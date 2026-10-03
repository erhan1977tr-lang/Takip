// Kurun TEK çözüldüğü yer (Aşama 7D-1, karar 95–98). Cam ve profil FGO belgeleri (ve ileride müşteri düzeyindeki
// belgeler) kuru buradan alır; başka bir yerde kur hesabı yapılmaz:
//   Customer.fxPolicy → resolveExchangeRate() → kur kaydı (fxSnapshot) → FGO belgesi o kayıtla kesilir.
//
// Müşterinin kur politikası (Customer.fxPolicy, zorunlu; varsayılan BT_UNIT_SELL):
//   BT_UNIT_SELL      → BT sitesindeki "În unitățile BT → Vânzare". Bu değerin sunucudan güvenilir biçimde okunabildiği
//                       bir kaynak YOK (site sunucu isteklerini reddediyor); bu yüzden yöneticinin o gün Entegrasyonlar'a
//                       elle girdiği "günün BT kuru" kullanılır. BT'nin XML dosyası (exchange.xml) FARKLI bir kurdur ve
//                       belge kuru olarak hiçbir yerde kullanılmaz.
//   BNR               → BNR'nin o an yayımlamış olduğu son resmî kur (server/fx/bnr.js); iş günü takvimi tutulmaz:
//                       cumartesi çözülen kur cuma günü yayımlanan kurdur ve kaynak günü olarak cuma saklanır.
//   BNR_PLUS_PERCENT  → BNR × (1 + yüzde / 100).
// Elle kur (manualRate): yönetici belgeyi isterken açıkça girer; her politikanın önüne geçer ve MANUAL diye işaretlenir.
// Gereken kur alınamazsa başka bir kaynağa sessizce geçilmez: hata verilir (belge bekler / yönetici elle kur girer).

import { dailyRateFor, parseManualRate } from './bt.js';
import { bnrRate } from './bnr.js';
import { RATE_PLACES, applyMarkup, dec, fmt, padRate } from './decimal.js';

export const FX_POLICIES = /** @type {const} */ (['BT_UNIT_SELL', 'BNR', 'BNR_PLUS_PERCENT']);
/** Yüzde üst sınırı ve ondalık sayısı (Customer.fxMarkupPercent: Decimal(6,3)) */
export const FX_MARKUP_MAX = 20;
const PERCENT_PLACES = 3;

/**
 * @typedef {Object} FxResult
 * @property {'BT_UNIT_SELL' | 'BNR' | 'BNR_PLUS_PERCENT'} policy  müşterinin politikası (elle kurda da müşterininki)
 * @property {string} currency
 * @property {string} baseRate  taban kur (BNR / BT / elle), metin
 * @property {string | null} markupPercent  yalnızca BNR_PLUS_PERCENT ve elle değilse
 * @property {string} finalRate  uygulanan kur, 4 ondalık metin
 * @property {number} rate  finalRate sayı olarak (FGO tutar hesabı için)
 * @property {string} source  BNR | MANUAL (bu belge için elle) | MANUAL_DAY (günün BT kuru, elle)
 * @property {string} sourceDate  YYYY-AA-GG
 * @property {string} resolvedAt  ISO zaman
 * @property {boolean} manual
 */

