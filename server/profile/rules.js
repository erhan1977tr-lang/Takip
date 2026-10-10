// Profil siparişi iş kuralları (Aşama 6) — Next.js'ten bağımsız, birim testli.
//
//   FIYAT_BEKLIYOR ──yönetici fiyatlar, "Müşteriye gönder"──▶ TEKLIF_GONDERILDI
//   ──müşteri "Onayla" (alış tarihi, telefon, plaka)──▶ ONAYLANDI ──"Proforma kesildi"──▶ PROFORMA
//   ──"Ödeme alındı" (hemen depoya gider) ya da ödemeden önce "Siparişi depoya gönder"──▶ DEPODA
//   ──depo bağlantısı / yönetici "Teslim edildi"──▶ TESLIM_EDILDI ──"Faturalandı"──▶ FATURALANDI (arşiv)
// FGO açıksa (Aşama 6b) proforma onayda, fatura teslimde kendiliğinden kesilir (server/profile/fgo-jobs.js); elle
// düğmeler yedek olarak kalır, "FGO'da yeniden dene" (retry_fgo) kuyruğa yeniden ekler.
// Satış ve çizim hiçbir adımda yoktur. İptal yalnızca yöneticide. Müşteri onaylamazsa teklif olarak kalır.
// Teklif onaydan önce yönetici tarafından güncellenebilir (yeni sürüm; müşteri son sürümü onaylar).
import { can } from '../auth/permissions.js';

export const PROFILE_TYPE = 'PROFILE_ORDER';

/** Adımlar sırasıyla (adım çubuğu: status.profileStage.<adım>) */
export const PROFILE_STAGES = ['FIYAT_BEKLIYOR', 'TEKLIF_GONDERILDI', 'ONAYLANDI', 'PROFORMA', 'DEPODA', 'TESLIM_EDILDI', 'FATURALANDI'];

/** Rozet renkleri */
export const PROFILE_STAGE_TONE = {
  FIYAT_BEKLIYOR: 'warn',
  TEKLIF_GONDERILDI: 'info',
  ONAYLANDI: 'purple',
  PROFORMA: 'purple',
  DEPODA: 'info',
  TESLIM_EDILDI: 'ok',
  FATURALANDI: 'muted',
};

/** Adımın genel sipariş durumu (listeler, arşiv): fiyat bekliyor → YENI, faturalandı → ARSIVLENDI, arası HAZIRLANIYOR */
export function orderStatusFor(stage) {
  if (stage === 'FIYAT_BEKLIYOR') return 'YENI';
  if (stage === 'FATURALANDI') return 'ARSIVLENDI';
  return 'HAZIRLANIYOR';
}

/** Teslim bilgilerini müşteri (ve yönetici) bu adımlarda değiştirebilir; depoya gidince müşteriye kilitlenir (yönetici DEPODA'da da değiştirir — karar 194). */
export const PICKUP_EDITABLE = ['ONAYLANDI', 'PROFORMA'];
/** Depoya gitmeden önceki adımlar: "Ödeme alındı" siparişi hemen depoya gönderir, "Siparişi depoya gönder" ödemesiz gönderir */
export const BEFORE_WAREHOUSE = ['ONAYLANDI', 'PROFORMA'];
const CLOSED = ['ARSIVLENDI', 'IPTAL'];

/**
 * @param {{ role: string, stage: string, status: string, canApprove?: boolean, paid?: boolean }} p
 *   paid: ödeme girilmiş (depoya elle gönderilmiş siparişte ödeme sonradan girilir)
 * @returns {string[]}
 */
