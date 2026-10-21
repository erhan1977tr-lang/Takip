// Bağımsız ticari teklifin İÇ Excel'i (3.83.0, karar 277): satış + iç maliyet + kâr + marj. Yalnızca yönetici ve yönetici
// yardımcısı indirir (rota COMMERCIAL_OFFER_MANAGE ister). Hesap computeOffer'dan (tek kural) — burada formül yok.
// Müşteri belgesi (PDF) bu veriyi KULLANMAZ: o yalnızca customerView'dan üretilir.
import { computeOffer, offerNoText, unitText, COLOR_TEXT, CRATE_KIND } from './rules.js';

const num = (v) => (v == null || v === '' ? null : Number(v));

/**
 * @param {{ no: number, version: number, status: string, draft: boolean, data: any }} o
 * @param {(key: string, params?: Record<string, unknown>) => string} t  panel dili
 * @param {{ statusText: string, locale: 'tr' | 'ro', subtitle?: string }} x
 * @returns {import('../files/xlsx-report.js').Sheet[]}
 */
export function internalSheets(o, t, x) {
  const d = o.data;
  const c = computeOffer(d);
  const k = (s) => t(`commercial.excel.col.${s}`);
  const glassCols = [
    { header: k('n'), width: 5, type: /** @type {const} */ ('int') },
    { header: k('description'), width: 34, type: /** @type {const} */ ('wrap') },
    { header: k('catalog'), width: 24, type: /** @type {const} */ ('wrap') },
    { header: k('en'), width: 9, type: /** @type {const} */ ('mm') },
    { header: k('boy'), width: 9, type: /** @type {const} */ ('mm') },
    { header: k('qty'), width: 8, type: /** @type {const} */ ('int') },
    { header: k('m2'), width: 12, type: /** @type {const} */ ('m2') },
    { header: k('price'), width: 11, type: /** @type {const} */ ('dec4') },
    { header: k('amount'), width: 14, type: /** @type {const} */ ('money'), unit: 'EUR' },
    { header: k('cost'), width: 11, type: /** @type {const} */ ('dec4') },
    { header: k('costAmount'), width: 14, type: /** @type {const} */ ('money'), unit: 'EUR' },
    { header: k('profit'), width: 14, type: /** @type {const} */ ('money'), unit: 'EUR' },
  ];
  const profileCols = [
    { header: k('n'), width: 5, type: /** @type {const} */ ('int') },
    { header: k('code'), width: 14 },
    { header: k('description'), width: 32, type: /** @type {const} */ ('wrap') },
    { header: k('color'), width: 10 },
    { header: k('meters'), width: 10, type: /** @type {const} */ ('dec2') },
    { header: k('packs'), width: 9, type: /** @type {const} */ ('int') },
    { header: k('unit'), width: 9 },
    { header: k('billQty'), width: 12, type: /** @type {const} */ ('dec3') },
    { header: k('billUnit'), width: 9 },
    { header: k('unitPrice'), width: 12, type: /** @type {const} */ ('dec4') },
    { header: k('amount'), width: 14, type: /** @type {const} */ ('money'), unit: 'EUR' },
    { header: k('unitCost'), width: 12, type: /** @type {const} */ ('dec4') },
    { header: k('costAmount'), width: 14, type: /** @type {const} */ ('money'), unit: 'EUR' },
    { header: k('profit'), width: 14, type: /** @type {const} */ ('money'), unit: 'EUR' },
  ];
  const T = c.totals;
  const hasExtras = c.glass.some((l) => l.kind === CRATE_KIND || l.ops?.length);
  const r = (s) => t(`commercial.excel.rows.${s}`);
  const summary = [
    [r('glassSale'), num(T.glass)],
    // Cam bölümünün içinden (cam satışına dahil) — yalnızca varsa (eski tekliflerin dökümü değişmez)
    ...(hasExtras ? [[r('ops'), num(T.ops)], [r('crate'), num(T.crate)]] : []),
    [r('glassCost'), num(T.glassCost)],
    [r('extra'), num(T.extraCost)],
    [r('profileSale'), num(T.profile)],
    [r('profileCost'), num(T.profileCost)],
    [r('total'), num(T.total)],
    [r('cost'), num(T.cost)],
    [r('profit'), num(T.profit)],
    [r('margin'), num(T.margin)],
    [r('missing'), T.missingCost],
  ];
  const info = (s) => t(`commercial.excel.info.${s}`);
  return [{
    name: t('commercial.excel.sheet'),
    title: t('commercial.excel.title', { no: offerNoText(o.no) }),
    subtitle: x.subtitle,
    landscape: true,
    info: [
      [info('no'), offerNoText(o.no)],
      [info('version'), o.version],
      [info('status'), x.statusText],
      [info('date'), d.date],
      [info('firm'), d.firmName],
      [info('validity'), d.validityDays],
      ...(d.note ? [[info('note'), d.note]] : []),
    ],
    blocks: [
      {
        title: t('commercial.excel.glass'),
        columns: glassCols,
        rows: glassRows(c.glass, t),
        totals: c.glass.length ? [['', '', '', '', '', null, num(T.glassM2), null, num(T.glass), null, num(T.glassCost), null]] : undefined,
        empty: t('commercial.editor.empty'),
      },
      {
        title: t('commercial.excel.profile'),
        columns: profileCols,
        rows: c.profile.map((l, i) => [
          i + 1, l.code, l.description, l.color ? COLOR_TEXT[l.color] ?? l.color : '', num(l.meters), l.qty, unitText(l.unitCode, x.locale),
          num(l.billQty), l.perMl ? 'ML' : unitText(l.unitCode, 'ro'), num(l.price), num(l.amount), num(l.cost), num(l.costAmount), num(l.profit),
        ]),
        totals: c.profile.length ? [['', '', '', '', null, null, '', null, '', null, num(T.profile), null, num(T.profileCost), null]] : undefined,
        empty: t('commercial.editor.empty'),
      },
      {
        title: t('commercial.excel.summary'),
        columns: [{ header: k('item'), width: 34 }, { header: k('value'), width: 16, type: /** @type {const} */ ('dec2') }],
        rows: summary,
      },
    ],
    notes: [t('commercial.excel.notes'), ...(hasExtras ? [t('commercial.excel.opsNote')] : [])],
  }];
}

/**
 * Cam bloğunun satırları: cam satırı numaralı (eskisiyle aynı), altındaki CNC / delik numarasız (m² boş, fiyat € / adet),
 * sandık parası numaralı ayrı kalem (maliyet 0). Numara yalnızca cam ve sandık satırlarında ilerler.
 * @param {any[]} glass  computeOffer(...).glass  @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function glassRows(glass, t) {
  const rows = [];
  let n = 0;
  for (const l of glass) {
    n += 1;
    if (l.kind === CRATE_KIND) {
      rows.push([n, t('commercial.editor.crate'), '', null, null, l.qty, null, num(l.price), num(l.amount), 0, num(l.costAmount), num(l.profit)]);
      continue;
    }
    rows.push([n, l.description, l.catalogTr ?? '', l.en, l.boy, l.qty, num(l.m2), num(l.price), num(l.amount), num(l.cost), num(l.costAmount), num(l.profit)]);
    for (const o of l.ops ?? []) {
      const label = t(`commercial.editor.op.${o.kind}`);
      rows.push(['', o.description ? `${label} – ${o.description}` : label, '', null, null, o.qty, null, num(o.price), num(o.amount), num(o.cost), num(o.costAmount), num(o.profit)]);
    }
  }
  return rows;
}
