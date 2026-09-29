import { notFound } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { canSeeCustomerName, maskName, shouldAutoProduce, slaDeadline } from '../server/orders/rules.js';
import { userCan } from './permissions';

/** Müşteri yalnızca kendi firmasının siparişlerini görür; çizim ekibi yalnızca çizimli siparişleri; denetimci hepsini. */
export function orderScope(user: CurrentUser): Prisma.OrderWhereInput {
  if (user.appRole === 'MUSTERI') return { customerId: user.customerId ?? '__none__' };
  if (user.appRole === 'CIZIM') return { drawingTrack: { not: 'YOK' } };
  return {};
}

export function customerLabel(user: CurrentUser, name: string): string {
  return canSeeCustomerName(user.appRole) ? name : maskName(name);
}

// Satış ve çizim ekibine firmanın iletişim ve grup bilgisi de gitmez (ADR 0003).
const PRIVATE_CUSTOMER_FIELDS = ['contactPerson', 'email', 'phone', 'address', 'taxId', 'groupName'] as const;

/**
 * Firma kaydını kullanıcının görebileceği hale getirir: tam adı göremeyen rollerde ad maskelenir
 * (GLA**********) ve iletişim alanları boşaltılır. Veri veritabanından gelir gelmez uygulanır;
 * sayfa ve istemci bileşenleri tam adı hiç görmez.
 */
export function sanitizeCustomer<C extends { name: string }>(user: CurrentUser, c: C): C {
  if (userCan(user, 'CUSTOMER_NAME_VIEW')) return c;
  const out: Record<string, unknown> = { ...c, name: maskName(c.name) };
  for (const f of PRIVATE_CUSTOMER_FIELDS) if (f in out) out[f] = null;
  return out as C;
}

/**
 * Liste sorgularının satırlarını temizler (sanitizeOrder ile aynı kurallar; satırda olan alanlara uygulanır).
 */
export function sanitizeRows<R extends { customer: { name: string }; price?: unknown; offers?: { status: string }[] }>(user: CurrentUser, rows: R[]): R[] {
  const priceOk = userCan(user, 'PRICE_FINAL_VIEW');
  const drafts = userCan(user, 'OFFER_DRAFT_VIEW');
  const offersOk = userCan(user, 'OFFER_VIEW');
  return rows.map((r) => {
    const out: R = { ...r, customer: sanitizeCustomer(user, r.customer) };
    if ('price' in r && !priceOk) out.price = null as R['price'];
    if (r.offers) {
      out.offers = (!offersOk ? [] : drafts ? r.offers : r.offers.filter((o) => o.status === 'GONDERILDI')) as R['offers'];
    }
    return out;
  });
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
  crates: { orderBy: { crateNo: 'asc' } },
  notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true, email: true, appRole: true } } } },
  events: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true, email: true } } } },
  assignedDrawer: { select: { name: true, email: true } },
  createdBy: { select: { name: true, email: true } },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;
type OfferRow = OrderDetail['offers'][number];

/** Siparişi kullanıcının yetkisi dahilinde yükler (erişimi yoksa 404) ve role göre temizler. */
export async function loadOrder(id: string, user: CurrentUser): Promise<OrderDetail> {
  const order = await db.order.findFirst({ where: { id, ...orderScope(user) }, include: orderDetailInclude });
  if (!order) notFound();
  return sanitizeOrder(user, order);
}

const ZERO = new Prisma.Decimal(0);

/**
 * Rolün göremeyeceği her şeyi sunucuda çıkarır (ekranda gizlemek yetmez):
 *  - firma adı / iletişim (satış, çizim)       - iç notlar ve iç dosyalar (müşteri)
 *  - gönderilmemiş teklifler (müşteri, denetimci) - teklif tutarları ve satırları (çizim; durum kalır)
 *  - yönetici fiyatı (satış, çizim)
 */
export function sanitizeOrder(user: CurrentUser, order: OrderDetail): OrderDetail {
  let offers = order.offers;
  if (!userCan(user, 'OFFER_VIEW')) offers = offers.map((o) => ({ ...o, lines: [], amount: ZERO }));
  else if (!userCan(user, 'OFFER_DRAFT_VIEW')) offers = offers.filter((o) => o.status === 'GONDERILDI');
  return {
    ...order,
    customer: sanitizeCustomer(user, order.customer),
    notes: userCan(user, 'NOTE_INTERNAL_VIEW') ? order.notes : order.notes.filter((n) => !n.internal),
    files: userCan(user, 'FILE_INTERNAL_VIEW') ? order.files : order.files.filter((f) => f.kind === 'CUSTOMER'),
    offers,
    price: userCan(user, 'PRICE_FINAL_VIEW') ? order.price : null,
  };
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

/**
 * Çizim onaylı (ya da gereksiz) ve teklif müşterideyse siparişi otomatik olarak üretime alır.
 * Beklemedeki sipariş geçmez. Üretime geçtiyse true döner.
 */
export async function maybeAutoProduction(tx: Tx, orderId: string, userId: string | null): Promise<boolean> {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!shouldAutoProduce({ status: o.status, onHold: o.onHold, drawing: o.drawingTrack, offer: o.offers[0]?.status ?? null })) return false;
  await tx.order.update({ where: { id: orderId }, data: { status: 'URETIMDE', slaDeadline: null } });
  // Not bir koddur; ekranda events.PRODUCTION.<kod> olarak çevrilir (lib/labels.ts → eventNoteText)
  await logEvent(tx, orderId, 'PRODUCTION', userId, o.drawingTrack === 'YOK' ? 'no_drawing' : 'drawing_approved');
  return true;
}

/** Bir sonraki müşteri sipariş numarası önerisi (son numara + 1). */
export async function suggestCustomerOrderNo(customerId: string): Promise<number> {
  const last = await db.order.aggregate({ where: { customerId }, _max: { customerOrderNo: true } });
  return (last._max.customerOrderNo ?? 0) + 1;
}
