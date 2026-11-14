// INTRAREA MARFĂ formu (4.2.20, karar 320) — ürün sahibinin Excel şablonu (Intrare_Depozit.xlsx) kural olarak burada.
// Amaç: depoya giren ürünlerin ağırlığını otomatik hesaplayıp depoya bildirmek. Şablonun satırları (sıra, Romence metin,
// renk, görsel) ve ağırlık katsayıları (kg / birim — Excel'deki formüller: GREUTATE = katsayı × adet) birebir buradadır;
// katsayılar UYDURULMAZ ve katalogdan okunmaz. Kapaklarda (CAPACE) ağırlık hesabı yoktur (ürün sahibi, 14.11.2026).
// Şablonda olmayan bir ürün teslim alınırsa "ALTE PRODUSE" bölümünde ağırlıksız yazılır (veri kaybolmaz, ağırlık tahmin edilmez).
// Hesap tam sayıyla (gram = katsayının binde biri): kayan nokta yok. Bağımlılığı yok (saf).

/** Bölümler: başlık, miktar sütununun birimi, ağırlık sütununun başlığı (Excel'deki gibi) */
export const IM_SECTIONS = Object.freeze([
  { key: 'GARNITURI', unit: 'CUTII', weight: 'GREUTATEA (KILO)' },
  { key: 'PLASTICE', unit: 'PUNGI', weight: 'GREUTATEA' },
  { key: 'PROFILE ALUMINIU', unit: 'BARA', weight: 'GREUTATEA' },
  { key: 'ACCESORII', unit: 'BUCATI', weight: 'GREUTATEA' },
]);

/** Satır renkleri (Excel'deki dolgu): somon, sarı, mavi */
export const IM_FILLS = Object.freeze({ salmon: [1, 0.5, 0.5], yellow: [1, 1, 0], cyan: [0, 0.8, 1] });

const row = (section, code, label, kg, image, span = 1, fill = null, tall = false) => Object.freeze({ section, code, label, kg, image, span, fill, tall });

/**
 * Şablon satırları (Excel sırası). kg: kg / birim (metin; null = ağırlık hesabı yok). image: görsel anahtarı
 * (server/pdf/intrare-marfa-images.js); span: görsel kaç satırı kaplar (Excel'deki birleştirilmiş hücre); image null + span:
 * önceki görselin devamı.
 */
export const IM_ROWS = Object.freeze([
  row('GARNITURI', 'GK15', 'GARNITURA EPDM - GK15', '10', 'gk15'),
  row('GARNITURI', 'AD45', 'GARNITURA EPDM - AD45', '10', 'ad45'),
  row('GARNITURI', 'MC12', 'GARNITURA PT MANA CURENTA - MC12', '10', 'mc12'),
  row('GARNITURI', 'MC16', 'GARNITURA PT MANA CURENTA - MC16', '10', 'mc16'),
  row('PLASTICE', 'PANA-115-12', 'PANA-115-12', '0.73', 'pana', 1, 'salmon'),
  row('PLASTICE', 'PANA-115-16', 'PANA-115-16', '0.55', 'pana', 1, 'salmon'),
  row('PLASTICE', 'PANA-90-12', 'PANA-90-12', '0.6', 'pana', 1, 'salmon'),
  row('PLASTICE', 'PANA-90-16', 'PANA-90-16', '0.44', 'pana', 1, 'salmon'),
  row('PLASTICE', 'PANA-L115', 'PANA-L115', '0.81', 'pana-l', 1, 'salmon'),
  row('PLASTICE', 'PANA-L90', 'PANA-L90', '0.64', 'pana-l', 1, 'salmon'),
  row('PROFILE ALUMINIU', 'MR23-7016', 'MR23 - 7016 (CEL MAI LAT, CU GARNITURA)', '2.1', 'mr23', 2, 'yellow'),
  row('PROFILE ALUMINIU', 'MR23-ELX', 'MR23 - ELX (CEL MAI LAT, CU GARNITURA)', '2.1', null, 0, 'yellow'),
  row('PROFILE ALUMINIU', 'RM16-7016', 'RM16 - 7016 (MEDIE, FARA GARNITURA)', '1.5', 'rm16', 2, 'yellow'),
  row('PROFILE ALUMINIU', 'RM16-ELX', 'RM16 - ELX (MEDIE, FARA GARNITURA)', '1.5', null, 0, 'yellow'),
  row('PROFILE ALUMINIU', 'RM12-7016', 'RM12 - 7016 (CEL MAI INGUST, FARA GARNITURA)', '1.2', 'rm12', 2, 'yellow'),
  row('PROFILE ALUMINIU', 'RM12-ELX', 'RM12 - ELX (CEL MAI INGUST, FARA GARNITURA)', '1.2', null, 0, 'yellow'),
  row('PROFILE ALUMINIU', 'FBL115-7016', 'FBL115 - 7016', '25', 'fbl', 4, 'cyan'),
  row('PROFILE ALUMINIU', 'FBL115-ELX', 'FBL115 - ELX', '25', null, 0, 'cyan'),
  row('PROFILE ALUMINIU', 'FBL90-7016', 'FBL90 - 7016', '22', null, 0, 'cyan'),
  row('PROFILE ALUMINIU', 'FBL90-ELX', 'FBL90 - ELX', '22', null, 0, 'cyan'),
  row('ACCESORII', 'FLANSA-PERETE-ELX', 'Flansa Perete - ELX', '0.05', 'flansa', 2),
  row('ACCESORII', 'FLANSA-PERETE-7016', 'Flansa Perete - 7016', '0.05', null, 0),
  row('ACCESORII', 'SPIGOTI', 'SPIGOTI', '0.68', 'spigoti', 1, null, true),
  row('ACCESORII', 'COLT-90-12', 'Colt 90-12 (MAI GROS)', '0.037', 'colt', 2),
  row('ACCESORII', 'COLT-90-16', 'Colt 90-16 (MAI SUBTIRE)', '0.026', null, 0),
  row('ACCESORII', 'CAPACE-PROFILE-7016', 'CAPACE PROFILE - 7016', null, null, 2),
  row('ACCESORII', 'CAPACE-PROFILE-ELX', 'CAPACE PROFILE - ELX', null, null, 0),
]);

