// Sandıklar (yükleme sekmesi): satış ya da yönetici, bir yükleme günü + müşteri için sandıkları girer:
// sandık no, uzunluk / genişlik / yükseklik (mm), net ve brüt ağırlık (kg), not ve sandıktaki siparişler.
// Sandık no o gün içinde tektir (müşteriler arasında da). Girilen sandıklar o müşterinin o günkü tahminin önüne geçer.
import { writeAudit, writeHistory } from '../orders/journal.js';
import { CRATE_MAX_KG, CRATE_TARE_KG, dayKey } from '../orders/loading.js';

export const MAX_CRATES = 60;
export const MAX_CRATE_NO = 999;
export const MAX_DIM_MM = 10_000;
export const MAX_KG = 20_000;

const clean = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => {
  const s = clean(v).replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
};

/**
 * Formdan gelen sandık satırlarını doğrular. Tamamen boş satır atlanır.
 * @param {{ crateNo?: unknown, lengthMm?: unknown, widthMm?: unknown, heightMm?: unknown, netKg?: unknown, grossKg?: unknown, note?: unknown, orderIds?: unknown[] }[]} raw
 * @returns {{ ok: true, rows: CrateInput[] } | { ok: false, errors: { row: number, code: string }[] }}
 *   hata kodları: NO (sandık no 1–999 tam sayı), DUPLICATE_NO, DIM, WEIGHT, GROSS_LT_NET, NOTE, TOO_MANY
 * @typedef {{ crateNo: number, lengthMm: number | null, widthMm: number | null, heightMm: number | null, netKg: number | null, grossKg: number | null, note: string | null, orderIds: string[] }} CrateInput
 */
export function validateCrates(raw) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((r, i) => {
    const row = i + 1;
    const vals = ['crateNo', 'lengthMm', 'widthMm', 'heightMm', 'netKg', 'grossKg', 'note'].map((k) => clean(r[k]));
    if (vals.every((v) => v === '')) return;
    const no = num(r.crateNo);
    if (!Number.isInteger(no) || no < 1 || no > MAX_CRATE_NO) errors.push({ row, code: 'NO' });
    else if (seen.has(no)) errors.push({ row, code: 'DUPLICATE_NO' });
    else seen.add(no);
    const dims = [r.lengthMm, r.widthMm, r.heightMm].map(num);
    if (dims.some((d) => d != null && (!Number.isInteger(d) || d < 1 || d > MAX_DIM_MM))) errors.push({ row, code: 'DIM' });
    const net = num(r.netKg);
    const gross = num(r.grossKg);
    if ([net, gross].some((w) => w != null && (Number.isNaN(w) || w > MAX_KG))) errors.push({ row, code: 'WEIGHT' });
    else if (net != null && gross != null && gross < net) errors.push({ row, code: 'GROSS_LT_NET' });
    const note = clean(r.note);
    if (note.length > 200) errors.push({ row, code: 'NOTE' });
    rows.push({
      crateNo: no, lengthMm: dims[0], widthMm: dims[1], heightMm: dims[2],
      netKg: net == null ? null : Math.round(net * 100) / 100, grossKg: gross == null ? null : Math.round(gross * 100) / 100,
      note: note || null, orderIds: [...new Set((r.orderIds ?? []).map(clean).filter(Boolean))],
    });
  });
  if (rows.length > MAX_CRATES) errors.push({ row: MAX_CRATES + 1, code: 'TOO_MANY' });
  return errors.length ? { ok: false, errors } : { ok: true, rows };
}

/**
 * Bir müşterinin bir günlük yükü: siparişlerin yükleri + girilmiş sandıklar.
 * Sandık girildiyse net/brüt/sandık sayısı sandıklardan (net boşsa camın tahmini ağırlığı sandıklara eşit bölünür,
 * brüt boşsa net + dara); girilmediyse tahmin (cam ağırlığı CRATE_MAX_KG'ye bölünüp yukarı yuvarlanır).
 * @param {{ metraj: number, camAdet: number, cnc?: number, delik?: number, netKg: number }[]} loads  siparişlerin tahmini yükleri
 * @param {{ netAgirlik?: unknown, brutAgirlik?: unknown, daraKg?: unknown }[]} crates
 */
