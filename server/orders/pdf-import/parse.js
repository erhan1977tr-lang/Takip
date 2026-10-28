// Fabrika PDF'i aktarımı (karar 255): Trakya Cam / GlassWorld "SİPARİŞ FORMU"nun satırlarından (lines.js) sipariş verisi.
// Saf modül — veritabanı, dosya, ağ yok; kayan nokta kullanılmaz (tutarlar kuruş, m² ve miktar binde bir birimle tam sayı).
//
//   Başlık   : fabrika sipariş no (büyük yazılan numara — "Sipariş No" yanındaki 121.001 gibi noktalı değer DEĞİL), sipariş
//              ve teslim tarihi, "Proje / Müşterisi" (gerçek müşteri + proje; "Müşteri Adı" alıcı olarak bizim firmamızdır).
//   Tablo    : sütun başlığından ("S.No … Poz") ilk "Toplam :" satırına kadar. Cam satırı: S.No + cam adı (+ aynı ya da
//              sonraki satırda) en, boy, adet, m², toplam m², birim fiyat, iskonto %, tutar, Poz. İşlem satırı (CNC, delik…):
//              ad, birim (ADET), miktar, toplam miktar, birim fiyat, iskonto %, tutar — kendinden önceki cam satırına aittir.
//   Sonrası  : "CAM / ÜRÜN GRUP BİLGİLERİ" aynı kalemlerin özetidir; satır olarak OKUNMAZ. Toplamlar: Ara Toplam (KDV hariç —
//              fabrika alış toplamının tek esası), KDV ve Genel Toplam (yalnızca bilgi; hiçbir hesapta kullanılmaz).
//   Para     : "TL", "€" ve "€ Kur" etiketleri fabrika çıktısının hatasıdır — bütün tutarlar EUR kabul edilir, dönüşüm yok.
//   Sayılar  : (4.2.11) GlassWorld sayıları çıktıyı alan iş istasyonunun bölge ayarıyla basar: Türkçe biçim (binlik ".", ondalık
//              ",": 1.183,44 · 4,594 · 0,0 — 4.2.10'a kadar tanınan TEK biçim, kuralı değişmedi) ya da noktalı ondalık (ondalık ".",
//              binlik "," ya da hiç: 1,183.44 / 1183.44 · 4.594 · 0.0 — ALE106 / ALE107 böyledir). Biçim BELGE BAŞINA bir kez,
//              tablo / "Toplam :" / Ara Toplam satırlarının hangi biçimle TAM okunduğundan belirlenir (numberFormatOf); iki biçim
//              aynı belgede görülürse belge reddedilir (NUMBER_FORMAT_MIXED). Tek bir sayı asla tek başına tahmin edilmez ("1.661"
//              Türkçe biçimde binlik ayırıcılı tam sayı, noktalı biçimde 1,661'dir).
//
// Belirsiz / tanınmayan hiçbir şey sessizce kabul edilmez: sorun kodu (problems) üretilir; ön izleme gösterir, aktarma engellenir.

const CUR = String.raw`(?:TL|TRY|€|EUR|EURO)?`;

