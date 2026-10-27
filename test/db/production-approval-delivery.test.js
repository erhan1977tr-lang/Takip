// Müşteri üretim onayı 4.2.5 (ürün sahibinin 27.10.2026 kararları) — veritabanıyla:
//   - süre talep müşteriye GERÇEKTEN iletildiğinde başlar (e-posta kabul edildi; e-posta gidemiyorsa uygulama içi bildirim)
//   - iletilemeyen talepte süre başlamaz, hata kaydedilir, yöneticiye bildirilir; yönetici yeniden gönderir (mükerrer yok)
//   - müşteriye tek hatırlatma (1 iş günü sonra), tekrarlanmaz
//   - onaysız yükleme engeli: "Yükleme yapıldı" ve "Yüklendi" sunucuda; 30.10.2026 serbest, 06.11.2026 ve sonrası engelli;
//     yalnızca yönetici gerekçeli istisna verir (müşteri onayı sayılmaz, denetim kaydı); ayar kapalıyken engel yok
// SMTP sahte (bellek içi taşıyıcı); FGO / ağ yok (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { approvalDeadline, approvalDueText } from '../../server/orders/production-approval.js';
import { remindApprovalCustomers, saveApprovalSetting } from '../../server/orders/production-approval-service.js';
import { dispatchNotifications } from '../../server/notifications/email.js';
import { dispatchInApp, dispatchInAppFor } from '../../server/notifications/inapp.js';
import { confirmLoading, previewLoading } from '../../server/loading/confirmation.js';

let db;
let firm;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const setApproval = (enabled) => saveApprovalSetting(db, { enabled, actor: actor(people.admin) });