/** Kur çözülemedi: belge kesilmez (yeniden denenir); code arayüz mesajını seçer */
export class FxUnavailable extends Error {
  /** @param {'BT_MANUAL_REQUIRED' | 'BNR_UNAVAILABLE' | 'CURRENCY' | 'BAD_POLICY' | 'BAD_MANUAL'} code  @param {string} message */
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
 * @returns {{ ok: true, data: { fxPolicy: 'BT_UNIT_SELL' | 'BNR' | 'BNR_PLUS_PERCENT', fxMarkupPercent: string | null } } | { ok: false, code: 'BAD_POLICY' | 'BAD_PERCENT' }}
 */
export function parseFxPolicy(raw) {
  const policy = String(raw.policy ?? '').trim();
  const p = FX_POLICIES.find((x) => x === policy);
  if (!p) return { ok: false, code: 'BAD_POLICY' };
  if (p !== 'BNR_PLUS_PERCENT') return { ok: true, data: { fxPolicy: p, fxMarkupPercent: null } };
  const percent = parseMarkupPercent(raw.percent);
  return percent == null ? { ok: false, code: 'BAD_PERCENT' } : { ok: true, data: { fxPolicy: p, fxMarkupPercent: percent } };
}

/** Yüzdeyi gösterim için kısaltır: "2.000" → "2", "2.500" → "2.5" */
export const trimPercent = (v) => String(v ?? '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

const policyOf = (customer) => {
  const p = FX_POLICIES.find((x) => x === customer?.fxPolicy);
  if (!p) throw new FxUnavailable('BAD_POLICY', `Müşterinin kur politikası yok ya da bilinmiyor: ${customer?.fxPolicy ?? '—'}`);
  return p;
};

/**
 * Yöneticinin bir belge için açıkça girdiği kur: olduğu gibi uygulanır (yüzde eklenmez), MANUAL diye işaretlenir.
 * @param {{ customer: { fxPolicy?: string | null } | null, currency?: string, manualRate: number | string, day: string, now?: Date }} o
 * @returns {FxResult}
 */
export function manualExchangeRate({ customer, currency = 'EUR', manualRate, day, now = new Date() }) {
  const policy = policyOf(customer);
  if (currency !== 'EUR') throw new FxUnavailable('CURRENCY', `Elle kur yalnızca EUR için girilir: ${currency}`);
  const m = parseManualRate(manualRate);
  if (m == null) throw new FxUnavailable('BAD_MANUAL', 'Elle girilen kur geçersiz');
  const r = m.toFixed(4);
  return { policy, currency, baseRate: r, markupPercent: null, finalRate: r, rate: Number(r), source: 'MANUAL', sourceDate: day, resolvedAt: now.toISOString(), manual: true };
}

/**
 * Müşteri + para birimi + gün için uygulanacak kur ve nereden geldiği.
 * @param {any} db
 * @param {{
 *   customer: { fxPolicy?: string | null, fxMarkupPercent?: unknown } | null,
 *   currency?: string, day: string, now?: Date,
 *   manualRate?: number | string | null,
 *   bnrImpl?: typeof bnrRate,
 * }} o  day: belge günü (YYYY-AA-GG)
 * @returns {Promise<FxResult>}  çözülemezse FxUnavailable
 */
export async function resolveExchangeRate(db, { customer, currency = 'EUR', day, now = new Date(), manualRate = null, bnrImpl = bnrRate }) {
  if (manualRate != null && manualRate !== '') return manualExchangeRate({ customer, currency, manualRate, day, now });
  const policy = policyOf(customer);
  const resolvedAt = now.toISOString();
  /** @returns {FxResult} */
  const out = (baseRate, finalRate, source, sourceDate, manual, markupPercent = null) => ({
    policy, currency, baseRate, markupPercent, finalRate, rate: Number(finalRate), source, sourceDate, resolvedAt, manual,
  });

  if (policy === 'BNR' || policy === 'BNR_PLUS_PERCENT') {
    // BNR'nin o an yayımlamış olduğu son kur; kaynak günü (ör. cumartesi çözülen kur için cuma) kayda geçer
    const r = await bnrImpl({ currency, day, now });
    if (!r.ok) throw new FxUnavailable('BNR_UNAVAILABLE', `BNR kuru alınamadı (${r.error}); yeniden denenir ya da kur elle girilir`);
    // Uygulanan kur 4 ondalık; birden çok birimle verilen para birimlerinde (HUF, JPY…) taban kurun ondalığı korunur
    const places = Math.max(RATE_PLACES, dec(r.rate)?.s ?? 0);
    if (policy === 'BNR') return out(r.rate, padRate(r.rate, places), 'BNR', r.date, false);
    const percent = parseMarkupPercent(customer?.fxMarkupPercent);
    const final = percent == null ? null : applyMarkup(r.rate, percent, places);
    if (final == null) throw new FxUnavailable('BAD_POLICY', 'Müşterinin BNR + % yüzdesi geçersiz');
    return out(r.rate, final, 'BNR', r.date, false, percent);
  }

  // BT_UNIT_SELL: otomatik kaynak yok → yöneticinin bugün girdiği BT kuru (yalnızca EUR). BT XML'i hiç okunmaz.
  if (currency !== 'EUR') throw new FxUnavailable('CURRENCY', `Bu kur politikasında yalnızca EUR desteklenir: ${currency}`);
  const m = await dailyRateFor(db, day);
  if (m == null) throw new FxUnavailable('BT_MANUAL_REQUIRED', 'BT "În unitățile BT" kuru otomatik alınamıyor; Entegrasyonlar → Günün BT kuru girilince (ya da kur elle girilince) belge kesilir');
  const r = m.toFixed(4);
  return out(r, r, 'MANUAL_DAY', day, true);
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
 * Belgeyle birlikte saklanacak kur kaydı (GlassBilling ve ProfileOrder'da aynı alanlar). Bir kez yazılır; sonraki BT / BNR değişiklikleri
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

/**
 * FGO belgesinin açıklamasındaki kur cümlesinin başı ve günü (kayıtlı kur kaydından): yalnızca gerçekten o kaynaktan
 * gelen kur o adla anılır — günün BT kuru "Curs BT vânzare", BNR kuru "Curs BNR"; yüzde eklenmiş ya da elle girilmiş
 * kur yalnızca "Curs de schimb".
 * @param {{ fxPolicy?: string | null, fxSource?: string | null, fxDate?: Date | null, fxSourceDate?: Date | null }} snap
 * @returns {{ label: string, date: Date | null }}
 */
export function fxDocumentNote(snap) {
  if (snap.fxSource === 'MANUAL_DAY') return { label: 'Curs BT vânzare', date: snap.fxDate ?? null };
  if (snap.fxSource === 'BNR' && snap.fxPolicy === 'BNR') return { label: 'Curs BNR', date: snap.fxSourceDate ?? snap.fxDate ?? null };
  return { label: 'Curs de schimb', date: snap.fxDate ?? null };
}
