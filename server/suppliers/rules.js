// Tedarik ve satın alma — SAF kurallar (Paket 6, kararlar 179–184). Veritabanı ve ağ yok; birim testli
// (test/suppliers.test.js). Veritabanı tarafı server/suppliers/service.js, e-posta gönderimi server/suppliers/dispatch.js.
//
// Para hesabı kayan noktasızdır: tutarlar metin ("12.5000") olarak gelir, BigInt ile tam hesaplanır, satır toplamı
// bir kez ve yarım-yukarı (half-up) 2 ondalığa yuvarlanır; sipariş toplamı yuvarlanmış satır toplamlarının toplamıdır
// (e-postadaki tablo ile toplam satırı her zaman tutar). Para birimleri birbirine HİÇBİR YERDE eklenmez.
import { CURRENCIES } from '../accounting/supplier.js';
import { UNITS } from '../../prisma/seed/data/units.js';
import { PRICE_MAX, cents, fromScaled, lineTotal, money, orderTotals, parsePrice, toScaled } from './money.js';

export { PRICE_MAX, cents, fromScaled, lineTotal, money, orderTotals, parsePrice, toScaled };

/** Tedarikçi ve alış para birimleri: muhasebedeki liste (EUR, RON, USD, TRY) */
export const SUPPLIER_CURRENCIES = CURRENCIES;
/** Sipariş birimleri: profil kataloğunun birimleri */
export const UNIT_CODES = UNITS.map((u) => u.code);

/** Metin alanı sınırları */
export const LIMITS = Object.freeze({
  name: 120, contact: 120, email: 200, phone: 40, address: 400,
  orderNo: 30, note: 2000, color: 40, description: 200, reason: 500, paymentNote: 500,
  lines: 200, qty: 100_000,
});
/**
 * Teknik ek sınırları (karar 181): bir revizyonda en çok 10 dosya, dosya başına 10 MB, toplam 20 MB — ekler e-postaya
 * eklenir; SMTP sunucularının ileti sınırı (genellikle 25 MB, base64 ile ~%33 büyür) aşılmasın.
 */
export const FILE_LIMITS = Object.freeze({ files: 10, fileBytes: 10 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });

/** Tek alıcı e-postası: virgül / noktalı virgül / açılı ayraç içermez (başka alıcı eklenemez) */
export const EMAIL_RE = /^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]+$/;

const one = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const multi = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Geçerli e-posta (kırpılmış) ya da null */
export function supplierEmail(v) {
  const s = String(v ?? '').trim();
  return s.length <= LIMITS.email && EMAIL_RE.test(s) ? s : null;
}

/**
 * Tedarikçi formu (Ayarlar → Tedarikçiler). E-posta boş bırakılabilir (gönderim o zaman engellenir — karar 179);
 * girildiyse geçerli olmalı. Hata kodları: NAME, TOO_LONG, EMAIL, CURRENCY.
 * @param {{ name?: unknown, contactName?: unknown, email?: unknown, phone?: unknown, address?: unknown, currency?: unknown, isActive?: unknown }} raw
 * @returns {{ ok: true, value: { name: string, contactName: string | null, email: string | null, phone: string | null, address: string | null, currency: string, isActive: boolean } } | { ok: false, errors: string[] }}
 */
export function parseSupplier(raw) {
  const errors = [];
  const name = one(raw.name);
  const contactName = one(raw.contactName) || null;
  const emailText = String(raw.email ?? '').trim();
  const phone = one(raw.phone) || null;
  const address = multi(raw.address) || null;
  const currency = String(raw.currency ?? '').trim().toUpperCase();
  if (!name) errors.push('NAME');
  if (name.length > LIMITS.name || (contactName?.length ?? 0) > LIMITS.contact || (phone?.length ?? 0) > LIMITS.phone || (address?.length ?? 0) > LIMITS.address) errors.push('TOO_LONG');
  const email = emailText ? supplierEmail(emailText) : null;
  if (emailText && !email) errors.push('EMAIL');
  if (!SUPPLIER_CURRENCIES.includes(currency)) errors.push('CURRENCY');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, contactName, email, phone, address, currency, isActive: raw.isActive !== false } };
}

/** Tedarikçi adı karşılaştırması (büyük / küçük harf ve Türkçe noktalı / noktasız I ayrımı yok) */
export const nameKey = (v) => one(v).normalize('NFC').toLocaleUpperCase('tr-TR').replace(/İ/g, 'I');

// ---------- ondalık (tek uygulama: server/suppliers/money.js — tarayıcıdaki düzenleyici de aynısını kullanır) ----------

