// Tedarikçi siparişi mal kabulü — saf kurallar (3.87.0, karar 282). Veritabanı tarafı server/suppliers/receipt.js.
//
// Bir siparişin satırı için: sipariş edilen = son KESİN revizyondaki adet; önceki teslim alınan = o satıra yazılmış bütün
// kabullerin toplamı; kalan = sipariş edilen − teslim alınan (hiç eksiye düşmez). Yeni kabul her satırda en çok kalan kadar
// olabilir; toplamı sipariş edileni asla geçemez.
//
// Birim: stok ürünün SATIŞ biriminde (ProfileProduct.unitCode) tutulur. Sipariş satırının birimi stok birimiyle aynı değilse o
// satır mal kabulüne alınmaz (UNIT_MISMATCH) — sistemde birimler arasında tanımlı / doğrulanmış bir dönüşüm yoktur, tahmini
// dönüşüm yapılmaz (paket içeriği bir birim dönüşümü değildir: kutudaki conta metresi, barın boyu).

/** Mal kabulü yapılabilen sipariş durumları (açık siparişler — taslak, iptal, teslim alındı değil) */
export const RECEIVABLE_STATUSES = Object.freeze(['GONDERIM_BEKLIYOR', 'GONDERILDI', 'GONDERIM_HATASI']);
export const RECEIPT_LIMITS = Object.freeze({ reference: 100, note: 500, pastDays: 366, qty: 1_000_000 });
/** Kuyruk işi türü: kabulün depo e-postası (kabulle AYNI işlemde yazılır) */
export const RECEIPT_EMAIL = 'SUPPLIER_RECEIPT_EMAIL';

const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const one = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const multi = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** "YYYY-MM-DD" ± gün (UTC takvim günü) */
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Gerçek bir takvim günü mü */
function realDay(s) {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Satır birimi stok birimiyle uyumlu mu (tek kural: aynı birim; dönüşüm yok)
 * @param {{ unitCode: string }} line  @param {{ unitCode: string }} product
 */
export const unitCompatible = (line, product) => !!line && !!product && line.unitCode === product.unitCode;

/**
 * Profil uzunluğu (m): yalnızca BAR birimli ve paket içeriği metre olan üründe — barın boyu (Profil Kataloğu'ndaki değer).
 * Başka ürünlerde (kutu, poşet, adet) uzunluk yoktur; değer tahmin edilmez.
 * @param {{ unitCode: string, packMeasure?: string | null, packContent?: unknown }} product
 * @returns {string | null}  "6.000" gibi ondalık metin
 */
export function profileLength(product) {
  if (!product || product.unitCode !== 'BARA' || product.packMeasure !== 'M' || product.packContent == null) return null;
  const s = String(product.packContent);
  return /^\d{1,9}(\.\d{1,3})?$/.test(s) && Number(s) > 0 ? s : null;
}

/**
 * Satır bakiyeleri (saf): sipariş edilen, teslim alınan, kalan
 * @param {{ id: string, qty: number }[]} lines  son kesin revizyonun satırları
 * @param {Map<string, number>} received  satır id → teslim alınan toplam
 * @returns {Map<string, { ordered: number, received: number, remaining: number }>}
 */
export function receiptBalance(lines, received) {
  const out = new Map();
  for (const l of lines) {
    const got = Math.max(0, Number(received.get(l.id) ?? 0));
    out.set(l.id, { ordered: l.qty, received: got, remaining: Math.max(0, l.qty - got) });
  }
  return out;
}

/** Bütün satırlar tamamen teslim alındı mı */
export const fullyReceived = (balance) => balance.size > 0 && [...balance.values()].every((b) => b.remaining === 0);

/**
 * Formdan gelen alanlar (saf; bakiye denetimi servistedir). quantities: satır id → yazılan adet (boş = 0).
 * @param {{ receivedOn?: unknown, reference?: unknown, note?: unknown, requestKey?: unknown, quantities?: Record<string, unknown> }} v
 * @param {{ today: string }} o  bugün (uygulama saat diliminde, YYYY-MM-DD)
 * @returns {{ ok: true, receivedOn: string, reference: string | null, note: string | null, requestKey: string, quantities: Map<string, number> }
 *   | { ok: false, code: 'KEY' | 'DATE' | 'DATE_FUTURE' | 'DATE_OLD' | 'REFERENCE' | 'NOTE' | 'QTY' | 'EMPTY', line?: string }}
 */
export function parseReceipt(v, { today }) {
  const requestKey = String(v.requestKey ?? '').trim();
  if (!KEY_RE.test(requestKey)) return { ok: false, code: 'KEY' };
  const receivedOn = String(v.receivedOn ?? '').trim();
  if (!realDay(receivedOn)) return { ok: false, code: 'DATE' };
  if (receivedOn > today) return { ok: false, code: 'DATE_FUTURE' };
  if (receivedOn < addDays(today, -RECEIPT_LIMITS.pastDays)) return { ok: false, code: 'DATE_OLD' };
  const reference = one(v.reference);
  if (reference.length > RECEIPT_LIMITS.reference) return { ok: false, code: 'REFERENCE' };
  const note = multi(v.note);
  if (note.length > RECEIPT_LIMITS.note) return { ok: false, code: 'NOTE' };
  const quantities = new Map();
  for (const [id, raw] of Object.entries(v.quantities ?? {})) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (!/^\d{1,7}$/.test(s) || Number(s) > RECEIPT_LIMITS.qty) return { ok: false, code: 'QTY', line: id };
    const n = Number(s);
    if (n > 0) quantities.set(String(id), n);
  }
  if (!quantities.size) return { ok: false, code: 'EMPTY' };
  return { ok: true, receivedOn, reference: reference || null, note: note || null, requestKey, quantities };
}