export function groupLoad(loads, crates = []) {
  let metraj = 0, camAdet = 0, cnc = 0, delik = 0, glassKg = 0;
  for (const l of loads) {
    metraj = Math.round((metraj + l.metraj) * 100) / 100;
    camAdet += l.camAdet;
    cnc += l.cnc ?? 0;
    delik += l.delik ?? 0;
    glassKg += l.netKg;
  }
  const base = { orders: loads.length, metraj, camAdet, cnc, delik };
  if (crates.length > 0) {
    const share = glassKg / crates.length;
    const kg = (v) => (v == null || v === '' ? null : Number(v));
    let netKg = 0, grossKg = 0;
    for (const c of crates) {
      const net = kg(c.netAgirlik) ?? share;
      netKg += net;
      grossKg += kg(c.brutAgirlik) ?? net + (kg(c.daraKg) ?? CRATE_TARE_KG);
    }
    return { ...base, netKg: Math.round(netKg), grossKg: Math.round(grossKg), crates: crates.length, realCrates: true, estimatedCrates: 0, estimatedNetKg: 0 };
  }
  const n = glassKg > 0 ? Math.ceil(glassKg / CRATE_MAX_KG) : 0;
  return { ...base, netKg: glassKg, grossKg: glassKg + n * CRATE_TARE_KG, crates: n, realCrates: false, estimatedCrates: n, estimatedNetKg: glassKg };
}

/** "YYYY-MM-DD" → o günün veritabanı tarihi (@db.Date) */
export const dayDate = (day) => new Date(`${day}T00:00:00Z`);

/** Müşterinin o gün yüklenecek siparişleri (iptal ve bekleyenler hariç). */
export async function dayOrders(tx, customerId, day) {
  const d = dayDate(day);
  const list = await tx.order.findMany({
    where: {
      customerId, status: { not: 'IPTAL' },
      OR: [
        { actualShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
        { actualShipDate: null, estimatedShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
      ],
    },
    select: { id: true, orderNo: true, status: true, actualShipDate: true, estimatedShipDate: true },
  });
  return list.filter((o) => dayKey(o.actualShipDate ?? o.estimatedShipDate) === day);
}

/**
 * Bir müşterinin bir günlük sandıklarını kaydeder (hepsi birden; eksik satır silinir).
 * Sandık numarası o gün başka müşteride kullanılıyorsa kaydedilmez. Siparişler o müşterinin o günkü siparişleri olmalı.
 * Denetim kaydına önce/sonra, ilgili siparişlerin geçmişine "sandıklar güncellendi" yazılır.
 * @param {CrateInput[]} rows  validateCrates() sonucu
 * @returns {Promise<{ ok: true, count: number } | { ok: false, code: 'NO_ORDERS' | 'NUMBER_TAKEN' | 'BAD_ORDER', numbers?: number[] }>}
 */
export async function saveDayCrates(db, { day, customerId, rows, actor }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${day}`}, 0))`;
    const orders = await dayOrders(tx, customerId, day);
    const before = await tx.crate.findMany({ where: { shipDay: dayDate(day), customerId }, include: { orders: true }, orderBy: { crateNo: 'asc' } });
    if (orders.length === 0 && before.length === 0) return { ok: false, code: 'NO_ORDERS' };
    const valid = new Set(orders.map((o) => o.id));
    if (rows.some((r) => r.orderIds.some((id) => !valid.has(id)))) return { ok: false, code: 'BAD_ORDER' };
    const others = await tx.crate.findMany({ where: { shipDay: dayDate(day), NOT: { customerId } }, select: { crateNo: true } });
    const taken = new Set(others.map((c) => c.crateNo));
    const clash = rows.map((r) => r.crateNo).filter((n) => taken.has(n));
    if (clash.length) return { ok: false, code: 'NUMBER_TAKEN', numbers: clash };

    await tx.crate.deleteMany({ where: { shipDay: dayDate(day), customerId } });
    for (const r of rows) {
      // Tek siparişli günde sandık o siparişindir
      const orderIds = r.orderIds.length ? r.orderIds : orders.length === 1 ? [orders[0].id] : [];
      await tx.crate.create({
        data: {
          shipDay: dayDate(day), customerId, crateNo: r.crateNo, lengthMm: r.lengthMm, widthMm: r.widthMm, heightMm: r.heightMm,
          netAgirlik: r.netKg, brutAgirlik: r.grossKg, note: r.note, updatedById: actor.id,
          orders: { create: orderIds.map((orderId) => ({ orderId })) },
        },
      });
    }
    const brief = (c) => ({
      no: c.crateNo, l: c.lengthMm ?? null, w: c.widthMm ?? null, h: c.heightMm ?? null,
      net: c.netAgirlik != null ? Number(c.netAgirlik) : c.netKg ?? null, gross: c.brutAgirlik != null ? Number(c.brutAgirlik) : c.grossKg ?? null,
      orders: c.orders ? c.orders.map((o) => o.orderId) : c.orderIds,
    });
    await writeAudit(tx, {
      action: 'CRATES_SAVE', entityType: 'Customer', entityId: customerId, userId: actor.id,
      details: { day, before: before.map(brief), after: rows.map(brief) },
    }, actor);
    for (const o of orders) {
      await writeHistory(tx, { orderId: o.id, event: 'CRATES', from: o.status, to: o.status, actorId: actor.id, note: String(rows.length) });
    }
    return { ok: true, count: rows.length };
  });
}
