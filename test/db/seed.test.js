import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { runBaseSeed } from '../../prisma/seed/base.mjs';
import { ROLES } from '../../prisma/seed/data/roles.js';

let db;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
});
after(closeDb);

const snapshot = async () =>
  (await db.role.findMany({ include: { permissions: true }, orderBy: { name: 'asc' } }))
    .map((r) => [r.name, r.permissions.map((p) => p.key).sort()]);

const expected = ROLES.map((r) => [r.code, [...r.permissions].sort()]).sort((a, b) => a[0].localeCompare(b[0]));

dbTest('temel seed: roller ve yetkiler kurulur', async () => {
  await runBaseSeed(db, { log: () => {} });
  assert.deepEqual(await snapshot(), expected);
});

dbTest('temel seed: tekrar çalıştırılabilir ve elle eklenen fazla yetkiyi geri alır', async () => {
  await runBaseSeed(db, { log: () => {} });
  const inspector = await db.role.findUniqueOrThrow({ where: { name: 'DENETIMCI' } });
  await db.rolePermission.create({ data: { roleId: inspector.id, key: 'PRICE_SET' } });
  await runBaseSeed(db, { log: () => {} });
  assert.deepEqual(await snapshot(), expected);
  assert.equal(await db.role.count(), ROLES.length);
});
