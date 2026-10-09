// Çalışma takvimi istisnaları (Paket 8, karar 192) — veritabanı tarafı. Yöneticinin elle açık / kapalı işaretlediği günler
// (WorkCalendarOverride) otomatik kuraldan (hafta sonu, resmî tatil) önce gelir. TEK yazar setOverride'dır: yalnızca
// OPS_SETTINGS_MANAGE (karar 219; eylemde ve burada — FORBIDDEN, veritabanına gitmeden), takvim başına danışma kilidi, her değişiklik
// denetim kaydında (WORK_CALENDAR_OVERRIDE: önce / sonra). Okuma: loadOverrides (yalnızca okuma; dış servis yok).
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { CALENDARS, addDaysKey, calendarToday, parseOverride } from './rules.js';

const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => !!actor?.id && can(actor.role, 'OPS_SETTINGS_MANAGE');
/** "YYYY-MM-DD" → @db.Date sütununa yazılacak tarih */
const dateOf = (day) => new Date(`${day}T00:00:00.000Z`);
const keyOf = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Takvimin aralıktaki elle verilmiş kararları: gün → { open, note }.
 * @param {any} db  @param {string} calendar  @param {string} fromDay  @param {string} toDay
 * @returns {Promise<Map<string, { open: boolean, note: string | null }>>}
 */
export async function loadOverrides(db, calendar, fromDay, toDay) {
  const rows = await db.workCalendarOverride.findMany({
    where: { calendar, day: { gte: dateOf(fromDay), lte: dateOf(toDay) } },
    select: { day: true, open: true, note: true },
  });
  return new Map(rows.map((r) => [keyOf(r.day), { open: r.open, note: r.note }]));
}

/**
 * Hesap penceresi: bugünden bir gün öncesinden bu kadar gün sonrasına kadarki kararlar (teslim günü, alış günü
 * doğrulaması ve tedarikçi uyarısı bu pencerenin içinde kalır: en uzak gün bugün + 180, aramayla birkaç hafta daha).
 */
export const OVERRIDE_WINDOW_DAYS = 420;

/**
 * Takvimin bugünkü penceresinin kararları (hesaplar için).
 * @param {any} db  @param {string} calendar  @param {{ now?: Date }} [o]
 */
export function calendarOverrides(db, calendar, { now = new Date() } = {}) {
  const today = calendarToday(calendar, now);
  return loadOverrides(db, calendar, addDaysKey(today, -1), addDaysKey(today, OVERRIDE_WINDOW_DAYS));
}

/**
 * Bir günü elle açık / kapalı işaretler ya da kararı kaldırır (AUTO → otomatik kural).
 * @param {any} db
 * @param {{ calendar: unknown, day: unknown, mode: unknown, note?: unknown }} input
 * @param {{ id: string, role: string, ip?: string | null }} actor
 * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, code: string }>}
 */
export async function setOverride(db, input, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const v = parseOverride(input);
  if (!v.ok) return v;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-calendar:${v.calendar}`}, 0))`;
    const where = { calendar_day: { calendar: v.calendar, day: dateOf(v.day) } };
    const before = await tx.workCalendarOverride.findUnique({ where });
    const prev = before ? { open: before.open, note: before.note ?? null } : null;
    let after = null;
    if (v.mode === 'AUTO') {
      if (!before) return { ok: true, changed: false };
      await tx.workCalendarOverride.delete({ where });
    } else {
      after = { open: v.mode === 'OPEN', note: v.note };
      if (prev && prev.open === after.open && prev.note === after.note) return { ok: true, changed: false };
      await tx.workCalendarOverride.upsert({
        where,
        create: { calendar: v.calendar, day: dateOf(v.day), open: after.open, note: after.note, updatedById: actor.id },
        update: { open: after.open, note: after.note, updatedById: actor.id },
      });
    }
    await writeAudit(tx, {
      action: 'WORK_CALENDAR_OVERRIDE', entityType: 'WorkCalendar', entityId: `${v.calendar}:${v.day}`, userId: actor.id,
      details: { calendar: v.calendar, timeZone: CALENDARS[v.calendar].timeZone, day: v.day, before: prev, after },
    }, actor);
    return { ok: true, changed: true };
  });
}
