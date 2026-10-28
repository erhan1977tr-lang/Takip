// Bildirim e-postaları (Aşama 8 başlangıcı): iş akışı işlemleri zaten aynı veritabanı işleminde NotificationOutbox'a
// olay yazıyor (ORDER_<OLAY>, ORDER_CREATED). Bu modül işçide (scripts/worker.mjs) o olaylardan seçilenleri, işlem
// tamamlandıktan SONRA, mevcut SMTP bağlantısıyla (server/mail/transport.js, .env) e-postaya çevirir. Gönderim hatası
// işlemi etkilemez: satır kuyrukta kalır, artan aralıklarla yeniden denenir, sonunda FAILED + lastError olur.
//
// Kural tablosu (olay → alıcı) NOTIFY_RULES'ta. FGO belgeleri (cam ve profil: proforma / avans / fatura) müşteriye ayrı
// bir belge e-postasıyla (PDF ekiyle) gider (server/documents/delivery.js → DOC_EMAIL; e-postayı yalnızca TAKİP gönderir,
// karar 111) — burada tekrarlanmaz: profilin PROFORMA / INVOICED olayı, belge FGO'da kesildiyse e-postaya çevrilmez
// (aynı belge için iki e-posta gitmesin); belge elle girildiyse (FGO belgesi yok) bildirim e-postası yine gider.
// Alıcı seçimi rol adına değil yetkiye göredir (server/auth/permissions.js). Satış ve çizim e-postada firma adını
// maskeli görür (ekrandaki kural). Bağlantı: uygulamadaki sipariş sayfası (giriş ve yetki gerekir).
import { can, ROLE_PERMISSIONS } from '../auth/permissions.js';
import { maskName } from '../orders/rules.js';
import { translate } from '../i18n/index.js';
import { brandedHtml, sendBrandedMail } from '../mail/send.js';
import { customerMailLang, snapshotLang } from './lang.js';
import { approvalDeadline, approvalDueText } from '../orders/production-approval.js';
import {
  APPROVAL_REMINDER_TYPE, APPROVAL_REQUEST_TYPES, approvalForMail, approvalOfferId, inAppDeliveredAt, markDelivered, markUndelivered,
} from '../orders/production-approval-delivery.js';
import { approvalGateSetting } from '../orders/loading-approval.js';

/**
 * customerFirm: siparişin FİRMASININ bütün etkin, silinmemiş, e-posta bildirimi açık müşteri kullanıcıları + firmanın genel
 * adresi (4.2.11 — teklif ve üretim onayı olayları) · customer: siparişi açan müşteri kullanıcısı + firmanın genel adresi
 * (öbür müşteri olayları — eski kural; firma adresi izolasyonu 4.2.11) · sales: BÜTÜN etkin satış kullanıcıları · admin / drawer: iç ekip ·
 * orderSales: siparişle ilgilenen satışçı (order.salesUsers — bkz. orderSalesUsers).
 * Müşterinin çizim onayı: atanmış çizimci + ilgili satışçı; yöneticiye gitmez (karar 84).
 * Bütün satış ekibine (4.2.11, ürün sahibi 28.10.2026): yeni cam siparişi, müşterinin çizim revizyonu (+ atanmış çizimci),
 * teklif değişiklik talebi ve üretim onayı. 4.2.x'te satış zaten bütün cam siparişlerini görür (orderScope): e-posta hiçbir
 * erişimi genişletmez — içerik satışın sipariş sayfasında gördüğüdür (firma adı maskeli), bağlantı giriş ve sayfanın kendi yetki
 * denetimini ister. Yönetici ve yardımcısı bu dört olayı uygulama içi bildirimle alır (e-posta değil — değişmedi).
 * Yöneticinin e-postaları (Yönetici Paneli Paketi 1, karar 218) yalnızca şu olaylarda: müşterinin yeni siparişi (cam ve
 * profil), satışın fabrika fiyatını gerçekten değiştirmesi (ORDER_PRICE_OVERRIDE — aynı fiyatın yeniden gönderimi olay
 * yazmaz), satışın yöneticiye gönderdiği teklifi geri alması, telafi camında müşteri fiyatının değişmesi (farklı fiyat /
 * bedelsiz — aynı fiyat olay yazmaz) ve müşterinin profil teklifini onaylaması. Şifre sıfırlamayı yönetici başlatır ve kod
 * kullanıcıya kendiliğinden gider: yöneticiye e-posta yok. Rutin yönetici e-postası yoktur.
 */
