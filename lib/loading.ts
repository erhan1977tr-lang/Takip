import type { Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { orderScope, sanitizeRows } from './orders';
import { dayKey, orderLoad } from '../server/orders/loading.js';

export const loadInclude = {
  customer: { select: { id: true, name: true } },
  items: { select: { camAdedi: true } },
  price: true,
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
} satisfies Prisma.OrderInclude;
export type LoadRow = Prisma.OrderGetPayload<{ include: typeof loadInclude }>;

/** Yükleme günü [from, to) aralığındaki siparişler. Beklemedekiler ve iptaller görünmez. */
export async function ordersShippingBetween(user: CurrentUser, from: Date, to: Date): Promise<LoadRow[]> {
  return sanitizeRows(user, await db.order.findMany({
    where: {
      ...orderScope(user),
      onHold: false,
      status: { not: 'IPTAL' },
      OR: [
        { actualShipDate: { gte: from, lt: to } },
        { actualShipDate: null, estimatedShipDate: { gte: from, lt: to } },
      ],
    },
    include: loadInclude,
    orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
  }));
}

export function shipDay(o: { actualShipDate: Date | null; estimatedShipDate: Date | null }): string | null {
  const d = o.actualShipDate ?? o.estimatedShipDate;
  return d ? dayKey(d) : null;
}

/**
 * Siparişin tahmini yükü (gerçek sandıklar müşteri + gün bazında: cratesBetween / groupLoad) ve müşteriye gitmiş teklif tutarı. Müşteri görünümünde yalnızca müşteriye gönderilmiş teklif
 * kullanılır; iç ekip için teklif henüz gönderilmediyse son taslaktaki ölçüler kullanılır.
 */
export function loadOf(o: Pick<LoadRow, 'offers' | 'items' | 'price'>, customerView: boolean) {
  const sent = o.offers.find((x) => x.status === 'GONDERILDI');
  const offer = customerView ? sent : sent ?? o.offers[0];
  const load = orderLoad({
    lines: (offer?.lines ?? []).map((l) => ({ description: l.description, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, weightKgM2: l.weightKgM2 != null ? Number(l.weightKgM2) : null })),
    items: o.items,
  });
  const amount = sent ? Number(o.price?.amount ?? sent.amount) : null;
  return { ...load, amount, currency: sent?.currency ?? 'EUR' };
}
export type Load = ReturnType<typeof loadOf>;

const crateInclude = {
  orders: { select: { orderId: true } },
  updatedBy: { select: { name: true } },
  customer: { select: { id: true, name: true } },
} satisfies Prisma.CrateInclude;
export type CrateRow = Prisma.CrateGetPayload<{ include: typeof crateInclude }>;

/**
 * [from, to) aralığındaki yükleme günlerinin sandıkları. Müşteri yalnızca kendi firmasının sandıklarını görür.
 */
export async function cratesBetween(user: CurrentUser, from: Date, to: Date): Promise<CrateRow[]> {
  // Müşteri: yalnızca kendi firması; iç ekip: tüm firmalar (eski düzenden kalmış, firması olmayan sandıklar hariç)
  const scope = user.appRole === 'MUSTERI' ? { customerId: user.customerId ?? '__none__' } : { customerId: { not: null } };
  return db.crate.findMany({
    where: { ...scope, shipDay: { gte: from, lt: to } },
    include: crateInclude,
    orderBy: [{ crateNo: 'asc' }],
  });
}

/** Sandığın günü: "YYYY-MM-DD" (@db.Date UTC gece yarısı) */
export const crateDay = (c: { shipDay: Date | null }) => (c.shipDay ? c.shipDay.toISOString().slice(0, 10) : null);
