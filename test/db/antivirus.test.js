import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';
import { eicar } from '../../server/files/clamav.js';

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
  const r = await scanPending(db, av, { scan: async () => ({ status: 'error', error: 'unreachable' }) });
  assert.equal(r.stopped, 'unreachable');
  assert.equal(await db.orderFile.count({ where: { scanStatus: 'PENDING' } }), 3);
  // Ham hata metni (eski biçim) sabit koda çevrilir: adres / ağ hatası metni sonuca, günlüğe çıkmaz (karar 150)
  const logs = [];
  const raw = await scanPending(db, av, { scan: async () => ({ status: 'error', error: 'ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:3310' }), log: (m) => logs.push(m) });
  assert.equal(raw.stopped, 'scanner-error');
  assert.equal(/ECONN|10\.0\.0\.5/.test(JSON.stringify([raw, logs])), false);
  assert.equal(await db.orderFile.count({ where: { scanStatus: 'PENDING' } }), 3);
});

dbTest('antivirüs: bekleyenler taranır; virüslü dosya karantinaya alınır, kayda ve kuyruğa yazılır', async () => {
  const fake = async (file) => {
    if (!fs.existsSync(file)) return { status: 'error', error: 'file-not-found' };
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
  // Adres / port gönderilse de saklanmaz; hedef sunucu ayarındandır (tanımlı değilse varsayılan clamav:3310) — karar 150
  await saveAvSettings(db, { enabled: true, host: 'kötü.example', port: 4444, onUnavailable: 'reject' }, { id: admin.id, role: 'ADMIN', ip: '1.2.3.4' });
  const s = await getAvSettings(db);
  assert.deepEqual([s.enabled, s.host, s.port, s.onUnavailable, s.fromDb], [true, 'clamav', 3310, 'reject', true]);
  assert.deepEqual((await db.integrationSetting.findUniqueOrThrow({ where: { key: 'antivirus' } })).value, { enabled: true, onUnavailable: 'reject' });
  const a = await db.auditLog.findFirstOrThrow({ where: { action: 'SETTINGS_UPDATE', entityId: 'antivirus' } });
  assert.deepEqual([a.actorRole, a.ip, a.details.after, a.details.before], ['ADMIN', '1.2.3.4', { enabled: true, onUnavailable: 'reject' }, null]);
  const off = await scanPending(db, { ...s, enabled: false });
  assert.equal(off.stopped, 'disabled');
});

// ───────────── karar 150 (AUD-12): tarayıcının adresi yalnızca sunucu ayarından ─────────────

/** 127.0.0.1'de sahte tarayıcı: bağlantıları sayar. honest: gerçek clamd gibi (EICAR → FOUND); değilse her şeye "temiz" der */
function fakeClamd(honest) {
  return new Promise((resolve) => {
    const s = { connections: 0, port: 0, socks: new Set(), server: null };
    s.server = net.createServer((sock) => {
      s.connections += 1;
      s.socks.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => s.socks.delete(sock));
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const text = buf.toString('latin1');
        if (text.startsWith('zPING\0')) return sock.end('PONG\0');
        if (!text.startsWith('zINSTREAM\0')) return;
        let i = 'zINSTREAM\0'.length;
        const body = [];
        while (i + 4 <= buf.length) {
          const n = buf.readUInt32BE(i);
          if (n === 0) return sock.end(honest && Buffer.concat(body).toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
          if (i + 4 + n > buf.length) return;
          body.push(buf.subarray(i + 4, i + 4 + n));
          i += 4 + n;
        }
      });
    });
    s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; resolve(s); });
  });
}
const closeFake = (s) => new Promise((r) => { for (const k of s.socks) k.destroy(); s.server.close(() => r()); });

