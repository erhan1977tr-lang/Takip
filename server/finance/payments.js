// Müşteri ödemeleri ve avans faturası tutarı — SAF kurallar (Paket 10, kararlar 206–208). Veritabanı tarafı
// server/finance/service.js; ekran ve işçiler aynı işlevleri kullanır (ikinci bir hesap yazılmaz).
//
//   İki ayrı kaynak: FGO'nun proformada gösterdiği tahsilat (FgoDocument.paid — "FGO doğrulandı") ve yöneticinin elle
//   kaydettiği ödemeler (ManualPayment — "elle"). Elle kayıt FGO tahsilatının yerine geçmez, onunla karşılaştırılır.
//   Avansı kesilecek tutar = max(FGO tahsilatı, elle kayıtların RON toplamı) − avansı kesilen (TVA dahil, RON).
//     - Aynı ödeme hem elle kaydedilip hem FGO'da görünse de BİR kez sayılır (en büyüğü, toplam değil): müşterinin 2.000 EUR
//       avansı elle kaydedilip avansı kesildikten sonra FGO'da aynı tutar görününce kesilecek tutar 0 kalır.
//     - İki kaynak farklıysa (biri eksik / fazla) fark "inceleme gerekli" olarak gösterilir; tahmin yapılmaz.
//   Tutarlar kuruş (BigInt) ile tam hesaplanır; EUR ödeme zincirin KAYITLI kuruyla (proformanın kuru, karar 96) RON'a
//   çevrilir — yeni kur çözülmez. Kur yoksa (RON zincirinde EUR ödeme) kayıt alınmaz (CURRENCY).
import crypto from 'node:crypto';
import { fromScaled, toScaled } from '../suppliers/money.js';

export const PAYMENT_METHODS = Object.freeze(['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER']);
export const PAYMENT_CURRENCIES = Object.freeze(['EUR', 'RON']);
/** Tek ödeme üst sınırı (tutar, kaynak para biriminde) */
export const PAYMENT_MAX = 10_000_000;
export const REFERENCE_MAX = 120;
export const NOTE_MAX = 500;
export const VOID_REASON_MAX = 300;
/** Aynı müşteride aynı tutar araması: son 180 gün (karar 208) */
export const DUPLICATE_WINDOW_DAYS = 180;
/** Elle kayda dayanan avans faturası kesildi ama FGO bu kadar gün sonra hâlâ tahsilatı göstermiyor → inceleme */
export const UNVERIFIED_DAYS = 14;
/** Belirsiz FGO belgesi: yöneticinin girdiği belgenin FGO toplamı ile beklenen toplam arasındaki izin verilen fark (RON) */
export const RECORD_TOLERANCE = 0.1;
const EARLIEST = '2020-01-01';

/** Tutar → kuruş (BigInt). Sayı ise 2 ondalığa yuvarlanır; Decimal / metin en çok 2 ondalık. Geçersiz → 0n. */
export function toCents(v) {
  if (v == null || v === '') return 0n;
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '0') : String(v).trim();
  const neg = s.startsWith('-');
  const c = toScaled(neg ? s.slice(1) : s, 2);
  if (c == null) return 0n;
  return neg ? -c : c;
}
/** Kuruş → sayı (ekran ve mevcut zincir işlevleriyle uyum için) */
export const centsNum = (c) => Number(fromScaled(c, 2, 2));
/** Kuruş → "123.45" */
export const centsText = (c) => fromScaled(c, 2, 2);
const maxC = (a, b) => (a > b ? a : b);

/**
 * Elle ödeme formu (sunucuda doğrulanır).
 * @param {Record<string, unknown>} raw  { paidOn, amount, currency, method, reference, note }
 * @param {{ today: string }} o  bugün (yerel gün, "YYYY-MM-DD") — ileri tarihli ödeme kabul edilmez
 * @returns {{ ok: true, value: { paidOn: string, amount: string, currency: string, method: string, reference: string | null, note: string | null } } | { ok: false, code: 'DATE' | 'FUTURE' | 'AMOUNT' | 'CURRENCY' | 'METHOD' | 'REFERENCE' | 'NOTE' }}
 */