export const NOTIFY_RULES = {
  ORDER_CREATED: (o) => (o.orderTypeCode === 'PROFILE_ORDER' ? ['admin'] : ['sales', 'admin']),
  ORDER_PRICE_OVERRIDE: () => ['admin'],
  ORDER_OFFER_WITHDRAWN: () => ['admin'],
  ORDER_COMPENSATION_PRICE: () => ['admin'],
  ORDER_SENT_TO_DRAWING: () => ['drawer'],
  // Müşterinin revizyon talebi: atanmış çizimci + bütün satış ekibi (4.2.11; eskiden yalnızca ilgili satışçı)
  ORDER_REVISION_REQUESTED: () => ['drawer', 'sales'],
  ORDER_DRAWING_APPROVED: () => ['drawer', 'orderSales'],
  // Müşterinin teklif değişiklik talebi (4.2.10, karar 306): bütün satış ekibine e-posta (4.2.11; 4.2.10'da ilgili satışçı —
  // uygulama içi bildirim yönetici + ilgili satışçı, değişmedi); müşterinin notu ve (hazırsa) saklanan Türkçe çevirisi yazılır
  ORDER_OFFER_CHANGE_REQUESTED: () => ['sales'],
  // Müşterinin üretim onayı (4.2.11 — 4.2.1'den beri yalnızca uygulama içi bildirimdi): bütün satış ekibine e-posta; yönetici ve
  // yardımcısı uygulama içi bildirimle (değişmedi). Kural SONRADAN eklendiği için eski satırlar e-postaya dönüşmez (STAMPED_MAIL_TYPES)
  ORDER_PRODUCTION_APPROVED: () => ['sales'],
  // Müşterinin DWG/DXF çizimi (karar 167): "hatalı" kararı müşteriye (açıklama e-postaya yazılmaz — sipariş sayfasında
  // Romence çevirisiyle); müşterinin yanıtı (düzeltilmiş dosya / fabrika çizimi) çizimciye + ilgili satışçıya
  ORDER_DWG_FAULTY: () => ['customer'],
  // Hatalı kararı geri alındı (karar 285): hatalı kararını e-postayla alan müşteriye tek e-posta (giden kuyruk, olay başına bir satır)
  ORDER_DWG_FAULTY_UNDONE: () => ['customer'],
  ORDER_DWG_RESUBMITTED: () => ['drawer', 'orderSales'],
  ORDER_DWG_FACTORY_REQUESTED: () => ['drawer', 'orderSales'],
  ORDER_PROFILE_APPROVED: () => ['admin'],
  ORDER_DRAWING_UPLOADED: () => ['customer'],
  // Teklif ve üretim onayı (4.2.11, ürün sahibi 28.10.2026): firmanın BÜTÜN etkin, e-postası açık kullanıcılarına + firma adresine
  ORDER_OFFER_SENT: () => ['customerFirm'],
  ORDER_OFFER_UPDATED: () => ['customerFirm'],
  // Müşteri üretim onayı (karar 305): mevcut siparişin geçişte açılan onay talebi — müşteriye (onay metni + son tarih)
  ORDER_PRODUCTION_APPROVAL_REQUESTED: () => ['customerFirm'],
  // Onay bekleyen müşteriye tek hatırlatma (4.2.5): iletimden 1 Romanya iş günü sonra, sürüm başına bir kez
  ORDER_PRODUCTION_APPROVAL_REMINDER: () => ['customerFirm'],
  ORDER_PROFILE_OFFER_SENT: () => ['customer'],
  ORDER_PROFORMA: () => ['customer'],
  ORDER_INVOICED: () => ['customer'],
  ORDER_SHIP_DATE: () => ['customer'],
  // Profil teslim günü (Paket 8, karar 194): yöneticinin değişikliği / depoya iletilirken kayma → müşteriye (tercihine göre)
  ORDER_DELIVERY_DATE_CHANGED: () => ['customer'],
  ORDER_PICKUP_MOVED: () => ['customer'],
};
/** Olayın verisinde gün taşıyan teslim günü olayları (e-postada "Tahmini teslim günü" satırı + açıklama) */
const DELIVERY_DAY_TYPES = ['ORDER_DELIVERY_DATE_CHANGED', 'ORDER_PICKUP_MOVED'];
export const NOTIFY_TYPES = Object.keys(NOTIFY_RULES);
/**
 * E-posta kuralı SONRADAN eklenen olay türleri (4.2.11: ORDER_PRODUCTION_APPROVED). Bu türlerin olayları yıllarca yalnızca
 * uygulama içi bildirim için yazıldı ve e-posta dağıtıcısı onlara hiç bakmadığından PENDING kaldı (normal). Kural eklenince
 * bu eski satırlar e-postaya DÖNÜŞMEZ: satır ancak kuralı bilen kodun kuyruğa yazarken koyduğu damgayı (payload.emailRule —
 * journal.js → enqueueOutbox) taşıyorsa e-postaya çevrilir. Damgasız eski satırlar hiç seçilmez ve DOKUNULMADAN kalır
 * (durum değişmez — uygulama içi kanal etkilenmez). Geçmiş bildirimler toplu gönderilmez. Yeni bir türe e-posta kuralı
 * eklenirken tür buraya da yazılmalıdır.
 */
