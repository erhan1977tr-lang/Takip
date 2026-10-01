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
import { DEFAULT_FX_URL, LEGACY_FX_URLS } from '../fx/bt.js';

export const FGO_KEY = 'fgo';
export const FGO_URLS = { prod: 'https://api.fgo.ro/v1', test: 'https://api-testuat.fgo.ro/v1' };
export const FGO_DEFAULTS = {
  enabled: false, env: 'test', cui: '', proformaSeries: 'PRF', invoiceSeries: 'GKH',
  proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: DEFAULT_FX_URL,
  // Kur kaynağı: 'manual' = yöneticinin girdiği günün kuru (varsayılan; BT'nin dosyası "În unități BT" kuruyla aynı değil),
  // 'auto' = fxUrl'den otomatik
  fxMode: 'manual',
  // Günde en fazla kaç FGO belgesi kesilir (deneme güvenliği; 0 = sınırsız)
  dailyLimit: 3,
  // Sıradaki fatura numarası (karar 64): doluysa TAM bu numara kullanılır ve her faturadan sonra +1 olur;
  // boşsa sistemdeki son fatura numarası + 1 (o da yoksa FGO numaralandırır).
  invoiceNext: /** @type {number | null} */ (null),
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
  if (LEGACY_FX_URLS.includes(out.fxUrl)) out.fxUrl = DEFAULT_FX_URL;
  return { ...out, hasKey: !!v.keySealed, keySealed: v.keySealed ?? null };
}

/** FGO'ya istek gönderilebilir mi (açık, CUI ve anahtar kayıtlı) */
export const fgoReady = (s) => !!(s.enabled && s.cui && s.hasKey);

const SERIES_RE = /^[A-Z0-9]{1,10}$/;
const TYPE_RE = /^[A-Za-z]{2,50}$/;
/**
 * Formdan gelen ayarları doğrular.
 * @returns {{ ok: true, value: typeof FGO_DEFAULTS } | { ok: false, errors: string[] }}
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
    fxMode: raw.fxMode === 'auto' ? 'auto' : 'manual',
    dailyLimit: raw.dailyLimit == null || String(raw.dailyLimit).trim() === '' ? 3 : Number(raw.dailyLimit),
    invoiceNext: raw.invoiceNext == null || String(raw.invoiceNext).trim() === '' ? null : Number(String(raw.invoiceNext).trim()),
  };
  if (cui && !/^\d{2,10}$/.test(cui)) errors.push('CUI');
  if (!SERIES_RE.test(value.proformaSeries)) errors.push('PROFORMA_SERIES');
  if (!SERIES_RE.test(value.invoiceSeries)) errors.push('INVOICE_SERIES');
  if (!TYPE_RE.test(value.proformaType)) errors.push('PROFORMA_TYPE');
  if (!TYPE_RE.test(value.invoiceType)) errors.push('INVOICE_TYPE');
  if (!(value.vatRate >= 0 && value.vatRate <= 50)) errors.push('VAT');
  if (value.invoiceNext !== null && !(Number.isInteger(value.invoiceNext) && value.invoiceNext >= 1 && value.invoiceNext <= 99_999_999)) errors.push('INVOICE_NEXT');
  if (!Number.isInteger(value.dailyLimit) || value.dailyLimit < 0 || value.dailyLimit > 1000) errors.push('DAILY_LIMIT');
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
export function emitereForm({ settings, key, kind, orderNo, appUrl, customer, lines, rate, rateDate, text = '', extern = null, rateNote = true, number = null }) {
  const proforma = kind === 'proforma';
  const name = String(customer.name).trim();
  const cui = String(customer.taxId ?? '').replace(/\s/g, '');
  const f = {
    CodUnic: settings.cui,
    Hash: fgoHash(settings.cui, key, name),
    PlatformaUrl: appUrl,
    Serie: proforma ? settings.proformaSeries : settings.invoiceSeries,
    // Numar: faturada sistemdeki son numara + 1 (nextInvoiceNumber); verilmezse FGO numaralandırır
    ...(number ? { Numar: String(number) } : {}),
    Valuta: 'RON',
    TipFactura: proforma ? settings.proformaType : settings.invoiceType,
    // Aynı belge iki kez kesilmesin: sipariş + tür
    IdExtern: extern ?? `${orderNo}-${proforma ? 'P' : 'F'}`,
    VerificareDuplicat: 'true',
    // rateNote: false → açıklamada yalnızca verilen metin (cam siparişi: siparişin açıklaması)
    Text: [text, rateNote ? `Curs BT vânzare EUR ${rate.toFixed(4)} RON din ${rateDate}. Comanda ${orderNo}.` : ''].filter(Boolean).join(' ').slice(0, 500),
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
    // Client[IdExtern] gönderilmez: FGO burada pozitif tam sayı ister, bizim kimliklerimiz metin (cuid)
  };
  lines.forEach((l, i) => {
    // l.ron: RON birim fiyat doğrudan (ör. avans satırı); yoksa EUR × kur
    const unit = l.ron != null ? l.ron : ronPrice(l.eur, rate);
    f[`Continut[${i}][Denumire]`] = (l.code ? `${l.name} (${l.code})` : l.name).slice(0, 250);
    f[`Continut[${i}][CodArticol]`] = l.code;
    f[`Continut[${i}][NrProduse]`] = String(l.qty);
    f[`Continut[${i}][UM]`] = l.unit;
    f[`Continut[${i}][CotaTVA]`] = String(settings.vatRate);
    // l.gross: satırın TVA dahil toplamı verilir, FGO geriye hesaplar (PretTotal). Cam faturasında birleştirilen satırın
    // toplamı proformadaki satırların toplamına kuruşu kuruşuna eşit olsun diye (karar 63).
    if (l.gross != null) f[`Continut[${i}][PretTotal]`] = l.gross.toFixed(2);
    else f[`Continut[${i}][PretUnitar]`] = unit.toFixed(2);
  });
  return f;
}

/** RON tutar (TVA hariç): Σ adet × RON birim fiyat */
export const ronTotal = (lines, rate) => round2(lines.reduce((s, l) => s + (l.net != null ? l.net : round2(l.qty * (l.ron != null ? l.ron : ronPrice(l.eur, rate)))), 0));

