// Paket A (veritabanıyla) — kararlar 219–225: Yönetici Yardımcısı, pasif kullanıcıya e-posta yok, kullanıcı / müşteri silme,
// yöneticinin e-posta değişikliği, giriş logları, kullanıcı başına sipariş uyarıları, siparişin ilk mesajının çevirisi.
// Gerçek SMTP / FGO / ANAF / Google yok: sahte gönderici ve sahte çevirmen; her ağ çağrısı testi düşürür (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { dispatchNotifications, recipientsFor } from '../../server/notifications/email.js';
import { dispatchInApp } from '../../server/notifications/inapp.js';
import { recordLock } from '../../server/auth/lock-events.js';
import { applyEmailChange, checkEmailChange, deleteUser, deletedEmail, userDeletionPreview } from '../../server/users/lifecycle.js';
import { customerDeletionPreview, deleteCustomer, removeOrphanFiles } from '../../server/customers/deletion.js';
import { LOGIN_LOG_RETENTION_DAYS, pruneLoginEvents, recordLoginEvent } from '../../server/auth/login-log.js';
import { markOrderSeen, orderAlertCounts, orderAlertTotal } from '../../server/notifications/order-alerts.js';
import { createInvite } from '../../server/auth/inviteCode.js';
import { verifyInviteCode } from '../../server/auth/invite-claim.js';

const tr = await import('../../server/notes/translation.js');
const { createNoteLimits } = await import('../../server/notes/limits.js');

