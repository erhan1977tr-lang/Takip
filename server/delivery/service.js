// Profil teslimatının belgeleri (Paket 8, karar 195–196) — veritabanı tarafı.
//   recordDeliveryPhoto   bir fotoğrafın kaydı (dosya storeFiles'tan geçmiş, tek dosya): OrderFile (DELIVERY_PHOTO) + DeliveryPhoto
//                         tek işlemde; aynı içerik zaten varsa yeni kayıt yazılmaz (duplicate) — eşzamanlı iki istek de
//                         veritabanının tekil kısıtıyla tek kayıt bırakır. Denetim: DELIVERY_PHOTO_ADDED.
//   createDeliveryReport  raporun kopyası (oluşturulduğu an) + sipariş geçmişi (DELIVERY_REPORT) + denetim; tek kullanımlık form
//                         anahtarı ve "son raporla aynı içerik" kontrolüyle çift rapor oluşmaz.
//   deliveryDocs          sayfa için fotoğraf ve rapor listesi (müşteriye iç ekipten kişi adı gitmez).
//   renderDeliveryReport  PDF (kopyadan; görenin dili) — erişim koşulu çağırandan gelir (sipariş kapsamı).
// Yetki: depo bağlantısı ya da yönetici (canManageDelivery) — eylemde ve burada (FORBIDDEN, veritabanına gitmeden).
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { resolveKey } from '../files/store.js';
import { translate } from '../i18n/index.js';
import { unitLabel } from '../profile/catalog.js';
import { localDay } from '../profile/dates.js';
import { deliveryReportPdf } from '../pdf/delivery-report.js';
import { exportFileName } from '../files/export-name.js';
import { createRateLimiter } from '../security/rate-limit.js';
import { canManageDelivery, photosToEmbed, reportContentKey, reportNote, reportSnapshot, takesDeliveryDocs } from './rules.js';

const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });

/** Rapor PDF'i her istekte kopyadan (fotoğraflar diskten) üretilir: kullanıcı başına 5 dakikada en çok 20 istek */
export const REPORT_RATE = Object.freeze({ limit: 20, windowMs: 5 * 60_000 });
export const reportLimiter = createRateLimiter(REPORT_RATE);
const DEPOT_TZ = 'Europe/Bucharest';
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const viaOf = (actor) => (actor.depot ? 'DEPOT_LINK' : 'ADMIN');
const userOf = (actor) => (actor.depot ? null : actor.id ?? null);

const ORDER_STATE = { id: true, orderNo: true, status: true, removedAt: true, orderTypeCode: true, profile: { select: { stage: true } } };

/**
 * Teslimat fotoğrafını kaydeder.
 * @param {any} db
 * @param {{ orderId: string, stored: { storageKey: string, name: string, size: number, mime?: string | null, checksum?: string | null,
 *   scanStatus?: string, scanSignature?: string | null, scannedAt?: Date | null },
 *   actor: { id: string | null, role: string, depot?: boolean, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, photoId: string, duplicate: boolean } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'STATE' | 'CHECKSUM' }>}
 *   duplicate: aynı içerik zaten kayıtlı — yeni kayıt yazılmadı; çağıran az önce sakladığı dosyayı siler (discardFiles)
 */
