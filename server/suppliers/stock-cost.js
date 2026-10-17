// Nakliye gideri ve gerçekleşen stok maliyeti — SAF kurallar (DÜZELTME 10 M6, 3.97.0). Veritabanı ve ağ yok.
//
// Nakliye: taşıyıcının faturası (EUR ya da RON). RON tutar, fatura tarihindeki KAYITLI kurla (yöneticinin girdiği
// 1 EUR = x RON) EUR'ya bir kez çevrilir (yarım-yukarı 2 ondalık); kur ve tarih kayıtta sabittir, sonradan değişmez. Kur yoksa
// kayıt yapılmaz (FX_REQUIRED) — kur tahmin edilmez.
//
// Dağıtım: nakliyenin EUR tutarı, bağlı mal kabullerinin satırlarına GERÇEK teslim alınan miktara göre BİRİM BAŞINA EŞİT pay
// olarak dağıtılır (1 bar = 1 poşet = 1 kutu = 1 adet — ürünün stok birimi). Pay 10⁻⁴ EUR hassasiyetle, en büyük kalan
// yöntemiyle: satır payları toplamı nakliye tutarına KURUŞU KURUŞUNA eşittir. Dağıtım bir kez, nakliye kaydıyla aynı işlemde
// yazılır ve değişmez (iki kez dağıtılmaz); iptal edilen nakliye maliyetten çıkar.
//
// Gerçekleşen stok maliyeti (ürün başına, EUR / stok birimi): ağırlıklı ortalama =
//   Σ (net teslim alınan × sipariş satırının birim fiyatı + o satıra dağıtılan nakliye) / Σ net teslim alınan
// yalnızca para birimi EUR ve fiyatı olan satırlar üzerinden. Fiyatı olmayan ya da EUR dışı (kur kaydı olmayan) satır
// hesaba GİRMEZ ve ayrıca bildirilir (missingQty) — maliyet uydurulmaz. Katalog alış fiyatı (ProfileProduct.purchasePrice)
// bundan AYRIDIR ve değişmez.
import { cents, fromScaled, money, toScaled } from './money.js';

export const TRANSPORT_CURRENCIES = Object.freeze(['EUR', 'RON']);
export const TRANSPORT_LIMITS = Object.freeze({ carrier: 120, invoiceNo: 60, note: 500, amountMax: 10_000_000, receipts: 50, rateMin: 1, rateMax: 20 });

const one = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const divRound = (num, den) => (num >= 0n ? (num + den / 2n) / den : -((-num + den / 2n) / den));

/**
 * Nakliye formu. Hata kodları: CARRIER, TOO_LONG, AMOUNT, CURRENCY, FX_REQUIRED, FX_RATE, RECEIPTS.
 * @param {{ carrierName?: unknown, invoiceNo?: unknown, amount?: unknown, currency?: unknown, fxRate?: unknown, note?: unknown, receiptIds?: unknown }} raw
 * @returns {{ ok: true, value: { carrierName: string, invoiceNo: string | null, amount: string, currency: string, fxRate: string | null, amountEur: string, note: string | null, receiptIds: string[] } } | { ok: false, code: string }}
 */
export function parseTransport(raw) {
  const carrierName = one(raw.carrierName);
  if (!carrierName) return { ok: false, code: 'CARRIER' };
  const invoiceNo = one(raw.invoiceNo) || null;
  const note = one(raw.note) || null;
  if (carrierName.length > TRANSPORT_LIMITS.carrier || (invoiceNo?.length ?? 0) > TRANSPORT_LIMITS.invoiceNo || (note?.length ?? 0) > TRANSPORT_LIMITS.note) return { ok: false, code: 'TOO_LONG' };
  const a = toScaled(String(raw.amount ?? '').trim().replace(',', '.'), 2);
  if (a == null || a <= 0n || a > BigInt(TRANSPORT_LIMITS.amountMax) * 100n) return { ok: false, code: 'AMOUNT' };
  const currency = String(raw.currency ?? '').trim().toUpperCase();
  if (!TRANSPORT_CURRENCIES.includes(currency)) return { ok: false, code: 'CURRENCY' };
  let fxRate = null;
  let eur = a;
  if (currency === 'RON') {
    const rs = String(raw.fxRate ?? '').trim().replace(',', '.');
    if (!rs) return { ok: false, code: 'FX_REQUIRED' };
    const r = toScaled(rs, 6);
    if (r == null || r < BigInt(TRANSPORT_LIMITS.rateMin) * 1_000_000n || r > BigInt(TRANSPORT_LIMITS.rateMax) * 1_000_000n) return { ok: false, code: 'FX_RATE' };
    fxRate = fromScaled(r, 6);
    eur = ronToEurCents(a, r);
  }
  const ids = Array.isArray(raw.receiptIds) ? [...new Set(raw.receiptIds.map((x) => String(x ?? '').trim()).filter(Boolean))] : [];
  if (!ids.length || ids.length > TRANSPORT_LIMITS.receipts || ids.some((x) => !/^[A-Za-z0-9_-]{8,64}$/.test(x))) return { ok: false, code: 'RECEIPTS' };
  return { ok: true, value: { carrierName, invoiceNo, amount: money(a), currency, fxRate, amountEur: money(eur), note, receiptIds: ids } };
}