export function parsePayment(raw, { today }) {
  const paidOn = String(raw?.paidOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T12:00:00Z`)) || new Date(`${paidOn}T12:00:00Z`).toISOString().slice(0, 10) !== paidOn || paidOn < EARLIEST) return { ok: false, code: 'DATE' };
  if (paidOn > today) return { ok: false, code: 'FUTURE' };
  const a = String(raw?.amount ?? '').replace(/\s/g, '');
  const norm = /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(a) ? a.replace(/\./g, '').replace(',', '.') : a;
  if (!/^\d{1,9}([.,]\d{1,2})?$/.test(norm)) return { ok: false, code: 'AMOUNT' };
  const c = toCents(norm.replace(',', '.'));
  if (c <= 0n || c > BigInt(PAYMENT_MAX) * 100n) return { ok: false, code: 'AMOUNT' };
  const currency = String(raw?.currency ?? '');
  if (!PAYMENT_CURRENCIES.includes(currency)) return { ok: false, code: 'CURRENCY' };
  const method = String(raw?.method ?? '');
  if (!PAYMENT_METHODS.includes(method)) return { ok: false, code: 'METHOD' };
  const reference = String(raw?.reference ?? '').replace(/\s+/g, ' ').trim();
  if (reference.length > REFERENCE_MAX) return { ok: false, code: 'REFERENCE' };
  const note = String(raw?.note ?? '').trim();
  if (note.length > NOTE_MAX) return { ok: false, code: 'NOTE' };
  return { ok: true, value: { paidOn, amount: centsText(c), currency, method, reference: reference || null, note: note || null } };
}

/**
 * Ödemenin RON karşılığı (kuruş): RON aynen; EUR × zincirin kayıtlı kuru (4 ondalık), bir kez yarım-yukarı yuvarlanır.
 * Zincir RON ise (kur yok) EUR ödeme çevrilmez → null (kayıt alınmaz, CURRENCY).
 * @param {{ amount: unknown, currency: string }} p  @param {{ rate: unknown }} chain  rate: zincirin EUR kuru; RON zincirinde null
 * @returns {bigint | null}
 */
export function paymentRonCents({ amount, currency }, { rate }) {
  const c = toCents(amount);
  if (currency === 'RON') return c;
  if (currency !== 'EUR' || rate == null) return null;
  const r = toScaled(String(rate), 4);
  if (r == null || r <= 0n) return null;
  return (c * r + 5000n) / 10000n;
}

/**
 * Elle kayıt ile FGO tahsilatının karşılaştırması (karar 207). Eşitlik kuruşu kuruşuna (RON):
 *   NONE (ikisi de yok) · FGO_ONLY (yalnızca FGO — elle kayıt şart değil) · MANUAL_ONLY (FGO'da henüz görünmüyor) ·
 *   MATCHED (aynı tutar) · MISMATCH (ikisi de var, farklı → inceleme)
 * @param {bigint} fgo  @param {bigint} manual
 */
export function paymentMatch(fgo, manual) {
  if (fgo <= 0n && manual <= 0n) return 'NONE';
  if (manual <= 0n) return 'FGO_ONLY';
  if (fgo <= 0n) return 'MANUAL_ONLY';
  return fgo === manual ? 'MATCHED' : 'MISMATCH';
}

/** Avans faturasının dayanağı: FGO tahsilatı mı, elle kayıt mı (ikisi aynıysa FGO_MANUAL) */
export function basisOf(fgo, manual) {
  if (manual > fgo) return 'MANUAL';
  return manual > 0n && manual === fgo ? 'FGO_MANUAL' : 'FGO';
}

/**
 * Bir belge zincirinin (sipariş başına ya da müşteri proforması) ödeme / avans durumu — TEK hesap.
 * @param {{ fgoPaid: unknown, proformaTotal?: unknown, payments?: { ron: unknown, voidedAt?: unknown }[], advanced: unknown }} p
 *   fgoPaid: FGO'nun proformada gösterdiği tahsilat (TVA dahil RON) · payments: zincirin elle kayıtları (geçersiz olanlar
 *   sayılmaz) · advanced: kesilmiş (ve kuyruktaki) avansların karşıladığı toplam
 * @returns {{ fgoPaid: number, manualRon: number, basis: number, advanced: number, advanceRequired: number,
 *   advanceBasis: 'FGO' | 'MANUAL' | 'FGO_MANUAL', match: string, review: string[], full: boolean | null }}
 */
export function paymentState({ fgoPaid, proformaTotal = null, payments = [], advanced }) {
  const fgo = maxC(toCents(fgoPaid), 0n);
  const manual = payments.filter((x) => !x.voidedAt).reduce((s, x) => s + toCents(x.ron), 0n);
  const adv = maxC(toCents(advanced), 0n);
  const basis = maxC(fgo, manual);
  const required = basis > adv ? basis - adv : 0n;
  const match = paymentMatch(fgo, manual);
  const review = [];
  if (match === 'MISMATCH') review.push('MISMATCH');
  const total = proformaTotal == null ? null : toCents(proformaTotal);
  if (total != null && total > 0n && basis > total) review.push('OVERPAID');
  return {
    fgoPaid: centsNum(fgo), manualRon: centsNum(manual), basis: centsNum(basis), advanced: centsNum(adv), advanceRequired: centsNum(required),
    advanceBasis: basisOf(fgo, manual), match, review, full: total == null || total <= 0n ? null : basis >= total,
  };
}

/**
 * Avans faturası kesilince hangi elle kayıtları karşıladığı (izlenebilirlik, karar 207): geçerli kayıtlar tarih sırasıyla
 * birikir; biriken RON toplamı avansı kesilen toplamı aşmayan ve henüz bağlanmamış kayıtlar bu avansa bağlanır.
 * @param {{ id: string, ron: unknown, paidOn: unknown, createdAt?: unknown, voidedAt?: unknown, linked?: boolean }[]} payments
 * @param {unknown} advancedTotal  bu avansla birlikte avansı kesilen toplam
 * @returns {string[]}
 */
export function coveredPaymentIds(payments, advancedTotal) {
  const limit = toCents(advancedTotal);
  const key = (x) => `${new Date(x.paidOn).toISOString()}|${x.createdAt ? new Date(x.createdAt).toISOString() : ''}|${x.id}`;
  let sum = 0n;
  const out = [];
  for (const x of payments.filter((p) => !p.voidedAt).sort((a, b) => (key(a) < key(b) ? -1 : 1))) {
    sum += toCents(x.ron);
    if (sum > limit) break;
    if (!x.linked) out.push(x.id);
  }
  return out;
}

/**
 * Aynı müşteride aynı tutar (karar 208): yeni kayıt / avans ile aynı müşterinin son 180 gündeki kayıtlarından aynı tutarlı
 * olanlar. Eşleşme: aynı RON karşılığı (kuruşu kuruşuna) ya da elle kayıtta aynı tutar + aynı para birimi.
 * @param {{ ron: unknown, amount?: unknown, currency?: string, exclude?: string[] }} target
 * @param {{ key: string, kind: 'PAYMENT' | 'ADVANCE' | 'ADVANCE_PENDING', ron: unknown, amount?: unknown, currency?: string, at: unknown, ref?: string | null, orderNo?: string | null }[]} candidates
 * @param {{ now: Date, windowDays?: number }} o
 */
export function duplicateMatches(target, candidates, { now, windowDays = DUPLICATE_WINDOW_DAYS }) {
  const ron = toCents(target.ron);
  const amount = target.amount == null ? null : toCents(target.amount);
  const since = now.getTime() - windowDays * 86_400_000;
  const skip = new Set(target.exclude ?? []);
  return candidates.filter((c) => {
    if (skip.has(c.key)) return false;
    const at = new Date(c.at).getTime();
    if (!(at >= since)) return false;
    if (ron > 0n && toCents(c.ron) === ron) return true;
    return amount != null && c.kind === 'PAYMENT' && c.currency === target.currency && toCents(c.amount) === amount;
  }).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Eşleşmelerin onay anahtarı: yönetici gördüğü eşleşmeleri onaylar; eşleşmeler değişirse eski onay geçmez */
export const ackKeyOf = (matches) => (matches.length ? crypto.createHash('sha256').update(matches.map((m) => m.key).join('|')).digest('hex').slice(0, 24) : '');

/**
 * Sipariş başına zincirde hesaba giren elle kayıtlar: yalnızca zincirin GEÇERLİ proformasına kaydedilenler. Proforma FGO'da
 * silinip yenisi kesildiyse eski proformaya kaydedilen ödeme yeni zincire tahminle taşınmaz (ekranda "başka belge
 * zincirinde" görünür; yönetici gerekirse geçersiz kılıp yeni proformaya yeniden kaydeder). Proforma yoksa hiçbiri.
 * @template {{ proformaRef?: string | null }} P
 * @param {P[]} payments  @param {{ series: string, number: string } | null | undefined} proforma
 * @returns {P[]}
 */
export function ofProforma(payments, proforma) {
  if (!proforma) return [];
  const ref = `${proforma.series}${proforma.number}`;
  return payments.filter((p) => p.proformaRef === ref);
}

/** Formun tek kullanımlık anahtarı: 16–64 güvenli karakter */
export const validRequestKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v);
