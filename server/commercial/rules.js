// Bağımsız yönetici ticari teklifi (3.83.0, karar 277) — SAF kurallar: doğrulama, hesap, müşteri görünümü. Bağımlılığı yalnızca
// saf modüller; tarayıcıdaki düzenleyici (canlı ara toplam) ile sunucu (kayıt, PDF, Excel) AYNI kodu kullanır.
//
// Bu modül sipariş, sipariş teklifi (Offer), üretim, yükleme, FGO, stok ve müşteri sipariş süreçlerinden TAMAMEN ayrıdır:
// hiçbirini okumaz ya da yazmaz; teklifin kabulü sipariş oluşturmaz (müşteri siparişini kendi hesabından verir).
//
// Hesap (kayan nokta yok — BigInt, mevcut kurallarla aynı hassasiyet):
//   cam   : parça m² = en × boy (mm) / 10⁶, 3 ondalık yarım-yukarı (fabrika kuralı — server/orders/rules.js → pieceAreaFromDims);
//           satır m² = parça m² × adet (3 ondalık, ek yuvarlama yok); tutar = m² × €/m², BİR KEZ yarım-yukarı 2 ondalık.
//   profil: tutar = miktar × birim fiyat, BİR KEZ yarım-yukarı 2 ondalık.
//   toplam: yuvarlanmış satır tutarlarının toplamı (EUR, KDV hariç). Tek para birimi: EUR.
// İç maliyet satırın kendi birimiyle (€/m² ya da €/birim) girilir; cam bölümüne isteğe bağlı nakliye + gümrük toplamı eklenir
// (örnek teklif dosyasındaki gibi). Maliyeti girilmemiş satırın maliyeti UYDURULMAZ: "maliyet eksik" sayılır ve kâr /
// marj "eksik" işaretlenir. Maliyet, kâr ve marj YALNIZCA iç görünümdedir; müşteri belgesi customerView'dan üretilir.
import { UNITS } from '../../prisma/seed/data/units.js';
import { CRATE_LINE } from '../orders/rules.js';

export const OFFER_STATUSES = Object.freeze(['TASLAK', 'HAZIR', 'KABUL', 'RED', 'IPTAL']);
/** Sonuç işaretlenebilen durumlar (kabul / ret yalnızca kayıt: sipariş, belge, e-posta YOK) */
export const OUTCOME_STATUSES = Object.freeze(['KABUL', 'RED']);
export const LIMITS = Object.freeze({
  glass: 100, profile: 200, ops: 20, terms: 20, termChars: 300, desc: 200, firm: 160, note: 1000,
  mm: 10_000, qty: 100_000, price: 1_000_000, extra: 10_000_000, validity: 365, number: 999_999,
});
export const PROFILE_COLORS = Object.freeze(['RAL7016', 'ELOXAT']);
/**
 * Cam bölümünün ek kalemleri (4.0.0, karar 297 — referans: satış ekibinin teklif tablosu, karar 113 / 211 / 214):
 *   - CNC / DELIK: cam satırının ALTINDAKİ işlem (satırın `ops` dizisi); numarasız, ölçüsüz, birimi adet. Adedi camın
 *     adedinden BAĞIMSIZDIR (sınır / denetim yok — cam bölünmez); tutar = kendi adedi × birim satış fiyatı, bir kez 2 ondalık.
 *     Maliyet isteğe bağlı (öneri: kullanıcının fiyat tablosundaki CNC / delik fiyatı).
 *   - SANDIK (sandık parası): cam bölümünde ayrı, NUMARALI kalem (`kind: 'SANDIK'`); yalnızca "+ Sandık parası" ile eklenir.
 *     Adet ve birim satış fiyatı girilir; maliyeti kuralla 0 € (referanstaki yönetici sandık bedeli gibi — "maliyet eksik" sayılmaz).
 * Hiçbiri cam adedini, m² toplamını ve nakliye + gümrük payını (m² başına) değiştirmez; tutarları cam bölümünün toplamına ve
 * genel toplama bir kez eklenir. `kind` / `ops` taşımayan (eski) satırlar bugünkü gibi cam satırıdır.
 */
