// Müşteri fiyatı değişikliklerinin kaydı (fonksiyonel paket 4) — yöneticinin teklifte müşteri fiyatını değiştirmesi
// (fiyat onayında taslak kaydı / "onayla ve gönder" / satışa geri gönderme, ya da müşterideki teklifin yeni sürümü).
// Kayıt değişmez denetim kaydıdır (AuditLog OFFER_PRICE_CHANGED): kim, ne zaman, hangi sipariş ve teklif sürümü,
// satır satır eski → yeni müşteri fiyatı. Tutar sipariş geçmişinin notuna yazılmaz (geçmişi satış da görür — AUD-1);
// yöneticinin "Hareketler" listesi bu kayıttan okunur (yalnızca yönetici).
// Saf işlev: veritabanı ve dil yok. Sunucu her kayıtta önceki ve yeni satırlarla çağırır.

const MAX_CHANGES = 50;
const num = (v) => (v == null || v === '' ? null : Number(v));
const money = (v) => {
  const n = num(v);
  return n == null || !Number.isFinite(n) ? null : n.toFixed(2);
};
/** Satırın müşteri fiyatı (bedelsiz satırda "FREE"; fiyatı girilmemiş satırda null) */
const priceOf = (l) => (l.free ? 'FREE' : money(l.offerPrice));
const isSub = (l) => l.kind === 'CNC' || l.kind === 'DELIK';
const int = (v) => (v == null || v === '' ? null : Math.trunc(Number(v)) || null);

/**
 * @typedef {{ no: number, change: 'PRICE' | 'ADDED' | 'REMOVED', description: string, kind: string, unit: string,
 *   enMm: number | null, boyMm: number | null, crateFee: boolean, old: string | null, new: string | null }} PriceChange
 */

/**
 * Önceki satırlar → yeni satırlar: müşteri fiyatı değişen, fiyatlı olarak eklenen ya da kaldırılan satırlar.
 * Eşleme satır kimliğiyle (yeni satırın kimliği yoktur ya da önceki satırlarda yoktur). İşlem eklemek için ayrılan tek cam
 * (from: kaynağın kimliği) kaynağının fiyatını taşıyorsa değişiklik sayılmaz — ayırma fiyat değişikliği değildir (karar 113).
 * Ölçü / adet değişikliği fiyat değişikliği değildir (toplam ayrıca kaydedilir).
 * @param {{ id?: string | null, from?: string | null, description?: string, kind?: string, unit?: string, enMm?: unknown, boyMm?: unknown, offerPrice?: unknown, free?: boolean, crateFee?: boolean }[]} before
 * @param {typeof before} after
 * @returns {{ changes: PriceChange[], more: number }}
 */
export function priceChanges(before, after) {
  const prev = new Map((before ?? []).filter((l) => l.id).map((l) => [l.id, l]));
  const seen = new Set();
  /** @type {PriceChange[]} */
  const all = [];
  const row = (l, no, change, oldP, newP) => ({
    no, change, description: String(l.description ?? '').slice(0, 120), kind: l.kind ?? 'CAM', unit: l.unit ?? (isSub(l) ? 'adet' : 'm2'),
    enMm: isSub(l) ? null : int(l.enMm), boyMm: isSub(l) ? null : int(l.boyMm), crateFee: !!l.crateFee, old: oldP, new: newP,
  });
  for (const [i, l] of (after ?? []).entries()) {
    const own = l.id ? prev.get(l.id) : undefined;
    if (own) {
      seen.add(own.id);
      const a = priceOf(own), b = priceOf(l);
      if (a !== b) all.push(row(l, i + 1, 'PRICE', a, b));
      continue;
    }
    const src = l.from ? prev.get(l.from) : undefined;
    const p = priceOf(l);
    if (src && priceOf(src) === p) continue; // ayrılan tek cam: kaynağının fiyatı
    if (p != null) all.push(row(l, i + 1, 'ADDED', src ? priceOf(src) : null, p));
  }
  for (const [i, l] of (before ?? []).entries()) {
    if (l.id && seen.has(l.id)) continue;
    const p = priceOf(l);
    if (p != null) all.push(row(l, i + 1, 'REMOVED', p, null));
  }
  return { changes: all.slice(0, MAX_CHANGES), more: Math.max(0, all.length - MAX_CHANGES) };
}