const SECRET = 'p'.repeat(40);
const KEY = 'AIzaSyTESTONLY-not-a-real-key-0123456789';
const DAY = 86_400_000;
let db, factory, A, B, glass;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const sent = [];
const transport = { sendMail: async (m) => { sent.push(m); return { messageId: `m${sent.length}` }; } };
const opts = { transport, from: 'takip@pa.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
async function pump() {
  for (let i = 0; i < 30; i++) {
    const r = await dispatchNotifications(db, opts);
    if (r.sent + r.failed + r.skipped === 0) return;
  }
}
let fileNo = 0;
async function newOrder(firm, who, title, note = null) {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: act(U[who]), firm, title, requestedNo: next, suggestedNo: next, note,
    items: [{ glassProductId: glass.id, glassName: '8 MM TEMPER', glassNameRo: 'SECURIZAT 8 MM', glassWeightKgM2: 20, camAdedi: 1 }],
    files: [{ storageKey: `2026/10/pa-${fileNo}.pdf`, name: `pa-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'Alfa Test SRL', prefix: 'ALF', email: 'firma@alfa.test' } });
  B = await db.customer.create({ data: { name: 'Beta Glass SRL', prefix: 'BET', email: 'firma@beta.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@pa.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, language: 'tr', ...extra } })
      .then((u) => { U[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('admin2', 'ADMIN', factory.id);
  await mk('yy', 'YONETICI_YARDIMCISI', factory.id);
  await mk('yyOff', 'YONETICI_YARDIMCISI', factory.id, { isActive: false });
  await mk('sales', 'SATIS', factory.id);
  await mk('salesOff', 'SATIS', factory.id, { isActive: false });
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('custA', 'MUSTERI', A.id, { canApprove: true });
  await mk('custA2', 'MUSTERI', A.id);
  await mk('custB', 'MUSTERI', B.id, { canApprove: true });
  glass = await db.glassProduct.create({ data: { nameTr: '8 MM TEMPER', colorTr: '', nameRo: 'SECURIZAT 8 MM', colorRo: '', weightKgM2: 20 } });
  await dispatchNotifications(db, { ...opts, now: new Date(Date.now() - 1000) });
});
after(closeDb);

dbTest('bildirim (karar 220): Yönetici Yardımcısı operasyonel e-postayı alır; pasif hesaplar (yardımcı, satış) hiçbir kitlede yok', offline(async () => {
  sent.length = 0;
  const o = await newOrder(A, 'custA', 'Bildirim siparişi');
  await pump();
  const to = new Set(sent.filter((m) => m.subject.startsWith(o.orderNo)).map((m) => m.to));
  for (const k of ['admin', 'admin2', 'yy', 'sales']) assert.ok(to.has(U[k].email), k);
  for (const k of ['yyOff', 'salesOff', 'inspector', 'drawer']) assert.equal(to.has(U[k].email), false, k);
  // Müşteri kitlesi: siparişi açan kullanıcı pasifse ona gitmez (firmanın kendi adresi kullanıcı değildir)
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { customer: true, createdBy: true } });
  await db.user.update({ where: { id: U.custA.id }, data: { isActive: false } });
  const creator = await db.user.findUniqueOrThrow({ where: { id: U.custA.id } });
  const r = await recipientsFor(db, 'ORDER_OFFER_SENT', { ...order, createdBy: creator });
  assert.deepEqual(r.map((x) => x.email), ['firma@alfa.test']);
  // Atanmış çizimci pasifse çizimci kitlesi boş
  const drawerOff = { ...U.drawer, isActive: false };
  assert.deepEqual(await recipientsFor(db, 'ORDER_REVISION_REQUESTED', { ...order, assignedDrawer: drawerOff, salesUsers: [] }).then((x) => x.filter((y) => y.email === U.drawer.email)), []);
  await db.user.update({ where: { id: U.custA.id }, data: { isActive: true } });
}));

dbTest('güvenlik bildirimi (karar 220): hesap kilidi yalnızca gerçek yöneticilere; Yönetici Yardımcısı almaz', offline(async () => {
  await recordLock(db, { kind: 'LOGIN', email: U.sales.email, ip: '203.0.113.9', filled: ['email'], log: () => {} });
  const rows = await db.notification.findMany({ where: { type: 'AUTH_LOCKED' }, select: { userId: true } });
  assert.deepEqual(rows.map((r) => r.userId).sort(), [U.admin.id, U.admin2.id].sort());
}));

dbTest('kullanıcı silme (karar 221): anonimleştirme; yönetici hesabı, kendi hesabı korunur; Yönetici Yardımcısı silemez; başka müşteriye dokunulmaz', offline(async () => {
  const victim = await db.user.create({ data: { email: 'silinecek@pa.test', name: 'Test Kişi', phone: '0700', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: A.id, passwordHash: 'x' } });
  const ob = await newOrder(B, 'custB', 'B siparişi (dokunulmaz)');
  const ov = await newOrder(A, 'custA', 'A siparişi');
  await db.orderNote.create({ data: { orderId: ov.id, userId: victim.id, text: 'test notu' } });
  await db.session.create({ data: { userId: victim.id, tokenHash: 'h-silinecek', expiresAt: new Date(Date.now() + DAY) } });
  await db.notification.create({ data: { userId: victim.id, message: 'x', type: 'ORDER_OFFER_SENT', orderId: ov.id } });
  const before = { bOrders: await db.order.count({ where: { customerId: B.id } }), notes: await db.orderNote.count() };

  assert.equal((await deleteUser(db, { targetId: victim.id, confirmEmail: victim.email, actor: act(U.yy) })).code, 'FORBIDDEN');
  assert.equal((await deleteUser(db, { targetId: U.admin2.id, confirmEmail: U.admin2.email, actor: act(U.admin) })).code, 'PROTECTED');
  assert.equal((await deleteUser(db, { targetId: U.admin.id, confirmEmail: U.admin.email, actor: act(U.admin) })).code, 'SELF');
  assert.equal((await deleteUser(db, { targetId: victim.id, confirmEmail: 'yanlis@pa.test', actor: act(U.admin) })).code, 'CONFIRM_REQUIRED');
  const preview = await userDeletionPreview(db, { targetId: victim.id, actor: act(U.admin) });
  assert.equal(preview.ok, true);
  assert.deepEqual([preview.removed.sessions, preview.removed.notifications, preview.kept.notes], [1, 1, 1]);

  const r = await deleteUser(db, { targetId: victim.id, confirmEmail: 'SILINECEK@pa.test ', actor: act(U.admin) });
  assert.equal(r.ok, true);
  const row = await db.user.findUniqueOrThrow({ where: { id: victim.id } });
  assert.deepEqual([row.email, row.name, row.phone, row.passwordHash, row.isActive, !!row.deletedAt], [deletedEmail(victim.id), 'Silinmiş kullanıcı', null, null, false, true]);
  assert.equal(await db.session.count({ where: { userId: victim.id } }), 0);
  assert.equal(await db.notification.count({ where: { userId: victim.id } }), 0);
  // Kayıtlar yerinde; B'nin siparişleri değişmedi; adres yeniden kullanılabilir
  assert.equal(await db.orderNote.count(), before.notes);
  assert.equal(await db.order.count({ where: { customerId: B.id } }), before.bOrders);
  assert.ok(await db.order.findUnique({ where: { id: ob.id } }));
  await db.user.create({ data: { email: 'silinecek@pa.test', name: 'Yeni', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: A.id } });
  assert.equal((await deleteUser(db, { targetId: victim.id, confirmEmail: row.email, actor: act(U.admin) })).code, 'DELETED');
  const audit = await db.auditLog.findFirst({ where: { action: 'USER_DELETED', entityId: victim.id } });
  assert.equal(audit?.userId, U.admin.id);
}));

dbTest('e-posta değişikliği (karar 222): yalnızca yönetici; oturumlar kapanır; kod yeni adrese bağlı, tek kullanımlık ve süreli; başka hesap etkilenmez', offline(async () => {
  const target = await db.user.create({ data: { email: 'eski@pa.test', name: 'Değişen', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id, passwordHash: 'eski-hash' } });
  const other = await db.user.create({ data: { email: 'baska@pa.test', name: 'Başka', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id, passwordHash: 'baska-hash' } });
  await db.session.create({ data: { userId: target.id, tokenHash: 'h-eski-1', expiresAt: new Date(Date.now() + DAY) } });
  await db.session.create({ data: { userId: target.id, tokenHash: 'h-eski-2', expiresAt: new Date(Date.now() + DAY) } });
  await db.session.create({ data: { userId: other.id, tokenHash: 'h-baska', expiresAt: new Date(Date.now() + DAY) } });

  assert.equal((await checkEmailChange(db, { targetId: target.id, newEmail: 'yeni@pa.test', actor: act(U.yy) })).code, 'FORBIDDEN');
  assert.equal((await checkEmailChange(db, { targetId: target.id, newEmail: 'yeni@', actor: act(U.admin) })).code, 'INVALID_EMAIL');
  assert.equal((await checkEmailChange(db, { targetId: target.id, newEmail: 'BASKA@pa.test', actor: act(U.admin) })).code, 'EMAIL_TAKEN');
  assert.equal((await checkEmailChange(db, { targetId: U.admin2.id, newEmail: 'x@pa.test', actor: act(U.admin) })).code, 'PROTECTED');
  const ok = await checkEmailChange(db, { targetId: target.id, newEmail: ' Yeni@PA.test ', actor: act(U.admin) });
  assert.equal(ok.email, 'yeni@pa.test');

  const { code, record } = createInvite('yeni@pa.test', SECRET, 24);
  assert.equal((await applyEmailChange(db, { targetId: target.id, oldEmail: 'farkli@pa.test', newEmail: 'yeni@pa.test', invite: record, actor: act(U.admin) })).code, 'STALE');
  const r = await applyEmailChange(db, { targetId: target.id, oldEmail: 'eski@pa.test', newEmail: 'yeni@pa.test', invite: record, actor: act(U.admin) });
  assert.deepEqual(r, { ok: true, sessions: 2 });
  const row = await db.user.findUniqueOrThrow({ where: { id: target.id } });
  assert.deepEqual([row.email, row.passwordHash], ['yeni@pa.test', null]);
  assert.equal(await db.session.count({ where: { userId: target.id } }), 0, 'eski oturumlar kullanılamaz');
  assert.equal(await db.session.count({ where: { userId: other.id } }), 1, 'başka hesabın oturumu durur');
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: other.id } })).passwordHash, 'baska-hash');
  // Eski adresle kod çalışmaz; yeni adresle bir kez çalışır
  assert.equal((await verifyInviteCode(db, { email: 'eski@pa.test', code, secret: SECRET })).ok, false);
  const v = await verifyInviteCode(db, { email: 'yeni@pa.test', code, secret: SECRET });
  assert.equal(v.ok, true);
  await db.userInvite.updateMany({ where: { userId: target.id, usedAt: null }, data: { usedAt: new Date() } }); // şifre belirlendi (setPasswordAction)
  assert.equal((await verifyInviteCode(db, { email: 'yeni@pa.test', code, secret: SECRET })).ok, false, 'kod ikinci kez kullanılamaz');
  // Süresi dolan kod çalışmaz
  const late = createInvite('yeni@pa.test', SECRET, 24, new Date(Date.now() - 2 * DAY));
  await db.userInvite.create({ data: { userId: target.id, codeHash: late.record.codeHash, expiresAt: late.record.expiresAt, sentAt: new Date() } });
  assert.equal((await verifyInviteCode(db, { email: 'yeni@pa.test', code: late.code, secret: SECRET })).ok, false);
  const audit = await db.auditLog.findFirst({ where: { action: 'USER_EMAIL_CHANGED', entityId: target.id } });
  assert.deepEqual([audit?.details?.from, audit?.details?.to], ['eski@pa.test', 'yeni@pa.test']);
}));

dbTest('müşteri silme (karar 221): yalnızca kendi kayıtları; başka müşteri, paylaşılan dosya ve denetim kaydı kalır; resmî belge / ortak sandık engeller', offline(async () => {
  const T = await db.customer.create({ data: { name: 'Silinecek Test SRL', prefix: 'SIL', email: 'firma@sil.test' } });
  const tUser = await db.user.create({ data: { email: 'musteri@sil.test', name: 'Silinecek Müşteri', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: T.id } });
  U.tUser = tUser;
  const ot = await newOrder(T, 'tUser', 'Silinecek sipariş', 'İlk mesaj');
  const ob = await newOrder(B, 'custB', 'B dokunulmaz');
  const shared = (await db.orderFile.findFirstOrThrow({ where: { orderId: ob.id } })).storageKey;
  // Silinecek firmanın taslağı + aynı dosyayı gösteren (paylaşılan) bir kayıt: dosya diskten silinmemeli
  await db.orderDraft.create({ data: { customerId: T.id, createdById: tUser.id, files: { create: [{ name: 'taslak.pdf', storageKey: `2026/10/taslak-${T.id}.pdf`, size: 1, uploadedById: tUser.id }] } } });
  const drawing = await db.drawing.create({ data: { orderId: ot.id, version: 1, uploadedById: U.drawer.id } });
  await db.drawingFile.create({ data: { drawingId: drawing.id, name: 'ortak.pdf', storageKey: shared, size: 1, uploadedById: U.drawer.id } });
  await db.offer.create({ data: { orderId: ot.id, createdById: U.sales.id, lines: { create: [{ description: 'cam', adet: 1, unit: 'm2', kind: 'CAM' }] } } });
  const crate = await db.crate.create({ data: { customerId: T.id, crateNo: 7, shipDay: new Date('2026-12-01') } });
  await db.crateOrder.create({ data: { crateId: crate.id, orderId: ot.id } });
  await db.notification.create({ data: { userId: U.admin.id, message: 'x', type: 'ORDER_CREATED', orderId: ot.id } });
  const before = {
    b: await db.order.count({ where: { customerId: B.id } }), bFiles: await db.orderFile.count({ where: { orderId: ob.id } }),
    audit: await db.auditLog.count(),
  };

  // Yetki: yardımcı silebilir (CUSTOMER_DELETE), satış silemez; fabrika firması silinemez
  assert.equal((await customerDeletionPreview(db, { customerId: T.id, actor: act(U.sales) })).code, 'FORBIDDEN');
  const fac = await customerDeletionPreview(db, { customerId: factory.id, actor: act(U.admin) });
  assert.deepEqual(fac.blockers.map((b) => b.code), ['FACTORY']);
  const p = await customerDeletionPreview(db, { customerId: T.id, actor: act(U.yy) });
  assert.equal(p.ok, true);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual([p.counts.orders, p.counts.drafts, p.counts.crates, p.counts.users, p.counts.drawings], [1, 1, 1, 1, 1]);

  // Başka firmanın siparişi bu firmanın sandığında → engel; kaldırılınca yeniden açılır
  const guest = await db.crateOrder.create({ data: { crateId: crate.id, orderId: ob.id } });
  const blocked = await deleteCustomer(db, { customerId: T.id, confirmName: T.name, fingerprint: p.fingerprint, actor: act(U.yy) });
  assert.deepEqual([blocked.code, blocked.blockers.map((b) => b.code)], ['BLOCKED', ['SHARED_CRATE']]);
  await db.crateOrder.delete({ where: { id: guest.id } });
  // Yanlış ad / eski önizleme
  assert.equal((await deleteCustomer(db, { customerId: T.id, confirmName: 'Başka Ad', fingerprint: p.fingerprint, actor: act(U.yy) })).code, 'CONFIRM_REQUIRED');
  assert.equal((await deleteCustomer(db, { customerId: T.id, confirmName: T.name, fingerprint: 'eski', actor: act(U.yy) })).code, 'STALE');

  const r = await deleteCustomer(db, { customerId: T.id, confirmName: ' silinecek test srl ', fingerprint: p.fingerprint, actor: act(U.yy) });
  assert.equal(r.ok, true);
  assert.equal(await db.customer.findUnique({ where: { id: T.id } }), null);
  assert.equal(await db.order.count({ where: { id: ot.id } }), 0);
  assert.equal(await db.crate.count({ where: { id: crate.id } }), 0);
  assert.equal(await db.notification.count({ where: { orderId: ot.id } }), 0);
  const u = await db.user.findUniqueOrThrow({ where: { id: tUser.id } });
  assert.deepEqual([u.customerId, u.isActive, !!u.deletedAt, u.email], [null, false, true, deletedEmail(tUser.id)]);
  // Başka müşteri ve dosyaları yerinde; denetim kaydı yalnızca büyür
  assert.equal(await db.order.count({ where: { customerId: B.id } }), before.b);
  assert.equal(await db.orderFile.count({ where: { orderId: ob.id } }), before.bFiles);
  assert.ok((await db.auditLog.count()) > before.audit);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'CUSTOMER_DELETED', entityId: T.id, userId: U.yy.id } }));
  // Disk: paylaşılan dosya silinmez, yalnız kalanlar silinir
  const removed = [];
  const files = await removeOrphanFiles(db, r.storageKeys, async (k) => { removed.push(k); });
  assert.ok(r.storageKeys.includes(shared));
  assert.equal(removed.includes(shared), false, 'B siparişinin dosyası silinmez');
  assert.ok(removed.includes(`2026/10/taslak-${T.id}.pdf`));
  assert.equal(files.kept >= 1, true);
}));

dbTest('müşteri silme: FGO belgesi / onaylı yükleme / ödeme gibi resmî iz varsa hiçbir şey silinmez', offline(async () => {
  const F = await db.customer.create({ data: { name: 'Belgeli SRL', prefix: 'BEL' } });
  const fu = await db.user.create({ data: { email: 'm@bel.test', name: 'm', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: F.id } });
  U.fu = fu;
  const o = await newOrder(F, 'fu', 'Belgeli sipariş');
  await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: '1', issuedAt: new Date() } });
  const p = await customerDeletionPreview(db, { customerId: F.id, actor: act(U.admin) });
  assert.deepEqual(p.blockers.map((b) => b.code), ['FGO_DOCUMENT']);
  const r = await deleteCustomer(db, { customerId: F.id, confirmName: F.name, fingerprint: p.fingerprint, actor: act(U.admin) });
  assert.equal(r.code, 'BLOCKED');
  assert.ok(await db.order.findUnique({ where: { id: o.id } }));
  assert.ok(await db.auditLog.findFirst({ where: { action: 'CUSTOMER_DELETE_BLOCKED', entityId: F.id } }));
}));

dbTest('giriş logu (karar 223): sır yok; kimliği kesin olmayan deneme kullanıcıya bağlanmaz; 365 günden eski kayıt silinir', offline(async () => {
  const now = new Date();
  assert.equal(await recordLoginEvent(db, { kind: 'LOGIN', success: true, user: U.admin, ip: '198.51.100.7', now }), true);
  assert.equal(await recordLoginEvent(db, { kind: 'LOGIN', success: false, user: null, ip: '198.51.100.8', now }), true);
  assert.equal(await recordLoginEvent(db, { kind: 'CODE', success: false, user: U.sales, ip: 'not-an-ip<script>', locked: true, now }), true);
  await db.loginEvent.create({ data: { kind: 'LOGIN', success: true, userId: U.admin.id, role: 'ADMIN', ip: '1.2.3.4', createdAt: new Date(now.getTime() - (LOGIN_LOG_RETENTION_DAYS + 1) * DAY) } });
  await db.loginEvent.create({ data: { kind: 'LOGIN', success: true, userId: U.admin.id, role: 'ADMIN', ip: '1.2.3.5', createdAt: new Date(now.getTime() - (LOGIN_LOG_RETENTION_DAYS - 1) * DAY) } });
  const rows = await db.loginEvent.findMany({ orderBy: { createdAt: 'desc' } });
  const unknown = rows.find((r) => r.ip === '198.51.100.8');
  assert.deepEqual([unknown.userId, unknown.role, unknown.success], [null, null, false]);
  const code = rows.find((r) => r.kind === 'CODE');
  assert.deepEqual([code.userId, code.ip, code.locked], [U.sales.id, null, true]);
  // Tablo yalnızca izinli sütunları taşır (şifre / kod / belirteç / e-posta / tarayıcı alanı yok)
  const cols = (await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'LoginEvent'`).map((c) => c.column_name).sort();
  assert.deepEqual(cols, ['createdAt', 'id', 'ip', 'kind', 'locked', 'role', 'success', 'userId']);
  assert.equal(await pruneLoginEvents(db, now), 1);
  assert.equal(await db.loginEvent.count({ where: { ip: '1.2.3.4' } }), 0);
  assert.equal(await db.loginEvent.count({ where: { ip: '1.2.3.5' } }), 1);
}));