export function profileActions({ role, stage, status, canApprove = false, paid = false }) {
  if (CLOSED.includes(status)) return [];
  const a = [];
  if (can(role, 'OFFER_SEND')) {
    const byStage = {
      FIYAT_BEKLIYOR: ['save_profile_prices', 'send_profile_offer'],
      TEKLIF_GONDERILDI: ['update_profile_offer'],
      ONAYLANDI: ['mark_proforma', 'retry_fgo', 'mark_paid', 'send_to_warehouse'],
      PROFORMA: ['mark_paid', 'send_to_warehouse'],
      DEPODA: ['mark_delivered', 'resend_warehouse'],
      TESLIM_EDILDI: ['mark_invoiced', 'retry_fgo'],
    };
    a.push(...(byStage[stage] ?? []));
    if (!paid && ['DEPODA', 'TESLIM_EDILDI'].includes(stage)) a.push('mark_paid');
    // Yönetici teslim (alış) gününü depoda iken de değiştirebilir (karar 194; müşteriye bildirilir) — müşteri değiştiremez
    if (PICKUP_EDITABLE.includes(stage) || stage === 'DEPODA') a.push('update_pickup');
  }
  if (can(role, 'OFFER_APPROVE')) {
    if (stage === 'TEKLIF_GONDERILDI' && canApprove) a.push('approve_profile_offer');
    if (PICKUP_EDITABLE.includes(stage)) a.push('update_pickup');
  }
  if (can(role, 'ORDER_CANCEL')) a.push('cancel');
  // Profil siparişine müşteri dosya yüklemez (karar 161 — ürün ve adet formdadır); iç ekibin iç dosyası değişmedi.
  // Aynı kural cam kuralları üzerinden de uygulanır (server/orders/rules.js → availableActions, orderType).
  if (can(role, 'FILE_UPLOAD') && !can(role, 'DRAWING_APPROVE')) a.push('add_file');
  return a;
}

/**
 * Müşterinin gördüğü tek satırlık durum (metni: status.profileCustomer.<key>.label / .next).
 * @returns {{ key: string, tone: string }}
 */
export function profileCustomerSummary({ status, stage }) {
  if (status === 'IPTAL') return { key: 'cancelled', tone: 'muted' };
  return { key: stage ?? 'FIYAT_BEKLIYOR', tone: PROFILE_STAGE_TONE[stage] ?? 'muted' };
}

// ---------- adetler ----------
export const MAX_PROFILE_QTY = 100_000;
export const MAX_PROFILE_LINES = 300;

/**
 * Formdaki adetleri okur: yalnızca adedi > 0 olan satırlar siparişe girer.
 * @param {{ id: string, qty: unknown }[]} rows
 * @returns {{ ok: true, lines: { productId: string, qty: number }[] } | { ok: false, code: 'BAD_QTY' | 'TOO_MANY_LINES', productId?: string }}
 */
export function readQuantities(rows) {
  const lines = [];
  const seen = new Set();
  for (const r of rows) {
    const id = String(r.id ?? '').trim();
    const raw = String(r.qty ?? '').trim();
    if (!id || raw === '' || raw === '0') continue;
    if (!/^\d+$/.test(raw)) return { ok: false, code: 'BAD_QTY', productId: id };
    const qty = Number(raw);
    if (qty === 0) continue;
    if (qty > MAX_PROFILE_QTY) return { ok: false, code: 'BAD_QTY', productId: id };
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push({ productId: id, qty });
  }
  if (lines.length > MAX_PROFILE_LINES) return { ok: false, code: 'TOO_MANY_LINES' };
  return { ok: true, lines };
}

/**
 * Siparişe girecek kalemler: ürünün o anki kopyası (katalog sonradan değişse de sipariş değişmez).
 * Pasif ya da bulunamayan ürün seçilmişse PRODUCT_GONE.
 * @param {{ productId: string, qty: number }[]} lines
 * @param {{ id: string, code: string, nameRo: string, nameTr: string, unitCode: string, imageId?: string | null, isActive: boolean, sortOrder: number, category: { code: string, sortOrder: number, isActive?: boolean } }[]} products
 * @returns {{ ok: true, items: { productId: string, code: string, nameRo: string, nameTr: string, unitCode: string, categoryCode: string, imageId: string | null, qty: number, sortOrder: number }[] } | { ok: false, code: 'NO_ITEMS' | 'PRODUCT_GONE' }}
 */
export function profileOrderItems(lines, products) {
  if (lines.length === 0) return { ok: false, code: 'NO_ITEMS' };
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = [];
  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p || !p.isActive || p.category?.isActive === false) return { ok: false, code: 'PRODUCT_GONE' };
    items.push({ p, qty: l.qty });
  }
  // Katalog sırası: kategori, sonra ürün
  items.sort((x, y) => x.p.category.sortOrder - y.p.category.sortOrder || x.p.sortOrder - y.p.sortOrder);
  return {
    ok: true,
    items: items.map(({ p, qty }, i) => ({
      productId: p.id, code: p.code, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode,
      categoryCode: p.category.code, imageId: p.imageId ?? null, qty, sortOrder: i,
    })),
  };
}