/** TVA hariç satır tutarı → TVA dahil (FGO gibi: satır başına TVA, 2 hane) */
export const grossOf = (net, vatRate) => round2(net + round2((net * Number(vatRate)) / 100));

/** FGO'nun "belge yok" yanıtı (getstatus): belge FGO'da silinmiş */
export const FGO_NOT_FOUND = /nu exist|nu a fost g[aă]sit|negăsit|not found|inexist/i;
const maxNumber = (rows) => rows.reduce((m, r) => (/^\d+$/.test(r.number) ? Math.max(m, Number(r.number)) : m), 0);

/**
 * Sıradaki fatura numarası (ürün sahibinin kuralı, karar 62 / 64): yönetici Entegrasyonlar'da "Sonraki fatura numarası"nı
 * girdiyse TAM o numara (her faturadan sonra kendiliğinden +1 olur); boşsa sistemdeki (FgoDocument) bu serinin en büyük
 * numarası + 1. Hiçbiri yoksa null (FGO numaralandırır). Ön izleme içindir; keserken reserveInvoiceNumber kullanılır.
 * @returns {Promise<string | null>}
 */
export async function nextInvoiceNumber(db, settings) {
  if (Number.isInteger(settings.invoiceNext) && settings.invoiceNext > 0) return String(settings.invoiceNext);
  const max = maxNumber(await db.fgoDocument.findMany({ where: { series: settings.invoiceSeries }, select: { number: true } }));
  return max ? String(max + 1) : null;
}

/**
 * Keserken numara: nextInvoiceNumber; bu numara sistemde kayıtlıysa FGO'ya sorulur — FGO'da silinmişse (deneme
 * faturaları) eski kayıt sistemden kaldırılır ve numara yeniden kullanılır; FGO'da varsa sonraki numaraya geçilir.
 * @returns {Promise<string | null>}
 */
