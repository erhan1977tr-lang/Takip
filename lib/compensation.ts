// Kırık / telafi camı (Aşama 9) — sipariş sayfasının verisi: "Önemli kararlar" kartındaki telafi geçmişi ve telafi
// formunun seçenekleri. Kurallar server/orders/compensation.js'tedir; burada yalnızca yükleme ve ROLE GÖRE TEMİZLİK var:
// satış müşteri fiyatını görmez (karar 4) — yöneticinin müşteri fiyatı üzerinden verdiği kararın tutarı satışa hiç gitmez,
// yalnızca kararın türü (normal / bedelsiz / değiştirildi) gider.
import crypto from 'node:crypto';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { sentOffer, type OrderDetail } from './orders';
import { userCan } from './permissions';
import { compensableLines, compensationDestinations, notLoadedLinks } from '../server/orders/compensation.js';

export type CompEntry = {
  id: string; status: 'APPLIED' | 'PENDING' | 'REJECTED';
  quantity: number; glass: string; glassRo: string | null; enMm: number | null; boyMm: number | null; currency: string;
  sourceLineId: string; sourceOrder: { id: string; orderNo: string };
  destOrder: { id: string; orderNo: string; removed: boolean } | null; destType: 'NEW' | 'EXISTING'; day: string | null;
  mode: 'NORMAL' | 'FREE' | 'CUSTOM'; tier: 'CUSTOMER' | 'SALES'; free: boolean;
  /** Kararın kademesindeki fiyatlar; görme yetkisi yoksa null (yalnızca tür gösterilir) */
  normal: number | null; price: number | null;
  /** Bekleyen kararda yönetici için: kaynağın müşteri fiyatı ve müşteri fiyatının girilmesi gerekip gerekmediği */
  normalCustomer: number | null; customerPrice: number | null; needsPrice: boolean;
  linked: boolean; createdBy: string; createdAt: Date; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null;
};

const num = (v: unknown) => (v == null ? null : Number(v));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Siparişin telafi geçmişi (kaynağı ya da hedefi bu sipariş), kullanıcının görebileceği kadar. */
export async function loadCompensations(orderId: string, user: CurrentUser): Promise<CompEntry[]> {
  if (!userCan(user, 'OFFER_PREPARE')) return [];
  const admin = userCan(user, 'OFFER_SEND');
  const rows = await db.compensation.findMany({
    where: { OR: [{ sourceOrderId: orderId }, { destOrderId: orderId }] },
    orderBy: { createdAt: 'desc' },
    include: {
      sourceOrder: { select: { id: true, orderNo: true } }, destOrder: { select: { id: true, orderNo: true, removedAt: true } },
      createdBy: { select: { name: true } }, decidedBy: { select: { name: true } },
    },
    take: 100,
  });
  return rows.map((c): CompEntry => {
    const customerTier = c.priceTier === 'CUSTOMER';
    // Satış yalnızca kendi kademesindeki (satış fiyatı) kararın tutarlarını görür
    const visible = admin || !customerTier;
    return {
      id: c.id, status: c.status as CompEntry['status'], quantity: c.quantity, glass: c.description, glassRo: c.descriptionRo, enMm: c.enMm, boyMm: c.boyMm, currency: c.currency,
      sourceLineId: c.sourceLineId, sourceOrder: c.sourceOrder,
      destOrder: c.destOrder ? { id: c.destOrder.id, orderNo: c.destOrder.orderNo, removed: !!c.destOrder.removedAt } : null,
      destType: c.destType as CompEntry['destType'], day: day(c.loadingDay),
      mode: c.priceMode as CompEntry['mode'], tier: c.priceTier as CompEntry['tier'], free: c.free,
      normal: !visible ? null : customerTier ? num(c.normalPrice) : num(c.normalCost),
      price: !visible ? null : c.free ? 0 : customerTier ? num(c.offerPrice) : num(c.unitCost),
      normalCustomer: admin ? num(c.normalPrice) : null, customerPrice: admin ? num(c.offerPrice) : null,
      needsPrice: admin && c.status === 'PENDING' && !c.free && c.offerPrice == null,
      linked: !!c.sourceItemId, createdBy: c.createdBy.name, createdAt: c.createdAt,
      decidedBy: c.decidedBy?.name ?? null, decidedAt: c.decidedAt, decisionNote: c.decisionNote,
    };
  });
}