dbTest('antivirüs: veritabanında kalmış eski adres / port kullanılmaz — yükleme sonrası tarama (işçi) sunucu ayarındaki tarayıcıya gider; kayıt sonrası da öyle', offline(async () => {
  const real = await fakeClamd(true); // sunucu ayarındaki tarayıcı
  const trap = await fakeClamd(false); // veritabanında kalmış adres: bağlanılırsa her dosyaya "temiz" der
  const saved = { host: process.env.CLAMAV_HOST, port: process.env.CLAMAV_PORT };
  try {
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(real.port);
    resetEnvCache();
    // Eski sürümden kalma kayıt: adres ve port veritabanında
    const legacy = { enabled: true, host: '127.0.0.1', port: trap.port, onUnavailable: 'accept' };
    await db.integrationSetting.upsert({ where: { key: 'antivirus' }, create: { key: 'antivirus', value: legacy }, update: { value: legacy } });
    const s = await getAvSettings(db);
    assert.deepEqual([s.enabled, s.host, s.port, s.onUnavailable, s.fromDb], [true, '127.0.0.1', real.port, 'accept', true]);
    assert.deepEqual((await db.integrationSetting.findUniqueOrThrow({ where: { key: 'antivirus' } })).value, legacy, 'okumak kaydı değiştirmez (taşıma / geri doldurma yok)');

    // İşçinin yaptığı: ayarı oku → bekleyenleri GERÇEK istemciyle tara
    const cust = await db.user.findFirstOrThrow({ where: { email: 'm@av.test' } });
    put('2026/10/aud12-temiz.pdf', Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(70_000, 0x20)]));
    put('2026/10/aud12-virus.pdf', Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(70_000, 0x20), eicar()]));
    await db.orderFile.createMany({
      data: ['aud12-temiz.pdf', 'aud12-virus.pdf', 'aud12-kayip.pdf'].map((name) => ({ name, storageKey: `2026/10/${name}`, size: 10, uploadedById: cust.id, orderId: order.id, scanStatus: 'PENDING' })),
    });
    const r = await scanPending(db, await getAvSettings(db));
    assert.deepEqual([r.scanned, r.clean, r.infected, r.missing, r.stopped], [2, 1, 1, 1, null]);
    const byName = Object.fromEntries((await db.orderFile.findMany({ where: { name: { startsWith: 'aud12-' } } })).map((f) => [f.name, f]));
    assert.deepEqual(['aud12-temiz.pdf', 'aud12-virus.pdf', 'aud12-kayip.pdf'].map((n) => byName[n].scanStatus), ['CLEAN', 'INFECTED', 'SKIPPED']);
    assert.equal(byName['aud12-virus.pdf'].scanSignature, 'Win.Test.EICAR_HDB-1');
    assert.ok(fs.existsSync(path.join(UPLOAD, '.karantina', '2026_10_aud12-virus.pdf')), 'virüslü dosya karantinada');
    assert.equal(real.connections, 2, 'dosyası olmayan kayıt için tarayıcıya bağlanılmaz');
    assert.equal(trap.connections, 0, 'veritabanındaki adrese HİÇ bağlanılmadı');

    // Elle hazırlanmış kayıt isteği (adres / port ile): saklanmaz, eski değerler de satırdan kalkar; hedef değişmez
    await saveAvSettings(db, { enabled: true, host: '127.0.0.1', port: trap.port, onUnavailable: 'reject' }, { id: admin.id, role: 'ADMIN', ip: '1.2.3.4' });
    assert.deepEqual((await db.integrationSetting.findUniqueOrThrow({ where: { key: 'antivirus' } })).value, { enabled: true, onUnavailable: 'reject' });
    const after = await getAvSettings(db);
    assert.deepEqual([after.enabled, after.host, after.port, after.onUnavailable], [true, '127.0.0.1', real.port, 'reject']);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: 'SETTINGS_UPDATE', entityId: 'antivirus' }, orderBy: { createdAt: 'desc' } });
    assert.deepEqual([a.details.before, a.details.after], [legacy, { enabled: true, onUnavailable: 'reject' }], 'denetim: önceki değer aynen, sonraki değerde adres yok');
    // Kayıttan sonra da tarama sunucu ayarındaki tarayıcıya gider
    put('2026/10/aud12-sonra.pdf', Buffer.concat([Buffer.from('%PDF-1.4 '), eicar()]));
    await db.orderFile.create({ data: { name: 'aud12-sonra.pdf', storageKey: '2026/10/aud12-sonra.pdf', size: 10, uploadedById: cust.id, orderId: order.id, scanStatus: 'PENDING' } });
    const again = await scanPending(db, after);
    assert.deepEqual([again.scanned, again.infected, again.stopped], [1, 1, null]);
    assert.deepEqual([real.connections, trap.connections], [3, 0]);

    // Tarayıcı kapanırsa: sabit kod; dosya PENDING kalır (sonra yeniden denenir)
    await closeFake(real);
    put('2026/10/aud12-bekle.pdf');
    await db.orderFile.create({ data: { name: 'aud12-bekle.pdf', storageKey: '2026/10/aud12-bekle.pdf', size: 10, uploadedById: cust.id, orderId: order.id, scanStatus: 'PENDING' } });
    const down = await scanPending(db, after);
    assert.deepEqual([down.scanned, down.stopped], [0, 'unreachable']);
    assert.equal((await db.orderFile.findFirstOrThrow({ where: { name: 'aud12-bekle.pdf' } })).scanStatus, 'PENDING');
    assert.equal(trap.connections, 0);
    await db.orderFile.deleteMany({ where: { name: 'aud12-bekle.pdf' } });
  } finally {
    for (const [k, v] of [['CLAMAV_HOST', saved.host], ['CLAMAV_PORT', saved.port]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetEnvCache();
    await closeFake(real).catch(() => {});
    await closeFake(trap).catch(() => {});
  }
}));
