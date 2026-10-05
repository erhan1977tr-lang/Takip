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

export const FGO_KEY = 'fgo';
export const FGO_URLS = { prod: 'https://api.fgo.ro/v1', test: 'https://api-testuat.fgo.ro/v1' };
export const FGO_DEFAULTS = {
  enabled: false, env: 'test', cui: '', proformaSeries: 'PRF', invoiceSeries: 'GKH',
  proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21,
  // Günde en fazla kaç FGO belgesi kesilir (deneme güvenliği; 0 = sınırsız)
  dailyLimit: 3,
  // Fatura numarası (karar 87): numarayı FGO verir (Numar gönderilmez). Bu alan yalnızca yöneticinin isteğe bağlı,
  // TEK SEFERLİK elle numarasıdır: doluysa sıradaki fatura TAM bu numarayla istenir, fatura kesilince alan boşalır.
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

// ---------- Ölçü birimi (Continut[UM]) ----------
// FGO en çok 5 karakter kabul eder ("Dimensiunea valorii transmise pentru 'Continut[UM]' nu trebuie sa depaseasca 5
// caractere"). TEK kaynak: proforma, avans faturası ve fatura (cam ve profil) birimi buradan alır; metin kırpılmaz.
export const FGO_UM_MAX = 5;
export const FGO_UM = Object.freeze({
  // teklif satırı birimi (OfferLine.unit): cam m², adetle fiyatlanan satır (CNC, delik, sandık, avans, storno)
  m2: 'mp',
  adet: 'buc',
  // profil kataloğu birimi (ProfileProduct.unitCode — prisma/seed/data/units.js)
  CUTII: 'cutii',
  PUNGI: 'pungi',
  BARA: 'bară',
  BUCATI: 'buc', // "bucăți" 6 karakter: FGO reddeder
});
/** Birim kodu → FGO'ya yazılacak kısaltma; tanımsız kod → null */
export const fgoUnit = (code) => {
  const k = String(code ?? '').trim();
  return FGO_UM[k] ?? FGO_UM[k.toUpperCase()] ?? null;
};
/** UM geçerli mi: boş değil, en çok 5 karakter */
export const validUm = (um) => typeof um === 'string' && um.trim() === um && um.length > 0 && [...um].length <= FGO_UM_MAX;

// ---------- Satır açıklaması (Continut[Descriere]) ----------
// FGO belgesindeki her kalemin altında kaynak TAKİP siparişi yazılır ("Comanda UMI7"). Müşteri belgesinde (birden çok
// sipariş, tek belge) her kalem KENDİ siparişini taşır. Denumire, miktar, birim, fiyat, TVA ve toplamlar değişmez.
export const FGO_DETAIL_MAX = 4000;
/**
 * Kalemin açıklaması: var olan açıklama korunur, sipariş numarası sonuna (ayrı satırda) eklenir; zaten yazılıysa
 * ikinci kez eklenmez. Sipariş bilinmiyorsa yalnızca var olan açıklama döner (boş olabilir).
 * @param {string | null | undefined} orderNo  @param {string | null} [existing]
 */
export function orderDetail(orderNo, existing = '') {
  const base = String(existing ?? '').trim();
  const no = String(orderNo ?? '').trim();
  if (!no) return base;
  const ref = `Comanda ${no}`;
  if (!base) return ref;
  const has = new RegExp(`(^|[^\\p{L}\\p{N}])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}-])`, 'u').test(base);
  return has ? base : `${base}\n${ref}`;
}

/**
 * FGO "factura/emitere" gövdesi (form alanları). Satırlar: onaylanan teklifin kopyası.
 * @param {{ settings: object, key: string, kind: 'proforma' | 'invoice', orderNo: string, appUrl: string,
 *   customer: object, lines: { code: string, name: string, unit: string, qty: number, eur: number, detail?: string }[], rate: number, rateText?: string, text?: string }} p
 *   lines[].detail: satırın FGO açıklaması (Continut[Descriere] — "detalii articol"): kaynak TAKİP siparişi (orderDetail)
 *   rateText: belgenin açıklamasındaki kur cümlesi (server/fx/resolve.js → fxDocumentText); rateNote: false ise yazılmaz
 * @returns {Record<string, string>}
 */
export function emitereForm({ settings, key, kind, orderNo, appUrl, customer, lines, rate, rateText = '', text = '', extern = null, rateNote = true, number = null }) {
  const proforma = kind === 'proforma';
  const name = String(customer.name).trim();
  const cui = String(customer.taxId ?? '').replace(/\s/g, '');
  const f = {
    CodUnic: settings.cui,
    Hash: fgoHash(settings.cui, key, name),
    PlatformaUrl: appUrl,
    Serie: proforma ? settings.proformaSeries : settings.invoiceSeries,
    // Numar: yalnızca yönetici elle numara girdiyse (manualInvoiceNumber); verilmezse FGO numaralandırır
    ...(number ? { Numar: String(number) } : {}),
    Valuta: 'RON',
    TipFactura: proforma ? settings.proformaType : settings.invoiceType,
    // Aynı belge iki kez kesilmesin: sipariş + tür
    IdExtern: extern ?? `${orderNo}-${proforma ? 'P' : 'F'}`,
    VerificareDuplicat: 'true',
    // rateNote: false → açıklamada yalnızca verilen metin (cam siparişi: siparişin açıklaması)
    Text: [text, rateNote ? `${rateText ? `${rateText}. ` : ''}Comanda ${orderNo}.` : ''].filter(Boolean).join(' ').slice(0, 500),
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
    // FGO'ya gitmeden önce: birim boş olamaz, en çok 5 karakter (yeniden denenmez; yöneticiye uyarı düşer)
    if (!validUm(l.unit)) throw new FgoError(`Satır ${i + 1} (${String(l.name).slice(0, 60)}): ölçü birimi geçersiz ("${l.unit ?? ''}") — FGO boş olmayan, en çok ${FGO_UM_MAX} karakterlik birim ister`, { retry: false });
    f[`Continut[${i}][Denumire]`] = (l.code ? `${l.name} (${l.code})` : l.name).slice(0, 250);
    f[`Continut[${i}][CodArticol]`] = l.code;
    // Satır açıklaması (FGO "Descriere", en çok 4000 karakter): kaynak sipariş — "Comanda UMI7". Boşsa alan gönderilmez.
    if (l.detail) f[`Continut[${i}][Descriere]`] = String(l.detail).slice(0, FGO_DETAIL_MAX);
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
// "Belge yok" KESİN sayılmadan önce (karar 132): yanıt belgeden söz etmeli ("Factura nu exista") ve kimlik / yetki /
// sınır / biçim hatası olmamalı — "Firma nu exista", "Hash invalid", "prea multe cereri" belgenin silindiğini kanıtlamaz.
const FGO_DOC_WORD = /factur|proform|document|invoice/i;
const FGO_NOT_PROOF = /hash|cheie|autentific|autoriz|unauthor|token|acces|limit|prea multe|too many|invalid/i;
/**
 * FGO'nun kalıcı yanıt metni "bu belge FGO'da yok" mu (ör. "Factura nu exista")? Yalnızca metne bakar.
 * @param {unknown} message
 */
export const fgoAbsentMessage = (message) => {
  const m = String(message ?? '');
  return FGO_NOT_FOUND.test(m) && FGO_DOC_WORD.test(m) && !FGO_NOT_PROOF.test(m);
};
/**
 * Belgenin FGO'da OLMADIĞININ kesin kanıtı — sistemdeki kaydı kaldırmaya izin veren TEK koşul: FGO'nun kendi kalıcı
 * yanıtı (FgoError, retry değil — ağ hatası, zaman aşımı, 5xx, 429 ve okunamayan yanıt retry'dır ya da FgoError değildir)
 * ve metni "belge yok". Başka her hata belirsizdir: kayıt kaldırılmaz.
 * @param {unknown} e
 */
export const fgoDocumentAbsent = (e) => e instanceof FgoError && !e.retry && fgoAbsentMessage(e.message);
const notFound = fgoDocumentAbsent;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Yöneticinin elle girdiği fatura numarası (Entegrasyonlar → "Sonraki fatura numarası"), yoksa null.
 * Karar 87: fatura numarasını FGO verir. Sistem kendi başına numara ÜRETMEZ (son numara + 1 yok, kendiliğinden artan
 * sayaç yok); bu alan yalnızca isteğe bağlı, tek seferlik bir elle numaradır.
 * @returns {string | null}
 */
export const manualInvoiceNumber = (settings) => (Number.isInteger(settings.invoiceNext) && settings.invoiceNext > 0 ? String(settings.invoiceNext) : null);

/**
 * Fatura kesilmeden hemen önce: FGO'ya gönderilecek numara — çoğunlukla null (numarayı FGO verir).
 *   - Yönetici elle numara girdiyse TAM o numara döner. Numara sistemde kayıtlıysa FGO'ya sorulur: FGO'da silinmişse
 *     (deneme faturası) eski kayıt kaldırılır ve numara kullanılır; FGO'da varsa iş kalıcı hatayla durur — başka numara
 *     DENENMEZ (yönetici alanı düzeltir ya da boşaltır).
 *   - Elle numara yoksa null. FGO, son faturası silinmişse o numarayı yeniden verir; sistemde o numaranın eski kaydı
 *     kalmışsa yeni belge kaydedilemezdi. Bu yüzden sistemdeki en büyük numaralı fatura kaydı FGO'ya sorulur ve
 *     silinmişse kaldırılır (mevcut "FGO'da silinen belge" kuralı, karar 65). FGO'da duran hiçbir kayda dokunulmaz;
 *     bu kontrol yalnızca temizliktir — FGO'ya ulaşılamazsa fatura kesimi yine sürer.
 * @returns {Promise<string | null>}
 */
export async function reserveInvoiceNumber(db, settings, { key, appUrl = '', fetchImpl = fetch, sleep = pause }) {
  // Döngüsel içe aktarmayı önlemek için istek anında yüklenir (profil akışını kullanır)
  const { removeDeletedDocument } = await import('./fgo-deleted.js');
  const manual = manualInvoiceNumber(settings);
  if (manual) {
    const row = await db.fgoDocument.findUnique({ where: { series_number: { series: settings.invoiceSeries, number: manual } } });
    if (!row) return manual;
    try {
      await fgoStatus(settings, key, { series: row.series, number: row.number, appUrl }, fetchImpl);
    } catch (e) {
      if (!notFound(e)) throw e; // ağ hatası: iş sonra yeniden denenir, numara uydurulmaz
      await removeDeletedDocument(db, row, e.message);
      await sleep(1100); // FGO saniyede bir istek kabul eder
      return manual;
    }
    await sleep(1100);
    throw new FgoError(`Fatura numarası ${row.series}${row.number} zaten kullanılmış (FGO'da ve sistemde kayıtlı); başka numara denenmedi. Entegrasyonlar → "Sonraki fatura numarası" alanını düzeltin ya da boşaltın.`, { retry: false });
  }
  for (let i = 0; i < 10; i++) {
    const rows = await db.fgoDocument.findMany({ where: { series: settings.invoiceSeries }, select: { id: true, orderId: true, batchId: true, kind: true, series: true, number: true } });
    const last = rows.filter((r) => /^\d+$/.test(r.number)).sort((a, b) => Number(b.number) - Number(a.number))[0];
    if (!last) break;
    try {
      await fgoStatus(settings, key, { series: last.series, number: last.number, appUrl }, fetchImpl);
      await sleep(1100);
      break;
    } catch (e) {
      // Yalnızca temizlik: FGO'ya ulaşılamadıysa ya da başka bir yanıt verdiyse fatura kesimi bu yüzden durmaz
      if (!notFound(e)) break;
      await removeDeletedDocument(db, last, e.message);
      await sleep(1100);
    }
  }
  return null;
}

/**
 * Fatura kesildikten sonra. Elle numara gönderildiyse alan boşaltılır (tek seferlik; sonraki faturaları yine FGO
 * numaralandırır) ve FGO başka numara kestiyse yöneticiye uyarı düşer. Numara gönderilmediyse yapılacak iş yok:
 * kaydedilen numara her zaman FGO'nun döndürdüğü numaradır.
 */
export async function afterInvoiceIssued(db, { sent, issued, orderId }) {
  if (!sent) return;
  if (String(sent) !== String(issued)) {
    await db.adminAlert.create({ data: { type: 'FGO_NUMBER', orderId, details: { code: 'NUMBER', error: `${sent} → ${issued}` } } });
  }
  const row = await db.integrationSetting.findUnique({ where: { key: FGO_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : null;
  // Yönetici bu arada başka bir numara girdiyse ona dokunulmaz
  if (!v || String(v.invoiceNext ?? '') !== String(sent)) return;
  await db.integrationSetting.update({ where: { key: FGO_KEY }, data: { value: { ...v, invoiceNext: null } } });
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
 * Belgenin PDF bağlantısı (factura/print): yalnızca OKUR, belge kesmez / değiştirmez. Kayıtlı bağlantı yoksa ya da artık
 * açılmıyorsa sunucu tarafında çağrılır (server/documents/delivery.js). Hash = SHA1(CUI + anahtar + belge no).
 * @returns {Promise<string | null>}
 */
export async function fgoPrint(settings, key, { series, number, appUrl = '' }, fetchImpl = fetch) {
  const json = await post(settings, '/factura/print', {
    CodUnic: settings.cui, Hash: fgoHash(settings.cui, key, number), Serie: series, Numar: number, PlatformaUrl: appUrl,
  }, fetchImpl);
  const link = json.Factura?.Link ?? json.Link;
  return typeof link === 'string' && /^https:\/\//i.test(link) ? link.slice(0, 500) : null;
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
