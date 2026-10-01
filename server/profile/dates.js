// Profil siparişi tarih kuralları (ürün sahibinin kararları, Aşama 6):
//   - Depo hafta sonu çalışmaz: alış tarihi cumartesi / pazar olamaz.
//   - Mal en erken ödeme gününden sonraki ilk iş günü alınabilir.
//   - Müşteri onayda bir tarih seçer; ödeme gelmeden önce en erken bugünden sonraki ilk iş günü seçilebilir
//     (bugün ödenirse yarın alınabilir).
//   - Ödeme teyit edilince sipariş hemen depoya gider (yönetici ödemeden önce de "Siparişi depoya gönder" diyebilir);
//     müşterinin seçtiği gün ödemeden sonraki ilk iş gününden önceyse o güne kayar.
// Tarihler "gün" olarak tutulur: gün ortası (12:00 UTC) Date — saat dilimi kaymasın diye (rules.js → parseDateOnly ile aynı).
// Resmî tatiller dikkate alınmaz (yalnızca hafta sonu).

export const MAX_PICKUP_DAYS = 180;

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

/** Cumartesi ve pazar dışındaki günler */
export function isWorkingDay(d) {
  const w = new Date(d).getUTCDay();
  return w !== 0 && w !== 6;
}

/** Verilen günden SONRAKİ ilk iş günü (gün ortası tarih) */
export function nextWorkingDay(d) {
  const x = dayDate(dayKeyOf(d));
  do x.setUTCDate(x.getUTCDate() + 1);
  while (!isWorkingDay(x));
  return x;
}

/** Günü n gün ileri alır */
export function addDays(d, n) {
  const x = dayDate(dayKeyOf(d));
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/**
 * Seçilebilecek en erken alış günü.
 * @param {{ today: Date, paidAt?: Date | null }} p  today: yerel bugün (gün ortası)
 */
export function earliestPickup({ today, paidAt = null }) {
  // Ödeme yoksa: en erken bugün ödenir → bugünden sonraki ilk iş günü
  return nextWorkingDay(paidAt ?? today);
}

/**
 * Alış tarihi sorunu ya da null. Kodlar: PICKUP_WEEKEND | PICKUP_TOO_EARLY | PICKUP_TOO_LATE
 * @param {Date} date
 * @param {{ today: Date, paidAt?: Date | null }} ctx
 */
export function pickupProblem(date, ctx) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'PICKUP_INVALID';
  if (!isWorkingDay(date)) return 'PICKUP_WEEKEND';
  if (dayKeyOf(date) < dayKeyOf(earliestPickup(ctx))) return 'PICKUP_TOO_EARLY';
  if (dayKeyOf(date) > dayKeyOf(addDays(ctx.today, MAX_PICKUP_DAYS))) return 'PICKUP_TOO_LATE';
  return null;
}

/**
 * Ödeme teyit edilince müşterinin alış günü: seçtiği gün ödemeden sonraki ilk iş gününden önceyse o güne kayar.
 * Ödeme günü geçmişte girildiyse alış günü bugünden (iş günü değilse sonraki iş gününden) önce olmaz.
 * @param {{ paidAt: Date, pickupDate: Date | null, today: Date }} p
 * @returns {{ pickupDate: Date, moved: boolean }}
 */
export function pickupAfterPayment({ paidAt, pickupDate, today }) {
  let earliest = nextWorkingDay(paidAt);
  if (dayKeyOf(earliest) < dayKeyOf(today)) earliest = isWorkingDay(today) ? dayDate(dayKeyOf(today)) : nextWorkingDay(today);
  const moved = !pickupDate || dayKeyOf(pickupDate) < dayKeyOf(earliest);
  return { pickupDate: moved ? earliest : dayDate(dayKeyOf(pickupDate)), moved };
}

/** Yerel günün başlangıç anı (saat diliminde gece yarısı) */
export function localDayStart(now, timeZone) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return new Date(now.getTime() - ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 - now.getMilliseconds());
}
