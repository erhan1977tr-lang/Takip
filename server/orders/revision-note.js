// Müşterinin revizyon notu (karar 162): "Nota de revizie" altında NUMARALI maddeler. Müşteri her değişikliği ayrı bir
// maddeye yazar; madde listesi tek metin olarak saklanır ("1. …\n2. …" — DrawingRevision.comment), böylece iş akışı
// (request_revision: not zorunlu), geçmiş, e-posta ve çeviri aynı metni kullanır. Saf kural: veritabanı, ağ, ortam yok.
//   - Madde tek satırdır: satır sonları ve fazla boşluk tek boşluğa iner; müşterinin elle yazdığı baştaki numara /
//     madde işareti ("1.", "2)", "-", "•") atılır — numarayı sistem verir.
//   - Boş maddeler atılır; en az bir dolu madde zorunludur (EMPTY). En fazla REVISION_ITEMS_MAX madde (TOO_MANY),
//     madde başına REVISION_ITEM_MAX karakter ve toplam REVISION_TEXT_MAX karakter (TOO_LONG).
//   - Gösterim: revisionItems saklanan metni yeniden maddelere ayırır; düzene uymayan (eski serbest) not null döner ve
//     olduğu gibi gösterilir. Çeviri metni de aynı işlevle maddelenir (çeviri satırları korunduysa).

export const REVISION_ITEMS_MAX = 20;
export const REVISION_ITEM_MAX = 500;
export const REVISION_TEXT_MAX = 4000;

// Baştaki işaret ancak ardından boşluk gelirse atılır: "1. kenar", "2) delik", "- ölçü" → atılır; "1.5 mm", "-5 mm" kalır
const LEAD = /^(?:\d{1,3}[.)]|[-–—•*])\s+/;

/**
 * Bir maddeyi temizler (tek satır, baştaki elle yazılmış numara / madde işareti olmadan).
 * @param {unknown} v
 * @returns {string}
 */
export function cleanRevisionItem(v) {
  const s = String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().replace(LEAD, '').trim();
  // Yalnızca işaretten oluşan madde ("2.", "-") boştur
  return /^(?:\d{1,3}[.)]|[-–—•*])$/.test(s) ? '' : s;
}

/**
 * Formdaki maddelerden saklanacak numaralı not.
 * @param {unknown[]} items  maddeler, formdaki sırasıyla
 * @returns {{ ok: true, text: string, items: string[] } | { ok: false, code: 'EMPTY' | 'TOO_MANY' | 'TOO_LONG' }}
 */
export function revisionNote(items) {
  const list = (Array.isArray(items) ? items : [items]).map(cleanRevisionItem).filter(Boolean);
  if (list.length === 0) return { ok: false, code: 'EMPTY' };
  if (list.length > REVISION_ITEMS_MAX) return { ok: false, code: 'TOO_MANY' };
  if (list.some((x) => x.length > REVISION_ITEM_MAX)) return { ok: false, code: 'TOO_LONG' };
  const text = list.map((x, i) => `${i + 1}. ${x}`).join('\n');
  if (text.length > REVISION_TEXT_MAX) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, text, items: list };
}

/**
 * Paket B (karar 227): müşteri revizyon ekranında çizim üstüne işaret koyar (iğne, dikdörtgen, serbest, metin) ve her
 * işarete kısa bir açıklama yazabilir. İşaretin açıklaması numaralı nota "#<işaret no>: metin" maddesi olarak eklenir —
 * böylece not ile işaret aynı numarayla bağlanır ve işaret açıklamaları da notla birlikte BİR KEZ çevrilir. İşaret
 * numarası işaretin KALICI numarasıdır (no — server/orders/annotations.js, P5 karar 244; çizim üstünde ve "Nota de revizie"
 * bölümünde gösterilen numara); numarasız eski işarette listedeki sıra.
 * Maddesiz ama açıklamalı işaret içeren talep geçerlidir; ikisi de yoksa EMPTY.
 * @param {unknown[]} items  formdaki maddeler
 * @param {{ text?: string }[]} annotations  doğrulanmış işaretler (server/orders/annotations.js → cleanAnnotations)
 */
export function revisionNoteWithMarks(items, annotations = []) {
  const marks = (Array.isArray(annotations) ? annotations : [])
    .map((a, i) => {
      const text = cleanRevisionItem(a?.text);
      // Kalıcı işaret numarası (P5 — karar 244): silme / sıra değişimi başka işaretin numarasını değiştirmez; eski kayıtta sıra
      const prefix = `#${Number.isInteger(a?.no) && a.no > 0 ? a.no : i + 1}: `;
      return text ? prefix + text.slice(0, REVISION_ITEM_MAX - prefix.length) : '';
    })
    .filter(Boolean);
  return revisionNote([...(Array.isArray(items) ? items : [items]), ...marks]);
}

/**
 * Saklanan (ya da çevrilmiş) notun maddeleri: her satır sırayla "n. metin" ise maddeler; değilse null (eski serbest not —
 * olduğu gibi gösterilir).
 * @param {unknown} text
 * @returns {string[] | null}
 */
export function revisionItems(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const out = [];
  for (const [i, line] of lines.entries()) {
    const m = /^(\d{1,3})[.)]\s+(.+)$/.exec(line);
    if (!m || Number(m[1]) !== i + 1) return null;
    out.push(m[2].trim());
  }
  return out;
}