export type CompFormLine = {
  id: string; n: number; glass: string; glassRo: string | null; enMm: number; boyMm: number; adet: number;
  /** Kullanıcının kademesindeki normal fiyat: yönetici → müşteri fiyatı, satış → satış fiyatı. Kaynak bedelsizse 0. */
  normal: number | null; free: boolean;
  ops: { kind: string; adet: number }[];
  links: { itemId: string; day: string; free: number }[];
};
export type CompFormData = {
  orderId: string; orderNo: string; nextNo: string; currency: string; admin: boolean; minDay: string; requestKey: string;
  lines: CompFormLine[];
  destinations: { id: string; orderNo: string; day: string; via: 'DRAFT' | 'SENT' | null; reason: string | null }[];
};

/**
 * Telafi formunun seçenekleri. `order` sayfanın yüklediği, ROLE GÖRE TEMİZLENMİŞ sipariştir: satışta satırların müşteri
 * fiyatı zaten yoktur — "normal fiyat" kullanıcının görebildiği fiyattan hesaplanır, başka fiyat okunmaz.
 */
export async function loadCompensationForm(order: OrderDetail, user: CurrentUser): Promise<CompFormData | null> {
  if (!userCan(user, 'OFFER_PREPARE') || order.orderTypeCode !== 'GLASS_ORDER' || order.status === 'IPTAL') return null;
  const sent = sentOffer(order);
  if (!sent) return null;
  const admin = userCan(user, 'OFFER_SEND');
  type Line = OrderDetail['offers'][number]['lines'][number];
  const groups: { line: Line; subs: Line[] }[] = compensableLines(sent.lines);
  if (groups.length === 0) return null;
  const [links, destinations, root] = await Promise.all([
    notLoadedLinks(db, order.id),
    compensationDestinations(db, { source: { id: order.id, customerId: order.customerId, currency: sent.currency } }),
    order.compOfId ? db.order.findUnique({ where: { id: order.compOfId }, select: { orderNo: true, customerOrderNo: true } }) : null,
  ]);
  // Bir sonraki telafi siparişi numarası (bilgi; kesin numara kayıt anında kilit altında verilir)
  const rootNo = root?.orderNo ?? order.orderNo;
  const last = await db.order.aggregate({ where: { customerId: order.customerId, orderTypeCode: 'GLASS_ORDER', customerOrderNo: root?.customerOrderNo ?? order.customerOrderNo }, _max: { compSeq: true } });
  const seq = (last._max.compSeq ?? 0) + 1;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  // Cam satırı sırası teklif tablosundaki "#" ile aynı (işlem satırları sayılmaz)
  const glassNo = new Map<string, number>();
  let n = 0;
  for (const l of sent.lines) if (l.kind !== 'CNC' && l.kind !== 'DELIK') glassNo.set(l.id, ++n);
  return {
    orderId: order.id, orderNo: order.orderNo, nextNo: `${rootNo}-T${seq > 1 ? seq : ''}`, currency: sent.currency, admin, minDay: tomorrow,
    requestKey: crypto.randomUUID(),
    lines: groups.map((g) => ({
      id: g.line.id, n: glassNo.get(g.line.id) ?? 0, glass: g.line.description, glassRo: g.line.descriptionRo, enMm: g.line.enMm ?? 0, boyMm: g.line.boyMm ?? 0, adet: g.line.adet,
      normal: g.line.free ? 0 : admin ? num(g.line.offerPrice) : num(g.line.unitPrice), free: g.line.free,
      ops: g.subs.map((s) => ({ kind: s.kind, adet: s.adet })),
      links: links.filter((x) => x.lineId === g.line.id).map((x) => ({ itemId: x.itemId, day: x.day, free: x.free })),
    })),
    destinations,
  };
}
