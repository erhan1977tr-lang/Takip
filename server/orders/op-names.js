// CNC / delik işlem adlarının Romence karşılığı (ürün sahibi, 14.11.2026; karar 315).
//
//   İşlem satırının (kind CNC | DELIK) açıklaması serbest metindir: fabrika PDF'inden (GlassWorld) aktarılır ya da satış /
//   yönetici yazar — Türkçedir ("Kose Yuvarlama", "CNC KÜÇÜK DELİK"). Cam satırının Romence adı kayıtlıdır (descriptionRo,
//   katalogdan); işlem satırının yoktur, bu yüzden Romence ekranda (müşteri paneli, teklif PDF / Excel, Tekliflerim, yükleme
//   dökümleri) Türkçe görünüyordu.
//
//   Kural — yalnızca GÖSTERİM: kayıtlı açıklama değişmez (veritabanına yazılmaz, düzenleyiciye / faturaya / fabrikaya giden
//   metin aynen kalır). Romence ekranda işlem satırının açıklaması bu sözlükle çevrilir. Eşleştirme büyük / küçük harf ve
//   Türkçe karakterden bağımsızdır (Kose = KÖŞE, Delik = DELİK). Açıklamadaki HER kelime sözlükte (ya da sayı / ölçü /
//   "CNC" gibi ortak bir sözcük) olmalıdır; tanınmayan tek bir kelime varsa yarım çeviri yapılmaz, özgün metin gösterilir.
//   Yeni bir işlem adı Türkçe kalırsa yalnızca bu sözlüğe eklenir (test/op-names.test.js).

/** Türkçe karakterleri katlar, büyük harfe çevirir: "Köşe" → "KOSE", "delik" → "DELIK" */
export function foldTr(s) {
  const MAP = { Ç: 'C', Ğ: 'G', İ: 'I', I: 'I', Ö: 'O', Ş: 'S', Ü: 'U', Â: 'A', Î: 'I', Û: 'U' };
  return String(s ?? '').normalize('NFC').toLocaleUpperCase('tr').replace(/[ÇĞİÖŞÜÂÎÛ]/g, (c) => MAP[c] ?? c);
}

/**
 * Sözlük: katlanmış Türkçe kelime dizisi → Romence. Önce en uzun eşleşme denenir (en çok 3 kelime).
 * Romence yazım cümle düzenindedir (ilk harf büyük).
 */
const PHRASES = Object.freeze({
  // köşe
  'KOSE YUVARLAMA': 'Rotunjire colțuri',
  'KOSE YUVARLATMA': 'Rotunjire colțuri',
  'KOSE YUVARLAK': 'Colțuri rotunjite',
  'KOSE KESIM': 'Tăiere colț',
  'KOSE KESME': 'Tăiere colț',
  'KOSE KIRMA': 'Tăiere colț',
  'KOSE PAH': 'Teșire colț',
  'KOSE PAHI': 'Teșire colț',
  YUVARLAMA: 'Rotunjire',
  KOSE: 'Colț',
  // delik
  'KUCUK DELIK': 'Gaură mică',
  'BUYUK DELIK': 'Gaură mare',
  'ORTA DELIK': 'Gaură medie',
  'HAVSALI DELIK': 'Gaură zencuită',
  'KULP DELIGI': 'Gaură mâner',
  'MENTESE DELIGI': 'Gaură balama',
  'PRIZ DELIGI': 'Decupaj priză',
  DELIK: 'Gaură',
  DELIGI: 'Gaură',
  DELIKLER: 'Găuri',
  DELIKLI: 'Cu găuri',
  HAVSA: 'Zencuire',
  // oyuk / yer açma
  'KUCUK OYUK': 'Decupaj mic',
  'BUYUK OYUK': 'Decupaj mare',
  'PRIZ OYUGU': 'Decupaj priză',
  'PRIZ YERI': 'Decupaj priză',
  'KULP YERI': 'Decupaj mâner',
  'MENTESE YERI': 'Decupaj balama',
  'KILIT YERI': 'Decupaj yală',
  OYUK: 'Decupaj',
  OYUGU: 'Decupaj',
  // işlem / kenar / kesim
  'CNC ISLEMI': 'Prelucrare CNC',
  'CNC ISLEM': 'Prelucrare CNC',
  'CNC ISLEME': 'Prelucrare CNC',
  'KENAR ISLEME': 'Prelucrare margini',
  'KENAR ISLEMI': 'Prelucrare margini',
  ISLEM: 'Prelucrare',
  ISLEMI: 'Prelucrare',
  'PAH KIRMA': 'Teșire',
  PAH: 'Teșire',
  RODAJ: 'Șlefuire margini',
  ZIMPARA: 'Șlefuire',
  FAZETA: 'Fațetare',
  FATURA: 'Falț',
  'SEKILLI KESIM': 'Tăiere în formă',
  'OZEL KESIM': 'Tăiere specială',
  'DUZ KESIM': 'Tăiere dreaptă',
  KESIM: 'Tăiere',
  ADET: 'buc.',
});
const MAX_WORDS = 3;