/**
 * Kabulün özeti (belge ve e-posta): satır sayısı ve birim başına toplam (farklı birimler toplanmaz)
 * @param {{ qty: number, unitCode: string }[]} lines
 * @returns {{ lines: number, byUnit: { unitCode: string, qty: number }[] }}
 */
export function receiptSummary(lines) {
  const byUnit = [];
  for (const l of lines) {
    const e = byUnit.find((x) => x.unitCode === l.unitCode);
    if (e) e.qty += l.qty;
    else byUnit.push({ unitCode: l.unitCode, qty: l.qty });
  }
  return { lines: lines.length, byUnit };
}

/**
 * Depo e-postasında bir alıcıya gönderim hatası "ileti kesinlikle gitmedi" mi: sunucuya bağlanılamadı (CONN) ya da sunucu
 * iletiyi açık bir SMTP koduyla REDDETTİ (responseCode). Bunlar o alıcı için güvenle yeniden denenir. Kodsuz kopma (ileti
 * gönderilirken bağlantı düştü) belirsizdir → o alıcıya otomatik yeniden GÖNDERİLMEZ (mükerrer bildirim olmasın).
 * @param {any} err
 */
export function receiptMailNotSent(err) {
  return !!err && (err.command === 'CONN' || Number.isInteger(err.responseCode));
}

// =====================================================================================================================
// Hatalı mal kabulünün düzeltmesi (3.91.0, karar 286) — saf kurallar. Veritabanı tarafı receipt.js → correctReceipt.
//
// Orijinal kabul ve satırları değişmez; düzeltme ayrı kayıttır ve stoğa ters (−) hareket yazar. Bir kabul satırı için:
//   düzeltilebilir = kabul edilen adet − o satırın önceki düzeltmeleri (hiç eksiye düşmez).
// Siparişin satırı için net teslim alınan = kabullerin toplamı − düzeltmelerin toplamı; kalan bundan yeniden hesaplanır.
// =====================================================================================================================

export const CORRECTION_LIMITS = Object.freeze({ reason: 1000, qty: 1_000_000 });
/** Kuyruk işi türü: düzeltmenin depo e-postası da mal kabulü e-postası işiyle AYNI türdedir (yükte correctionId) */
export const CORRECTION_EMAIL_KEY = 'correctionId';

/**
 * Kabul satırlarının düzeltilebilir miktarı (saf)
 * @param {{ id: string, qty: number }[]} receiptLines  @param {Map<string, number>} corrected  kabul satırı id → önceki düzeltmeler
 * @returns {Map<string, { accepted: number, corrected: number, correctable: number }>}
 */
export function correctionBalance(receiptLines, corrected) {
  const out = new Map();
  for (const l of receiptLines) {
    const c = Math.max(0, Number(corrected.get(l.id) ?? 0));
    out.set(l.id, { accepted: l.qty, corrected: c, correctable: Math.max(0, l.qty - c) });
  }
  return out;
}

