// Telefon bildirimi (Web Push) ve müşteri duyuru e-postası (4.2.33, karar 331) — veritabanıyla. Push hizmetine GERÇEK istek
// yapılmaz: gönderim sahte fetchImpl'e gider (offline: global fetch hata verir).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const p = await import('../../server/push/service.js');
const an = await import('../../server/push/announce.js');
const { anonymizeUser } = await import('../../server/users/lifecycle.js');

const SECRET = 'p'.repeat(40);
let db, U, A;
const actor = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1' });
const user = (email, name, appRole, customerId, extra = {}) =>
  db.user.create({ data: { email, name, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, passwordHash: 'x', ...extra } });

function device(host = 'fcm.googleapis.com') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: `https://${host}/fcm/send/${crypto.randomUUID()}`, keys: { p256dh: ua.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

function fakePush(status = 201) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: typeof status === 'function' ? status(String(url)) : status });
  };
  return { calls, fetchImpl };
}

const note = (u, extra = {}) => db.notification.create({
  data: { userId: u.id, type: 'ORDER_OFFER_SENT', params: { orderNo: 'GLA7', aud: 'customer', amount: '9.999' }, message: 'x', link: '/siparisler/abc#teklif', dedupeKey: crypto.randomUUID(), ...extra },
});

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'GLASSANDMORE SRL', prefix: 'GLA', email: 'a@gla.test' } });
  U = {
    admin: await user('admin@p.test', 'Yönetici', 'ADMIN', factory.id),
    sales: await user('satis@p.test', 'Satış', 'SATIS', factory.id),
    a1: await user('a1@gla.test', 'Ion', 'MUSTERI', A.id, { language: 'ro' }),
    a2: await user('a2@gla.test', 'Ayşe', 'MUSTERI', A.id, { language: 'tr' }),
  };
});
after(closeDb);

dbTest('anahtarlar bir kez üretilir; yönetici kapatınca kayıt ve gönderim durur', offline(async () => {
  assert.equal((await p.getPushSettings(db)).ready, false);
  assert.equal((await p.saveSubscription(db, { user: U.a1, subscription: device() })).code, 'DISABLED');
  const [x, y] = await Promise.all([p.ensureVapidKeys(db, { secret: SECRET }), p.ensureVapidKeys(db, { secret: SECRET })]);
  assert.deepEqual([x, y].sort(), ['CREATED', 'EXISTS']);
  const s = await p.getPushSettings(db);
  assert.equal(s.ready, true);
  assert.equal(Buffer.from(s.publicKey, 'base64url').length, 65);
  // Özel anahtar düz metin olarak saklanmaz
  const row = await db.integrationSetting.findUnique({ where: { key: 'push' } });
  assert.equal(Object.keys(row.value).sort().join(','), 'enabled,privateSealed,publicKey');
  assert.equal((await p.savePushSettings(db, { enabled: false }, actor(U.sales))).code, 'FORBIDDEN');
  assert.equal((await p.savePushSettings(db, { enabled: false }, actor(U.admin))).ok, true);
  assert.equal((await p.getPushSettings(db)).publicKey, s.publicKey);
  assert.equal((await p.saveSubscription(db, { user: U.a1, subscription: device() })).code, 'DISABLED');
  assert.deepEqual(await p.dispatchPush(db, { secret: SECRET, subject: 'https://takip.test', fetchImpl: fakePush().fetchImpl }), { skipped: 'DISABLED' });
  await p.savePushSettings(db, { enabled: true }, actor(U.admin));
  assert.equal(await db.auditLog.count({ where: { action: 'SETTINGS_UPDATE', entityId: 'push' } }), 2);
}));