/**
 * E-postada fiyat sütunları (Birim Fiyat, Toplam) ve genel toplam yalnızca HER satırın fiyatı varsa gösterilir
 * (karar 181): fiyatı olmayan bir satır varsa sütunlar boş bırakılmaz, tamamen kaldırılır.
 * @param {{ unitPrice?: unknown }[]} lines
 */
export const showPrices = (lines) => lines.length > 0 && lines.every((l) => l.unitPrice != null && l.unitPrice !== '');

/**
 * Ürünün kayıtlı alış fiyatı bu siparişe otomatik gelir mi (karar 180): ürünün tedarikçisi siparişin tedarikçisi ve
 * alış para birimi siparişin para birimi olmalı; aksi hâlde fiyat yoktur (kur çevrilmez, başka tedarikçinin fiyatı alınmaz).
 * @param {{ supplierId?: string | null, purchasePrice?: unknown, purchaseCurrency?: string | null }} product
 * @param {{ supplierId: string, currency: string }} order
 * @returns {string | null}
 */
export function catalogPrice(product, order) {
  if (product.purchasePrice == null || product.supplierId !== order.supplierId || product.purchaseCurrency !== order.currency) return null;
  const p = parsePrice(String(product.purchasePrice));
  return p.ok ? p.value : null;
}

/** Ürünün sipariş birimi (boş = satış birimi) */
export const orderUnitOf = (product) => (product.purchaseUnit && UNIT_CODES.includes(product.purchaseUnit) ? product.purchaseUnit : product.unitCode);

/**
 * Ürünün alış bilgisi (Profil Kataloğu → ürün formu; yalnızca SUPPLIER_MANAGE). Fiyat girildiyse para birimi zorunlu.
 * Hata kodları: PURCHASE_PRICE, PURCHASE_CURRENCY, PURCHASE_UNIT.
 * @returns {{ ok: true, value: { supplierId: string | null, purchasePrice: string | null, purchaseCurrency: string | null, purchaseUnit: string | null } } | { ok: false, code: string }}
 */
export function parsePurchase({ supplierId, price, currency, unit }) {
  const p = parsePrice(price);
  if (!p.ok) return { ok: false, code: 'PURCHASE_PRICE' };
  const cur = String(currency ?? '').trim().toUpperCase() || null;
  if (cur && !SUPPLIER_CURRENCIES.includes(cur)) return { ok: false, code: 'PURCHASE_CURRENCY' };
  if (p.value != null && !cur) return { ok: false, code: 'PURCHASE_CURRENCY' };
  const u = String(unit ?? '').trim().toUpperCase() || null;
  if (u && !UNIT_CODES.includes(u)) return { ok: false, code: 'PURCHASE_UNIT' };
  return { ok: true, value: { supplierId: String(supplierId ?? '').trim() || null, purchasePrice: p.value, purchaseCurrency: cur, purchaseUnit: u } };
}

// ---------- sipariş numarası ----------

/** Sipariş numarası: büyük harf, boşluk → "-", A–Z 0–9 - / . _ (en çok 30) */
export function cleanOrderNo(v) {
  const s = one(v).toUpperCase().replace(/\s+/g, '-');
  return /^[A-Z0-9][A-Z0-9\-/._]{0,29}$/.test(s) ? s : null;
}

/**
 * Önerilen numara: "TS-<yıl>-<sıra>" (sıra o yılın en büyüğü + 1, en az 3 hane). Yönetici taslakta değiştirebilir;
 * benzersizliği veritabanı sağlar (karar 181).
 * @param {string[]} existing  @param {number} year
 */
