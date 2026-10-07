// Gerçek sunucu kipi — işçi ve demo verisi betiği GERÇEK SÜREÇ olarak, gerçek PostgreSQL ile (karar 151; güvenlik denetimi
// 3.50.9 AUD-13). `node scripts/worker.mjs --once` ve `node scripts/demo/seed.mjs` çocuk süreç olarak, test veritabanına
// karşı çalıştırılır:
//   - işaret yok (CI / demo işçisi): MAIL_OUTBOX_DIR geçerli — e-posta klasöre yazılır, iş SENT olur (test özelliği duruyor)
//   - gerçek sunucu işareti + sunucuya kopyalanmış demo / test ayarları: klasör HİÇ oluşmaz, iş "gönderildi" olmaz; e-posta
//     SMTP yoluna gider (127.0.0.1'deki sahte sunucu bağlantıyı sayar; STARTTLS olmadığı için hiçbir ileti / şifre gitmez);
//     günlükteki uyarı yalnızca ayar adlarını içerir
//   - hatalı ortam: işçi BAŞLAMAZ (çıkış 1), veritabanında hiçbir şey değişmez
//   - demo verisi: gerçek sunucu işaretiyle (DEMO_MODE=1 olsa da) ve boş olmayan veritabanında reddedilir; hiçbir satır eklenmez
// Dış ağ yok: yalnızca 127.0.0.1 (sahte SMTP) ve test veritabanı. FGO ayarı yoktur (işçi FGO'ya istek atmaz); --once ile
// saatlik FGO eşitlemesi de çalışmaz.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_URL, closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-sunucu-kipi-'));
const SECRET = 'sunucu-kipi-testi-gizli-anahtar-0123456789abcdef';
const SMTP_PASS = 'gizli-smtp-parolasi';
const NAMES = ['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'TRANSLATE_FAKE', 'COOKIE_SECURE'];
const DEMO_ADMIN = 'yonetici@ornek.test';
const RECIPIENT = 'musteri@sunucu-kipi.test';

let db;
let order;
let smtp;

/** Çocuk sürecin ortamı: yalnızca verilenler (test sürecinin ortamı — TEST_DATABASE_URL, CLAMAV_HOST, bayraklar — geçmez) */
const childEnv = (extra = {}) => ({
  PATH: process.env.PATH ?? '', DATABASE_URL: TEST_URL, AUTH_SECRET: SECRET, UPLOAD_DIR: path.join(TMP, 'uploads'), APP_URL: 'http://localhost:3999', NODE_ENV: 'production', ...extra,
});
/** Betiği çocuk süreç olarak çalıştırır → { code, out } (out: standart çıktı + hata çıktısı) */
function run(script, args, env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script}: 120 saniyede bitmedi\n${out.slice(-2000)}`)); }, 120_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
const worker = (env) => run('scripts/worker.mjs', ['--once'], childEnv(env));
/** Sahte SMTP (127.0.0.1): bağlantıları ve gelen komutları sayar; STARTTLS sunmaz → istemci ileti / şifre göndermeden vazgeçer */
function fakeSmtp() {
  return new Promise((resolve) => {
    const s = { connections: 0, commands: [], port: 0, socks: new Set(), server: null };
    s.server = net.createServer((sock) => {
      s.connections += 1;
      s.socks.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => s.socks.delete(sock));
      sock.write('220 localhost ESMTP sahte\r\n');
      sock.on('data', (d) => {
        for (const line of d.toString('latin1').split(/\r?\n/).filter(Boolean)) {
          const cmd = line.split(' ')[0].toUpperCase();
          s.commands.push(cmd);
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 localhost\r\n');
          else if (cmd === 'QUIT') sock.end('221 bye\r\n');
          else sock.write('502 desteklenmiyor\r\n');
        }
      });
    });
    s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; resolve(s); });
  });
}
const event = () => db.notificationOutbox.create({ data: { type: 'ORDER_OFFER_SENT', orderId: order.id, payload: {} } });
const row = (id) => db.notificationOutbox.findUniqueOrThrow({ where: { id } });
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
/** Veritabanının bu testte değişmemesi gereken sayıları */
const counts = async () => JSON.stringify({
  users: await db.user.count(), customers: await db.customer.count(), orders: await db.order.count(), files: await db.orderFile.count(),
  demoSeed: await db.auditLog.count({ where: { action: 'DEMO_SEED' } }), demoAdmin: await db.user.count({ where: { email: DEMO_ADMIN } }),
});

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const firm = await db.customer.create({ data: { name: 'Sunucu Kipi SRL', prefix: 'SNK' } });
  await db.user.create({ data: { email: 'yonetici@sunucu-kipi.test', name: 'Y', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  const cust = await db.user.create({ data: { email: RECIPIENT, name: 'M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, language: 'ro' } });
  order = await db.order.create({ data: { orderNo: 'SNK1', customerOrderNo: 1, title: 'Sunucu kipi', customerId: firm.id, createdById: cust.id } });
  // Bildirim e-postaları "başlangıç anı"ndan sonraki olaylar içindir: testteki olaylar işlensin diye başlangıç geçmişe alınır
  const since = { at: new Date(0).toISOString() };
  await db.integrationSetting.upsert({ where: { key: 'notify.since' }, create: { key: 'notify.since', value: since }, update: { value: since } });
  smtp = await fakeSmtp();
});
after(async () => {
  if (smtp) { for (const k of smtp.socks) k.destroy(); await new Promise((r) => { smtp.server.close(() => r()); }); }
  await closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

dbTest('işçi (işaret yok — CI / demo): MAIL_OUTBOX_DIR geçerli; e-posta klasöre yazılır, iş SENT olur', offline(async () => {
  const dir = path.join(TMP, 'outbox-test');
  const e = await event();
  const r = await worker({ MAIL_OUTBOX_DIR: dir });
  assert.equal(r.code, 0, r.out.slice(-1500));
  assert.match(r.out, /işçi başladı/);
  const done = await row(e.id);
  assert.deepEqual([done.status, done.sentAt !== null], ['SENT', true]);
  const files = filesIn(dir);
  assert.equal(files.length, 1, 'klasörde bir e-posta');
  const mail = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(mail.to, RECIPIENT);
  assert.equal(smtp.connections, 0, 'SMTP kullanılmadı');
  // Açık test ayarı günlükte görünür (üretim derlemesi, işaret yok) ama "yok sayıldı" DEĞİL
  assert.match(r.out, /⚠ MAIL_OUTBOX_DIR: açık — bu bir test \/ demo kurulumu olmalı/);
  assert.doesNotMatch(r.out, /YOK SAYILDI/);
  assert.equal(r.out.includes(dir), false, 'günlükte klasör yolu yok');
}));

dbTest('işçi (gerçek sunucu işareti + kopyalanmış demo / test ayarları): klasör kullanılmaz, iş "gönderildi" olmaz; e-posta SMTP yoluna gider; uyarı yalnızca adlar', offline(async () => {
  const dir = path.join(TMP, 'gizli-yol', 'outbox-sunucu');
  const e = await event();
  const before = smtp.connections;
  const r = await worker({
    TAKIP_DEPLOYMENT: 'server', DEMO_MODE: '1', MAIL_OUTBOX_DIR: dir, TRANSLATE_FAKE: '1', COOKIE_SECURE: 'false', NODE_ENV: 'development',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'posta@sunucu-kipi.test', SMTP_PASS, MAIL_FROM: 'posta@sunucu-kipi.test',
  });
  assert.equal(r.code, 0, r.out.slice(-1500));
  assert.match(r.out, /işçi başladı/, 'işçi kapanmadı, turunu attı');
  // Klasör hiç oluşmadı; iş gönderildi sayılmadı (sonra yeniden denenecek)
  assert.equal(fs.existsSync(dir), false, 'e-posta klasörü oluşmadı');
  assert.equal(fs.existsSync(path.dirname(dir)), false);
  const pending = await row(e.id);
  assert.deepEqual([pending.status, pending.sentAt, pending.attempts], ['PENDING', null, 1]);
  assert.ok(pending.lastError, 'gönderim hatası kayıtlı (SMTP)');
  // E-posta SMTP yoluna gitti: sahte sunucuya bağlanıldı; STARTTLS olmadığı için ileti de şifre de gönderilmedi
  assert.ok(smtp.connections > before, 'SMTP sunucusuna bağlanıldı');
  for (const cmd of ['AUTH', 'MAIL', 'RCPT', 'DATA']) assert.equal(smtp.commands.includes(cmd), false, `düz metin ${cmd} gönderilmedi`);
  // Günlük: göze çarpan uyarı + dört ad; değer / yol / sır yok
  assert.match(r.out, /GÜVENLİK UYARISI — test \/ geliştirme ayarları gerçek sunucuda YOK SAYILDI/);
  for (const name of NAMES) assert.ok(r.out.includes(`⚠ ${name}: gerçek sunucuda yok sayıldı`), name);
  for (const s of [dir, 'gizli-yol', 'outbox-sunucu', SECRET, SMTP_PASS, TEST_URL]) assert.equal(r.out.includes(s), false, `günlükte olmamalı: ${s.slice(0, 14)}…`);
}));

dbTest('işçi (gerçek sunucu işareti, SMTP ayarı yok): e-posta kuyrukta bekler; klasöre yine yazılmaz', offline(async () => {
  const dir = path.join(TMP, 'outbox-smtp-yok');
  const e = await event();
  const before = smtp.connections;
  const r = await worker({ TAKIP_DEPLOYMENT: 'server', MAIL_OUTBOX_DIR: dir });
  assert.equal(r.code, 0, r.out.slice(-1500));
  assert.match(r.out, /e-posta ayarlı değil/);
  const waiting = await row(e.id);
  assert.deepEqual([waiting.status, waiting.sentAt, waiting.attempts], ['PENDING', null, 0], 'iş dokunulmadan bekliyor');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(smtp.connections, before);
  // Sonraki test için: bekleyen iş kapatılır (kuyrukta kalmasın)
  await db.notificationOutbox.update({ where: { id: e.id }, data: { status: 'SKIPPED' } });
}));

dbTest('işçi (hatalı ortam): başlamaz — çıkış 1, veritabanına dokunmaz, klasöre yazmaz; rapor değer içermez', offline(async () => {
  const dir = path.join(TMP, 'outbox-hatali');
  const e = await event();
  const status = async () => JSON.stringify([await db.integrationSetting.findUnique({ where: { key: 'antivirus.status' } }), await row(e.id), await db.notification.count()]);
  const before = await status();
  // [hatalı ortam, raporda adı geçmesi gereken değişken]
  const cases = [
    [{ AUTH_SECRET: 'kisa-gizli' }, 'AUTH_SECRET'],
    [{ AUTH_SECRET: 'kisa-gizli', TAKIP_DEPLOYMENT: 'server' }, 'AUTH_SECRET'],
    [{ NOTIFY_EMAILS: 'belki' }, 'NOTIFY_EMAILS'],
    [{ TAKIP_DEPLOYMENT: 'test' }, 'TAKIP_DEPLOYMENT'],
    [{ DATABASE_URL: 'mysql://kullanici:gizli-parola@127.0.0.1/x' }, 'DATABASE_URL'],
  ];
  for (const [bad, name] of cases) {
    const r = await worker({ MAIL_OUTBOX_DIR: dir, ...bad });
    assert.equal(r.code, 1, `${name}: ${r.out.slice(-800)}`);
    assert.match(r.out, /Ortam değişkenleri hatalı/);
    assert.match(r.out, /İşçi başlatılmadı: ortam değişkenleri hatalı\./);
    assert.doesNotMatch(r.out, /işçi başladı/);
    assert.ok(r.out.includes(`✘ ${name}:`), `hatalı değişkenin adı raporda: ${name}`);
    for (const s of ['kisa-gizli', 'gizli-parola', 'belki', dir, SECRET]) assert.equal(r.out.includes(s), false, `raporda değer yok: ${s}`);
  }
  assert.equal(await status(), before, 'veritabanında hiçbir şey değişmedi (tur atılmadı)');
  assert.equal(fs.existsSync(dir), false);
  await db.notificationOutbox.update({ where: { id: e.id }, data: { status: 'SKIPPED' } });
}));

dbTest('demo verisi betiği: gerçek sunucu işaretiyle (DEMO_MODE=1 olsa da) ve boş olmayan veritabanında çalışmaz — hiçbir satır eklenmez', offline(async () => {
  const cwd = fs.mkdtempSync(path.join(TMP, 'seed-'));
  const seed = (env) => run('scripts/demo/seed.mjs', [], childEnv({ UPLOAD_DIR: path.join(cwd, 'uploads'), ...env }), cwd);
  const before = await counts();
  assert.equal(JSON.parse(before).demoAdmin, 0);
  // 1. Gerçek sunucu: işaretin her değeri, DEMO_MODE=1 ile birlikte
  for (const marker of ['server', 'test', '0']) {
    const r = await seed({ TAKIP_DEPLOYMENT: marker, DEMO_MODE: '1', MAIL_OUTBOX_DIR: path.join(cwd, 'outbox') });
    assert.equal(r.code, 1, `${marker}: ${r.out.slice(-800)}`);
    assert.match(r.out, /GERÇEK SUNUCUDA çalışmaz/);
    assert.equal(await counts(), before, `${marker}: veritabanı aynen`);
  }
  // 2. İşaret yok ama DEMO_MODE=1 değil
  for (const demo of [undefined, '0', 'true']) {
    const r = await seed(demo === undefined ? {} : { DEMO_MODE: demo });
    assert.equal(r.code, 1);
    assert.match(r.out, /yalnızca demo ortamında çalışır/);
  }
  // 3. İşaret bir şekilde verilmemiş + DEMO_MODE=1 (ör. imaj Compose'suz çalıştırıldı): veritabanında gerçek veri var → reddedilir
  const bypass = await seed({ DEMO_MODE: '1' });
  assert.equal(bypass.code, 1, bypass.out.slice(-800));
  assert.match(bypass.out, /yalnızca BOŞ bir veritabanına yüklenir/);
  assert.equal(await counts(), before, 'veritabanı aynen: demo kullanıcısı / firması / siparişi eklenmedi');
  assert.equal(await db.customer.count({ where: { prefix: 'ORN' } }), 0);
  // Giriş bilgisi dosyası ve örnek dosyalar da yazılmadı
  assert.equal(fs.existsSync(path.join(cwd, 'DEMO-GIRIS.txt')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'uploads')), false);
}));
