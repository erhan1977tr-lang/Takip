// "Sıra bende" kuyrukları (iç ekip): hangi sipariş hangi rolün önüne düşer.
// Yalnızca cam siparişleri girer — profil siparişleri satış ve çizim kuyruklarına hiç düşmez (CLAUDE.md "Profile Order").
// Beklemedeki siparişler iş kuyruklarında değil, ayrı "Beklemede" bölümünde görünür.
import { offerNeedsCheck } from './rules.js';

export const SLA_RISK_HOURS = 6;
const DRAWING_WORK = ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'];

/** @typedef {{ orderTypeCode: string, status: string, onHold: boolean, drawingTrack: string, slaDeadline: Date | null,
 *   offers: { status: string, sentAt?: Date | null }[], drawings: { createdAt: Date }[], events: { createdAt: Date }[] }} QueueRow */

/** En son teklifin durumu (teklifler en yeniden eskiye sıralı) */
export const latestOfferStatus = (o) => o.offers[0]?.status ?? null;

/** Teklif müşteriye gittikten sonra yeni çizim yüklenmiş ve yönetici henüz bakmamış */
export const needsOfferCheck = (o) =>
  (o.status === 'HAZIRLANIYOR' || o.status === 'URETIMDE') &&
  offerNeedsCheck({
    offer: latestOfferStatus(o), sentAt: o.offers[0]?.sentAt ?? null,
    lastDrawing: o.drawings[o.drawings.length - 1] ?? null, checkedAt: o.events[0]?.createdAt ?? null,
  });

/**
 * Kullanıcının yetkilerine göre kuyruklar.
 * @template {QueueRow} R
 * @param {R[]} rows  kullanıcının görebildiği aktif siparişler
 * @param {{ review: boolean, send: boolean, drawing: boolean }} can
 *   review: ORDER_REVIEW (satış kararı) · send: OFFER_SEND (yönetici fiyatı) · drawing: DRAWING_WORK (çizim ekibi)
 * @param {number} [now]
 * @returns {{ key: string, rows: R[] }[]}
 */
export function queuesFor(rows, can, now = Date.now()) {
  const glass = rows.filter((o) => o.orderTypeCode === 'GLASS_ORDER');
  const active = glass.filter((o) => !o.onHold);
  const prep = active.filter((o) => o.status === 'HAZIRLANIYOR');
  const out = [];
  if (can.review) {
    out.push({ key: 'newOrders', rows: active.filter((o) => o.status === 'YENI') });
    out.push({ key: 'offersToPrepare', rows: prep.filter((o) => { const s = latestOfferStatus(o); return s === null || s === 'HAZIRLANIYOR'; }) });
  }
  if (can.send) {
    out.push({ key: 'priceApproval', rows: prep.filter((o) => latestOfferStatus(o) === 'YONETIMDE') });
    out.push({ key: 'offerCheck', rows: active.filter(needsOfferCheck) });
  }
  if (can.drawing && !can.review) {
    out.push({ key: 'drawingJobs', rows: prep.filter((o) => DRAWING_WORK.includes(o.drawingTrack)) });
  }
  if (can.review || can.drawing) {
    out.push({ key: 'atCustomer', rows: prep.filter((o) => o.drawingTrack === 'ONAY_BEKLIYOR') });
  }
  if (can.review) {
    out.push({ key: 'production', rows: active.filter((o) => o.status === 'URETIMDE') });
  }
  out.push({ key: 'sla', rows: active.filter((o) => o.slaDeadline && o.slaDeadline.getTime() - now < SLA_RISK_HOURS * 3_600_000) });
  const held = glass.filter((o) => o.onHold);
  if (held.length) out.push({ key: 'held', rows: held });
  return out;
}
