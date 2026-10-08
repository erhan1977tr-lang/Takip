// Profil siparişi tarih kuralları — Romanya deposunun çalışma takvimiyle (Paket 8, karar 192, 194; Aşama 6 kurallarının yerine).
//   - Depo yalnızca açık günlerde çalışır: hafta sonu, Romanya resmî tatilleri ve yöneticinin kapattığı günler kapalı;
//     yöneticinin elle açtığı gün açıktır (server/calendar/rules.js, takvim RO_DEPOT, saat dilimi Europe/Bucharest —
//     APP_TIMEZONE'dan bağımsız).
//   - Depo teslim (alış) günü, siparişin depoya İLETİLDİĞİ ana göre hesaplanır (depotReadyDay): açık bir günde saat 12:00'ye
//     kadar (12:00 dahil, 12:00:59'a kadar) iletilen sipariş bir sonraki açık günde, 12:00'den sonra iletilen sipariş ondan
//     sonraki açık günde teslim edilebilir; kapalı günde iletilen sipariş ilk açık günün başında işleme alınmış sayılır ve
//     ondan sonraki açık güne planlanır. Hesap sunucuda yapılır; tarayıcı saatine güvenilmez.
//   - Müşteri onayda (ve depoya gidene kadar) bir alış günü seçer: en erken = sipariş ŞİMDİ iletilse hesaplanan gün.
//   - Sipariş depoya iletilince ("Ödeme alındı" ya da ödemeden önce "Siparişi depoya gönder") alış günü o anın kuralıyla
//     yeniden denetlenir: daha erkense (ya da depo o gün kapalıysa) ileri kayar (pickupOnForward) ve müşteriye bildirilir.
//   - Yönetici teslim gününü depoda iken de değiştirebilir (açık bir gün, bugünden önce olamaz); en erken kural ona uygulanmaz.
//   - Bu tarih tahminidir: stok durumu hesaba katılmaz (stok yetersizliği siparişi engellemez — karar 165).
// Tarihler "gün" olarak tutulur: gün ortası (12:00 UTC) Date — saat dilimi kaymasın diye (rules.js → parseDateOnly ile aynı).
import { CALENDARS, localClock, nextOpenDay, openOnOrAfter, dayStatus } from '../calendar/rules.js';

export const MAX_PICKUP_DAYS = 180;
/** Depo takvimi ve saat dilimi */
export const DEPOT_CALENDAR = 'RO_DEPOT';
export const DEPOT_TIME_ZONE = CALENDARS.RO_DEPOT.timeZone;
/** Kesim saati (dakika): 12:00 dahil */
export const DEPOT_CUTOFF_MINUTES = 12 * 60;

/** "YYYY-MM-DD" → gün ortası UTC Date */
export const dayDate = (key) => new Date(`${key}T12:00:00.000Z`);
/** Date → "YYYY-MM-DD" (UTC günü; gün ortası tarihlerle kullanılır) */
export const dayKeyOf = (d) => new Date(d).toISOString().slice(0, 10);