dbTest('sipariş uyarıları (karar 224): yalnızca o kullanıcının o siparişteki uyarıları okunur; sonra gelen, başka kullanıcının ve başka siparişin uyarısı kalır', offline(async () => {
  const o1 = await newOrder(A, 'custA', 'Uyarı 1');
  const o2 = await newOrder(A, 'custA', 'Uyarı 2');
  await dispatchInApp(db, { now: new Date() });
  const t0 = new Date(Date.now() - 60_000);
  const mk = (u, orderId, type, at = t0) => db.notification.create({ data: { userId: u.id, message: 'x', type, orderId, createdAt: at } });
  await mk(U.admin, o1.id, 'ORDER_DRAWING_UPLOADED');
  await mk(U.admin, o1.id, 'ORDER_NOTE_ADDED');
  await mk(U.admin, o1.id, 'FGO_FAILED'); // sipariş uyarısı değil
  await mk(U.admin, o2.id, 'ORDER_REVISION_REQUESTED');
  await mk(U.yy, o1.id, 'ORDER_DRAWING_UPLOADED');
  await mk(U.custA, o1.id, 'ORDER_OFFER_SENT');
  const before = await orderAlertCounts(db, U.admin, [o1.id, o2.id]);
  assert.ok(before.get(o1.id) >= 2 && before.get(o2.id) >= 1);
  const upTo = new Date();
  await mk(U.admin, o1.id, 'ORDER_OFFER_UPDATED', new Date(upTo.getTime() + 5_000)); // sayfa çizildikten sonra
  const r = await markOrderSeen(db, { user: U.admin, orderId: o1.id, upTo, now: new Date(upTo.getTime() + 10_000) });
  assert.deepEqual(r, { ok: true, changed: true });
  const unread = (u, orderId) => db.notification.findMany({ where: { userId: u.id, orderId, isRead: false }, select: { type: true } }).then((x) => x.map((n) => n.type).sort());
  assert.deepEqual(await unread(U.admin, o1.id), ['FGO_FAILED', 'ORDER_OFFER_UPDATED']);
  assert.ok((await unread(U.admin, o2.id)).includes('ORDER_REVISION_REQUESTED'));
  assert.ok((await unread(U.yy, o1.id)).includes('ORDER_DRAWING_UPLOADED'), 'başka kullanıcı etkilenmez');
  assert.ok((await unread(U.custA, o1.id)).includes('ORDER_OFFER_SENT'));
  // Kapsam dışı sipariş: başka firmanın müşterisi hiçbir şey okuyamaz / sayamaz
  assert.deepEqual(await markOrderSeen(db, { user: U.custB, orderId: o1.id }), { ok: false, code: 'NOT_FOUND' });
  assert.equal((await orderAlertCounts(db, U.custB, [o1.id])).size, 0);
  // Müşteri göstergesi (Paket B) için toplam
  assert.ok((await orderAlertTotal(db, U.custA)).total >= 1);
  // Denetimciye sipariş bildirimi yazılmaz → uyarısı yok
  assert.equal((await orderAlertCounts(db, U.inspector, [o1.id, o2.id])).size, 0);
}));

