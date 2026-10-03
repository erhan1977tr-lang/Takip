// Muhasebe → Tedarikçi Hesap Durumu.
//   A) Yükleme kârlılığı (yükleme = yükleme günü; Yüklemeler sekmesiyle aynı gruplama):
//        kâr = cam satış − cam alış/maliyet − nakliye (yönetici elle girer, LoadingCost)
//   B) Fabrika cari hesabı: borç = toplam cam alış/maliyet − fabrikaya yapılan ödemeler (FactoryPayment).
//      Ödemeler yüklemelere/siparişlere bağlı değildir ve dağıtılmaz; yükleme kârından düşülmez.
// Para birimleri asla birbirine eklenmez: her toplam para birimi başına ayrı tutulur.
//
// İki ayrı değer, ikisi de müşteriye GÖNDERİLMİŞ teklif sürümünün satırlarında saklı (karar 89):
//   Satış  = OfferLine.offerPrice — yöneticinin müşteri fiyatı (müşteriye giden son fiyat).
//   Maliyet = OfferLine.unitPrice — satış fiyatı: teklif hazırlanırken satışçının fabrika fiyat tablosundan gelen (ya da
//             satışçının girdiği) fiyat. Yönetici müşteri fiyatını değiştirince bu değer DEĞİŞMEZ; fiyat tablosu sonradan
//             değişse de satırdaki değer değişmez (bugünün tablosu kullanılmaz).
// İkisi de aynı kuralla toplanır: fatura / yükleme dökümü kuralı (server/glass/billing.js → glassTotals: cam + ona
// eklenen CNC, delik, sandık parası ve diğer kalemler). Ayrı bir fiyat formülü yoktur.
//
// Yükleme onayı (karar 92): bir yükleme günü "Eksiksiz Yüklendi" olarak onaylandıysa o günün satış ve maliyeti onay
// anında alınan kopyadan (LoadingConfirmationItem) gelir — teklif ya da fiyat sonradan değişse de değişmez. Onaylanmamış
// günlerde eski hesap sürer (planlanan yükleme günü; ekranda "planlanan" olarak ayrılır). Bir sipariş iki kez sayılmaz:
// onaylı bir yüklemede yüklenmiş sipariş, tarihi sonradan değişse de başka günde yeniden sayılmaz.
//
// Yükleme düzeltmesi (karar 105): kârlılık onayın GEÇERLİ kalemlerinden (effectiveItems — düzeltmeler uygulanmış) gelir,
// yani fiilen yüklenen camı izler. Kesilmiş bir fatura düzeltilmiş yüklemeyle uyuşmuyorsa muhasebe düzeltilmiş SAYILMAZ:
// gün "muhasebe işlemi gerekli" olarak işaretlenir (accounting) — fark otomatik belgeyle kapatılmaz (Aşama 7F-2).
import { dayKey, orderLoad } from '../orders/loading.js';
import { effectiveItems, itemAsLine, lineTotals } from '../loading/confirmation.js';
import { ACTION_REQUIRED, orderImpacts } from '../glass/invoice-batch.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const add = (map, cur, key, v) => {
  const o = (map[cur] ??= { sale: 0, cost: 0, transport: 0 });
  o[key] = round2(o[key] + v);
};
/** Müşterinin ödediği (bedelsiz değil, müşteri fiyatı > 0) ama fabrika maliyeti (satış fiyatı) kayıtlı olmayan satır */
export const missingCost = (l) => !l.free && Number(l.offerPrice ?? 0) > 0 && !(Number(l.unitPrice ?? 0) > 0);

/**
 * Siparişin muhasebe satırı: müşteriye gönderilmiş son teklif. Gönderilmiş teklifi olmayan sipariş null.
 *   - Bedelsiz satır: müşteriye satış 0; maliyet satırdaki satış fiyatı kadardır (satış bedelsiz yaptıysa o fiyat zaten 0).
 *   - noCost: müşterinin ödediği (bedelsiz olmayan, müşteri fiyatı > 0) ama satış fiyatı / maliyeti girilmemiş satır
 *     sayısı — ör. teklife yöneticinin eklediği ve fabrika fiyatı bulunamayan satır. Maliyet sessizce 0 sayılmaz:
 *     ekranda bu siparişler ayrıca gösterilir.
 * @param {{ id: string, orderNo: string, actualShipDate: Date | null, estimatedShipDate: Date | null,
 *   offers: { status: string, currency: string, offerAmount?: unknown, lines: object[] }[], items?: { camAdedi: number }[] }} o
 */
