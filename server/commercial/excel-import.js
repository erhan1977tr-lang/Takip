// Ticari teklif → Cam: Excel'den aktarma (4.1.0, karar 298) — SAF kurallar (tarayıcıdaki önizleme ve sunucu testleri aynı kodu
// kullanır). Dosyanın okunması ve ön izleme penceresi (1000 satır × 30 sütun, metin sınırları) sunucuda:
// server/commercial/excel-read.js (mevcut okuyucular ve previewRows).
//
// Satış ekibinin Excel aktarımından (server/orders/excel-import.js) aynen kullanılanlar: sayı okuma (cellNumber — "1.200",
// "1200,5", "mm"), en / boy / adet doğrulaması ve ondalıklı mm'nin tam sayıya yuvarlanması (validateImportRows), başlık satırı
// tahmini (looksLikeHeader). Bu dosya yalnızca ticari teklifin ek kurallarını ekler: ölçü / adet üst sınırları (rules.js LIMITS),
// isteğe bağlı cam tipi sütunu ve cam eşleştirmesi, 100 satır sınırı, aynı dosya / aynı satır uyarıları.
//
// CAM EŞLEŞTİRME (yanlış cam = yanlış maliyet ve teklif — bilinçli olarak dar):
//   - hücre boş → seçilen varsayılan cam (seçilmemişse satırın camı belirlenmez);
//   - hücre dolu → katalogda yalnızca TEK ve KESİN eşleşme (büyük / küçük harf, Türkçe İ/ı, gereksiz boşluk farkı yok sayılır;
//     Türkçe ad + renk, Romence ad + renk, ekrandaki etiket); eşleşmezse ya da birden fazla cama uyarsa varsayılana GEÇİLMEZ,
//     otomatik seçim YAPILMAZ — kullanıcı elle seçer; seçmezse satır aktarılmaz;
//   - benzer ad, kısmi metin, tahmin YOK.
import { looksLikeHeader, validateImportRows } from '../orders/excel-import.js';
import { LIMITS } from './rules.js';

/** Ticari teklife aktarılacak Excel dosyasının en büyük boyutu: 1,5 MB (vekilin genel 2 MB istek sınırının içinde) */
export const COMMERCIAL_IMPORT_MAX_BYTES = 1.5 * 1024 * 1024;