/** RON kuruş ÷ kur (10⁻⁶) → EUR kuruş, bir kez yarım-yukarı */
export function ronToEurCents(ronCents, rateMicro) {
  return divRound(BigInt(ronCents) * 1_000_000n, BigInt(rateMicro));
}

/**
 * Nakliyeyi satırlara dağıtır: birim başına eşit pay (stok birimi), 10⁻⁴ EUR, en büyük kalan. Toplam = amountEur.
 * @param {string} amountEur  "123.45"
 * @param {{ receiptLineId: string, productId: string, qty: number }[]} lines  net teslim alınan > 0 olanlar
 * @returns {{ ok: true, rows: { receiptLineId: string, productId: string, qty: number, amountEur: string }[] } | { ok: false, code: string }}
 */
export function allocateTransport(amountEur, lines) {
  const usable = lines.filter((l) => Number.isInteger(l.qty) && l.qty > 0);
  const totalQty = usable.reduce((n, l) => n + BigInt(l.qty), 0n);
  if (!usable.length || totalQty <= 0n) return { ok: false, code: 'NO_QTY' };
  const total = cents(amountEur) * 100n; // 10⁻⁴
  const base = usable.map((l) => {
    const num = total * BigInt(l.qty);
    return { l, share: num / totalQty, rem: num % totalQty };
  });
  let left = total - base.reduce((n, b) => n + b.share, 0n);
  // En büyük kalan; eşitlikte satır sırası (kararlı)
  const order = base.map((b, i) => ({ b, i })).sort((x, y) => (y.b.rem > x.b.rem ? 1 : y.b.rem < x.b.rem ? -1 : x.i - y.i));
  for (const { b } of order) {
    if (left <= 0n) break;
    b.share += 1n;
    left -= 1n;
  }
  return { ok: true, rows: base.map((b) => ({ receiptLineId: b.l.receiptLineId, productId: b.l.productId, qty: b.l.qty, amountEur: fromScaled(b.share, 4, 4) })) };
}

/**
 * Ürünlerin gerçekleşen stok maliyeti (ağırlıklı ortalama, EUR / stok birimi, nakliye dahil).
 * @param {{ productId: string, netQty: number, unitPrice: unknown, currency: string }[]} lines  teslim alınan satırlar (net = kabul − düzeltme)
 * @param {{ receiptLineId?: string, productId: string, amountEur: unknown, counted: boolean }[]} allocations  iptal edilmemiş nakliye payları; counted: satırı hesaba giriyor mu
 * @returns {Map<string, { avgEur: string | null, qty: number, valueEur: string, transportEur: string, missingQty: number }>}
 */
export function stockCosts(lines, allocations = []) {
  /** @type {Map<string, { value: bigint, transport: bigint, qty: number, missingQty: number }>} */
  const by = new Map();
  const of = (id) => {
    if (!by.has(id)) by.set(id, { value: 0n, transport: 0n, qty: 0, missingQty: 0 });
    return /** @type {{ value: bigint, transport: bigint, qty: number, missingQty: number }} */ (by.get(id));
  };
  for (const l of lines) {
    const q = Math.max(0, Math.trunc(Number(l.netQty) || 0));
    if (!q) continue;
    const e = of(l.productId);
    const p = l.unitPrice == null || l.unitPrice === '' ? null : toScaled(String(l.unitPrice), 4);
    if (l.currency !== 'EUR' || p == null) { e.missingQty += q; continue; }
    e.value += BigInt(q) * p; // 10⁻⁴
    e.qty += q;
  }
  for (const a of allocations) {
    if (!a.counted) continue;
    const v = toScaled(String(a.amountEur ?? '0'), 4);
    if (v == null) continue;
    of(a.productId).transport += v;
  }
  const out = new Map();
  for (const [id, e] of by) {
    const total = e.value + e.transport;
    out.set(id, {
      avgEur: e.qty > 0 ? fromScaled(divRound(total, BigInt(e.qty)), 4, 2) : null,
      qty: e.qty, valueEur: fromScaled(divRound(total, 100n), 2, 2), transportEur: fromScaled(divRound(e.transport, 100n), 2, 2), missingQty: e.missingQty,
    });
  }
  return out;
}

/**
 * Taşıyıcı giderleri özeti (ürün tedarikçisinin borcundan ayrı): taşıyıcı + para birimi başına toplam / ödenen / kalan.
 * İptal edilen kayıt sayılmaz. Para birimleri toplanmaz.
 * @param {{ carrierName: string, currency: string, amount: unknown, paidOn?: unknown, voidedAt?: unknown }[]} rows
 */
export function carrierBalances(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.voidedAt) continue;
    const key = `${r.carrierName}\u0000${r.currency}`;
    const e = by.get(key) ?? { carrier: r.carrierName, currency: r.currency, total: 0n, paid: 0n, count: 0 };
    e.total += cents(r.amount);
    if (r.paidOn) e.paid += cents(r.amount);
    e.count++;
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => a.carrier.localeCompare(b.carrier) || a.currency.localeCompare(b.currency))
    .map((e) => ({ carrier: e.carrier, currency: e.currency, total: money(e.total), paid: money(e.paid), open: money(e.total - e.paid), count: e.count }));
}