export async function recordDeliveryPhoto(db, { orderId, stored, actor }) {
  if (!canManageDelivery(actor)) return FORBIDDEN;
  if (!stored?.checksum || !/^[a-f0-9]{64}$/.test(stored.checksum)) return { ok: false, code: 'CHECKSUM' };
  const existing = () => db.deliveryPhoto.findUnique({ where: { orderId_checksum: { orderId, checksum: stored.checksum } }, select: { id: true } });
  try {
    return await db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, orderTypeCode: 'PROFILE_ORDER' }, select: ORDER_STATE });
      if (!order) return { ok: false, code: 'NOT_FOUND' };
      if (!takesDeliveryDocs({ stage: order.profile?.stage, status: order.status, removedAt: order.removedAt })) return { ok: false, code: 'STATE' };
      const same = await tx.deliveryPhoto.findUnique({ where: { orderId_checksum: { orderId, checksum: stored.checksum } }, select: { id: true } });
      if (same) return { ok: true, photoId: same.id, duplicate: true };
      const file = await tx.orderFile.create({
        data: {
          orderId, kind: 'INTERNAL', source: 'DELIVERY_PHOTO', uploadedById: userOf(actor),
          name: stored.name, storageKey: stored.storageKey, size: stored.size, mime: stored.mime ?? null, checksum: stored.checksum,
          scanStatus: /** @type {any} */ (stored.scanStatus ?? 'SKIPPED'), scanSignature: stored.scanSignature ?? null, scannedAt: stored.scannedAt ?? null,
        },
      });
      const photo = await tx.deliveryPhoto.create({ data: { orderId, fileId: file.id, checksum: stored.checksum, via: viaOf(actor) } });
      await writeAudit(tx, {
        action: 'DELIVERY_PHOTO_ADDED', entityType: 'Order', entityId: orderId, userId: userOf(actor),
        details: { orderNo: order.orderNo, photoId: photo.id, fileId: file.id, name: file.name, size: file.size, via: viaOf(actor) },
      }, actor);
      return { ok: true, photoId: photo.id, duplicate: false };
    });
  } catch (e) {
    // Aynı içerik aynı anda iki kez geldi: tekil kısıt ikinci kaydı (ve dosya satırını) geri aldı — ilk kayıt kalır
    if (/** @type {any} */ (e)?.code === 'P2002') {
      const first = await existing();
      if (first) return { ok: true, photoId: first.id, duplicate: true };
    }
    throw e;
  }
}

/**
 * Teslimat raporu oluşturur (kopya). Son raporla aynı içerikteyse yeni sürüm açılmaz (duplicate); aynı form anahtarıyla gelen
 * ikinci istek ilk raporu döner.
 * @param {any} db
 * @param {{ orderId: string, note?: unknown, requestKey?: unknown, actor: { id: string | null, role: string, depot?: boolean, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, reportId: string, revision: number, duplicate: boolean } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'STATE' | 'KEY' }>}
 */
export async function createDeliveryReport(db, { orderId, note = null, requestKey = null, actor, now = new Date() }) {
  if (!canManageDelivery(actor)) return FORBIDDEN;
  const key = typeof requestKey === 'string' && KEY_RE.test(requestKey) ? requestKey : null;
  const text = reportNote(note);
  const byKey = async (tx) => {
    if (!key) return null;
    const prev = await tx.deliveryReport.findUnique({ where: { requestKey: key }, select: { id: true, orderId: true, revision: true } });
    if (!prev) return null;
    return prev.orderId === orderId ? { ok: true, reportId: prev.id, revision: prev.revision, duplicate: true } : { ok: false, code: 'KEY' };
  };
  try {
    return await db.$transaction(async (tx) => {
      // Sipariş başına sıra: sürüm numarası ve "aynı içerik" kontrolü yarışmaz
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery-report:${orderId}`}, 0))`;
      const again = await byKey(tx);
      if (again) return again;
      const order = await tx.order.findFirst({
        where: { id: orderId, orderTypeCode: 'PROFILE_ORDER' },
        select: {
          ...ORDER_STATE, title: true, customer: { select: { name: true } },
          profile: { select: { stage: true, pickupDate: true, deliveredAt: true, deliveredVia: true } },
          profileItems: { orderBy: { sortOrder: 'asc' }, select: { code: true, nameTr: true, nameRo: true, unitCode: true, qty: true } },
          deliveryPhotos: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, via: true, createdAt: true, file: { select: { name: true, size: true, scanStatus: true, uploadedBy: { select: { name: true } } } } },
          },
        },
      });
      if (!order) return { ok: false, code: 'NOT_FOUND' };
      if (!order.profile || !takesDeliveryDocs({ stage: order.profile.stage, status: order.status, removedAt: order.removedAt })) return { ok: false, code: 'STATE' };
      const createdBy = actor.depot ? null : (await tx.user.findUnique({ where: { id: String(actor.id) }, select: { name: true } }))?.name ?? null;
      const data = reportSnapshot({
        order, profile: order.profile, items: order.profileItems, photos: order.deliveryPhotos, note: text, via: viaOf(actor), createdBy, now,
      });
      const fingerprint = crypto.createHash('sha256').update(reportContentKey(data)).digest('hex');
      const last = await tx.deliveryReport.findFirst({ where: { orderId }, orderBy: { revision: 'desc' }, select: { id: true, revision: true, fingerprint: true } });
      if (last && last.fingerprint === fingerprint) return { ok: true, reportId: last.id, revision: last.revision, duplicate: true };
      const revision = (last?.revision ?? 0) + 1;
      // Teslimat tarihi: teslim edildiyse teslim günü (depo saat dilimi), değilse planlanan alış günü
      const deliveryDay = order.profile.deliveredAt
        ? new Date(`${localDay(order.profile.deliveredAt, DEPOT_TZ)}T00:00:00.000Z`)
        : order.profile.pickupDate ? new Date(`${new Date(order.profile.pickupDate).toISOString().slice(0, 10)}T00:00:00.000Z`) : null;
      const report = await tx.deliveryReport.create({
        data: {
          orderId, revision, stage: order.profile.stage, deliveryDay, deliveredAt: order.profile.deliveredAt ?? null, note: text,
          data, fingerprint, requestKey: key, via: viaOf(actor), createdById: userOf(actor),
        },
      });
      await writeHistory(tx, { orderId, event: 'DELIVERY_REPORT', from: order.status, to: order.status, actorId: userOf(actor), note: `#${revision}` });
      await writeAudit(tx, {
        action: 'DELIVERY_REPORT_CREATED', entityType: 'Order', entityId: orderId, userId: userOf(actor),
        details: { orderNo: order.orderNo, reportId: report.id, revision, stage: order.profile.stage, photos: data.photos.length, via: viaOf(actor) },
      }, actor);
      return { ok: true, reportId: report.id, revision, duplicate: false };
    });
  } catch (e) {
    // Aynı form anahtarıyla eşzamanlı ikinci istek: ilk rapor
    if (/** @type {any} */ (e)?.code === 'P2002' && key) {
      const again = await byKey(db);
      if (again) return again;
    }
    throw e;
  }
}

