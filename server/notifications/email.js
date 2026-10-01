// Bildirim e-postaları (Aşama 8 başlangıcı): iş akışı işlemleri zaten aynı veritabanı işleminde NotificationOutbox'a
// olay yazıyor (ORDER_<OLAY>, ORDER_CREATED). Bu modül işçide (scripts/worker.mjs) o olaylardan seçilenleri, işlem
// tamamlandıktan SONRA, mevcut SMTP bağlantısıyla (server/mail/transport.js, .env) e-postaya çevirir. Gönderim hatası
// işlemi etkilemez: satır kuyrukta kalır, artan aralıklarla yeniden denenir, sonunda FAILED + lastError olur.
//
// Kural tablosu (olay → alıcı) NOTIFY_RULES'ta. Cam FGO belgeleri (proforma / avans / fatura) müşteriye zaten ayrı
// e-postayla (FGO bağlantısıyla) gider (server/glass/billing.js → DOC_EMAIL; FGO API'si e-posta göndermez) — burada
// tekrarlanmaz. Profil siparişinde FGO belgesi için e-posta yoktu: PROFORMA / INVOICED olayıyla müşteriye bildirim gider.
// Alıcı seçimi rol adına değil yetkiye göredir (server/auth/permissions.js). Satış ve çizim e-postada firma adını
// maskeli görür (ekrandaki kural). Bağlantı: uygulamadaki sipariş sayfası (giriş ve yetki gerekir).
import { can, ROLE_PERMISSIONS } from '../auth/permissions.js';
import { maskName } from '../orders/rules.js';
import { translate } from '../i18n/index.js';

/** customer: siparişi açan müşteri kullanıcısı + firmanın e-postası · sales / admin / drawer: iç ekip */
export const NOTIFY_RULES = {
  ORDER_CREATED: (o) => (o.orderTypeCode === 'PROFILE_ORDER' ? ['admin'] : ['sales']),
  ORDER_SENT_TO_DRAWING: () => ['drawer'],
  ORDER_REVISION_REQUESTED: () => ['drawer'],
  ORDER_DRAWING_APPROVED: () => ['drawer'],
  ORDER_PROFILE_APPROVED: () => ['admin'],
  ORDER_DRAWING_UPLOADED: () => ['customer'],
  ORDER_OFFER_SENT: () => ['customer'],
  ORDER_OFFER_UPDATED: () => ['customer'],
  ORDER_PROFILE_OFFER_SENT: () => ['customer'],
  ORDER_PROFORMA: () => ['customer'],
  ORDER_INVOICED: () => ['customer'],
  ORDER_SHIP_DATE: () => ['customer'],
};
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
 */
export async function recipientsFor(db, type, order) {
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
      const lang = creator?.fixedLanguage || creator?.language || 'ro';
      if (mine) add(creator.email, lang, null);
      const firm = order.customer?.email;
      if (isEmail(firm) && !(await db.user.findFirst({ where: { email: { equals: firm.trim(), mode: 'insensitive' }, emailNotifications: false }, select: { id: true } }))) add(firm, lang, null);
    } else if (a === 'drawer' && order.assignedDrawer) {
      add(order.assignedDrawer.email, order.assignedDrawer.language, order.assignedDrawer.appRole);
    } else {
      const users = await db.user.findMany({ where: { appRole: { in: ROLE_SETS[a] ?? [] } }, select: { email: true, language: true, appRole: true } });
      for (const u of users) add(u.email, u.language, u.appRole);
    }
  }
  return [...out.values()];
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDay = (d, timeZone) => (d ? new Intl.DateTimeFormat('ro-RO', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d)) : '—');
const fmtTime = (d, timeZone) => new Intl.DateTimeFormat('ro-RO', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

/**
 * E-posta metni (alıcının dilinde): sipariş no, firma, işlem, tarih, (yükleme tarihinde yeni tarih), sipariş bağlantısı.
 * @param {{ type: string, order: any, createdAt: Date, recipient: { locale: 'ro' | 'tr', role: string | null }, appUrl: string, timeZone: string }} p
 */
export function renderNotification({ type, order, createdAt, recipient, appUrl, timeZone }) {
  const t = (k, params) => translate(recipient.locale, k, params);
  const event = type === 'ORDER_CREATED' ? 'CREATED' : type.replace(/^ORDER_/, '');
  const what = recipient.role
    ? (type === 'ORDER_CREATED' ? t('notify.newOrder') : t(`events.${event}.label`))
    : t(`events.${event}.customer`);
  const firm = recipient.role && !can(recipient.role, 'CUSTOMER_NAME_VIEW') ? maskName(order.customer?.name) : order.customer?.name ?? '';
  const link = `${appUrl}/siparisler/${order.id}`;
  const rows = [
    [t('notify.orderNo'), order.orderNo],
    [t('notify.customer'), firm],
    [t('notify.action'), what],
    [t('notify.date'), fmtTime(createdAt, timeZone)],
    ...(type === 'ORDER_SHIP_DATE' ? [[t('notify.shipDate'), fmtDay(order.actualShipDate ?? order.estimatedShipDate, timeZone)]] : []),
  ];
  const subject = `${order.orderNo} — ${what}`;
  const text = [...rows.map(([k, v]) => `${k}: ${v}`), '', `${t('notify.open')}: ${link}`, '', t('notify.footer')].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.5">
<p><b>${esc(what)}</b></p>
<table cellpadding="4" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6b7280">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p style="margin-top:16px"><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">${esc(t('notify.open'))}</a></p>
<p style="color:#6b7280;font-size:12px">${esc(t('notify.footer'))}</p></body></html>`;
  return { subject, text, html };
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
  for (const row of rows) {
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
          createdBy: { select: { email: true, language: true, fixedLanguage: true, emailNotifications: true, customerId: true } },
          assignedDrawer: { select: { email: true, language: true, appRole: true } },
        },
      }) : null;
      const recipients = order ? await recipientsFor(db, row.type, order) : [];
      if (!order || recipients.length === 0) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: order ? 'alıcı yok' : 'sipariş yok' } });
        skipped++;
        continue;
      }
      let error = null;
      for (const r of recipients) {
        if (done.has(r.email.toLowerCase())) continue;
        try {
          const mail = renderNotification({ type: row.type, order, createdAt: row.createdAt, recipient: r, appUrl, timeZone });
          await transport.sendMail({ from, to: r.email, subject: mail.subject, text: mail.text, html: mail.html });
          done.add(r.email.toLowerCase());
        } catch (e) {
          error = `${r.email}: ${String(e?.message ?? e)}`.slice(0, 300);
        }
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
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(attempt >= NOTIFY_MAX_ATTEMPTS ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      log('bildirim hatası', row.type, row.orderId, msg);
    }
  }
  return { sent, failed, skipped };
}