export const STAMPED_MAIL_TYPES = Object.freeze(['ORDER_PRODUCTION_APPROVED']);
const BASE_MAIL_TYPES = NOTIFY_TYPES.filter((t) => !STAMPED_MAIL_TYPES.includes(t));
/** E-postaya çevrilebilen kuyruk satırı: eski türler + damgalı yeni tür satırları (Prisma where parçası) */
const MAILABLE = { OR: [{ type: { in: BASE_MAIL_TYPES } }, { type: { in: [...STAMPED_MAIL_TYPES] }, payload: { path: ['emailRule'], equals: true } }] };
export const NOTIFY_SINCE_KEY = 'notify.since';
export const NOTIFY_MAX_ATTEMPTS = 6;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120][Math.min(attempt - 1, 5)];

const rolesWith = (pred) => Object.keys(ROLE_PERMISSIONS).filter(pred);
const ROLE_SETS = {
  admin: rolesWith((r) => can(r, 'OFFER_SEND')),
  sales: rolesWith((r) => can(r, 'OFFER_PREPARE') && !can(r, 'OFFER_SEND')),
  drawer: rolesWith((r) => can(r, 'DRAWING_WORK') && !can(r, 'OFFER_SEND')),
};

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const loc = (l) => (l === 'tr' ? 'tr' : 'ro');

/**
 * Olayın alıcıları: [{ email, locale, role }] (e-postaya göre tekil — aynı adrese bir olay için tek e-posta). role: firma adı
 * maskesi için (müşteride null).
 * lang: olay yazılırken belirlenen müşteri e-posta dili (payload.lang — karar 200); yoksa (eski olay) bugünkü kural.
 * actorId: işlemi yapan — yönetici kümesinde kendisine kendi işlemi e-postalanmaz (karar 218).
 * at: olayın anı (kuyruk satırının createdAt'i) — satış ve müşteri kullanıcılarından yalnızca o anda VAR OLAN hesaplar alır
 * (4.2.11): gecikmeli ya da yeniden denenen bir olay sonradan açılmış hesaba geçmiş bildirim olarak gitmez.
 * Pasif kullanıcıya operasyonel e-posta GİTMEZ (Paket A, karar 220): bütün kitlelerde — müşteri kullanıcıları, atanmış
 * çizimci, ilgili satışçı / satış ekibi, yönetici ve diğer roller — yalnızca etkin, silinmemiş hesaplar (uygulama içi bildirimle
 * aynı kural). Satıştan geçmeyen sipariş tipinde (orderType.usesSales = false — profil) satış kitlesi boştur: satış, göremediği
 * siparişin e-postasını almaz (orderScope ile aynı sınır).
 * @param {any} db @param {string} type @param {any} order
 * @param {{ lang?: 'ro' | 'tr' | null, actorId?: string | null, at?: Date | string | null }} [o]
 */
