// FGO (fatura sistemi) bağlantısı — Aşama 6b. API: https://api.fgo.ro/v1 (test: https://api-testuat.fgo.ro/v1).
//   - Müşteri profil teklifini onaylayınca: PRF serisinde proforma (belge türü ayardan; API'nin kabul ettiği tür
//     test ortamında doğrulanacak).
//   - Teslimde: GKH serisinde fatura. İkisi de RON; birim fiyat = EUR müşteri fiyatı × BT EUR satış kuru
//     (proforma günündeki kur; fatura aynı kurla — karar 46).
//   - Kimlik: CodUnic (CUI) + Hash = SHA1(CodUnic + özel anahtar + müşteri adı | belge no), büyük harf.
// Özel anahtar yalnızca Yönetici → Entegrasyonlar ekranından girilir, şifreli saklanır (server/crypto/secret.js).
import crypto from 'node:crypto';
import { writeAudit } from '../orders/journal.js';
import { openSecret, sealSecret } from '../crypto/secret.js';
import { DEFAULT_FX_URL } from '../fx/bt.js';

export const FGO_KEY = 'fgo';
export const FGO_URLS = { prod: 'https://api.fgo.ro/v1', test: 'https://api-testuat.fgo.ro/v1' };
export const FGO_DEFAULTS = {
  enabled: false, env: 'test', cui: '', proformaSeries: 'PRF', invoiceSeries: 'GKH',
  proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: DEFAULT_FX_URL,
};
const SECRET_PURPOSE = 'fgo-key';

/**
 * Ayarlar (anahtar hariç; yalnızca kayıtlı olup olmadığı).
 * @returns {Promise<typeof FGO_DEFAULTS & { hasKey: boolean, keySealed: string | null }>}
 */
export async function getFgoSettings(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: FGO_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  const out = { ...FGO_DEFAULTS };
  for (const k of Object.keys(FGO_DEFAULTS)) if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
  return { ...out, hasKey: !!v.keySealed, keySealed: v.keySealed ?? null };
}

/** FGO'ya istek gönderilebilir mi (açık, CUI ve anahtar kayıtlı) */
export const fgoReady = (s) => !!(s.enabled && s.cui && s.hasKey);

const SERIES_RE = /^[A-Z0-9]{1,10}$/;
const TYPE_RE = /^[A-Za-z]{2,50}$/;
/**
 * Formdan gelen ayarları doğrular.
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateFgoSettings(raw) {
  const errors = [];
  const cui = String(raw.cui ?? '').replace(/^RO/i, '').replace(/\s/g, '');
  const value = {
    enabled: !!raw.enabled,
    env: raw.env === 'prod' ? 'prod' : 'test',
    cui,
    proformaSeries: String(raw.proformaSeries ?? '').trim().toUpperCase(),
    invoiceSeries: String(raw.invoiceSeries ?? '').trim().toUpperCase(),
    proformaType: String(raw.proformaType ?? '').trim(),
    invoiceType: String(raw.invoiceType ?? '').trim() || 'Factura',
    vatRate: Number(String(raw.vatRate ?? '').replace(',', '.')),
    fxUrl: String(raw.fxUrl ?? '').trim() || DEFAULT_FX_URL,
  };
  if (cui && !/^\d{2,10}$/.test(cui)) errors.push('CUI');
  if (!SERIES_RE.test(value.proformaSeries)) errors.push('PROFORMA_SERIES');
  if (!SERIES_RE.test(value.invoiceSeries)) errors.push('INVOICE_SERIES');
  if (!TYPE_RE.test(value.proformaType)) errors.push('PROFORMA_TYPE');
  if (!TYPE_RE.test(value.invoiceType)) errors.push('INVOICE_TYPE');
  if (!(value.vatRate >= 0 && value.vatRate <= 50)) errors.push('VAT');
  try {
    if (new URL(value.fxUrl).protocol !== 'https:') errors.push('FX_URL');
  } catch {
    errors.push('FX_URL');
  }
  if (value.enabled && !value.cui) errors.push('CUI');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Ayarları kaydeder. key: yeni özel anahtar (boşsa eskisi kalır); clearKey: anahtarı sil.
 * Denetim kaydına anahtar yazılmaz (yalnızca değiştiği).
 */