/** Verilen andaki yerel gün ("YYYY-MM-DD") */
export function localDay(now, timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Günü n gün ileri alır */
export function addDays(d, n) {
  const x = dayDate(dayKeyOf(d));
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Deponun bugünü (Europe/Bucharest), gün ortası */
export const depotToday = (now = new Date()) => dayDate(localDay(now, DEPOT_TIME_ZONE));

/**
 * Depo bu gün açık mı (yöneticinin kararı → hafta sonu → resmî tatil).
 * @param {Date | string} d  gün ortası tarih ya da "YYYY-MM-DD"
 * @param {Map<string, { open: boolean }> | null} [overrides]
 */
export function depotOpen(d, overrides = null) {
  return dayStatus(DEPOT_CALENDAR, typeof d === 'string' ? d : dayKeyOf(d), overrides).open;
}

/** Bir hesap için açık gün bulunamadı (yönetici sonraki 400 günü kapatmış): tarih verilemez */
export class NoOpenDayError extends Error {
  constructor() {
    super('NO_OPEN_DAY');
    this.code = 'NO_OPEN_DAY';
  }
}
const must = (day) => {
  if (!day) throw new NoOpenDayError();
  return day;
};

/** Verilen günden SONRAKİ ilk açık depo günü (gün ortası) */
export function nextDepotDay(d, overrides = null) {
  return dayDate(must(nextOpenDay(DEPOT_CALENDAR, typeof d === 'string' ? d : dayKeyOf(d), overrides)));
}

/**
 * Depo teslim günü: sipariş depoya `at` anında iletilirse en erken teslim (alış) günü (gün ortası).
 * @param {Date} at  @param {Map<string, { open: boolean }> | null} [overrides]
 */
export function depotReadyDay(at, overrides = null) {
  const { day, minutes } = localClock(at, DEPOT_TIME_ZONE);
  const cal = DEPOT_CALENDAR;
  if (depotOpen(day, overrides)) {
    const first = must(nextOpenDay(cal, day, overrides));
    return dayDate(minutes <= DEPOT_CUTOFF_MINUTES ? first : must(nextOpenDay(cal, first, overrides)));
  }
  // Kapalı gün: ilk açık günün başında işleme alınmış sayılır → ondan sonraki açık gün
  const processing = must(nextOpenDay(cal, day, overrides));
  return dayDate(must(nextOpenDay(cal, processing, overrides)));
}

/**
 * Müşterinin seçebileceği en erken alış günü: sipariş şimdi depoya iletilse hesaplanan gün.
 * @param {{ now: Date, overrides?: Map<string, { open: boolean }> | null }} p
 */
export function earliestPickup({ now, overrides = null }) {
  return depotReadyDay(now, overrides);
}

/**
 * Alış günü sorunu ya da null. Kodlar: PICKUP_INVALID | PICKUP_WEEKEND | PICKUP_CLOSED | PICKUP_PAST | PICKUP_TOO_EARLY |
 * PICKUP_TOO_LATE. staff (yönetici): en erken kural uygulanmaz; yalnızca açık gün, bugünden önce değil.
 * @param {Date} date
 * @param {{ now: Date, overrides?: Map<string, { open: boolean }> | null, staff?: boolean }} ctx
 */
export function pickupProblem(date, { now, overrides = null, staff = false }) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'PICKUP_INVALID';
  const key = dayKeyOf(date);
  const st = dayStatus(DEPOT_CALENDAR, key, overrides);
  if (!st.open) return st.reason === 'WEEKEND' ? 'PICKUP_WEEKEND' : 'PICKUP_CLOSED';
  const today = depotToday(now);
  if (staff && key < dayKeyOf(today)) return 'PICKUP_PAST';
  if (!staff) {
    let earliest;
    try {
      earliest = earliestPickup({ now, overrides });
    } catch (e) {
      if (e instanceof NoOpenDayError) return 'PICKUP_CLOSED';
      throw e;
    }
    if (key < dayKeyOf(earliest)) return 'PICKUP_TOO_EARLY';
  }
  if (key > dayKeyOf(addDays(today, MAX_PICKUP_DAYS))) return 'PICKUP_TOO_LATE';
  return null;
}

/**
 * Sipariş depoya iletilirken (ödeme teyidi ya da "Siparişi depoya gönder") alış günü: seçilen gün iletim anının depo
 * kuralından erkense ya da depo o gün kapalıysa ileri kayar (açık bir güne). Seçilmemişse depo kuralının günü.
 * @param {{ now: Date, pickupDate: Date | null, overrides?: Map<string, { open: boolean }> | null }} p
 * @returns {{ pickupDate: Date, moved: boolean, earliest: Date }}
 */
export function pickupOnForward({ now, pickupDate, overrides = null }) {
  const earliest = depotReadyDay(now, overrides);
  if (!pickupDate) return { pickupDate: earliest, moved: true, earliest };
  const chosen = dayKeyOf(pickupDate);
  const target = chosen < dayKeyOf(earliest) ? dayKeyOf(earliest) : chosen;
  const day = must(openOnOrAfter(DEPOT_CALENDAR, target, overrides));
  return { pickupDate: dayDate(day), moved: day !== chosen, earliest };
}

/**
 * Teslim günü müşteriye nasıl gösterilir (yalnızca görünüm — durum eklemez, karar 194): depoda değilse yok; depodaysa
 * "hazırlanıyor" ya da teslim günü geldiyse "teslimata hazır (tahmini)"; teslim edildiyse "teslim edildi".
 * @param {{ stage: string, status: string, pickupDate: Date | null, now: Date }} p
 * @returns {'PREPARING' | 'READY' | 'DELIVERED' | null}
 */
export function depotPhase({ stage, status, pickupDate, now }) {
  if (status === 'IPTAL') return null;
  if (stage === 'TESLIM_EDILDI' || stage === 'FATURALANDI') return 'DELIVERED';
  if (stage !== 'DEPODA') return null;
  return pickupDate && dayKeyOf(pickupDate) <= dayKeyOf(depotToday(now)) ? 'READY' : 'PREPARING';
}

/** Yerel günün başlangıç anı (saat diliminde gece yarısı) */
export function localDayStart(now, timeZone) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return new Date(now.getTime() - ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 - now.getMilliseconds());
}