/** "2.1" → 2100 (gram / birim) */
export function gramsOf(kg) {
  const m = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(String(kg ?? ''));
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0') || '0');
}

/** gram → "4825" / "3,65" / "0,185" (Excel gibi: binlik ayırıcı yok, ondalık virgül, sondaki sıfırlar atılır) */
export function fmtKg(g) {
  const neg = g < 0;
  const a = Math.abs(g);
  const int = Math.floor(a / 1000);
  const frac = String(a % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `,${frac}` : ''}`;
}

/** Adet alanı: boş → null; 0 … 99 999 tam sayı; geçersiz → undefined */
export function parseCount(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^\d{1,5}$/.test(s)) return undefined;
  return Number(s);
}

/**
 * Formun verisi: kabul satırlarının (ürün kodu → adet; aynı kod birden çok satırda ise toplanır) şablona yerleşimi.
 * @param {{ code: string, name?: string, qty: number, unit?: string }[]} lines
 * @returns {{ sections: { key: string, unit: string, weight: string, rows: { code: string, label: string, qty: number | null, grams: number | null, hasWeight: boolean, image: string | null, span: number, fill: string | null, tall: boolean }[] }[],
 *   others: { code: string, name: string, qty: number, unit: string }[], totalGrams: number }}
 */
export function intrareMarfaData(lines) {
  const by = new Map();
  for (const l of lines) {
    const k = String(l.code ?? '').trim().toUpperCase();
    if (!k) continue;
    const e = by.get(k) ?? { code: String(l.code), name: String(l.name ?? l.code), qty: 0, unit: String(l.unit ?? '') };
    e.qty += Math.max(0, Math.trunc(Number(l.qty) || 0));
    by.set(k, e);
  }
  const known = new Set(IM_ROWS.map((r) => r.code));
  let totalGrams = 0;
  const sections = IM_SECTIONS.map((s) => ({
    ...s,
    rows: IM_ROWS.filter((r) => r.section === s.key).map((r) => {
      const got = by.get(r.code);
      const qty = got && got.qty > 0 ? got.qty : null;
      const per = r.kg == null ? null : gramsOf(r.kg);
      const grams = per == null ? null : per * (qty ?? 0);
      if (grams) totalGrams += grams;
      return { code: r.code, label: r.label, qty, grams, hasWeight: per != null, image: r.image, span: r.span, fill: r.fill, tall: r.tall };
    }),
  }));
  const others = [...by.values()].filter((e) => !known.has(e.code.toUpperCase()) && e.qty > 0);
  return { sections, others, totalGrams };
}

/**
 * Düzeltmenin (REV.n) değişiklik listesi: ürün başına önceki → yeni adet (yalnızca değişenler).
 * @param {{ code: string, qty: number }[]} before  @param {{ code: string, qty: number }[]} after
 */
export function imChanges(before, after) {
  const sum = (ls) => { const m = new Map(); for (const l of ls) m.set(l.code, (m.get(l.code) ?? 0) + l.qty); return m; };
  const a = sum(before), b = sum(after);
  return [...a.keys()].filter((k) => (b.get(k) ?? 0) !== a.get(k)).map((code) => ({ code, from: a.get(code) ?? 0, to: b.get(code) ?? 0 }));
}

/** Belge no (dosya adı ve başlık): "<sipariş no>-<kabul no>" + düzeltmede " REV.<n>" */
export const imDocNo = (orderNo, seq, rev = 0) => `${orderNo}-${seq}${rev ? ` REV.${rev}` : ''}`;
