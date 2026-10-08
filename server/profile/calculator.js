// Profil ve aksesuar hesaplayıcısı (Paket 5, karar 175–176) — Next.js'ten ve veritabanından bağımsız, birim testli.
//
// Müşteri profil siparişi ekranında toplam korkuluk metresini girer; kesim optimizasyonu YOKTUR. Değerleri yönetici tanımlar:
//   sistem          — ör. "MR23 el tutamağı" (ProfileSystem); RM29 gibi yeni sistemleri yönetici açar
//   kalem (slot)    — sistemin bir parçası (ör. "Profil", "El tutamağı contası"); kalemin satırları birbirinin SEÇENEĞİDİR
//   satır           — ürün (ya da "bu koşulda gerekmez") + koşul (renk, cam kalınlığı; boş = hepsi) + 1 m korkuluk için
//                     tüketim (ürünün ölçüsünde: metre ya da adet)
//   paket içeriği   — ürünün BİR satış birimindeki miktar (Profil Kataloğu): kutu 137 m conta, bar = profil boyu (m),
//                     poşet = parça (adet). Paket içeriği tüketim değildir.
// Kural: her kalemde koşula uyan TEK satır seçilir (MR23'ün conta kalemi: 12,76 mm → MC12, 16,76 mm → MC16; RM29'un böyle
// bir kalemi yoksa MC hiç hesaplanmaz); aynı ürünün ihtiyaçları toplanır ve bir kez yuvarlanır:
//   adet = yukarı yuvarla(metre × tüketim / paket içeriği)
// Hesap tam sayı aritmetiğiyle yapılır (BigInt; kayan nokta yok): metre 2, tüketim 4, içerik 3 ondalık.
// TAHMİN YOK: koşula uyan satır yoksa, tüketim ya da paket içeriği boşsa, ürün pasifse HİÇBİR miktar üretilmez; hata,
// yöneticinin tamamlaması gereken değeri adıyla söyler (karar 176). Yarım sonuç da üretilmez.
import { MAX_PROFILE_QTY } from './rules.js';

/** Hesaplayıcının renkleri (ProfileColor) */
export const PROFILE_COLORS = Object.freeze(['RAL7016', 'ELOXAT']);
/** İçeriğin ölçüsü (ProfileMeasure): metre ya da adet */
export const MEASURES = Object.freeze(['M', 'BUC']);
/** Müşterinin bir hesapta girebileceği en çok toplam metre */
export const MAX_CALC_METERS = 10_000;
/** Bir satış birimindeki en çok içerik (m ya da adet) */
export const MAX_PACK_CONTENT = 100_000;
/** 1 m korkuluk için en çok tüketim */
export const MAX_PER_METER = 1_000;
/** Cam kalınlığı (mm) aralığı */
export const THICKNESS_MM = Object.freeze({ min: 1, max: 200 });
/** Kalem adının en çok uzunluğu */
export const MAX_SLOT = 60;

const SCALE = Object.freeze({ meters: 2, perMeter: 4, content: 3, mm: 2 });

// ---------- ondalık sayılar (tam sayı olarak) ----------

/**
 * "137", "12,5", 12.5 ya da Prisma Decimal → ölçekli tam sayı (BigInt). Ölçekten fazla anlamlı ondalık, eksi işareti,
 * üs gösterimi ve sayı olmayan değer → null (yuvarlama yapılmaz).
 * @param {unknown} v  @param {number} scale
 * @returns {bigint | null}
 */
export function toScaled(v, scale) {
  if (v == null) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  const s = String(v).trim();
  const m = /^(\d{1,15})(?:[.,](\d{1,20}))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (/[1-9]/.test(frac.slice(scale))) return null;
  return BigInt(m[1]) * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0');
}

/**
 * Ölçekli tam sayı → "137", "12.5", "0.0001" (sondaki sıfırlar atılır)
 * @param {bigint} n  @param {number} scale
 */
export function fromScaled(n, scale) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(scale);
  const int = (a / base).toString();
  const frac = scale ? (a % base).toString().padStart(scale, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

// ---------- girdiler ----------

/**
 * Müşterinin toplam metresi: en çok 2 ondalık (virgül ya da nokta), 0'dan büyük, en çok MAX_CALC_METERS.
 * @returns {{ ok: true, cm: number } | { ok: false, code: 'METERS_EMPTY' | 'METERS_BAD' | 'METERS_ZERO' | 'METERS_TOO_LARGE' }}
 */
export function parseMeters(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) return { ok: false, code: 'METERS_EMPTY' };
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, code: 'METERS_BAD' };
  if (m[1].replace(/^0+/, '').length > String(MAX_CALC_METERS).length) return { ok: false, code: 'METERS_TOO_LARGE' };
  const cm = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (cm <= 0) return { ok: false, code: 'METERS_ZERO' };
  if (cm > MAX_CALC_METERS * 100) return { ok: false, code: 'METERS_TOO_LARGE' };
  return { ok: true, cm };
}

