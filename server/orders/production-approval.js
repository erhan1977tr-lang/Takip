// Müşteri üretim onayı (4.2.1) — saf kurallar (veritabanı yok; sayfa, iş akışı ve işçi aynı kuralları kullanır).
//
//   Kapsam: özellik açıkken (IntegrationSetting 'production-approval') oluşturulan müşteri cam siparişleri
//   (Order.productionApprovalRequired). Eski siparişler ve telafi (-T) siparişleri bayraksızdır → eski kural aynen.
//   Bayraklı sipariş HAZIRLANIYOR'dayken müşteriye gönderilen her teklif sürümü müşterinin "Üretime alınmasını
//   onaylıyorum" onayını bekler (Offer.approvedAt). Onay yalnızca EN SON gönderilen sürüme verilir; eski sürüm onaylanamaz.
//   "Ölçülerde değişiklik var" → sürüm değişiklik istendi olarak işaretlenir (Offer.changeRequestedAt + not), satışa yeni
//   taslak açılır; mevcut satış → yönetici → müşteriye gönder akışı yeni sürümü üretir, o sürüm de yeniden onay ister.
//   Ana sipariş durumları değişmez; yalnızca otomatik üretime geçişe bir koşul eklenir (productionBlockers →
//   'offer_not_approved').
//
//   Süre: gönderim anından itibaren 2 Romanya iş günü (Europe/Bucharest; cumartesi, pazar ve Romanya resmî tatilleri
//   hariç — depo takviminin elle kapatılan günleri SAYILMAZ). Son tarih = gönderim gününden sonraki 2. iş gününün aynı
//   yerel saati (dakika). Aradaki bir günün tatil verisi yoksa süre HESAPLANMAZ (null) — tahmin edilmez.
import { addDaysKey, CALENDARS, dayStatus, localClock } from '../calendar/rules.js';

/** Ayar anahtarı (IntegrationSetting.key) */
export const APPROVAL_SETTING_KEY = 'production-approval';
/** Onay süresi: Romanya iş günü */
export const APPROVAL_BUSINESS_DAYS = 2;
/** Süre hesabının takvimi: Romanya resmî tatilleri + Europe/Bucharest (yöneticinin depo kararları kullanılmaz) */
export const APPROVAL_CALENDAR = 'RO_DEPOT';
export const APPROVAL_TIME_ZONE = CALENDARS[APPROVAL_CALENDAR].timeZone;
/** Değişiklik talebi notu: zorunlu, en fazla bu kadar karakter */
export const CHANGE_NOTE_MAX = 2000;

/**
 * Yerel gün + dakika → UTC an (saat dilimi kurallarıyla; yaz / kış saati geçişleri dahil).
 * @param {string} day  "YYYY-MM-DD"  @param {number} minutes  @param {string} timeZone
 */
export function localToInstant(day, minutes, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const offsetAt = (ms) => {
    const c = localClock(new Date(ms), timeZone);
    const [yy, mm, dd] = c.day.split('-').map(Number);
    return Date.UTC(yy, mm - 1, dd, Math.floor(c.minutes / 60), c.minutes % 60) - ms;
  };
  let guess = wall - offsetAt(wall);
  // Geçiş anına yakınsa bir kez daha düzelt
  const second = wall - offsetAt(guess);
  if (second !== guess) guess = second;
  return new Date(guess);
}

/**
 * Onay son tarihi: gönderim anından itibaren APPROVAL_BUSINESS_DAYS Romanya iş günü, aynı yerel saat.
 * Hafta sonu / tatil gönderiminde de sayım gönderim gününden SONRAKİ ilk iş gününden başlar.
 * @param {Date | string} sentAt
 * @returns {{ due: Date | null, noData: boolean, day: string | null }}  noData: aradaki bir yılın tatil verisi yok → süre yok
 */
