// Fabrika PDF'i aktarımı (karar 255): fabrika cam adından TAKİP cam cinsi — kalınlık / PVB kodu + renk ve kaplama.
// Saf modül (veritabanı yok). Katalog ve fiyat listeleri DEĞİŞMEZ; katalogda olmayan cam oluşturulmaz.
//
//   Kod  : "6 mm … +1.14 Şeffaf+6 mm …" → 6.3.6 (ortadaki sayı PVB kat sayısı = PVB kalınlığı ÷ 0,38 mm). 0,38'in tam katı
//          olmayan PVB yuvarlanmaz (kod üretilmez → elle seçim). Tek kat cam: "10 mm Temperli Düz Cam" → 10.
//   Renk : her katın renk / kaplama sınıfları (Düz → şeffaf, Ultra Clear, Bronz, Füme, Reflekte, Tentesol …) + şeffaf olmayan
//          PVB. "ŞEKİLLİ", "DELİKLİ" şekil bilgisidir; "ŞEKİLLİ + CNC …" kuyruğu cam cinsini etkilemez ve işlem satırı
//          üretmez (CNC maliyeti yalnızca gerçek işlem satırlarından gelir — plan.js).
//   Eşleşme: kod ve renk sınıfları birebir aynı olan TEK katalog camı → otomatik; birden çok ya da hiç → elle seçim.
//          Tanınmayan bir renk / kaplama sözcüğü varsa otomatik eşleşme yapılmaz.

/** Büyük harf, Türkçe / Romence harfler ASCII'ye */
export function fold(s) {
  return String(s ?? '').toLocaleUpperCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G').replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
    .replace(/Ș|Ş/g, 'S').replace(/Ț|Ţ/g, 'T').replace(/Ă|Â/g, 'A').replace(/Î/g, 'I');
}

// Renk / kaplama sınıfları. Çok sözcüklüler önce (ULTRA CLEAR, EXTRA CLAR …).
const PHRASES = [
  ['ULTRA CLEAR', 'ULTRA_CLEAR'], ['ULTRACLEAR', 'ULTRA_CLEAR'], ['EXTRA CLEAR', 'ULTRA_CLEAR'], ['EXTRACLEAR', 'ULTRA_CLEAR'],
  ['EXTRA CLAR', 'ULTRA_CLEAR'], ['EXTRACLAR', 'ULTRA_CLEAR'], ['ULTRA CLAR', 'ULTRA_CLEAR'], ['ULTRACLAR', 'ULTRA_CLEAR'],
  ['OPTIWHITE', 'ULTRA_CLEAR'], ['LOW IRON', 'ULTRA_CLEAR'],
];
const WORDS = new Map([
  ['DUZ', 'CLEAR'], ['SEFFAF', 'CLEAR'], ['TRANSPARENT', 'CLEAR'], ['TRANSPARENTA', 'CLEAR'], ['CLAR', 'CLEAR'], ['CLARA', 'CLEAR'], ['CLEAR', 'CLEAR'], ['INCOLOR', 'CLEAR'], ['INCOLORA', 'CLEAR'],
  ['FUME', 'GREY'], ['GRI', 'GREY'], ['GREY', 'GREY'], ['GRAY', 'GREY'],
  ['BRONZ', 'BRONZE'], ['BRONZE', 'BRONZE'],
  ['REFLEKTE', 'REFLECTIVE'], ['REFLECTIV', 'REFLECTIVE'], ['REFLECTIVA', 'REFLECTIVE'], ['REFLECTIVE', 'REFLECTIVE'], ['TENTESOL', 'REFLECTIVE'],
  ['YESIL', 'GREEN'], ['VERDE', 'GREEN'], ['GREEN', 'GREEN'],
  ['MAVI', 'BLUE'], ['ALBASTRU', 'BLUE'], ['ALBASTRA', 'BLUE'], ['BLUE', 'BLUE'],
]);
/** PVB (ara katman) sözcükleri: şeffaf olmayan PVB ayrı bir sınıftır */
const PVB_WORDS = new Map([
  ['SEFFAF', null], ['TRANSPARENT', null], ['CLEAR', null], ['CLAR', null],
  ['OPAK', 'PVB_OPAQUE'], ['OPAQUE', 'PVB_OPAQUE'], ['OPAC', 'PVB_OPAQUE'], ['MAT', 'PVB_OPAQUE'], ['SATEN', 'PVB_OPAQUE'], ['BEYAZ', 'PVB_OPAQUE'], ['ALB', 'PVB_OPAQUE'],
]);
/** Cam katında renk sayılmayan, bilinen sözcükler */
const NEUTRAL = new Set(['CAM', 'DR', 'MM', 'TEMPERLI', 'TEMPER', 'TEMPERE', 'SECURIZAT', 'SECURIZATA', 'FLOAT']);
const SHAPE = new Set(['SEKILLI', 'DELIKLI']);

