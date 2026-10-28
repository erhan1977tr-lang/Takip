// 4.2.11 — bildirim e-postası alıcıları, gerçek PostgreSQL ve gerçek iş akışıyla (birim karşılığı: test/eposta-alicilari.test.js):
//   A2 yeni cam siparişi, çizim revizyonu, teklif değişiklik talebi ve üretim onayı → bütün etkin satış ekibi; pasif satışçı ve
//      olaydan sonra açılan hesap almaz; yönetici + yardımcısının uygulama içi bildirimi ve çizimcinin bildirimi aynen
//   A3 üretim onayı e-postası (yalnızca 4.2.11'in damgaladığı olaydan)
//   A4 teklif ve üretim onayı olayları → firmanın bütün etkin, e-postası açık kullanıcıları + firma adresi; tercihi kapalı / pasif /
//      başka firma yok; öbür müşteri olayları eski kuralla (siparişi açan + firma adresi)
//   A5 firma adresi başka firmanın kullanıcısının giriş adresiyse gönderilmez
//   A7 4.2.10'dan kalan damgasız ORDER_PRODUCTION_APPROVED ve yalnızca zil olayları e-postaya dönüşmez, DOKUNULMAZ
//   A8 SMTP geçici hatası → yalnızca hata veren alıcıya yeniden; ilerleme alıcı başına; mükerrer yok
// Gerçek SMTP yok (bellek içi sahte taşıyıcı); FGO / ağ yok (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { saveApprovalSetting } from '../../server/orders/production-approval-service.js';
import { CHANGE_MAIL_DELAY_MS, dispatchNotifications } from '../../server/notifications/email.js';
import { dispatchInAppFor } from '../../server/notifications/inapp.js';
import { enqueueOutbox } from '../../server/orders/journal.js';

let db;
let factory;
let firm;
let other;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const setApproval = (enabled) => saveApprovalSetting(db, { enabled, actor: actor(people.admin) });

