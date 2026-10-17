// Panel AI asistanı — yanıt metninin GÜVENLİ ayrıştırılması (3.95.0, karar 290). Saf modül (tarayıcıda da çalışır).
//
// Model yanıtı güvenilmeyen metindir (araç sonuçlarındaki müşteri / not metinlerini yansıtabilir). Bu modül HTML ÜRETMEZ:
// metni düz veri ağacına çevirir ({ type, ... } + metin parçaları); arayüz bu ağacı React öğeleriyle çizer, metinler her
// zaman metin düğümü olur (dangerouslySetInnerHTML yok). Desteklenen biçim bilinçli olarak dardır: paragraf, "- " madde,
// **kalın**, basit tablo ve sipariş numarası bağlantısı. Bağlantı adresi metinden ALINMAZ: yalnızca sipariş numarası
// biçimindeki parçadan sabit iç yol (/siparisler?q=…) kurulur.

export const MD_LIMITS = Object.freeze({ chars: 6000, tableCols: 8, tableRows: 60, blocks: 120 });

// Sipariş numarası: 3 harf firma kodu (+ profil "P") + müşteri numarası ("40", "40-1") + isteğe bağlı telafi "-T" / "-T2".
const ORDER_RE = /\b([A-Z]{3}P?\d{1,6}(?:-\d{1,6}){0,3}(?:-T\d{0,3})?)\b/g;
// Sipariş numarasına benzeyen ama sipariş olmayan kodlar (renk, profil, fatura serisi)
const NOT_ORDER = /^(RAL|FBL|PRF|GKH|EUR|RON|USD|TRY|PVB)/;

/** Sipariş numarası için sabit iç yol */
export const orderHref = (no) => `/siparisler?q=${encodeURIComponent(no)}`;

/** Satır içi: **kalın** ve sipariş numaraları → [{ t: 'text' | 'b' | 'order', v }] */
export function inline(text) {
  const out = [];
  const s = String(text ?? '');
  const parts = s.split(/(\*\*[^*\n]{1,400}\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) { pushText(out, part.slice(2, -2), 'b'); continue; }
    pushText(out, part.replace(/\*\*/g, ''), 'text');
  }
  return out;
}

function pushText(out, s, kind) {
  let last = 0;
  for (const m of s.matchAll(ORDER_RE)) {
    if (NOT_ORDER.test(m[1])) continue;
    if (m.index > last) out.push({ t: kind, v: s.slice(last, m.index) });
    out.push({ t: 'order', v: m[1], bold: kind === 'b' });
    last = m.index + m[1].length;
  }
  if (last < s.length) out.push({ t: kind, v: s.slice(last) });
}

const cells = (line) => {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
};
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);

/**
 * Yanıt metni → bloklar: { type: 'p', parts } | { type: 'ul', items: parts[] } | { type: 'table', head: parts[], rows: parts[][] }
 * Başlık işareti (#) atılır; kod çitleri (```) ve HTML etiketleri düz metin kalır (yorumlanmaz).
 */
export function parseAnswer(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').slice(0, MD_LIMITS.chars);
  const lines = src.split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', parts: inline(para.join('\n')) }); para = []; } };
  for (let i = 0; i < lines.length && blocks.length < MD_LIMITS.blocks; i++) {
    const line = lines[i];
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(line).slice(0, MD_LIMITS.tableCols);
      const rows = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        if (rows.length < MD_LIMITS.tableRows) {
          const r = cells(lines[i]).slice(0, head.length);
          while (r.length < head.length) r.push('');
          rows.push(r.map(inline));
        }
        i++;
      }
      i--;
      blocks.push({ type: 'table', head: head.map(inline), rows });
      continue;
    }
    const item = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === 'ul' && prev.open) prev.items.push(inline(item[1]));
      else blocks.push({ type: 'ul', items: [inline(item[1])], open: true });
      continue;
    }
    const prev = blocks[blocks.length - 1];
    if (prev && prev.type === 'ul') prev.open = false;
    if (!line.trim()) { flush(); continue; }
    para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flush();
  for (const b of blocks) if (b.type === 'ul') delete b.open;
  return blocks;
}
