import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeDb, dbTest, getDb, resetDb, TEST_URL } from './helpers.js';

const MIGRATION = new URL('../../prisma/migrations/20260929120000_firm_code_3_letters/migration.sql', import.meta.url).pathname;

let db;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
});
after(closeDb);

dbTest('firma kodu: veritabanı yalnızca 3 büyük harfe izin verir', async () => {
  await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  await db.customer.create({ data: { name: 'Fabrika', type: 'FACTORY' } }); // fabrikanın kodu yok
  for (const bad of ['GL', 'GLAS', 'GL1', 'gla', 'ĞLA']) {
    await assert.rejects(db.customer.create({ data: { name: `Kötü ${bad}`, prefix: bad } }), /Customer_prefix_3_letters|check constraint/i, bad);
  }
});

dbTest('firma kodu: eski kodlar 3 harfe taşınır, sipariş numaraları da güncellenir', async () => {
  await resetDb(db);
  await db.$executeRawUnsafe('ALTER TABLE "Customer" DROP CONSTRAINT "Customer_prefix_3_letters"');
  const mk = (name, prefix) => db.customer.create({ data: { name, prefix } });
  const mir = await mk('Mir Glass', 'MIR');
  const mirela = await mk('Mirela Construct', 'MIRELA');
  const ab = await mk('AB Cam', 'AB');
  const mixed = await mk('X1 Y2', 'X1Y2');
  const user = await db.user.create({ data: { type: 'CUSTOMER', name: 'U', email: 'u@kod.test', appRole: 'MUSTERI', customerId: mirela.id } });
  const order = (customerId, prefix, n) => db.order.create({ data: { orderNo: `${prefix}${n}`, customerOrderNo: n, customerId, createdById: user.id } });
  await order(mir.id, 'MIR', 5);
  await order(mirela.id, 'MIRELA', 12);
  await order(ab.id, 'AB', 3);

  // Migration dosyasının kendisi çalıştırılır (psql ile; DO bloğu birden çok ifade içerir)
  execFileSync('psql', [TEST_URL.split('?')[0], '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], { stdio: 'pipe' });

  const code = async (id) => (await db.customer.findUniqueOrThrow({ where: { id } })).prefix;
  assert.equal(await code(mir.id), 'MIR', 'geçerli kod değişmez');
  assert.equal(await code(mirela.id), 'MIA', 'MIR dolu → üçüncü harf A');
  assert.equal(await code(ab.id), 'ABX', 'kısa kod X ile tamamlanır');
  assert.equal(await code(mixed.id), 'XYX', 'rakamlar atılır');
  const nos = (await db.order.findMany({ orderBy: { orderNo: 'asc' } })).map((o) => o.orderNo);
  assert.deepEqual(nos, ['ABX3', 'MIA12', 'MIR5']);
  await assert.rejects(db.customer.create({ data: { name: 'Yine kötü', prefix: 'AB' } }), /Customer_prefix_3_letters|check constraint/i);
});