// Sahte SMTP: gönderilenler burada; failing kümesindeki adrese BİR KEZ geçici hata
const sent = [];
const failing = new Set();
const transport = {
  sendMail: async (m) => {
    if (failing.has(m.to)) { failing.delete(m.to); throw new Error('SMTP 451 geçici hata'); }
    sent.push(m);
    return { messageId: `m${sent.length}` };
  },
};
const opts = { transport, from: 'takip@ea.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
/** İşçinin e-posta turu: gönderilecek satır kalmayana kadar (now: işçinin saati) */
async function pump(now = undefined) {
  for (let i = 0; i < 40; i++) {
    const r = await dispatchNotifications(db, { ...opts, ...(now ? { now } : {}) });
    if (r.sent + r.failed + r.skipped === 0) return;
  }
}
/** Bu siparişin, verilen konudaki e-postalarının alıcıları (sıralı) */
const mailsOf = (from, orderNo, subjectTail = null) => sent.slice(from)
  .filter((m) => m.subject.startsWith(`${orderNo} — `) && (!subjectTail || m.subject === `${orderNo} — ${subjectTail}`))
  .map((m) => m.to).sort();
const SALES = () => [people.s1.email, people.s2.email, people.s3.email].sort();
const APPROVED_TR = 'Müşteri üretime alınmasını onayladı';

let fileNo = 0;
const newOrder = async (title, flagged = true) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  const o = await createGlassOrder(db, {
    actor: actor(people.a1), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/ea-${fileNo}.pdf`, name: `ea-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date('2027-02-05T10:00:00Z'), productionApprovalRequired: flagged } });
  return o;
};
const glass = () => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false });
const latest = (orderId) => db.offer.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const adminForm = (lines) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), crateFee: l.crateFee, offerPrice: '50',
}));
async function sendOffer(orderId) {
  await run(orderId, 'no_drawing', 's1');
  await run(orderId, 'submit_offer', 's1', { lines: [glass()] });
  await run(orderId, 'approve_offer', 'admin', { lines: adminForm((await latest(orderId)).lines) });
  return latest(orderId);
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Alegrad Sticla SRL', prefix: 'ALE', email: 'office@alegrad-ea.test' } });
  other = await db.customer.create({ data: { name: 'Beta Glass SRL', prefix: 'BET', email: 'office@beta-ea.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@ea.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, language: appRole === 'MUSTERI' ? 'ro' : 'tr', ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  // Canlıdaki gibi üç etkin satış kullanıcısı + bir pasif
  await mk('s1', 'SATIS', factory.id);
  await mk('s2', 'SATIS', factory.id);
  await mk('s3', 'SATIS', factory.id);
  await mk('sOff', 'SATIS', factory.id, { isActive: false });
  await mk('drawer', 'CIZIM', factory.id);
  // Siparişin firması: siparişi açan a1, öbür etkin a2, e-postayı kapatan a3, pasif a4; başka firma: b1
  await mk('a1', 'MUSTERI', firm.id, { canApprove: true });
  await mk('a2', 'MUSTERI', firm.id);
  await mk('a3', 'MUSTERI', firm.id, { emailNotifications: false });
  await mk('a4', 'MUSTERI', firm.id, { isActive: false });
  await mk('b1', 'MUSTERI', other.id, { canApprove: true });
  // E-posta bildirimleri bu testte en baştan başlamış sayılır (olaylar atlanmaz)
  await db.integrationSetting.upsert({ where: { key: 'notify.since' }, create: { key: 'notify.since', value: { at: new Date(0).toISOString() } }, update: { value: { at: new Date(0).toISOString() } } });
});
after(closeDb);

dbTest('A2 + A3 + A4: yeni sipariş, teklif, üretim onayı, değişiklik talebi, revizyon — doğru alıcılar, adres başına bir e-posta, başka firma yok', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Alıcılar');
  let mark = sent.length;
  await pump();
  // A2 yeni cam siparişi: bütün etkin satış ekibi + etkin yöneticiler (karar 218); pasif satışçı ve müşteriler yok
  assert.deepEqual(mailsOf(mark, o.orderNo), [...SALES(), people.admin.email, people.assistant.email].sort());

  // A4 teklif müşteriye: firmanın etkin, e-postası açık kullanıcıları + firma adresi; a3 (kapalı), a4 (pasif), b1 (başka firma) yok
  mark = sent.length;
  const offer = await sendOffer(o.id);
  await pump();
  const customerSide = sent.slice(mark).map((m) => m.to).filter((e) => !e.endsWith('@ea.test') || /^(a|b)\d@/.test(e));
  assert.deepEqual(customerSide.sort(), [people.a1.email, people.a2.email, firm.email].sort());
  for (const k of ['a3', 'a4', 'b1', 'sOff']) assert.ok(!sent.some((m) => m.to === people[k].email), k);

  // A3 üretim onayı: olay damgalı; uygulama içi bildirim aynen (yönetici + yardımcısı + ilgili satışçı); e-posta bütün satış ekibine
  mark = sent.length;
  await run(o.id, 'approve_production', 'a1', { offerId: offer.id });
  const ev = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_PRODUCTION_APPROVED' } });
  assert.equal(ev.payload.emailRule, true, '4.2.11 kodunun yazdığı onay olayı damgalı');
  await dispatchInAppFor(db, [ev.id]);
  const bells = await db.notification.findMany({ where: { dedupeKey: `outbox:${ev.id}` }, select: { userId: true } });
  assert.deepEqual(bells.map((b) => b.userId).sort(), [people.admin.id, people.assistant.id, people.s1.id].sort(), 'uygulama içi alıcılar değişmedi');
  await pump();
  assert.deepEqual(mailsOf(mark, o.orderNo, APPROVED_TR), SALES(), 'üretim onayı: bütün etkin satış ekibi, satışçı başına bir e-posta');
  assert.ok(!sent.slice(mark).some((m) => [people.admin.email, people.assistant.email].includes(m.to) && m.subject.endsWith(APPROVED_TR)), 'yöneticiye onay e-postası yok');
  const mail = sent.slice(mark).find((m) => m.to === people.s2.email && m.subject.endsWith(APPROVED_TR));
  assert.match(mail.text, /Onay tarihi ve saati: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  assert.match(mail.text, new RegExp(`https://takip\\.test/siparisler/${o.id}`));
  assert.match(mail.text, /Firma: Ale\*{10}/);
  assert.ok(!mail.text.includes('Alegrad Sticla') && !mail.html.includes('Alegrad Sticla'), 'satışa firma adı maskeli');
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: ev.id } })).status, 'SENT');

  // A2 teklif değişiklik talebi: bütün satış ekibine (yönetici uygulama içi)
  const o2 = await newOrder('Değişiklik');
  const offer2 = await sendOffer(o2.id);
  await pump();
  mark = sent.length;
  await run(o2.id, 'request_offer_change', 'a1', { offerId: offer2.id, note: 'Lățimea 1200 mm' });
  const ev2 = await db.notificationOutbox.findFirst({ where: { orderId: o2.id, type: 'ORDER_OFFER_CHANGE_REQUESTED' } });
  await pump(new Date(ev2.createdAt.getTime() + CHANGE_MAIL_DELAY_MS + 1000));
  assert.deepEqual(mailsOf(mark, o2.orderNo), SALES(), 'değişiklik talebi: bütün etkin satış ekibi; yönetici e-postası yok');

  // A2 çizim revizyonu: atanmış çizimci + bütün satış ekibi
  const o3 = await newOrder('Revizyon');
  await db.order.update({ where: { id: o3.id }, data: { assignedDrawerId: people.drawer.id } });
  await pump();
  mark = sent.length;
  await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_REVISION_REQUESTED', orderId: o3.id, payload: { actorId: people.a1.id } }));
  await pump();
  assert.deepEqual(mailsOf(mark, o3.orderNo), [people.drawer.email, ...SALES()].sort());
}));