// ---------- fiyat ----------
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "12,5" / 12.5 → 12.5; boş → null; geçersiz → NaN */
export function parsePrice(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return NaN;
  const n = Number(s);
  return n > 1_000_000 ? NaN : round2(n);
}

/** Satır tutarı = adet × fiyat; toplam. Fiyatı boş satır toplamda 0 sayılır. */
export function profileTotals(lines) {
  let amount = 0;
  for (const l of lines) amount = round2(amount + round2(Number(l.adet ?? l.qty ?? 0) * Number(l.offerPrice ?? 0)));
  return { amount };
}

/** Müşteriye gidecek teklifte fiyatı eksik satırlar (sıra numaraları, 1 tabanlı) */
export function missingPrices(lines) {
  return lines.flatMap((l, i) => (l.offerPrice == null || l.offerPrice === '' || !(Number(l.offerPrice) >= 0) ? [i + 1] : []));
}

// ---------- telefon / plaka ----------
/** Telefon: rakam, boşluk, +, -, (, ) · 6–20 rakam */
export function cleanPhone(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  const digits = s.replace(/\D/g, '');
  if (!/^[+\d\s()\-./]+$/.test(s) || digits.length < 6 || digits.length > 20) return null;
  return s.slice(0, 40);
}
/** Plaka: harf/rakam/boşluk/tire, en fazla 20; büyük harfe çevrilir. Birden çok araç virgülle yazılabilir. */
export function cleanPlate(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('ro-RO');
  if (!s || s.length > 60 || !/^[A-Z0-9ĂÂÎȘȚŞŢ\s\-,/]+$/.test(s)) return null;
  return s;
}

// ---------- fiyat listesiyle doğrudan sipariş ve teslim bilgisi (Paket B — karar 229) ----------
// Müşteriye bağlı ETKİN bir profil fiyat tablosu varsa ve siparişin her ürününün fiyatı belliyse (tablo fiyatı ya da
// katalog liste fiyatı — mevcut fiyat kuralı, server/profile/pricing.js), sipariş yönetici teklifi ve müşteri onayı
// OLMADAN doğrudan ONAYLANDI adımında açılır (fiyatların kopyası gönderilmiş teklif olarak saklanır; FGO açıksa proforma
// kuyruğa girer). Fiyatı belli olmayan ürün varsa sipariş olağan akışa (yönetici fiyatlandırması) gider — fiyat uydurulmaz.
// Doğrudan siparişte yalnızca alış (teslim) günü zorunludur; telefon ve plaka boş olabilir.

/** Depoya sipariş formu (depo e-postası) gitmeden önce dolu olması gereken teslim bilgileri */
export const PICKUP_REQUIRED = ['pickupDate', 'contactPhone', 'vehiclePlate'];

/**
 * Eksik teslim bilgileri (sıra sabit). Boş liste: depoya gönderilebilir.
 * @param {{ pickupDate?: unknown, contactPhone?: string | null, vehiclePlate?: string | null } | null | undefined} profile
 * @returns {('pickupDate' | 'contactPhone' | 'vehiclePlate')[]}
 */
export function missingPickup(profile) {
  return /** @type {any} */ (PICKUP_REQUIRED.filter((k) => {
    const v = profile?.[k];
    return v == null || (typeof v === 'string' && !v.trim());
  }));
}

/**
 * Müşteri teslim bilgisini alış gününden BİR GÜN ÖNCESİNE kadar (o gün dahil) değiştirebilir; alış günü ve sonrası kapalı.
 * Günler Romanya deposunun yerel günüdür (sunucu saati; tarayıcı saati kullanılmaz). Alış günü yoksa açıktır.
 * @param {{ pickupDay: string | null, today: string }} p  "YYYY-MM-DD"
 */
export function customerPickupOpen({ pickupDay, today }) {
  return !pickupDay || today < pickupDay;
}

/**
 * Alış gününe göre müşterinin son değişiklik günü ("YYYY-MM-DD"): alış gününden bir önceki gün.
 * @param {string} pickupDay
 */
export function pickupEditDeadline(pickupDay) {
  const d = new Date(`${pickupDay}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * İsteğe bağlı telefon / plaka: boş → null (izinli), dolu ama geçersiz → undefined (hata).
 * @param {unknown} v  @param {(v: unknown) => string | null} clean
 * @returns {string | null | undefined}
 */
export function optionalField(v, clean) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return clean(s) ?? undefined;
}
