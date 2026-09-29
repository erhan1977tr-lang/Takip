import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { runBaseSeed } from '../../prisma/seed/base.mjs';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';

let db;
const people = {};
let firm;
let otherFirm;

const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const fileMeta = (n) => ({ storageKey: `2026/09/test${n}.pdf`, name: `cizim-${n}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const newOrder = async (title = 'Test') => {
  const next = await suggestNextNo(db, firm.id);
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }], files: [fileMeta(`o${next}`)],
  });
};
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  await runBaseSeed(db, { log: () => {} });
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', camEtiket: 'GLA-CAM' } });
  otherFirm = await db.customer.create({ data: { name: 'Alegrad', prefix: 'ALE' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@test.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('other', 'MUSTERI', otherFirm.id, { canApprove: true });
});
after(closeDb);

dbTest('numara: aynı anda 10 sipariş → 10 farklı ardışık numara (önerilen numara değişmediyse kaydırılır)', async () => {
  const first = await suggestNextNo(db, firm.id);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createGlassOrder(db, {
    actor: actor(people.cust), firm, title: `Eşzamanlı ${i}`, requestedNo: first, suggestedNo: first,
    items: [{ glassName: 'Cam', camAdedi: 1 }], files: [fileMeta(`c${i}`)],
  })));
  const nos = results.map((r) => r.customerOrderNo).sort((a, b) => a - b);
  assert.deepEqual(nos, Array.from({ length: 10 }, (_, i) => first + i));
  assert.equal(new Set(results.map((r) => r.orderNo)).size, 10);
  assert.ok(results.every((r) => r.orderNo === `GLA${r.customerOrderNo}`));
  assert.equal(results.filter((r) => r.bumped).length, 9);
});

dbTest('numara: müşterinin yazdığı numara doluysa kaydedilmez; boşsa yazdığı numara kullanılır', async () => {
  const taken = (await db.order.findFirst({ where: { customerId: firm.id } })).customerOrderNo;
  const next = await suggestNextNo(db, firm.id);
  const dup = createGlassOrder(db, { actor: actor(people.cust), firm, title: 'x', requestedNo: taken, suggestedNo: next, items: [], files: [fileMeta('d1')] });
  assert.equal(await codeOf(dup), 'DUPLICATE_NUMBER');
  const custom = await createGlassOrder(db, { actor: actor(people.cust), firm, title: 'x', requestedNo: 500, suggestedNo: next, items: [], files: [fileMeta('d2')] });
  assert.deepEqual([custom.orderNo, custom.bumped], ['GLA500', false]);
  assert.equal(await suggestNextNo(db, firm.id), 501);
  // Başka firma aynı numarayı kullanabilir (kodlar farklı)
  const ale = await createGlassOrder(db, { actor: actor(people.other), firm: otherFirm, title: 'x', requestedNo: 500, suggestedNo: 1, items: [], files: [fileMeta('d3')] });
  assert.equal(ale.orderNo, 'ALE500');
});

dbTest('oluşturma: tip, geçmiş, denetim (rol + IP) ve bildirim kuyruğu', async () => {
  const o = await newOrder('Kayıt testi');
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { files: true, events: true } });
  assert.equal(order.orderTypeCode, 'GLASS_ORDER');
  assert.equal(order.files[0].scanStatus, 'CLEAN');
  assert.deepEqual(order.events.map((e) => [e.event, e.fromStatus, e.toStatus]), [['CREATED', null, 'YENI']]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_CREATE' } });
  assert.deepEqual([audit.actorRole, audit.ip], ['MUSTERI', '127.0.0.1']);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'ORDER_CREATED' } }), 1);
});

dbTest('geçiş: satış kararı durum + geçmiş + denetim + kuyruk yazar, sürümü artırır', async () => {
  const o = await newOrder();
  const res = await run(o.id, 'send_to_drawing', 'sales');
  assert.equal(res.order.status, 'HAZIRLANIYOR');
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { offers: { include: { lines: true } } } });
  assert.deepEqual([order.drawingTrack, order.version, order.offers.length, order.offers[0].lines[0].description], ['GEREKLI', 1, 1, '8mm Temperli']);
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, event: 'SENT_TO_DRAWING' } });
  assert.deepEqual([ev.fromStatus, ev.toStatus, ev.userId], ['YENI', 'HAZIRLANIYOR', people.sales.id]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION' } });
  assert.equal(audit.actorRole, 'SATIS');
  assert.equal(audit.details.action, 'send_to_drawing');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'ORDER_SENT_TO_DRAWING' } }), 1);
});

dbTest('geçiş: denetimci ve yetkisiz roller hiçbir şey yapamaz; başka firmanın müşterisi siparişi bulamaz', async () => {
  const o = await newOrder();
  const before = await db.orderEvent.count({ where: { orderId: o.id } });
  assert.equal(await codeOf(run(o.id, 'send_to_drawing', 'inspector')), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'send_to_drawing', 'drawer')), 'NOT_FOUND', 'çizim ekibi çizimsiz siparişi görmez');
  assert.equal(await codeOf(run(o.id, 'cancel', 'sales', { note: 'x' })), 'NOT_ALLOWED', 'satış iptal edemez (karar 3)');
  assert.equal(await codeOf(run(o.id, 'hold', 'other')), 'NOT_FOUND');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id } }), before);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).version, 0);
});

dbTest('geçiş: aynı anda iki karar → yalnızca biri işlenir; eski sürümle gelen işlem reddedilir', async () => {
  const o = await newOrder();
  const [a, b] = await Promise.all([codeOf(run(o.id, 'no_drawing', 'sales')), codeOf(run(o.id, 'no_drawing', 'admin'))]);
  // Biri işlenir; diğeri ya sürüm çakışması (aynı anda) ya da artık geçersiz işlem (sonra yüklendiyse) alır
  assert.equal([a, b].filter((r) => r === 'OK').length, 1, `${a} / ${b}`);
  assert.ok([a, b].some((r) => r === 'CONFLICT' || r === 'NOT_ALLOWED'), `${a} / ${b}`);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'NO_DRAWING' } }), 1);
  const version = (await db.order.findUniqueOrThrow({ where: { id: o.id } })).version;
  assert.equal(await codeOf(run(o.id, 'set_ship_date', 'sales', { date: new Date('2026-12-04T12:00:00Z'), expectedVersion: version - 1 })), 'CONFLICT');
  assert.equal(await codeOf(run(o.id, 'set_ship_date', 'sales', { date: new Date('2026-12-04T12:00:00Z'), expectedVersion: version })), 'OK');
});

dbTest('geçiş: teklif yolu → yönetici gönderir → otomatik üretim (iki geçmiş kaydı)', async () => {
  const o = await newOrder();
  await run(o.id, 'no_drawing', 'sales');
  const lines = [{ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false }];
  await run(o.id, 'save_offer', 'sales', { lines, amount: '40.00' });
  await run(o.id, 'submit_offer', 'sales', { lines, amount: '40.00' });
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'sales', { lines, amount: '40.00' })), 'NOT_ALLOWED', 'satış teklifi müşteriye gönderemez');
  const res = await run(o.id, 'approve_offer', 'admin', { lines, amount: '41.00', labels: { camEtiket: 'GLA-CAM', sandikEtiket: 'GLA-S' } });
  assert.equal(res.result.produced, true);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { price: true, events: { orderBy: { createdAt: 'asc' } } } });
  assert.deepEqual([order.status, String(order.price.amount), order.sandikEtiket], ['URETIMDE', '41', 'GLA-S']);
  const tail = order.events.slice(-2).map((e) => [e.event, e.fromStatus, e.toStatus]);
  assert.deepEqual(tail, [['OFFER_SENT', 'HAZIRLANIYOR', 'HAZIRLANIYOR'], ['PRODUCTION', 'HAZIRLANIYOR', 'URETIMDE']]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', actorRole: 'ADMIN' } });
  assert.deepEqual(audit.details.events, ['OFFER_SENT', 'PRODUCTION']);
});

dbTest('geçiş: çizim döngüsü; müşteri eski sürümü onaylayamaz (bu arada yeni sürüm geldiyse)', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  await run(o.id, 'start_drawing', 'drawer');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { file: fileMeta('v1') });
  await run(o.id, 'request_revision', 'cust', { comment: 'Yükseklik 1100 olsun', drawingId: v1.result.drawingId });
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { file: fileMeta('v2') });
  assert.equal(v2.result.version, 2);
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'STALE_DRAWING');
  await run(o.id, 'approve_drawing', 'cust', { drawingId: v2.result.drawingId });
  const drawings = await db.drawing.findMany({ where: { orderId: o.id }, orderBy: { version: 'asc' } });
  assert.deepEqual(drawings.map((d) => [d.version, d.status]), [[1, 'REVIZYON_ISTENDI'], [2, 'ONAYLANDI']], 'eski sürüm silinmez');
});
