// Depo e-postası ve depo bağlantısı (Aşama 6).
//   - Ayarlar (yönetici → Entegrasyonlar): alıcılar (varsayılan adrian@partnertrans.ro, enis@gkh.ro). Gönderen SMTP'deki
//     MAIL_FROM (info@gkh.ro); SMTP şifresi yalnızca sunucudaki .env'de.
//   - "Ödeme alındı" (ya da ödemeden önce "Siparişi depoya gönder") işlemi e-postayı kuyruğa yazar (WAREHOUSE_EMAIL); işçi PDF'i üretir (bir kez, siparişin iç dosyası
//     olur), tek kullanımlık depo bağlantısını oluşturur ve e-postayı gönderir. Olmazsa artan aralıklarla yeniden dener.
//   - Depo bağlantısı: /depo/<anahtar>; yalnızca anahtarın özeti saklanır, 60 gün geçerli, yeniden gönderimde yenilenir.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { resolveKey, storeGenerated } from '../files/store.js';
import { depotFormPdf } from '../pdf/depot-form.js';
import { renderWarehouseEmail } from '../mail/templates/warehouse.js';
import { sendBrandedMail } from '../mail/send.js';
import { unitLabel } from './catalog.js';
import { dayDate, localDay } from './dates.js';
import { WAREHOUSE_EMAIL } from './transitions.js';

export const WAREHOUSE_KEY = 'profile.warehouse';
export const DEFAULT_RECIPIENTS = ['adrian@partnertrans.ro', 'enis@gkh.ro'];
export const DEPOT_LINK_DAYS = 60;
export const MAX_ATTEMPTS = 8;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** @returns {Promise<{ recipients: string[], fromDb: boolean }>} */
export async function getWarehouseSettings(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: WAREHOUSE_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  const list = Array.isArray(v.recipients) ? v.recipients.filter((x) => typeof x === 'string' && EMAIL_RE.test(x)) : null;
  return { recipients: list ?? DEFAULT_RECIPIENTS, fromDb: !!row };
}

/**
 * "a@x.ro, b@y.ro" → adresler; geçersiz adres varsa { ok: false, bad }
 * @returns {{ ok: true, recipients: string[] } | { ok: false, bad: string[] }}
 */
export function parseRecipients(text) {
  const list = [...new Set(String(text ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((s) => !EMAIL_RE.test(s));
  if (bad.length) return { ok: false, bad };
  if (list.length === 0 || list.length > 10) return { ok: false, bad: [] };
  return { ok: true, recipients: list };
}

export async function saveWarehouseSettings(db, { recipients }, actor) {
  return db.$transaction(async (tx) => {
    const before = await tx.integrationSetting.findUnique({ where: { key: WAREHOUSE_KEY } });
    const value = { recipients };
    await tx.integrationSetting.upsert({ where: { key: WAREHOUSE_KEY }, create: { key: WAREHOUSE_KEY, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    await writeAudit(tx, { action: 'SETTINGS_UPDATE', entityType: 'IntegrationSetting', entityId: WAREHOUSE_KEY, userId: actor.id, details: { before: before?.value ?? null, after: value } }, actor);
  });
}

// ---------- depo bağlantısı ----------
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Bağlantının siparişi (süresi dolmuşsa, iptal edildiyse ya da yenilendiyse null): ProfileOrder + order (firma, kalemler, dosyalar).
 * @param {import('@prisma/client').PrismaClient} db
 * @param {string} token
 */
export async function findDepotOrder(db, token, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token ?? ''))) return null;
  const p = await db.profileOrder.findUnique({
    where: { depotTokenHash: hashToken(token) },
    include: {
      order: {
        include: {
          customer: { select: { name: true } },
          profileItems: { orderBy: { sortOrder: 'asc' } },
          files: { where: { source: 'DEPOT_LINK' }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, size: true, createdAt: true } },
        },
      },
    },
  });
  if (!p || !p.depotTokenExpiresAt || p.depotTokenExpiresAt <= now || p.order.status === 'IPTAL') return null;
  return p;
}

// ---------- PDF ----------
/**
 * Siparişin Comanda Depozit PDF'i (katalogdaki tüm etkin ürünler + siparişte olup artık pasif olanlar; adetler siparişten).
 * @returns {Promise<{ buf: Buffer, name: string, order: object }>}
 */
export async function buildDepotPdf(db, orderId, now = new Date(), timeZone = 'Europe/Bucharest') {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      customer: { select: { name: true } },
      profile: true,
      profileItems: { orderBy: { sortOrder: 'asc' } },
      notes: { where: { internal: false, user: { appRole: 'MUSTERI' } }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
  });
  const categories = await db.profileCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const products = await db.profileProduct.findMany({
    where: { OR: [{ isActive: true }, { id: { in: order.profileItems.map((i) => i.productId).filter(Boolean) } }] },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    include: { image: { select: { data: true } }, category: { select: { code: true } } },
  });
  const qty = new Map(order.profileItems.map((i) => [i.code, i.qty]));
  const listed = products.map((p) => ({ id: p.id, code: p.code, categoryCode: p.category.code, name: p.nameRo, image: p.image ? Buffer.from(p.image.data) : null }));
  // Katalogdan silinmiş/kodu değişmiş kalem: sipariş kopyasıyla eklenir
  for (const it of order.profileItems) {
    if (!listed.some((x) => x.code === it.code)) listed.push({ id: it.productId, code: it.code, categoryCode: it.categoryCode, name: it.nameRo, image: null });
  }
  const unitOf = (catCode) => {
    const it = order.profileItems.find((i) => i.categoryCode === catCode);
    const p = products.find((x) => x.category.code === catCode);
    return unitLabel(it?.unitCode ?? p?.unitCode ?? '', 'ro').toUpperCase();
  };
  const cats = categories.map((c) => ({ code: c.code, name: c.nameRo, unit: unitOf(c.code) }));
  for (const it of order.profileItems) {
    if (!cats.some((c) => c.code === it.categoryCode)) cats.push({ code: it.categoryCode, name: it.categoryCode, unit: unitLabel(it.unitCode, 'ro').toUpperCase() });
  }
  const buf = depotFormPdf({
    orderNo: order.orderNo, firmName: order.customer.name, phone: order.profile?.contactPhone ?? null, plate: order.profile?.vehiclePlate ?? null,
    pickupDate: order.profile?.pickupDate ?? null, date: dayDate(localDay(now, timeZone)),
    categories: cats, products: listed, qty, note: order.notes[0]?.text ?? null,
  });
  return { buf, name: `Comanda-Depozit-${order.orderNo}.pdf`, order };
}

// ---------- işçi ----------
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];

