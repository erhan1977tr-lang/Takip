// Profil iadesi (DÜZELTME 10 M8, 3.99.0) — SAF kurallar. Veritabanı tarafı server/profile/returns.js.
//
// İade edilebilir miktar: siparişin ONAYLI teklifindeki profil satırı (teslim edilen miktar) − iptal edilmemiş önceki
// iadelerin aynı satırdaki miktarı. Aynı mal iki kez iade edilemez (OVER_RETURNABLE). Satır fiyatı onaylı teklifteki satış
// fiyatıdır (kopya); tutar = adet × fiyat, bir kez yarım-yukarı 2 ondalık. Mali karşılık yalnızca müşteri ödeme yaptıysa
// seçilir (REFUND / OFFSET) ve yalnızca NİYETTİR — TAKİP seçimi gerçek para iadesi sayılmaz, FGO belgesi kesilmez.
import { lineTotal, cents, money } from '../suppliers/money.js';

export const RETURN_LIMITS = Object.freeze({ reason: 500, note: 1000, reference: 120, lines: 200, qty: 100_000, photos: 5 });
export const FINANCE_ACTIONS = Object.freeze(['REFUND', 'OFFSET']);
/** İade açılabilen aşamalar: teslim edildi (faturadan önce) ya da faturalandı */
export const RETURNABLE_STAGES = Object.freeze(['TESLIM_EDILDI', 'FATURALANDI']);

const one = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const int = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return 0;
  if (!/^\d{1,6}$/.test(s)) return null;
  return Number(s);
};

/**
 * @param {{ id: string, kind?: string, profileProductId?: string | null, adet: number, offerPrice?: unknown, description?: string, unitCode?: string | null }[]} offerLines  onaylı teklifin satırları
 * @param {{ offerLineId: string, qty: number }[]} returned  iptal edilmemiş iadelerin satırları
 * @returns {{ offerLineId: string, productId: string, delivered: number, returned: number, remaining: number, unitPrice: string | null, unitCode: string | null }[]}
 */
export function returnableLines(offerLines, returned) {
  const back = new Map();
  for (const r of returned) back.set(r.offerLineId, (back.get(r.offerLineId) ?? 0) + r.qty);
  return offerLines
    .filter((l) => l.profileProductId && (l.kind ?? 'PROFIL') === 'PROFIL' && Number(l.adet) > 0)
    .map((l) => {
      const got = back.get(l.id) ?? 0;
      return {
        offerLineId: l.id, productId: /** @type {string} */ (l.profileProductId), delivered: Number(l.adet), returned: got, remaining: Math.max(0, Number(l.adet) - got),
        unitPrice: l.offerPrice == null ? null : String(l.offerPrice), unitCode: l.unitCode ?? null,
      };
    });
}

/**
 * İade formu. Hata: REASON, TOO_LONG, QTY, EMPTY, OVER_RETURNABLE (index), NO_PRICE (index), FINANCE_ACTION.
 * @param {{ reason?: unknown, note?: unknown, quantities?: Record<string, unknown>, financeAction?: unknown }} raw
 * @param {ReturnType<typeof returnableLines>} lines
 * @param {{ paid: boolean }} ctx
 */
export function parseReturnRequest(raw, lines, { paid }) {
  const reason = one(raw.reason);
  if (!reason) return { ok: false, code: 'REASON' };
  const note = String(raw.note ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  if (reason.length > RETURN_LIMITS.reason || note.length > RETURN_LIMITS.note) return { ok: false, code: 'TOO_LONG' };
  const q = raw.quantities && typeof raw.quantities === 'object' ? raw.quantities : {};
  const out = [];
  for (const [index, l] of lines.entries()) {
    const n = int(/** @type {any} */ (q)[l.offerLineId]);
    if (n == null || n > RETURN_LIMITS.qty) return { ok: false, code: 'QTY', index };
    if (!n) continue;
    if (n > l.remaining) return { ok: false, code: 'OVER_RETURNABLE', index };
    if (l.unitPrice == null) return { ok: false, code: 'NO_PRICE', index };
    out.push({ ...l, qty: n, lineTotal: /** @type {string} */ (lineTotal(n, l.unitPrice)) });
  }
  // Bilinmeyen satır kimliği: reddedilir (başka siparişin / eski teklifin satırı iade edilemez)
  const known = new Set(lines.map((l) => l.offerLineId));
  if (Object.entries(q).some(([k, v]) => !known.has(k) && int(v))) return { ok: false, code: 'QTY' };
  if (!out.length) return { ok: false, code: 'EMPTY' };
  const fa = String(raw.financeAction ?? '').trim().toUpperCase();
  let financeAction = null;
  if (paid) {
    if (!FINANCE_ACTIONS.includes(fa)) return { ok: false, code: 'FINANCE_ACTION' };
    financeAction = fa;
  }
  const amount = money(out.reduce((s, l) => s + cents(l.lineTotal), 0n));
  return { ok: true, value: { reason, note: note || null, lines: out, amount, financeAction } };
}

/**
 * Depo teslimi: satır başına sağlam + hasarlı ≤ iade edilen; en az biri > 0. Eksik gelen (sağlam + hasarlı < iade) kaydedilir.
 * Hata: QTY (index), OVER (index), EMPTY.
 * @param {{ id: string, qty: number }[]} lines
 * @param {Record<string, { good?: unknown, damaged?: unknown }>} input
 */
export function parseReturnReceipt(lines, input) {
  const out = [];
  let total = 0;
  for (const [index, l] of lines.entries()) {
    const x = input?.[l.id] ?? {};
    const good = int(x.good), damaged = int(x.damaged);
    if (good == null || damaged == null) return { ok: false, code: 'QTY', index };
    if (good + damaged > l.qty) return { ok: false, code: 'OVER', index };
    total += good + damaged;
    out.push({ id: l.id, good, damaged, missing: l.qty - good - damaged });
  }
  if (!total) return { ok: false, code: 'EMPTY' };
  return { ok: true, lines: out };
}

/** Müşteri ödeme yapmış mı: ödeme günü işaretli, FGO'da ödenen > 0 ya da geçerli elle ödeme kaydı */
export const customerPaid = ({ paidAt, fgoPaid, manualPayments }) => !!paidAt || Number(fgoPaid ?? 0) > 0 || (manualPayments ?? 0) > 0;
