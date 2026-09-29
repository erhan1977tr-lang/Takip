// Sandıklar yükleme sekmesinde: müşteri + gün bazında kayıt, gün içinde tek numara, eski düzenin taşınması.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { saveDayCrates, validateCrates } from '../../server/loading/crates.js';
import { cratesStep } from '../../prisma/seed/steps/crates.mjs';
import { runOrderAction } from '../../server/orders/transitions.js';

let db;
let a;
let b;
let sales;
const DAY = '2027-05-10';
const ship = new Date('2027-05-10T09:00:00Z');
const orders = {};
const actor = () => ({ id: sales.id, role: 'SATIS', ip: '127.0.0.1' });
const rows = (list) => {
  const v = validateCrates(list);
  assert.equal(v.ok, true);
  return v.rows;
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  a = await db.customer.create({ data: { name: 'Alfa Cam', prefix: 'ALF' } });
  b = await db.customer.create({ data: { name: 'Beta Cam', prefix: 'BET' } });
  sales = await db.user.create({ data: { email: 's@crate.test', name: 'Satış', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id } });
  const cust = await db.user.create({ data: { email: 'c@crate.test', name: 'M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: a.id } });
  const mk = (key, firm, no, extra = {}) => db.order.create({
    data: { orderNo: `${firm.prefix}${no}`, customerOrderNo: no, customerId: firm.id, createdById: cust.id, status: 'URETIMDE', estimatedShipDate: ship, ...extra },
  }).then((o) => { orders[key] = o; });
  await mk('a1', a, 1);
  await mk('a2', a, 2);
  await mk('b1', b, 1);
  await mk('aOther', a, 3, { estimatedShipDate: new Date('2027-05-20T09:00:00Z') });
});
after(closeDb);

dbTest('sandık: müşteri + gün için kaydedilir; siparişler seçilir; denetim ve geçmiş yazılır', async () => {
  const r = await saveDayCrates(db, {
    day: DAY, customerId: a.id, actor: actor(),
    rows: rows([
      { crateNo: '15', lengthMm: '2700', widthMm: '541', heightMm: '1182', netKg: '1275', grossKg: '1335', orderIds: [orders.a1.id] },
      { crateNo: '16', netKg: '1043', orderIds: [orders.a1.id, orders.a2.id] },
    ]),
  });
  assert.deepEqual(r, { ok: true, count: 2 });
  const crates = await db.crate.findMany({ where: { customerId: a.id }, include: { orders: true }, orderBy: { crateNo: 'asc' } });
  assert.deepEqual(crates.map((c) => [c.crateNo, c.shipDay.toISOString().slice(0, 10), c.lengthMm, Number(c.netAgirlik), c.orders.length, c.updatedById]),
    [[15, DAY, 2700, 1275, 1, sales.id], [16, DAY, null, 1043, 2, sales.id]]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CRATES_SAVE', entityId: a.id } });
  assert.deepEqual([audit.details.day, audit.details.before.length, audit.details.after.length, audit.actorRole], [DAY, 0, 2, 'SATIS']);
  assert.equal(await db.orderEvent.count({ where: { event: 'CRATES', orderId: { in: [orders.a1.id, orders.a2.id] } } }), 2);
  assert.equal(await db.orderEvent.count({ where: { event: 'CRATES', orderId: orders.aOther.id } }), 0, 'başka günün siparişi etkilenmez');
});

dbTest('sandık: numara o gün başka müşteride kullanılıyorsa kaydedilmez; başka müşterinin siparişi seçilemez', async () => {
  assert.deepEqual(
    await saveDayCrates(db, { day: DAY, customerId: b.id, actor: actor(), rows: rows([{ crateNo: '16' }, { crateNo: '17' }]) }),
    { ok: false, code: 'NUMBER_TAKEN', numbers: [16] },
  );
  assert.deepEqual(
    await saveDayCrates(db, { day: DAY, customerId: b.id, actor: actor(), rows: rows([{ crateNo: '17', orderIds: [orders.a1.id] }]) }),
    { ok: false, code: 'BAD_ORDER' },
  );
  // Tek siparişli günde sandık kendiliğinden o siparişe bağlanır
  assert.deepEqual(await saveDayCrates(db, { day: DAY, customerId: b.id, actor: actor(), rows: rows([{ crateNo: '17' }]) }), { ok: true, count: 1 });
  const c = await db.crate.findFirstOrThrow({ where: { customerId: b.id }, include: { orders: true } });
  assert.deepEqual(c.orders.map((o) => o.orderId), [orders.b1.id]);
  assert.deepEqual(
    await saveDayCrates(db, { day: '2027-06-01', customerId: b.id, actor: actor(), rows: rows([{ crateNo: '1' }]) }),
    { ok: false, code: 'NO_ORDERS' },
  );
});

dbTest('sandık: kayıt tümünü değiştirir (silinen satır silinir)', async () => {
  await saveDayCrates(db, { day: DAY, customerId: a.id, actor: actor(), rows: rows([{ crateNo: '15', netKg: '1000' }]) });
  assert.deepEqual((await db.crate.findMany({ where: { customerId: a.id } })).map((c) => c.crateNo), [15]);
  assert.equal(await db.crateOrder.count({ where: { crate: { customerId: a.id } } }), 0, 'iki siparişli günde seçim yapılmadıysa bağlantı yok');
});

dbTest('sandık: eski düzendeki (sipariş başına) sandıklar yükleme gününe taşınır; numara çakışırsa kayar', async () => {
  await db.crate.create({ data: { orderId: orders.a2.id, crateNo: 15, dimensions: '2400×1600×900', netAgirlik: 190 } });
  await db.crate.create({ data: { orderId: orders.aOther.id, crateNo: 1 } });
  const summary = await cratesStep.run(db);
  assert.equal(summary, '2 sandık taşındı');
  const moved = await db.crate.findMany({ where: { note: '2400×1600×900' }, include: { orders: true } });
  assert.equal(moved.length, 1);
  assert.deepEqual([moved[0].crateNo, moved[0].orderId, moved[0].customerId, moved[0].shipDay.toISOString().slice(0, 10), moved[0].orders[0].orderId],
    [16, null, a.id, DAY, orders.a2.id], 'o gün 15 ve 17 dolu → ilk boş numara 16');
  assert.equal(await cratesStep.run(db), '0 sandık taşındı', 'tekrar çalıştırılabilir');
});

dbTest('sandık: siparişin yükleme günü değişince sandıkları da yeni güne taşınır (numara doluysa kayar)', async () => {
  const D2 = '2027-07-01';
  const D3 = '2027-07-08';
  const at = new Date(`${D2}T09:00:00Z`);
  const c1 = await db.order.update({ where: { id: orders.a1.id }, data: { estimatedShipDate: at } });
  const c2 = await db.order.update({ where: { id: orders.a2.id }, data: { estimatedShipDate: at } });
  await db.order.update({ where: { id: orders.b1.id }, data: { estimatedShipDate: new Date(`${D3}T09:00:00Z`) } });
  await saveDayCrates(db, { day: D3, customerId: b.id, actor: actor(), rows: rows([{ crateNo: '5' }]) });
  await saveDayCrates(db, {
    day: D2, customerId: a.id, actor: actor(),
    rows: rows([{ crateNo: '5', orderIds: [c1.id] }, { crateNo: '6', orderIds: [c1.id, c2.id] }, { crateNo: '7' }]),
  });
  const move = (orderId, day) => runOrderAction(db, {
    orderId, action: 'set_ship_date', actor: { id: sales.id, role: 'SATIS', canApprove: false, customerId: sales.customerId, ip: '127.0.0.1' },
    payload: { date: new Date(`${day}T09:00:00Z`) },
  });
  const state = async () => (await db.crate.findMany({ where: { customerId: a.id, shipDay: { in: [new Date(`${D2}T00:00:00Z`), new Date(`${D3}T00:00:00Z`)] } }, include: { orders: true }, orderBy: [{ shipDay: 'asc' }, { crateNo: 'asc' }] }))
    .map((c) => [c.shipDay.toISOString().slice(0, 10), c.crateNo, c.orders.map((o) => (o.orderId === c1.id ? 'c1' : 'c2')).sort().join('+')]);

  // c1 taşınır: yalnız c1'i taşıyan 5 → yeni günde 5 dolu (Beta) → 6; ortak 6 kalır, c1 bağı kalkar; belirsiz 7 kalır (c2 hâlâ orada)
  await move(c1.id, D3);
  assert.deepEqual(await state(), [[D2, 6, 'c2'], [D2, 7, ''], [D3, 6, 'c1']]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CRATES_MOVE', entityId: c1.id } });
  assert.deepEqual([audit.details.moved, audit.details.unlinked], [[{ from: 5, to: 6 }], [6]]);

  // c2 de taşınır: 6 (artık yalnız c2) → 7; eski günde sipariş kalmadığı için belirsiz 7 de → 8
  await move(c2.id, D3);
  assert.deepEqual(await state(), [[D3, 6, 'c1'], [D3, 7, 'c2'], [D3, 8, '']]);
  assert.equal(await db.crate.count({ where: { customerId: b.id, shipDay: new Date(`${D3}T00:00:00Z`), crateNo: 5 } }), 1, 'başka müşterinin sandığına dokunulmaz');
});