/**
 * Ürünün paket içeriği (yönetici): ikisi de boş → içerik tanımsız; içerik varsa ölçü zorunlu. Adet ölçüsünde tam sayı.
 * @param {{ content: unknown, measure: unknown }} raw
 * @returns {{ ok: true, value: { packContent: string | null, packMeasure: 'M' | 'BUC' | null } } | { ok: false, code: 'PACK' | 'PACK_MEASURE' | 'PACK_INT' }}
 */
export function parsePack({ content, measure }) {
  const c = String(content ?? '').trim();
  const ms = String(measure ?? '').trim().toUpperCase();
  if (!c) return { ok: true, value: { packContent: null, packMeasure: null } };
  if (!MEASURES.includes(ms)) return { ok: false, code: 'PACK_MEASURE' };
  const n = toScaled(c, SCALE.content);
  if (n == null || n <= 0n || n > BigInt(MAX_PACK_CONTENT) * 1000n) return { ok: false, code: 'PACK' };
  if (ms === 'BUC' && n % 1000n !== 0n) return { ok: false, code: 'PACK_INT' };
  return { ok: true, value: { packContent: fromScaled(n, SCALE.content), packMeasure: /** @type {'M' | 'BUC'} */ (ms) } };
}

/**
 * 1 m korkuluk için tüketim (yönetici): boş → tanımsız (hesap yapılmaz); 0'dan büyük, en çok 4 ondalık, en çok MAX_PER_METER.
 * @returns {{ ok: true, value: string | null } | { ok: false }}
 */
export function parsePerMeter(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: null };
  const n = toScaled(s, SCALE.perMeter);
  if (n == null || n <= 0n || n > BigInt(MAX_PER_METER) * 10_000n) return { ok: false };
  return { ok: true, value: fromScaled(n, SCALE.perMeter) };
}

/**
 * Cam kalınlığı (mm, en çok 2 ondalık, THICKNESS_MM aralığında)
 * @returns {{ ok: true, value: string } | { ok: false }}
 */
export function parseThickness(raw) {
  const n = toScaled(String(raw ?? '').trim(), SCALE.mm);
  if (n == null || n < BigInt(THICKNESS_MM.min) * 100n || n > BigInt(THICKNESS_MM.max) * 100n) return { ok: false };
  return { ok: true, value: fromScaled(n, SCALE.mm) };
}

/** Kalem adı: kırpılır, boşluklar teke iner; boş ya da çok uzunsa null */
export function cleanSlot(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s && s.length <= MAX_SLOT ? s : null;
}
/**
 * Kalemin eşleştirme anahtarı: büyük / küçük harf ayrımı yok ve Türkçe noktalı / noktasız I aynı harf sayılır — "Profil",
 * "profil", "PROFIL", "PROFİL", "profıl" aynı kalemdir (yönetici Türkçe ya da Latin klavyeyle yazabilir).
 */
export const slotKey = (v) => (cleanSlot(v) ?? '').normalize('NFC').toLocaleUpperCase('tr-TR').replace(/İ/g, 'I');

// ---------- seçim ----------

/**
 * @typedef {{ id: string, code: string, nameTr: string, nameRo: string, unitCode: string, isActive: boolean,
 *   packContent: unknown, packMeasure: string | null, category?: { isActive?: boolean } | null }} CalcProduct
 * @typedef {{ id: string, slot: string, sortOrder?: number, productId: string | null, product?: CalcProduct | null,
 *   color: string | null, thicknessId: string | null, perMeter: unknown }} CalcItem
 * @typedef {{ id: string, mm: unknown, isActive: boolean }} CalcThickness
 * @typedef {{ code: string, slot?: string, product?: string, color?: string | null, thicknessMm?: string | null, max?: number }} CalcError
 */

/** Satırın koşulu bu seçime uyuyor mu (boş koşul = hepsi) */
export const matches = (item, color, thicknessId) =>
  (item.color == null || item.color === color) && (item.thicknessId == null || item.thicknessId === thicknessId);

/**
 * İki satırın koşulu aynı seçimde birlikte geçerli olabilir mi (aynı kalemde buna izin verilmez — karar 175)
 * @param {{ color: string | null, thicknessId: string | null }} a  @param {{ color: string | null, thicknessId: string | null }} b
 */
export const overlaps = (a, b) =>
  (a.color == null || b.color == null || a.color === b.color) && (a.thicknessId == null || b.thicknessId == null || a.thicknessId === b.thicknessId);

