import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { runBaseSeed } from '../../prisma/seed/base.mjs';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { reviewToken } from '../../server/orders/review.js';
import { getEnv } from '../../server/env.js';
import { glassLoadingDate } from '../../server/orders/rules.js';
import { drawingsView, findDrawingFile } from '../../server/orders/drawing-access.js';
import { orderScope } from '../../server/orders/scope.js';

let db;
const people = {};
let firm;
let otherFirm;

const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const fileMeta = (n) => ({ storageKey: `2026/09/test${n}.pdf`, name: `cizim-${n}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const ITEM = { glassName: '8mm Temperli', camAdedi: 2 };
const newOrder = async (title = 'Test') => {
  const next = await suggestNextNo(db, firm.id);
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }], files: [fileMeta(`o${next}`)],
  });
};
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
/** "Kontrol Et" ekranının verdiği kanıt: son sürüm (taslak) + bu kullanıcı + o andaki dosyalar için */
const reviewOf = async (orderId, who, now) => {
  const d = await db.drawing.findFirstOrThrow({ where: { orderId }, orderBy: { version: 'desc' }, include: { files: true } });
  return reviewToken({ secret: getEnv().AUTH_SECRET, drawingId: d.id, userId: people[who].id, files: d.files, ...(now ? { now } : {}) });
};
/** Çizimi kontrol edip müşteriye gönderir (ekrandaki akış: Kontrol Et → Müşteriye gönder) */
const send = async (orderId, who = 'drawer', payload = {}) => run(orderId, 'send_drawing', who, { review: await reviewOf(orderId, who), ...payload });

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
  const dup = createGlassOrder(db, { actor: actor(people.cust), firm, title: 'x', requestedNo: taken, suggestedNo: next, items: [ITEM], files: [fileMeta('d1')] });
  assert.equal(await codeOf(dup), 'DUPLICATE_NUMBER');
  const custom = await createGlassOrder(db, { actor: actor(people.cust), firm, title: 'x', requestedNo: 500, suggestedNo: next, items: [ITEM], files: [fileMeta('d2')] });
  assert.deepEqual([custom.orderNo, custom.bumped], ['GLA500', false]);
  assert.equal(await suggestNextNo(db, firm.id), 501);
  // Başka firma aynı numarayı kullanabilir (kodlar farklı)
  const ale = await createGlassOrder(db, { actor: actor(people.other), firm: otherFirm, title: 'x', requestedNo: 500, suggestedNo: 1, items: [ITEM], files: [fileMeta('d3')] });
  assert.equal(ale.orderNo, 'ALE500');
});

dbTest('yeni cam siparişi: tam olarak bir cam tipi — sıfır ve iki cam sunucuda reddedilir, hiçbir şey yazılmaz (karar 85)', async () => {
  const next = await suggestNextNo(db, firm.id);
  const base = { actor: actor(people.cust), firm, title: 'Tek cam', requestedNo: next, suggestedNo: next };
  const before = [await db.order.count(), await db.orderItem.count(), await db.auditLog.count({ where: { action: 'ORDER_CREATE' } })];
  assert.equal(await codeOf(createGlassOrder(db, { ...base, items: [], files: [fileMeta('g0')] })), 'NO_GLASS', 'sıfır cam');
  assert.equal(await codeOf(createGlassOrder(db, { ...base, files: [fileMeta('g0')] })), 'NO_GLASS', 'cam listesi hiç yok');
  const two = [{ glassName: '8mm Temperli', camAdedi: 1 }, { glassName: '10mm Temperli', camAdedi: 1 }];
  assert.equal(await codeOf(createGlassOrder(db, { ...base, items: two, files: [fileMeta('g2')] })), 'ONE_GLASS', 'iki cam');
  assert.deepEqual([await db.order.count(), await db.orderItem.count(), await db.auditLog.count({ where: { action: 'ORDER_CREATE' } })], before, 'reddedilen sipariş iz bırakmaz');
  assert.equal(await suggestNextNo(db, firm.id), next, 'numara harcanmadı');
  const ok = await createGlassOrder(db, { ...base, items: [{ glassName: '8mm Temperli', camAdedi: 7 }], files: [fileMeta('g1')] });
  const saved = await db.order.findUniqueOrThrow({ where: { id: ok.id }, include: { items: true } });
  assert.deepEqual(saved.items.map((i) => [i.glassName, i.camAdedi]), [['8mm Temperli', 7]], 'tam bir cam');
  assert.equal(saved.customerId, firm.id, 'sipariş işlemi yapanın firmasına açılır');
});

dbTest('yeni cam siparişi: tahmini yükleme günü mevcut tek hesaptan (glassLoadingDate) gelir; satış değiştirince kayıt güncellenir', async () => {
  const o = await newOrder('Yükleme günü');
  const saved = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  // Aynı işlev, siparişin oluşturulduğu an ile: formda gösterilen tarih de bu hesaptan gelir
  assert.equal(saved.estimatedShipDate.toISOString(), glassLoadingDate(saved.createdAt, getEnv().APP_TIMEZONE).toISOString());
  assert.equal(saved.estimatedShipDate.getUTCDay(), 5, 'Cuma');
  // Satış / yönetici sonradan değiştirir: tek kayıt (Order.estimatedShipDate) güncellenir, geçmişe yazılır
  await run(o.id, 'send_to_drawing', 'sales');
  const moved = new Date('2026-12-04T12:00:00Z');
  await run(o.id, 'set_ship_date', 'sales', { date: moved });
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).estimatedShipDate.toISOString(), moved.toISOString());
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'SHIP_DATE' } }), 1);
  assert.equal(await codeOf(run(o.id, 'set_ship_date', 'cust', { date: moved })), 'NOT_ALLOWED', 'müşteri tarihi değiştiremez');
});

dbTest('eski çok camlı sipariş: olduğu gibi durur ve iş akışı normal işler; teklif tablosunda birden çok cam satırı olabilir', async () => {
  const o = await newOrder('Eski çok camlı');
  // Kuraldan önce açılmış sipariş gibi: ikinci ve üçüncü cam doğrudan kayıtta
  await db.orderItem.createMany({ data: [{ orderId: o.id, glassName: '10mm Temperli', camAdedi: 4 }, { orderId: o.id, glassName: '6mm Float', camAdedi: 1 }] });
  const glasses = async () => (await db.orderItem.findMany({ where: { orderId: o.id }, orderBy: { camAdedi: 'asc' } })).map((i) => [i.glassName, i.camAdedi]);
  const all = [['6mm Float', 1], ['8mm Temperli', 2], ['10mm Temperli', 4]];
  assert.deepEqual(await glasses(), all);
  await run(o.id, 'no_drawing', 'sales');
  // Satış / yönetici teklif tablosu sınırlanmaz: farklı camlardan birden çok satır
  const lines = [
    { description: '8mm Temperli', poz: 'P1', enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false },
    { description: '10mm Temperli', poz: 'P2', enMm: 800, boyMm: 600, adet: 4, unit: 'm2', unitPrice: '55.00', kind: 'CAM', free: false },
    { description: '6mm Float', poz: 'P3', enMm: 500, boyMm: 500, adet: 1, unit: 'm2', unitPrice: '20.00', kind: 'CAM', free: false },
  ];
  await run(o.id, 'save_offer', 'sales', { lines });
  await run(o.id, 'submit_offer', 'sales', { lines });
  const offer = await db.offer.findFirstOrThrow({ where: { orderId: o.id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  assert.deepEqual(offer.lines.map((l) => [l.description, l.kind]), [['8mm Temperli', 'CAM'], ['10mm Temperli', 'CAM'], ['6mm Float', 'CAM']]);
  assert.equal(offer.status, 'YONETIMDE');
  assert.deepEqual(await glasses(), all, 'sipariş kalemleri değişmedi');
  // AUD-1: satış tutarı geçmiş notuna yazılmaz (geçmişi çizim ve denetimci de görür); tutar denetim kaydında
  const submitted = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, event: 'OFFER_SUBMITTED' } });
  assert.equal(submitted.note, null);
  const trail = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'submit_offer' } } });
  assert.equal(Number(trail.details.amount), Number(offer.amount));
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
  const cncLine = { description: 'CNC', poz: null, enMm: null, boyMm: null, adet: 2, unit: 'adet', unitPrice: '0', kind: 'CNC', free: false };
  // (işlem TEK bir cama aittir — karar 113: işlemli cam satırı tek adettir)
  const noPrice = [{ ...lines[0], adet: 1 }, cncLine];
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
  await send(o.id, 'drawer', { drawingId: v1.result.drawingId });
  // Revizyon: not zorunlu; çizim üstü işaretler yalnızca bu sürümün dosyalarına, doğrulanarak saklanır
  assert.equal(await codeOf(run(o.id, 'request_revision', 'cust', { comment: '', drawingId: v1.result.drawingId })), 'REVISION_COMMENT');
  const v1File = (await db.drawingFile.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } })).id;
  await run(o.id, 'request_revision', 'cust', {
    comment: 'Yükseklik 1100 olsun', drawingId: v1.result.drawingId,
    annotations: JSON.stringify([{ fileId: v1File, page: 1, type: 'pin', x: 0.5, y: 0.25, text: 'burası' }, { fileId: 'baska-dosya', page: 1, type: 'pin', x: 0.1, y: 0.1, text: 'x' }]),
  });
  const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } });
  assert.deepEqual(rev.annotations, [{ id: 'm1', no: 1, fileId: v1File, page: 1, type: 'pin', x: 0.5, y: 0.25, text: 'burası' }], 'başka dosyaya işaret atılır; kalıcı kimlik / numara verilir (P5)');
  assert.equal(rev.comment, 'Yükseklik 1100 olsun');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('v2')] });
  assert.equal(v2.result.version, 2);
  await send(o.id);
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'STALE_DRAWING');
  await run(o.id, 'approve_drawing', 'cust', { drawingId: v2.result.drawingId });
  const drawings = await db.drawing.findMany({ where: { orderId: o.id }, orderBy: { version: 'asc' }, include: { files: true } });
  assert.deepEqual(drawings.map((d) => [d.version, d.status, d.files.length, !!d.sentAt, d.decidedById]),
    [[1, 'REVIZYON_ISTENDI', 1, true, people.cust.id], [2, 'ONAYLANDI', 1, true, people.cust.id]], 'eski sürüm silinmez');
});

dbTest('Paket B (karar 227): müşteri revizyonu — işaretler sürüme ve talebe bağlı saklanır, açıklamaları numaralı nota "#n" ile eklenir; eski sürüme karar verilemez', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('p1')] });
  await send(o.id, 'drawer', { drawingId: v1.result.drawingId });
  const f1 = (await db.drawingFile.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } })).id;
  // Ne madde ne açıklamalı işaret → REVISION_COMMENT
  assert.equal(await codeOf(run(o.id, 'request_revision', 'cust', { items: [''], comment: '', drawingId: v1.result.drawingId, annotations: JSON.stringify([{ fileId: f1, page: 1, type: 'pin', x: 0.1, y: 0.1, text: '' }]) })), 'REVISION_COMMENT');
  // Başka dosyaya konmuş işaret atılır; numara doğrulanmış listedeki sıradır
  await run(o.id, 'request_revision', 'cust', {
    items: ['Ölçü 1100', ''], comment: 'yok sayılır', drawingId: v1.result.drawingId,
    annotations: JSON.stringify([
      { fileId: 'baska', page: 1, type: 'pin', x: 0.2, y: 0.2, text: 'atılır' },
      { fileId: f1, page: 1, type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, text: '' },
      { fileId: f1, page: 2, type: 'free', x: 0.3, y: 0.3, points: [[0.3, 0.3], [0.4, 0.5]], text: 'Bu çizgi düz olsun' },
    ]),
  });
  const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } });
  assert.equal(rev.comment, '1. Ölçü 1100\n2. #2: Bu çizgi düz olsun');
  assert.deepEqual(rev.annotations.map((a) => [a.type, a.page, a.text]), [['rect', 1, ''], ['free', 2, 'Bu çizgi düz olsun']]);
  // Yeni sürüm gönderildikten sonra eski sürüme (bayat sekme) ne onay ne revizyon
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('p2')] });
  await send(o.id, 'drawer', { drawingId: v2.result.drawingId });
  assert.equal(await codeOf(run(o.id, 'request_revision', 'cust', { items: ['eski'], drawingId: v1.result.drawingId })), 'STALE_DRAWING');
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'STALE_DRAWING');
  assert.equal((await db.drawing.findUniqueOrThrow({ where: { id: v2.result.drawingId } })).status, 'ONAY_BEKLIYOR', 'son sürüm etkilenmedi');
  assert.equal(await db.drawingRevision.count({ where: { drawing: { orderId: o.id } } }), 1);
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

  assert.equal(await codeOf(send(o.id)), 'DRAWING_SCAN_PENDING');
  await db.drawingFile.updateMany({ where: { drawingId: d.id, scanStatus: 'PENDING' }, data: { scanStatus: 'CLEAN' } });
  assert.equal(await codeOf(send(o.id)), 'DRAWING_NOT_SCANNED', 'antivirüs kapalıyken yüklenen dosya da gönderilemez');
  const skipped = d.files.find((f) => f.scanStatus === 'SKIPPED');
  const rm = await run(o.id, 'remove_drawing_file', 'drawer', { fileId: skipped.id });
  assert.equal(rm.result.storageKey, skipped.storageKey);
  assert.equal(await codeOf(send(o.id, 'sales')), 'NOT_ALLOWED', 'satış çizim gönderemez');
  await send(o.id);
  d = await db.drawing.findUniqueOrThrow({ where: { id: d.id }, include: { files: true } });
  assert.deepEqual([d.status, d.files.length, d.sentById], ['ONAY_BEKLIYOR', 2, people.drawer.id]);
  assert.equal(await codeOf(run(o.id, 'remove_drawing_file', 'drawer', { fileId: d.files[0].id })), 'NOT_ALLOWED', 'gönderilen sürümün dosyası değişmez');
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'send_drawing' } } });
  assert.equal(audit.actorRole, 'CIZIM');
  assert.equal(audit.details.checked, true, 'kontrol edilerek gönderildiği denetim kaydında');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'DRAWING_UPLOADED' } }), 1);
});

dbTest('çizim gönderimi: "Kontrol Et" kanıtı olmadan gönderilemez (sunucu denetimi); kanıt kişiye, sürüme ve dosyalara bağlıdır', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('k1')] });
  const state = async () => { const x = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { drawings: true } }); return [x.drawingTrack, x.drawings[0].status]; };
  // Doğrudan istek (düğme gizli olsa da): kanıt yok / uydurma / başkasının kanıtı → reddedilir, hiçbir şey değişmez
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer')), 'DRAWING_NOT_CHECKED');
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer', { review: `${Date.now()}.uydurma` })), 'DRAWING_NOT_CHECKED');
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer', { review: await reviewOf(o.id, 'admin') })), 'DRAWING_NOT_CHECKED', 'kontrol eden kişi göndermeli');
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer', { review: await reviewOf(o.id, 'drawer', Date.now() - 3 * 3_600_000) })), 'DRAWING_NOT_CHECKED', 'eski kontrol (2 saatten fazla)');
  // Kontrolden sonra taslağa dosya eklendi → eski kanıt geçmez, yeniden kontrol gerekir
  const before = await reviewOf(o.id, 'drawer');
  await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('k2')] });
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer', { review: before })), 'DRAWING_NOT_CHECKED');
  assert.deepEqual(await state(), ['YAPILIYOR', 'TASLAK']);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'DRAWING_UPLOADED' } }), 0, 'müşteriye bildirim olayı yazılmadı');
  // Müşteri taslağı hiçbir şekilde gönderemez / onaylayamaz
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'cust', { review: await reviewOf(o.id, 'cust') })), 'NOT_ALLOWED');
  await send(o.id);
  assert.deepEqual(await state(), ['ONAY_BEKLIYOR', 'ONAY_BEKLIYOR']);
});

dbTest('çizim gönderimi: müşterinin açabileceği (PDF / JPG / PNG) temiz dosya şart; teknik dosyalar ek olarak kalır', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const tech = (n, ext) => ({ ...fileMeta(n), name: `cizim-${n}.${ext}`, storageKey: `2026/09/test${n}.${ext}`, mime: 'application/octet-stream' });
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [tech('t1', 'dwg'), tech('t2', 'dxf'), tech('t3', 'step')] });
  assert.equal(await codeOf(send(o.id)), 'DRAWING_NO_VIEWABLE', 'yalnızca DWG / DXF / STEP ile gönderilemez');
  assert.equal((await db.drawing.findUniqueOrThrow({ where: { id: v1.result.drawingId } })).status, 'TASLAK');
  // Taranmamış PDF "açılabilir dosya" sayılmaz: önce tarama kuralı devreye girer
  await run(o.id, 'upload_drawing', 'drawer', { files: [{ ...fileMeta('t4'), scanStatus: 'PENDING' }] });
  assert.equal(await codeOf(send(o.id)), 'DRAWING_SCAN_PENDING');
  await db.drawingFile.updateMany({ where: { drawingId: v1.result.drawingId, scanStatus: 'PENDING' }, data: { scanStatus: 'CLEAN' } });
  await send(o.id);
  const d = await db.drawing.findUniqueOrThrow({ where: { id: v1.result.drawingId }, include: { files: true } });
  assert.deepEqual([d.status, d.files.length], ['ONAY_BEKLIYOR', 4], 'teknik ekler sürümde kalır');
  // Görsel de yeterlidir
  await run(o.id, 'request_revision', 'cust', { comment: 'Düzeltin', drawingId: d.id });
  await run(o.id, 'upload_drawing', 'drawer', { files: [tech('t5', 'dwg'), tech('t6', 'PNG')] });
  await send(o.id);
});

dbTest('çizim kararı: onay yetkisi olmayan müşteri kullanıcısı ne onaylayabilir ne revizyon isteyebilir; onay kesindir', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('p1')] });
  await send(o.id);
  const viewer = await db.user.create({ data: { email: `izleyici-${o.customerOrderNo}@test.test`, name: 'İzleyici', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, canApprove: false } });
  people.viewer = viewer;
  const payload = { drawingId: v1.result.drawingId, comment: 'Değiştirin', annotations: '[]' };
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'viewer', payload)), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'request_revision', 'viewer', payload)), 'NOT_ALLOWED', 'revizyon da onay yetkisi ister');
  // Başka firmanın (onay yetkili) müşterisi siparişi hiç bulamaz
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'other', payload)), 'NOT_FOUND');
  assert.equal(await codeOf(run(o.id, 'request_revision', 'other', payload)), 'NOT_FOUND');
  // İç ekip müşteri adına karar veremez
  for (const who of ['admin', 'sales', 'drawer', 'inspector']) {
    assert.equal(await codeOf(run(o.id, 'approve_drawing', who, payload)), 'NOT_ALLOWED', who);
    assert.equal(await codeOf(run(o.id, 'request_revision', who, payload)), 'NOT_ALLOWED', who);
  }
  assert.equal(await db.drawingRevision.count({ where: { drawingId: v1.result.drawingId } }), 0);
  assert.equal((await db.drawing.findUniqueOrThrow({ where: { id: v1.result.drawingId } })).status, 'ONAY_BEKLIYOR');
  // Yetkili kullanıcı onaylar; onay kesindir: yeniden onay, revizyon, geri çekme ve yeni yükleme yok
  await run(o.id, 'approve_drawing', 'cust', payload);
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', payload)), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'request_revision', 'cust', payload)), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'withdraw_drawing', 'drawer', { reason: 'x' })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('p2')] })), 'NOT_ALLOWED');
  const d = await db.drawing.findUniqueOrThrow({ where: { id: v1.result.drawingId } });
  assert.deepEqual([d.status, d.decidedById], ['ONAYLANDI', people.cust.id]);
});

dbTest('çizim sürümleri değişmez: v1 ve revizyon talebi (not + işaretler) v2 / v3 sonrasında aynen durur', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const snap = async (id) => {
    const d = await db.drawing.findUniqueOrThrow({ where: { id }, include: { files: { orderBy: { createdAt: 'asc' } }, revisions: true } });
    return JSON.stringify([d.version, d.status, d.sentAt, d.decidedAt, d.decidedById, d.noteCustomer, d.files.map((f) => [f.id, f.name, f.storageKey, f.checksum]), d.revisions.map((r) => [r.comment, r.annotations])]);
  };
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('i1')], noteCustomer: 'ilk sürüm' });
  await send(o.id);
  const f1 = (await db.drawingFile.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } })).id;
  const marks = [
    { fileId: f1, page: 1, type: 'free', x: 0.2, y: 0.2, points: [[0.2, 0.2], [0.3, 0.25], [0.4, 0.2]], text: 'kenar' },
    { fileId: f1, page: 1, type: 'text', x: 0.6, y: 0.5, text: '1100 mm' },
  ];
  await run(o.id, 'request_revision', 'cust', { comment: 'Ölçü yanlış', drawingId: v1.result.drawingId, annotations: JSON.stringify(marks) });
  const frozen = await snap(v1.result.drawingId);
  assert.deepEqual((await db.drawingRevision.findFirstOrThrow({ where: { drawingId: v1.result.drawingId } })).annotations.map((a) => a.type), ['free', 'text'], 'serbest ve metin işaretleri saklanır');
  // v1'e artık hiçbir işlem dokunamaz
  assert.equal(await codeOf(run(o.id, 'remove_drawing_file', 'drawer', { fileId: f1 })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'NOT_ALLOWED');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('i2')] });
  assert.equal(await codeOf(run(o.id, 'remove_drawing_file', 'drawer', { fileId: f1 })), 'FILE_NOT_FOUND', 'taslak varken de eski sürümün dosyası çıkarılamaz');
  await send(o.id);
  await run(o.id, 'request_revision', 'cust', { comment: 'Bir daha', drawingId: v2.result.drawingId });
  const frozen2 = await snap(v2.result.drawingId);
  const v3 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('i3')] });
  await send(o.id);
  await run(o.id, 'approve_drawing', 'cust', { drawingId: v3.result.drawingId });
  assert.equal(await snap(v1.result.drawingId), frozen, 'v1 değişmedi');
  assert.equal(await snap(v2.result.drawingId), frozen2, 'v2 değişmedi');
  const all = await db.drawing.findMany({ where: { orderId: o.id }, orderBy: { version: 'asc' } });
  assert.deepEqual(all.map((d) => [d.version, d.status]), [[1, 'REVIZYON_ISTENDI'], [2, 'REVIZYON_ISTENDI'], [3, 'ONAYLANDI']]);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).revisionCount, 2);
});

dbTest('çizim: gönderilen sürüm gerekçeyle geri çekilir; müşteri artık onaylayamaz; yeni sürüm açılır', async () => {
  const o = await newOrder();
  await run(o.id, 'send_to_drawing', 'sales');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('w1')] });
  await send(o.id);
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

dbTest('çizim içeriğine erişim (karar 146, AUD-8): müşteri geri çekilen sürümün dosyasını dosya kimliğiyle de eski sürüm kimliğiyle de alamaz, satırını görür; iç roller ve öteki durumlar değişmez', async () => {
  // Gerçek sorgu: /dosya/cizim yolunun kullandığı işlev (findDrawingFile) + rolün sipariş kapsamı (orderScope)
  const get = (who, id) => findDrawingFile(db, { id, scope: orderScope(people[who]), role: people[who].appRole });
  const names = async (who, ids) => Promise.all(ids.map(async (id) => (await get(who, id))?.name ?? null));
  const tech = (n) => ({ ...fileMeta(n), name: `cizim-${n}.dxf`, storageKey: `2026/09/test${n}.dxf`, mime: 'application/octet-stream' });
  const view = async (who, orderId) => drawingsView(people[who].appRole, await db.drawing.findMany({ where: { orderId }, orderBy: { version: 'asc' }, include: { files: { orderBy: { createdAt: 'asc' } } } }));
  const INTERNAL = ['admin', 'sales', 'drawer', 'inspector'];

  const o = await newOrder('Geri çekilen çizim');
  await run(o.id, 'send_to_drawing', 'sales');
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('q1'), tech('q2')], noteCustomer: 'v1 müşteri notu', noteInternal: 'v1 iç not' });
  const d1 = v1.result.drawingId;
  const [f1, f2] = (await db.drawingFile.findMany({ where: { drawingId: d1 }, orderBy: { name: 'asc' } })).map((f) => f.id);

  // TASLAK (değişmedi): müşteriye sürüm de dosya da yok; iç roller alır
  assert.deepEqual(await names('cust', [f1, f2, d1]), [null, null, null]);
  assert.deepEqual(await view('cust', o.id), []);
  for (const who of INTERNAL) assert.deepEqual(await names(who, [f1, f2]), ['cizim-q1.pdf', 'cizim-q2.dxf'], who);

  // Gönderildi (ONAY_BEKLIYOR, değişmedi): müşteri dosyaları ve notu görür — dosya kimliği ve eski sürüm kimliğiyle
  await send(o.id);
  assert.deepEqual(await names('cust', [f1, f2]), ['cizim-q1.pdf', 'cizim-q2.dxf']);
  assert.ok((await get('cust', d1)).name.startsWith('cizim-q'), 'eski bağlantı: sürümün ilk dosyası');
  assert.deepEqual((await view('cust', o.id)).map((d) => [d.status, d.files.length, d.noteCustomer]), [['ONAY_BEKLIYOR', 2, 'v1 müşteri notu']]);
  assert.deepEqual(await names('other', [f1, f2, d1]), [null, null, null], 'başka firmanın müşterisi hiçbir zaman');

  // GERİ ÇEKİLDİ: müşteriye bütün dosya yolları kapanır; satır (durum, gerekçe, tarihler) kalır; dosya adı ve not gelmez
  await run(o.id, 'withdraw_drawing', 'drawer', { reason: 'Yanlış firmanın çizimi' });
  assert.deepEqual(await names('cust', [f1, f2, d1]), [null, null, null]);
  const row = (await view('cust', o.id))[0];
  assert.deepEqual([row.id, row.version, row.status, row.withdrawReason, !!row.withdrawnAt, !!row.sentAt], [d1, 1, 'GERI_CEKILDI', 'Yanlış firmanın çizimi', true, true]);
  assert.deepEqual([row.files, row.noteCustomer, row.fileUrl, row.fileName], [[], null, null, null]);
  const seen = JSON.stringify(await view('cust', o.id));
  for (const leak of ['cizim-q1.pdf', 'cizim-q2.dxf', 'v1 müşteri notu', f1, f2, 'testq1', 'testq2']) assert.equal(seen.includes(leak), false, leak);
  // İç roller (yönetici, satış, çizim, denetimci) geri çekilen sürümü eskisi gibi görür ve dosyalarını alır
  for (const who of INTERNAL) {
    assert.deepEqual(await names(who, [f1, f2]), ['cizim-q1.pdf', 'cizim-q2.dxf'], who);
    assert.ok((await get(who, d1)).name.startsWith('cizim-q'), who);
    const d = (await view(who, o.id))[0];
    assert.deepEqual([d.status, d.files.length, d.noteCustomer], ['GERI_CEKILDI', 2, 'v1 müşteri notu'], who);
  }
  // Kayıt silinmedi / değişmedi: geri çekme yalnızca erişimi kapatır
  assert.equal(await db.drawingFile.count({ where: { drawingId: d1 } }), 2);
  assert.equal((await db.drawing.findUniqueOrThrow({ where: { id: d1 } })).noteCustomer, 'v1 müşteri notu');

  // Yeni sürüm: taslakken kapalı, gönderilince açık; v1 kapalı kalır
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('q3')], noteCustomer: 'v2 müşteri notu' });
  const g1 = (await db.drawingFile.findFirstOrThrow({ where: { drawingId: v2.result.drawingId } })).id;
  assert.deepEqual(await names('cust', [g1, v2.result.drawingId]), [null, null]);
  await send(o.id);
  assert.deepEqual(await names('cust', [g1, v2.result.drawingId, f1, f2, d1]), ['cizim-q3.pdf', 'cizim-q3.pdf', null, null, null]);
  assert.deepEqual((await view('cust', o.id)).map((d) => [d.version, d.status, d.files.length, d.noteCustomer]),
    [[1, 'GERI_CEKILDI', 0, null], [2, 'ONAY_BEKLIYOR', 1, 'v2 müşteri notu']]);
  // Revizyon istenen sürüm (değişmedi): açık kalır; yeni taslak kapalı
  await run(o.id, 'request_revision', 'cust', { comment: 'Düzeltin', drawingId: v2.result.drawingId });
  assert.deepEqual(await names('cust', [g1, f1]), ['cizim-q3.pdf', null]);
  const v3 = await run(o.id, 'upload_drawing', 'drawer', { files: [fileMeta('q4')] });
  const h1 = (await db.drawingFile.findFirstOrThrow({ where: { drawingId: v3.result.drawingId } })).id;
  assert.deepEqual(await names('cust', [h1]), [null]);
  // Onaylanan sürüm (değişmedi): açık
  await send(o.id);
  await run(o.id, 'approve_drawing', 'cust', { drawingId: v3.result.drawingId });
  assert.deepEqual(await names('cust', [h1, g1, f1, f2, d1]), ['cizim-q4.pdf', 'cizim-q3.pdf', null, null, null]);
  assert.deepEqual((await view('cust', o.id)).map((d) => [d.version, d.status, d.files.length]),
    [[1, 'GERI_CEKILDI', 0], [2, 'REVIZYON_ISTENDI', 1], [3, 'ONAYLANDI', 1]]);
});

// Karar 113: CNC / delik TEK bir fiziksel cama aittir — sunucu her teklif kaydında (taslak dahil) denetler
dbTest('işlem sahipliği: adedi 1\'den büyük cama işlem bağlanamaz (satış, yönetici, taslak, güncelleme); ayrılan cam kaynağının fiyatlarını taşır, toplamlar değişmez', async () => {
  const o = await newOrder('İşlem sahipliği');
  await run(o.id, 'no_drawing', 'sales');
  const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', unitPrice: '24.00', kind: 'CAM', free: false, ...extra });
  const hole = (extra = {}) => ({ description: '', poz: null, enMm: null, boyMm: null, adet: 2, unit: 'adet', unitPrice: '3.00', kind: 'DELIK', free: false, ...extra });
  const stored = () => db.offer.findFirstOrThrow({ where: { orderId: o.id }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  const shape = (offer) => offer.lines.map((l) => [l.kind, l.adet, Number(l.unitPrice), l.offerPrice == null ? null : Number(l.offerPrice)]);

  // "5 cam + delik": satış taslak olarak da, gönderirken de kaydedemez; hiçbir şey yazılmaz
  const before = shape(await stored());
  for (const action of ['save_offer', 'submit_offer']) assert.equal(await codeOf(run(o.id, action, 'sales', { lines: [glass(), hole()] })), 'OPS_MULTI_GLASS', action);
  assert.deepEqual(shape(await stored()), before);
  // İşlemsiz camlar adetle durur
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  let offer = await stored();
  assert.deepEqual(shape(offer), [['CAM', 5, 24, null]]);
  const L = offer.lines[0].id;

  // Yönetici: müşteri fiyatı 40; sonra bir cama delik ekler → cam 4 + 1 olarak ayrılır (ayrılan satır kaynağını gösterir).
  // Yöneticinin EKLEDİĞİ olağan satırın maliyeti fiyat tablosundan gelir (burada tablo yok → 0); AYRILAN cam ise aynı
  // camdır: kaynağının kayıtlı maliyetini (24) taşır — tarayıcıdan gelen satış fiyatı (999) kullanılmaz.
  await run(o.id, 'save_offer', 'admin', { lines: [{ ...glass(), id: L, offerPrice: '40.00' }] });
  assert.deepEqual([Number((await stored()).amount), Number((await stored()).offerAmount)], [240, 400]);
  assert.equal(await codeOf(run(o.id, 'save_offer', 'admin', { lines: [{ ...glass(), id: L, offerPrice: '40.00' }, hole({ offerPrice: '5.00' })] })), 'OPS_MULTI_GLASS', 'yönetici de bağlayamaz');
  const split = [
    { ...glass({ adet: 4 }), id: L, offerPrice: '40.00' },
    { ...glass({ adet: 1, unitPrice: '999.00' }), id: null, from: L, offerPrice: '40.00' },
    hole({ id: null, offerPrice: '5.00' }),
  ];
  await run(o.id, 'save_offer', 'admin', { lines: split });
  offer = await stored();
  assert.deepEqual(shape(offer), [['CAM', 4, 24, 40], ['CAM', 1, 24, 40], ['DELIK', 2, 0, 5]], 'ayrılan cam: aynı maliyet ve müşteri fiyatı');
  assert.equal(offer.lines.reduce((s, l) => s + (l.kind === 'CAM' ? l.adet : 0), 0), 5, 'fiziksel cam adedi aynı');
  // Cam tutarları değişmedi: satış 10 m² × 24 = 240, müşteri 10 m² × 40 = 400 (+ delik: müşteri 2 × 5)
  assert.deepEqual([Number(offer.amount), Number(offer.offerAmount)], [240, 410]);
  // Kaynak gösterilmeyen yeni cam satırı olağan yeni satırdır (maliyet tablodan; tablo yok → 0). Başka bir camı kaynak
  // gösteren satır da kaynağın fiyatını ALAMAZ (aynı cam değil).
  const [g4, g1, h] = offer.lines;
  const keep = [{ ...glass({ adet: 4 }), id: g4.id, offerPrice: '40.00' }, { ...glass({ adet: 1 }), id: g1.id, offerPrice: '40.00' }, hole({ id: h.id, offerPrice: '5.00' })];
  await run(o.id, 'save_offer', 'admin', { lines: [...keep, { ...glass({ adet: 1 }), id: null, offerPrice: '40.00' }, { ...glass({ adet: 1, description: 'Başka cam', enMm: 500 }), id: null, from: g4.id, offerPrice: '40.00' }] });
  assert.deepEqual(shape(await stored()).slice(3), [['CAM', 1, 0, 40], ['CAM', 1, 0, 40]]);
  await run(o.id, 'save_offer', 'admin', { lines: keep });

  // Satış da ayırabilir: müşteri fiyatı satış formunda yoktur — ayrılan cam kaynağının müşteri fiyatını taşır
  await run(o.id, 'return_offer', 'admin', { lines: keep, returnNote: 'bir cama daha delik' });
  const sales = [
    { ...glass({ adet: 3 }), id: g4.id }, { ...glass({ adet: 1 }), id: null, from: g4.id }, hole({ id: null, adet: 1 }),
    { ...glass({ adet: 1 }), id: g1.id }, hole({ id: h.id }),
  ];
  await run(o.id, 'submit_offer', 'sales', { lines: sales });
  offer = await stored();
  assert.deepEqual(shape(offer), [['CAM', 3, 24, 40], ['CAM', 1, 24, 40], ['DELIK', 1, 3, null], ['CAM', 1, 24, 40], ['DELIK', 2, 3, 5]]);
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'admin', { lines: offer.lines.map((l) => ({ ...glass(), ...hole(), description: l.description, kind: l.kind, unit: l.unit, enMm: l.enMm, boyMm: l.boyMm, adet: l.kind === 'CAM' ? 5 : l.adet, id: l.id, offerPrice: '40.00' })) })), 'OPS_MULTI_GLASS', 'fiyat onayında da');
  const ok = offer.lines.map((l) => ({ description: l.description, poz: null, kind: l.kind, unit: l.unit, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unitPrice: '0', free: false, id: l.id, offerPrice: l.kind === 'CAM' ? '40.00' : '5.00' }));
  await run(o.id, 'approve_offer', 'admin', { lines: ok });
  // Müşterideki teklifin güncellenmesi (yeni sürüm) de aynı kurala tabidir
  const sent = await stored();
  assert.equal(sent.status, 'GONDERILDI');
  const upd = sent.lines.map((l) => ({ description: l.description, poz: null, kind: l.kind, unit: l.unit, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unitPrice: '0', free: false, id: l.id, offerPrice: String(l.offerPrice) }));
  assert.equal(await codeOf(run(o.id, 'update_offer', 'admin', { lines: upd.map((l, i) => (i === 1 ? { ...l, adet: 2 } : l)) })), 'OPS_MULTI_GLASS');
  assert.equal(await db.offer.count({ where: { orderId: o.id } }), 1, 'yeni sürüm açılmadı');
});

// Karar 114: ayırma (5 → 4 + 1) yalnızca gösterimdir — m² satır başına yuvarlandığında oluşan fark (333 × 1000: 1,67 → 1,66 m²)
// kalemin toplam adedinden hesaplanarak giderildi; sıra (pieceBase) her kayıtta sunucuda hesaplanır
dbTest('ayrılmış cam: toplam m², satış (maliyet) tutarı ve müşteri tutarı ayırmayla değişmez; grup sunucuda doğrulanır, yeni sürüme taşınır', async () => {
  const { offerTotals, atOfferPrice } = await import('../../server/orders/rules.js');
  const o = await newOrder('Ayırma yuvarlaması');
  await run(o.id, 'no_drawing', 'sales');
  const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 333, boyMm: 1000, adet: 5, unit: 'm2', unitPrice: '41.50', kind: 'CAM', free: false, ...extra });
  const hole = (extra = {}) => ({ description: '', poz: null, enMm: null, boyMm: null, adet: 2, unit: 'adet', unitPrice: '3.00', kind: 'DELIK', free: true, ...extra });
  const stored = () => db.offer.findFirstOrThrow({ where: { orderId: o.id }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  const money = (offer) => [Number(offer.amount), Number(offer.offerAmount)];
  const m2 = (offer) => offerTotals(offer.lines).metraj;
  const groups = (offer) => offer.lines.map((l) => [l.kind, l.adet, l.splitGroup, l.pieceBase]);

  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  const L = (await stored()).lines[0].id;
  await run(o.id, 'save_offer', 'admin', { lines: [{ ...glass(), id: L, offerPrice: '66.96' }] });
  const before = await stored();
  // 5 × 0,333 m² = 1,665 → 1,67 m² · satış 1,67 × 41,50 = 69,30 · müşteri 1,67 × 66,96 = 111,82
  assert.deepEqual([m2(before), ...money(before), groups(before)], [1.67, 69.3, 111.82, [['CAM', 5, null, 0]]]);

  // Yönetici bir cama (bedelsiz) delik ekler: ekran camı 4 + 1 olarak ayırır ve iki satıra aynı grup anahtarını verir
  const split = [
    { ...glass({ adet: 4 }), id: L, offerPrice: '66.96', splitGroup: 'grp1' },
    { ...glass({ adet: 1 }), id: null, from: L, offerPrice: '66.96', splitGroup: 'grp1' },
    hole({ id: null, offerPrice: '0.00' }),
  ];
  await run(o.id, 'save_offer', 'admin', { lines: split });
  let offer = await stored();
  assert.deepEqual(groups(offer), [['CAM', 4, 'grp1', 0], ['CAM', 1, 'grp1', 4], ['DELIK', 2, null, 0]]);
  assert.deepEqual([m2(offer), ...money(offer)], [1.67, 69.3, 111.82], 'toplam m², maliyet ve müşteri tutarı ayırmadan önceki gibi');
  assert.equal(offer.lines.reduce((s, l) => s + (l.kind === 'CAM' ? l.adet : 0), 0), 5);
  // Grup bilgisi olmasaydı (eski hesap): 1,33 + 0,33 = 1,66 m² ve tutarlar farklı
  const naive = offer.lines.map((l) => ({ ...l, pieceBase: 0, unitPrice: String(l.unitPrice) }));
  assert.deepEqual([offerTotals(naive).metraj, offerTotals(naive).amount, offerTotals(atOfferPrice(naive)).amount], [1.66, 68.9, 111.16]);

  // Sıra tarayıcıdan ALINMAZ (taklit pieceBase yok sayılır); camı / ölçüsü farklı satır gruba giremez
  const [g4, g1, h] = offer.lines;
  const same = (extra = []) => [
    { ...glass({ adet: 4 }), id: g4.id, offerPrice: '66.96', splitGroup: 'grp1', pieceBase: 77 },
    { ...glass({ adet: 1 }), id: g1.id, offerPrice: '66.96', splitGroup: 'grp1', pieceBase: 99 },
    hole({ id: h.id, offerPrice: '0.00' }), ...extra,
  ];
  await run(o.id, 'save_offer', 'admin', { lines: same([{ ...glass({ adet: 2, enMm: 400 }), id: null, offerPrice: '66.96', splitGroup: 'grp1' }]) });
  offer = await stored();
  assert.deepEqual(groups(offer), [['CAM', 4, 'grp1', 0], ['CAM', 1, 'grp1', 4], ['DELIK', 2, null, 0], ['CAM', 2, null, 0]]);
  await run(o.id, 'save_offer', 'admin', { lines: same() });
  assert.deepEqual([m2(await stored()), ...money(await stored())], [1.67, 69.3, 111.82]);

  // Satış bir cama daha işlem ekler (4 → 3 + 1): toplamlar yine aynı; müşteriye gönderilince ve teklif güncellenince de
  await run(o.id, 'return_offer', 'admin', { lines: same(), returnNote: 'bir cama daha' });
  await run(o.id, 'submit_offer', 'sales', { lines: [
    { ...glass({ adet: 3 }), id: g4.id, splitGroup: 'grp1' }, { ...glass({ adet: 1 }), id: null, from: g4.id, splitGroup: 'grp1' }, hole({ id: null, adet: 1 }),
    { ...glass({ adet: 1 }), id: g1.id, splitGroup: 'grp1' }, hole({ id: h.id }),
  ] });
  offer = await stored();
  assert.deepEqual(groups(offer), [['CAM', 3, 'grp1', 0], ['CAM', 1, 'grp1', 3], ['DELIK', 1, null, 0], ['CAM', 1, 'grp1', 4], ['DELIK', 2, null, 0]]);
  assert.deepEqual([m2(offer), ...money(offer)], [1.67, 69.3, 111.82]);
  const form = (lines) => lines.map((l) => ({ description: l.description, poz: null, kind: l.kind, unit: l.unit, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unitPrice: '0', free: l.free, id: l.id, splitGroup: l.splitGroup, offerPrice: l.free ? '0.00' : String(l.offerPrice) }));
  await run(o.id, 'approve_offer', 'admin', { lines: form(offer.lines) });
  let sent = await stored();
  assert.deepEqual([sent.status, m2(sent), ...money(sent)], ['GONDERILDI', 1.67, 69.3, 111.82]);
  await run(o.id, 'update_offer', 'admin', { lines: form(sent.lines), note: 'aynı' });
  sent = await stored();
  assert.equal(await db.offer.count({ where: { orderId: o.id } }), 2);
  assert.deepEqual(groups(sent), [['CAM', 3, 'grp1', 0], ['CAM', 1, 'grp1', 3], ['DELIK', 1, null, 0], ['CAM', 1, 'grp1', 4], ['DELIK', 2, null, 0]], 'grup yeni sürüme taşınır');
  assert.deepEqual([m2(sent), ...money(sent)], [1.67, 69.3, 111.82]);
});
