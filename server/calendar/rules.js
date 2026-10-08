// Çalışma takvimleri (Paket 8, karar 192–193) — saf kurallar. İki takvim birbirinden TAMAMEN bağımsızdır:
//   RO_DEPOT   Romanya deposu (profil siparişlerinin teslimi): Europe/Bucharest, Romanya resmî tatilleri
//   TR_FACTORY Türkiye fabrikası (tedarikçi tahmini yükleme uyarısı): Europe/Istanbul, Türkiye resmî tatilleri
// Bir günün durumu, öncelik sırasıyla: yöneticinin elle verdiği karar (açık / kapalı — otomatik kuraldan önce gelir) →
// hafta sonu (cumartesi, pazar) kapalı → tam gün resmî tatil kapalı → diğer günler açık. Yarım gün resmî tatil (TR arife,
// 28 Ekim) açık gün sayılır, ekranda ve uyarıda belirtilir. Tatil verisi olmayan yılda yalnızca hafta sonu ve elle
// verilen kararlar bilinir (noData) — uyarı missingYears'tan gelir; tahmin yapılmaz.
// Cam siparişinin tahmini yükleme günü (server/orders/rules.js → glassLoadingDate) bu takvimleri KULLANMAZ (karar 193).
import { HOLIDAYS } from './holidays.js';

export const CALENDARS = Object.freeze({
  RO_DEPOT: Object.freeze({ country: 'RO', timeZone: 'Europe/Bucharest' }),
  TR_FACTORY: Object.freeze({ country: 'TR', timeZone: 'Europe/Istanbul' }),
});
export const CALENDAR_KEYS = Object.freeze(Object.keys(CALENDARS));