/**
 * Satırları kalemlere ayırır (kalemin sırası: ilk satırının sırası)
 * @param {CalcItem[]} items
 * @returns {{ key: string, label: string, items: CalcItem[] }[]}
 */
export function slotsOf(items) {
  const sorted = [...items].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
  /** @type {Map<string, { key: string, label: string, items: CalcItem[] }>} */
  const map = new Map();
  for (const it of sorted) {
    const key = slotKey(it.slot);
    if (!map.has(key)) map.set(key, { key, label: cleanSlot(it.slot) ?? String(it.slot ?? ''), items: [] });
    map.get(key)?.items.push(it);
  }
  return [...map.values()];
}

const mmText = (t) => (t ? fromScaled(toScaled(t.mm, SCALE.mm) ?? 0n, SCALE.mm) : null);

/**
 * Bir seçim (renk, cam kalınlığı) için her kalemin satırı. Hata varsa satır dönmez (o kalem için).
 * @param {{ key: string, label: string, items: CalcItem[] }[]} slots
 * @param {string | null} color  @param {CalcThickness | null} thickness
 * @returns {{ errors: CalcError[], picks: { slot: string, product: CalcProduct, per: bigint, content: bigint }[] }}
 */
function resolve(slots, color, thickness) {
  /** @type {CalcError[]} */
  const errors = [];
  const picks = [];
  const where = { color, thicknessMm: mmText(thickness) };
  for (const s of slots) {
    const hit = s.items.filter((i) => matches(i, color, thickness?.id ?? null));
    if (hit.length === 0) { errors.push({ code: 'NO_OPTION', slot: s.label, ...where }); continue; }
    if (hit.length > 1) { errors.push({ code: 'AMBIGUOUS', slot: s.label, ...where }); continue; }
    const item = hit[0];
    if (!item.productId) continue; // bu koşulda bu kalem gerekmez (yöneticinin açık kararı)
    const p = item.product;
    if (!p) { errors.push({ code: 'PRODUCT_GONE', slot: s.label }); continue; }
    if (!p.isActive || p.category?.isActive === false) { errors.push({ code: 'PRODUCT_INACTIVE', slot: s.label, product: p.code }); continue; }
    const per = toScaled(item.perMeter, SCALE.perMeter);
    const content = toScaled(p.packContent, SCALE.content);
    const perOk = per != null && per > 0n;
    const packOk = content != null && content > 0n && MEASURES.includes(p.packMeasure ?? '');
    if (!perOk) errors.push({ code: 'NO_PER_METER', slot: s.label, product: p.code });
    if (!packOk) errors.push({ code: 'NO_PACK', product: p.code });
    if (perOk && packOk) picks.push({ slot: s.label, product: p, per: /** @type {bigint} */ (per), content: /** @type {bigint} */ (content) });
  }
  return { errors, picks };
}

