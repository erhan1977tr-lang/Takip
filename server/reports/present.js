// Rapor sonucunun gösterimi (3.89.0, karar 284) — panel ve Excel AYNI hücre metnini buradan alır; Telegram için kısa özet.
// Değer hesaplanmaz: rapor servisinin (server/reports/service.js) sayıları olduğu gibi yazılır. Eksik değer (null) boş /
// "—" gösterilir, asla sıfır yazılmaz.

/** "YYYY-MM-DD" → "GG.AA.YYYY" */
export const dayText = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : d ?? '');
/** "YYYY-MM" → "AA.YYYY" */
export const monthText = (m) => (typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? `${m.slice(5, 7)}.${m.slice(0, 4)}` : m ?? '');

/**
 * Kod / not / gün hücresinin metni (sayı sütunları sayı kalır).
 * @param {{ type: string, dict?: string }} col @param {unknown} v @param {(key: string, p?: Record<string, unknown>) => string} t
 * @returns {string | number | null}
 */
export function cellLabel(col, v, t) {
  if (v == null || v === '') return null;
  if (col.type === 'day') return dayText(String(v));
  if (col.type === 'month') return monthText(String(v));
  if (col.type === 'code') {
    const s = String(v);
    if (col.dict === 'status') return t(`status.order.${s}`);
    if (col.dict === 'supplierStatus') return t(`supplier.status.${s}`);
    return t(`reports.val.${col.dict}.${s}`);
  }
  if (col.type === 'note') {
    const s = String(v);
    if (s.startsWith('REPLAN:')) return t('reports.val.note.REPLAN', { day: dayText(s.slice(7)) });
    return t(`reports.val.note.${s}`);
  }
  return typeof v === 'number' ? v : String(v);
}
const NUMERIC = new Set(['int', 'm2', 'money', 'dec3']);
export const isNumericCol = (c) => NUMERIC.has(c.type);

/** Filtrelerin okunur metni */
export function filtersText(report, t) {
  const f = report.filters;
  const parts = [];
  if (f.customer) parts.push(`${t('reports.filter.customer')}: ${f.customer.name}`);
  if (f.orderType !== 'ALL') parts.push(`${t('reports.filter.orderType')}: ${t(`reports.types.${f.orderType}`)}`);
  if (f.status) parts.push(`${t('reports.filter.status')}: ${t(`status.order.${f.status}`)}`);
  if (f.product) parts.push(`${t('reports.filter.product')}: ${f.product}`);
  if (f.loading !== 'ALL') parts.push(`${t('reports.filter.loading')}: ${t(`reports.loadingStates.${f.loading}`)}`);
  return parts.length ? parts.join(' · ') : t('reports.excel.none');
}

const XLSX_TYPE = { int: 'int', m2: 'm2', money: 'money', dec3: 'dec3', day: 'text', month: 'text', code: 'text', note: 'wrap', text: 'text', currency: 'text' };
const WIDTH = { int: 11, m2: 13, money: 15, dec3: 11, day: 12, month: 10, code: 16, note: 34, text: 22, currency: 9 };

/**
 * Excel sayfaları: özet sayfası (bilgi + özet değerler + açıklamalar) ve her tablo için ayrı sayfa — hücreler ekrandakiyle
 * aynı değerler. Büyük raporlarda satır sayısı servis sınırlarıyla (REPORT_LIMITS) sınırlıdır.
 * @param {any} report @param {(key: string, p?: Record<string, unknown>) => string} t
 * @param {{ subtitle?: string, generatedText: string }} o
 * @returns {import('../files/xlsx-report.js').Sheet[]}
 */