export function approvalDeadline(sentAt) {
  const at = new Date(sentAt);
  if (Number.isNaN(at.getTime())) return { due: null, noData: false, day: null };
  const local = localClock(at, APPROVAL_TIME_ZONE);
  let day = local.day;
  let counted = 0;
  for (let i = 0; i < 60 && counted < APPROVAL_BUSINESS_DAYS; i++) {
    day = addDaysKey(day, 1);
    // Yalnızca resmî kural: hafta sonu + Romanya resmî tatili (elle verilen depo kararları geçirilmez)
    const s = dayStatus(APPROVAL_CALENDAR, day, null);
    if (s.noData) return { due: null, noData: true, day: null };
    if (s.open) counted++;
  }
  if (counted < APPROVAL_BUSINESS_DAYS) return { due: null, noData: false, day: null };
  return { due: localToInstant(day, local.minutes, APPROVAL_TIME_ZONE), noData: false, day };
}

/**
 * Siparişin üretim onayı durumu (en son teklif sürümüne göre).
 *   NONE: onay kuralı uygulanmaz (bayraksız sipariş, hazırlıkta değil, teklif müşteride değil)
 *   PENDING: en son gönderilen sürüm müşterinin onayını bekliyor
 *   APPROVED: en son gönderilen sürüm onaylandı
 *   CHANGE_REQUESTED: müşteri bu sürümde değişiklik istedi (yeni sürüm hazırlanıyor)
 * @param {{ required?: boolean | null, status: string, offer?: { status: string, approvedAt?: Date | string | null, changeRequestedAt?: Date | string | null } | null }} p
 * @returns {'NONE' | 'PENDING' | 'APPROVED' | 'CHANGE_REQUESTED'}
 */
export function approvalState({ required, status, offer }) {
  if (!required || status !== 'HAZIRLANIYOR' || !offer || offer.status !== 'GONDERILDI') return 'NONE';
  if (offer.approvedAt) return 'APPROVED';
  if (offer.changeRequestedAt) return 'CHANGE_REQUESTED';
  return 'PENDING';
}

/**
 * Süre doldu mu (müşteri onay hakkını kaybetmez; yalnızca yöneticiye bir kez bildirilir).
 * @param {{ approvalDueAt?: Date | string | null }} offer  @param {Date} [now]
 */
export function approvalOverdue(offer, now = new Date()) {
  return !!offer?.approvalDueAt && new Date(offer.approvalDueAt).getTime() <= now.getTime();
}

/**
 * Değişiklik talebi notu: zorunlu, tek satıra indirilmez (müşterinin yazdığı gibi), en fazla CHANGE_NOTE_MAX karakter.
 * @returns {{ ok: true, note: string } | { ok: false, code: 'CHANGE_NOTE_REQUIRED' | 'CHANGE_NOTE_TOO_LONG' }}
 */
export function changeNote(value) {
  const note = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!note) return { ok: false, code: 'CHANGE_NOTE_REQUIRED' };
  if (note.length > CHANGE_NOTE_MAX) return { ok: false, code: 'CHANGE_NOTE_TOO_LONG' };
  return { ok: true, note };
}

/**
 * Bayraklı sipariş hazırlıktayken gönderilen sürümün onay alanları + olay verisi (e-posta ve bildirim son tarihi yazar).
 * Bayraksız siparişte ya da hazırlık dışında boş döner (eski davranış).
 * @param {{ productionApprovalRequired?: boolean | null, status: string }} order  @param {Date} now
 * @returns {{ data: { approvalDueAt: Date | null } | null, event: { approval: { due: string | null } } | null, noData: boolean }}
 */
export function approvalOnSend(order, now) {
  if (!order?.productionApprovalRequired || order.status !== 'HAZIRLANIYOR') return { data: null, event: null, noData: false };
  const d = approvalDeadline(now);
  return { data: { approvalDueAt: d.due }, event: { approval: { due: d.due ? d.due.toISOString() : null } }, noData: d.noData };
}

/** Ayarın değeri (eksik / bozuk = kapalı) */
export function approvalSettingOn(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && value.enabled === true);
}

/**
 * Son tarihin metni (e-posta, bildirim, ekran): Romanya saatiyle "gg.aa.yyyy ss:dd". Geçersiz / boş → null.
 * @param {Date | string | null | undefined} at
 */
export function approvalDueText(at) {
  const d = at instanceof Date ? at : typeof at === 'string' && at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const c = localClock(d, APPROVAL_TIME_ZONE);
  const [y, m, day] = c.day.split('-');
  return `${day}.${m}.${y} ${String(Math.floor(c.minutes / 60)).padStart(2, '0')}:${String(c.minutes % 60).padStart(2, '0')}`;
}