/** Aynı hatayı bir kez (ör. iki kalemde kullanılan ürünün eksik paket içeriği) */
function dedupe(errors) {
  const seen = new Set();
  return errors.filter((e) => {
    const k = JSON.stringify([e.code, e.slot ?? null, e.product ?? null, e.color ?? null, e.thicknessMm ?? null]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Sistemin hangi seçimleri gerektirdiği: renk (renk koşullu satır varsa), cam kalınlığı (kalınlık koşullu satır varsa) */
export function systemNeeds(items) {
  return { color: items.some((i) => i.color != null), thickness: items.some((i) => i.thicknessId != null) };
}

/**
 * İhtiyacın gösterimi: metre en çok 2 ondalık (yukarı), adet tam sayı (yukarı)
 * @param {bigint} need6  10⁻⁶ ölçekli ihtiyaç  @param {string} measure
 */
export function needText(need6, measure) {
  const unit = measure === 'BUC' ? 1_000_000n : 10_000n;
  const rounded = ((need6 + unit - 1n) / unit) * unit;
  return fromScaled(rounded, 6);
}

/**
 * Hesap. Başarılıysa her ürün için adet (satış biriminde); değilse yalnızca hatalar (hiçbir miktar).
 * @param {{ id?: string, code?: string, isActive: boolean, items: CalcItem[] } | null} system
 * @param {{ color?: unknown, thicknessId?: unknown, meters: unknown }} input
 * @param {CalcThickness[]} thicknesses  tanımlı cam kalınlıkları (etkin olmayanlar seçilemez)
 * @returns {{ ok: false, errors: CalcError[] } | { ok: true, meters: string, color: string | null, thicknessId: string | null,
 *   lines: { productId: string, code: string, nameTr: string, nameRo: string, unitCode: string, measure: string, need: string,
 *   content: string, qty: number, slots: string[] }[] }}
 */
export function calculate(system, input, thicknesses) {
  const meters = parseMeters(input.meters);
  if (!meters.ok) return { ok: false, errors: [{ code: meters.code, ...(meters.code === 'METERS_TOO_LARGE' ? { max: MAX_CALC_METERS } : {}) }] };
  if (!system || !system.isActive) return { ok: false, errors: [{ code: 'SYSTEM_INACTIVE' }] };
  const items = system.items ?? [];
  if (items.length === 0) return { ok: false, errors: [{ code: 'SYSTEM_EMPTY' }] };
  const needs = systemNeeds(items);
  /** @type {CalcError[]} */
  const errors = [];
  const color = needs.color ? (PROFILE_COLORS.includes(String(input.color ?? '')) ? String(input.color) : null) : null;
  if (needs.color && !color) errors.push({ code: 'COLOR_REQUIRED' });
  const thickness = needs.thickness ? thicknesses.find((t) => t.isActive && t.id === input.thicknessId) ?? null : null;
  if (needs.thickness && !thickness) errors.push({ code: 'THICKNESS_REQUIRED' });
  if (errors.length) return { ok: false, errors };

  const res = resolve(slotsOf(items), color, thickness);
  if (res.errors.length) return { ok: false, errors: dedupe(res.errors) };
  if (res.picks.length === 0) return { ok: false, errors: [{ code: 'NO_PRODUCTS' }] };

  // Aynı ürünün ihtiyaçları toplanır, bir kez yuvarlanır
  /** @type {Map<string, { product: CalcProduct, content: bigint, need: bigint, slots: string[] }>} */
  const byProduct = new Map();
  for (const pk of res.picks) {
    const need = BigInt(meters.cm) * pk.per; // 10⁻² × 10⁻⁴ = 10⁻⁶
    const cur = byProduct.get(pk.product.id);
    if (cur) { cur.need += need; cur.slots.push(pk.slot); } else byProduct.set(pk.product.id, { product: pk.product, content: pk.content, need, slots: [pk.slot] });
  }
  const lines = [];
  for (const { product, content, need, slots } of byProduct.values()) {
    const c6 = content * 1000n; // 10⁻³ → 10⁻⁶
    const qty = (need + c6 - 1n) / c6;
    if (qty > BigInt(MAX_PROFILE_QTY)) { errors.push({ code: 'TOO_MANY', product: product.code, max: MAX_PROFILE_QTY }); continue; }
    lines.push({
      productId: product.id, code: product.code, nameTr: product.nameTr, nameRo: product.nameRo, unitCode: product.unitCode,
      measure: String(product.packMeasure), need: needText(need, String(product.packMeasure)), content: fromScaled(content, SCALE.content),
      qty: Number(qty), slots,
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, meters: fromScaled(BigInt(meters.cm), SCALE.meters), color, thicknessId: thickness?.id ?? null, lines };
}

/**
 * Yöneticinin "eksikler" listesi: sistemin her geçerli seçimi (iki renk × etkin cam kalınlıkları — sistem gerektiriyorsa)
 * için hesap yapılamayan noktalar. Boş liste = sistem her seçimde hesaplanabilir.
 * @param {{ items: CalcItem[] }} system  @param {CalcThickness[]} thicknesses
 * @returns {CalcError[]}
 */
export function systemProblems(system, thicknesses) {
  const items = system.items ?? [];
  if (items.length === 0) return [{ code: 'SYSTEM_EMPTY' }];
  const needs = systemNeeds(items);
  const active = thicknesses.filter((t) => t.isActive);
  /** @type {CalcError[]} */
  const out = [];
  if (needs.thickness && active.length === 0) out.push({ code: 'NO_THICKNESS' });
  const colors = needs.color ? [...PROFILE_COLORS] : [null];
  const ths = needs.thickness ? active : [null];
  const slots = slotsOf(items);
  for (const c of colors) for (const t of ths) out.push(...resolve(slots, c, t).errors);
  return dedupe(out);
}

/**
 * Hesap sonucunun forma aktarımı (müşteri formu — karar 175): yalnızca sonuçtaki ürünlerin adedi değişir, formdaki öbür
 * ürünlere dokunulmaz. Adedi boş / 0 olmayan ve yeni değerden farklı ürünler "üzerine yazılacak" diye ÖNCE listelenir.
 * @param {Record<string, string>} current  formdaki adetler (ürün id → metin)
 * @param {{ productId: string, qty: number }[]} lines
 * @returns {{ next: Record<string, string>, overwrites: { productId: string, from: string, to: string }[] }}
 */
export function applyCalc(current, lines) {
  const next = { ...current };
  const overwrites = [];
  for (const l of lines) {
    const to = String(l.qty);
    const from = String(current[l.productId] ?? '').trim();
    if (from !== '' && !/^0+$/.test(from) && from !== to) overwrites.push({ productId: l.productId, from, to });
    next[l.productId] = to;
  }
  return { next, overwrites };
}