/**
 * Sayfa için teslimat belgeleri. Müşteriye (staff false) iç ekipten kişi adı gitmez — yalnızca "depo" / "GKH".
 * @param {any} db  @param {string} orderId  @param {{ staff: boolean }} o
 */
export async function deliveryDocs(db, orderId, { staff }) {
  const [photos, reports] = await Promise.all([
    db.deliveryPhoto.findMany({
      where: { orderId, file: { scanStatus: { not: 'INFECTED' } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, via: true, createdAt: true, file: { select: { name: true, size: true, scanStatus: true, uploadedBy: { select: { name: true } } } } },
    }),
    db.deliveryReport.findMany({
      where: { orderId },
      orderBy: { revision: 'desc' },
      select: { id: true, revision: true, stage: true, via: true, createdAt: true, deliveryDay: true, createdBy: { select: { name: true } } },
    }),
  ]);
  return {
    photos: photos.map((p) => ({
      id: p.id, name: p.file.name, size: p.file.size, scanStatus: p.file.scanStatus, createdAt: p.createdAt, via: p.via,
      by: staff && p.via === 'ADMIN' ? p.file.uploadedBy?.name ?? null : null,
    })),
    reports: reports.map((r) => ({
      id: r.id, revision: r.revision, stage: r.stage, via: r.via, createdAt: r.createdAt, deliveryDay: r.deliveryDay,
      by: staff && r.via === 'ADMIN' ? r.createdBy?.name ?? null : null,
    })),
  };
}

const dmy = (day) => (day ? String(day).slice(0, 10).split('-').reverse().join('.') : '—');
const fmtTime = (iso, locale) => new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'ro-RO', {
  timeZone: DEPOT_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(iso));

/**
 * Raporun PDF'i. where: erişim koşulu (sipariş kapsamı — müşteride kendi firması); bulunamazsa null.
 * @param {any} db
 * @param {{ reportId: string, orderWhere: object, locale: 'tr' | 'ro', staff: boolean, appUrl: string }} p
 * @returns {Promise<{ buf: Buffer, name: string, orderId: string, revision: number } | null>}
 */
export async function renderDeliveryReport(db, { reportId, orderWhere, locale, staff, appUrl }) {
  const r = await db.deliveryReport.findFirst({ where: { id: reportId, order: orderWhere }, select: { id: true, orderId: true, revision: true, stage: true, data: true } });
  if (!r) return null;
  const t = (k, p) => translate(locale, k, p);
  const s = /** @type {any} */ (r.data ?? {});
  const photos = Array.isArray(s.photos) ? s.photos : [];
  // Gömme kararı dosyaların ŞU ANKİ tarama durumuna göre: sonradan virüslü bulunan fotoğraf gömülmez
  const files = photos.length
    ? await db.deliveryPhoto.findMany({ where: { id: { in: photos.map((p) => String(p.id)) }, orderId: r.orderId }, select: { id: true, file: { select: { storageKey: true, name: true, size: true, scanStatus: true } } } })
    : [];
  const byId = new Map(files.map((f) => [f.id, f.file]));
  const embed = photosToEmbed(photos.map((p) => ({ id: String(p.id), name: String(p.name ?? ''), size: Number(byId.get(String(p.id))?.size ?? 0), scanStatus: byId.get(String(p.id))?.scanStatus ?? 'INFECTED' })));
  const who = (via, by) => (via === 'DEPOT_LINK' ? t('delivery.report.byDepot') : staff && by ? `${t('delivery.report.byAdmin')} — ${by}` : t('delivery.report.byAdmin'));
  const list = [];
  for (const p of photos) {
    const id = String(p.id);
    const f = byId.get(id);
    if (!f || f.scanStatus === 'INFECTED') continue;
    let buf = null;
    if (embed.has(id)) {
      const full = resolveKey(f.storageKey);
      buf = full ? await fsp.readFile(full).catch(() => null) : null;
    }
    list.push({ label: `${f.name} · ${fmtTime(p.at, locale)} · ${who(p.via, p.by)}`, url: `${appUrl}/dosya/teslimat/${id}?ac=1`, buf });
  }
  const delivered = !!s.deliveredAt;
  const deliveryText = delivered
    ? t('delivery.report.deliveredOn', { date: fmtTime(s.deliveredAt, locale) })
    : s.pickupDay ? t('delivery.report.plannedOn', { date: dmy(s.pickupDay) }) : '—';
  const stageText = t(`delivery.report.stage.${r.stage}`);
  const info = [
    [t('delivery.report.orderNo'), String(s.orderNo ?? '')],
    ...(s.title ? [[t('delivery.report.project'), String(s.title)]] : []),
    [t('delivery.report.firm'), String(s.firm ?? '')],
    [t('delivery.report.status'), stageText],
    [t('delivery.report.date'), deliveryText],
    [t('delivery.report.createdBy'), `${who(s.createdVia, s.createdBy)} · ${s.createdAt ? fmtTime(s.createdAt, locale) : '—'}`],
  ];
  const buf = deliveryReportPdf({
    items: (Array.isArray(s.items) ? s.items : []).map((i) => ({ code: String(i.code ?? ''), name: String((locale === 'tr' ? i.nameTr : i.nameRo) ?? i.nameRo ?? ''), unit: unitLabel(String(i.unitCode ?? ''), locale), qty: Number(i.qty ?? 0) })),
    photos: list,
  }, {
    title: t('delivery.report.pdfTitle', { n: r.revision }),
    firm: String(s.firm ?? ''),
    subtitle: t('delivery.report.subtitle', { orderNo: String(s.orderNo ?? ''), date: s.createdAt ? fmtTime(s.createdAt, locale) : '—' }),
    info: /** @type {[string, string][]} */ (info),
    note: s.note ? { label: t('delivery.report.note'), text: String(s.note) } : null,
    itemsTitle: t('delivery.report.items'),
    photosTitle: t('delivery.report.photos'),
    noPhotos: t('delivery.report.noPhotos'),
    notEmbedded: t('delivery.report.notEmbedded'),
    linkHint: t('delivery.report.linkHint'),
    cols: { code: t('delivery.report.colCode'), product: t('delivery.report.colProduct'), unit: t('delivery.report.colUnit'), qty: t('delivery.report.colQty') },
  });
  const name = exportFileName(t('exports.names.deliveryReport'), [String(s.orderNo ?? ''), `${r.revision}`], 'pdf');
  return { buf, name, orderId: r.orderId, revision: r.revision };
}
