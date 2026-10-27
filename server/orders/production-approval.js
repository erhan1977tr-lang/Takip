// Müşteri üretim onayı (4.2.1) — saf kurallar (veritabanı yok; sayfa, iş akışı ve işçi aynı kuralları kullanır).
//
//   Kapsam (karar 305, ürün sahibinin 26–27.10.2026 kararları): PLANLANAN YÜKLEME TARİHİ kesim gününde (varsayılan 06.11.2026)
//   ya da sonrasında olan cam siparişleri — durumu HAZIRLANIYOR ya da URETIMDE olsun. Kapsam siparişin bayrağıdır
//   (Order.productionApprovalRequired): yeni sipariş oluşturulurken (ayar açık + tahmini yükleme ≥ kesim) ya da mevcut
//   siparişler için açık onaylı geçiş işleminde (production-approval-enroll.js) bir kez yazılır. Kesimden önceki
//   siparişler, profil siparişleri ve telafi (-T) siparişleri bayraksızdır → eski davranış aynen.
//   Bayraklı siparişte müşteriye gönderilen her teklif sürümü müşterinin "Üretime alınmasını onaylıyorum" onayını bekler
//   (Offer.approvedAt). Onay yalnızca EN SON gönderilen sürüme verilir; eski sürüm onaylanamaz. Daha önceki teklif
//   gönderimi onay sayılmaz. Onay durumu ana sipariş durumundan AYRIDIR: HAZIRLANIYOR siparişte otomatik üretime geçişe
//   bir koşul eklenir (productionBlockers → 'offer_not_approved'); URETIMDE siparişte durum değişmez.
//   "Ölçülerde değişiklik var" → sürüm değişiklik istendi olarak işaretlenir (Offer.changeRequestedAt + not). HAZIRLANIYOR
//   siparişte satışa yeni taslak açılır (satış → yönetici → gönder); URETIMDE siparişte yönetici mevcut "Teklifi güncelle"
//   ile yeni sürümü gönderir (satışın yetkisi genişletilmedi). Yeni sürüm yeniden onay ister.
//
//   Süre (4.2.5): talebin müşteriye GERÇEKTEN iletildiği andan itibaren 2 Romanya iş günü — e-posta posta sunucusuna
//   kabul edildiğinde (müşteriye e-posta gidemiyorsa uygulama içi bildirim yazıldığında). İletilemeyen talepte süre
//   başlamaz (production-approval-delivery.js). Europe/Bucharest; cumartesi, pazar ve Romanya resmî tatilleri hariç —
//   depo takviminin elle kapatılan günleri SAYILMAZ. Son tarih = iletim gününden sonraki 2. iş gününün aynı yerel saati.
//   Aradaki bir günün tatil verisi yoksa süre HESAPLANMAZ (null) — tahmin edilmez. Müşteriye bir hatırlatma (1 iş günü sonra).
//
//   Onaysız yükleme engeli (4.2.5 / 4.2.6): kapsamdaki (bayraklı) siparişte müşteriye gönderilmiş son sürüm müşteri
//   tarafından onaylanmadıysa yükleme ("Yükleme yapıldı", "Yüklendi") sunucuda reddedilir; yalnızca yönetici gerekçeyle
//   istisna verebilir (loadingApprovalBlock). Kural güne değil bayrağa bakar: yükleme tarihi değiştirilerek aşılamaz;
//   kesimden önce planlanmış (30.10.2026) siparişler bayraksızdır. Yükleme tarihi değişikliği onayı bozmaz (sürüm değildir).
//
//   Acil durdurma anahtarı (4.2.6): ayar kapalıyken onay zorunluluğu, üretime geçiş ve yükleme engelleri, yeni talepler ve
//   hatırlatmalar YOKTUR (approvalState(enabled: false) → NONE) — 4.2.0 iş akışı. Kayıtlar silinmez; yeniden açılınca
//   kendiliğinden talep yazılmaz.
import { addDaysKey, CALENDARS, dayStatus, localClock } from '../calendar/rules.js';

/** Ayar anahtarı (IntegrationSetting.key) */
export const APPROVAL_SETTING_KEY = 'production-approval';
/** Onay süresi: Romanya iş günü */
export const APPROVAL_BUSINESS_DAYS = 2;
/** Süre hesabının takvimi: Romanya resmî tatilleri + Europe/Bucharest (yöneticinin depo kararları kullanılmaz) */
export const APPROVAL_CALENDAR = 'RO_DEPOT';
export const APPROVAL_TIME_ZONE = CALENDARS[APPROVAL_CALENDAR].timeZone;
/** Kapsamın varsayılan kesim günü: planlanan yükleme tarihi bu gün ya da sonrası olan siparişler (ürün sahibi) */
export const APPROVAL_CUTOFF_DEFAULT = '2026-11-06';
/** Onay isteğinin geçerli olduğu sipariş durumları (yüklenmiş / arşiv / iptal siparişte onay istenmez) */
export const APPROVAL_STATUSES = Object.freeze(['HAZIRLANIYOR', 'URETIMDE']);
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
  return businessDeadline(sentAt, APPROVAL_BUSINESS_DAYS);
}

