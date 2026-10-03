// Kurun TEK çözüldüğü yer (Aşama 7D-1, karar 95–96). Cam proforma / fatura akışı ve ileride müşteri düzeyindeki
// FGO belgeleri kuru buradan alır; başka bir yerde kur hesabı yapılmaz.
//
// Müşterinin kur politikası (Customer.fxPolicy):
//   boş (LEGACY)      → 7D-1 öncesi davranış aynen: Entegrasyonlar'daki kur ayarı (server/fx/bt.js → rateForDay).
//   BT_UNIT_SELL      → BT sitesindeki "În unitățile BT → Vânzare". Bu değerin sunucudan güvenilir biçimde okunabildiği
//                       bir kaynak YOK (site sunucu isteklerini reddediyor); bu yüzden yöneticinin o gün Entegrasyonlar'a
//                       elle girdiği "günün BT kuru" kullanılır. BT'nin XML dosyası (exchange.xml) FARKLI bir kurdur ve
//                       bu politika için ASLA kullanılmaz — fxMode 'auto' olsa bile.
//   BNR               → BNR resmî kuru (server/fx/bnr.js).
//   BNR_PLUS_PERCENT  → BNR × (1 + yüzde / 100).
// Elle kur (manualRate): yönetici belgeyi isterken açıkça girer; her politikanın önüne geçer ve MANUAL diye işaretlenir.
// BNR alınamazsa elle girilmiş başka bir kura sessizce düşülmez: hata verilir (belge bekler / yönetici elle kur girer).

import { dailyRateFor, fetchBtEurSell, parseManualRate, rateForDay } from './bt.js';
import { bnrRate } from './bnr.js';
import { RATE_PLACES, applyMarkup, dec, fmt, padRate } from './decimal.js';

export const FX_POLICIES = /** @type {const} */ (['BT_UNIT_SELL', 'BNR', 'BNR_PLUS_PERCENT']);
/** Yüzde üst sınırı ve ondalık sayısı (Customer.fxMarkupPercent: Decimal(6,3)) */
export const FX_MARKUP_MAX = 20;
const PERCENT_PLACES = 3;

/**
 * @typedef {Object} FxResult
 * @property {'LEGACY' | 'BT_UNIT_SELL' | 'BNR' | 'BNR_PLUS_PERCENT'} policy  müşterinin politikası (elle kurda da müşterininki)
 * @property {string} currency
 * @property {string} baseRate  taban kur (BNR / BT / elle), metin
 * @property {string | null} markupPercent  yalnızca BNR_PLUS_PERCENT ve elle değilse
 * @property {string} finalRate  uygulanan kur, 4 ondalık metin
 * @property {number} rate  finalRate sayı olarak (FGO tutar hesabı için)
 * @property {string} source  BNR | MANUAL | MANUAL_DAY | (eski davranışta) BT adresi
 * @property {string} sourceDate  YYYY-AA-GG
 * @property {string} resolvedAt  ISO zaman
 * @property {boolean} manual
 */