export const OP_KINDS = Object.freeze(['CNC', 'DELIK']);
export const CRATE_KIND = 'SANDIK';
/** Müşteri belgesindeki sandık kaleminin adı (belge Romence; satış tablosuyla aynı ad — server/orders/rules.js → CRATE_LINE) */
export const CRATE_TEXT = CRATE_LINE.ro;
const isCrate = (l) => l?.kind === CRATE_KIND;
/** Müşteri belgesindeki renk yazımı (örnek teklif: "RAL7016") */
export const COLOR_TEXT = Object.freeze({ RAL7016: 'RAL7016', ELOXAT: 'Eloxat' });
export const DEFAULT_VALIDITY_DAYS = 5;
/** Varsayılan koşullar (örnek teklif dosyasından; teklifte düzenlenebilir). "*" ile başlayan satır belgede not olarak yazılır. */
export const DEFAULT_TERMS = Object.freeze([
  'Metode de plată: 75% avans, 25% înainte de livrare.',
  'Pentru profile: ridicare din depozitul București.',
  'Termen de livrare: 4 - 6 săptămâni după ce primim avansul.',
  'Prețurile sunt valabile dacă pierderile nu depășesc 10%.',
  'Prețurile sunt valabile pentru un singur transport pentru toată comanda.',
  '*Plata pentru prețurile exprimate în EURO se va efectua în RON la cursul de vânzare al Băncii Transilvania din data facturii proforme.',
  '*Orice modificare de preț din partea Șișecam va fi aplicată în prețurile lucrărilor pentru care nu s-a primit un avans.',
]);
/** Müşteri belgesinin altındaki iletişim bilgisi (örnek teklif dosyasından) */
export const GKH_CONTACT = Object.freeze({
  address: 'Str. Tanase Banciu, Nr.3, Popești Leordeni - ILFOV',
  phone: '+40 736 947797',
  web: Object.freeze(['www.gkhdigital.ro', 'www.balustradacusticla.ro', 'www.gkh.ro']),
  email: 'info@gkh.ro',
});
/** Belgedeki geçerlilik cümlesi (koşulların ilki) */
export const validityText = (days) => `Oferta este valabilă ${days} zile lucrătoare.`;

/**
 * Ticari teklif modülüne özgü profil kategori sırası (DÜZELTME 10 M1, 3.96.0): Alüminyum profiller → Contalar → Plastikler →
 * Aksesuarlar. Kategori KODUYLA eşleşir; listede olmayan kategori arkadan, kendi katalog sırasıyla gelir. Müşteri profil
 * sipariş formu kendi katalog sırasını (ProfileCategory.sortOrder) kullanmaya devam eder — bu sıra yalnızca bu modüldedir.
 */
export const COMMERCIAL_CATEGORY_ORDER = Object.freeze(['PROFILE_ALUMINIU', 'GARNITURI', 'PLASTICE', 'ACCESORII']);
/** Kategori → modül sırası (0…3; bilinmeyen: 100 + katalog sırası) */
export function commercialCategoryRank(category) {
  const i = COMMERCIAL_CATEGORY_ORDER.indexOf(String(category?.code ?? ''));
  if (i >= 0) return i;
  const s = Number(category?.sortOrder ?? 0);
  return 100 + (Number.isFinite(s) ? s : 0);
}
/**
 * Veri biçimi: 2 = profil satırları categoryRank ile sıralanır (3.96.0). Daha önce kaydedilmiş (özellikle kesinleşmiş) sürümler
 * bu alanı taşımaz ve eski sırayla (categorySort) çizilir — kesinleşmiş belge değişmez.
 */
export const CATEGORY_ORDER_VERSION = 2;

/** Teklif numarası ekranda / belgede 4 hane: 496 → "0496" */
export const offerNoText = (n) => String(n).padStart(4, '0');

// ---------------------------------------------------------------- sayı yardımcıları (ölçekli tam sayı)
/** "12,5" / "12.5" → ölçekli tam sayı; en çok `scale` ondalık; eksi yok; geçersiz → null */
export function toScaled(v, scale) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s/g, '');
  const norm = /^\d{1,3}(\.\d{3})+,\d+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s;
  const m = /^(\d{1,15})(?:[.,](\d{1,20}))?$/.exec(norm);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (/[1-9]/.test(frac.slice(scale))) return null;
  return BigInt(m[1]) * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0');
}
/** Ölçekli tam sayı → "12.50" (en az minFrac ondalık, sondaki fazla sıfırlar atılır) */
export function fromScaled(n, scale, minFrac = 0) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(scale);
  let frac = scale ? (a % base).toString().padStart(scale, '0').replace(/0+$/, '') : '';
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return `${neg ? '-' : ''}${(a / base).toString()}${frac ? `.${frac}` : ''}`;
}
/** Yarım-yukarı bölme (pay eksi olabilir: kâr) */
const divRound = (num, den) => (num >= 0n ? (num + den / 2n) / den : -((-num + den / 2n) / den));
const int = (v, min, max) => {
  const s = String(v ?? '').trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};
