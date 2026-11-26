// Sabit tahmini yükleme tarihi (4.2.34): Ayarlar → Entegrasyonlar'da cam ve profil siparişleri için AYRI ayar.
//   - AUTO (varsayılan, ayar hiç kaydedilmemişse de): bugünkü otomatik hesap aynen çalışır
//     (cam: rules.js → glassLoadingDate; profil: dates.js → earliestPickup / depo kuralı).
//   - FIXED + gün: cam → yeni siparişin tahmini yükleme tarihi bu gündür; profil → müşterinin seçebileceği en erken alış
//     günü bu günden (ya da ondan sonraki ilk açık depo gününden) önce olamaz.
//   - Sabit gün geçmişte kaldıysa (bugünden önce) kendiliğinden yok sayılır → otomatik hesap (eski bir tarih asla yazılmaz).
//   - Yalnızca YENİ kararları etkiler: mevcut siparişlerin kayıtlı tarihi değişmez; satış / yönetici tarihi eskisi gibi
//     sipariş sayfasından değiştirir.
// Bu modülün kural kısmı saftır (DB yok); kayıt / okuma IntegrationSetting 'loading-date' üzerinden.
import { can } from '../auth/permissions.js';
import { writeAudit } from './journal.js';
import { glassLoadingDate } from './rules.js';

export const LOADING_DATE_SETTING_KEY = 'loading-date';
export const LOADING_DATE_KINDS = Object.freeze(['glass', 'profile']);
/** Sabit gün en fazla bugünden bu kadar gün sonrası olabilir */
export const FIXED_MAX_DAYS = 366;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** "YYYY-MM-DD" geçerli bir takvim günü mü */
export function validDay(s) {
  const m = DAY_RE.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const AUTO = Object.freeze({ mode: 'AUTO', date: null });

/** Kayıtlı değerin bir türü → { mode, date }; bozuk / eksik değer = AUTO (bugünkü davranış) */
function kindOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return AUTO;
  if (v.mode === 'FIXED' && validDay(v.date)) return { mode: 'FIXED', date: v.date };
  return { mode: 'AUTO', date: validDay(v.date) ? v.date : null };
}

/** Kayıtlı değer → { glass, profile } (her biri { mode, date }) */
export function parseLoadingDateSetting(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { glass: kindOf(v.glass), profile: kindOf(v.profile) };
}

/**
 * Bugün geçerli sabit gün ("YYYY-MM-DD") ya da null (= otomatik hesap). Geçmişte kalmış gün yok sayılır.
 * @param {{ glass: { mode: string, date: string | null }, profile: { mode: string, date: string | null } }} setting
 * @param {'glass' | 'profile'} kind  @param {string} todayKey  işletmenin bugünü "YYYY-MM-DD"
 */
export function activeFixedDay(setting, kind, todayKey) {
  const k = setting?.[kind];
  if (!k || k.mode !== 'FIXED' || !validDay(k.date)) return null;
  return k.date >= todayKey ? k.date : null;
}

/** "YYYY-MM-DD" → gün ortası UTC Date (rules.js / dates.js ile aynı gün gösterimi) */
export const fixedDayDate = (key) => new Date(`${key}T12:00:00.000Z`);

/** Verilen andaki yerel gün "YYYY-MM-DD" */
export function localDayKey(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const addDaysKey = (key, n) => {
  const d = fixedDayDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Formdan gelen bir türü doğrular. Hata kodu: BAD_DATE (sabit seçili ama gün yok / geçersiz), PAST_DATE, TOO_FAR.
 * Otomatik seçiliyken girilmiş gün saklanır (bir sonraki açışta hazır dursun) ama kullanılmaz.
 * @returns {{ ok: true, value: { mode: string, date: string | null } } | { ok: false, code: string }}
 */
export function parseKindInput({ fixed, date }, todayKey) {
  const d = String(date ?? '').trim();
  if (!fixed) return { ok: true, value: { mode: 'AUTO', date: validDay(d) ? d : null } };
  if (!validDay(d)) return { ok: false, code: 'BAD_DATE' };
  if (d < todayKey) return { ok: false, code: 'PAST_DATE' };
  if (d > addDaysKey(todayKey, FIXED_MAX_DAYS)) return { ok: false, code: 'TOO_FAR' };
  return { ok: true, value: { mode: 'FIXED', date: d } };
}

/** @param {any} db */
export async function getLoadingDateSetting(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: LOADING_DATE_SETTING_KEY }, select: { value: true } });
  return parseLoadingDateSetting(row?.value);
}

/**
 * Ayarı kaydeder (SETTINGS_MANAGE — eylemde ve burada). Yalnızca ayar satırı ve denetim kaydı yazılır; hiçbir sipariş değişmez.
 * @param {any} db
 * @param {{ glass: { fixed: boolean, date?: string }, profile: { fixed: boolean, date?: string }, actor: { id: string, role: string, ip?: string | null }, now?: Date, timeZone?: string }} p
 */
export async function saveLoadingDateSetting(db, { glass, profile, actor, now = new Date(), timeZone = 'Europe/Bucharest' }) {
  if (!actor || !can(actor.role, 'SETTINGS_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const today = localDayKey(now, timeZone);
  const g = parseKindInput(glass ?? {}, today);
  if (!g.ok) return { ok: false, code: g.code, kind: 'glass' };
  const pr = parseKindInput(profile ?? {}, today);
  if (!pr.ok) return { ok: false, code: pr.code, kind: 'profile' };
  const after = { glass: g.value, profile: pr.value };
  return db.$transaction(async (tx) => {
    const row = await tx.integrationSetting.findUnique({ where: { key: LOADING_DATE_SETTING_KEY }, select: { value: true } });
    const before = parseLoadingDateSetting(row?.value);
    if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true, changed: false };
    const value = { ...after, since: now.toISOString() };
    await tx.integrationSetting.upsert({ where: { key: LOADING_DATE_SETTING_KEY }, create: { key: LOADING_DATE_SETTING_KEY, value }, update: { value } });
    await writeAudit(tx, {
      action: 'LOADING_DATE_SETTING', entityType: 'IntegrationSetting', entityId: LOADING_DATE_SETTING_KEY,
      userId: actor.id ?? null, details: { before, after },
    }, actor);
    return { ok: true, changed: true };
  });
}

/**
 * Yeni CAM siparişinin tahmini yükleme günü: geçerli sabit gün varsa o, yoksa TEK otomatik hesap (glassLoadingDate).
 * Sipariş oluşturma (create.js) ve Yeni Sipariş formundaki bilgi aynı fonksiyonu kullanır.
 * @param {ReturnType<typeof parseLoadingDateSetting>} setting  @param {Date} now  @param {string} timeZone
 */
export function glassShipDate(setting, now, timeZone) {
  const fixed = activeFixedDay(setting, 'glass', localDayKey(now, timeZone));
  return fixed ? fixedDayDate(fixed) : glassLoadingDate(now, timeZone);
}

/**
 * PROFİL siparişinde müşterinin seçebileceği en erken alış gününün alt sınırı ("YYYY-MM-DD") ya da null (= yalnız depo kuralı).
 * Gün, depo saat diliminde (Europe/Bucharest) alınır.
 */
export function profilePickupFloor(setting, now) {
  return activeFixedDay(setting, 'profile', localDayKey(now, 'Europe/Bucharest'));
}