export function orderLine(o) {
  const sent = o.offers.find((x) => x.status === 'GONDERILDI');
  const d = o.actualShipDate ?? o.estimatedShipDate;
  if (!sent || !d) return null;
  const load = orderLoad({
    lines: sent.lines.map((l) => ({ description: l.description, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, weightKgM2: l.weightKgM2 != null ? Number(l.weightKgM2) : null })),
    items: o.items ?? [],
  });
  // 3.10 öncesi teklif (müşteri fiyatı sütunu yok): müşteriye giden fiyat satırdaki tek fiyattı (lib/orders.ts → offerPrices)
  const legacy = sent.offerAmount == null;
  const t = lineTotals(legacy ? sent.lines.map((l) => ({ ...l, offerPrice: l.unitPrice })) : sent.lines);
  // Maliyeti eksik satırlar (yönetici Muhasebe'de yalnızca bunların maliyetini girebilir — server/accounting/cost-correction.js)
  const noCostLines = legacy ? [] : sent.lines.filter(missingCost).map((l) => ({
    lineId: l.id, description: l.description, kind: l.kind ?? 'CAM', unit: l.unit ?? 'm2', adet: l.adet, offerPrice: Number(l.offerPrice),
  }));
  // Gün: Yüklemeler sayfasıyla aynı (Romanya günü) — yükleme onayı da aynı günle eşleşir
  return {
    orderId: o.id, orderNo: o.orderNo, day: dayKey(d), currency: sent.currency, m2: load.metraj, sale: t.sale, cost: t.cost,
    noCost: noCostLines.length, noCostLines, confirmed: false,
  };
}

/**
 * Onaylı yüklemedeki bir siparişin muhasebe satırı: yalnızca fiilen yüklenen (LOADED) kalemlerin onay anındaki kopyası.
 * Hiç yüklenen kalemi yoksa null.
 * @param {{ orderId: string, orderNo: string, day: string, items: object[] }} g
 */
export function confirmedLine(g) {
  const loaded = g.items.filter((i) => i.status === 'LOADED');
  if (loaded.length === 0) return null;
  const t = lineTotals(loaded.map(itemAsLine));
  return {
    orderId: g.orderId, orderNo: g.orderNo, day: g.day, currency: loaded[0].currency, m2: round2(loaded.reduce((s, i) => s + Number(i.m2), 0)),
    sale: t.sale, cost: t.cost, noCost: t.noCost, noCostLines: [], confirmed: true,
  };
}

/**
 * Planlanan (eski hesap) satırlarla onaylı yükleme satırlarını birleştirir; hiçbir sipariş iki kez sayılmaz.
 *   - Onaylı günde yalnızca onaydaki siparişler sayılır. O güne planlı ama onayda olmayan sipariş sayılmaz ve
 *     `outside` listesine yazılır (ör. onaydan sonra o güne alınmış sipariş).
 *   - Onaylı bir yüklemede yüklenmiş sipariş, tarihi başka güne alınmış olsa da o günde yeniden sayılmaz.
 * @param {ReturnType<typeof orderLine>[]} planned
 * @param {{ day: string, orders: { orderId: string, orderNo: string, items: object[] }[] }[]} confirmations
 */
export function mergeConfirmed(planned, confirmations) {
  const confirmedDays = new Set(confirmations.map((c) => c.day));
  const lines = [];
  // Bir onayda kalemi olan sipariş (yüklenmiş ya da yüklenmemiş) planlanan hesaba girmez: yüklenen kısmı o onayın
  // gününde sayılır; yüklenmeyen kısmı ancak ileride fiilen yüklendiği onayın gününde sayılır (karar 102).
  const loaded = new Set();
  for (const c of confirmations) {
    for (const o of c.orders) {
      loaded.add(o.orderId);
      const l = confirmedLine({ ...o, day: c.day });
      if (l) lines.push(l);
    }
  }
  const outside = new Map();
  for (const l of planned) {
    if (!l || loaded.has(l.orderId)) continue;
    if (confirmedDays.has(l.day)) outside.set(l.day, [...(outside.get(l.day) ?? []), { orderId: l.orderId, orderNo: l.orderNo }]);
    else lines.push(l);
  }
  return { lines, confirmedDays, outside };
}

/**
 * Yükleme günleri: m², para birimi başına satış / maliyet / nakliye / kâr; noCost = maliyeti eksik siparişlerin numaraları.
 * confirmed: gün "Eksiksiz Yüklendi" olarak onaylı (tutarlar onay kopyasından) · outside: onaylı güne planlı ama onayda olmayanlar.
 * accounting: kesilmiş faturası düzeltilmiş yüklemeyle uyuşmayan siparişler (supplierData doldurur; muhasebe işlemi gerekli).
 * @param {(ReturnType<typeof orderLine> | ReturnType<typeof confirmedLine>)[]} lines
 * @param {{ shipDay: Date, amount: unknown, currency: string }[]} costs
 * @param {{ confirmedDays?: Set<string>, outside?: Map<string, { orderId: string, orderNo: string }[]> }} [conf]
 */