/** Fiyat / maliyet: 0 … LIMITS.price, en çok 4 ondalık. Boş → null. Geçersiz → undefined */
function price4(v, { required }) {
  const s = String(v ?? '').trim();
  if (!s) return required ? undefined : null;
  const n = toScaled(s, 4);
  if (n == null || n > BigInt(LIMITS.price) * 10_000n) return undefined;
  return fromScaled(n, 4);
}
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------- hesap
/** Cam parçasının m²'si, 10⁻³ m² cinsinden (en × boy mm², 3 ondalığa yarım-yukarı) */
export const pieceMilli = (en, boy) => divRound(BigInt(en) * BigInt(boy), 1000n);
/** m² (10⁻³) × €/m² (10⁻⁴) → sent (10⁻²), bir kez yarım-yukarı */
const areaAmount = (milli, p) => divRound(milli * toScaled(p, 4), 100_000n);
/**
 * Miktar (10⁻³) × birim fiyat (10⁻⁴) → sent (10⁻²), bir kez yarım-yukarı — profil satırı, cam işlemi (CNC / delik) ve sandık
 * kalemi aynı kuralı kullanır (adetli kalem: miktar = adet × 1000).
 */
const qtyAmount = areaAmount;

/**
 * Profil / aksesuar ürünü metreyle mi fiyatlanır: paket ölçüsü metre (M) ve paket içeriği tanımlı (profil çubuğu 6 m, conta
 * kutusu 137 m …). O zaman yalnızca METRE girilir; paket sayısı = ⌈metre ÷ içerik⌉ (profil hesaplayıcısının yuvarlaması —
 * server/profile/calculator.js) ve belgede miktar = paket × içerik (ML), fiyat €/ML. Aksi hâlde ürünün kendi biriminde adet.
 * @param {{ packMeasure?: unknown, packContent?: unknown }} prod
 */
export function perMlContent(prod) {
  if (String(prod?.packMeasure ?? '') !== 'M' || prod?.packContent == null) return null;
  const c = toScaled(String(prod.packContent), 3);
  return c != null && c > 0n ? fromScaled(c, 3) : null;
}
/**
 * Profil / aksesuar ürününün önerilen satış ve iç maliyet birim fiyatı (yalnızca öneri — yönetici değiştirir): satış = katalog
 * liste fiyatı (EUR, satış birimi başına). Maliyet (DÜZELTME 10 M6): önce GERÇEKLEŞEN stok maliyeti (mal kabullerinden, nakliye
 * dahil ağırlıklı ortalama, EUR / stok birimi — stockCostEur); yoksa katalog alış fiyatı, yalnızca alış para birimi EUR ve alış
 * birimi satış birimiyle aynıysa (çevrim / tahmin yok). İkisi ayrı değerlerdir ve ayrı döner. Metreyle fiyatlanan üründe birim
 * başına fiyat ÷ içerik (€/ML, 4 ondalık yarım-yukarı).
 * @param {{ listPrice?: unknown, purchasePrice?: unknown, purchaseCurrency?: unknown, purchaseUnit?: unknown, unitCode?: unknown, packMeasure?: unknown, packContent?: unknown, stockCostEur?: unknown }} prod
 * @returns {{ price: string | null, cost: string | null, costSource: 'STOCK' | 'CATALOG' | null, stockCost: string | null, catalogCost: string | null }}
 */
export function profileDefaults(prod) {
  const content = perMlContent(prod);
  const per = (v) => {
    if (v == null || v === '') return null;
    const n = toScaled(String(v), 4);
    if (n == null) return null;
    return content ? fromScaled(divRound(n * 1000n, toScaled(content, 3)), 4, 2) : fromScaled(n, 4, 2);
  };
  const sameUnit = prod?.purchaseUnit == null || prod.purchaseUnit === '' || prod.purchaseUnit === prod.unitCode;
  const catalogCost = prod?.purchaseCurrency === 'EUR' && sameUnit ? per(prod?.purchasePrice) : null;
  const stockCost = per(prod?.stockCostEur);
  return { price: per(prod?.listPrice), cost: stockCost ?? catalogCost, costSource: stockCost != null ? 'STOCK' : catalogCost != null ? 'CATALOG' : null, stockCost, catalogCost };
}
/** Metre → tam paket sayısı (yukarı yuvarlama, bir kez) */
export function packsFor(meters, content) {
  const m = toScaled(meters, 3), c = toScaled(content, 3);
  if (m == null || c == null || c <= 0n) return null;
  return Number((m + c - 1n) / c);
}

/**
 * Bütün hesap — satırlar, bölüm toplamları, maliyet, brüt kâr, marj. Girdi: doğrulanmış teklif verisi (parseOffer) ya da
 * kayıtlı sürümün verisi. Tutarlar metin ("17137.96"); m² metin ("271.600").
 * @param {{ glass: any[], profile: any[], glassExtraCost?: string | null }} d
 */
