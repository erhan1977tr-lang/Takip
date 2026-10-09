// Kırık / telafi camı (Aşama 9) — sipariş sayfasının verisi: "Önemli kararlar" kartındaki telafi geçmişi ve telafi
// formunun seçenekleri. Kurallar server/orders/compensation.js'tedir; burada yalnızca yükleme ve ROLE GÖRE TEMİZLİK var:
// satış müşteri fiyatını görmez (karar 4) — müşteri fiyatı üzerinden verilen kararın tutarı satışa hiç gitmez, yalnızca
// kararın türü (bedelsiz / aynı fiyat / farklı fiyat) gider (karar 157: üç kararı satış da seçer, tutarı görmeden).
import crypto from 'node:crypto';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { sentOffer, type OrderDetail } from './orders';
import { userCan } from './permissions';
import { ambiguousOps, compensableLines, compensationDestinations, notLoadedLinks, sourceState } from '../server/orders/compensation.js';
import { isSalesCrate } from '../server/orders/rules.js';

export type CompEntry = {
  id: string; status: 'APPLIED' | 'PENDING' | 'REJECTED';
  quantity: number; glass: string; glassRo: string | null; enMm: number | null; boyMm: number | null; currency: string;
  sourceLineId: string; sourceOrder: { id: string; orderNo: string };
  destOrder: { id: string; orderNo: string; removed: boolean } | null; destType: 'NEW' | 'EXISTING'; day: string | null;
  mode: 'NORMAL' | 'FREE' | 'CUSTOM'; tier: 'CUSTOMER' | 'SALES'; free: boolean;
  /** Kararın kademesindeki fiyatlar; görme yetkisi yoksa null (yalnızca tür gösterilir) */
  normal: number | null; price: number | null;
  /** Bekleyen kararda yönetici için: kaynağın müşteri fiyatı ve telafinin (varsa) kayıtlı müşteri fiyatı */
  normalCustomer: number | null; customerPrice: number | null;
  /** Camın müşteri fiyatını yönetici henüz belirlemedi ("farklı fiyat" kararı) — tutar taşımaz; satış da görür */
  awaitingPrice: boolean;
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
    // Karar müşteri fiyatı üzerinedir (karar 112): tutarı yalnızca yönetici görür; satışa kararın türü gider (aynı fiyat /
    // bedelsiz). Eski kayıtlardaki satış kademesi kararları (SALES) satışa kendi tutarıyla görünmeye devam eder.
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
      awaitingPrice: c.status !== 'REJECTED' && !c.free && c.offerPrice == null && (c.priceMode === 'CUSTOM' || c.status === 'PENDING'),
      linked: !!c.sourceItemId, createdBy: c.createdBy.name, createdAt: c.createdAt,
      decidedBy: c.decidedBy?.name ?? null, decidedAt: c.decidedAt, decisionNote: c.decisionNote,
    };
  });
}

export type CompFormLine = {
  id: string; n: number; glass: string; glassRo: string | null; enMm: number; boyMm: number; adet: number;
  /**
   * Mevcut müşteri fiyatı (yöneticinin kaynak teklifte belirlediği) — YALNIZCA yöneticiye gider; satışta null: satış
   * "aynı fiyat"ı seçer, tutarı sunucu taşır (iki kademeli fiyat, karar 4). Kaynak bedelsizse 0.
   */
  normal: number | null; free: boolean;
  /** Bu TEK cama ait işlemler (CNC / delik): telafiye aynen taşınır; müşteri fiyatları telafide 0'dır (karar 157) */
  ops: { kind: string; adet: number; description: string }[];
  /** İşlemler adedi 1'den büyük satıra bağlı (eski kayıt): hangi camda olduğu belli değil — telafi açılamaz (karar 113) */
  ambiguous: boolean;
  links: { itemId: string; day: string; free: number }[];
};
export type CompFormData = {
  orderId: string; orderNo: string; nextNo: string; currency: string; admin: boolean; minDay: string; requestKey: string;
  /**
   * Kaynak adedi (karar 157): reducible → telafi açılınca ana siparişte kalan adet düşer. Değilse neden (sipariş kapalı /
   * yüklemesi onaylanmış / belgesi var): telafi ek üretim olarak açılır, kaynak teklif değişmez. Kesin karar kayıt anında.
   */
  source: { reducible: boolean; reason: 'CLOSED' | 'LOADED' | 'BILLING' | null };
  lines: CompFormLine[];
  destinations: { id: string; orderNo: string; day: string; via: 'DRAFT' | 'SENT' | null; reason: string | null }[];
};

/**
 * Telafi formunun seçenekleri. `order` sayfanın yüklediği, ROLE GÖRE TEMİZLENMİŞ sipariştir: satışta satırların müşteri
 * fiyatı zaten yoktur — mevcut müşteri fiyatı yalnızca yöneticinin formuna yazılır; satışın formuna hiçbir tutar gitmez.
 */
export async function loadCompensationForm(order: OrderDetail, user: CurrentUser): Promise<CompFormData | null> {
  if (!userCan(user, 'OFFER_PREPARE') || order.orderTypeCode !== 'GLASS_ORDER' || order.status === 'IPTAL') return null;
  const sent = sentOffer(order);
  if (!sent) return null;
  const admin = userCan(user, 'OFFER_SEND');
  type Line = OrderDetail['offers'][number]['lines'][number];
  const groups: { line: Line; subs: Line[] }[] = compensableLines(sent.lines);
  if (groups.length === 0) return null;
  const [state, links, destinations, root] = await Promise.all([
    sourceState(db, order.id),
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
  for (const l of sent.lines) if (l.kind !== 'CNC' && l.kind !== 'DELIK' && !isSalesCrate(l)) glassNo.set(l.id, ++n);
  return {
    orderId: order.id, orderNo: order.orderNo, nextNo: `${rootNo}-T${seq > 1 ? seq : ''}`, currency: sent.currency, admin, minDay: tomorrow,
    requestKey: crypto.randomUUID(),
    source: { reducible: state.ok, reason: state.ok ? null : state.reason },
    lines: groups.map((g) => ({
      id: g.line.id, n: glassNo.get(g.line.id) ?? 0, glass: g.line.description, glassRo: g.line.descriptionRo, enMm: g.line.enMm ?? 0, boyMm: g.line.boyMm ?? 0, adet: g.line.adet,
      normal: !admin ? null : g.line.free ? 0 : num(g.line.offerPrice), free: g.line.free,
      ops: g.subs.map((s) => ({ kind: s.kind, adet: s.adet, description: s.description ?? '' })),
      ambiguous: ambiguousOps(g),
      links: links.filter((x) => x.lineId === g.line.id).map((x) => ({ itemId: x.itemId, day: x.day, free: x.free })),
    })),
    destinations,
  };
}