export async function saveFgoSettings(db, value, { key = '', clearKey = false, secret }, actor) {
  return db.$transaction(async (tx) => {
    const row = await tx.integrationSetting.findUnique({ where: { key: FGO_KEY } });
    const before = row?.value && typeof row.value === 'object' ? row.value : {};
    const k = String(key ?? '').trim();
    const keySealed = clearKey ? null : k ? sealSecret(k, secret, SECRET_PURPOSE) : (before.keySealed ?? null);
    const next = { ...value, keySealed };
    await tx.integrationSetting.upsert({ where: { key: FGO_KEY }, create: { key: FGO_KEY, value: next, updatedById: actor.id }, update: { value: next, updatedById: actor.id } });
    const strip = ({ keySealed: _k, ...rest }) => rest;
    await writeAudit(tx, {
      action: 'SETTINGS_UPDATE', entityType: 'IntegrationSetting', entityId: FGO_KEY, userId: actor.id,
      details: { before: strip(before), after: strip(next), keyChanged: !!k || clearKey, keyCleared: !!clearKey },
    }, actor);
  });
}

/** Kayıtlı anahtarı açar (yalnızca sunucuda, istek anında) */
export const fgoKey = (s, secret) => (s.keySealed ? openSecret(s.keySealed, secret, SECRET_PURPOSE) : null);

/** Hash = SHA1(CodUnic + özel anahtar + veri), büyük harf */
export const fgoHash = (cui, key, data = '') => crypto.createHash('sha1').update(`${cui}${key}${data}`, 'utf8').digest('hex').toUpperCase();

// ---------- belge ----------
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** EUR fiyat → RON birim fiyat (2 hane) */
export const ronPrice = (eur, rate) => round2(Number(eur) * Number(rate));

/**
 * Firmanın fatura bilgisi eksikse eksik alanlar (proforma kesilmez, yöneticiye uyarı).
 * @param {{ name: string, taxId?: string | null, regCom?: string | null, county?: string | null, city?: string | null, address?: string | null, country?: string | null }} c
 */
export function missingBilling(c) {
  const miss = [];
  if (!c.taxId) miss.push('taxId');
  if (!c.county) miss.push('county');
  if (!c.city) miss.push('city');
  if (!c.address) miss.push('address');
  return miss;
}

/**
 * FGO "factura/emitere" gövdesi (form alanları). Satırlar: onaylanan teklifin kopyası.
 * @param {{ settings: object, key: string, kind: 'proforma' | 'invoice', orderNo: string, appUrl: string,
 *   customer: object, lines: { code: string, name: string, unit: string, qty: number, eur: number }[], rate: number, rateDate: string, text?: string }} p
 * @returns {Record<string, string>}
 */
export function emitereForm({ settings, key, kind, orderNo, appUrl, customer, lines, rate, rateDate, text = '' }) {
  const proforma = kind === 'proforma';
  const name = String(customer.name).trim();
  const cui = String(customer.taxId ?? '').replace(/\s/g, '');
  const f = {
    CodUnic: settings.cui,
    Hash: fgoHash(settings.cui, key, name),
    PlatformaUrl: appUrl,
    Serie: proforma ? settings.proformaSeries : settings.invoiceSeries,
    Valuta: 'RON',
    TipFactura: proforma ? settings.proformaType : settings.invoiceType,
    // Aynı belge iki kez kesilmesin: sipariş + tür
    IdExtern: `${orderNo}-${proforma ? 'P' : 'F'}`,
    VerificareDuplicat: 'true',
    Text: [text, `Curs BT vânzare EUR ${rate.toFixed(4)} RON din ${rateDate}. Comanda ${orderNo}.`].filter(Boolean).join(' ').slice(0, 500),
    'Client[Denumire]': name,
    'Client[CodUnic]': cui,
    'Client[NrRegCom]': customer.regCom ?? '',
    'Client[Tara]': customer.country || 'RO',
    'Client[Judet]': customer.county ?? '',
    'Client[Localitate]': customer.city ?? '',
    'Client[Adresa]': customer.address ?? '',
    'Client[Email]': customer.email ?? '',
    'Client[Telefon]': customer.phone ?? '',
    'Client[Tip]': 'PJ',
    'Client[IdExtern]': customer.id ?? '',
  };
  lines.forEach((l, i) => {
    const unit = ronPrice(l.eur, rate);
    f[`Continut[${i}][Denumire]`] = `${l.name} (${l.code})`.slice(0, 250);
    f[`Continut[${i}][CodArticol]`] = l.code;
    f[`Continut[${i}][NrProduse]`] = String(l.qty);
    f[`Continut[${i}][UM]`] = l.unit;
    f[`Continut[${i}][CotaTVA]`] = String(settings.vatRate);
    f[`Continut[${i}][PretUnitar]`] = unit.toFixed(2);
  });
  return f;
}