/** Çevrilmeden aynen geçen kelimeler (ortak kısaltmalar, ölçü birimleri) */
const PASS = new Set(['CNC', 'MM', 'CM', 'X', 'Ø', 'R']);

/**
 * İşlem satırı açıklamasının Romence karşılığı; çevrilemezse null (çağıran özgün metni gösterir).
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function opNameRo(text) {
  const src = String(text ?? '').normalize('NFC').trim();
  if (!src) return null;
  /** @type {{ text: string, word: boolean, gap: string }[]} */
  const tokens = [];
  const re = /(\s*)(\p{L}+|\d+(?:[.,]\d+)?|[^\s\p{L}\d]+)/gu;
  for (const m of src.matchAll(re)) tokens.push({ text: m[2], word: /^\p{L}+$/u.test(m[2]), gap: m[1] });
  /** @type {{ text: string, gap: string, kind: 'phrase' | 'cnc' | 'other' }[]} */
  const out = [];
  let translated = false;
  for (let i = 0; i < tokens.length;) {
    const tk = tokens[i];
    if (!tk.word) { out.push({ text: tk.text, gap: tk.gap, kind: 'other' }); i += 1; continue; }
    let hit = null;
    for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1 && !hit; n -= 1) {
      const span = tokens.slice(i, i + n);
      if (!span.every((x, k) => x.word && (k === 0 || /^\s+$/.test(x.gap)))) continue;
      const key = span.map((x) => foldTr(x.text)).join(' ');
      if (Object.hasOwn(PHRASES, key)) hit = { ro: PHRASES[key], n };
    }
    if (hit) {
      // "2 delik" → "2 găuri" (Romencede 2 ve üstü sayıdan sonra çoğul)
      const prev = out.at(-1);
      const plural = hit.ro === 'Gaură' && prev && /^\d+$/.test(prev.text) && Number(prev.text) >= 2;
      out.push({ text: plural ? 'Găuri' : hit.ro, gap: tk.gap, kind: 'phrase' });
      translated = true;
      i += hit.n;
      continue;
    }
    const f = foldTr(tk.text);
    if (!PASS.has(f)) return null; // tanınmayan kelime: yarım çeviri yok
    out.push({ text: f === 'Ø' ? tk.text : f, gap: tk.gap, kind: f === 'CNC' ? 'cnc' : 'other' });
    i += 1;
  }
  if (!translated) return null;
  // Romence sıra: "CNC KÜÇÜK DELİK" → "Gaură mică CNC" (sıfat / nitelik isimden sonra)
  if (out.length >= 2 && out[0].kind === 'cnc' && out[1].kind === 'phrase') {
    const [cnc, phrase] = out;
    out.splice(0, 2, { ...phrase, gap: '' }, { ...cnc, gap: ' ' });
  }
  return out.map((x, k) => {
    // Cümlenin ortasındaki sözlük karşılığı küçük harfle başlar ("2 gaură"); kısaltmalar olduğu gibi
    const text = x.kind === 'phrase' && k > 0 ? x.text.charAt(0).toLocaleLowerCase('ro') + x.text.slice(1) : x.text;
    return `${k === 0 ? '' : x.gap}${text}`;
  }).join('');
}

/**
 * Teklif satırının ekranda / belgede gösterilen adı. Romence ekranda: cam satırı → kayıtlı Romence ad (descriptionRo, eskisi
 * gibi); CNC / delik satırı → kayıtlı Romence ad yoksa sözlük çevirisi; çevrilemezse özgün açıklama. Türkçe ekranda daima
 * özgün açıklama.
 * @param {{ description?: string | null, descriptionRo?: string | null, kind?: string | null }} l
 * @param {string} locale
 * @returns {string}
 */
export function lineDisplayName(l, locale) {
  const raw = l.description ?? '';
  if (locale !== 'ro') return raw;
  if (l.descriptionRo) return l.descriptionRo;
  if (l.kind === 'CNC' || l.kind === 'DELIK') return opNameRo(raw) ?? raw;
  return raw;
}