/** Kur çözülemedi: belge kesilmez (yeniden denenir); code arayüz mesajını seçer */
export class FxUnavailable extends Error {
  /** @param {'BT_MANUAL_REQUIRED' | 'BNR_UNAVAILABLE' | 'LEGACY_UNAVAILABLE' | 'CURRENCY' | 'BAD_POLICY' | 'BAD_MANUAL'} code  @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** "2", "2,5" → "2.000" / "2.500"; geçersiz (sayı değil, eksi, üst sınırın üstü, 3'ten çok ondalık) → null */
export function parseMarkupPercent(v) {
  const d = dec(String(v ?? '').trim().replace(',', '.'));
  if (!d || d.s > PERCENT_PLACES) return null;
  const milli = d.n * 10n ** BigInt(PERCENT_PLACES - d.s);
  if (milli > BigInt(FX_MARKUP_MAX) * 1000n) return null;
  return fmt(milli, PERCENT_PLACES, PERCENT_PLACES);
}

/**
 * Müşteri formundaki kur politikası alanları.
 * @param {{ policy: unknown, percent: unknown }} raw
 * @returns {{ ok: true, data: { fxPolicy: 'BT_UNIT_SELL' | 'BNR' | 'BNR_PLUS_PERCENT' | null, fxMarkupPercent: string | null } } | { ok: false, code: 'BAD_POLICY' | 'BAD_PERCENT' }}
 */
export function parseFxPolicy(raw) {
  const policy = String(raw.policy ?? '').trim();
  if (policy === '') return { ok: true, data: { fxPolicy: null, fxMarkupPercent: null } };
  const p = FX_POLICIES.find((x) => x === policy);
  if (!p) return { ok: false, code: 'BAD_POLICY' };
  if (p !== 'BNR_PLUS_PERCENT') return { ok: true, data: { fxPolicy: p, fxMarkupPercent: null } };
  const percent = parseMarkupPercent(raw.percent);
  return percent == null ? { ok: false, code: 'BAD_PERCENT' } : { ok: true, data: { fxPolicy: p, fxMarkupPercent: percent } };
}

/** Yüzdeyi gösterim için kısaltır: "2.000" → "2", "2.500" → "2.5" */
export const trimPercent = (v) => String(v ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/**
 * Müşteri + para birimi + gün için uygulanacak kur ve nereden geldiği.
 * @param {any} db
 * @param {{
 *   customer: { fxPolicy?: string | null, fxMarkupPercent?: unknown } | null,
 *   currency?: string, day: string, now?: Date,
 *   settings?: { fxMode?: string, fxUrl?: string },
 *   manualRate?: number | string | null,
 *   rateImpl?: Function, bnrImpl?: typeof bnrRate,
 * }} o  day: belge günü (YYYY-AA-GG); settings: FGO ayarları (yalnızca eski davranış için)
 * @returns {Promise<FxResult>}  çözülemezse FxUnavailable
 */
export async function resolveExchangeRate(db, { customer, currency = 'EUR', day, now = new Date(), settings = {}, manualRate = null, rateImpl = fetchBtEurSell, bnrImpl = bnrRate }) {
  const raw = customer?.fxPolicy ?? null;
  if (raw != null && !FX_POLICIES.includes(/** @type {any} */ (raw))) throw new FxUnavailable('BAD_POLICY', `Bilinmeyen kur politikası: ${raw}`);
  /** @type {FxResult['policy']} */
  const policy = /** @type {any} */ (raw) ?? 'LEGACY';
  const resolvedAt = now.toISOString();
  /** @returns {FxResult} */
  const out = (baseRate, finalRate, source, sourceDate, manual, markupPercent = null) => ({
    policy, currency, baseRate, markupPercent, finalRate, rate: Number(finalRate), source, sourceDate, resolvedAt, manual,
  });

  // Yöneticinin bu belge için açıkça girdiği kur: olduğu gibi uygulanır (yüzde eklenmez)
  if (manualRate != null && manualRate !== '') {
    const m = parseManualRate(manualRate);
    if (currency !== 'EUR') throw new FxUnavailable('CURRENCY', `Elle kur yalnızca EUR için girilir: ${currency}`);
    if (m == null) throw new FxUnavailable('BAD_MANUAL', 'Elle girilen kur geçersiz');
    const r = m.toFixed(4);
    return out(r, r, 'MANUAL', day, true);
  }

  if (policy === 'BNR' || policy === 'BNR_PLUS_PERCENT') {
    const r = await bnrImpl({ currency, day, now });
    if (!r.ok) throw new FxUnavailable('BNR_UNAVAILABLE', `BNR kuru alınamadı (${r.error}); yeniden denenir ya da belge istenirken kur elle girilir`);
    // Uygulanan kur 4 ondalık; birden çok birimle verilen para birimlerinde (HUF, JPY…) taban kurun ondalığı korunur
    const places = Math.max(RATE_PLACES, dec(r.rate)?.s ?? 0);
    if (policy === 'BNR') return out(r.rate, padRate(r.rate, places), 'BNR', r.date, false);
    const percent = parseMarkupPercent(customer?.fxMarkupPercent);
    const final = percent == null ? null : applyMarkup(r.rate, percent, places);
    if (final == null) throw new FxUnavailable('BAD_POLICY', 'Müşterinin BNR + % yüzdesi geçersiz');
    return out(r.rate, final, 'BNR', r.date, false, percent);
  }

  // BT kurları yalnızca EUR için girilir / okunur
  if (currency !== 'EUR') throw new FxUnavailable('CURRENCY', `Bu kur politikasında yalnızca EUR desteklenir: ${currency}`);

  if (policy === 'BT_UNIT_SELL') {
    // Otomatik kaynak yok: yöneticinin bugün girdiği BT kuru. BT XML'i (settings.fxUrl) burada hiç okunmaz.
    const m = await dailyRateFor(db, day);
    if (m == null) throw new FxUnavailable('BT_MANUAL_REQUIRED', 'BT "În unitățile BT" kuru otomatik alınamıyor; Entegrasyonlar → Günün BT kuru girilince (ya da belge istenirken kur elle girilince) belge kesilir');
    const r = m.toFixed(4);
    return out(r, r, 'MANUAL_DAY', day, true);
  }

  // LEGACY: 7D-1 öncesi davranış, değiştirilmeden
  try {
    const r = await rateForDay(db, { settings, day, rateImpl });
    const v = Number(r.rate).toFixed(4);
    return out(v, v, r.source, day, r.source === 'MANUAL_DAY');
  } catch (e) {
    throw new FxUnavailable('LEGACY_UNAVAILABLE', String(e?.message ?? e));
  }
}

/**
 * Ekranda göstermek için: hata fırlatmaz.
 * @param {any} db  @param {Parameters<typeof resolveExchangeRate>[1]} o
 * @returns {Promise<{ ok: true, fx: FxResult } | { ok: false, code: string, error: string }>}
 */
export async function previewExchangeRate(db, o) {
  try {
    return { ok: true, fx: await resolveExchangeRate(db, o) };
  } catch (e) {
    return { ok: false, code: e instanceof FxUnavailable ? e.code : 'ERROR', error: String(e?.message ?? e).slice(0, 300) };
  }
}

const asDay = (d) => new Date(`${d}T00:00:00Z`);

/**
 * Belgeyle birlikte saklanacak kur kaydı (GlassBilling alanları). Bir kez yazılır; sonraki BT / BNR değişiklikleri
 * ya da müşterinin politikasının değişmesi bu kaydı etkilemez.
 * @param {FxResult} fx  @param {Date} docDay  belge günü
 */
export function fxSnapshot(fx, docDay) {
  return {
    fxRate: fx.finalRate, fxDate: docDay, fxSource: fx.source,
    fxPolicy: fx.policy, fxCurrency: fx.currency, fxBaseRate: fx.baseRate, fxMarkupPercent: fx.markupPercent,
    fxSourceDate: asDay(fx.sourceDate), fxResolvedAt: new Date(fx.resolvedAt), fxManual: fx.manual,
  };
}

/** Kur kaydını siler (proforma FGO'da silinince: yeni proforma yeniden çözülür) */
export const FX_SNAPSHOT_CLEAR = {
  fxRate: null, fxDate: null, fxSource: null, fxPolicy: null, fxCurrency: null, fxBaseRate: null,
  fxMarkupPercent: null, fxSourceDate: null, fxResolvedAt: null, fxManual: null,
};