/** Metni karşılaştırma anahtarına çevirir: Türkçe küçük harf, İ/ı → i, birleşik nokta yok, boşluklar tek */
export function glassKey(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('tr-TR')
    .replace(/̇/g, '')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Katalogdaki her cam için kabul edilen yazımlar (anahtar olarak): ad + renk (boşluk, " — ", ", ", " - " ile), renk yoksa ad,
 * ekrandaki etiket. Aynı anahtarı birden fazla cam taşıyorsa o anahtar belirsizdir.
 * @param {{ id: string, nameTr?: string | null, colorTr?: string | null, nameRo?: string | null, colorRo?: string | null, label?: string | null }[]} catalog
 * @returns {Map<string, Set<string>>}
 */
export function glassIndex(catalog) {
  const idx = new Map();
  const add = (k, id) => {
    const key = glassKey(k);
    if (!key) return;
    if (!idx.has(key)) idx.set(key, new Set());
    idx.get(key).add(id);
  };
  for (const g of catalog ?? []) {
    for (const [name, color] of [[g.nameTr, g.colorTr], [g.nameRo, g.colorRo]]) {
      const n = String(name ?? '').trim(), c = String(color ?? '').trim();
      if (!n) continue;
      if (!c) { add(n, g.id); continue; }
      for (const sep of [' ', ' — ', ', ', ' - ']) add(`${n}${sep}${c}`, g.id);
    }
    if (g.label) add(g.label, g.id);
  }
  return idx;
}

/**
 * Cam hücresinin eşleşmesi.
 * @returns {{ status: 'EMPTY' } | { status: 'MATCH', id: string } | { status: 'NONE' } | { status: 'AMBIGUOUS', ids: string[] }}
 */
export function matchGlass(cell, index) {
  const key = glassKey(cell);
  if (!key) return { status: 'EMPTY' };
  const ids = index.get(key);
  if (!ids || ids.size === 0) return { status: 'NONE' };
  if (ids.size > 1) return { status: 'AMBIGUOUS', ids: [...ids] };
  return { status: 'MATCH', id: [...ids][0] };
}

/** Başlık satırı tahmini: seçilen ölçü / adet sütunlarından biri sayı değilse (satış aktarımının kuralı) */
export const looksLikeHeaderRow = (rows, map) => looksLikeHeader(rows, map);

/**
 * Ön izleme satırlarını doğrular ve camını çözer.
 * @param {string[][]} rows  sunucunun döndürdüğü ön izleme penceresi
 * @param {{ glass: number, width: number, height: number, qty: number }} map  sütun indeksleri (glass -1 = sütun yok)
 * @param {{ skipHeader?: boolean, index: Map<string, Set<string>>, defaultId?: string, picks?: Record<number, string>, valid?: Set<string> }} o
 *   picks: satır numarası (Excel, 1 tabanlı) → elle seçilen cam; valid: seçilebilir (etkin) cam kimlikleri
 * @returns {{ rows: { line: number, glassText: string, glass: string | null, glassStatus: 'MATCH' | 'DEFAULT' | 'PICKED' | 'NONE' | 'AMBIGUOUS' | 'MISSING',
 *   en: number | null, boy: number | null, qty: number | null, errors: string[], ok: boolean }[], ready: number, invalid: number, needsGlass: number }}
 */
export function importRows(rows, map, { skipHeader = false, index, defaultId = '', picks = {}, valid = null }) {
  const base = validateImportRows(rows, { width: map.width, height: map.height, qty: map.qty }, { skipHeader });
  const usable = (id) => !!id && (!valid || valid.has(id));
  const out = base.rows.map((r) => {
    const errors = [...r.errors];
    // Ticari teklifin sınırları (satış kuralı yalnızca > 0 ister): 1–10000 mm, 1–100000 adet
    if (r.en != null && (r.en < 1 || r.en > LIMITS.mm)) errors.push('widthRange');
    if (r.boy != null && (r.boy < 1 || r.boy > LIMITS.mm)) errors.push('heightRange');
    if (r.adet != null && r.adet > LIMITS.qty) errors.push('qtyRange');
    const raw = map.glass >= 0 ? rows[r.line - 1]?.[map.glass] ?? '' : '';
    const glassText = String(raw).trim();
    const m = map.glass >= 0 ? matchGlass(glassText, index) : { status: 'EMPTY' };
    const pick = Object.hasOwn(picks, r.line) ? picks[r.line] : '';
    let glass = null;
    let glassStatus;
    if (usable(pick)) { glass = pick; glassStatus = 'PICKED'; }
    else if (m.status === 'MATCH' && usable(m.id)) { glass = m.id; glassStatus = 'MATCH'; }
    else if (m.status === 'EMPTY' && usable(defaultId)) { glass = defaultId; glassStatus = 'DEFAULT'; }
    else glassStatus = m.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : m.status === 'EMPTY' ? 'MISSING' : 'NONE';
    return { line: r.line, glassText, glass, glassStatus, en: r.en, boy: r.boy, qty: r.adet, errors, ok: errors.length === 0 && !!glass };
  });
  const ready = out.filter((r) => r.ok).length;
  const invalid = out.filter((r) => r.errors.length > 0).length;
  const needsGlass = out.filter((r) => r.errors.length === 0 && !r.glass).length;
  return { rows: out, ready, invalid, needsGlass };
}

/** 100 satır sınırı: aktarım sonrası cam bölümü en çok LIMITS.glass satır (sandık kalemleri dahil). Aşılırsa hiçbir satır eklenmez. */
export function importCapacity(existing, adding, max = LIMITS.glass) {
  const free = Math.max(0, max - existing);
  return { ok: adding <= free, existing, adding, free, max };
}

/** Aynı satır (cam, en, boy, adet) tabloda zaten var mı — tekrar aktarım uyarısı için (engellemez) */
export function duplicateRows(newRows, existing) {
  const keyOf = (l) => [l.productId ?? l.glass, Number(l.en), Number(l.boy), Number(l.qty)].join('|');
  const have = new Set((existing ?? []).filter((l) => l.productId).map(keyOf));
  return newRows.filter((r) => have.has(keyOf(r))).length;
}