/**
 * Kuyruktaki depo e-postalarını gönderir.
 * @param {{ transport: { sendMail: (m: object) => Promise<any> } | null, from: string, appUrl: string, now?: Date, timeZone?: string, log?: Function }} ctx
 *   transport null ise (SMTP ayarlı değil) hiçbir şey yapılmaz; e-postalar kuyrukta bekler.
 */
export async function dispatchWarehouseEmails(db, { transport, from, appUrl, now = new Date(), timeZone = 'Europe/Bucharest', log = () => {} }) {
  if (!transport) return { sent: 0, failed: 0, skipped: 'no_smtp' };
  const rows = await db.notificationOutbox.findMany({
    where: { type: WAREHOUSE_EMAIL, status: 'PENDING', availableAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  let sent = 0, failed = 0;
  for (const row of rows) {
    // Satırı üstlen (aynı anda iki işçi aynı e-postayı göndermesin)
    const claimed = await db.notificationOutbox.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const attempt = row.attempts + 1;
    try {
      const order = row.orderId ? await db.order.findUnique({ where: { id: row.orderId }, include: { profile: true, customer: { select: { name: true } }, profileItems: { orderBy: { sortOrder: 'asc' } }, files: { where: { source: 'WAREHOUSE_FORM' }, orderBy: { createdAt: 'desc' }, take: 1 } } }) : null;
      // İptal edilmiş ya da artık depoda olmayan sipariş: gönderilmez
      if (!order || order.status === 'IPTAL' || !order.profile || !['DEPODA', 'TESLIM_EDILDI'].includes(order.profile.stage)) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'order not in warehouse stage' } });
        continue;
      }
      const settings = await getWarehouseSettings(db);
      // PDF bir kez üretilir ve siparişin iç dosyası olarak saklanır; yeniden gönderimde aynı dosya
      let file = order.files[0] ?? null;
      let pdf;
      if (file) {
        const full = resolveKey(file.storageKey);
        pdf = full ? await fsp.readFile(full).catch(() => null) : null;
      }
      if (!pdf) {
        const built = await buildDepotPdf(db, order.id, now, timeZone);
        pdf = built.buf;
        const stored = await storeGenerated(pdf, { name: built.name, mime: 'application/pdf' });
        file = await db.orderFile.create({ data: { ...stored, orderId: order.id, kind: 'INTERNAL', source: 'WAREHOUSE_FORM', uploadedById: null } });
      }
      const token = newToken();
      const expires = new Date(now.getTime() + DEPOT_LINK_DAYS * 86_400_000);
      await db.profileOrder.update({ where: { orderId: order.id }, data: { depotTokenHash: hashToken(token), depotTokenExpiresAt: expires } });
      const mail = renderWarehouseEmail({
        orderNo: order.orderNo, firmName: order.customer.name, pickupDate: order.profile.pickupDate, phone: order.profile.contactPhone, plate: order.profile.vehiclePlate,
        items: order.profileItems.map((i) => ({ code: i.code, name: i.nameRo, unit: unitLabel(i.unitCode, 'ro'), qty: i.qty })),
        link: `${appUrl}/depo/${token}`, validDays: DEPOT_LINK_DAYS, resend: !!row.payload?.resend,
      });
      const info = await sendBrandedMail(transport, {
        from, to: settings.recipients.join(', '), subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro',
        attachments: [{ filename: file.name, content: pdf, contentType: 'application/pdf' }],
      });
      await db.$transaction(async (tx) => {
        await tx.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
        await writeHistory(tx, { orderId: order.id, event: 'WAREHOUSE_EMAILED', from: order.status, to: order.status, actorId: null, note: settings.recipients.join(', ') });
        await writeAudit(tx, {
          action: 'WAREHOUSE_EMAIL_SENT', entityType: 'Order', entityId: order.id, userId: null,
          details: { recipients: settings.recipients, fileId: file.id, messageId: info?.messageId ?? null, attempt },
        }, { role: 'SYSTEM' });
      });
      sent++;
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      const final = attempt >= MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      if (final && row.orderId) {
        await db.$transaction(async (tx) => {
          await writeHistory(tx, { orderId: row.orderId, event: 'WAREHOUSE_EMAIL_FAILED', actorId: null, note: msg.slice(0, 200) });
          await tx.adminAlert.create({ data: { type: 'WAREHOUSE_EMAIL_FAILED', orderId: row.orderId, details: { error: msg.slice(0, 300), attempts: attempt } } });
        });
      }
      log('depo e-postası gönderilemedi', row.orderId, msg);
    }
  }
  return { sent, failed };
}
