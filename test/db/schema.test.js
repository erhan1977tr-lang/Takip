import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

let db;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
});
after(closeDb);

dbTest('şema: sipariş numarası ve firma ön eki veritabanında benzersiz', async () => {
  const firm = await db.customer.create({ data: { name: 'Test Firma', prefix: 'TST' } });
  await assert.rejects(db.customer.create({ data: { name: 'Başka Firma', prefix: 'TST' } }), { code: 'P2002' });
  const user = await db.user.create({ data: { type: 'CUSTOMER', name: 'T', email: 'm@tst.test', appRole: 'MUSTERI', customerId: firm.id } });
  const data = { orderNo: 'TST1', customerOrderNo: 1, title: 'x', customerId: firm.id, createdById: user.id };
  await db.order.create({ data });
  await assert.rejects(db.order.create({ data }), { code: 'P2002' });
  await assert.rejects(db.order.create({ data: { ...data, customerOrderNo: 2 } }), { code: 'P2002' }); // aynı orderNo
});

dbTest('şema: tüm migration\'lar uygulanmış', async () => {
  const pending = await db.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL`;
  assert.deepEqual(pending, []);
});