export function suggestOrderNo(existing, year) {
  const re = new RegExp(`^TS-${year}-(\\d{1,9})$`);
  let max = 0;
  for (const no of existing) {
    const m = re.exec(String(no));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `TS-${year}-${String(max + 1).padStart(3, '0')}`;
}

// ---------- satırlar ----------

/**
 * Taslak satırları (sunucu doğrular; tarayıcıya güvenilmez). Her satır: katalogdaki ürün, miktar (tam sayı 1 … 100.000),
 * renk / RAL (serbest), açıklama (boşsa ürünün Türkçe adı), sipariş birimi, birim fiyat (boş = fiyat yok).
 * Fiyatın kaynağı sunucuda belirlenir: kayıtlı alış fiyatıyla aynıysa CATALOG, değilse MANUAL.
 * Hata kodları: LINES, PRODUCT, PRODUCT_INACTIVE, QTY, PRICE, UNIT, TOO_LONG (index: satır sırası, 0'dan).
 * @param {unknown} rows
 * @param {{ products: { id: string, code: string, nameTr: string, nameRo: string, unitCode: string, isActive: boolean, category?: { isActive?: boolean } | null,
 *   supplierId?: string | null, purchasePrice?: unknown, purchaseCurrency?: string | null, purchaseUnit?: string | null }[], order: { supplierId: string, currency: string } }} ctx
 * @returns {{ ok: true, lines: { productId: string, code: string, description: string, color: string | null, qty: number, unitCode: string,
 *   unitPrice: string | null, priceSource: string | null, lineTotal: string | null, sortOrder: number }[] } | { ok: false, code: string, index?: number }}
 */
export function parseLines(rows, { products, order }) {
  if (!Array.isArray(rows) || rows.length > LIMITS.lines) return { ok: false, code: 'LINES' };
  const byId = new Map(products.map((p) => [p.id, p]));
  const out = [];
  for (const [index, r] of rows.entries()) {
    if (!r || typeof r !== 'object') return { ok: false, code: 'LINES', index };
    const row = /** @type {Record<string, unknown>} */ (r);
    const p = byId.get(String(row.productId ?? ''));
    if (!p) return { ok: false, code: 'PRODUCT', index };
    if (!p.isActive || p.category?.isActive === false) return { ok: false, code: 'PRODUCT_INACTIVE', index };
    const qtyText = String(row.qty ?? '').trim();
    if (!/^\d{1,6}$/.test(qtyText) || Number(qtyText) < 1 || Number(qtyText) > LIMITS.qty) return { ok: false, code: 'QTY', index };
    const qty = Number(qtyText);
    const color = one(row.color) || null;
    const description = one(row.description) || p.nameTr || p.nameRo;
    if ((color?.length ?? 0) > LIMITS.color || description.length > LIMITS.description) return { ok: false, code: 'TOO_LONG', index };
    const unitCode = String(row.unitCode ?? '').trim().toUpperCase() || orderUnitOf(p);
    if (!UNIT_CODES.includes(unitCode)) return { ok: false, code: 'UNIT', index };
    const price = parsePrice(row.unitPrice);
    if (!price.ok) return { ok: false, code: 'PRICE', index };
    const fromCatalog = catalogPrice(p, order);
    const priceSource = price.value == null ? null : fromCatalog != null && toScaled(fromCatalog, 4) === toScaled(price.value, 4) ? 'CATALOG' : 'MANUAL';
    out.push({
      productId: p.id, code: p.code, description, color, qty, unitCode,
      unitPrice: price.value, priceSource, lineTotal: lineTotal(qty, price.value), sortOrder: index,
    });
  }
  return { ok: true, lines: out };
}

// ---------- durum ----------

/** Borç doğuran (kesinleşmiş) durumlar — iptal hariç (karar 182) */
export const DEBT_STATUSES = ['GONDERIM_BEKLIYOR', 'GONDERILDI', 'GONDERIM_HATASI', 'TESLIM_ALINDI'];
/** Açık siparişler: beklenen tedarik ve tahmini yükleme hatırlatması bunlar için (karar 183–184) */
export const OPEN_STATUSES = ['GONDERIM_BEKLIYOR', 'GONDERILDI', 'GONDERIM_HATASI'];

/**
 * Yöneticinin bu siparişte yapabilecekleri. hasDraft: düzenlenen (kesinleşmemiş) revizyon var mı; pendingJob: son kesin
 * revizyonun e-postası kuyrukta mı.
 * @param {{ status: string, hasDraft: boolean, pendingJob?: boolean }} o
 * @returns {string[]}
 */
export function supplierOrderActions({ status, hasDraft, pendingJob = false }) {
  if (status === 'TASLAK') return ['save_draft', 'files', 'approve_send', 'delete_draft'];
  if (!OPEN_STATUSES.includes(status)) return [];
  const a = ['set_eta', 'mark_received', 'cancel'];
  if (hasDraft) a.push('save_draft', 'files', 'approve_send', 'discard_revision');
  else a.push('start_revision');
  if (status === 'GONDERIM_HATASI' && !hasDraft && !pendingJob) a.push('resend');
  return a;
}

// ---------- e-posta gönderimi ----------

/** Gönderim hatasının sabit kodları (sipariş ekranında metne çevrilir; ham SMTP metni gösterilmez) */
export const SEND_ERRORS = ['NO_EMAIL', 'FILE_NOT_CLEAN', 'FILE_MISSING', 'SMTP', 'UNKNOWN'];

/**
 * E-posta kesinlikle GİTMEDİ mi: hata bağlantı aşamasında (SMTP sunucusuna bağlanılamadı, ad çözülemedi, karşılama
 * gelmedi) oluştuysa ileti sunucuya hiç verilmemiştir → otomatik yeniden denenebilir. Diğer her hata (kimlik doğrulama,
 * alıcı reddi, ileti sırasında kopma, yanıt beklerken zaman aşımı) ya kalıcıdır ya da sonucu belirsizdir → otomatik
 * yeniden GÖNDERİLMEZ; yönetici "Tekrar gönder" ile açıkça karar verir (aynı sipariş için ikinci e-posta riski yok).
 * @param {any} err
 */
export function definitelyNotSent(err) {
  return !!err && err.command === 'CONN';
}

// ---------- tahmini yükleme tarihi ----------

/** Hatırlatma, tahmini yükleme tarihinden bu kadar TAKVİM günü önce (Türkiye fabrika takvimi yok — karar 183) */
export const ETA_REMIND_DAYS = 2;

/** "YYYY-MM-DD" ± gün */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Hatırlatma zamanı geldi mi: bugün (yerel gün) tarihten 2 gün önce ya da sonrası VE tarih geçmemiş.
 * @param {{ etaDay: string | null, today: string }} p
 */
export function etaReminderDue({ etaDay, today }) {
  if (!etaDay) return false;
  return today >= addDays(etaDay, -ETA_REMIND_DAYS) && today <= etaDay;
}

/** Hatırlatmanın anahtarı: sipariş + TARİH — aynı tarih için tek hatırlatma; tarih değişirse yenisi (karar 183) */
export const etaReminderKey = (orderId, etaDay) => `supplier-eta:${orderId}:${etaDay}`;

// ---------- hesap ----------

/**
 * Tedarikçi hesabı (karar 182), para birimi başına: borç = kesinleşmiş ve iptal edilmemiş siparişlerin (son kesin
 * revizyon) toplamı; ödeme = iptal edilmemiş ödemeler; kalan = borç − ödeme. Para birimleri birbirine eklenmez; fiyatı
 * eksik sipariş sayısı ayrıca verilir (borcun o kısmı bilinmiyor — uydurulmaz).
 * @param {{ currency: string, status: string, total: unknown, missingPrice?: boolean }[]} orders
 * @param {{ currency: string, amount: unknown, voidedAt?: Date | string | null }[]} payments
 * @returns {Record<string, { debt: string, paid: string, balance: string, orders: number, missingPrice: number }>}
 */
export function supplierBalances(orders, payments) {
  /** @type {Map<string, { debt: bigint, paid: bigint, orders: number, missingPrice: number }>} */
  const by = new Map();
  const of = (c) => {
    if (!by.has(c)) by.set(c, { debt: 0n, paid: 0n, orders: 0, missingPrice: 0 });
    return /** @type {{ debt: bigint, paid: bigint, orders: number, missingPrice: number }} */ (by.get(c));
  };
  for (const o of orders) {
    if (!DEBT_STATUSES.includes(o.status)) continue;
    const b = of(o.currency);
    b.debt += cents(o.total ?? '0');
    b.orders++;
    if (o.missingPrice) b.missingPrice++;
  }
  for (const p of payments) {
    if (p.voidedAt) continue;
    of(p.currency).paid += cents(p.amount);
  }
  return Object.fromEntries([...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, b]) => [c, {
    debt: money(b.debt), paid: money(b.paid), balance: money(b.debt - b.paid), orders: b.orders, missingPrice: b.missingPrice,
  }]));
}