/**
 * Düzeltme formu (saf; bakiye ve stok denetimi servistedir). quantities: kabul satırı id → düzeltilecek (stoktan düşülecek)
 * adet (boş = 0). Gerekçe zorunlu.
 * @param {{ requestKey?: unknown, reason?: unknown, expectedVersion?: unknown, quantities?: Record<string, unknown> }} v
 * @returns {{ ok: true, requestKey: string, reason: string, expectedVersion: number, quantities: Map<string, number> }
 *   | { ok: false, code: 'KEY' | 'REASON' | 'REASON_LONG' | 'VERSION' | 'QTY' | 'EMPTY', line?: string }}
 */
export function parseCorrection(v) {
  const requestKey = String(v.requestKey ?? '').trim();
  if (!KEY_RE.test(requestKey)) return { ok: false, code: 'KEY' };
  const reason = multi(v.reason);
  if (!reason) return { ok: false, code: 'REASON' };
  if (reason.length > CORRECTION_LIMITS.reason) return { ok: false, code: 'REASON_LONG' };
  const vs = String(v.expectedVersion ?? '').trim();
  if (!/^\d{1,9}$/.test(vs)) return { ok: false, code: 'VERSION' };
  const quantities = new Map();
  for (const [id, raw] of Object.entries(v.quantities ?? {})) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (!/^\d{1,7}$/.test(s) || Number(s) > CORRECTION_LIMITS.qty) return { ok: false, code: 'QTY', line: String(id) };
    const n = Number(s);
    if (n > 0) quantities.set(String(id), n);
  }
  if (!quantities.size) return { ok: false, code: 'EMPTY' };
  return { ok: true, requestKey, reason, expectedVersion: Number(vs), quantities };
}

/**
 * Düzeltmeden sonra sipariş yeniden açılır mı (saf). Yalnızca mal kabulüyle OTOMATİK kapanmış sipariş (son kabul siparişi
 * tamamladı ve kapanış zamanı o kabulün zamanı) ve artık kalan miktar varsa açılır; elle kapatılmış ("Kalanı beklemeden
 * kapat") ya da iptal edilmiş sipariş açılmaz — o kapatma yöneticinin kararıdır.
 * Açılınca dönülecek durum siparişin kendi gönderim kaydından okunur: e-posta gönderildiyse (sentAt) GONDERILDI, aksi hâlde
 * GONDERIM_HATASI (kapanırken kuyruktaki iş "teslim alındı" diye bırakılmıştır; bekleyen bir gönderim yoktur — yönetici
 * isterse "Tekrar gönder" ile gönderir, kendiliğinden e-posta gitmez).
 * @param {{ status: string, receivedAt?: Date | string | null, sentAt?: Date | string | null, sendError?: string | null }} order
 * @param {{ complete: boolean, createdAt: Date | string }[]} receipts
 * @param {boolean} stillComplete  düzeltmeden sonra bütün satırlar teslim alınmış mı
 * @returns {null | string}  yeni durum ya da null (değişmez)
 */
export function reopenStatus(order, receipts, stillComplete) {
  if (stillComplete || order?.status !== 'TESLIM_ALINDI' || !order.receivedAt) return null;
  const closedAt = new Date(order.receivedAt).getTime();
  const auto = (receipts ?? []).some((r) => r.complete && new Date(r.createdAt).getTime() === closedAt);
  if (!auto) return null;
  return order.sentAt ? 'GONDERILDI' : 'GONDERIM_HATASI';
}

/**
 * Net teslim alınan (saf): kabul toplamları − düzeltme toplamları, satır başına (hiç eksiye düşmez)
 * @param {{ orderLineId: string, _sum: { qty: number | null } }[]} rows  @param {{ orderLineId: string, _sum: { qty: number | null } }[]} fixes
 * @returns {Map<string, number>}
 */
export function netReceived(rows, fixes) {
  const out = new Map(rows.map((r) => [r.orderLineId, r._sum.qty ?? 0]));
  for (const f of fixes) out.set(f.orderLineId, Math.max(0, (out.get(f.orderLineId) ?? 0) - (f._sum.qty ?? 0)));
  return out;
}
