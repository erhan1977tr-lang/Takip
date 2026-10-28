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
 * customer: siparişi açan müşteri kullanıcısı + firmanın e-postası · sales / admin / drawer: iç ekip ·
 * orderSales: siparişle ilgilenen satışçı (order.salesUsers — bkz. orderSalesUsers).
 * Müşterinin çizim kararı (revizyon / onay): atanmış çizimci + ilgili satışçı; yöneticiye gitmez (karar 84).
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
  ORDER_REVISION_REQUESTED: () => ['drawer', 'orderSales'],
  ORDER_DRAWING_APPROVED: () => ['drawer', 'orderSales'],
  // Müşterinin teklif değişiklik talebi (4.2.10, karar 306 — ürün sahibinin kararı): ilgili satışçıya e-posta (uygulama içi
  // bildirim zaten yönetici + ilgili satışçı); müşterinin notu ve (hazırsa) saklanan Türkçe çevirisi e-postaya yazılır
  ORDER_OFFER_CHANGE_REQUESTED: () => ['orderSales'],
  // Müşterinin DWG/DXF çizimi (karar 167): "hatalı" kararı müşteriye (açıklama e-postaya yazılmaz — sipariş sayfasında
  // Romence çevirisiyle); müşterinin yanıtı (düzeltilmiş dosya / fabrika çizimi) çizimciye + ilgili satışçıya
  ORDER_DWG_FAULTY: () => ['customer'],
  // Hatalı kararı geri alındı (karar 285): hatalı kararını e-postayla alan müşteriye tek e-posta (giden kuyruk, olay başına bir satır)
  ORDER_DWG_FAULTY_UNDONE: () => ['customer'],
  ORDER_DWG_RESUBMITTED: () => ['drawer', 'orderSales'],
  ORDER_DWG_FACTORY_REQUESTED: () => ['drawer', 'orderSales'],
  ORDER_PROFILE_APPROVED: () => ['admin'],
  ORDER_DRAWING_UPLOADED: () => ['customer'],
  ORDER_OFFER_SENT: () => ['customer'],
  ORDER_OFFER_UPDATED: () => ['customer'],
  // Müşteri üretim onayı (karar 305): mevcut siparişin geçişte açılan onay talebi — müşteriye (onay metni + son tarih)
  ORDER_PRODUCTION_APPROVAL_REQUESTED: () => ['customer'],
  // Onay bekleyen müşteriye tek hatırlatma (4.2.5): iletimden 1 Romanya iş günü sonra, sürüm başına bir kez
  ORDER_PRODUCTION_APPROVAL_REMINDER: () => ['customer'],
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
 * Olayın alıcıları: [{ email, locale, role }] (e-postaya göre tekil). role: firma adı maskesi için (müşteride null).
 * lang: olay yazılırken belirlenen müşteri e-posta dili (payload.lang — karar 200); yoksa (eski olay) bugünkü kural.
 * actorId: işlemi yapan — yönetici kümesinde kendisine kendi işlemi e-postalanmaz (karar 218).
 * Pasif kullanıcıya operasyonel e-posta GİTMEZ (Paket A, karar 220): bütün kitlelerde — sipariş sahibi müşteri kullanıcısı,
 * atanmış çizimci, ilgili satışçı / satış ekibi, yönetici ve diğer roller — yalnızca etkin hesaplar (uygulama içi bildirimle
 * aynı kural). Firmanın kendi e-posta adresi bir kullanıcı değildir; o adres pasif bir hesabın adresiyse yine gönderilmez.
 * @param {any} db @param {string} type @param {any} order @param {{ lang?: 'ro' | 'tr' | null, actorId?: string | null }} [o]
 */