export function loadingProfits(lines, costs, { confirmedDays = new Set(), outside = new Map() } = {}) {
  const days = new Map();
  const dayOf = (key) => {
    if (!days.has(key)) days.set(key, { day: key, orders: 0, m2: 0, byCur: {}, noCost: [], confirmed: confirmedDays.has(key), outside: outside.get(key) ?? [], accounting: [] });
    return days.get(key);
  };
  for (const l of lines) {
    if (!l) continue;
    const d = dayOf(l.day);
    d.orders++;
    d.m2 = round2(d.m2 + l.m2);
    add(d.byCur, l.currency, 'sale', l.sale);
    add(d.byCur, l.currency, 'cost', l.cost);
    if (l.noCost > 0) d.noCost.push({ orderId: l.orderId, orderNo: l.orderNo });
  }
  // Nakliye yükleme gününe ve para birimine göre: yalnızca aynı para biriminin kârından düşülür
  for (const c of costs) add(dayOf(new Date(c.shipDay).toISOString().slice(0, 10)).byCur, c.currency, 'transport', Number(c.amount));
  const out = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const d of out) for (const v of Object.values(d.byCur)) v.profit = round2(v.sale - v.cost - v.transport);
  return out;
}

/**
 * Üst özet ve fabrika bakiyesi, para birimi başına.
 * @param {ReturnType<typeof loadingProfits>} days
 * @param {{ amount: unknown, currency: string }[]} payments
 */
export function supplierSummary(days, payments) {
  const s = {};
  const cur = (c) => (s[c] ??= { sale: 0, cost: 0, transport: 0, profit: 0, paid: 0, balance: 0 });
  for (const d of days) {
    for (const [c, v] of Object.entries(d.byCur)) {
      const o = cur(c);
      o.sale = round2(o.sale + v.sale);
      o.cost = round2(o.cost + v.cost);
      o.transport = round2(o.transport + v.transport);
      o.profit = round2(o.profit + v.profit);
    }
  }
  for (const p of payments) {
    const o = cur(p.currency);
    o.paid = round2(o.paid + Number(p.amount));
  }
  for (const o of Object.values(s)) o.balance = round2(o.cost - o.paid);
  return s;
}

export const CURRENCIES = ['EUR', 'RON', 'USD', 'TRY'];
export const MAX_AMOUNT = 100_000_000;

/** Tutar: "1.234,56" / "1234.56" → sayı (pozitif); geçersiz → null */
export function parseAmount(v) {
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= MAX_AMOUNT ? round2(n) : null;
}

/**
 * Sayfa verisi: bugüne kadar yüklenmiş (yükleme günü bugün ya da önce) cam siparişleri, nakliye ve ödemeler.
 * @param {Date} endOfToday  bu andan önceki yükleme günleri
 */
export async function supplierData(db, endOfToday) {
  const orders = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', status: { not: 'IPTAL' }, onHold: false,
      OR: [{ actualShipDate: { lt: endOfToday } }, { actualShipDate: null, estimatedShipDate: { lt: endOfToday } }],
    },
    include: { items: { select: { camAdedi: true } }, offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
  const [costs, payments, confirmed] = await Promise.all([
    db.loadingCost.findMany({ orderBy: [{ shipDay: 'desc' }, { createdAt: 'asc' }] }),
    db.factoryPayment.findMany({ orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }] }),
    db.loadingConfirmation.findMany({
      orderBy: { shipDay: 'desc' },
      include: { items: { orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }], include: { order: { select: { orderNo: true } } } } },
    }),
  ]);
  const confirmations = confirmed.map((c) => {
    const byOrder = new Map();
    // Geçerli durum: düzeltilmiş kapsamda son düzeltmenin kalemleri (eski satırlar sayılmaz — çift sayım olmaz)
    for (const it of effectiveItems(c.items)) {
      const g = byOrder.get(it.orderId) ?? { orderId: it.orderId, orderNo: it.order.orderNo, items: [] };
      g.items.push(it);
      byOrder.set(it.orderId, g);
    }
    return { day: c.shipDay.toISOString().slice(0, 10), orders: [...byOrder.values()] };
  });
  const planned = orders.map(orderLine);
  const merged = mergeConfirmed(planned, confirmations);
  const days = loadingProfits(merged.lines, costs, merged);
  // Düzeltilmiş onaylarda kesilmiş faturası fiili yüklemeyle uyuşmayan siparişler: gün işaretlenir (yalnızca saptama)
  for (const c of confirmed.filter((x) => x.items.some((i) => i.revision > 0))) {
    const list = [...(await orderImpacts(db, { confirmationId: c.id, items: effectiveItems(c.items) })).values()].filter((x) => ACTION_REQUIRED.includes(x.code));
    const d = days.find((x) => x.day === c.shipDay.toISOString().slice(0, 10));
    if (d && list.length) d.accounting = list.map((x) => ({ orderId: x.orderId, orderNo: x.orderNo, code: x.code, ref: x.ref }));
  }
  // Maliyeti girilebilecek satırlar: yalnızca henüz onaylı yüklemeye girmemiş siparişlerin eksik maliyetleri
  const missing = merged.lines.filter((l) => !l.confirmed && l.noCostLines.length > 0)
    .map((l) => ({ orderId: l.orderId, orderNo: l.orderNo, day: l.day, currency: l.currency, lines: l.noCostLines }));
  return { days, costs, payments, summary: supplierSummary(days, payments), missing };
}
