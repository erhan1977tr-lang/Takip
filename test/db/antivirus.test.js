import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-av-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { getAvSettings, saveAvSettings, scanPending } = await import('../../server/files/antivirus.js');

let db;
let order;
let admin;
const put = (key, content = '%PDF-1.4 test') => {
  const full = path.join(UPLOAD, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const firm = await db.customer.create({ data: { name: 'Virus Test', prefix: 'VIR' } });
  admin = await db.user.create({ data: { email: 'yonetici@av.test', name: 'Y', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  const cust = await db.user.create({ data: { email: 'm@av.test', name: 'M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id } });
  order = await db.order.create({ data: { orderNo: 'VIR1', customerOrderNo: 1, customerId: firm.id, createdById: cust.id } });
  const file = (name, key, scanStatus = 'PENDING') => ({ name, storageKey: key, size: 10, uploadedById: cust.id, orderId: order.id, scanStatus });
  put('2026/09/temiz.pdf');
  put('2026/09/virus.pdf');
  await db.orderFile.createMany({
    data: [
      file('temiz.pdf', '2026/09/temiz.pdf'),
      file('virus.pdf', '2026/09/virus.pdf'),
      file('kayip.pdf', '2026/09/kayip.pdf'), // diskte yok
      file('eski.pdf', '2026/09/eski.pdf', 'CLEAN'),
    ],
  });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

const av = { enabled: true, host: 'x', port: 1, onUnavailable: 'accept', timeoutMs: 1000 };

dbTest('antivirüs: tarayıcı kapalıyken bekleyen dosyalara dokunulmaz (sonra yeniden denenir)', async () => {
  const r = await scanPending(db, av, { scan: async () => ({ status: 'error', error: 'ECONNREFUSED' }) });
  assert.equal(r.stopped, 'ECONNREFUSED');
  assert.equal(await db.orderFile.count({ where: { scanStatus: 'PENDING' } }), 3);
});

dbTest('antivirüs: bekleyenler taranır; virüslü dosya karantinaya alınır, kayda ve kuyruğa yazılır', async () => {
  const fake = async (file) => {
    if (!fs.existsSync(file)) return { status: 'error', error: `ENOENT: ${file}` };
    return file.endsWith('virus.pdf') ? { status: 'infected', signature: 'Eicar-Test-Signature' } : { status: 'clean' };
  };
  const r = await scanPending(db, av, { scan: fake });
  assert.deepEqual([r.scanned, r.clean, r.infected, r.missing, r.stopped], [2, 1, 1, 1, null]);
  const byName = Object.fromEntries((await db.orderFile.findMany()).map((f) => [f.name, f]));
  assert.equal(byName['temiz.pdf'].scanStatus, 'CLEAN');
  assert.equal(byName['virus.pdf'].scanStatus, 'INFECTED');
  assert.equal(byName['virus.pdf'].scanSignature, 'Eicar-Test-Signature');
  assert.equal(byName['kayip.pdf'].scanStatus, 'SKIPPED');
  assert.equal(byName['eski.pdf'].scanStatus, 'CLEAN', 'taranmış dosyaya dokunulmaz');
  assert.ok(!fs.existsSync(path.join(UPLOAD, '2026/09/virus.pdf')), 'virüslü dosya yerinden kaldırıldı');
  assert.ok(fs.existsSync(path.join(UPLOAD, '.karantina', '2026_09_virus.pdf')), 'karantinada');
  assert.equal(await db.auditLog.count({ where: { action: 'FILE_INFECTED', entityId: byName['virus.pdf'].id } }), 1);
  assert.equal(await db.notificationOutbox.count({ where: { type: 'FILE_INFECTED', orderId: order.id } }), 1);
});

dbTest('antivirüs: ayar kaydı denetime önce/sonra değerleriyle yazılır; kapalıysa tarama yapılmaz', async () => {
  delete process.env.CLAMAV_HOST;
  resetEnvCache();
  assert.equal((await getAvSettings(db)).enabled, false, 'adres tanımlı değilse varsayılan kapalı');
  await saveAvSettings(db, { enabled: true, host: 'clamav', port: 3310, onUnavailable: 'reject' }, { id: admin.id, role: 'ADMIN', ip: '1.2.3.4' });
  const s = await getAvSettings(db);
  assert.deepEqual([s.enabled, s.host, s.port, s.onUnavailable, s.fromDb], [true, 'clamav', 3310, 'reject', true]);
  const a = await db.auditLog.findFirstOrThrow({ where: { action: 'SETTINGS_UPDATE', entityId: 'antivirus' } });
  assert.deepEqual([a.actorRole, a.ip, a.details.after.onUnavailable, a.details.before], ['ADMIN', '1.2.3.4', 'reject', null]);
  const off = await scanPending(db, { ...s, enabled: false });
  assert.equal(off.stopped, 'disabled');
});
