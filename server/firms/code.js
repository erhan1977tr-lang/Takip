// Firma kodu: tam 3 büyük harf (A–Z). Sipariş numarası = kod + sıra (GLA68). Veritabanında da CHECK ile zorunlu.

const TR = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U', ă: 'a', â: 'a', î: 'i', ș: 's', ț: 't', Ă: 'A', Â: 'A', Î: 'I', Ș: 'S', Ț: 'T' };

/** Girilen metni koda çevirir: Türkçe/Romence harfler sadeleşir, harf olmayanlar atılır, en fazla 3 harf. */
export function cleanFirmCode(v) {
  return String(v || '')
    .replace(/[çğıöşüÇĞİÖŞÜăâîșțĂÂÎȘȚ]/g, (c) => TR[c])
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
}

export function isFirmCode(v) {
  return /^[A-Z]{3}$/.test(String(v || ''));
}

/**
 * Firma adından kod önerir (ilk 3 harf; ad kısaysa X ile tamamlanır). `taken` içindeyse
 * üçüncü, sonra ikinci harf A–Z denenir (veritabanı migration'ıyla aynı kural).
 * @param {string} name
 * @param {Iterable<string>} [taken]
 */
export function suggestFirmCode(name, taken = []) {
  const used = new Set(taken);
  const base = cleanFirmCode(name).padEnd(3, 'X');
  if (!used.has(base)) return base;
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const c of L) if (!used.has(base.slice(0, 2) + c)) return base.slice(0, 2) + c;
  for (const b of L) for (const c of L) if (!used.has(base[0] + b + c)) return base[0] + b + c;
  return null;
}