dbTest('A2 / A4 / A5: olaydan sonra açılan hesap almaz; firma adresi başka firmanın kullanıcısının adresiyse gönderilmez; başka firma hiç almaz', offline(async () => {
  const o = await newOrder('Geç hesap');
  await pump();
  const evCust = await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_OFFER_UPDATED', orderId: o.id, payload: { actorId: people.admin.id } }));
  const evSales = await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_PRODUCTION_APPROVED', orderId: o.id, payload: { offerId: 'yok', revision: 1, actorId: people.a1.id } }));
  // Olaylar kuyrukta beklerken açılan hesaplar (olaydan sonra)
  const later = new Date(Math.max(evCust.createdAt.getTime(), evSales.createdAt.getTime()) + 1000);
  const lateSales = await db.user.create({ data: { email: 'gec-satis@ea.test', name: 'Geç', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id, language: 'tr', createdAt: later } });
  const lateCust = await db.user.create({ data: { email: 'gec-musteri@ea.test', name: 'Geç M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, createdAt: later } });
  // Firmanın genel adresi başka firmanın kullanıcısının giriş adresi (büyük harfle bile)
  await db.customer.update({ where: { id: firm.id }, data: { email: people.b1.email.toUpperCase() } });
  try {
    const mark = sent.length;
    await pump();
    const cust = sent.slice(mark).filter((m) => m.subject.startsWith(`${o.orderNo} — `) && !m.subject.endsWith(APPROVED_TR)).map((m) => m.to).sort();
    assert.deepEqual(cust, [people.a1.email, people.a2.email].sort(), 'firma adresi (başka firmanın kullanıcısı) ve geç açılan müşteri hesabı yok');
    assert.deepEqual(mailsOf(mark, o.orderNo, APPROVED_TR), SALES(), 'geç açılan satış hesabı ve pasif satışçı yok');
    for (const e of [lateSales.email, lateCust.email, people.b1.email, people.b1.email.toUpperCase()]) assert.ok(!sent.slice(mark).some((m) => m.to.toLowerCase() === e.toLowerCase()), e);
  } finally {
    await db.customer.update({ where: { id: firm.id }, data: { email: 'office@alegrad-ea.test' } });
    await db.user.updateMany({ where: { id: { in: [lateSales.id, lateCust.id] } }, data: { isActive: false } });
  }
}));

dbTest('A4 kapsamı: teklif / üretim onayı dışındaki müşteri olayı eski kuralla — siparişi açan + firma adresi; firmanın öbür kullanıcısı almaz', offline(async () => {
  const o = await newOrder('Eski kural');
  await pump();
  const mark = sent.length;
  await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_SHIP_DATE', orderId: o.id, payload: { actorId: people.s1.id } }));
  await pump();
  assert.deepEqual(mailsOf(mark, o.orderNo), [people.a1.email, firm.email].sort(), 'a2 almaz (eski kural aynen); başka firma yok');
}));

dbTest('A7: 4.2.10\'dan kalan damgasız ORDER_PRODUCTION_APPROVED ve yalnızca zil olayları e-postaya dönüşmez ve dokunulmaz', offline(async () => {
  const o = await newOrder('Eski kayıtlar');
  await pump();
  // 4.2.10'un yazdığı biçim: damga yok (e-posta kuralı yokken yazılmış satır — doğrudan kuyruğa)
  const old = [
    await db.notificationOutbox.create({ data: { type: 'ORDER_PRODUCTION_APPROVED', orderId: o.id, payload: { offerId: 'eski', revision: 1, from: 'URETIMDE', to: 'URETIMDE', actorId: people.a1.id, lang: 'ro' } } }),
    ...await Promise.all(['ORDER_DWG_READY', 'ORDER_NOTE_ADDED', 'ORDER_OFFER_RETURNED', 'ORDER_OFFER_SUBMITTED']
      .map((type) => db.notificationOutbox.create({ data: { type, orderId: o.id, payload: { actorId: people.admin.id } } }))),
  ];
  const snap = async () => JSON.stringify(await db.notificationOutbox.findMany({
    where: { id: { in: old.map((r) => r.id) } }, orderBy: { id: 'asc' },
    select: { id: true, status: true, attempts: true, lastError: true, sentAt: true, availableAt: true, payload: true },
  }));
  const before = await snap();
  const mark = sent.length;
  for (let i = 0; i < 5; i++) await dispatchNotifications(db, { ...opts, now: new Date(Date.now() + i * 3_600_000) });
  assert.equal(await snap(), before, 'eski satırlar hiç değişmedi (PENDING, deneme 0, hata yok)');
  assert.deepEqual(mailsOf(mark, o.orderNo), [], 'eski olaylardan e-posta yok');
}));

dbTest('A8: SMTP geçici hatası — yalnızca hata veren satışçıya yeniden; ilerleme alıcı başına; satışçı başına tek e-posta', offline(async () => {
  const o = await newOrder('Yeniden deneme');
  await pump();
  const ev = await db.$transaction((tx) => enqueueOutbox(tx, { type: 'ORDER_PRODUCTION_APPROVED', orderId: o.id, payload: { offerId: 'yok', revision: 2, actorId: people.a1.id } }));
  const mark = sent.length;
  failing.add(people.s2.email);
  const t = new Date(Date.now() + 1000);
  await dispatchNotifications(db, { ...opts, now: t });
  let row = await db.notificationOutbox.findUnique({ where: { id: ev.id } });
  assert.equal(row.status, 'PENDING');
  assert.match(row.lastError, /SMTP 451/);
  assert.deepEqual([...row.payload.sentTo].sort(), [people.s1.email, people.s3.email].sort(), 'kabul edilen alıcılar yazıldı');
  await dispatchNotifications(db, { ...opts, now: new Date(t.getTime() + 2 * 60_000) });
  row = await db.notificationOutbox.findUnique({ where: { id: ev.id } });
  assert.equal(row.status, 'SENT');
  for (let i = 1; i <= 3; i++) await dispatchNotifications(db, { ...opts, now: new Date(t.getTime() + i * 3_600_000) });
  const got = sent.slice(mark).filter((m) => m.subject === `${o.orderNo} — ${APPROVED_TR}`).map((m) => m.to);
  assert.deepEqual([...got].sort(), SALES(), 'her satışçıya bir kez (hata veren yeniden denemede)');
  assert.equal(got.length, 3);
}));