/** Sayı biçimleri: tam sayı kısmı (binlik ayırıcısıyla), ondalık ayırıcı (RegExp kaynağı) ve binlik ayırıcı */
const FORMAT_PARTS = Object.freeze({
  // Türkçe biçim (4.2.10'a kadar tek biçim — DEĞİŞMEDİ): 1.183,44
  comma: { num: String.raw`\d{1,3}(?:\.\d{3})*`, dec: ',', thousands: /\./g },
  // Noktalı ondalık (4.2.11): 1,183.44 ya da 1183.44
  dot: { num: String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`, dec: String.raw`\.`, thousands: /,/g },
});
/** @typedef {'comma' | 'dot'} NumberFormat */
export const NUMBER_FORMATS = Object.freeze(/** @type {NumberFormat[]} */ (Object.keys(FORMAT_PARTS)));

function patternsOf({ num, dec, thousands }) {
  const MONEY = String.raw`${num}${dec}\d{2}`;
  const DEC3 = String.raw`${num}${dec}\d{3}`;
  const DISC = String.raw`\d{1,3}(?:${dec}\d{1,2})?`;
  /** Tablodan sonraki etiketli tutar (büyük harfe çevrilmiş satırda): "ARA TOPLAM : 481.64", "KDV TUTARI 20,00 : 86,70". Tutar
   *  bir rakamla devam edemez: öteki biçimin binlik ayırıcılı tutarı ("2,566.00") bu biçimde kısmen ("2,56") okunmaz. */
  const labelled = (label) => new RegExp(`${label}\\s*(?:\\d{1,2}${dec}\\d{2}\\s*)?:\\s*(${MONEY})(?!\\d)`);
  return {
    thousands,
    money: new RegExp(`^(${num})${dec}(\\d{2})$`),
    dec3: new RegExp(`^(${num})${dec}(\\d{3})$`),
    disc: new RegExp(`^(\\d{1,3})(?:${dec}(\\d{1,2}))?$`),
    /** Cam satırının sayısal kuyruğu: en boy adet m² topM² fiyat [para] isk tutar [Poz] */
    glassTail: new RegExp(String.raw`(?:^|\s)(\d{2,5})\s+(\d{2,5})\s+(\d{1,5})\s+(${DEC3})\s+(${DEC3})\s+(${MONEY})\s*${CUR}\s+(${DISC})\s+(${MONEY})(?:\s+(.+))?$`, 'u'),
    /** İşlem satırı: ad [birim] miktar topMiktar fiyat [para] isk tutar */
    opLine: new RegExp(String.raw`^(\D.*?)\s+(?:(ADET|AD|MT|MTUL|M2|M)\s+)?(${DEC3})\s+(${DEC3})\s+(${MONEY})\s*${CUR}\s+(${DISC})\s+(${MONEY})$`, 'u'),
    totalLine: new RegExp(String.raw`^Toplam\s*:\s*(\d{1,5})\s+(${DEC3})\s+(${MONEY})(?:\s*${CUR})?$`, 'u'),
    labelled,
    ara: labelled('ARA TOPLAM'),
    /** Satırda tutar var mı (açıklama satırı ayrımı): Türkçe biçimde eski kural aynen; noktalıda yalnızca ayrı duran tutar
     *  ("DR+1.14+8" gibi açıklamaya yapışık PVB kalınlığı tutar sayılmaz) */
    hasMoney: dec === ',' ? /\d,\d{2}/ : new RegExp(String.raw`(?:^|\s)${num}${dec}\d{2}(?=\s|$)`),
  };
}
const PATTERNS = Object.freeze({ comma: patternsOf(FORMAT_PARTS.comma), dot: patternsOf(FORMAT_PARTS.dot) });
const fmtOf = (format) => PATTERNS[format === 'dot' ? 'dot' : 'comma'];

/** "1.183,44" → 118344 (kuruş); noktalı biçimde "1,183.44" / "1183.44" → 118344 */
export function moneyCents(s, format = 'comma') {
  const p = fmtOf(format);
  const m = p.money.exec(String(s ?? '').trim());
  if (!m) return null;
  return Number(m[1].replace(p.thousands, '')) * 100 + Number(m[2]);
}
/** "4,594" → 4594 (binde bir); noktalı biçimde "4.594" → 4594 */
export function milli(s, format = 'comma') {
  const p = fmtOf(format);
  const m = p.dec3.exec(String(s ?? '').trim());
  if (!m) return null;
  return Number(m[1].replace(p.thousands, '')) * 1000 + Number(m[2]);
}
/** "12,5" → 1250 (yüzde × 100); noktalı biçimde "12.5" → 1250 */
export function discountBp(s, format = 'comma') {
  const m = fmtOf(format).disc.exec(String(s ?? '').trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return bp <= 10000 ? bp : null;
}

/** Yarı yukarı yuvarlamalı tam sayı bölme (BigInt; pozitif değerler) */
const divRound = (a, b) => (a * 2n + b) / (b * 2n);

/** Satırın beklenen tutarı (kuruş): miktar (binde bir) × fiyat (kuruş) × (1 − iskonto) — bir kez yuvarlanır */
export function expectedAmount(qtyMilli, priceCents, discBp) {
  return Number(divRound(BigInt(qtyMilli) * BigInt(priceCents) * BigInt(10000 - discBp), 10_000_000n));
}

const folded = (s) => String(s ?? '').toLocaleUpperCase('tr-TR')
  .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G').replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C');

const isColumnHeader = (t) => { const f = folded(t); return /^S\.?NO\b/.test(f) && f.includes('CAM') && /\bPOZ\b/.test(f); };
const isGroupSection = (t) => folded(t).includes('URUN GRUP BILGILERI');
/** Sonraki sayfalarda tablonun üstüne tekrar basılabilecek başlık satırları (tablo dışı) */
const PAGE_HEADER = [/SIPARIS FORMU/, /^SIPARIS NO\b/, /^MUSTERI ADI\b/, /^PROJE\s*\/\s*MUSTERISI\b/, /^ADRES\s*:/, /SIPARIS TARIHI/, /TESLIM TARIHI/, /RAPOR TARIHI/, /^FORM NO\b/, /^TRAKYA\b/];
const isPageHeader = (t) => { const f = folded(t); return PAGE_HEADER.some((r) => r.test(f)); };

/** Açıklama devamı olabilecek metin: harf içerir, tutar / ölçü dizisi içermez, yalnızca güvenli karakterler */
const isDescContinuation = (t, p) => /\p{L}/u.test(t) && !p.hasMoney.test(t) && !/\d{2,5}\s+\d{2,5}\s+\d/.test(t)
  && /^[\p{L}\d\s.,+\-()]+$/u.test(t) && !/^TOPLAM\b/.test(folded(t));

/**
 * Belgenin sayı biçimi (4.2.11): sütun başlığından sonraki satırlardan hangileri hangi biçimle YAPI OLARAK tam okunuyor — cam
 * satırı, işlem satırı, "Toplam :" satırı, "Ara Toplam :". Bir satır iki biçimle birden okunamaz (her yapı biçime özgü ondalık
 * sayı taşır). İki biçim de görüldüyse 'mixed' (belge reddedilir); hiçbiri görülmediyse 'comma' (eski davranış — sorunlar
 * eskisi gibi raporlanır).
 * @param {{ text: string }[]} lines
 * @returns {NumberFormat | 'mixed'}
 */
export function numberFormatOf(lines) {
  const hits = { comma: 0, dot: 0 };
  for (const l of lines ?? []) {
    const t = String(l?.text ?? '');
    const f = folded(t);
    for (const k of NUMBER_FORMATS) {
      const p = PATTERNS[k];
      if (p.glassTail.test(t) || p.opLine.test(t) || p.totalLine.test(t) || p.ara.test(f)) hits[k] += 1;
    }
  }
  if (hits.comma && hits.dot) return 'mixed';
  return hits.dot ? 'dot' : 'comma';
}

const dateOf = (text, label) => {
  const m = new RegExp(`${label}\\s*:\\s*(\\d{2})[-./](\\d{2})[-./](\\d{4})`).exec(folded(text));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/**
 * @param {{ page: number, text: string }[]} lines
 * @returns {{
 *   header: { factoryNo: string | null, orderDate: string | null, deliveryDate: string | null, project: string | null },
 *   rows: object[], totals: object, problems: { code: string, line?: number, text?: string }[]
 * }}
 */
export function parseFactoryOrder(lines) {
  /** @type {{ code: string, line?: number, text?: string, row?: number }[]} */
  const problems = [];
  const header = { factoryNo: null, orderDate: null, deliveryDate: null, project: null };
  const totals = { count: null, totalM2: null, tableSum: null, subtotal: null, grossSum: null, discount: null, vat: null, grandTotal: null };
  /** @type {any[]} */
  const rows = [];
  const list = (lines ?? []).map((l, i) => ({ ...l, n: i + 1 }));

  // ---- Başlık (tablodan önceki satırlar) ----
  const headerStart = list.findIndex((l) => isColumnHeader(l.text));
  if (headerStart < 0) return { header, rows, totals, problems: [{ code: 'NOT_FACTORY_FORM' }] };
  const head = list.slice(0, headerStart);
  const buyerIdx = head.findIndex((l) => /^MUSTERI ADI\b/.test(folded(l.text)));
  const noCandidates = new Set();
  for (const l of (buyerIdx >= 0 ? head.slice(0, buyerIdx + 1) : head)) {
    // Tarih / saat / telefon taşıyan satırlar numara adayı değildir; büyük sipariş numarası noktasız 4–8 hanedir
    for (const tok of l.text.split(/\s+/)) if (/^\d{4,8}$/.test(tok)) noCandidates.add(tok);
  }
  if (noCandidates.size === 1) header.factoryNo = [...noCandidates][0];
  else problems.push({ code: noCandidates.size ? 'FACTORY_NO_AMBIGUOUS' : 'FACTORY_NO_MISSING' });
  for (const l of head) {
    header.orderDate ??= dateOf(l.text, 'SIPARIS TARIHI');
    header.deliveryDate ??= dateOf(l.text, 'TESLIM TARIHI');
    // "Proje / Müşterisi : musterix ABC 40" — iki noktadan sonrası (özgün yazımıyla)
    if (header.project == null && /^PROJE\s*\/\s*MUSTERISI\s*:/.test(folded(l.text))) header.project = l.text.slice(l.text.indexOf(':') + 1).trim() || null;
  }
  if (!header.project) problems.push({ code: 'PROJECT_MISSING' });

  // ---- Sayı biçimi (4.2.11): belge başına bir kez; iki biçim birlikte → red (hiçbir sayı tahminle okunmaz) ----
  const numberFormat = numberFormatOf(list.slice(headerStart + 1));
  if (numberFormat === 'mixed') return { header, rows, totals, problems: [...problems, { code: 'NUMBER_FORMAT_MIXED' }], numberFormat: null };
  const P = PATTERNS[numberFormat];
  const money = (s) => moneyCents(s, numberFormat);
  const thousandths = (s) => milli(s, numberFormat);
  const discount = (s) => discountBp(s, numberFormat);

  // ---- Tablo ----
  let state = 'rows';
  let pending = null; // S.No + açıklaması okunmuş, sayıları bekleyen cam satırı
  let afterGlass = false; // bir önceki tablo satırı cam satırıydı (ya da onun açıklama devamı) — karar 262
  let i = headerStart + 1;
  for (; i < list.length && state === 'rows'; i++) {
    const l = list[i];
    const t = l.text;
    if (isColumnHeader(t) || isPageHeader(t)) continue;
    if (isGroupSection(t)) { problems.push({ code: 'TABLE_END_MISSING', line: l.n }); state = 'post'; i--; break; }
    const tot = P.totalLine.exec(t);
    if (/^Toplam\s*:/u.test(t)) {
      if (pending) problems.push({ code: 'ROW_INCOMPLETE', line: pending.line, text: pending.description });
      pending = null;
      if (tot) { totals.count = Number(tot[1]); totals.totalM2 = thousandths(tot[2]); totals.tableSum = money(tot[3]); }
      else problems.push({ code: 'TOTAL_LINE_UNREADABLE', line: l.n, text: t });
      state = 'post';
      break;
    }
    const g = P.glassTail.exec(t);
    if (g) {
      const before = t.slice(0, g.index).trim();
      let sno = null; let description = null;
      const lead = /^(\d{1,4})\s+(.+)$/.exec(before);
      if (lead) { sno = Number(lead[1]); description = lead[2]; }
      else if (!before && pending) { sno = pending.sno; description = pending.description; }
      // Açıklamanın ikinci satırı sayılarla aynı satırda (karar 262): "66.3 TEMPER LAMİNE CAM - ŞEKİLLİ" / "REFLEKTE FÜME + ŞEFFAF 1000 …"
      else if (pending && !/^\d/.test(before)) { sno = pending.sno; description = `${pending.description} ${before}`; }
      else { problems.push({ code: 'UNRECOGNIZED_LINE', line: l.n, text: t }); pending = null; afterGlass = false; continue; }
      if (lead && pending) problems.push({ code: 'ROW_INCOMPLETE', line: pending.line, text: pending.description });
      pending = null;
      rows.push({
        line: l.n, sno, description: description.replace(/\s+\.$/, '').trim(),
        en: Number(g[1]), boy: Number(g[2]), adet: Number(g[3]), m2: thousandths(g[4]), totalM2: thousandths(g[5]),
        unitPrice: money(g[6]), discount: discount(g[7]), amount: money(g[8]), poz: (g[9] ?? '').trim() || null, ops: [],
      });
      afterGlass = true;
      continue;
    }
    const op = P.opLine.exec(t);
    if (op) {
      const row = rows[rows.length - 1];
      if (!row || pending) { problems.push({ code: 'OP_WITHOUT_GLASS', line: l.n, text: t }); continue; }
      row.ops.push({
        line: l.n, name: op[1].trim(), unit: op[2] ?? null, qty: thousandths(op[3]), totalQty: thousandths(op[4]),
        unitPrice: money(op[5]), discount: discount(op[6]), amount: money(op[7]),
      });
      afterGlass = false;
      continue;
    }
    // S.No + cam adı (sayıları sonraki satırda): ad bir kalınlık ("6 mm") ya da "CAM" sözcüğünü taşır ("66.3 TEMPER LAMİNE CAM")
    const desc = /^(\d{1,4})\s+(\d{1,2}(?:[.,]\d+)?\s*mm\b.*)$/iu.exec(t) ?? (/^(\d{1,4})\s+(\d.*)$/u.test(t) && /\bCAM\b/.test(folded(t)) && !P.hasMoney.test(t) ? /^(\d{1,4})\s+(\d.*)$/u.exec(t) : null);
    // Cam satırının açıklama devamı (sayıların ALTINDA kalan ikinci satır, ör. "REFLEKTE FÜME + ŞEFFAF" — karar 262):
    // yalnızca harf / rakam / + - . ( ) taşıyan, tutar içermeyen, yeni bir sıra numarasıyla başlamayan metin
    if (!desc && afterGlass && rows.length && !pending && isDescContinuation(t, P)) {
      const row = rows[rows.length - 1];
      row.description = `${row.description} ${t}`.replace(/\s+/g, ' ').trim();
      continue;
    }
    afterGlass = false;
    if (desc) {
      if (pending) problems.push({ code: 'ROW_INCOMPLETE', line: pending.line, text: pending.description });
      pending = { line: l.n, sno: Number(desc[1]), description: desc[2].trim() };
      continue;
    }
    // Uzun cam adının devamı (sayısız metin) — yalnızca sayıları beklenen satırda
    if (pending && !P.hasMoney.test(t)) { pending.description = `${pending.description} ${t}`.trim(); continue; }
    problems.push({ code: 'UNRECOGNIZED_LINE', line: l.n, text: t });
  }
  if (state === 'rows') { problems.push({ code: 'TABLE_END_MISSING' }); if (pending) problems.push({ code: 'ROW_INCOMPLETE', line: pending.line, text: pending.description }); }

  // ---- Toplamlar (tablodan sonra; grup özeti satır olarak okunmaz) ----
  const subtotals = [];
  for (; i < list.length; i++) {
    const t = list[i].text;
    const f = folded(t);
    const val = (label) => { const m = P.labelled(label).exec(f); return m ? money(m[1]) : null; };
    const ara = val('ARA TOPLAM');
    if (ara != null) subtotals.push(ara);
    totals.grossSum ??= val('TOPLAM TUTAR');
    totals.discount ??= val('INDIRIM TOPLAMI');
    totals.vat ??= val('KDV TUTARI');
    totals.grandTotal ??= val('GENEL TOPLAM');
  }
  if (subtotals.length === 1) totals.subtotal = subtotals[0];
  else problems.push({ code: subtotals.length ? 'SUBTOTAL_AMBIGUOUS' : 'SUBTOTAL_MISSING' });

  // ---- PDF'in kendi içinde tutarlılığı ----
  if (!rows.length && !problems.some((p) => p.code === 'NOT_FACTORY_FORM')) problems.push({ code: 'NO_ROWS' });
  rows.forEach((r, k) => {
    const n = k + 1;
    if ([r.m2, r.totalM2, r.unitPrice, r.discount, r.amount].some((v) => v == null) || r.adet <= 0) { problems.push({ code: 'ROW_UNREADABLE', row: n, line: r.line }); return; }
    if (r.m2 * r.adet !== r.totalM2) problems.push({ code: 'ROW_AREA_MISMATCH', row: n, line: r.line });
    if (Math.abs(expectedAmount(r.totalM2, r.unitPrice, r.discount) - r.amount) > 1) problems.push({ code: 'ROW_AMOUNT_MISMATCH', row: n, line: r.line });
    for (const o of r.ops) {
      if ([o.qty, o.totalQty, o.unitPrice, o.discount, o.amount].some((v) => v == null)) { problems.push({ code: 'OP_UNREADABLE', row: n, line: o.line }); continue; }
      if (Math.abs(expectedAmount(o.totalQty, o.unitPrice, o.discount) - o.amount) > 1) problems.push({ code: 'OP_AMOUNT_MISMATCH', row: n, line: o.line });
    }
  });
  if (totals.count != null && rows.length && totals.count !== rows.reduce((s, r) => s + r.adet, 0)) problems.push({ code: 'COUNT_MISMATCH' });
  if (totals.totalM2 != null && rows.length && totals.totalM2 !== rows.reduce((s, r) => s + (r.totalM2 ?? 0), 0)) problems.push({ code: 'AREA_TOTAL_MISMATCH' });
  return { header, rows, totals, problems, numberFormat };
}

/**
 * A denetimi: PDF'ten okunan net cam + işlem tutarlarının toplamı = PDF'in KDV hariç Ara Toplamı (kuruşu kuruşuna).
 * @returns {{ pdfSum: number, subtotal: number | null, ok: boolean }}
 */
export function checkSubtotal(parsed) {
  const pdfSum = parsed.rows.reduce((s, r) => s + (r.amount ?? 0) + r.ops.reduce((x, o) => x + (o.amount ?? 0), 0), 0);
  const subtotal = parsed.totals.subtotal;
  return { pdfSum, subtotal, ok: subtotal != null && pdfSum === subtotal };
}