/** Müşteriye tek hatırlatma: iletimden 1 Romanya iş günü sonra (aynı yerel saat) */
export const APPROVAL_REMINDER_BUSINESS_DAYS = 1;
export function approvalReminderAt(deliveredAt) {
  return businessDeadline(deliveredAt, APPROVAL_REMINDER_BUSINESS_DAYS);
}

/**
 * Andan itibaren n Romanya iş günü sonrası, aynı yerel saat (approvalDeadline ile aynı kural).
 * @param {Date | string} sentAt  @param {number} days
 * @returns {{ due: Date | null, noData: boolean, day: string | null }}
 */
export function businessDeadline(sentAt, days) {
  const at = new Date(sentAt);
  if (Number.isNaN(at.getTime())) return { due: null, noData: false, day: null };
  const local = localClock(at, APPROVAL_TIME_ZONE);
  let day = local.day;
  let counted = 0;
  for (let i = 0; i < 60 && counted < days; i++) {
    day = addDaysKey(day, 1);
    // Yalnızca resmî kural: hafta sonu + Romanya resmî tatili (elle verilen depo kararları geçirilmez)
    const s = dayStatus(APPROVAL_CALENDAR, day, null);
    if (s.noData) return { due: null, noData: true, day: null };
    if (s.open) counted++;
  }
  if (counted < days) return { due: null, noData: false, day: null };
  return { due: localToInstant(day, local.minutes, APPROVAL_TIME_ZONE), noData: false, day };
}

/**
 * Siparişin üretim onayı durumu (en son teklif sürümüne göre).
 *   NONE: onay kuralı uygulanmaz (bayraksız sipariş, hazırlıkta değil, teklif müşteride değil)
 *   PENDING: en son gönderilen sürüm müşterinin onayını bekliyor
 *   APPROVED: en son gönderilen sürüm onaylandı
 *   CHANGE_REQUESTED: müşteri bu sürümde değişiklik istedi (yeni sürüm hazırlanıyor)
 * enabled: özellik ayarı (acil durdurma anahtarı — 4.2.6, ürün sahibinin 27.10.2026 kararı). false → NONE: onay zorunluluğu,
 * üretime geçiş engeli, müşteri işlemleri ve ekrandaki onay bilgisi kalkar; kayıtlar (onaylar, talepler) silinmez.
 * @param {{ required?: boolean | null, status: string, offer?: { status: string, approvedAt?: Date | string | null, changeRequestedAt?: Date | string | null } | null, enabled?: boolean }} p
 * @returns {'NONE' | 'PENDING' | 'APPROVED' | 'CHANGE_REQUESTED'}
 */
