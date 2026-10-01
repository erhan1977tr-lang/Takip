// Sunucu ve istemcide ortak kullanılan, sözlük parçası alan biçimlendiriciler (sözlüklerin tamamını içe aktarmaz).
import { interpolate } from './interpolate.js';

/**
 * offerProblems() çıktısını metne çevirir.
 * @param {any[]} problems
 * @param {{ offerProblems: Record<string, string>, lineKind: Record<string, string> }} m
 * @returns {string[]}
 */
export function formatOfferProblems(problems, m) {
  const kind = (k) => m.lineKind[k] ?? k;
  const row = (r) => (r.kind === 'CAM'
    ? `${interpolate(m.offerProblems.rowGlass, { n: r.n })}${r.desc ? ` (${r.desc})` : ''}`
    : interpolate(m.offerProblems.rowSub, { n: r.n, kind: kind(r.kind) }));
  return problems.map((p) => {
    if (p.code === 'sub_without_glass') return interpolate(m.offerProblems.subWithoutGlass, { kind: kind(p.kind) });
    if (p.code === 'missing_dims') return interpolate(m.offerProblems.missingDims, { row: row(p.row) });
    if (p.code === 'missing_prices') return interpolate(m.offerProblems.missingPrices, { count: p.rows.length, rows: p.rows.map(row).join(', ') });
    return m.offerProblems.noLines;
  });
}
