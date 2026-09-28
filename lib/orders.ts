import { notFound } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { canSeeCustomerName, maskName, slaDeadline } from '../server/orders/rules.js';

/** Müşteri yalnızca kendi firmasının siparişlerini görür; çizim ekibi yalnızca çizimli siparişleri. */
export function orderScope(user: CurrentUser): Prisma.OrderWhereInput {
  if (user.appRole === 'MUSTERI') return { customerId: user.customerId ?? '__none__' };
  if (user.appRole === 'CIZIM') return { drawingTrack: { not: 'YOK' } };
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
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
  price: true,
  notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true, email: true, appRole: true } } } },
  events: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true, email: true } } } },
  assignedDrawer: { select: { name: true, email: true } },
  createdBy: { select: { name: true, email: true } },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;
type OfferRow = OrderDetail['offers'][number];

/** Siparişi kullanıcının yetkisi dahilinde yükler; erişimi yoksa 404. */
export async function loadOrder(id: string, user: CurrentUser): Promise<OrderDetail> {
  const order = await db.order.findFirst({ where: { id, ...orderScope(user) }, include: orderDetailInclude });
  if (!order) notFound();
  return order;
}

/** Üzerinde çalışılan son teklif (en yeni). */
export function currentOffer(order: { offers: OfferRow[] }): OfferRow | undefined {
  return order.offers[0];
}
/** Müşteriye gönderilmiş son teklif. */
export function sentOffer(order: { offers: OfferRow[] }): OfferRow | undefined {
  return order.offers.find((o) => o.status === 'GONDERILDI');
}

type Tx = Prisma.TransactionClient;

export async function logEvent(tx: Tx, orderId: string, event: string, userId: string | null, note?: string | null) {
  await tx.orderEvent.create({ data: { orderId, event, userId, note: note ?? null } });
  await tx.auditLog.create({ data: { action: `ORDER_${event}`, entityType: 'Order', entityId: orderId, userId, details: note ? { note } : undefined } });
}

/** Siparişin SLA son tarihini güncel çizim ve teklif durumuna göre yeniden hesaplar. */
export async function refreshSla(tx: Tx, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  const offer = o.offers[0];
  const deadline = slaDeadline({
    status: o.status, onHold: o.onHold, createdAt: o.createdAt,
    drawing: o.drawingTrack, drawingSince: o.drawingSince,
    offer: offer?.status ?? null, offerSince: offer?.statusSince ?? null,
  });
  await tx.order.update({ where: { id: orderId }, data: { slaDeadline: deadline } });
}

/** Bir sonraki müşteri sipariş numarası önerisi (son numara + 1). */
export async function suggestCustomerOrderNo(customerId: string): Promise<number> {
  const last = await db.order.aggregate({ where: { customerId }, _max: { customerOrderNo: true } });
  return (last._max.customerOrderNo ?? 0) + 1;
}
