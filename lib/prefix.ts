const TR: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };

/** Sipariş no ön eki: yalnızca A–Z ve 0–9, en fazla 5 karakter. */
export function cleanPrefix(v: string): string {
  return (v || '')
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => TR[c])
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5);
}

export function suggestPrefix(name: string): string {
  return cleanPrefix(name).slice(0, 3);
}
