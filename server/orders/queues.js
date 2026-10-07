// "Sıra bende" kuyrukları (iç ekip): hangi sipariş hangi rolün önüne düşer.
// Satış ve çizim kuyruklarına yalnızca cam siparişleri girer — profil siparişleri satış ve çizim kuyruklarına hiç düşmez
// (CLAUDE.md "Profile Order"); onların kuyrukları yalnızca yöneticidedir (profileQueues).
// Beklemedeki siparişler iş kuyruklarında değil, ayrı "Beklemede" bölümünde görünür.
import { offerNeedsCheck } from './rules.js';

export const SLA_RISK_HOURS = 6;
/**
 * Satışın "Sıra bende" bölümleri (karar 155): yalnızca karar bekleyen yeni siparişler ve SLA riski / gecikenler.
 * Teklif işleri Teklifler sayfasındadır (salesOfferGroups); öteki siparişler "Tüm aktif siparişler" sekmesinde durur.
 */
export const SALES_QUEUES = ['newOrders', 'sla'];
const DRAWING_WORK = ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'];

/** @typedef {{ orderTypeCode: string, status: string, onHold: boolean, drawingTrack: string, slaDeadline: Date | null, assignedDrawerId?: string | null,
 *   offers: { status: string, sentAt?: Date | null }[], drawings: { version: number, createdAt: Date, sentAt?: Date | null }[], events: { createdAt: Date }[] }} QueueRow */

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
 * @param {{ review: boolean, send: boolean, drawing: boolean, userId?: string, allDrawers?: boolean }} can
 *   review: ORDER_REVIEW (satış kararı) · send: OFFER_SEND (yönetici fiyatı) · drawing: DRAWING_WORK (çizim ekibi)
 *   allDrawers: çizim ekibinin panelini ekibin tamamı için gören (yönetici — "Çizim Paneli"): yapılacak çizimler kime
 *   atanmış olursa olsun listelenir; kişiye özel "Benim çizimlerim" bölümü olmaz
 * @param {number} [now]
 * @returns {{ key: string, rows: R[] }[]}
 */
export function queuesFor(rows, can, now = Date.now()) {
  const out = buildQueues(rows, can, now);
  // Her kuyrukta süresi geçenler en üstte, sonra son tarihi en yakın olanlar (SLA'sız olanlar sonda)
  return out.map((q) => ({ ...q, rows: bySla(q.rows, now) }));
}

/** Süresi geçenler önce; sonra son tarihe göre; SLA'sızlar sonda (sıralama kararlı). */
export function bySla(rows, now = Date.now()) {
  const key = (o) => (o.slaDeadline ? new Date(o.slaDeadline).getTime() : Infinity);
  return [...rows].sort((a, b) => {
    const oa = key(a) < now ? 0 : 1;
    const ob = key(b) < now ? 0 : 1;
    return oa - ob || key(a) - key(b);
  });
}

function buildQueues(rows, can, now) {
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
    // Çizilecekler: bana atanmış ya da henüz kimseye atanmamış işler
    const mineOrOpen = (o) => can.allDrawers || !o.assignedDrawerId || o.assignedDrawerId === can.userId;
    out.push({ key: 'drawingJobs', rows: prep.filter((o) => DRAWING_WORK.includes(o.drawingTrack) && mineOrOpen(o)) });
  }
  if (can.review || can.drawing) {
    out.push({ key: 'atCustomer', rows: prep.filter((o) => o.drawingTrack === 'ONAY_BEKLIYOR') });
  }
  if (can.drawing && !can.review && can.userId && !can.allDrawers) {
    out.push({ key: 'myDrawings', rows: prep.filter((o) => o.drawingTrack !== 'YOK' && o.assignedDrawerId === can.userId) });
  }
  if (can.drawing || can.review) {
    // Müşterinin onayladığı çizimler (sipariş hazırlanırken ya da üretimdeyken): çizim ekibi ve yönetici görür (karar 84);
    // satışın "Sıra bende"sinde bu bölüm yoktur (karar 155 — aşağıdaki SALES_QUEUES süzgeci). Yükleme gününe göre süzme
    // ve en yeni / en eski sıralaması sayfada (approvedDrawingList).
    out.push({ key: 'approvedDrawings', rows: active.filter((o) => o.drawingTrack === 'ONAYLANDI' && (o.status === 'HAZIRLANIYOR' || o.status === 'URETIMDE')) });
  }
  if (can.review) {
    out.push({ key: 'production', rows: active.filter((o) => o.status === 'URETIMDE') });
  }
  out.push({ key: 'sla', rows: active.filter((o) => o.slaDeadline && o.slaDeadline.getTime() - now < SLA_RISK_HOURS * 3_600_000) });
  const held = glass.filter((o) => o.onHold);
  if (held.length) out.push({ key: 'held', rows: held });
  if (can.send) out.push(...profileQueues(rows));
  // Satış (satış kararı yetkisi var, fiyat onayı yetkisi yok): yalnızca SALES_QUEUES. Yönetici ve çizim ekibi etkilenmez.
  if (can.review && !can.send) return out.filter((q) => SALES_QUEUES.includes(q.key));
  return out;
}

