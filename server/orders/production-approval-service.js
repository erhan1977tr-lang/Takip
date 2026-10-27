// Müşteri üretim onayı (4.2.1) — veritabanı tarafı: özellik anahtarı ve süre dolunca yöneticiye bir kez bildirim.
// Kurallar: server/orders/production-approval.js. İş akışı işlemleri (onay, değişiklik talebi): server/orders/transitions.js.
import { can } from '../auth/permissions.js';
import { notifyStaff } from '../notifications/inapp.js';
import { localClock } from '../calendar/rules.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { APPROVAL_REMINDER_TYPE } from './production-approval-delivery.js';
import { APPROVAL_SETTING_KEY, APPROVAL_STATUSES, APPROVAL_TIME_ZONE, approvalCutoff, approvalReminderAt, approvalSettingOn } from './production-approval.js';

const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => !!actor && can(actor.role, 'SETTINGS_MANAGE');

/** Saatlik denetimin aralığı ve bir turda bakılan en fazla teklif */
export const APPROVAL_REMIND_EVERY_MS = 3_600_000;
const REMIND_BATCH = 200;
/** Bu kadar eski son tarih artık taranmaz (bildirim zaten süre dolduktan sonraki ilk turda gider) */
const REMIND_LOOKBACK_MS = 30 * 86_400_000;

/** Özellik anahtarı (yalnızca okunur): { enabled, cutoff, since } */
export async function getApprovalSetting(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: APPROVAL_SETTING_KEY }, select: { value: true } });
  const v = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {};
  return { enabled: approvalSettingOn(v), cutoff: approvalCutoff(v), since: typeof v.since === 'string' ? v.since : null };
}

/**
 * Özellik anahtarını ve kesim gününü değiştirir (SETTINGS_MANAGE). Yalnızca BUNDAN SONRA oluşturulan siparişlerin kapsamını
 * belirler (açık + tahmini yükleme ≥ kesim): mevcut siparişlerin bayrağı ve teklifleri değişmez — mevcut siparişler yalnızca
 * açık onaylı geçiş işlemiyle kapsama alınır (production-approval-enroll.js). Kapatınca geriye dönük hiçbir şey yazılmaz.
 * @param {any} db  @param {{ enabled: boolean, cutoff?: string | null, actor: { id: string, role: string, ip?: string | null } }} p
 */
export async function saveApprovalSetting(db, { enabled, cutoff = null, actor }) {
  if (!allowed(actor)) return FORBIDDEN;
  const on = enabled === true;
  if (cutoff != null && cutoff !== '' && approvalCutoff({ cutoff }) !== cutoff) return { ok: false, code: 'BAD_CUTOFF' };
  return db.$transaction(async (tx) => {
    const row = await tx.integrationSetting.findUnique({ where: { key: APPROVAL_SETTING_KEY }, select: { value: true } });
    const before = { enabled: approvalSettingOn(row?.value), cutoff: approvalCutoff(row?.value) };
    const after = { enabled: on, cutoff: cutoff || before.cutoff };
    if (before.enabled === after.enabled && before.cutoff === after.cutoff) return { ok: true, changed: false };
    const value = { ...after, since: new Date().toISOString() };
    await tx.integrationSetting.upsert({ where: { key: APPROVAL_SETTING_KEY }, create: { key: APPROVAL_SETTING_KEY, value }, update: { value } });
    await writeAudit(tx, {
      action: 'PRODUCTION_APPROVAL_SETTING', entityType: 'IntegrationSetting', entityId: APPROVAL_SETTING_KEY,
      userId: actor.id ?? null, details: { before: before.enabled, after: on, cutoffBefore: before.cutoff, cutoff: after.cutoff },
    }, actor);
    return { ok: true, changed: true };
  });
}

/**
 * Süresi dolmuş, hâlâ onay bekleyen sürümler → yöneticiye uygulama içi bildirim, sürüm başına BİR KEZ (approvalOverdueAt
 * koşullu yazılır + bildirimin benzersiz anahtarı). Müşteri onay hakkını kaybetmez; yükleme tarihi değişmez; e-posta yok.
 * Yalnızca siparişin EN SON sürümü sayılır (eski sürüm onaylanamaz, onun gecikmesi de bildirilmez).
 * @param {any} db  @param {{ now?: Date, log?: Function }} [o]
 * @returns {Promise<{ checked: number, notified: number }>}
 */