export async function recipientsFor(db, type, order, { lang: snapshot = null, actorId = null, at = null } = {}) {
  const audiences = NOTIFY_RULES[type]?.(order) ?? [];
  const out = new Map();
  const add = (email, locale, role) => {
    if (!isEmail(email)) return;
    const k = email.trim().toLowerCase();
    if (!out.has(k)) out.set(k, { email: email.trim(), locale: loc(locale), role });
  };
  const opened = at ? { createdAt: { lte: new Date(at) } } : {};
  const salesSees = order?.orderType?.usesSales !== false;
  for (const a of audiences) {
    if (a === 'customer' || a === 'customerFirm') {
      for (const r of await customerRecipients(db, order, { snapshot, opened, firmWide: a === 'customerFirm' })) add(r.email, r.locale, null);
    } else if (a === 'drawer' && order.assignedDrawer) {
      if (order.assignedDrawer.isActive !== false) add(order.assignedDrawer.email, order.assignedDrawer.language, order.assignedDrawer.appRole);
    } else if (a === 'orderSales') {
      if (!salesSees) continue;
      // İlgili satışçı biliniyorsa yalnızca o; bilinmiyorsa (siparişi yönetici yönlendirdiyse) satış ekibi. Yönetici değil.
      const known = (order.salesUsers ?? []).filter((u) => u.isActive !== false && ROLE_SETS.sales.includes(u.appRole));
      const users = known.length ? known : await db.user.findMany({
        where: { appRole: { in: ROLE_SETS.sales }, isActive: true, deletedAt: null, ...opened },
        select: { email: true, language: true, appRole: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const u of users) add(u.email, u.language, u.appRole);
    } else if (a === 'admin') {
      const users = await db.user.findMany({ where: { appRole: { in: ROLE_SETS.admin }, isActive: true }, select: { id: true, email: true, language: true, appRole: true } });
      for (const u of users) if (!actorId || u.id !== actorId) add(u.email, u.language, u.appRole);
    } else {
      if (a === 'sales' && !salesSees) continue;
      const users = await db.user.findMany({
        where: { appRole: { in: ROLE_SETS[a] ?? [] }, isActive: true, deletedAt: null, ...opened },
        select: { email: true, language: true, appRole: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const u of users) add(u.email, u.language, u.appRole);
    }
  }
  return [...out.values()];
}

/**
 * Müşteri kitlesinin e-posta alıcıları. Firma yalnızca siparişin kendi firmasıdır (order.customerId — gönderim anındaki kayıt):
 * başka firmanın kullanıcısı hiçbir koşulda alıcı olmaz.
 *   - firmWide (customerFirm — 4.2.11, ürün sahibi 28.10.2026: teklif gönderildi / güncellendi, üretim onayı talebi ve
 *     hatırlatması): firmanın bütün etkin, silinmemiş, e-posta bildirimi açık müşteri kullanıcıları (olaydan sonra açılan hesap
 *     hariç — opened); siparişi açanın tercihi yalnızca kendisini etkiler.
 *   - değilse (customer — öbür müşteri olayları, eski kural aynen): siparişi açan müşteri kullanıcısı (aynı firmada, etkin);
 *     siparişi açan e-postayı kapattıysa bu siparişin bu olaylarına müşteri e-postası gitmez (firma adresi dahil).
 *   - firmanın genel adresi (Customer.email — iki kuralda da): adres bir giriş hesabının adresiyse yalnızca bu firmanın etkin,
 *     silinmemiş, e-posta bildirimi açık müşteri hesabıysa kullanılır (o zaman tekilleşir). Başka firmanın ya da iç ekibin
 *     hesabının adresine, pasif / silinmiş / tercihi kapalı hesabın adresine "firma adresi" diye gönderilmez (4.2.11).
 * Dil: siparişi açan ve firma adresi olayın dili (payload.lang — karar 200; yoksa siparişi açanın bugünkü kuralı); firmanın
 * diğer kullanıcıları kendi dil tercihiyle. Sıra: siparişi açan, diğer kullanıcılar (hesap açılış sırası), firma adresi.
 * @param {any} db @param {any} order @param {{ snapshot?: 'ro' | 'tr' | null, opened?: object, firmWide?: boolean }} [o]
 * @returns {Promise<{ email: string, locale: 'ro' | 'tr' }[]>}
 */
async function customerRecipients(db, order, { snapshot = null, opened = {}, firmWide = false } = {}) {
  if (!order?.customerId) return [];
  const creator = order.createdBy && order.createdBy.customerId === order.customerId ? order.createdBy : null;
  const eventLang = loc(snapshot ?? customerMailLang(creator));
  /** @type {{ email: string, locale: 'ro' | 'tr' }[]} */
  let out;
  if (firmWide) {
    const users = await db.user.findMany({
      where: { customerId: order.customerId, type: 'CUSTOMER', appRole: 'MUSTERI', isActive: true, deletedAt: null, emailNotifications: true, ...opened },
      select: { id: true, email: true, language: true, fixedLanguage: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const creatorId = order.createdById ?? null;
    const ordered = [...users.filter((u) => u.id === creatorId), ...users.filter((u) => u.id !== creatorId)];
    out = ordered.map((u) => ({ email: u.email, locale: u.id === creatorId ? eventLang : customerMailLang(u) }));
  } else {
    if (creator && creator.emailNotifications === false) return [];
    out = creator && creator.isActive !== false ? [{ email: creator.email, locale: eventLang }] : [];
  }
  const firm = order.customer?.email;
  if (isEmail(firm)) {
    const owners = await db.user.findMany({
      where: { email: { equals: firm.trim(), mode: 'insensitive' } },
      select: { customerId: true, type: true, isActive: true, deletedAt: true, emailNotifications: true },
    });
    const ours = owners.every((u) => u.customerId === order.customerId && u.type === 'CUSTOMER' && u.isActive === true && !u.deletedAt && u.emailNotifications !== false);
    if (ours) out.push({ email: firm.trim(), locale: eventLang });
  }
  return out;
}

const STAFF = { id: true, email: true, language: true, appRole: true, isActive: true };

/**
 * Siparişle ilgilenen satışçı (ayrı bir "satışçı" alanı yok; mevcut kayıtlardan bulunur): siparişi çizim ekibine
 * gönderen satış kullanıcısı (OrderEvent SENT_TO_DRAWING), yoksa teklifi hazırlayan satış kullanıcısı (Offer.createdBy).
 * Yönetici bu işleri yaptıysa satışçı bilinmez → boş liste (recipientsFor satış ekibine gönderir).
 */
export async function orderSalesUsers(db, orderId) {
  const sales = { appRole: { in: ROLE_SETS.sales } };
  const sent = await db.orderEvent.findFirst({ where: { orderId, event: 'SENT_TO_DRAWING', user: sales }, orderBy: { createdAt: 'desc' }, select: { user: { select: STAFF } } });
  if (sent?.user) return [sent.user];
  const offer = await db.offer.findFirst({ where: { orderId, createdBy: sales }, orderBy: { createdAt: 'desc' }, select: { createdBy: { select: STAFF } } });
  return offer?.createdBy ? [offer.createdBy] : [];
}

/**
 * Olayın anındaki revizyon talebi (not + sürüm): aynı veritabanı işleminde yazılmıştır; sonraki talepler karışmaz.
 * Yalnızca müşterinin talebi (TALEP) — çizimcinin "hatalı" açıklaması (karar 167) revizyon e-postasına girmez.
 */
export async function revisionOf(db, orderId, at) {
  const r = await db.drawingRevision.findFirst({
    where: { drawing: { orderId }, kind: 'TALEP', createdAt: { lte: new Date(new Date(at).getTime() + 5000) } },
    orderBy: { createdAt: 'desc' },
    select: { comment: true, drawing: { select: { version: true } } },
  });
  return r ? { note: r.comment, version: r.drawing?.version ?? null } : null;
}

/**
 * Teklif değişiklik talebinin e-postadaki bilgisi (4.2.10): müşterinin notu, saklanan Türkçe çevirisi (yalnızca tamamlanmışsa —
 * çeviri talep kaydedildikten hemen sonra sunucu işleminde yapılır; e-posta bu yüzden olaydan CHANGE_MAIL_DELAY_MS sonra
 * gönderilir) ve sürüm numarası (olayın kuyruk verisi). İşçi çeviri YAPMAZ, yalnızca okur.
 * @returns {Promise<{ note: string, translation: string | null, version: number | null } | null>}
 */
export async function offerChangeOf(db, orderId, payload) {
  const offerId = typeof payload?.offerId === 'string' ? payload.offerId : null;
  if (!offerId) return null;
  const o = await db.offer.findFirst({ where: { id: offerId, orderId }, select: { changeNote: true, translation: true, translationLang: true, translationStatus: true } });
  if (!o?.changeNote) return null;
  const version = Number.isInteger(Number(payload?.revision)) && Number(payload.revision) > 0 ? Number(payload.revision) : null;
  return { note: o.changeNote, translation: o.translationStatus === 'DONE' && o.translationLang === 'tr' && o.translation ? o.translation : null, version };
}
/** Değişiklik talebi e-postası olaydan bu kadar sonra gönderilir: notun çevirisi (sunucu işleminde, en çok ~6 sn) yetişsin */
export const CHANGE_MAIL_DELAY_MS = 45_000;
const MAIL_EMAIL = /[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[^\s@<>()[\]{},;:"']+/g;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDay = (d, timeZone) => (d ? new Intl.DateTimeFormat('ro-RO', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d)) : '—');
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dmyOf = (day) => day.split('-').reverse().join('.');
const fmtTime = (d, timeZone) => new Intl.DateTimeFormat('ro-RO', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

/**
 * E-posta metni (alıcının dilinde): sipariş no, firma, işlem, tarih, (yükleme tarihinde yeni tarih), sipariş bağlantısı.
 * Revizyon talebinde müşterinin notu da yazılır (yalnızca metin: HTML'de kaçışlanır, konu satırına girmez).
 * @param {{ type: string, order: any, createdAt: Date, recipient: { locale: 'ro' | 'tr', role: string | null }, appUrl: string, timeZone: string,
 *   revision?: { note: string, version: number | null } | null }} p
 */
export function renderNotification({ type, order, createdAt, recipient, appUrl, timeZone, revision = null, payload = null, change = null }) {
  const t = (k, params) => translate(recipient.locale, k, params);
  // Müşteri üretim onayı (4.2.1): yalnızca müşteriye giden "teklif gönderildi / güncellendi" e-postasında, olay onay
  // bekleyen bir sürümü taşıyorsa (kuyruk verisi payload.approval — gönderim anında yazılır)
  const approval = !recipient.role && (type === 'ORDER_OFFER_SENT' || type === 'ORDER_OFFER_UPDATED' || type === 'ORDER_PRODUCTION_APPROVAL_REQUESTED' || type === 'ORDER_PRODUCTION_APPROVAL_REMINDER')
    && payload?.approval && typeof payload.approval === 'object' ? payload.approval : null;
  const event = type === 'ORDER_CREATED' ? 'CREATED' : type.replace(/^ORDER_/, '');
  const admin = adminText(type, payload, t);
  const what = recipient.role
    ? (type === 'ORDER_CREATED' ? t('notify.newOrder') : admin?.what ?? t(`events.${event}.label`))
    : t(`events.${event}.customer`);
  const firm = recipient.role && !can(recipient.role, 'CUSTOMER_NAME_VIEW') ? maskName(order.customer?.name) : order.customer?.name ?? '';
  const link = `${appUrl}/siparisler/${order.id}`;
  // Müşterinin üretim onayı (4.2.11): tarih satırı onayın anıdır (olay onayla aynı işlemde yazılır); onaylanan teklif sürümü
  const approved = type === 'ORDER_PRODUCTION_APPROVED';
  const approvedVersion = approved && Number.isInteger(Number(payload?.revision)) && Number(payload.revision) > 0 ? Number(payload.revision) : null;
  const rows = [
    [t('notify.orderNo'), order.orderNo],
    [t('notify.customer'), firm],
    [t('notify.action'), what],
    [t(approved ? 'notify.approvedAt' : 'notify.date'), fmtTime(createdAt, timeZone)],
    ...(approvedVersion ? [[t('notify.offerVersion'), `v${approvedVersion}`]] : []),
    ...(type === 'ORDER_SHIP_DATE' ? [[t('notify.shipDate'), fmtDay(order.actualShipDate ?? order.estimatedShipDate, timeZone)]] : []),
    // Teslim günü olayın anındaki değerdir (kuyruk verisi); sonradan yeniden değişse de bu e-posta kendi gününü yazar
    ...(DELIVERY_DAY_TYPES.includes(type) && isDay(payload?.day) ? [[t('notify.deliveryDay'), dmyOf(payload.day)]] : []),
    ...(type === 'ORDER_REVISION_REQUESTED' && revision?.version ? [[t('notify.drawingVersion'), `v${revision.version}`]] : []),
    ...(type === 'ORDER_REVISION_REQUESTED' && revision?.note ? [[t('notify.revisionNote'), String(revision.note).slice(0, 2000)]] : []),
    // Müşterinin teklif değişiklik talebi (4.2.10): sürüm, not (e-posta adresi görmeyen role adresler maskeli — sipariş
    // sayfasındaki kural) ve Türkçe çeviri (yalnızca Türkçe okuyan alıcıya, tamamlanmışsa)
    ...(type === 'ORDER_OFFER_CHANGE_REQUESTED' && change?.version ? [[t('notify.offerVersion'), `v${change.version}`]] : []),
    ...(type === 'ORDER_OFFER_CHANGE_REQUESTED' && change?.note ? [[t('notify.changeNote'), maskMail(recipient.role, change.note)]] : []),
    ...(type === 'ORDER_OFFER_CHANGE_REQUESTED' && change?.translation && recipient.locale === 'tr' ? [[t('notify.changeTranslation'), maskMail(recipient.role, change.translation)]] : []),
    // Yöneticinin e-postalarında olayın açıklaması (tutar yazılmaz — ayrıntı sipariş sayfasında ve "Önemli kararlar"da)
    ...(recipient.role && admin?.detail ? [[t('notify.description'), admin.detail]] : []),
    // Müşteri üretim onayı (4.2.1): son onay tarihi (Romanya saati; hesaplanamadıysa açıkça belirtilir)
    ...(approval ? [[t('notify.approval.deadline'), approvalDueText(approval.due) ? `${approvalDueText(approval.due)} (${t('notify.approval.roTime')})` : t('notify.approval.noDeadline')]] : []),
  ];
  const subject = `${order.orderNo} — ${what}`;
  const extra = DELIVERY_DAY_TYPES.includes(type) ? t('notify.deliveryNote') : approval ? t('notify.approval.text') : null;
  const text = [...rows.map(([k, v]) => `${k}: ${v}`), ...(extra ? ['', extra] : []), '', `${t('notify.open')}: ${link}`, '', t('notify.footer')].join('\n');
  // Ortak GKH düzeni (logo başlığı — server/mail/layout.js); burada yalnızca gövde üretilir
  const html = brandedHtml({ lang: recipient.locale, title: subject, body: `<p style="margin:0 0 12px"><b>${esc(what)}</b></p>
<table cellpadding="4" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6b7280;vertical-align:top">${esc(k)}</td><td style="white-space:pre-wrap"><b>${esc(v)}</b></td></tr>`).join('')}</table>
${extra ? `<p style="color:#6b7280;margin:12px 0 0">${esc(extra)}</p>` : ''}
<p style="margin-top:16px"><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">${esc(t('notify.open'))}</a></p>
<p style="color:#6b7280;font-size:12px;margin-bottom:0">${esc(t('notify.footer'))}</p>` });
  return { subject, text, html };
}

/** Not metni (en çok 2000 karakter): firma adı maskeli role e-posta adresleri de maskeli (server/orders/order-view.js ile aynı) */
function maskMail(role, text) {
  const v = String(text ?? '').slice(0, 2000);
  return role && !can(role, 'CUSTOMER_NAME_VIEW') ? v.replace(MAIL_EMAIL, '***') : v;
}

/**
 * Yöneticiye giden olayların başlığı ve açıklaması (karar 218). Değerler olayın kuyruk verisinden; tutar hiç yazılmaz.
 * @param {string} type @param {any} payload @param {(k: string, p?: object) => string} t
 * @returns {{ what: string | null, detail: string } | null}
 */
function adminText(type, payload, t) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const n = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  if (type === 'ORDER_PRICE_OVERRIDE') return { what: t('notify.admin.priceOverride'), detail: t('notify.admin.priceOverrideDetail', { n: n(p.qty) ?? 1 }) };
  if (type === 'ORDER_OFFER_WITHDRAWN') return { what: null, detail: t('notify.admin.withdrawnDetail') };
  if (type === 'ORDER_COMPENSATION_PRICE') {
    const mode = p.mode === 'FREE' ? 'free' : 'custom';
    const detail = t('notify.admin.compensationDetail', { qty: n(p.qty) ?? 1, source: String(p.sourceOrderNo ?? '—').slice(0, 40) });
    return { what: t(`notify.admin.compensation.${mode}`), detail: p.pending ? `${detail} ${t('notify.admin.compensationPending')}` : detail };
  }
  return null;
}

/**
 * Kuyruktaki bildirim olaylarını gönderir. İlk çalıştırmada başlangıç anı kaydedilir; ondan önceki (birikmiş) olaylar
 * gönderilmez (SKIPPED). Alıcı başına gönderilir; gönderilenler payload.sentTo'da tutulur (yeniden denemede tekrar
 * gitmez). Hata: artan aralıklarla yeniden; NOTIFY_MAX_ATTEMPTS sonunda FAILED (lastError).
 */
export async function dispatchNotifications(db, { transport, from, appUrl, timeZone = 'Europe/Bucharest', now = new Date(), log = () => {} }) {
  if (!transport) return { sent: 0, failed: 0, skipped: 0 };
  let since = (await db.integrationSetting.findUnique({ where: { key: NOTIFY_SINCE_KEY } }))?.value;
  if (!since || typeof since !== 'object' || !since.at) {
    since = { at: now.toISOString() };
    await db.integrationSetting.upsert({ where: { key: NOTIFY_SINCE_KEY }, create: { key: NOTIFY_SINCE_KEY, value: since }, update: { value: since } });
  }
  // Yalnızca e-postaya çevrilebilen satırlar (MAILABLE): kuralı sonradan eklenen türün damgasız eski satırları ne atlanır ne
  // gönderilir — hiç seçilmez (STAMPED_MAIL_TYPES)
  const old = await db.notificationOutbox.updateMany({
    where: { ...MAILABLE, status: 'PENDING', createdAt: { lt: new Date(since.at) } },
    data: { status: 'SKIPPED', lastError: 'e-posta bildirimleri başlamadan önceki olay' },
  });
  const rows = await db.notificationOutbox.findMany({
    where: { ...MAILABLE, status: 'PENDING', availableAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  let sent = 0, failed = 0, skipped = old.count;
  // Müşteri üretim onayı ayarı (acil durdurma anahtarı, 4.2.6): kapalıyken onay talebi / hatırlatma e-postası gitmez, teklif
  // e-postası onay metni olmadan (4.2.0 metni) gider, iletim yazılmaz
  const approvalOn = rows.length ? (await approvalGateSetting(db)).enabled : false;
  for (const row of rows) {
    // Değişiklik talebi (4.2.10): notun çevirisi yetişsin diye ilk deneme olaydan CHANGE_MAIL_DELAY_MS sonra (satıra dokunulmaz)
    if (row.type === 'ORDER_OFFER_CHANGE_REQUESTED' && row.attempts === 0 && now.getTime() - new Date(row.createdAt).getTime() < CHANGE_MAIL_DELAY_MS) continue;
    const claimed = await db.notificationOutbox.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const attempt = row.attempts + 1;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const done = new Set(Array.isArray(payload.sentTo) ? payload.sentTo : []);
    try {
      const order = row.orderId ? await db.order.findUnique({
        where: { id: row.orderId },
        include: {
          customer: { select: { name: true, email: true } },
          createdBy: { select: { email: true, language: true, fixedLanguage: true, emailNotifications: true, customerId: true, isActive: true } },
          assignedDrawer: { select: { email: true, language: true, appRole: true, isActive: true } },
          orderType: { select: { usesSales: true } },
        },
      }) : null;
      // Belge FGO'da kesildiyse müşteriye belge e-postası gider (PDF ekiyle); aynı olay için ikinci e-posta gönderilmez
      const docKind = { ORDER_PROFORMA: 'PROFORMA', ORDER_INVOICED: 'INVOICE' }[row.type];
      if (order && docKind && (await db.fgoDocument.count({ where: { orderId: order.id, kind: docKind } })) > 0) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'belge e-postası gönderilir' } });
        skipped++;
        continue;
      }
      const audiences = order ? NOTIFY_RULES[row.type]?.(order) ?? [] : [];
      if (order && audiences.includes('orderSales')) order.salesUsers = await orderSalesUsers(db, order.id);
      const revision = order && row.type === 'ORDER_REVISION_REQUESTED' ? await revisionOf(db, order.id, row.createdAt) : null;
      const change = order && row.type === 'ORDER_OFFER_CHANGE_REQUESTED' ? await offerChangeOf(db, order.id, payload) : null;
      const recipients = order ? await recipientsFor(db, row.type, order, { lang: snapshotLang(payload), actorId: typeof payload.actorId === 'string' ? payload.actorId : null, at: row.createdAt }) : [];
      if (!approvalOn && (row.type === 'ORDER_PRODUCTION_APPROVAL_REQUESTED' || row.type === APPROVAL_REMINDER_TYPE)) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'üretim onayı kapalı' } });
        skipped++;
        continue;
      }
      // Müşteri üretim onayı talebi (4.2.5): süre talep müşteriye iletilince başlar (production-approval-delivery.js)
      const apId = order && approvalOn ? approvalOfferId(row.type, payload) : null;
      const ap = apId ? await approvalForMail(db, apId, now) : null;
      const isRequest = !!ap && APPROVAL_REQUEST_TYPES.includes(row.type);
      if (!order || recipients.length === 0) {
        if (isRequest && !ap.delivered && ap.open) {
          // E-posta gidemiyor (tercih / adres): müşterinin uygulama içi bildirimi iletimdir; henüz yazılmadıysa beklenir
          const at = await inAppDeliveredAt(db, { outboxId: row.id, customerId: order.customerId });
          if (!at && !row.inAppAt && attempt < NOTIFY_MAX_ATTEMPTS) {
            await db.notificationOutbox.update({ where: { id: row.id }, data: { availableAt: new Date(now.getTime() + 60_000) } });
            continue;
          }
          if (at) await markDelivered(db, { offerId: apId, at, due: approvalDeadline(at).due, channel: 'IN_APP' });
          else await markUndelivered(db, { offerId: apId, orderId: order.id, code: 'NO_RECIPIENT', outboxId: row.id, now });
        }
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: order ? 'alıcı yok' : 'sipariş yok' } });
        skipped++;
        continue;
      }
      const plainPayload = { ...payload };
      delete plainPayload.approval;
      const mailPayload = ap ? { ...payload, approval: { ...payload.approval, due: ap.due ? new Date(ap.due).toISOString() : null } } : approvalOn ? payload : plainPayload;
      let error = null;
      for (const r of recipients) {
        if (done.has(r.email.toLowerCase())) continue;
        let accepted = false;
        try {
          const mail = renderNotification({ type: row.type, order, createdAt: row.createdAt, recipient: r, appUrl, timeZone, revision, payload: mailPayload, change });
          await sendBrandedMail(transport, { from, to: r.email, subject: mail.subject, text: mail.text, html: mail.html, lang: r.locale });
          done.add(r.email.toLowerCase());
          accepted = true;
        } catch (e) {
          error = `${r.email}: ${String(e?.message ?? e)}`.slice(0, 300);
        }
        // Alıcı başına ilerleme hemen yazılır (4.2.11 — kitleler büyüdü): işçi turun ortasında durursa ya da sonraki bir adım
        // hata verirse yeniden denemede kabul edilmiş adrese ikinci e-posta gitmez. Yazılamazsa tur sonundaki kayıt dener.
        if (accepted) await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, sentTo: [...done] } } }).catch(() => {});
      }
      // En az bir müşteri adresine kabul edildi → iletim (bir kez); e-postadaki son tarih aynı andan hesaplandı
      if (isRequest && !ap.delivered && done.size > 0) await markDelivered(db, { offerId: apId, at: now, due: ap.due, channel: 'EMAIL' });
      if (isRequest && !ap.delivered && done.size === 0 && error && attempt >= NOTIFY_MAX_ATTEMPTS) {
        await markUndelivered(db, { offerId: apId, orderId: order.id, code: 'EMAIL_FAILED', outboxId: row.id, now });
      }
      const sentTo = [...done];
      if (!error) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null, payload: { ...payload, sentTo } } });
        sent++;
      } else {
        const final = attempt >= NOTIFY_MAX_ATTEMPTS;
        await db.notificationOutbox.update({
          where: { id: row.id },
          data: { lastError: error, payload: { ...payload, sentTo }, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
        });
        failed++;
        log('bildirim e-postası gönderilemedi', row.type, row.orderId, error);
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 300);
      // Onay talebi bütün denemelerden sonra iletilemedi: süre başlamaz, yöneticiye bildirilir (ilk iletim olduysa değişmez).
      // Ayar kapalıyken (acil durdurma) onay kaydına hiçbir şey yazılmaz — diğer iletim yazımlarıyla aynı koşul (4.2.9)
      const apId = approvalOn && row.orderId && attempt >= NOTIFY_MAX_ATTEMPTS && APPROVAL_REQUEST_TYPES.includes(row.type) ? approvalOfferId(row.type, payload) : null;
      if (apId) await markUndelivered(db, { offerId: apId, orderId: row.orderId, code: 'EMAIL_FAILED', outboxId: row.id, now }).catch(() => false);
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(attempt >= NOTIFY_MAX_ATTEMPTS ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      log('bildirim hatası', row.type, row.orderId, msg);
    }
  }
  return { sent, failed, skipped };
}