export function reportSheets(report, t, { subtitle, generatedText }) {
  const kind = t(`reports.kinds.${report.kind}`);
  const info = [
    [t('reports.excel.info.report'), kind],
    [t('reports.excel.info.range'), `${dayText(report.range.from)} – ${dayText(report.range.to)}`],
    [t('reports.excel.info.basis'), t(`reports.basis.${report.basis}`)],
    [t('reports.excel.info.filters'), filtersText(report, t)],
    [t('reports.excel.info.generated'), generatedText],
  ];
  // Değer türüne göre kendi sütununda (adet tamsayı, m² 3 ondalık, tutar 2 ondalık + para birimi)
  const cardRows = report.cards.map((c) => [cardLabel(c, t), c.type === 'int' ? c.value : null, c.type === 'm2' ? c.value : null, c.type === 'money' ? c.value : null,
    c.unit ?? null, c.value == null ? (c.note ? t(`reports.val.note.${c.note}`) : t('reports.missing')) : null]);
  const notes = report.notes.map((n) => t(`reports.notes.${n}`, { n: report.counts?.outside ?? 0 }));
  const sheets = [{
    name: t('reports.excel.sheet'),
    title: t('reports.excel.title', { kind }),
    subtitle,
    info,
    blocks: [{
      title: t('reports.excel.cards'),
      columns: [
        { header: t('reports.excel.cards'), width: 34 }, { header: t('reports.col.pcs'), width: 12, type: /** @type {const} */ ('int') },
        { header: 'm²', width: 14, type: /** @type {const} */ ('m2') }, { header: t('reports.col.sale'), width: 16, type: /** @type {const} */ ('money') },
        { header: t('reports.col.currency'), width: 10 }, { header: t('reports.col.note'), width: 36, type: /** @type {const} */ ('wrap') },
      ],
      rows: cardRows,
    }],
    notes,
  }];
  const used = new Set([sheets[0].name]);
  for (const tb of report.tables) {
    let name = t(`reports.tables.${tb.key}`).slice(0, 31);
    while (used.has(name)) name = `${name.slice(0, 28)}_${used.size}`;
    used.add(name);
    const rowsOf = (rows) => rows.map((r) => tb.columns.map((c, i) => (isNumericCol(c) ? r[i] : cellLabel(c, r[i], t))));
    sheets.push({
      name,
      title: `${kind} — ${t(`reports.tables.${tb.key}`)}`,
      subtitle,
      info: [[t('reports.excel.info.range'), `${dayText(report.range.from)} – ${dayText(report.range.to)}`], [t('reports.excel.info.basis'), t(`reports.basis.${tb.basis ?? report.basis}`)], [t('reports.excel.info.filters'), filtersText(report, t)]],
      landscape: tb.columns.length > 7,
      blocks: [{
        columns: tb.columns.map((c) => ({ header: t(`reports.col.${c.key}`), width: WIDTH[c.type] ?? 14, type: /** @type {any} */ (XLSX_TYPE[c.type] ?? 'text') })),
        rows: rowsOf(tb.rows),
        ...(tb.totals?.length ? { totals: rowsOf(tb.totals).map((r) => (r[0] === '' || r[0] == null ? [t('reports.totals'), ...r.slice(1)] : r)) } : {}),
        empty: t('reports.filter.empty'),
      }],
    });
  }
  return sheets;
}

/** Özet kartının etiketi */
export const cardLabel = (c, t) => t(`reports.col.${c.key}`);

/**
 * Telegram asistanı için KISA özet: aralık, esas tarih, filtreler, özet değerler ve her tablonun ilk satırları (anahtarlı
 * nesneler). Sayılar servisin sayılarıdır — model yeniden hesaplamaz. Satır sayısı ve kısaltma açıkça yazılır.
 * @param {any} report @param {{ rows?: number, tables?: string[] }} [o]
 */
export function reportForAi(report, { rows = 8, tables, maxChars = 9000 } = {}) {
  // Mesaj / jeton maliyeti sınırlı: özet sığmazsa tablo başına satır azaltılır (toplamlar ve satır sayısı hep kalır)
  for (const n of [rows, 5, 3, 1, 0]) {
    if (n > rows) continue;
    const out = aiSummary(report, n, tables);
    if (JSON.stringify(out).length <= maxChars || n === 0) return out;
  }
  return aiSummary(report, 0, tables);
}
function aiSummary(report, rows, tables) {
  const pick = (tb) => tb.rows.slice(0, rows).map((r) => Object.fromEntries(tb.columns.map((c, i) => [c.key, r[i]]).filter(([, v]) => v !== null && v !== '')));
  const tot = (tb) => (tb.totals ?? []).map((r) => Object.fromEntries(tb.columns.map((c, i) => [c.key, r[i]]).filter(([, v]) => v !== null && v !== '')));
  return {
    rapor: report.kind,
    aralik: report.range,
    esasTarih: report.basis,
    filtreler: {
      ...(report.filters.customer ? { musteri: report.filters.customer.name } : {}),
      ...(report.filters.orderType !== 'ALL' ? { tur: report.filters.orderType } : {}),
      ...(report.filters.status ? { durum: report.filters.status } : {}),
      ...(report.filters.product ? { urun: report.filters.product } : {}),
      ...(report.filters.loading !== 'ALL' ? { yukleme: report.filters.loading } : {}),
    },
    ozet: report.cards.map((c) => ({ [c.key]: c.value, ...(c.unit ? { birim: c.unit } : {}), ...(c.value == null ? { eksikVeri: c.note ?? true } : {}) })),
    tablolar: report.tables.filter((tb) => !tables || tables.includes(tb.key)).map((tb) => ({
      ad: tb.key, satirSayisi: tb.rows.length, ...(tb.rows.length > rows ? { gosterilen: rows } : {}), ...(rows > 0 ? { satirlar: pick(tb) } : {}), ...(tb.totals?.length ? { toplam: tot(tb) } : {}),
    })),
    notlar: report.notes,
    ...(report.counts ? { sayaclar: report.counts } : {}),
  };
}