/**
 * Satışın Teklifler sayfası (karar 155) — yalnızca iki liste, yalnızca cam siparişleri:
 *   awaitingPrice — "Fiyatımı bekleyenler": teklif tablosu açılmış ve teklif hâlâ satışta (HAZIRLANIYOR)
 *   notOpened     — "Teklif tablosu açılmamış siparişler": henüz karar verilmemiş (YENI) ya da teklifi hiç olmayan sipariş
 * Yönetici onayındaki ve müşterideki teklifler satışın bu sayfasında listelenmez. Kapanmış (yüklenmiş / arşiv / iptal)
 * siparişler çağıranın sorgusunda elenir; burada da sayılmaz.
 * @template {{ orderTypeCode: string, status: string, offers: { status: string }[] }} R
 * @param {R[]} rows
 * @returns {{ key: 'awaitingPrice' | 'notOpened', rows: R[] }[]}
 */
export function salesOfferGroups(rows) {
  const open = rows.filter((o) => o.orderTypeCode === 'GLASS_ORDER' && !['YUKLENDI', 'ARSIVLENDI', 'IPTAL'].includes(o.status));
  const notOpened = (o) => o.status === 'YENI' || latestOfferStatus(o) === null;
  return [
    { key: 'awaitingPrice', rows: open.filter((o) => !notOpened(o) && latestOfferStatus(o) === 'HAZIRLANIYOR') },
    { key: 'notOpened', rows: open.filter(notOpened) },
  ];
}

/**
 * "Müşteri tarafından onaylanmış çizimler" listesi: yükleme gününe göre süzülür (day: YYYY-AA-GG; boş = hepsi),
 * yükleme gününe göre gruplanır, grup içinde onay zamanına göre en yeni (varsayılan) ya da en eski üstte.
 * @template {{ estimatedShipDate: Date | null, drawingSince?: Date | null }} R
 * @param {R[]} rows
 * @param {{ day?: string | null, oldest?: boolean, dayOf: (d: Date | null) => string }} opts  dayOf: tarihin günü (uygulama saat diliminde)
 * @returns {{ rows: R[], days: string[], day: string | null }}  days: listedeki yükleme günleri (süzgeç seçenekleri), eskiden yeniye
 */
export function approvedDrawingList(rows, { day = null, oldest = false, dayOf }) {
  const days = [...new Set(rows.map((o) => dayOf(o.estimatedShipDate)).filter(Boolean))].sort();
  const picked = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  const at = (o) => o.drawingSince?.getTime() ?? 0;
  const ship = (o) => o.estimatedShipDate?.getTime() ?? Infinity;
  const list = rows
    .filter((o) => !picked || dayOf(o.estimatedShipDate) === picked)
    .sort((a, b) => ship(a) - ship(b) || (oldest ? at(a) - at(b) : at(b) - at(a)));
  return { rows: list, days, day: picked };
}

/**
 * Profil siparişi kuyrukları (yalnızca yönetici): adım adım. İptal/arşiv zaten listede yoktur.
 * @template {{ orderTypeCode: string, status: string, profile?: { stage: string } | null }} R
 * @param {R[]} rows
 */
export function profileQueues(rows) {
  const prof = rows.filter((o) => o.orderTypeCode === 'PROFILE_ORDER' && o.status !== 'IPTAL' && o.profile);
  const at = (...stages) => prof.filter((o) => stages.includes(o.profile.stage));
  return [
    { key: 'profilePricing', rows: at('FIYAT_BEKLIYOR') },
    { key: 'profileUnapproved', rows: at('TEKLIF_GONDERILDI') },
    { key: 'profilePayment', rows: at('ONAYLANDI', 'PROFORMA') },
    { key: 'profilePickup', rows: at('DEPODA') },
    { key: 'profileInvoice', rows: at('TESLIM_EDILDI') },
  ];
}