export async function recipientsFor(db, type, order, { lang: snapshot = null, actorId = null } = {}) {
  const audiences = NOTIFY_RULES[type]?.(order) ?? [];
  const out = new Map();
  const add = (email, locale, role) => {
    if (!isEmail(email)) return;
    const k = email.trim().toLowerCase();
    if (!out.has(k)) out.set(k, { email: email.trim(), locale: loc(locale), role });
  };
  for (const a of audiences) {
    if (a === 'customer') {
      // Müşterinin ayarı (Ayarlar → E-posta bildirimleri): siparişi açan kullanıcı kapattıysa bu siparişin müşteri
      // bildirimleri gönderilmez; bildirimi kapatmış başka bir kullanıcının adresine de gönderilmez.
      const creator = order.createdBy;
      const mine = creator && creator.customerId === order.customerId;
      if (mine && creator.emailNotifications === false) continue;
      const lang = snapshot ?? customerMailLang(creator);
      if (mine && creator.isActive !== false) add(creator.email, lang, null);
      const firm = order.customer?.email;
      const blocked = isEmail(firm)
        ? await db.user.findFirst({ where: { email: { equals: firm.trim(), mode: 'insensitive' }, OR: [{ emailNotifications: false }, { isActive: false }] }, select: { id: true } })
        : null;
      if (isEmail(firm) && !blocked) add(firm, lang, null);
    } else if (a === 'drawer' && order.assignedDrawer) {
      if (order.assignedDrawer.isActive !== false) add(order.assignedDrawer.email, order.assignedDrawer.language, order.assignedDrawer.appRole);
    } else if (a === 'orderSales') {
      // İlgili satışçı biliniyorsa yalnızca o; bilinmiyorsa (siparişi yönetici yönlendirdiyse) satış ekibi. Yönetici değil.
      const known = (order.salesUsers ?? []).filter((u) => u.isActive !== false && ROLE_SETS.sales.includes(u.appRole));
      const users = known.length ? known : await db.user.findMany({ where: { appRole: { in: ROLE_SETS.sales }, isActive: true }, select: { email: true, language: true, appRole: true } });
      for (const u of users) add(u.email, u.language, u.appRole);
    } else if (a === 'admin') {
      const users = await db.user.findMany({ where: { appRole: { in: ROLE_SETS.admin }, isActive: true }, select: { id: true, email: true, language: true, appRole: true } });
      for (const u of users) if (!actorId || u.id !== actorId) add(u.email, u.language, u.appRole);
    } else {
      const users = await db.user.findMany({ where: { appRole: { in: ROLE_SETS[a] ?? [] }, isActive: true }, select: { email: true, language: true, appRole: true } });
      for (const u of users) add(u.email, u.language, u.appRole);
    }
  }
  return [...out.values()];
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
  const rows = [
    [t('notify.orderNo'), order.orderNo],
    [t('notify.customer'), firm],
    [t('notify.action'), what],
    [t('notify.date'), fmtTime(createdAt, timeZone)],
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
  const old = await db.notificationOutbox.updateMany({
    where: { type: { in: NOTIFY_TYPES }, status: 'PENDING', createdAt: { lt: new Date(since.at) } },
    data: { status: 'SKIPPED', lastError: 'e-posta bildirimleri başlamadan önceki olay' },
  });
  const rows = await db.notificationOutbox.findMany({
    where: { type: { in: NOTIFY_TYPES }, status: 'PENDING', availableAt: { lte: now } },
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
      const recipients = order ? await recipientsFor(db, row.type, order, { lang: snapshotLang(payload), actorId: typeof payload.actorId === 'string' ? payload.actorId : null }) : [];
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
        try {
          const mail = renderNotification({ type: row.type, order, createdAt: row.createdAt, recipient: r, appUrl, timeZone, revision, payload: mailPayload, change });
          await sendBrandedMail(transport, { from, to: r.email, subject: mail.subject, text: mail.text, html: mail.html, lang: r.locale });
          done.add(r.email.toLowerCase());
        } catch (e) {
          error = `${r.email}: ${String(e?.message ?? e)}`.slice(0, 300);
        }
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