export function computeOffer(d) {
  let glassM2 = 0n, glassSale = 0n, glassCost = 0n, profileSale = 0n, profileCost = 0n, costedSale = 0n, missing = 0;
  let opsSale = 0n, crateSale = 0n, glassQty = 0, cnc = 0, holes = 0, crates = 0;
  const glass = (d.glass ?? []).map((l) => {
    if (isCrate(l)) {
      // Sandık parası: adet × birim fiyat; maliyet kuralla 0 € (maliyeti "girilmiş" sayılır)
      const sale = qtyAmount(BigInt(l.qty) * 1000n, l.price);
      glassSale += sale; crateSale += sale; costedSale += sale; crates += l.qty;
      return { ...l, amount: fromScaled(sale, 2, 2), costAmount: '0.00', profit: fromScaled(sale, 2, 2) };
    }
    const piece = pieceMilli(l.en, l.boy);
    const m2 = piece * BigInt(l.qty);
    const sale = areaAmount(m2, l.price);
    const cost = l.cost == null ? null : areaAmount(m2, l.cost);
    glassM2 += m2; glassSale += sale; glassQty += l.qty;
    if (cost == null) missing++; else { glassCost += cost; costedSale += sale; }
    const out = { ...l, pieceM2: fromScaled(piece, 3, 3), m2: fromScaled(m2, 3, 3), amount: fromScaled(sale, 2, 2),
      costAmount: cost == null ? null : fromScaled(cost, 2, 2), profit: cost == null ? null : fromScaled(sale - cost, 2, 2) };
    if (!Array.isArray(l.ops) || !l.ops.length) return out;
    // CNC / delik: kendi adedi × birim fiyat (camın adedinden bağımsız); m²'ye girmez
    out.ops = l.ops.map((o) => {
      const milli = BigInt(o.qty) * 1000n;
      const s = qtyAmount(milli, o.price);
      const c = o.cost == null ? null : qtyAmount(milli, o.cost);
      glassSale += s; opsSale += s;
      if (o.kind === 'CNC') cnc += o.qty; else holes += o.qty;
      if (c == null) missing++; else { glassCost += c; costedSale += s; }
      return { ...o, amount: fromScaled(s, 2, 2), costAmount: c == null ? null : fromScaled(c, 2, 2), profit: c == null ? null : fromScaled(s - c, 2, 2) };
    });
    return out;
  });
  const profile = (d.profile ?? []).map((l) => {
    // Metre ile fiyatlanan ürün (profil çubuğu, conta kutusu): faturalanan miktar = tam paket × paket içeriği (ML)
    const billMilli = l.perMl ? BigInt(l.qty) * toScaled(l.content, 3) : BigInt(l.qty) * 1000n;
    const sale = qtyAmount(billMilli, l.price);
    const cost = l.cost == null ? null : qtyAmount(billMilli, l.cost);
    profileSale += sale;
    if (cost == null) missing++; else { profileCost += cost; costedSale += sale; }
    return { ...l, billQty: fromScaled(billMilli, 3), amount: fromScaled(sale, 2, 2), costAmount: cost == null ? null : fromScaled(cost, 2, 2),
      profit: cost == null ? null : fromScaled(sale - cost, 2, 2) };
  });
  const extra = d.glassExtraCost ? toScaled(d.glassExtraCost, 2) ?? 0n : 0n;
  const total = glassSale + profileSale;
  const cost = glassCost + profileCost + extra;
  // Brüt kâr ve marj yalnızca maliyeti girilmiş satırlardan (maliyeti eksik satırın satışı kâr sayılmaz): kâr = bu satırların
  // satışı − toplam maliyet; marj = kâr / bu satış × 100, 2 ondalık (satış 0 ise yok). Eksik satır yoksa satış = genel toplam.
  const profit = costedSale - cost;
  const margin = costedSale > 0n ? fromScaled(divRound(profit * 10_000n, costedSale), 2, 2) : null;
  // Nakliye + gümrükün m² başına payı (yalnızca bilgi — örnek dosyadaki "transport/mp"; 4 ondalık)
  const extraPerM2 = extra > 0n && glassM2 > 0n ? fromScaled(divRound(extra * 100_000n, glassM2), 4, 2) : null;
  const s2 = (n) => fromScaled(n, 2, 2);
  return {
    glass, profile,
    totals: {
      glassM2: fromScaled(glassM2, 3, 3), glass: s2(glassSale), profile: s2(profileSale), total: s2(total),
      glassCost: s2(glassCost), profileCost: s2(profileCost), extraCost: s2(extra), extraPerM2,
      cost: s2(cost), costedSale: s2(costedSale), profit: s2(profit), margin, missingCost: missing,
      // Cam bölümünün içinden (glass toplamına dahil): işlemler ve sandık parası; adetler (cam, CNC, delik, sandık)
      ops: s2(opsSale), crate: s2(crateSale), glassQty, cnc, holes, crates,
    },
  };
}

