import { Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { customerLabel, orderScope, sanitizeRows } from './orders';
import { userCan } from './permissions';
import { dayKey, orderLoad } from '../server/orders/loading.js';
import { effectiveItems } from '../server/loading/confirmation.js';
import { crateOrdersWhere } from '../server/loading/crates.js';
import { dayFirms } from '../server/loading/day-firms.js';

export const loadInclude = {
  // sandikEtiket: yükleme sayfasında (iç ekip) müşteri başlığında gösterilir; sipariş kendi etiketiyle ezebilir.
  // prefix: firma kodu (sipariş numarasının başı) — firma çıktısının dosya adında (Paket 7)
  customer: { select: { id: true, name: true, sandikEtiket: true, prefix: true } },
  items: { select: { camAdedi: true } },
  price: true,
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof loadInclude }>;
/**
 * Yükleme sayfasının sipariş satırı.
 *   replan   : satır siparişin tamamı değil, daha önce yüklenmeyen camın bu güne AKTARILMIŞ KALANIDIR (karar 102) —
 *              teklif satırları yalnızca aktarılan adedi taşır (lines), gün `replan.day`.
 *   notLoaded: sipariş kendi gününde onaylandı ama bir kısmı yüklenmedi (adet; aktarıldıysa yeni gün).
 */
export type LoadRow = OrderRow & {
  replan?: { day: string; fromDay: string; status: 'ACTIVE' | 'CONFIRMED' };
  notLoaded?: { quantity: number; replanDays: string[] };
};

/**
 * "Özel durum" (karar 124): ev sahibi firma kararı iç ekibe aittir — müşteriye giden satırda hiç bulunmaz (kendi siparişinin
 * hangi firmanın yüklemesiyle gittiğini müşteri yalnızca sandık numarası olarak görür).
 */
const hideHost = <R extends { guestHostId: string | null }>(user: CurrentUser, rows: R[]): R[] =>
  (user.appRole === 'MUSTERI' ? rows.map((r) => ({ ...r, guestHostId: null })) : rows);

/** Yükleme günü [from, to) aralığındaki siparişler. Beklemedekiler ve iptaller görünmez. */
export async function ordersShippingBetween(user: CurrentUser, from: Date, to: Date): Promise<LoadRow[]> {
  return hideHost(user, sanitizeRows(user, await db.order.findMany({
    where: {
      ...orderScope(user),
      orderTypeCode: 'GLASS_ORDER', // profil siparişleri depodan alınır; yükleme takvimine girmez
      onHold: false,
      status: { not: 'IPTAL' },
      OR: [
        { actualShipDate: { gte: from, lt: to } },
        { actualShipDate: null, estimatedShipDate: { gte: from, lt: to } },
      ],
    },
    include: loadInclude,
    orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
  })));
}

export function shipDay(o: { actualShipDate: Date | null; estimatedShipDate: Date | null; replan?: { day: string } }): string | null {
  // Aktarılmış kalan: siparişin kendi günü değil, aktarıldığı gün
  if (o.replan) return o.replan.day;
  const d = o.actualShipDate ?? o.estimatedShipDate;
  return d ? dayKey(d) : null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Yüklenmeyen camın [from, to) aralığındaki günlere aktarılmış kalanları (karar 102), yükleme satırı biçiminde: sipariş
 * aynı sipariştir (kopya sipariş yok), teklif satırları yalnızca aktarılan adedi ve kaynağın (onay kaleminin) ticari
 * kopyasını taşır. Kapsam ve fiyat temizliği sipariş satırlarıyla aynıdır (orderScope + sanitizeRows): müşteri yalnızca
 * kendi siparişinin kalanını görür; satışa müşteri fiyatı, müşteriye satış fiyatı gitmez.
 */
export async function replanRowsBetween(user: CurrentUser, from: Date, to: Date): Promise<LoadRow[]> {
  const replans = await db.loadingReplan.findMany({
    where: {
      status: { not: 'CANCELLED' }, shipDay: { gte: from, lt: to },
      order: { ...orderScope(user), orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' } },
    },
    include: { sourceItem: true, order: { include: loadInclude } },
    orderBy: [{ customerId: 'asc' }, { createdAt: 'asc' }],
  });
  const groups = new Map<string, typeof replans>();
  for (const r of replans) {
    const key = `${r.orderId}|${isoDay(r.shipDay)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rows: LoadRow[] = [...groups.values()].map((list) => {
    const o = list[0].order;
    const base = o.offers.find((x) => x.status === 'GONDERILDI') ?? o.offers[0];
    let cost = 0, sale = 0;
    const lines = list.map((r) => {
      const s = r.sourceItem;
      const unit = s.unit === 'm2' ? Number(r.m2) : r.quantity;
      cost += unit * Number(s.unitCost);
      sale += s.free || s.unitSale == null ? 0 : unit * Number(s.unitSale);
      return {
        ...(base?.lines.find((l) => l.id === s.offerLineId) ?? {}),
        id: s.offerLineId ?? s.id, offerId: base?.id ?? '', sortOrder: s.sortOrder, description: s.description, descriptionRo: s.descriptionRo,
        enMm: s.enMm, boyMm: s.boyMm, adet: r.quantity, unit: s.unit, kind: s.kind, free: s.free, glassProductId: s.glassProductId,
        weightKgM2: s.weightKgM2, unitPrice: s.unitCost, offerPrice: s.unitSale, listPrice: null, pieceBase: s.pieceBase, splitGroup: null,
      } as unknown as OrderRow['offers'][number]['lines'][number];
    });
    const offer = {
      ...(base ?? {}), id: base?.id ?? `replan-${list[0].id}`, status: 'GONDERILDI', currency: list[0].sourceItem.currency,
      amount: new Prisma.Decimal(cost.toFixed(2)), offerAmount: new Prisma.Decimal(sale.toFixed(2)), lines,
    } as unknown as OrderRow['offers'][number];
    // price: siparişin tamamının tutarıdır; kalan için kullanılmaz (tutar aktarılan satırlardan)
    return { ...o, offers: [offer], price: null, items: [], replan: { day: isoDay(list[0].shipDay), fromDay: isoDay(list[0].fromDay), status: list[0].status === 'CONFIRMED' ? 'CONFIRMED' : 'ACTIVE' } };
  });
  return hideHost(user, sanitizeRows(user, rows));
}

/**
 * Kendi gününde onaylanmış ama bir kısmı yüklenmemiş siparişler: sipariş → yüklenmeyen adet ve (aktarıldıysa) yeni günler.
 * Yalnızca verilen siparişler için (çağıran zaten kullanıcının görebildiği siparişleri verir).
 */
export async function notLoadedByOrder(rows: LoadRow[]): Promise<Map<string, { quantity: number; replanDays: string[] }>> {
  const dated = rows.filter((o) => !o.replan);
  if (dated.length === 0) return new Map();
  // Geçerli durum (karar 105): düzeltmeler uygulanmış kalemler; aktarımlar kapsamın bütün satırlarından (düzeltmeyle
  // yerini yenisi alan satıra bağlı aktarım da kapsamındır)
  const all = await db.loadingConfirmationItem.findMany({
    where: { orderId: { in: dated.map((o) => o.id) }, replanId: null },
    select: {
      id: true, orderId: true, confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true,
      confirmation: { select: { shipDay: true } }, replans: { where: { status: { not: 'CANCELLED' } }, select: { shipDay: true }, orderBy: { shipDay: 'asc' } },
    },
  });
  const dayOfOrder = new Map(dated.map((o) => [o.id, shipDay(o)]));
  const out = new Map<string, { quantity: number; replanDays: string[] }>();
  for (const it of effectiveItems(all)) {
    if (it.status !== 'NOT_LOADED' || it.quantity <= 0) continue;
    // Yalnızca siparişin göründüğü günün onayı (sipariş tarihi sonradan değiştiyse eski onayın notu o güne yazılmaz)
    if (isoDay(it.confirmation.shipDay) !== dayOfOrder.get(it.orderId)) continue;
    const cur = out.get(it.orderId) ?? { quantity: 0, replanDays: [] };
    cur.quantity += it.quantity;
    const scope = all.filter((x) => x.confirmationId === it.confirmationId && x.offerLineId === it.offerLineId);
    for (const r of scope.flatMap((x) => x.replans)) if (!cur.replanDays.includes(isoDay(r.shipDay))) cur.replanDays.push(isoDay(r.shipDay));
    out.set(it.orderId, cur);
  }
  return out;
}

/**
 * Siparişin tahmini yükü (gerçek sandıklar müşteri + gün bazında: cratesBetween / groupLoad) ve müşteriye gitmiş teklif tutarı. Müşteri görünümünde yalnızca müşteriye gönderilmiş teklif
 * kullanılır; iç ekip için teklif henüz gönderilmediyse son taslaktaki ölçüler kullanılır.
 */
export function loadOf(o: Pick<LoadRow, 'offers' | 'items' | 'price'>, customerView: boolean) {
  const sent = o.offers.find((x) => x.status === 'GONDERILDI');
  const offer = customerView ? sent : sent ?? o.offers[0];
  const load = orderLoad({
    lines: (offer?.lines ?? []).map((l) => ({ description: l.description, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, weightKgM2: l.weightKgM2 != null ? Number(l.weightKgM2) : null, pieceBase: l.pieceBase })),
    items: o.items,
  });
  // amount: müşteriye giden (yönetici) tutar · salesAmount: satış tutarı (karar 4; hangisi görünür: sayfa yetkiye göre seçer,
  // veriler zaten role göre temizlenmiştir — satışa müşteri tutarı, müşteriye satış tutarı hiç gelmez)
  const amount = sent ? Number(o.price?.amount ?? sent.offerAmount ?? sent.amount) : null;
  const cur = sent ?? o.offers[0];
  const salesAmount = cur ? Number(cur.amount) : null;
  return { ...load, amount, salesAmount, currency: cur?.currency ?? 'EUR' };
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
    // Müşteri, sandığındaki başka müşteriye ait (misafir) siparişin kimliğini almaz (SEC-17)
    include: { ...crateInclude, orders: { where: crateOrdersWhere(user), select: { orderId: true } } },
    orderBy: [{ crateNo: 'asc' }],
  });
}

/**
 * Fiziksel yerleşim (karar 103): [from, to) aralığındaki günlerde BAŞKA müşterinin sandığına konmuş siparişler.
 *   - İç ekip: sipariş, gerçek müşterisi, sandık ve sandığın müşterisi (ev sahibi). Adlar ham döner; ekranda rolün
 *     göremeyeceği ad maskelenir (customerLabel) — sandıklarla aynı kural.
 *   - Müşteri: yalnızca KENDİ siparişinin hangi sandık numarasında gittiği. Ev sahibi müşterinin kimliği, sandığın ölçü /
 *     ağırlığı ve o sandıktaki başka siparişler hiç dönmez. Kendi sandığında başka müşterinin camı olduğu bilgisi de dönmez.
 */
export type GuestLink = {
  day: string; orderId: string; orderNo: string; ownerId: string; ownerName: string; crateId: string; crateNo: number; hostId: string; hostName: string;
  /** Sandık, yöneticinin seçtiği ev sahibi firmanın (karar 124): satış sandığı değiştirebilir. false: eski kayıt (yalnızca yönetici kaldırır). */
  byHost: boolean;
};
export async function guestCratesBetween(user: CurrentUser, from: Date, to: Date): Promise<GuestLink[]> {
  const customer = user.appRole === 'MUSTERI';
  const links = await db.crateOrder.findMany({
    where: {
      crate: { shipDay: { gte: from, lt: to }, customerId: { not: null } },
      ...(customer ? { order: { customerId: user.customerId ?? '__none__' } } : {}),
    },
    select: {
      orderId: true, order: { select: { orderNo: true, customerId: true, guestHostId: true, customer: { select: { name: true } } } },
      crate: { select: { id: true, crateNo: true, shipDay: true, customerId: true, customer: { select: { name: true } } } },
    },
  });
  return links.filter((l) => l.crate.customerId !== l.order.customerId && l.crate.shipDay).map((l) => ({
    day: isoDay(l.crate.shipDay!), orderId: l.orderId, orderNo: l.order.orderNo, crateNo: l.crate.crateNo,
    ownerId: l.order.customerId, ownerName: customer ? '' : l.order.customer.name,
    crateId: customer ? '' : l.crate.id, hostId: customer ? '' : l.crate.customerId!, hostName: customer ? '' : l.crate.customer?.name ?? '',
    byHost: !customer && l.order.guestHostId === l.crate.customerId,
  }));
}

/**
 * "Özel durum"daki siparişlerin ev sahibi firma adları (iç ekip; ekranda rolün göremeyeceği ad maskelenir — customerLabel).
 * Müşteri görünümünde boştur: satırlarda guestHostId zaten yoktur.
 */
export async function guestHostNames(user: CurrentUser, rows: { guestHostId: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.guestHostId).filter((x): x is string => !!x))];
  if (user.appRole === 'MUSTERI' || ids.length === 0) return new Map();
  return new Map((await db.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
}

/** Sandığın günü: "YYYY-MM-DD" (@db.Date UTC gece yarısı) */
export const crateDay = (c: { shipDay: Date | null }) => (c.shipDay ? c.shipDay.toISOString().slice(0, 10) : null);

/**
 * Hangi tutarlar görünür (karar 4; Paket 7 — karar 187): fabrika satış tutarı = satış fiyatını gören rol (yönetici, satış);
 * teklif tutarı = müşteri fiyatını gören rol (yönetici, denetimci; müşteri kendi teklifini). Veriler zaten role göre temizlenmiş
 * gelir (sanitizeRows); bu yalnızca hangi sütunun yazılacağını seçer — görünmeyen tutar firma tablosuna hiç girmez (null).
 */
export type MoneyView = { sales: boolean; offer: boolean };
export function moneyView(user: CurrentUser): MoneyView {
  return { sales: userCan(user, 'OFFER_PREPARE'), offer: userCan(user, 'OFFER_SEND') || userCan(user, 'PRICE_FINAL_VIEW') };
}

/** Yükleme gününün sipariş satırı: sayfa satırı (o), yükü (load) ve firma tablosunun (server/loading/day-firms.js) alanları */
export type DayEntry = {
  o: LoadRow; load: Load; orderId: string; orderNo: string; customerId: string; customerName: string; guestHostId: string | null; replan: boolean;
  money: { currency: string; sales: number | null; offer: number | null };
};
export function dayEntry(o: LoadRow, { customer, money }: { customer: boolean; money: MoneyView }): DayEntry {
  const load = loadOf(o, customer);
  return {
    o, load, orderId: o.id, orderNo: o.orderNo, customerId: o.customer.id, customerName: o.customer.name, guestHostId: o.guestHostId ?? null, replan: !!o.replan,
    // Görünmeyen tutar null: satışta load.amount satış tutarına düşer (müşteri fiyatı satışa hiç gelmez) — teklif sütununa yazılmaz
    money: { currency: load.currency, sales: money.sales ? load.salesAmount : null, offer: money.offer ? load.amount : null },
  };
}

/**
 * Bir yükleme gününün firma tablosu (tek atıf kuralı — server/loading/day-firms.js). Firma adları görene göre burada BİR kez
 * yazılır (customerLabel: satışa maskeli); sonuçtaki her ad ekrana / dosyaya olduğu gibi yazılabilir.
 */
export function firmsOfDay(user: CurrentUser, entries: DayEntry[], crates: CrateRow[], guests: GuestLink[], hostNames: Map<string, string> = new Map()) {
  const label = (n: string) => customerLabel(user, n);
  return dayFirms({
    entries: entries.map((e) => ({ ...e, customerName: label(e.customerName) })),
    crates: crates.map((c) => ({ ...c, customerName: label(c.customer?.name ?? ''), orderIds: c.orders.map((x) => x.orderId) })),
    links: guests.map((l) => ({ ...l, hostName: l.hostName ? label(l.hostName) : '' })),
    hostNames: new Map([...hostNames].map(([k, v]) => [k, label(v)])),
  });
}
export type DayFirms = ReturnType<typeof firmsOfDay>;
export type DayFirm = DayFirms['firms'][number];

/**
 * Tek bir yükleme gününün verisi (sayfa dışındaki kullanıcılar: Yükleme Özeti Excel'i, firma PDF / Excel'i, firma özeti):
 * o güne planlı siparişler (yüklenmeyen adet notuyla) + o güne aktarılmış kalanlar, günün sandıkları ve misafir yükleri.
 * Kapsam ve temizlik sayfayla aynıdır (orderScope + sanitizeRows; müşteri yalnızca kendi firması).
 */
export async function loadDay(user: CurrentUser, day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  const next = new Date(d.getTime() + 86_400_000);
  const [around, carried, crates, guests] = await Promise.all([
    ordersShippingBetween(user, new Date(d.getTime() - 86_400_000), new Date(d.getTime() + 2 * 86_400_000)),
    replanRowsBetween(user, d, next), cratesBetween(user, d, next), guestCratesBetween(user, d, next),
  ]);
  const dated = around.filter((o) => shipDay(o) === day);
  const missing = await notLoadedByOrder(dated);
  const rows: LoadRow[] = [...dated.map((o) => (missing.has(o.id) ? { ...o, notLoaded: missing.get(o.id) } : o)), ...carried.filter((o) => shipDay(o) === day)];
  return { rows, crates, guests: guests.filter((l) => l.day === day), hostNames: await guestHostNames(user, rows) };
}