export async function remindApprovalOverdue(db, { now = new Date(), log = () => {} } = {}) {
  if (!(await getApprovalSetting(db)).enabled) return { checked: 0, notified: 0 };
  const rows = await db.offer.findMany({
    where: {
      status: 'GONDERILDI', approvedAt: null, changeRequestedAt: null, approvalOverdueAt: null,
      approvalDueAt: { lte: now, gte: new Date(now.getTime() - REMIND_LOOKBACK_MS) },
      order: { productionApprovalRequired: true, status: { in: [...APPROVAL_STATUSES] }, removedAt: null },
    },
    orderBy: { approvalDueAt: 'asc' },
    take: REMIND_BATCH,
    select: {
      id: true, approvalDueAt: true, createdAt: true, orderId: true,
      order: { select: { offers: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } } } },
    },
  });
  let notified = 0;
  for (const r of rows) {
    if (r.order.offers[0]?.id !== r.id) continue; // daha yeni sürüm var
    const claimed = await db.offer.updateMany({ where: { id: r.id, approvalOverdueAt: null, approvedAt: null, changeRequestedAt: null }, data: { approvalOverdueAt: now } });
    if (claimed.count !== 1) continue;
    try {
      const due = localClock(new Date(r.approvalDueAt), APPROVAL_TIME_ZONE);
      notified += await notifyStaff(db, {
        audience: 'admin', key: `approval-overdue:${r.id}`, type: 'PRODUCTION_APPROVAL_OVERDUE', orderId: r.orderId,
        params: { day: due.day }, link: `/siparisler/${r.orderId}#teklif`,
      });
    } catch (e) {
      log('üretim onayı gecikme bildirimi yazılamadı', r.orderId, String(e?.message ?? e).slice(0, 200));
    }
  }
  return { checked: rows.length, notified };
}

/**
 * Onay bekleyen müşteriye TEK hatırlatma (4.2.5): talep müşteriye iletildikten 1 Romanya iş günü sonra, hâlâ onay ya da
 * değişiklik talebi yoksa. Sürüm başına bir kez (approvalReminderAt koşullu yazılır; olay aynı işlemde kuyruğa → e-posta +
 * zil, müşterinin tercihine göre). Yalnızca siparişin EN SON sürümü; iletilmemiş talep hatırlatılmaz (süre başlamadı).
 * Ayar kapalıyken hatırlatma yok.
 * @param {any} db  @param {{ now?: Date, log?: Function }} [o]
 * @returns {Promise<{ checked: number, reminded: number }>}
 */
export async function remindApprovalCustomers(db, { now = new Date(), log = () => {} } = {}) {
  if (!(await getApprovalSetting(db)).enabled) return { checked: 0, reminded: 0 };
  const rows = await db.offer.findMany({
    where: {
      status: 'GONDERILDI', approvedAt: null, changeRequestedAt: null, approvalReminderAt: null,
      approvalDeliveredAt: { lte: now, gte: new Date(now.getTime() - REMIND_LOOKBACK_MS) },
      order: { productionApprovalRequired: true, status: { in: [...APPROVAL_STATUSES] }, removedAt: null, onHold: false },
    },
    orderBy: { approvalDeliveredAt: 'asc' },
    take: REMIND_BATCH,
    select: {
      id: true, orderId: true, approvalDeliveredAt: true, approvalDueAt: true,
      order: { select: { status: true, offers: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } } } },
    },
  });
  let reminded = 0;
  for (const r of rows) {
    if (r.order.offers[0]?.id !== r.id) continue; // daha yeni sürüm var
    const at = approvalReminderAt(r.approvalDeliveredAt).due;
    if (!at || at.getTime() > now.getTime()) continue; // henüz zamanı değil ya da tatil verisi yok (tahmin edilmez)
    try {
      const done = await db.$transaction(async (tx) => {
        const claimed = await tx.offer.updateMany({ where: { id: r.id, approvalReminderAt: null, approvedAt: null, changeRequestedAt: null, status: 'GONDERILDI' }, data: { approvalReminderAt: now } });
        if (claimed.count !== 1) return false;
        await writeHistory(tx, { orderId: r.orderId, event: 'PRODUCTION_APPROVAL_REMINDER', from: r.order.status, to: r.order.status, actorId: null });
        await enqueueOutbox(tx, {
          type: APPROVAL_REMINDER_TYPE, orderId: r.orderId,
          payload: { approval: { offerId: r.id, due: r.approvalDueAt ? new Date(r.approvalDueAt).toISOString() : null }, from: r.order.status, to: r.order.status, actorId: null },
        });
        return true;
      });
      if (done) reminded++;
    } catch (e) {
      log('üretim onayı hatırlatması yazılamadı', r.orderId, String(e?.message ?? e).slice(0, 200));
    }
  }
  return { checked: rows.length, reminded };
}