dbTest('gönderim: yalnızca abonelikten sonraki yeni bildirim, bir kez; şifreli, kısa metin; 410 aboneliği siler', offline(async () => {
  await db.pushSubscription.deleteMany({});
  const old = await note(U.a1, { createdAt: new Date(Date.now() - 60_000) });
  const d1 = device();
  const d2 = device('web.push.apple.com');
  assert.equal((await p.saveSubscription(db, { user: U.a1, subscription: d1 })).ok, true);
  assert.equal((await p.saveSubscription(db, { user: U.a1, subscription: d2 })).ok, true);
  assert.equal((await p.saveSubscription(db, { user: U.a1, subscription: { ...device(), endpoint: 'https://evil.test/x' } })).code, 'ENDPOINT');
  const stale = await note(U.a1, { createdAt: new Date(Date.now() - 20 * 60_000) });
  const fresh = await note(U.a1);
  const other = await note(U.sales, { params: { orderNo: 'GLA7', aud: 'staff', firm: 'GLA**********' } }); // aboneliği yok
  const fp = fakePush((url) => (url.includes('apple') ? 410 : 201));
  const [r1, r2] = await Promise.all([
    p.dispatchPush(db, { secret: SECRET, subject: 'https://takip.test', fetchImpl: fp.fetchImpl }),
    p.dispatchPush(db, { secret: SECRET, subject: 'https://takip.test', fetchImpl: fp.fetchImpl }),
  ]);
  assert.equal(r1.notifications + r2.notifications, 1);
  assert.equal(fp.calls.length, 2);
  for (const c of fp.calls) {
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.redirect, 'error');
    assert.equal(c.init.headers['Content-Encoding'], 'aes128gcm');
    assert.match(c.init.headers.Authorization, /^vapid t=.+, k=/);
    assert.doesNotMatch(Buffer.from(c.init.body).toString('latin1'), /GLA7|9\.999/); // uçtan uca şifreli
  }
  // Abonelikten önceki bildirim işaretlenir ama gönderilmez (yukarıda: 1 bildirim × 2 cihaz = 2 istek)
  assert.ok(old.createdAt < (await db.pushSubscription.findFirst({ where: { endpoint: d1.endpoint } })).createdAt);
  assert.equal((await db.notification.findUnique({ where: { id: stale.id } })).pushedAt, null, '15 dakikadan eski gönderilmez');
  assert.ok((await db.notification.findUnique({ where: { id: fresh.id } })).pushedAt);
  assert.equal((await db.notification.findUnique({ where: { id: other.id } })).pushedAt, null);
  assert.deepEqual((await db.pushSubscription.findMany({ where: { userId: U.a1.id } })).map((s) => s.endpoint), [d1.endpoint], '410 → abonelik silindi');
  // Tekrar çalıştırma: aynı bildirim ikinci kez gitmez
  const again = fakePush();
  await p.dispatchPush(db, { secret: SECRET, subject: 'https://takip.test', fetchImpl: again.fetchImpl });
  assert.equal(again.calls.length, 0);
}));

dbTest('cihaz başka hesaba geçer; çıkış / kapatma / silme / pasif kullanıcı bildirim almaz', offline(async () => {
  await db.pushSubscription.deleteMany({});
  const d = device();
  await p.saveSubscription(db, { user: U.a1, subscription: d });
  await p.saveSubscription(db, { user: U.a2, subscription: d });
  assert.deepEqual((await db.pushSubscription.findMany()).map((s) => s.userId), [U.a2.id], 'aynı telefon tek kişiye');
  // Başkasının cihazını silemez
  assert.equal(await p.removeSubscription(db, { userId: U.a1.id, endpoint: d.endpoint }), 0);
  assert.equal(await p.hasSubscription(db, { userId: U.a2.id, endpoint: d.endpoint }), true);
  // Pasif kullanıcıya gönderilmez
  await db.user.update({ where: { id: U.a2.id }, data: { isActive: false } });
  const n = await note(U.a2);
  const fp = fakePush();
  await p.dispatchPush(db, { secret: SECRET, subject: 'https://takip.test', fetchImpl: fp.fetchImpl });
  assert.equal(fp.calls.length, 0);
  assert.equal((await db.notification.findUnique({ where: { id: n.id } })).pushedAt, null);
  await db.user.update({ where: { id: U.a2.id }, data: { isActive: true } });
  assert.equal(await p.removeSubscription(db, { userId: U.a2.id, endpoint: d.endpoint }), 1, 'çıkışta silinir');
  // Kullanıcı başına en çok 10 cihaz
  for (let i = 0; i < 12; i++) await p.saveSubscription(db, { user: U.a1, subscription: device() });
  assert.equal(await db.pushSubscription.count({ where: { userId: U.a1.id } }), 10);
  // Kullanıcı silme (anonimleştirme) cihazlarını kaldırır
  const tmp = await user('tmp@gla.test', 'Geçici', 'MUSTERI', A.id);
  await p.saveSubscription(db, { user: tmp, subscription: device() });
  await db.$transaction((tx) => anonymizeUser(tx, tmp.id, new Date()));
  assert.equal(await db.pushSubscription.count({ where: { userId: tmp.id } }), 0);
}));

