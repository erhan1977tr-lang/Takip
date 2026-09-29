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

const appendOnly = /append-only/;

dbTest('denetim kaydı: eklenebilir, güncellenemez', async () => {
  const row = await db.auditLog.create({ data: { action: 'TEST', entityType: 'System' } });
  await assert.rejects(db.auditLog.update({ where: { id: row.id }, data: { action: 'DEGISTI' } }), appendOnly);
  await assert.rejects(db.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'X'`), appendOnly);
  assert.equal((await db.auditLog.findUnique({ where: { id: row.id } })).action, 'TEST');
});

dbTest('denetim kaydı: silinemez, TRUNCATE edilemez', async () => {
  const row = await db.auditLog.create({ data: { action: 'TEST', entityType: 'System' } });
  await assert.rejects(db.auditLog.delete({ where: { id: row.id } }), appendOnly);
  await assert.rejects(db.auditLog.deleteMany({}), appendOnly);
  await assert.rejects(db.$executeRawUnsafe(`TRUNCATE "AuditLog"`), appendOnly);
  assert.ok(await db.auditLog.findUnique({ where: { id: row.id } }));
});

dbTest('denetim kaydı: kaydı olan kullanıcı silinemez (kullanıcılar pasifleştirilir)', async () => {
  const user = await db.user.create({ data: { type: 'INTERNAL', name: 'Test', email: `t${Date.now()}@ornek.test`, appRole: 'SATIS' } });
  await db.auditLog.create({ data: { action: 'USER_LOGIN', entityType: 'User', entityId: user.id, userId: user.id } });
  await assert.rejects(db.user.delete({ where: { id: user.id } }));
});

dbTest('denetim kaydı: bakım anahtarı yalnızca kendi işleminde geçerli', async () => {
  await db.auditLog.create({ data: { action: 'TEST', entityType: 'System' } });
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL takip.audit_maintenance = 'on'`),
    db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE action = 'TEST'`),
  ]);
  assert.equal(await db.auditLog.count({ where: { action: 'TEST' } }), 0);
  // işlem bitti → anahtar kapandı
  await db.auditLog.create({ data: { action: 'TEST', entityType: 'System' } });
  await assert.rejects(db.auditLog.deleteMany({ where: { action: 'TEST' } }), appendOnly);
});