/** Bir katın metninden renk sınıfları ve tanınmayan sözcükler */
function plyFeatures(text) {
  let t = ` ${fold(text).replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const colours = new Set();
  for (const [p, c] of PHRASES) if (t.includes(` ${p} `)) { colours.add(c); t = t.replace(` ${p} `, ' '); }
  const unknown = [];
  let tempered = false;
  for (const w of t.trim().split(' ').filter(Boolean)) {
    if (/^\d+$/.test(w)) continue;
    if (w === 'TEMPERLI' || w === 'TEMPER' || w === 'SECURIZAT' || w === 'SECURIZATA') tempered = true;
    if (WORDS.has(w)) colours.add(/** @type {string} */ (WORDS.get(w)));
    else if (!NEUTRAL.has(w) && !SHAPE.has(w)) unknown.push(w);
  }
  return { colours, unknown, tempered };
}

const mmOf = (s) => {
  const m = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null; // yüzde bir mm
};
const mmText = (h) => (h % 100 === 0 ? String(h / 100) : String(h / 100).replace('.', ','));

/**
 * Fabrika cam adının imzası.
 * @param {string} description
 * @returns {{ ok: boolean, code: string | null, colours: string[], unknown: string[], tempered: boolean, shaped: boolean, drilled: boolean, pvb: { mm: string, layers: number | null } | null, problem?: string }}
 */
export function factoryGlassSignature(description) {
  const raw = String(description ?? '').replace(/\s+\.\s*$/, '').trim();
  const f = fold(raw);
  const shaped = /\bSEKILLI\b/.test(f);
  const drilled = /\bDELIKLI\b/.test(f);
  // "ŞEKİLLİ + CNC OYUK" gibi boşluklu "+" kuyruğu cam cinsine ait değildir (işlem satırı da üretmez)
  const body = raw.replace(/\s\+\s.*$/u, '').trim();
  const lam = /^(\d{1,2}(?:[.,]\d{1,2})?)\s*mm\s+(.+?)\+\s*(\d{1,2}[.,]\d{1,2})\s*([^+]*?)\+\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*mm\s+(.+)$/iu.exec(body);
  const base = { colours: [], unknown: [], tempered: false, shaped, drilled, pvb: null };
  if (lam) {
    const t1 = mmOf(lam[1]); const pvbMm = mmOf(lam[3]); const t2 = mmOf(lam[5]);
    const p1 = plyFeatures(lam[2]); const p2 = plyFeatures(lam[6]);
    const pv = fold(lam[4]).replace(/[^A-Z ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const colours = new Set([...p1.colours, ...p2.colours]);
    const unknown = [...p1.unknown, ...p2.unknown];
    for (const w of pv) {
      if (PVB_WORDS.has(w)) { const c = PVB_WORDS.get(w); if (c) colours.add(c); } else unknown.push(`PVB:${w}`);
    }
    const tempered = p1.tempered && p2.tempered;
    // Her kat bir renk taşımalı (Düz = şeffaf); rengi yazmayan kat tahmin edilmez
    if (!p1.colours.size || !p2.colours.size) unknown.push('PLY_COLOUR');
    const pvb = { mm: lam[3].replace('.', ','), layers: null };
    if (t1 == null || t2 == null || pvbMm == null) return { ...base, ok: false, code: null, colours: [...colours].sort(), unknown, tempered, pvb, problem: 'THICKNESS' };
    if (pvbMm % 38 !== 0 || pvbMm === 0) return { ...base, ok: false, code: null, colours: [...colours].sort(), unknown, tempered, pvb, problem: 'PVB_NOT_MULTIPLE' };
    pvb.layers = pvbMm / 38;
    return { ...base, ok: true, code: `${mmText(t1)}.${pvb.layers}.${mmText(t2)}`, colours: [...colours].sort(), unknown, tempered, pvb };
  }
  if (!body.includes('+')) {
    const mono = /^(\d{1,2}(?:[.,]\d{1,2})?)\s*mm\s+(.+)$/iu.exec(body);
    const t = mono ? mmOf(mono[1]) : null;
    if (mono && t != null) {
      const p = plyFeatures(mono[2]);
      const unknown = [...p.unknown, ...(p.colours.size ? [] : ['PLY_COLOUR'])];
      return { ...base, ok: true, code: mmText(t), colours: [...p.colours].sort(), unknown, tempered: p.tempered };
    }
  }
  return { ...base, ok: false, code: null, problem: 'UNRECOGNIZED' };
}

/**
 * Katalog camının imzası (Türkçe ve Romence ad + renk). Kod: "6.3.6" / "6.3.6." ya da tek kat "10 mm".
 * Renk: bilinen sınıflar; katalog adındaki diğer sözcükler (Sticla, Lamine, securizata …) sayılmaz.
 * @param {{ nameTr?: string | null, colorTr?: string | null, nameRo?: string | null, colorRo?: string | null }} g
 */
export function catalogGlassSignature(g) {
  const texts = [g?.nameTr, g?.colorTr, g?.nameRo, g?.colorRo].filter(Boolean).map(String);
  const all = fold(texts.join(' | '));
  const lam = /(?:^|[^\d.,])(\d{1,2})[.,](\d)[.,](\d{1,2})(?![\d])/.exec(all);
  const mono = /(?:^|[^\d.,])(\d{1,2})\s*MM\b/.exec(all);
  const code = lam ? `${Number(lam[1])}.${Number(lam[2])}.${Number(lam[3])}` : mono && !/\bLAMIN/.test(all) ? String(Number(mono[1])) : null;
  let t = ` ${all.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const colours = new Set();
  for (const [p, c] of PHRASES) if (t.includes(` ${p} `)) { colours.add(c); t = t.split(` ${p} `).join(' '); }
  for (const w of t.trim().split(' ')) {
    if (WORDS.has(w)) colours.add(/** @type {string} */ (WORDS.get(w)));
    if (['OPAK', 'OPAQUE', 'OPAC'].includes(w)) colours.add('PVB_OPAQUE');
  }
  return { code, colours: [...colours].sort() };
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** İki imza birebir aynı cam cinsi mi (kod + renk sınıfları) */
export function sameGlass(factory, catalog) {
  return !!factory.code && factory.code === catalog.code && sameSet(factory.colours, catalog.colours);
}

/**
 * Fabrika satırının cam cinsi için katalog adayları.
 * @param {ReturnType<typeof factoryGlassSignature>} sig
 * @param {{ id: string, nameTr: string, colorTr?: string, nameRo?: string, colorRo?: string, isActive?: boolean }[]} catalog  etkin camlar
 * @returns {{ exact: string[], sameCode: string[] }}  katalog kimlikleri
 */
export function glassCandidates(sig, catalog) {
  const exact = [];
  const sameCode = [];
  for (const g of catalog) {
    if (g.isActive === false) continue;
    const c = catalogGlassSignature(g);
    if (sig.code && c.code === sig.code) sameCode.push(g.id);
    // Tanınmayan sözcük varken (ör. bilinmeyen bir kaplama) otomatik eşleşme yapılmaz
    if (sig.ok && !sig.unknown.length && sameGlass(sig, c)) exact.push(g.id);
  }
  return { exact, sameCode };
}

/**
 * Siparişin camı ile fabrika camı arasında belirgin uyuşmazlık var mı. Siparişin camının adından kod çıkmıyorsa
 * karşılaştırılamaz (UNKNOWN — uyarı); kod ya da renkler farklıysa MISMATCH (aktarma durur).
 * @returns {'MATCH' | 'MISMATCH' | 'UNKNOWN' | 'NONE'}
 */
export function orderGlassVerdict(sig, orderGlass) {
  if (!orderGlass) return 'NONE';
  const c = catalogGlassSignature(orderGlass);
  if (!c.code || !sig.code) return 'UNKNOWN';
  if (c.code !== sig.code) return 'MISMATCH';
  if (!c.colours.length || sig.unknown.length) return 'UNKNOWN';
  return sameSet(c.colours, sig.colours) ? 'MATCH' : 'MISMATCH';
}
