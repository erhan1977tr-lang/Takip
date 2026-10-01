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
  // Fiyatı eksik teklif: taslak kaydedilir, gönderilemez (sunucu kuralı); CNC / delik de fiyatlı olmalı, 0 kabul edilmez
  const noPrice = [...lines, { description: 'CNC', poz: null, enMm: null, boyMm: null, adet: 2, unit: 'adet', unitPrice: '0', kind: 'CNC', free: false }];
  assert.equal(await codeOf(run(o.id, 'save_offer', 'sales', { lines: noPrice })), 'OK', 'taslak engellenmez');
  const missing = await run(o.id, 'submit_offer', 'sales', { lines: noPrice }).catch((e) => e);
  assert.equal(missing.code, 'SALES_PRICE_MISSING');
  assert.deepEqual(missing.details.problems, [{ code: 'missing_prices', rows: [{ n: 1, kind: 'CNC' }] }]);
  assert.equal((await db.offer.findFirstOrThrow({ where: { orderId: o.id } })).status, 'HAZIRLANIYOR', 'gönderilmedi');
  assert.equal(await codeOf(run(o.id, 'submit_offer', 'sales', { lines: [{ ...lines[0], unitPrice: '0.00' }] })), 'SALES_PRICE_MISSING', 'cam satırı fiyatsız');
  await run(o.id, 'save_offer', 'sales', { lines, amount: '40.00' });
  await run(o.id, 'submit_offer', 'sales', { lines, amount: '40.00' });
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'sales', { lines, amount: '40.00' })), 'NOT_ALLOWED', 'satış teklifi müşteriye gönderemez');
  // Yönetici müşteri fiyatını girmeden gönderemez (karar 4); satış fiyatı (40) satırda kalır
  const saved = await db.offerLine.findMany({ where: { offer: { orderId: o.id } } });
  const adminLines = lines.map((l, i) => ({ ...l, id: saved[i].id }));
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'admin', { lines: adminLines })), 'OFFER_PRICE_MISSING');
  const res = await run(o.id, 'approve_offer', 'admin', { lines: adminLines.map((l) => ({ ...l, offerPrice: '41.00', unitPrice: '999.00' })), labels: { camEtiket: 'GLA-CAM', sandikEtiket: 'GLA-S' } });
  const offer = await db.offer.findFirstOrThrow({ where: { orderId: o.id }, include: { lines: true } });
  assert.deepEqual([String(offer.amount), String(offer.offerAmount), String(offer.lines[0].unitPrice), String(offer.lines[0].offerPrice)], ['40', '41', '40', '41'],
    'yönetici satış fiyatını değiştiremez; iki tutar ayrı saklanır');
  assert.equal(res.result.produced, true);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { price: true, events: { orderBy: { createdAt: 'asc' } } } });
  assert.deepEqual([order.status, String(order.price.amount), order.sandikEtiket], ['URETIMDE', '41', 'GLA-S']);
  const tail = order.events.slice(-2).map((e) => [e.event, e.fromStatus, e.toStatus]);
  assert.deepEqual(tail, [['OFFER_SENT', 'HAZIRLANIYOR', 'HAZIRLANIYOR'], ['PRODUCTION', 'HAZIRLANIYOR', 'URETIMDE']]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', actorRole: 'ADMIN' } });
  assert.deepEqual(audit.details.events, ['OFFER_SENT', 'PRODUCTION']);
});

dbTest('geçiş: çizim döngüsü; taslak → gönder; müşteri eski sürümü onaylayamaz (bu arada yeni sürüm geldiyse)', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  // Tek etkin çizimci → iş kendiliğinden ona atanır, "üstlen" gerekmez
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).assignedDrawerId, people.drawer.id);
  assert.equal(await codeOf(run(o.id, 'start_drawing', 'drawer')), 'NOT_ALLOWED');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('v1')] });
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'NOT_ALLOWED', 'taslak müşteriye gitmedi');
  await run(o.id, 'send_drawing', 'drawer', { drawingId: v1.result.drawingId });
  // Revizyon: not zorunlu; çizim üstü işaretler yalnızca bu sürümün dosyalarına, doğrulanarak saklanır
  assert.equal(await codeOf(run(o.id, 'request_revision', 'cust', { comment: '', drawingId: v1.result.drawingId })), 'REVISION_COMMENT');
  const v1File = (await db.drawingFile.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } })).id;
  await run(o.id, 'request_revision', 'cust', {
    comment: 'Yükseklik 1100 olsun', drawingId: v1.result.drawingId,
    annotations: JSON.stringify([{ fileId: v1File, page: 1, type: 'pin', x: 0.5, y: 0.25, text: 'burası' }, { fileId: 'baska-dosya', page: 1, type: 'pin', x: 0.1, y: 0.1, text: 'x' }]),
  });
  const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } });
  assert.deepEqual(rev.annotations, [{ fileId: v1File, page: 1, type: 'pin', x: 0.5, y: 0.25, text: 'burası' }], 'başka dosyaya işaret atılır');
  assert.equal(rev.comment, 'Yükseklik 1100 olsun');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('v2')] });
  assert.equal(v2.result.version, 2);
  await run(o.id, 'send_drawing', 'drawer');
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'STALE_DRAWING');
  await run(o.id, 'approve_drawing', 'cust', { drawingId: v2.result.drawingId });
  const drawings = await db.drawing.findMany({ where: { orderId: o.id }, orderBy: { version: 'asc' }, include: { files: true } });
  assert.deepEqual(drawings.map((d) => [d.version, d.status, d.files.length, !!d.sentAt, d.decidedById]),
    [[1, 'REVIZYON_ISTENDI', 1, true, people.cust.id], [2, 'ONAYLANDI', 1, true, people.cust.id]], 'eski sürüm silinmez');
});