/** Yöneticinin uyarı penceresi: bugünden itibaren bu kadar gün içinde verisi olmayan yıl varsa uyarı gösterilir */
export const COVERAGE_DAYS = 180;
/** Açık gün aranırken en fazla bakılan gün (yönetici her günü kapatsa da hesap sonsuza gitmez) */
export const MAX_SEARCH_DAYS = 400;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" geçerli bir takvim günü mü */
export function isDayKey(s) {
  const m = DAY_RE.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Takvim anahtarı geçerli mi (Object.hasOwn — kullanıcıdan gelen anahtarda miras alınan ad kabul edilmez) */
export const isCalendar = (k) => typeof k === 'string' && Object.hasOwn(CALENDARS, k);

/** Gün + n gün ("YYYY-MM-DD") */
export function addDaysKey(day, n) {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Haftanın günü: 0 pazar … 6 cumartesi */
export const weekdayOf = (day) => new Date(`${day}T12:00:00.000Z`).getUTCDay();
export const isWeekend = (day) => {
  const w = weekdayOf(day);
  return w === 0 || w === 6;
};

/**
 * Verilen andaki yerel gün ve dakika (saat dilimi kurallarıyla: yaz / kış saati geçişleri dahil). Saniye yok sayılır:
 * 12:00:59 → 720. dakika.
 * @param {Date} now  @param {string} timeZone
 * @returns {{ day: string, minutes: number }}
 */
export function localClock(now, timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Takvimin bugünü (kendi saat diliminde) */
export const calendarToday = (calendar, now = new Date()) => localClock(now, CALENDARS[calendar].timeZone).day;

/** Yılın tatil verisi var mı */
export function hasYearData(calendar, year) {
  const c = CALENDARS[calendar];
  return !!c && Object.hasOwn(HOLIDAYS[c.country], String(year));
}

/**
 * Günün resmî tatili: tatil kaydı, tatil değilse null, yılın verisi yoksa undefined.
 * @returns {import('./holidays.js').Holiday | null | undefined}
 */
export function holidayOf(calendar, day) {
  const c = CALENDARS[calendar];
  const year = day.slice(0, 4);
  if (!c || !Object.hasOwn(HOLIDAYS[c.country], year)) return undefined;
  return HOLIDAYS[c.country][year].find((h) => h.day === day) ?? null;
}

/** @typedef {{ open: boolean, note?: string | null }} Override */
/**
 * @typedef {{ day: string, open: boolean, reason: 'MANUAL_OPEN' | 'MANUAL_CLOSED' | 'WEEKEND' | 'HOLIDAY' | 'WORKDAY',
 *   holiday: import('./holidays.js').Holiday | null, half: boolean, manual: boolean, note: string | null, noData: boolean }} DayStatus
 */

/**
 * Bir günün durumu.
 * @param {string} calendar  RO_DEPOT | TR_FACTORY
 * @param {string} day  "YYYY-MM-DD"
 * @param {Map<string, Override> | null} [overrides]  yöneticinin kararları (gün → açık / kapalı)
 * @returns {DayStatus}
 */
export function dayStatus(calendar, day, overrides = null) {
  if (!isCalendar(calendar)) throw new Error(`bilinmeyen takvim: ${calendar}`);
  const h = holidayOf(calendar, day);
  const ov = overrides?.get(day) ?? null;
  const base = { day, holiday: h ?? null, half: !!h?.half, manual: !!ov, note: ov?.note ?? null, noData: h === undefined };
  if (ov) return { ...base, open: !!ov.open, reason: ov.open ? 'MANUAL_OPEN' : 'MANUAL_CLOSED' };
  if (isWeekend(day)) return { ...base, open: false, reason: 'WEEKEND' };
  if (h && !h.half) return { ...base, open: false, reason: 'HOLIDAY' };
  return { ...base, open: true, reason: 'WORKDAY' };
}

export const isOpenDay = (calendar, day, overrides = null) => dayStatus(calendar, day, overrides).open;

/**
 * Verilen günden SONRAKİ ilk açık gün; MAX_SEARCH_DAYS içinde yoksa null.
 * @param {string} calendar  @param {string} day  @param {Map<string, Override> | null} [overrides]
 */
export function nextOpenDay(calendar, day, overrides = null) {
  let d = day;
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    d = addDaysKey(d, 1);
    if (isOpenDay(calendar, d, overrides)) return d;
  }
  return null;
}

/**
 * Verilen gün açıksa kendisi, değilse sonraki ilk açık gün (yoksa null).
 * @param {string} calendar  @param {string} day  @param {Map<string, Override> | null} [overrides]
 */
export function openOnOrAfter(calendar, day, overrides = null) {
  return isOpenDay(calendar, day, overrides) ? day : nextOpenDay(calendar, day, overrides);
}

/**
 * Tatil verisi olmayan yıllar (verilen aralıkta, artan sırada).
 * @param {string} calendar  @param {string} fromDay  @param {string} toDay
 * @returns {number[]}
 */
export function missingYears(calendar, fromDay, toDay) {
  const out = [];
  for (let y = Number(fromDay.slice(0, 4)); y <= Number(toDay.slice(0, 4)); y++) if (!hasYearData(calendar, y)) out.push(y);
  return out;
}

/** Yöneticiye gösterilecek eksik veri: bugünden COVERAGE_DAYS gün sonrasına kadar verisi olmayan yıllar */
export const coverageGaps = (calendar, today) => missingYears(calendar, today, addDaysKey(today, COVERAGE_DAYS));

/** Verisi olan yıllar */
export function dataYears(calendar) {
  const c = CALENDARS[calendar];
  return c ? Object.keys(HOLIDAYS[c.country]).map(Number).sort((a, b) => a - b) : [];
}

/** Aralıktaki resmî tatiller (gün sırasıyla) */
export function holidaysBetween(calendar, fromDay, toDay) {
  const c = CALENDARS[calendar];
  if (!c) return [];
  const out = [];
  for (let y = Number(fromDay.slice(0, 4)); y <= Number(toDay.slice(0, 4)); y++) {
    for (const h of HOLIDAYS[c.country][String(y)] ?? []) if (h.day >= fromDay && h.day <= toDay) out.push(h);
  }
  return out;
}

/**
 * Bir ayın günleri (takvim görünümü): 1. günden son güne her günün durumu.
 * @param {string} calendar  @param {string} month "YYYY-MM"  @param {Map<string, Override> | null} [overrides]
 * @returns {DayStatus[]}
 */
export function monthDays(calendar, month, overrides = null) {
  const out = [];
  let d = `${month}-01`;
  while (d.slice(0, 7) === month) {
    out.push(dayStatus(calendar, d, overrides));
    d = addDaysKey(d, 1);
  }
  return out;
}

/**
 * Yönetici formundan gelen karar: OPEN (açık), CLOSED (kapalı) ya da AUTO (elle kararı kaldır, otomatik kurala dön).
 * Açıklama en fazla 200 karakter, tek satır.
 * @returns {{ ok: true, calendar: string, day: string, mode: 'OPEN' | 'CLOSED' | 'AUTO', note: string | null } | { ok: false, code: 'CALENDAR' | 'DAY' | 'MODE' }}
 */
export function parseOverride({ calendar, day, mode, note }) {
  if (!isCalendar(calendar)) return { ok: false, code: 'CALENDAR' };
  if (!isDayKey(day)) return { ok: false, code: 'DAY' };
  if (!['OPEN', 'CLOSED', 'AUTO'].includes(String(mode))) return { ok: false, code: 'MODE' };
  const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { ok: true, calendar, day, mode: /** @type {'OPEN' | 'CLOSED' | 'AUTO'} */ (mode), note: text || null };
}

/**
 * Orthodoks Paskalya (Gregoryen takvimde; 1900–2099): Julian computus (Meeus) + 13 gün. Yalnızca veri doğrulaması için —
 * takvim tatilleri her zaman holidays.js'ten okunur.
 * @param {number} year
 */
export function orthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return addDaysKey(julian, 13);
}