/**
 * Beklenen tedarik (karar 184; yalnızca yönetici): açık siparişlerin son kesin revizyonundaki miktarlar. Stok birimiyle
 * aynı birimdeki satırlar toplanır; başka birimdeki satırlar ayrı listelenir (birbirine çevrilmez). Stok ve rezerveyle
 * karıştırılmaz — hiçbir stok hareketi yazılmaz.
 * @param {{ status: string, lines: { productId: string, qty: number, unitCode: string }[] }[]} orders  her siparişin son kesin revizyonu
 * @param {Map<string, string>} stockUnits  ürün → satış (stok) birimi
 * @returns {Map<string, { qty: number, other: { unitCode: string, qty: number }[], orders: number }>}
 */
export function expectedSupply(orders, stockUnits) {
  const out = new Map();
  for (const o of orders) {
    if (!OPEN_STATUSES.includes(o.status)) continue;
    const seen = new Set();
    for (const l of o.lines) {
      const e = out.get(l.productId) ?? { qty: 0, other: [], orders: 0 };
      if (l.unitCode === stockUnits.get(l.productId)) e.qty += l.qty;
      else {
        const x = e.other.find((y) => y.unitCode === l.unitCode);
        if (x) x.qty += l.qty;
        else e.other.push({ unitCode: l.unitCode, qty: l.qty });
      }
      if (!seen.has(l.productId)) {
        e.orders++;
        seen.add(l.productId);
      }
      out.set(l.productId, e);
    }
  }
  return out;
}