export function approvalState({ required, status, offer, enabled = true }) {
  if (enabled === false || !required || !APPROVAL_STATUSES.includes(status) || !offer || offer.status !== 'GONDERILDI') return 'NONE';
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
 * Bayraklı siparişe (HAZIRLANIYOR / URETIMDE) gönderilen sürümün onay alanları + olay verisi. Talep anı = gönderim anı;
 * SÜRE BURADA BAŞLAMAZ (4.2.5): son tarih, talep müşteriye iletildiğinde yazılır (production-approval-delivery.js). Olay
 * verisi yalnızca sürümün kimliğini taşır (e-posta ve bildirim son tarihi iletim anında hesaplar). Bayraksız siparişte ya da
 * başka durumda boş döner (eski davranış).
 * @param {{ productionApprovalRequired?: boolean | null, status: string }} order  @param {Date} now  @param {string} offerId
 * @returns {{ data: { approvalRequestedAt: Date } | null, event: { approval: { offerId: string } } | null }}
 */
export function approvalOnSend(order, now, offerId) {
  // Acil durdurma (4.2.6): özellik kapalıyken yeni onay talebi açılmaz (order.approvalEnabled — siparişi yükleyen yazar)
  if (!order?.productionApprovalRequired || order.approvalEnabled === false || !APPROVAL_STATUSES.includes(order.status)) return { data: null, event: null };
  return { data: { approvalRequestedAt: now }, event: { approval: { offerId } } };
}

/**
 * Onaysız yükleme engeli (4.2.5; 4.2.6 — ürün sahibinin 27.10.2026 kesin kararı). Yalnızca ayar açıkken. Kapsam siparişin
 * BAYRAĞIDIR, yükleme günü değil: kapsama alınmış (planlanan yükleme ≥ kesim günü iken bayrak yazılmış) sipariş, yükleme
 * tarihi sonradan kesim gününden önceye çekilse de onaysız yüklenemez (tarih değiştirerek engel aşılamaz). Kesimden önce
 * planlanmış siparişler (30.10.2026) bayraksızdır → hiç etkilenmez. Yöneticinin istisnası yoksa: müşteriye gönderilmiş SON
 * sürüm müşteri tarafından onaylanmış olmalı. Gönderilmemiş taslak onayı bozmaz (yalnızca gönderilmiş sürüme bakılır);
 * onaydan sonra yeni sürüm gönderildiyse onun onayı gerekir. Yükleme tarihi değişikliği teklif sürümü değildir → onayı bozmaz.
 * @param {{ enabled: boolean, order: { productionApprovalRequired?: boolean | null, loadingOverrideAt?: Date | string | null }, offer?: { status: string, approvedAt?: Date | string | null, changeRequestedAt?: Date | string | null } | null }} p
 *   offer: siparişin müşteriye gönderilmiş SON sürümü (yoksa null)
 * @returns {null | 'NOT_SENT' | 'PENDING' | 'CHANGE_REQUESTED'}
 */
export function loadingApprovalBlock({ enabled, order, offer }) {
  if (!enabled || !order?.productionApprovalRequired || order.loadingOverrideAt) return null;
  if (!offer || offer.status !== 'GONDERILDI') return 'NOT_SENT';
  if (offer.approvedAt) return null;
  return offer.changeRequestedAt ? 'CHANGE_REQUESTED' : 'PENDING';
}

/** Yönetici iletilemeyen talebi şu kadar süre sonra yeniden gönderebilir (kuyruk hâlâ deniyor olabilir) */
export const APPROVAL_RESEND_AFTER_MS = 60 * 60_000;

/**
 * Siparişin üretim onayı işlemleri için bayraklar (availableActions): loadingOverride — kapsamdaki sipariş, yöneticinin
 * istisnası yok, güncel sürüm müşteri tarafından onaylanmadı; approvalResend — güncel sürümün talebi iletilmedi ve iletim
 * hatası kaydedildi ya da talep bir saatten eski (bekleyen gönderim işlem içinde ayrıca denetlenir).
 * @param {{ productionApprovalRequired?: boolean | null, loadingOverrideAt?: any, status: string, offers?: any[], approvalEnabled?: boolean }} order  @param {Date} [now]
 */
export function approvalFlags(order, now = new Date()) {
  const offers = order?.offers ?? [];
  const latest = offers[0] ?? null;
  // Yükleme için müşteriye gönderilmiş SON sürüm (taslak onayı bozmaz); yeniden gönderim yalnızca güncel sürüm müşterideyken
  const sent = offers.find((o) => o.status === 'GONDERILDI') ?? null;
  const flagged = !!order?.productionApprovalRequired && order?.approvalEnabled !== false && APPROVAL_STATUSES.includes(order?.status);
  const approved = !!sent?.approvedAt;
  const pending = latest?.status === 'GONDERILDI' && !latest.approvedAt && !latest.changeRequestedAt;
  // Talep kaydı yoksa (özellik kapalıyken gönderilmiş sürüm) ya da bir saatten eskiyse / iletim hatası varsa yeniden gönderilebilir
  const stale = pending && (!latest.approvalRequestedAt || new Date(latest.approvalRequestedAt).getTime() <= now.getTime() - APPROVAL_RESEND_AFTER_MS);
  return {
    loadingOverride: flagged && !order.loadingOverrideAt && !approved,
    approvalResend: flagged && pending && !latest.approvalDeliveredAt && (!!latest.approvalDeliveryError || stale),
  };
}

/** İstisna gerekçesi: zorunlu, tek satır, en fazla bu kadar karakter */
export const OVERRIDE_REASON_MAX = 1000;
export function overrideReason(value) {
  const r = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!r) return { ok: false, code: 'OVERRIDE_REASON_REQUIRED' };
  if (r.length > OVERRIDE_REASON_MAX) return { ok: false, code: 'OVERRIDE_REASON_TOO_LONG' };
  return { ok: true, reason: r };
}

/** Ayarın değeri (eksik / bozuk = kapalı) */
export function approvalSettingOn(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && value.enabled === true);
}

/** Ayardaki kesim günü (geçersiz / yoksa varsayılan) */
export function approvalCutoff(value) {
  const c = value && typeof value === 'object' && !Array.isArray(value) ? value.cutoff : null;
  return typeof c === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c) && !Number.isNaN(Date.parse(`${c}T12:00:00Z`)) ? c : APPROVAL_CUTOFF_DEFAULT;
}

/**
 * Sipariş kapsamda mı: planlanan yükleme günü (yerel gün, "YYYY-MM-DD") kesim günü ya da sonrası. Gün yoksa hayır.
 * @param {string | null | undefined} shipDay  @param {string} cutoff
 */
export function inApprovalScope(shipDay, cutoff) {
  return typeof shipDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(shipDay) && shipDay >= cutoff;
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