// Sahte SMTP: gönderilenler burada; failing kümesindeki adrese her seferinde hata
const sent = [];
const failing = new Set();
const transport = {
  sendMail: async (m) => {
    if (failing.has(m.to)) throw Object.assign(new Error('SMTP 550 reddedildi'), { responseCode: 550 });
    sent.push(m);
    return { messageId: `m${sent.length}` };
  },
};
const mailOpts = { transport, from: 'takip@po.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
const mailsTo = (email) => sent.filter((m) => m.to === email);

let fileNo = 0;
/**
 * Sipariş: yükleme günü ve kapsam bayrağı açıkça yazılır (oluşturmadaki tahmini gün testin günüyle çakışmasın —
 * yükleme günü testleri kendi günlerini kullanır). Varsayılan: uzak bir gün + bayraklı.
 */
const newOrder = async (title, ship = '2027-02-05', flagged = true) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  const o = await createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/po-${fileNo}.pdf`, name: `po-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${ship}T10:00:00Z`), productionApprovalRequired: flagged } });
  return o;
};
const glass = () => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false });
const latest = (orderId) => db.offer.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const adminForm = (lines, price = '50') => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), crateFee: l.crateFee, offerPrice: price,
}));
const orderOf = (id) => db.order.findUnique({ where: { id } });
async function sendOffer(orderId) {
  await run(orderId, 'no_drawing', 'sales');
  await run(orderId, 'submit_offer', 'sales', { lines: [glass()] });
  await run(orderId, 'approve_offer', 'admin', { lines: adminForm((await latest(orderId)).lines) });
  return latest(orderId);
}
/** Ayar kapalıyken üretime geçmiş sipariş + geçişin yazdığı kapsam / talep (mevcut sipariş — URETIMDE) */
async function producingFlagged(title, ship) {
  await setApproval(false);
  const o = await newOrder(title, ship, false);
  const offer = await sendOffer(o.id);
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  await db.order.update({ where: { id: o.id }, data: { productionApprovalRequired: true } });
  await db.offer.update({ where: { id: offer.id }, data: { approvalRequestedAt: new Date() } });
  await setApproval(true);
  return { order: o, offer };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Pilot Onay Cam SRL', prefix: 'POC', email: 'firma@po.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@po.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, language: 'ro', ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  // E-posta bildirimleri bu testte en baştan başlamış sayılır (önceki olaylar atlanmaz)
  await db.integrationSetting.upsert({ where: { key: 'notify.since' }, create: { key: 'notify.since', value: { at: new Date(0).toISOString() } }, update: { value: { at: new Date(0).toISOString() } } });
});
after(closeDb);

// 7. İki iş günlük süre doğru başlar · 8. e-posta ve uygulama içi bildirim çalışır
dbTest('süre e-posta müşteriye iletildiği anda başlar (gönderimde değil); e-postada aynı son tarih; zil bildirimi', offline(async () => {
  await setApproval(true);
  const o = await newOrder('İletim e-posta');
  const offer = await sendOffer(o.id);
  assert.ok(offer.approvalRequestedAt instanceof Date, 'talep yazıldı');
  assert.equal(offer.approvalDueAt, null, 'gönderimde süre başlamaz');
  assert.equal(offer.approvalDeliveredAt, null);
  const row = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_SENT' } });
  assert.deepEqual(row.payload.approval, { offerId: offer.id });
  // Uygulama içi: müşteriye "Üretim onayınız bekleniyor" (son tarih yazılmaz — e-postada / sipariş sayfasında)
  await dispatchInAppFor(db, [row.id]);
  const bell = await db.notification.findFirst({ where: { userId: people.cust.id, dedupeKey: `outbox:${row.id}` } });
  assert.equal(bell.params.approval, 1);
  assert.equal('due' in bell.params, false);
  // İşçinin e-posta turu: pazartesi 09.11.2026 10:30 (Romanya) → son tarih çarşamba 11.11.2026 10:30
  const at = new Date('2026-11-09T08:30:00Z');
  sent.length = 0;
  await dispatchNotifications(db, { ...mailOpts, now: at });
  const after1 = await db.offer.findUnique({ where: { id: offer.id } });
  assert.equal(after1.approvalDeliveredAt.toISOString(), at.toISOString());
  assert.equal(after1.approvalDeliveryChannel, 'EMAIL');
  assert.equal(after1.approvalDueAt.toISOString(), approvalDeadline(at).due.toISOString());
  assert.equal(after1.approvalDueAt.toISOString(), '2026-11-11T08:30:00.000Z');
  const mail = mailsTo('cust@po.test').find((m) => m.subject.startsWith(o.orderNo));
  assert.ok(mail, 'müşteriye e-posta');
  assert.match(mail.text, /11\.11\.2026 10:30/, 'e-postadaki son tarih kaydedilen son tarih');
  assert.match(mail.text, /2 zile lucrătoare/, 'müşterinin dilinde (Romence)');
  assert.ok(mailsTo('firma@po.test').length >= 1, 'firmanın adresine de');
  // İletim bir kez: daha sonraki tur değiştirmez
  await dispatchNotifications(db, { ...mailOpts, now: new Date('2026-11-10T08:30:00Z') });
  assert.equal((await db.offer.findUnique({ where: { id: offer.id } })).approvalDeliveredAt.toISOString(), at.toISOString());
}));

dbTest('iletilemeyen talep: süre başlamaz, hata kaydı + yöneticiye bir bildirim; yeniden gönderim (yalnızca yönetici, mükerrer yok) → iletimde süre', offline(async () => {
  await setApproval(true);
  const o = await newOrder('İletilemeyen');
  const offer = await sendOffer(o.id);
  failing.add('cust@po.test');
  failing.add('firma@po.test');
  let now = new Date('2026-11-09T08:00:00Z');
  for (let i = 0; i < 8; i++) {
    await dispatchNotifications(db, { ...mailOpts, now });
    now = new Date(now.getTime() + 3 * 3_600_000);
  }
  const row = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_SENT' } });
  assert.equal(row.status, 'FAILED', 'kayıt altında (son hata kuyrukta)');
  let x = await db.offer.findUnique({ where: { id: offer.id } });
  assert.equal(x.approvalDeliveredAt, null);
  assert.equal(x.approvalDueAt, null, 'iletilmeyen talepte süre YOK');
  assert.equal(x.approvalDeliveryError, 'EMAIL_FAILED');
  assert.ok(x.approvalDeliveryFailedAt instanceof Date);
  const alerts = await db.notification.findMany({ where: { type: 'PRODUCTION_APPROVAL_UNDELIVERED', orderId: o.id } });
  assert.deepEqual(alerts.map((n) => n.userId).sort(), [people.admin.id, people.assistant.id].sort(), 'yönetici + yardımcı, bir kez');
  // Yeniden gönderim: satış / çizimci / müşteri yapamaz; yönetici yapar; kuyrukta bekleyen varken ikincisi reddedilir
  for (const who of ['sales', 'cust', 'inspector']) assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(o.id, 'resend_approval_request', who, { offerId: offer.id }))), who);
  await run(o.id, 'resend_approval_request', 'admin', { offerId: offer.id });
  assert.equal(await codeOf(run(o.id, 'resend_approval_request', 'admin', { offerId: offer.id })), 'APPROVAL_SEND_QUEUED');
  x = await db.offer.findUnique({ where: { id: offer.id } });
  assert.equal(x.approvalDeliveryError, null);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'ORDER_PRODUCTION_APPROVAL_REQUESTED', status: 'PENDING' } }), 1);
  failing.clear();
  const at = new Date('2026-11-12T09:00:00Z');
  await dispatchNotifications(db, { ...mailOpts, now: at });
  x = await db.offer.findUnique({ where: { id: offer.id } });
  assert.equal(x.approvalDeliveredAt.toISOString(), at.toISOString());
  assert.equal(x.approvalDueAt.toISOString(), approvalDeadline(at).due.toISOString());
  // İletildikten sonra yeniden gönderim yok
  assert.equal(await codeOf(run(o.id, 'resend_approval_request', 'admin', { offerId: offer.id })), 'NOT_ALLOWED');
}));

dbTest('müşteri e-posta almıyorsa (tercih) uygulama içi bildirim iletimdir; hiçbir yoldan ulaşılamıyorsa süre başlamaz', offline(async () => {
  await setApproval(true);
  await db.customer.update({ where: { id: firm.id }, data: { email: null } });
  await db.user.update({ where: { id: people.cust.id }, data: { emailNotifications: false } });
  try {
    const o = await newOrder('Zil');
    const offer = await sendOffer(o.id);
    const row = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_SENT' } });
    await dispatchInApp(db, { now: new Date() });
    const bell = await db.notification.findFirst({ where: { userId: people.cust.id, dedupeKey: `outbox:${row.id}` } });
    await dispatchNotifications(db, { ...mailOpts, now: new Date('2026-11-09T08:30:00Z') });
    const x = await db.offer.findUnique({ where: { id: offer.id } });
    assert.equal(x.approvalDeliveryChannel, 'IN_APP');
    assert.equal(x.approvalDeliveredAt.toISOString(), bell.createdAt.toISOString());
    assert.equal(x.approvalDueAt.toISOString(), approvalDeadline(bell.createdAt).due?.toISOString());
    assert.equal(mailsTo('cust@po.test').filter((m) => m.subject.startsWith(o.orderNo)).length, 0, 'tercih: e-posta yok');

    // Etkin müşteri kullanıcısı da yok: iletilemez → süre yok, yönetici bilgilenir
    const o2 = await newOrder('Ulaşılamayan');
    const offer2 = await sendOffer(o2.id);
    await db.user.update({ where: { id: people.cust.id }, data: { isActive: false } });
    await dispatchInApp(db, { now: new Date() });
    await dispatchNotifications(db, { ...mailOpts, now: new Date('2026-11-09T08:30:00Z') });
    const y = await db.offer.findUnique({ where: { id: offer2.id } });
    assert.equal(y.approvalDeliveredAt, null);
    assert.equal(y.approvalDueAt, null);
    assert.equal(y.approvalDeliveryError, 'NO_RECIPIENT');
    assert.equal(await db.notification.count({ where: { type: 'PRODUCTION_APPROVAL_UNDELIVERED', orderId: o2.id } }), 2);
  } finally {
    await db.customer.update({ where: { id: firm.id }, data: { email: 'firma@po.test' } });
    await db.user.update({ where: { id: people.cust.id }, data: { emailNotifications: true, isActive: true } });
  }
}));

dbTest('hatırlatma: iletimden 1 iş günü sonra müşteriye BİR KEZ (e-posta + zil); onaylanmış / iletilmemiş talebe yok', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Hatırlatma');
  const offer = await sendOffer(o.id);
  const notYet = await newOrder('Henüz iletilmedi');
  await sendOffer(notYet.id);
  const at = new Date('2026-11-09T08:30:00Z');
  await db.notificationOutbox.updateMany({ where: { orderId: notYet.id }, data: { status: 'SKIPPED' } });
  await dispatchNotifications(db, { ...mailOpts, now: at });
  const reminders = (id) => db.notificationOutbox.count({ where: { orderId: id, type: 'ORDER_PRODUCTION_APPROVAL_REMINDER' } });
  await remindApprovalCustomers(db, { now: new Date('2026-11-10T08:29:00Z') });
  assert.equal(await reminders(o.id), 0, 'zamanı gelmedi');
  await remindApprovalCustomers(db, { now: new Date('2026-11-10T08:30:00Z') });
  await remindApprovalCustomers(db, { now: new Date('2026-11-10T12:00:00Z') });
  assert.equal(await reminders(o.id), 1, 'bir kez');
  assert.equal(await reminders(notYet.id), 0, 'iletilmemiş talep hatırlatılmaz');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'PRODUCTION_APPROVAL_REMINDER' } }), 1);
  sent.length = 0;
  await dispatchNotifications(db, { ...mailOpts, now: new Date('2026-11-10T08:31:00Z') });
  const mail = mailsTo('cust@po.test').find((m) => m.subject.startsWith(o.orderNo));
  assert.match(mail.subject, /Memento/);
  assert.match(mail.text, new RegExp(approvalDueText(approvalDeadline(at).due).replace(/\./g, '\\.')));
  const row = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_PRODUCTION_APPROVAL_REMINDER' } });
  await dispatchInAppFor(db, [row.id]);
  assert.equal(await db.notification.count({ where: { userId: people.cust.id, dedupeKey: `outbox:${row.id}` } }), 1);
  // İletim değişmedi
  assert.equal((await db.offer.findUnique({ where: { id: offer.id } })).approvalDeliveredAt.toISOString(), at.toISOString());
  // Onaylandıktan sonra bir sonraki sürüm yok → yeni hatırlatma yok
  await run(o.id, 'approve_production', 'cust', { offerId: offer.id });
  await remindApprovalCustomers(db, { now: new Date('2026-11-20T08:30:00Z') });
  assert.equal(await reminders(o.id), 1);
}));

// 1. 30.10.2026 serbest · 2. 06.11.2026 engelli · 3. yönetici gerekçeli istisna · 4. başka roller istisna veremez
dbTest('"Yükleme yapıldı": 30.10.2026 onaysız yapılır; 06.11.2026 onaysız yapılamaz; yöneticinin gerekçeli istisnasıyla yapılır', offline(async () => {
  const early = await producingFlagged('Erken yükleme', '2026-10-30');
  const late = await producingFlagged('Geç yükleme', '2026-11-06');
  const now = new Date('2026-11-07T12:00:00Z');
  // 1. 30.10.2026: kapsam bayrağı olsa da engel yok
  const p1 = await previewLoading(db, '2026-10-30');
  assert.ok(p1.orders.some((x) => x.orderId === early.order.id));
  const r1 = await confirmLoading(db, { day: '2026-10-30', key: p1.key, actor: actor(people.admin), now });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  // 2. 06.11.2026: müşteri onayı yok → hiçbir şey yazılmaz
  const p2 = await previewLoading(db, '2026-11-06');
  const r2 = await confirmLoading(db, { day: '2026-11-06', key: p2.key, actor: actor(people.admin), now });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'APPROVAL_REQUIRED');
  assert.deepEqual(r2.blocked.map((b) => [b.orderNo, b.reason]), [[(await orderOf(late.order.id)).orderNo, 'PENDING']]);
  assert.equal(await db.loadingConfirmation.count({ where: { shipDay: new Date('2026-11-06T00:00:00.000Z') } }), 0);
  // 4. Yönetici dışındaki roller istisna veremez (yönetici yardımcısı dahil)
  for (const who of ['assistant', 'sales', 'drawer', 'inspector', 'cust']) {
    assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(late.order.id, 'override_loading_approval', who, { reason: 'acil' }))), who);
  }
  // 3. Yönetici: gerekçe zorunlu; istisna müşteri onayı değildir; denetim kaydı (kullanıcı, zaman, sipariş, gerekçe)
  assert.equal(await codeOf(run(late.order.id, 'override_loading_approval', 'admin', { reason: '  ' })), 'OVERRIDE_REASON_REQUIRED');
  await run(late.order.id, 'override_loading_approval', 'admin', { reason: 'Müşteri telefonla onayladı, yazılı onay gelecek' });
  const ord = await orderOf(late.order.id);
  assert.equal(ord.loadingOverrideById, people.admin.id);
  assert.ok(ord.loadingOverrideAt instanceof Date);
  assert.equal(ord.loadingOverrideReason, 'Müşteri telefonla onayladı, yazılı onay gelecek');
  assert.equal(ord.status, 'URETIMDE', 'sipariş durumu değişmez');
  const off = await db.offer.findUnique({ where: { id: late.offer.id } });
  assert.equal(off.approvedAt, null, 'istisna müşteri onayı olarak kaydedilmez');
  assert.equal(off.approvedById, null);
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: late.order.id, details: { path: ['action'], equals: 'override_loading_approval' } } });
  assert.ok(audit);
  assert.equal(audit.userId, people.admin.id);
  assert.match(JSON.stringify(audit.details), /Müşteri telefonla onayladı/);
  assert.match(JSON.stringify(audit.details), /"customerApproval":false/);
  const ev = await db.orderEvent.findFirst({ where: { orderId: late.order.id, event: 'LOADING_APPROVAL_OVERRIDE' } });
  assert.equal(ev.userId, people.admin.id);
  assert.equal(ev.note, 'Müşteri telefonla onayladı, yazılı onay gelecek');
  // İstisna bir kez
  assert.equal(await codeOf(run(late.order.id, 'override_loading_approval', 'admin', { reason: 'tekrar' })), 'NOT_ALLOWED');
  const p3 = await previewLoading(db, '2026-11-06');
  const r3 = await confirmLoading(db, { day: '2026-11-06', key: p3.key, actor: actor(people.admin), now });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  // Müşteri hâlâ onaylayabilir (onay hakkı kaybolmaz)
  assert.equal((await db.offer.findUnique({ where: { id: late.offer.id } })).approvedAt, null);
}));

dbTest('"Yükleme yapıldı": müşteri onayı gelince engel kalkar; ayar kapalıyken engel yok (4.2.0 davranışı); bayraksız sipariş etkilenmez', offline(async () => {
  const a = await producingFlagged('Onaylanacak', '2026-11-13');
  const now = new Date('2026-11-14T12:00:00Z');
  let p = await previewLoading(db, '2026-11-13');
  assert.equal((await confirmLoading(db, { day: '2026-11-13', key: p.key, actor: actor(people.admin), now })).code, 'APPROVAL_REQUIRED');
  await run(a.order.id, 'approve_production', 'cust', { offerId: a.offer.id });
  p = await previewLoading(db, '2026-11-13');
  assert.equal((await confirmLoading(db, { day: '2026-11-13', key: p.key, actor: actor(people.admin), now })).ok, true);

  const b = await producingFlagged('Ayar kapalı', '2026-11-20');
  await setApproval(false);
  p = await previewLoading(db, '2026-11-20');
  assert.equal((await confirmLoading(db, { day: '2026-11-20', key: p.key, actor: actor(people.admin), now: new Date('2026-11-21T12:00:00Z') })).ok, true, 'ayar kapalı → engel yok');
  assert.equal((await db.offer.findUnique({ where: { id: b.offer.id } })).approvedAt, null);
  await setApproval(true);
  const plain = await newOrder('Bayraksız', '2026-11-27', false);
  await sendOffer(plain.id);
  assert.equal((await orderOf(plain.id)).productionApprovalRequired, false);
  p = await previewLoading(db, '2026-11-27');
  assert.equal((await confirmLoading(db, { day: '2026-11-27', key: p.key, actor: actor(people.admin), now: new Date('2026-11-28T12:00:00Z') })).ok, true);
}));

dbTest('"Yüklendi" (satış): onaysız kapsamdaki sipariş reddedilir; 30.10.2026 siparişi ve onaylı / istisnalı sipariş yüklenir', offline(async () => {
  const blocked = await producingFlagged('Yüklendi engel', '2026-12-04');
  assert.equal(await codeOf(run(blocked.order.id, 'mark_shipped', 'sales')), 'LOADING_APPROVAL_REQUIRED');
  assert.equal((await orderOf(blocked.order.id)).status, 'URETIMDE', 'hiçbir şey yazılmadı');
  await run(blocked.order.id, 'approve_production', 'cust', { offerId: blocked.offer.id });
  await run(blocked.order.id, 'mark_shipped', 'sales');
  assert.equal((await orderOf(blocked.order.id)).status, 'YUKLENDI');

  const early = await producingFlagged('Yüklendi 30.10', '2026-10-30');
  await run(early.order.id, 'mark_shipped', 'sales');
  assert.equal((await orderOf(early.order.id)).status, 'YUKLENDI', '30.10.2026 etkilenmez');

  const excepted = await producingFlagged('Yüklendi istisna', '2026-12-11');
  await run(excepted.order.id, 'override_loading_approval', 'admin', { reason: 'Kamyon bekliyor; müşteri yazılı onay verecek' });
  await run(excepted.order.id, 'mark_shipped', 'sales');
  assert.equal((await orderOf(excepted.order.id)).status, 'YUKLENDI');
  assert.equal((await db.offer.findUnique({ where: { id: excepted.offer.id } })).approvedAt, null, 'istisna onay değildir');
}));