dbTest('çizim: çoklu dosya taslağa eklenir; taranmamış dosyayla gönderilemez; gönderilen sürümün dosyası çıkarılamaz', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const a = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('a1'), { ...fileMeta('a2'), scanStatus: 'PENDING' }], noteCustomer: 'Müşteri notu', noteInternal: 'İç not' });
  const b = await run(o.id, 'upload_drawing', 'drawer', { files: [{ ...fileMeta('a3'), scanStatus: 'SKIPPED' }] });
  assert.equal(b.result.drawingId, a.result.drawingId, 'açık taslağa eklenir, yeni sürüm açılmaz');
  let d = await db.drawing.findUniqueOrThrow({ where: { id: a.result.drawingId }, include: { files: true } });
  assert.deepEqual([d.status, d.files.length, d.noteCustomer, d.noteInternal], ['TASLAK', 3, 'Müşteri notu', 'İç not']);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).drawingTrack, 'YAPILIYOR');

  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer')), 'DRAWING_SCAN_PENDING');
  await db.drawingFile.updateMany({ where: { drawingId: d.id, scanStatus: 'PENDING' }, data: { scanStatus: 'CLEAN' } });
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer')), 'DRAWING_NOT_SCANNED', 'antivirüs kapalıyken yüklenen dosya da gönderilemez');
  const skipped = d.files.find((f) => f.scanStatus === 'SKIPPED');
  const rm = await run(o.id, 'remove_drawing_file', 'drawer', { fileId: skipped.id });
  assert.equal(rm.result.storageKey, skipped.storageKey);
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'sales')), 'NOT_ALLOWED', 'satış çizim gönderemez');
  await run(o.id, 'send_drawing', 'drawer');
  d = await db.drawing.findUniqueOrThrow({ where: { id: d.id }, include: { files: true } });
  assert.deepEqual([d.status, d.files.length, d.sentById], ['ONAY_BEKLIYOR', 2, people.drawer.id]);
  assert.equal(await codeOf(run(o.id, 'remove_drawing_file', 'drawer', { fileId: d.files[0].id })), 'NOT_ALLOWED', 'gönderilen sürümün dosyası değişmez');
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'send_drawing' } } });
  assert.equal(audit.actorRole, 'CIZIM');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'DRAWING_UPLOADED' } }), 1);
});

dbTest('çizim: gönderilen sürüm gerekçeyle geri çekilir; müşteri artık onaylayamaz; yeni sürüm açılır', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('w1')] });
  await run(o.id, 'send_drawing', 'drawer');
  assert.equal(await codeOf(run(o.id, 'withdraw_drawing', 'drawer', { reason: '' })), 'WITHDRAW_REASON');
  assert.equal(await codeOf(run(o.id, 'withdraw_drawing', 'cust', { reason: 'x' })), 'NOT_ALLOWED');
  await run(o.id, 'withdraw_drawing', 'drawer', { reason: 'Yanlış dosya' });
  const d1 = await db.drawing.findUniqueOrThrow({ where: { id: v1.result.drawingId } });
  assert.deepEqual([d1.status, d1.withdrawReason, !!d1.withdrawnAt], ['GERI_CEKILDI', 'Yanlış dosya', true]);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).drawingTrack, 'YAPILIYOR');
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'NOT_ALLOWED');
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, event: 'DRAWING_WITHDRAWN' } });
  assert.equal(ev.note, 'v1: Yanlış dosya');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('w2')] });
  assert.equal(v2.result.version, 2);
});