dbTest('duyuru e-postası: yalnızca yetkili, onaylı ve zamanlı, bir kez; alıcı = firmanın mali belge adresi; gönderim adres başına bir ileti, seçilen saatte', offline(async () => {
  const now = new Date();
  const later = new Date(now.getTime() + 3600_000);
  // B: fatura e-postası var (iki kullanıcı → yine tek ileti, dil ilk kullanıcının); C: aynı fatura adresi (bir kez);
  // D: adres yok (eksik listesinde); E: kullanıcısı yalnızca pasif (alıcı değil)
  const B = await db.customer.create({ data: { name: 'BETA SRL', prefix: 'BET', email: 'firma@beta.test', billingEmail: 'fatura@beta.test' } });
  const C = await db.customer.create({ data: { name: 'CETA SRL', prefix: 'CET', billingEmail: 'FATURA@beta.test' } });
  const D = await db.customer.create({ data: { name: 'DELTA SRL', prefix: 'DEL' } });
  const E = await db.customer.create({ data: { name: 'EPSI SRL', prefix: 'EPS', email: 'e@epsi.test' } });
  await user('b1@beta.test', 'B1', 'MUSTERI', B.id, { language: 'tr' });
  await user('b2@beta.test', 'B2', 'MUSTERI', B.id, { language: 'ro', emailNotifications: false });
  await user('c1@ceta.test', 'C1', 'MUSTERI', C.id);
  await user('d1@delta.test', 'D1', 'MUSTERI', D.id);
  await user('e1@epsi.test', 'E1', 'MUSTERI', E.id, { isActive: false });
  assert.equal((await an.queueAnnouncement(db, { actor: actor(U.sales), confirm: true, sendAt: later })).code, 'FORBIDDEN');
  assert.equal((await an.queueAnnouncement(db, { actor: actor(U.admin), confirm: false, sendAt: later })).code, 'CONFIRM');
  assert.equal((await an.queueAnnouncement(db, { actor: actor(U.admin), confirm: true, sendAt: null })).code, 'SEND_AT');
  assert.equal((await an.queueAnnouncement(db, { actor: actor(U.admin), confirm: true, sendAt: new Date(now.getTime() - 1000) })).code, 'SEND_AT');
  assert.equal((await an.queueAnnouncement(db, { actor: actor(U.admin), confirm: true, sendAt: new Date(now.getTime() + 15 * 86400_000) })).code, 'SEND_AT');
  const st = await an.announcementStatus(db, actor(U.admin));
  const byTo = Object.fromEntries(st.list.map((r) => [r.to.toLowerCase(), r]));
  assert.ok(byTo['a@gla.test'], 'firma e-postası (fatura e-postası yok)');
  assert.equal(byTo['a@gla.test'].source, 'FIRM');
  assert.equal(byTo['a@gla.test'].lang, 'ro');
  assert.deepEqual(byTo['fatura@beta.test'].firms.sort(), ['BETA SRL', 'CETA SRL']);
  assert.equal(byTo['fatura@beta.test'].source, 'BILLING');
  assert.equal(byTo['fatura@beta.test'].lang, 'tr');
  assert.ok(!byTo['firma@beta.test'] && !byTo['e@epsi.test'] && !byTo['a1@gla.test']);
  assert.ok(st.missing.includes('DELTA SRL'));
  assert.ok(!st.missing.includes('EPSI SRL'));
  const expected = st.recipients.total;
  const [x, y] = await Promise.all([
    an.queueAnnouncement(db, { actor: actor(U.admin), confirm: true, sendAt: later }),
    an.queueAnnouncement(db, { actor: actor(U.admin), confirm: true, sendAt: later }),
  ]);
  assert.deepEqual([x.ok, y.ok].sort(), [false, true]);
  assert.equal([x, y].find((r) => !r.ok).code, 'ALREADY');
  assert.equal(await db.notificationOutbox.count({ where: { type: an.ANNOUNCEMENT_EMAIL } }), expected);
  assert.equal(await db.notificationOutbox.count({ where: { type: an.ANNOUNCEMENT_EMAIL, inAppAt: null } }), 0);
  assert.equal((await an.announcementStatus(db, actor(U.admin))).sendAt, later.toISOString());
  const sent = [];
  let failOnce = true;
  const transport = { sendMail: async (m) => {
    if (failOnce) { failOnce = false; const e = new Error('conn'); e.command = 'CONN'; throw e; }
    sent.push(m);
    return { messageId: 'x' };
  } };
  const send = (at) => an.dispatchAnnouncements(db, { transport, from: 'noreply@takip.test', appUrl: 'https://takip.test', now: at });
  // Seçilen saatten önce hiçbir şey gitmez
  assert.deepEqual(await send(now), { sent: 0, failed: 0, skipped: 0 });
  assert.equal(sent.length, 0);
  // Bu arada GLA'nın e-postası değişti → eski adrese gitmez (atlanır)
  await db.customer.update({ where: { id: A.id }, data: { email: 'yeni@gla.test' } });
  const at = new Date(later.getTime() + 1000);
  const r1 = await send(at);
  assert.equal(r1.skipped, 1);
  assert.equal(r1.failed, 1);
  const retry = await db.notificationOutbox.findFirst({ where: { type: an.ANNOUNCEMENT_EMAIL, lastError: 'CONN' } });
  assert.equal(retry.status, 'PENDING');
  await db.notificationOutbox.update({ where: { id: retry.id }, data: { availableAt: at } });
  await send(at);
  await send(at);
  const to = sent.map((m) => m.to.toLowerCase());
  assert.equal(new Set(to).size, to.length, 'adres başına bir ileti');
  assert.equal(to.length, expected - 1);
  assert.ok(!to.includes('a@gla.test') && !to.includes('yeni@gla.test'));
  const beta = sent.find((m) => m.to.toLowerCase() === 'fatura@beta.test');
  assert.match(beta.subject, /telefonunuzda/);
  assert.match(beta.text, /https:\/\/takip\.test\/dil\?l=tr&next=\/kurulum/);
  assert.match(beta.text, /Deneme bildirimi gönder/);
  // Gönderim sırasında yarıda kalan satır (işaretli) yeniden gönderilmez
  const half = await db.notificationOutbox.create({ data: { type: an.ANNOUNCEMENT_EMAIL, payload: { key: an.ANNOUNCEMENT_KEY, to: 'fatura@beta.test', customerIds: [B.id], lang: 'tr', sendingAt: new Date().toISOString() }, inAppAt: new Date() } });
  const before2 = sent.length;
  await send(at);
  assert.equal(sent.length, before2);
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: half.id } })).lastError, 'UNKNOWN');
  assert.equal(await db.auditLog.count({ where: { action: 'ANNOUNCEMENT_QUEUED' } }), 1);
}));