// ---------------------------------------------------------------- doğrulama
/**
 * Formdan gelen teklif verisini doğrular ve KATALOG KOPYASIYLA birleştirir (ad, kod, birim, kategori sunucuda katalogdan
 * alınır; tarayıcıdan gelen ürün bilgisine güvenilmez). Hata → { ok: false, code, section?, index? }.
 * @param {any} v  { date, firmName, customerId, validityDays, terms, note, glassExtraCost, glass: [], profile: [] }
 * @param {{ glassProducts: Map<string, any>, profileProducts: Map<string, any>, customers?: Map<string, any> }} cat
 */
export function parseOffer(v, cat) {
  const date = String(v?.date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return { ok: false, code: 'DATE' };
  const customerId = String(v?.customerId ?? '').trim() || null;
  const customer = customerId ? cat.customers?.get(customerId) : null;
  if (customerId && !customer) return { ok: false, code: 'CUSTOMER' };
  const firmName = clean(v?.firmName, LIMITS.firm + 1) || customer?.name || '';
  if (!firmName) return { ok: false, code: 'FIRM' };
  if (firmName.length > LIMITS.firm) return { ok: false, code: 'FIRM' };
  const validityDays = int(v?.validityDays, 1, LIMITS.validity);
  if (validityDays == null) return { ok: false, code: 'VALIDITY' };
  const rawTerms = Array.isArray(v?.terms) ? v.terms : String(v?.terms ?? '').split('\n');
  const terms = rawTerms.map((s) => clean(s, LIMITS.termChars + 1)).filter(Boolean);
  if (terms.length > LIMITS.terms || terms.some((s) => s.length > LIMITS.termChars)) return { ok: false, code: 'TERMS' };
  const note = String(v?.note ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  if (note.length > LIMITS.note) return { ok: false, code: 'NOTE' };
  let glassExtraCost = null;
  const ex = String(v?.glassExtraCost ?? '').trim();
  if (ex) {
    const n = toScaled(ex, 2);
    if (n == null || n > BigInt(LIMITS.extra) * 100n) return { ok: false, code: 'EXTRA' };
    glassExtraCost = n > 0n ? fromScaled(n, 2, 2) : null;
  }
  const g = Array.isArray(v?.glass) ? v.glass : [];
  const p = Array.isArray(v?.profile) ? v.profile : [];
  if (g.length > LIMITS.glass || p.length > LIMITS.profile) return { ok: false, code: 'TOO_MANY' };
  const glass = [];
  for (const [i, l] of g.entries()) {
    const kind = l?.kind == null || l.kind === '' ? 'CAM' : String(l.kind);
    if (kind === CRATE_KIND) {
      // Sandık parası: ad sabit (belgede CRATE_TEXT), maliyet kuralla 0
      const qty = int(l?.qty, 1, LIMITS.qty);
      if (qty == null) return { ok: false, code: 'QTY', section: 'glass', index: i };
      const price = price4(l?.price, { required: true });
      if (price === undefined) return { ok: false, code: 'PRICE', section: 'glass', index: i };
      glass.push({ kind: CRATE_KIND, qty, price, cost: '0' });
      continue;
    }
    if (kind !== 'CAM') return { ok: false, code: 'OPS', section: 'glass', index: i };
    const prod = cat.glassProducts.get(String(l?.productId ?? ''));
    if (!prod) return { ok: false, code: 'GLASS_PRODUCT', section: 'glass', index: i };
    const en = int(l?.en, 1, LIMITS.mm), boy = int(l?.boy, 1, LIMITS.mm);
    if (en == null || boy == null) return { ok: false, code: 'DIMENSION', section: 'glass', index: i };
    const qty = int(l?.qty, 1, LIMITS.qty);
    if (qty == null) return { ok: false, code: 'QTY', section: 'glass', index: i };
    const price = price4(l?.price, { required: true });
    if (price === undefined) return { ok: false, code: 'PRICE', section: 'glass', index: i };
    const cost = price4(l?.cost, { required: false });
    if (cost === undefined) return { ok: false, code: 'COST', section: 'glass', index: i };
    const catalogText = [prod.nameRo, prod.colorRo].map((s) => String(s ?? '').trim()).filter(Boolean).join(', ');
    const description = clean(l?.description, LIMITS.desc + 1) || catalogText;
    if (description.length > LIMITS.desc) return { ok: false, code: 'DESC', section: 'glass', index: i };
    // Teklifi hazırlayanın fiyat tablosundaki (Tanımlar → Fiyat Tabloları, server/commercial/glass-cost.js) o andaki fiyat sunucuda okunur ve sürüme kopyalanır; yöneticinin girdiği
    // maliyet bundan farklıysa satır "MANUAL" işaretlenir (denetim kaydına da yazılır). Liste fiyatı yoksa kaynak boş kalır.
    const listCost = cat.glassCosts?.get(prod.id) ?? null;
    const costSource = cost == null ? null : listCost != null && toScaled(listCost, 4) === toScaled(cost, 4) ? 'LIST' : listCost != null ? 'MANUAL' : null;
    // CNC / delik (cam satırının altındaki işlemler): adet camdan bağımsız; maliyet önerisi fiyat tablosunun CNC / delik fiyatı
    const rawOps = l?.ops == null ? [] : l.ops;
    if (!Array.isArray(rawOps)) return { ok: false, code: 'OPS', section: 'glass', index: i };
    if (rawOps.length > LIMITS.ops) return { ok: false, code: 'TOO_MANY' };
    const ops = [];
    for (const o of rawOps) {
      const ok = String(o?.kind ?? '');
      if (!OP_KINDS.includes(ok)) return { ok: false, code: 'OPS', section: 'glass', index: i };
      const oq = int(o?.qty, 1, LIMITS.qty);
      if (oq == null) return { ok: false, code: 'QTY', section: 'glass', index: i };
      const op = price4(o?.price, { required: true });
      if (op === undefined) return { ok: false, code: 'PRICE', section: 'glass', index: i };
      const oc = price4(o?.cost, { required: false });
      if (oc === undefined) return { ok: false, code: 'COST', section: 'glass', index: i };
      const od = clean(o?.description, LIMITS.desc + 1);
      if (od.length > LIMITS.desc) return { ok: false, code: 'DESC', section: 'glass', index: i };
      const olc = cat.opCosts?.[ok] ?? null;
      const osrc = oc == null ? null : olc != null && toScaled(olc, 4) === toScaled(oc, 4) ? 'LIST' : olc != null ? 'MANUAL' : null;
      ops.push({ kind: ok, description: od, qty: oq, price: op, cost: oc, listCost: olc, costSource: osrc });
    }
    glass.push({ productId: prod.id, catalogTr: [prod.nameTr, prod.colorTr].filter(Boolean).join(' — '), description, en, boy, qty, price, cost, listCost, costSource, ...(ops.length ? { ops } : {}) });
  }
  const profile = [];
  for (const [i, l] of p.entries()) {
    const prod = cat.profileProducts.get(String(l?.productId ?? ''));
    if (!prod) return { ok: false, code: 'PROFILE_PRODUCT', section: 'profile', index: i };
    const content = perMlContent(prod);
    let qty, meters = null;
    if (content) {
      const ms = String(l?.meters ?? '').trim();
      const m = toScaled(ms, 2);
      if (m == null || m <= 0n || m > BigInt(LIMITS.qty) * 100n) return { ok: false, code: 'METERS', section: 'profile', index: i };
      meters = fromScaled(m, 2);
      qty = packsFor(meters, content);
      if (qty == null || qty > LIMITS.qty) return { ok: false, code: 'METERS', section: 'profile', index: i };
    } else {
      qty = int(l?.qty, 1, LIMITS.qty);
      if (qty == null) return { ok: false, code: 'QTY', section: 'profile', index: i };
    }
    const color = String(l?.color ?? '').trim();
    if (color && !PROFILE_COLORS.includes(color)) return { ok: false, code: 'COLOR', section: 'profile', index: i };
    const price = price4(l?.price, { required: true });
    if (price === undefined) return { ok: false, code: 'PRICE', section: 'profile', index: i };
    const cost = price4(l?.cost, { required: false });
    if (cost === undefined) return { ok: false, code: 'COST', section: 'profile', index: i };
    // Maliyetin kaynağı (M6) sunucuda: gerçekleşen stok maliyeti / katalog alış fiyatı / elle; o anki değerler sürüme kopyalanır
    const def = profileDefaults(prod);
    const same = (a) => a != null && cost != null && toScaled(a, 4) === toScaled(cost, 4);
    const costSource = cost == null ? null : same(def.stockCost) ? 'STOCK' : same(def.catalogCost) ? 'CATALOG' : 'MANUAL';
    const description = clean(l?.description, LIMITS.desc + 1) || prod.nameRo;
    if (description.length > LIMITS.desc) return { ok: false, code: 'DESC', section: 'profile', index: i };
    profile.push({
      productId: prod.id, code: prod.code, nameTr: prod.nameTr, description, unitCode: prod.unitCode,
      category: prod.category?.nameRo ?? '', categoryTr: prod.category?.nameTr ?? '', categorySort: prod.category?.sortOrder ?? 0,
      categoryRank: commercialCategoryRank(prod.category),
      perMl: !!content, content, meters, color: color || null, qty, price, cost, costSource, stockCost: def.stockCost, catalogCost: def.catalogCost,
    });
  }
  // Belgede profil satırları kategoriye göre gruplanır (örnek teklif: profil / ACCESORII / MÂNĂ CURENTĂ); sıra kararlı
  return {
    ok: true,
    data: { date, firmName, customerId: customer?.id ?? null, validityDays, terms, note, glassExtraCost, glass, profile, categoryOrder: CATEGORY_ORDER_VERSION },
  };
}

// ---------------------------------------------------------------- birim
/** Belgedeki U.M. yazımı (Romence; bilinmeyen kod olduğu gibi) */
export function unitText(code, locale = 'ro') {
  const u = UNITS.find((x) => x.code === code);
  return u ? (u.name[locale] ?? u.name.ro) : String(code ?? '');
}

// ---------------------------------------------------------------- müşteri görünümü
/**
 * Müşteri belgesine (PDF) giden TEK veri — beyaz liste: maliyet, kâr, marj, nakliye / gümrük maliyeti, iç not ve katalog
 * kimlikleri BURADAN GEÇMEZ. PDF üreticisi yalnızca bunu alır.
 * @param {{ no: number, version: number, data: any, draft: boolean }} p
 */
export function customerView({ no, version, data, draft }) {
  const c = computeOffer(data);
  // Profil satırları kategoriye göre (kategori sırası, sonra girildiği sıra). Yeni biçim (3.96.0) modül sırasını (categoryRank)
  // kullanır; eski sürümler kayıtlı oldukları sırayla çizilir.
  const rank = data?.categoryOrder === CATEGORY_ORDER_VERSION ? (l) => l.categoryRank ?? 1000 : (l) => l.categorySort ?? 0;
  const groups = [];
  const byCat = new Map();
  c.profile
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .forEach(({ l }) => {
      const key = l.category || '';
      if (!byCat.has(key)) { const gr = { title: key, rows: [] }; byCat.set(key, gr); groups.push(gr); }
      byCat.get(key).rows.push({
        description: l.description, code: l.code, color: l.color ? COLOR_TEXT[l.color] ?? l.color : '',
        unit: l.perMl ? 'ML' : unitText(l.unitCode), qty: l.billQty, perMl: !!l.perMl, price: l.price, amount: l.amount,
      });
    });
  return {
    no: offerNoText(no), version, draft, date: data.date, firmName: data.firmName,
    glass: c.glass.map((l) => (isCrate(l)
      ? { crate: true, description: CRATE_TEXT, qty: l.qty, price: l.price, amount: l.amount }
      : {
        description: l.description, en: l.en, boy: l.boy, qty: l.qty, m2: l.m2, price: l.price, amount: l.amount,
        ...(l.ops ? { ops: l.ops.map((o) => ({ kind: o.kind, description: o.description, qty: o.qty, price: o.price, amount: o.amount })) } : {}),
      })),
    profileGroups: groups,
    totals: { glassM2: c.totals.glassM2, glass: c.totals.glass, profile: c.totals.profile, total: c.totals.total },
    terms: [validityText(data.validityDays), ...data.terms],
  };
}

/** Teklif verisinin boş başlangıcı (yeni teklif) */
export function emptyOffer(today) {
  return { date: today, firmName: '', customerId: null, validityDays: DEFAULT_VALIDITY_DAYS, terms: [...DEFAULT_TERMS], note: '', glassExtraCost: null, glass: [], profile: [] };
}

/**
 * Satırın belgedeki miktarı — fiyattan bağımsız (düzenleyici, fiyat girilmeden de gösterir). Metreyle fiyatlanan üründe
 * { packs, bill: paket × içerik (ML) }, diğerinde { packs: adet, bill: adet }. Geçersiz giriş → null.
 * @param {{ meters?: unknown, qty?: unknown }} l  @param {string | null} content
 */
export function billQuantity(l, content) {
  if (content) {
    const m = toScaled(String(l?.meters ?? '').trim(), 2);
    if (m == null || m <= 0n || m > BigInt(LIMITS.qty) * 100n) return null;
    const packs = packsFor(fromScaled(m, 2), content);
    if (packs == null || packs > LIMITS.qty) return null;
    return { packs, bill: fromScaled(BigInt(packs) * toScaled(content, 3), 3) };
  }
  const qty = int(l?.qty, 1, LIMITS.qty);
  return qty == null ? null : { packs: qty, bill: String(qty) };
}

/**
 * Cam satırının m²'si — fiyattan, maliyetten ve tekliften BAĞIMSIZ (4.1.0): cam seçili, en / boy (1–10000 mm) ve adet
 * (1–100000) geçerliyse computeOffer'ın aynı kuralı (parça m² = en × boy 3 ondalık, × adet); değilse null. Düzenleyici satırın
 * m² hücresini bununla gösterir: fiyat girilmeden de görünür. Toplamlar değişmez (fiyatsız satır toplama katılmaz).
 * @param {{ productId?: unknown, en?: unknown, boy?: unknown, qty?: unknown }} l
 * @returns {string | null}  "1.021"
 */
export function glassLineM2(l) {
  const en = int(l?.en, 1, LIMITS.mm), boy = int(l?.boy, 1, LIMITS.mm), qty = int(l?.qty, 1, LIMITS.qty);
  if (!l?.productId || en == null || boy == null || qty == null) return null;
  return fromScaled(pieceMilli(en, boy) * BigInt(qty), 3, 3);
}

/**
 * Düzenleyicinin canlı ara hesabı (tarayıcı): eksik / hatalı satır toplama KATILMAZ ve `null` döner; geçerli satırlar
 * computeOffer'dan (sunucuyla aynı kural). Kayıt her zaman sunucuda parseOffer ile yeniden doğrulanır.
 * @param {{ glass: any[], profile: any[], glassExtraCost?: string }} v
 * @param {(productId: string) => string | null | undefined} contentOf  metreyle fiyatlanan ürünün paket içeriği (yoksa null)
 */
export function previewOffer(v, contentOf) {
  const glass = (v.glass ?? []).map((l) => {
    const qty = int(l?.qty, 1, LIMITS.qty);
    const price = price4(l?.price, { required: true });
    if (isCrate(l)) return qty == null || price == null ? null : { kind: CRATE_KIND, qty, price, cost: '0' };
    const en = int(l?.en, 1, LIMITS.mm), boy = int(l?.boy, 1, LIMITS.mm);
    const cost = price4(l?.cost, { required: false });
    if (!l?.productId || en == null || boy == null || qty == null || price == null || cost === undefined) return null;
    // İşlemlerden biri eksik / hatalıysa cam satırı (işlemleriyle) toplama katılmaz — sunucu da satırı reddeder
    const ops = [];
    for (const o of Array.isArray(l?.ops) ? l.ops : []) {
      const oq = int(o?.qty, 1, LIMITS.qty), op = price4(o?.price, { required: true }), oc = price4(o?.cost, { required: false });
      if (!OP_KINDS.includes(String(o?.kind)) || oq == null || op == null || oc === undefined) return null;
      ops.push({ kind: String(o.kind), qty: oq, price: op, cost: oc });
    }
    return { en, boy, qty, price, cost, ...(ops.length ? { ops } : {}) };
  });
  const profile = (v.profile ?? []).map((l) => {
    if (!l?.productId) return null;
    const content = contentOf(String(l.productId)) ?? null;
    const price = price4(l?.price, { required: true }), cost = price4(l?.cost, { required: false });
    if (price == null || cost === undefined) return null;
    if (content) {
      const m = toScaled(String(l?.meters ?? '').trim(), 2);
      if (m == null || m <= 0n || m > BigInt(LIMITS.qty) * 100n) return null;
      const meters = fromScaled(m, 2);
      const qty = packsFor(meters, content);
      if (qty == null || qty > LIMITS.qty) return null;
      return { perMl: true, content, meters, qty, price, cost };
    }
    const qty = int(l?.qty, 1, LIMITS.qty);
    return qty == null ? null : { perMl: false, content: null, meters: null, qty, price, cost };
  });
  const ex = toScaled(String(v.glassExtraCost ?? '').trim() || '0', 2);
  const c = computeOffer({ glass: glass.filter(Boolean), profile: profile.filter(Boolean), glassExtraCost: ex == null ? null : fromScaled(ex, 2, 2) });
  let gi = 0, pi = 0;
  return {
    glass: glass.map((l) => (l ? c.glass[gi++] : null)),
    profile: profile.map((l) => (l ? c.profile[pi++] : null)),
    totals: c.totals,
    invalid: glass.filter((l) => !l).length + profile.filter((l) => !l).length,
  };
}
