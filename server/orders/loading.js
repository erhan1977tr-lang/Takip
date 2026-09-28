// Yükleme planı hesapları — Next.js'ten bağımsız, birim testli.
//
// Planlama tahmini: cam ağırlığı = metraj × cam m² ağırlığı (açıklamadaki kalınlıktan; 2,5 kg/m² her mm için).
// Sandık tahmini: cam ağırlığı azami 1700 kg'a bölünüp yukarı yuvarlanır; brüt = cam + sandık × 50 kg dara.
// Satış siparişe sandık ölçü/ağırlık girdiyse o siparişte GERÇEK kayıtlar kullanılır ve tahminin önüne geçer.

import { offerLineTotals } from './rules.js';

export const CRATE_MAX_KG = 1700;
export const CRATE_TARE_KG = 50;
export const DEFAULT_KG_PER_M2 = 20; // kalınlık anlaşılamazsa 8 mm kabul edilir
const TZ = 'Europe/Bucharest';

/**
 * Cam açıklamasından m² ağırlığı (kg). "8mm Temperli" → 20; "44.2 Lamine" → 4+4 mm cam + 2 PVB ≈ 20,8.
 * @param {string} description
 * @returns {number|null} anlaşılamazsa null
 */
export function glassKgPerM2(description) {
  const s = String(description || '').toLowerCase();
  const lam = /(?:^|[^\d.])(\d)(\d)\.(\d)(?![\d])/.exec(s); // 33.1, 44.2, 55.2, 66.2, 88.4 ...
  if (lam) return round2((Number(lam[1]) + Number(lam[2])) * 2.5 + Number(lam[3]) * 0.4);
  const mm = /(\d+(?:[.,]\d+)?)\s*mm/.exec(s);
  if (mm) {
    const t = Number(mm[1].replace(',', '.'));
    if (t > 0 && t <= 40) return round2(t * 2.5);
  }
  return null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Bir siparişin yükü.
 * @param {{
 *   lines?: {description: string, enMm?: number|null, boyMm?: number|null, adet: number, unit?: string, unitPrice?: any}[],
 *   items?: {camAdedi: number}[],
 *   crates?: {netAgirlik?: any, brutAgirlik?: any, daraKg?: any}[],
 * }} p
 * @returns {{metraj: number, camAdet: number, netKg: number, crates: number, grossKg: number, realCrates: boolean}}
 */
export function orderLoad({ lines = [], items = [], crates = [] }) {
  let metraj = 0, camAdet = 0, glassKg = 0;
  const glassLines = lines.filter((l) => (l.unit ?? 'm2') === 'm2');
  for (const l of glassLines) {
    const m = offerLineTotals({ ...l, unit: 'm2', unitPrice: 0 }).metraj;
    metraj = round2(metraj + m);
    camAdet += Math.max(0, Math.trunc(num(l.adet)));
    glassKg += m * (glassKgPerM2(l.description) ?? DEFAULT_KG_PER_M2);
  }
  if (glassLines.length === 0) camAdet = items.reduce((s, it) => s + Math.max(0, it.camAdedi || 0), 0);
  glassKg = Math.round(glassKg);

  if (crates.length > 0) {
    const netKg = Math.round(crates.reduce((s, c) => s + (c.netAgirlik != null ? num(c.netAgirlik) : glassKg / crates.length), 0));
    const grossKg = Math.round(crates.reduce((s, c) => {
      const net = c.netAgirlik != null ? num(c.netAgirlik) : glassKg / crates.length;
      return s + (c.brutAgirlik != null ? num(c.brutAgirlik) : net + (c.daraKg != null ? num(c.daraKg) : CRATE_TARE_KG));
    }, 0));
    return { metraj, camAdet, netKg, crates: crates.length, grossKg, realCrates: true };
  }
  const n = glassKg > 0 ? Math.ceil(glassKg / CRATE_MAX_KG) : 0;
  return { metraj, camAdet, netKg: glassKg, crates: n, grossKg: glassKg + n * CRATE_TARE_KG, realCrates: false };
}

/**
 * Siparişleri bir grupta toplar. Gerçek sandığı olmayan siparişlerin camı birlikte sandıklanır
 * (aynı müşterinin camları aynı sandığa girebilir), bu yüzden tahmini sandık sayısı grup düzeyinde hesaplanır.
 * @param {ReturnType<typeof orderLoad>[]} loads
 */
export function sumLoads(loads) {
  let metraj = 0, camAdet = 0, netKg = 0, realCrates = 0, realGross = 0, estNet = 0;
  for (const l of loads) {
    metraj = round2(metraj + l.metraj);
    camAdet += l.camAdet;
    netKg += l.netKg;
    if (l.realCrates) { realCrates += l.crates; realGross += l.grossKg; } else estNet += l.netKg;
  }
  const est = estNet > 0 ? Math.ceil(estNet / CRATE_MAX_KG) : 0;
  return {
    orders: loads.length, metraj, camAdet, netKg,
    crates: realCrates + est, grossKg: realGross + estNet + est * CRATE_TARE_KG,
    estimatedCrates: est, estimatedNetKg: estNet,
  };
}

/** Tarihin Romanya saatine göre günü: "YYYY-MM-DD". */
export function dayKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

/** "YYYY-MM" geçerliyse döner, değilse null. */
export function parseMonth(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2]}`;
}

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Pazartesiden başlayan takvim ızgarası: haftalar × 7 gün ("YYYY-MM-DD", o aya ait mi).
 * @param {string} ym "YYYY-MM"
 * @returns {{key: string, day: number, inMonth: boolean}[][]}
 */
export function monthGrid(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Pazartesi = 0
  const start = new Date(Date.UTC(y, m - 1, 1 - offset));
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getTime() + (w * 7 + i) * 86_400_000);
      week.push({ key: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() === m - 1 });
    }
    if (w >= 4 && !week.some((x) => x.inMonth)) break;
    weeks.push(week);
  }
  return weeks;
}

/** Izgaranın kapsadığı aralık (sorgu için; saat dilimi kaymasına karşı bir gün pay bırakılır). */
export function gridRange(ym) {
  const g = monthGrid(ym);
  const from = new Date(`${g[0][0].key}T00:00:00Z`);
  const last = g[g.length - 1][6].key;
  const to = new Date(`${last}T00:00:00Z`);
  return { from: new Date(from.getTime() - 86_400_000), to: new Date(to.getTime() + 2 * 86_400_000) };
}
