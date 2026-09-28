import { notFound } from 'next/navigation';
import type { OrderStatus, Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { audit } from './audit';
import { canSeeCustomerName, maskName, slaDeadlineFor } from '../server/orders/rules.js';

/** Müşteri yalnızca kendi firmasının siparişlerini görür; çizim ekibi yalnızca çizimli siparişleri. */
export function orderScope(user: CurrentUser): Prisma.OrderWhereInput {
  if (user.appRole === 'MUSTERI') return { customerId: user.customerId ?? '__none__' };
  if (user.appRole === 'CIZIM') return { needsDrawing: true };
  return {};
}

export function customerLabel(user: CurrentUser, name: string): string {
  return canSeeCustomerName(user.appRole) ? name : maskName(name);
}

export const orderDetailInclude = {
  customer: true,
  items: true,
  files: { orderBy: { createdAt: 'asc' }, include: { uploadedBy: { select: { name: true, email: true } } } },
  drawings: {
    orderBy: { version: 'asc' },
    include: {
      uploadedBy: { select: { name: true, email: true } },
      revisions: { orderBy: { createdAt: 'asc' } },
    },
  },
  offers: { orderBy: { createdAt: 'desc' }, take: 1, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
  price: true,
  notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true, email: true, appRole: true } } } },
  statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: { name: true, email: true } } } },
  assignedDrawer: { select: { name: true, email: true } },
  createdBy: { select: { name: true, email: true } },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

/** Siparişi kullanıcının yetkisi dahilinde yükler; erişimi yoksa 404. */
export async function loadOrder(id: string, user: CurrentUser): Promise<OrderDetail> {
  const order = await db.order.findFirst({ where: { id, ...orderScope(user) }, include: orderDetailInclude });
  if (!order) notFound();
  return order;
}

type Tx = Prisma.TransactionClient;

/** Durum değiştirir; SLA'yı yeniden hesaplar, geçmişe ve denetim kaydına yazar. */
export async function transition(
  tx: Tx,
  order: { id: string; status: OrderStatus },
  to: OrderStatus,
  userId: string,
  note?: string | null,
  extra: Prisma.OrderUpdateInput = {}
): Promise<void> {
  await tx.order.update({
    where: { id: order.id },
    data: { ...extra, status: to, slaDeadline: slaDeadlineFor(to) },
  });
  await tx.orderStatusHistory.create({
    data: { orderId: order.id, fromStatus: order.status, toStatus: to, note: note ?? null, changedById: userId },
  });
  await tx.auditLog.create({
    data: { action: 'ORDER_STATUS_CHANGE', entityType: 'Order', entityId: order.id, userId, details: { from: order.status, to, note: note ?? null } },
  });
}

/** Bir sonraki müşteri sipariş numarası önerisi (son numara + 1). */
export async function suggestCustomerOrderNo(customerId: string): Promise<number> {
  const last = await db.order.aggregate({ where: { customerId }, _max: { customerOrderNo: true } });
  return (last._max.customerOrderNo ?? 0) + 1;
}

export { audit };