dbTest('ilk mesaj (karar 225): sipariş oluşturulduktan sonra bir kez Türkçeye; ikinci çağrı / yenileme çevirmez; denetimci yalnızca özgün metni görür', offline(async () => {
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { key: KEY, secret: SECRET }, act(U.admin)), { ok: true });
  const calls = [];
  const translator = async (o) => { calls.push(o); return { text: `[${o.target}] ${o.text}` }; };
  const o = await newOrder(A, 'custA', 'Mesajlı sipariş', 'Bună ziua, vă rog');
  const note = await db.orderNote.findFirstOrThrow({ where: { orderId: o.id } });
  assert.equal(note.translationStatus, null, 'sipariş işlemi çeviri yapmaz');
  const r1 = await tr.translateOrderNote(db, { orderId: o.id, actor: act(U.custA), translator, secret: SECRET, limits: createNoteLimits() });
  assert.deepEqual(r1, { ok: true, translation: 'DONE' });
  const r2 = await tr.translateOrderNote(db, { orderId: o.id, actor: act(U.custA), translator, secret: SECRET, limits: createNoteLimits() });
  assert.equal(r2.ok, false);
  assert.equal(calls.length, 1);
  const row = await db.orderNote.findUniqueOrThrow({ where: { id: note.id } });
  assert.deepEqual([row.text, row.translation, row.translationLang, row.translationStatus], ['Bună ziua, vă rog', '[tr] Bună ziua, vă rog', 'tr', 'DONE']);
  // Başka kullanıcı (ör. yönetici) müşterinin notunu çeviremez
  assert.equal((await tr.translateOrderNote(db, { orderId: o.id, actor: act(U.admin), translator, secret: SECRET, limits: createNoteLimits() })).ok, false);
  // Görünürlük: yönetici, yardımcı, satış Türkçeyi görür; denetimci ve müşteri yalnızca özgün metni
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS']) assert.equal(tr.notesFor(role, [row])[0].translation, '[tr] Bună ziua, vă rog', role);
  for (const role of ['DENETIMCI', 'MUSTERI']) assert.equal(tr.notesFor(role, [row])[0].translation ?? null, null, role);
  // Çeviri başarısız olsa da sipariş durur
  const bad = await newOrder(A, 'custA', 'Çevrilemeyen', 'text');
  const failed = await tr.translateOrderNote(db, { orderId: bad.id, actor: act(U.custA), translator: async () => { throw new Error('ağ'); }, secret: SECRET, limits: createNoteLimits() });
  assert.deepEqual(failed, { ok: true, translation: 'FAILED' });
  assert.ok(await db.order.findUnique({ where: { id: bad.id } }));
}));