/** RON tutar (TVA hariç): Σ adet × RON birim fiyat */
export const ronTotal = (lines, rate) => round2(lines.reduce((s, l) => s + round2(l.qty * ronPrice(l.eur, rate)), 0));

/** FGO hata mesajı geçici mi (yeniden denenebilir)? Ağ/zaman aşımı/5xx: evet; FGO'nun "Success: false" yanıtı: hayır. */
export class FgoError extends Error {
  /** @param {string} message @param {{ retry: boolean }} o */
  constructor(message, { retry }) {
    super(message);
    this.retry = retry;
  }
}

async function post(settings, path, form, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${FGO_URLS[settings.env] ?? FGO_URLS.test}${path}`, {
      method: 'POST', body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    });
  } catch (e) {
    throw new FgoError(`FGO'ya ulaşılamadı: ${String(e?.message ?? e).slice(0, 200)}`, { retry: true });
  }
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new FgoError(`FGO yanıtı okunamadı (HTTP ${res.status})`, { retry: res.status >= 500 || res.status === 429 });
  }
  if (res.status >= 500 || res.status === 429) throw new FgoError(`FGO HTTP ${res.status}: ${json?.Message ?? ''}`.trim(), { retry: true });
  if (!json?.Success) throw new FgoError(String(json?.Message ?? `HTTP ${res.status}`).slice(0, 400), { retry: false });
  return json;
}

/**
 * Belge keser. @returns {Promise<{ series: string, number: string, link: string | null }>}
 */
export async function fgoEmit(settings, form, fetchImpl = fetch) {
  const json = await post(settings, '/factura/emitere', form, fetchImpl);
  const fac = json.Factura ?? {};
  if (!fac.Numar) throw new FgoError('FGO belge numarası dönmedi', { retry: false });
  const link = typeof fac.Link === 'string' && /^https:\/\//i.test(fac.Link) ? fac.Link.slice(0, 500) : null;
  return { series: String(fac.Serie ?? form.Serie), number: String(fac.Numar), link };
}

/**
 * Bağlantı denemesi: var olmayan bir belgenin durumunu sorar. Kimlik doğruysa FGO "bulunamadı" der,
 * yanlışsa kimlik hatası döner. Ayrıca belge türleri listelenir (proforma türünün adı için).
 * @returns {Promise<{ ok: boolean, message: string, types: string[] }>}
 */
export async function fgoTest(settings, key, fetchImpl = fetch) {
  let types = [];
  try {
    const r = await fetchImpl(`${FGO_URLS[settings.env] ?? FGO_URLS.test}/nomenclator/tipfactura`, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j?.List) ? j.List : Array.isArray(j) ? j : [];
    types = list.map((x) => String(x?.Valoare ?? x?.Value ?? x?.Nume ?? x?.Text ?? x)).filter(Boolean).slice(0, 20);
  } catch {
    // tür listesi alınamazsa yalnızca kimlik denenir
  }
  const number = '0';
  try {
    await post(settings, '/factura/getstatus', {
      CodUnic: settings.cui, Hash: fgoHash(settings.cui, key, number), Serie: settings.invoiceSeries, Numar: number, PlatformaUrl: '',
    }, fetchImpl);
    return { ok: true, message: 'OK', types };
  } catch (e) {
    const msg = String(e?.message ?? e);
    // "factura nu exista" gibi yanıtlar kimliğin kabul edildiğini gösterir
    const authFailed = /hash|cheie|autentific|unauthor|invalid/i.test(msg) && !/nu exist|not found|inexistent/i.test(msg);
    return { ok: !authFailed && !(e instanceof FgoError && e.retry), message: msg.slice(0, 300), types };
  }
}
