// P7 sertleştirme (karar 248), gerçek PostgreSQL: iptal / kaldırılmış siparişin misafir sandık bağı nakliye listesine
// girmez (AUD-15); bekleyen telafi uyarısı "Gördüm" ile kapanmaz (AUD-17). Ağ yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { transportList } = await import('../../server/loading/transport.js');
const { resolveAlert } = await import('../../server/pricing/alerts.js');

let db, admin;
const X = '2031-03-05';
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@p7.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
});
after(closeDb);

const order = (f, no, data = {}) => db.order.create({
  data: { orderNo: `${f.prefix}${no}`, customerOrderNo: no, title: `P${no}`, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: new Date(`${X}T12:00:00Z`), ...data },
});

dbTest('AUD-15: iptal edilen ya da kaldırılan misafir sipariş ev sahibinin sandığında listelenmez; etkin olan listelenir', offline(async () => {
  const A = await db.customer.create({ data: { name: 'Misafir A SRL', prefix: 'MSA' } });
  const B = await db.customer.create({ data: { name: 'Ev Sahibi B SRL', prefix: 'EVB' } });
  const a1 = await order(A, 1, { guestHostId: B.id });
  const a2 = await order(A, 2, { guestHostId: B.id });
  const b1 = await order(B, 1);
  const crate = await db.crate.create({ data: { shipDay: new Date(`${X}T00:00:00Z`), customerId: B.id, crateNo: 9, netAgirlik: '200', brutAgirlik: '250' } });
  for (const o of [a1, a2, b1]) await db.crateOrder.create({ data: { crateId: crate.id, orderId: o.id } });
  const guests = async () => (await transportList(db, X)).groups.flatMap((g) => g.crates.flatMap((c) => c.guests.map((x) => x.orderNo))).sort();
  assert.deepEqual(await guests(), [a1.orderNo, a2.orderNo].sort());
  await db.order.update({ where: { id: a1.id }, data: { status: 'IPTAL' } });
  await db.order.update({ where: { id: a2.id }, data: { removedAt: new Date(), removedStatus: 'URETIMDE', status: 'IPTAL' } });
  assert.deepEqual(await guests(), []);
  // Kayıtlar silinmez (yalnızca gösterilmez)
  assert.equal(await db.crateOrder.count({ where: { crateId: crate.id } }), 3);
}));

dbTest('AUD-17: bekleyen telafi uyarısı (COMPENSATION_PENDING) ve belirsiz FGO uyarısı "Gördüm" ile kapanmaz; sıradan uyarı kapanır', offline(async () => {
  const mk = (type) => db.adminAlert.create({ data: { type, details: {} } });
  const pending = await mk('COMPENSATION_PENDING');
  const uncertain = await mk('FGO_UNCERTAIN');
  const normal = await mk('PRICE_OVERRIDE');
  const actor = { id: admin.id, role: 'ADMIN', ip: '127.0.0.1' };
  assert.equal(await resolveAlert(db, pending.id, actor), false);
  assert.equal(await resolveAlert(db, uncertain.id, actor), false);
  assert.equal(await resolveAlert(db, normal.id, actor), true);
  assert.equal((await db.adminAlert.findUnique({ where: { id: pending.id } })).resolvedAt, null);
}));