export async function reserveInvoiceNumber(db, settings, { key, appUrl = '', fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const first = await nextInvoiceNumber(db, settings);
  if (!first) return null;
  let n = Number(first);
  for (let i = 0; i < 50; i++, n++) {
    const row = await db.fgoDocument.findUnique({ where: { series_number: { series: settings.invoiceSeries, number: String(n) } } });
    if (!row) return String(n);
    try {
      await fgoStatus(settings, key, { series: row.series, number: row.number, appUrl }, fetchImpl);
    } catch (e) {
      if (e instanceof FgoError && !e.retry && FGO_NOT_FOUND.test(e.message)) {
        await removeDeletedDocument(db, row, e.message);
        await sleep(1100); // FGO saniyede bir istek kabul eder
        return String(n);
      }
      throw e; // ağ hatası: iş sonra yeniden denenir
    }
    await sleep(1100);
  }
  throw new FgoError('Boş fatura numarası bulunamadı (50 numara dolu); Entegrasyonlar → Sonraki fatura numarası', { retry: false });
}

/** FGO'da silinmiş belgenin kaydını kaldırır (denetim kaydıyla; geçmiş satırı siparişte kalır) */
export async function removeDeletedDocument(db, row, reason = '') {
  await db.$transaction(async (tx) => {
    await tx.fgoDocument.delete({ where: { id: row.id } });
    await writeAudit(tx, {
      action: 'FGO_DOC_REMOVED', entityType: 'Order', entityId: row.orderId, userId: null,
      details: { kind: row.kind, series: row.series, number: row.number, reason: String(reason).slice(0, 200) },
    }, { role: 'SYSTEM' });
  });
}

/**
 * Fatura kesildikten sonra: "Sonraki fatura numarası" kesilen numara + 1 olur (yalnızca yönetici bu alanı kullanıyorsa;
 * boşsa sistemdeki son numara zaten bir sonrakini verir). Gönderilen numara ile FGO'nun kestiği farklıysa yöneticiye uyarı.
 */
export async function afterInvoiceIssued(db, { sent, issued, orderId }) {
  if (sent && String(sent) !== String(issued)) {
    await db.adminAlert.create({ data: { type: 'FGO_NUMBER', orderId, details: { code: 'NUMBER', error: `${sent} → ${issued}` } } });
  }
  if (!/^\d+$/.test(String(issued))) return;
  const row = await db.integrationSetting.findUnique({ where: { key: FGO_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : null;
  if (!v || !Number.isInteger(v.invoiceNext)) return;
  const next = Math.max(v.invoiceNext, Number(issued) + 1);
  if (next !== v.invoiceNext) await db.integrationSetting.update({ where: { key: FGO_KEY }, data: { value: { ...v, invoiceNext: next } } });
}

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
    const authFailed = /hash|cheie|autentific|unauthor|invalid/i.test(msg) && !FGO_NOT_FOUND.test(msg);
    return { ok: !authFailed && !(e instanceof FgoError && e.retry), message: msg.slice(0, 300), types };
  }
}

/**
 * Belgenin FGO'daki tutarı ve ödenen kısmı (factura/getstatus). Hash = SHA1(CUI + anahtar + belge no).
 * @returns {Promise<{ total: number | null, paid: number | null }>}
 */
export async function fgoStatus(settings, key, { series, number, appUrl = '' }, fetchImpl = fetch) {
  const json = await post(settings, '/factura/getstatus', {
    CodUnic: settings.cui, Hash: fgoHash(settings.cui, key, number), Serie: series, Numar: number, PlatformaUrl: appUrl,
  }, fetchImpl);
  const f = json.Factura ?? {};
  const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return { total: n(f.Valoare), paid: n(f.ValoareAchitata) };
}

/**
 * Bugün (yerel gün) kesilmiş FGO belgesi sayısı ve günlük sınır doldu mu (deneme güvenliği).
 * @param {{ dailyLimit: number }} settings
 */
export async function dailyLimitReached(db, settings, dayStart) {
  if (!settings.dailyLimit) return false;
  const n = await db.fgoDocument.count({ where: { createdAt: { gte: dayStart } } });
  return n >= settings.dailyLimit;
}
