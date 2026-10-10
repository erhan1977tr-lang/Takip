// Telafi etiketi ve bedelsiz telafinin ticari / fiziksel ayrımı (Paket C — karar 231). Saf kurallar + tek okuma işlevi.
//
// Etiket: telafi satırı (OfferLine.compensationId) gerçek telafi numarasını taşır — teklif tablolarında, teklif PDF'inde
// ve Excel'inde cam türünün ÜSTÜNDE. Kaynak tek yer: Compensation.
//   · Yeni telafi siparişi (destType NEW): hedef siparişin numarası (ALE46-T2 — compOrderNo)
//   · Var olan siparişe eklenen telafi (destType EXISTING): ayrı bir -T numarası YOKTUR; etiket kaynak siparişin numarasıyla
//     "ALE46 telafisi" yazılır (numara uydurulmaz).
// Bedelsiz telafi: müşteri fiyatı 0 — faturalanacak miktara / satışa eklenmez (faturada glassGroups bedelsiz satırı zaten
// atlar), ama fiziksel olarak üretilir ve yüklenir. Teklifin altında fiziksel ve faturalanacak adet / m² ayrı yazılır.
import { isM2Glass, offerLineTotals } from './rules.js';

/**
 * @param {{ destType: string, destOrder?: { orderNo: string } | null, sourceOrder?: { orderNo: string } | null } | null | undefined} c
 * @returns {{ kind: 'NEW', no: string } | { kind: 'EXISTING', source: string } | null}
 */
export function compensationTag(c) {
  if (!c) return null;
  if (c.destType === 'NEW' && c.destOrder?.orderNo) return { kind: 'NEW', no: c.destOrder.orderNo };
  if (c.sourceOrder?.orderNo) return { kind: 'EXISTING', source: c.sourceOrder.orderNo };
  return null;
}

/** Etiketin metni (i18n kalıpları çağırandan: new "Telafi {no}", existing "{source} telafisi") */
export function compensationTagText(tag, { newText, existingText }) {
  if (!tag) return '';
  return tag.kind === 'NEW' ? newText.replace('{no}', tag.no) : existingText.replace('{source}', tag.source);
}

/**
 * Teklif satırlarındaki telafilerin etiketleri — tek sorgu. Map: compensationId → etiket.
 * @param {any} db  @param {{ compensationId?: string | null }[]} lines
 */
export async function loadCompensationTags(db, lines) {
  const ids = [...new Set(lines.map((l) => l.compensationId).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.compensation.findMany({
    where: { id: { in: ids } },
    select: { id: true, destType: true, destOrder: { select: { orderNo: true } }, sourceOrder: { select: { orderNo: true } } },
  });
  return new Map(rows.map((c) => [c.id, compensationTag(c)]));
}

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/**
 * Fiziksel ve faturalanacak cam (m² cam satırları): fiziksel = bütün cam satırları; faturalanacak = bedelsiz olmayanlar.
 * Hesap teklifin kuralıdır (offerLineTotals); bedelsiz telafi fizikselde sayılır, faturalanacakta sayılmaz.
 * @param {object[]} lines
 * @returns {{ physical: { pieces: number, m2: number }, billable: { pieces: number, m2: number }, free: { pieces: number, m2: number } }}
 */
export function physicalVsBillable(lines) {
  const physical = { pieces: 0, m2: 0 }, billable = { pieces: 0, m2: 0 }, free = { pieces: 0, m2: 0 };
  for (const l of lines) {
    if (!isM2Glass(l)) continue;
    const pieces = Number(l.adet) || 0;
    const m2 = offerLineTotals({ ...l, unitPrice: '0' }).metraj;
    for (const t of l.free ? [physical, free] : [physical, billable]) {
      t.pieces += pieces;
      t.m2 = round3(t.m2 + m2);
    }
  }
  return { physical, billable, free };
}
