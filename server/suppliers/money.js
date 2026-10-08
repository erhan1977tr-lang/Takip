// Tedarikçi siparişinin para hesabı (Paket 6, karar 181) — TEK uygulama. Bağımlılığı yok: sunucu (server/suppliers/rules.js
// yeniden dışa verir, servis ve e-posta) ve tarayıcıdaki sipariş düzenleyicisi (canlı toplam) aynı kodu kullanır; ekrandaki
// ara toplam ile kaydedilen / e-postaya giden toplam aynı kuralla hesaplanır. Kayan nokta yok: tutarlar metin ("12.5000"),
// BigInt ile tam hesaplanır; satır tutarı bir kez, yarım-yukarı (half-up) 2 ondalığa yuvarlanır; sipariş toplamı yuvarlanmış
// satır tutarlarının toplamıdır. Para birimleri burada hiç karışmaz (tek siparişin tek para birimi vardır).

/** Alış birim fiyatı üst sınırı: 0 … 1.000.000, en çok 4 ondalık */
export const PRICE_MAX = 1_000_000;

/** "12,5" / "12.5000" → ölçekli tam sayı (scale 4: 125000n); en çok `scale` ondalık (fazlası yalnızca sıfırsa kabul), eksi yok; geçersiz → null */
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

/** Ölçekli tam sayı → "12.5" (sondaki sıfırlar atılır; en az `minFrac` ondalık) */
export function fromScaled(n, scale, minFrac = 0) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(scale);
  const int = (a / base).toString();
  let frac = scale ? (a % base).toString().padStart(scale, '0').replace(/0+$/, '') : '';
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/**
 * Alış birim fiyatı: boş → null (fiyat yok — uydurulmaz); 0 … PRICE_MAX, en çok 4 ondalık. Geçersizse { ok: false }.
 * @returns {{ ok: true, value: string | null } | { ok: false }}
 */
export function parsePrice(raw) {
  const s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return { ok: true, value: null };
  // "1.234,56" biçimi (binlik nokta + ondalık virgül) da kabul edilir
  const norm = /^\d{1,3}(\.\d{3})+,\d+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = toScaled(norm, 4);
  if (n == null || n > BigInt(PRICE_MAX) * 10_000n) return { ok: false };
  return { ok: true, value: fromScaled(n, 4) };
}

/**
 * Satır tutarı = miktar × birim fiyat, bir kez yarım-yukarı 2 ondalığa yuvarlanır. Fiyat yoksa null.
 * @param {number} qty  @param {string | number | { toString(): string } | null | undefined} price
 * @returns {string | null}  "123.46"
 */
export function lineTotal(qty, price) {
  if (price == null || price === '') return null;
  const p = toScaled(String(price), 4);
  if (p == null || !Number.isInteger(qty) || qty < 0) return null;
  const raw = BigInt(qty) * p; // 10⁻⁴
  const cents = (raw + 50n) / 100n; // yarım-yukarı (değerler eksi değil)
  return fromScaled(cents, 2, 2);
}

/** Tutar metni → kuruş (BigInt); geçersiz → 0n */
export const cents = (v) => toScaled(String(v ?? '0'), 2) ?? 0n;
/** Kuruş → "123.45" */
export const money = (c) => fromScaled(c, 2, 2);

/**
 * Sipariş toplamı (satır tutarlarının toplamı) ve fiyatı eksik satırlar. Fiyatı olmayan satır toplama girmez ve
 * missingPrice işaretlenir — eksik tutar UYDURULMAZ.
 * @param {{ qty: number, unitPrice?: unknown }[]} lines
 * @returns {{ total: string, missingPrice: boolean, priced: number, count: number }}
 */
export function orderTotals(lines) {
  let sum = 0n;
  let priced = 0;
  for (const l of lines) {
    const t = lineTotal(l.qty, l.unitPrice == null ? null : String(l.unitPrice));
    if (t == null) continue;
    sum += cents(t);
    priced++;
  }
  return { total: money(sum), missingPrice: priced < lines.length, priced, count: lines.length };
}
