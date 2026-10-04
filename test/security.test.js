// Güvenlik sertleştirmesi (3.46.0, denetim SEC-01 … SEC-17) — saf kuralların regresyon testleri.
// FGO'ya hiçbir istek yapılmaz: PDF indirme işlevi testte sahte işlevle değiştirilir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../server/security/client-ip.js';
import { createRateLimiter } from '../server/security/rate-limit.js';
import { PASSWORD_MIN, PASSWORD_MAX, passwordIssue } from '../server/auth/password-policy.js';
import { SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_TTL_MS, deadSessions, pruneSessions, sessionState } from '../server/auth/session-policy.js';
import { INTERNAL_CUSTOMER_FIELDS, PRIVATE_CUSTOMER_FIELDS, customerView } from '../server/orders/customer-view.js';
import { createPdfAccess } from '../server/documents/pdf-access.js';
import { pdfUrl } from '../server/documents/delivery.js';
import { DAY_MS, HOUR_MS, UPLOAD_LIMITS, checkUpload, freeBytesOf, uploadVerdict } from '../server/files/limits.js';
import { crateOrdersWhere } from '../server/loading/crates.js';
import { validateEnv } from '../server/env.js';

const h = (o) => (n) => o[n] ?? null;
const MB = 1024 * 1024;
const GB = 1024 * MB;

// ---------- SEC-01: güvenilir istemci IP'si ----------
test('SEC-01: sahte CF-Connecting-IP / X-Real-IP / True-Client-IP istemci IP\'sini belirleyemez', () => {
  const caddy = { 'x-forwarded-for': '86.121.5.5' }; // Caddy'nin yazdığı gerçek bağlantı adresi
  for (const forged of [{ 'cf-connecting-ip': '1.2.3.4' }, { 'x-real-ip': '1.2.3.4' }, { 'true-client-ip': '1.2.3.4' }]) {
    assert.equal(clientIp(h({ ...caddy, ...forged })), '86.121.5.5');
  }
  // Başlıklar tek başına gelse de güvenilmez
  assert.equal(clientIp(h({ 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '1.2.3.4' })), null);
});

test('SEC-01: sahte X-Forwarded-For değerleri sonuca giremez — en yakın vekilin (Caddy) yazdığı son değer alınır', () => {
  // Caddy istemcinin başlığını atar; atmayıp ekleseydi bile istemcinin yazdığı değerler solda kalır
  assert.equal(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, 86.121.5.5' })), '86.121.5.5');
  // Her istekte farklı sahte değer: sınırın anahtarı (IP) değişmez
  const seen = new Set();
  for (let i = 1; i <= 50; i++) seen.add(clientIp(h({ 'x-forwarded-for': `10.0.0.${i}, 86.121.5.5`, 'cf-connecting-ip': `10.9.0.${i}` })));
  assert.deepEqual([...seen], ['86.121.5.5']);
});

test('SEC-01: Caddy\'nin ilettiği adres çalışır (IPv4, IPv6, eşlenmiş IPv4); geçersiz değer yok sayılır', () => {
  assert.equal(clientIp(h({ 'x-forwarded-for': '86.121.5.5' })), '86.121.5.5');
  assert.equal(clientIp(h({ 'x-forwarded-for': '2a02:2f0e:1::1' })), '2a02:2f0e:1::1');
  assert.equal(clientIp(h({ 'x-forwarded-for': '::ffff:86.121.5.5' })), '86.121.5.5');
  assert.equal(clientIp(h({ 'x-forwarded-for': 'not-an-ip' })), null);
  assert.equal(clientIp(h({ 'x-forwarded-for': '<script>' })), null);
  assert.equal(clientIp(h({})), null);
});

test('SEC-01: Cloudflare başlığı yalnızca bilinçli ayarla (CLIENT_IP_SOURCE=cloudflare) okunur', () => {
  const hdr = h({ 'cf-connecting-ip': '78.180.1.1', 'x-forwarded-for': '172.70.1.1' });
  assert.equal(clientIp(hdr), '172.70.1.1');
  assert.equal(clientIp(hdr, { source: 'proxy' }), '172.70.1.1');
  assert.equal(clientIp(hdr, { source: 'cloudflare' }), '78.180.1.1');
  // Ayar açık ama başlık geçersizse vekil adresine düşer
  assert.equal(clientIp(h({ 'cf-connecting-ip': 'x', 'x-forwarded-for': '172.70.1.1' }), { source: 'cloudflare' }), '172.70.1.1');
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/t', AUTH_SECRET: 'x'.repeat(32) };
  assert.equal(validateEnv(base).values.CLIENT_IP_SOURCE, 'proxy');
  assert.equal(validateEnv({ ...base, CLIENT_IP_SOURCE: 'cloudflare' }).values.CLIENT_IP_SOURCE, 'cloudflare');
  // Tanınmayan değer hata verir ve güvenli varsayılana (proxy) düşer
  const bad = validateEnv({ ...base, CLIENT_IP_SOURCE: 'header' });
  assert.deepEqual(bad.errors.map((e) => e.name), ['CLIENT_IP_SOURCE']);
  assert.equal(bad.values.CLIENT_IP_SOURCE, 'proxy');
});

// ---------- SEC-04: şifre kuralı ----------
test('SEC-04: yeni şifre en az 10 karakter; uzun parola serbest, bileşim zorunluluğu yok', () => {
  assert.equal(PASSWORD_MIN, 10);
  assert.equal(passwordIssue('Denet1'), 'short'); // eski kural (6 karakter, harf + rakam) artık yetmez
  assert.equal(passwordIssue('abc123def'), 'short'); // 9 karakter
  assert.equal(passwordIssue('abcdefghij'), null); // 10 karakter, yalnızca harf: kabul
  assert.equal(passwordIssue('0123456789'), null); // yalnızca rakam: kabul (bileşim kuralı yok)
  assert.equal(passwordIssue('doğru at pil zımba'), null); // boşluklu parola
  assert.equal(passwordIssue('x'.repeat(40) + 'abc'), null);
  assert.equal(passwordIssue('a'.repeat(PASSWORD_MAX) + 'bcd'), 'long');
  assert.equal(passwordIssue('aaaaaaaaaaaa'), 'trivial'); // tek karakterin tekrarı
  assert.equal(passwordIssue('ababababab'), 'trivial');
  assert.equal(passwordIssue(''), 'short');
  assert.equal(passwordIssue(null), 'short');
});

// ---------- SEC-11: oturum ----------
test('SEC-11: oturum — mutlak ömür 30 gün, boşta kalma 7 gün, etkinlik kaydı en çok 15 dakikada bir', () => {
  assert.deepEqual([SESSION_TTL_MS, SESSION_IDLE_MS, SESSION_TOUCH_MS], [30 * 86_400_000, 7 * 86_400_000, 15 * 60_000]);
  const now = Date.parse('2026-10-04T12:00:00Z');
  const s = (ageMs, idleMs) => ({ expiresAt: new Date(now - ageMs + SESSION_TTL_MS), lastSeenAt: new Date(now - idleMs) });
  assert.equal(sessionState(s(60_000, 60_000), now), 'ok'); // az önce görüldü: veritabanına yazılmaz
  assert.equal(sessionState(s(3_600_000, 14 * 60_000), now), 'ok');
  assert.equal(sessionState(s(3_600_000, 15 * 60_000), now), 'touch'); // 15 dk geçti: etkinlik kaydı yenilenir
  assert.equal(sessionState(s(6 * 86_400_000, 6 * 86_400_000), now), 'touch'); // 6 gün sonra dönen kullanıcı hâlâ içeride
  assert.equal(sessionState(s(8 * 86_400_000, 7 * 86_400_000 + 1), now), 'idle');
  assert.equal(sessionState(s(SESSION_TTL_MS, 1000), now), 'expired'); // her gün kullanılsa da 30. günde biter
  assert.equal(sessionState(s(SESSION_TTL_MS + 1, 1000), now), 'expired');
});

test('SEC-11: temizlik yalnızca geçersiz oturumları (ve eski hatalı giriş kayıtlarını) siler', async () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const where = deadSessions(now);
  assert.deepEqual(where, { OR: [{ expiresAt: { lte: now } }, { lastSeenAt: { lt: new Date(now.getTime() - SESSION_IDLE_MS) } }] });
  const calls = [];
  const db = {
    session: { deleteMany: async (q) => (calls.push(['session', q]), { count: 3 }) },
    authFailure: { deleteMany: async (q) => (calls.push(['authFailure', q]), { count: 5 }) },
  };
  assert.deepEqual(await pruneSessions(db, now), { sessions: 3, failures: 5 });
  assert.deepEqual(calls[0], ['session', { where }]);
  assert.deepEqual(calls[1], ['authFailure', { where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) } } }]);
});

// ---------- istek sınırı ----------
test('istek sınırı: pencere içinde sınır, pencere geçince yeniden; anahtarlar birbirini etkilemez', () => {
  const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual([rl.take('a', 0).ok, rl.take('a', 10).ok, rl.take('a', 20).ok], [true, true, true]);
  const blocked = rl.take('a', 30);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterMs, 970);
  assert.equal(rl.take('b', 30).ok, true);
  assert.equal(rl.take('a', 999).ok, false);
  assert.equal(rl.take('a', 1000).ok, true); // ilk istek pencereden çıktı
  // Anahtar sayısı sınırlı: bellek büyümez
  const small = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });
  for (let i = 0; i < 100; i++) small.take(`k${i}`, i);
  assert.ok(small.size() <= 10);
});

// ---------- SEC-09: mali belge PDF'i ----------
test('SEC-09: PDF bağlantısı yalnızca FGO adresleri — https olsa da başka adres reddedilir', () => {
  assert.equal(pdfUrl('https://api.fgo.ro/v1/factura/print/abc'), 'https://api.fgo.ro/v1/factura/print/abc');
  assert.ok(pdfUrl('https://fgo.ro/x.pdf'));
  for (const bad of [
    'https://evil.example/x.pdf', 'https://fgo.ro.evil.example/x.pdf', 'https://evilfgo.ro/x.pdf', 'http://api.fgo.ro/x.pdf',
    'https://api.fgo.ro@evil.example/x.pdf', 'javascript:alert(1)', '//evil.example/x.pdf', '/belgeler', '', null,
  ]) assert.equal(pdfUrl(bad), null, String(bad));
});

test('SEC-09: PDF — kullanıcı başına istek sınırı, kısa önbellek, yedek bağlantı yalnızca FGO adresi (FGO çağrısı yok)', async () => {
  let fetched = 0;
  const bytes = Buffer.from('%PDF-1.4 test');
  const access = createPdfAccess({ limit: 3, windowMs: 1000, cacheMs: 500, failCacheMs: 100, fetchDoc: async () => (fetched++, { ok: true, bytes }) });
  // Sınır kullanıcı başınadır
  assert.deepEqual([access.allow('u1', 0).ok, access.allow('u1', 1).ok, access.allow('u1', 2).ok], [true, true, true]);
  const no = access.allow('u1', 3);
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterSec, 1);
  assert.equal(access.allow('u2', 3).ok, true);
  assert.equal(access.allow('u1', 1001).ok, true);
  // Önbellek: aynı belge süre içinde FGO'ya yeniden gitmez
  const doc = { id: 'd1' };
  const a = await access.get({}, doc, {}, 0);
  const b = await access.get({}, doc, {}, 400);
  assert.deepEqual([a.ok, a.cached, b.ok, b.cached, fetched], [true, false, true, true, 1]);
  await access.get({}, doc, {}, 600); // süre doldu
  assert.equal(fetched, 2);

  // İndirilemeyen belge: yönlendirme adresi yalnızca FGO'nun kendi adresi olabilir
  const links = { ok: 'https://api.fgo.ro/v1/factura/print/abc', evil: 'https://evil.example/fatura.pdf', http: 'http://api.fgo.ro/x' };
  let failFetched = 0;
  const failing = createPdfAccess({ failCacheMs: 100, fetchDoc: async (_db, d) => (failFetched++, { ok: false, link: links[d.id], error: 'HTTP 403' }) });
  assert.equal((await failing.get({}, { id: 'ok' }, {}, 0)).link, links.ok);
  assert.equal((await failing.get({}, { id: 'evil' }, {}, 0)).link, null);
  assert.equal((await failing.get({}, { id: 'http' }, {}, 0)).link, null);
  // Başarısız indirme de kısa süre hatırlanır
  const again = await failing.get({}, { id: 'ok' }, {}, 50);
  assert.deepEqual([again.ok, again.cached, failFetched], [false, true, 3]);
  await failing.get({}, { id: 'ok' }, {}, 200);
  assert.equal(failFetched, 4);
});

test('SEC-09: PDF önbelleği sınırlıdır (belge sayısı ve toplam bayt)', async () => {
  const access = createPdfAccess({ maxEntries: 3, maxBytes: 250, fetchDoc: async () => ({ ok: true, bytes: Buffer.alloc(100) }) });
  for (let i = 0; i < 10; i++) await access.get({}, { id: `d${i}` }, {}, i);
  assert.ok(access.entries() <= 2); // 3 × 100 bayt 250'yi aşar
});

// ---------- SEC-07: firma alanları ----------
const FIRM = {
  id: 'c1', name: 'GLASSANDMORE', prefix: 'GLA', type: 'CUSTOMER', camEtiket: 'G', sandikEtiket: 'S', groupName: 'Grup A',
  contactPerson: 'Darius', email: 'office@glass.ro', billingEmail: 'facturi@glass.ro', phone: '+40 700', address: 'Str. 1',
  taxId: 'RO123', regCom: 'J12/1/2020', country: 'RO', county: 'Cluj', city: 'Cluj-Napoca',
  fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2.000', priceTableId: 'pt1', profilePriceTableId: 'ppt1',
};

test('SEC-07: satış ve çizim — ad maskeli; iletişim, fatura e-postası, kur politikası, kur yüzdesi, fiyat tablosu gitmez', () => {
  for (const role of ['SATIS', 'CIZIM']) {
    const v = customerView(role, FIRM);
    assert.equal(v.name, 'GLA**********');
    for (const f of [...PRIVATE_CUSTOMER_FIELDS, ...INTERNAL_CUSTOMER_FIELDS]) assert.equal(v[f], null, `${role}: ${f}`);
    const json = JSON.stringify(v);
    for (const secret of ['GLASSANDMORE', 'facturi@glass.ro', 'office@glass.ro', 'BNR_PLUS_PERCENT', '2.000', 'pt1', 'RO123', 'Darius', 'Grup A']) {
      assert.ok(!json.includes(secret), `${role}: ${secret}`);
    }
    assert.equal(v.prefix, 'GLA'); // sipariş numarası için gereken kod kalır
  }
  // Listede en azından istenen alanlar var
  for (const f of ['billingEmail', 'fxPolicy']) assert.ok(PRIVATE_CUSTOMER_FIELDS.includes(f));
  for (const f of ['fxMarkupPercent', 'priceTableId', 'profilePriceTableId']) assert.ok(INTERNAL_CUSTOMER_FIELDS.includes(f));
});

test('SEC-07: müşteri ve denetimci — ad ve kendi bilgileri görünür, ticari iç alanlar (kur yüzdesi, fiyat tablosu) gitmez', () => {
  for (const role of ['MUSTERI', 'DENETIMCI']) {
    const v = customerView(role, FIRM);
    assert.equal(v.name, 'GLASSANDMORE');
    assert.equal(v.billingEmail, 'facturi@glass.ro');
    assert.equal(v.fxPolicy, 'BNR_PLUS_PERCENT'); // müşteriye yalnızca "sözleşme kuru" notu için; yüzde hiçbir zaman (karar 99)
    for (const f of INTERNAL_CUSTOMER_FIELDS) assert.equal(v[f], null, `${role}: ${f}`);
  }
  // Yönetici: kaydın tamamı (aynı nesne)
  assert.equal(customerView('ADMIN', FIRM), FIRM);
  // Girdi değişmez
  assert.equal(FIRM.fxMarkupPercent, '2.000');
  // Sorguda seçilmemiş alan eklenmez
  assert.deepEqual(customerView('SATIS', { name: 'ALEGRAD' }), { name: 'ALE**********' });
});

// ---------- SEC-05: yükleme sınırları ----------
const f = (name, mb) => ({ name, size: mb * MB });
test('SEC-05: istek başına dosya sayısı ve dosya boyutu', () => {
  assert.equal(uploadVerdict({ files: [], kind: 'customer' }), null);
  assert.equal(uploadVerdict({ files: [f('a.pdf', 5), f('b.dwg', 100)], kind: 'customer' }), null);
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 5), f('big.zip', 101)], kind: 'customer' }), { code: 'size', name: 'big.zip' });
  assert.deepEqual(uploadVerdict({ files: Array.from({ length: 21 }, (_, i) => f(`${i}.pdf`, 1)), kind: 'staff' }), { code: 'too_many', name: '' });
  assert.equal(uploadVerdict({ files: Array.from({ length: 20 }, (_, i) => f(`${i}.pdf`, 1)), kind: 'staff' }), null);
  assert.deepEqual(uploadVerdict({ files: [{ name: 'x.pdf', size: NaN }], kind: 'staff' }), { code: 'size', name: 'x.pdf' });
});

test('SEC-05: sipariş başına toplam sınır (2 GB / 400 dosya); depo bağlantısı daha sıkı (200 MB / 40 dosya)', () => {
  const order = Array.from({ length: 20 }, () => ({ size: 100 * MB })); // 2000 MB
  assert.equal(uploadVerdict({ files: [f('a.pdf', 48)], order, kind: 'staff' }), null); // tam 2048 MB
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 49)], order, kind: 'staff' }), { code: 'order_quota', name: '' });
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 1)], order: Array.from({ length: 400 }, () => ({ size: 1 })), kind: 'customer' }), { code: 'order_quota', name: '' });
  const depot = Array.from({ length: 10 }, () => ({ size: 19 * MB })); // 190 MB
  assert.equal(uploadVerdict({ files: [f('teslim.pdf', 10)], order: depot, kind: 'depot' }), null);
  assert.deepEqual(uploadVerdict({ files: [f('teslim.pdf', 11)], order: depot, kind: 'depot' }), { code: 'order_quota', name: '' });
  assert.deepEqual([UPLOAD_LIMITS.order.bytes, UPLOAD_LIMITS.depotOrder.bytes, UPLOAD_LIMITS.fileBytes], [2 * GB, 200 * MB, 100 * MB]);
});

test('SEC-05: yükleyen başına hız sınırı — müşteri saatte 1 GB / 120 dosya, günde 3 GB; iç ekip daha geniş', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const at = (msAgo, mb) => ({ size: mb * MB, createdAt: new Date(now - msAgo) });
  const hour = Array.from({ length: 10 }, () => at(10 * 60_000, 100)); // son saatte 1000 MB
  assert.equal(uploadVerdict({ files: [f('a.pdf', 24)], recent: hour, kind: 'customer', now }), null);
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 25)], recent: hour, kind: 'customer', now }), { code: 'rate', name: '' });
  assert.equal(uploadVerdict({ files: [f('a.pdf', 25)], recent: hour, kind: 'staff', now }), null); // iç ekip: 4 GB / saat
  // Bir saatten eski yüklemeler saatlik sınıra girmez, günlük sınıra girer
  const old = Array.from({ length: 30 }, () => at(2 * HOUR_MS, 100)); // 3000 MB, 2 saat önce
  assert.equal(uploadVerdict({ files: [f('a.pdf', 72)], recent: old, kind: 'customer', now }), null);
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 73)], recent: old, kind: 'customer', now }), { code: 'rate', name: '' });
  // 24 saatten eski kayıt sayılmaz
  assert.equal(uploadVerdict({ files: [f('a.pdf', 100)], recent: old.map((r) => ({ ...r, createdAt: new Date(now - DAY_MS - 1) })), kind: 'customer', now }), null);
  // Dosya sayısı
  const many = Array.from({ length: 119 }, () => at(60_000, 0.01));
  assert.equal(uploadVerdict({ files: [f('a.pdf', 1)], recent: many, kind: 'customer', now }), null);
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 1), f('b.pdf', 1)], recent: many, kind: 'customer', now }), { code: 'rate', name: '' });
});

test('SEC-05: disk koruması — boş alan eşiğin altına inecekse yükleme reddedilir', async () => {
  const min = 1024 * MB;
  assert.equal(uploadVerdict({ files: [f('a.pdf', 10)], kind: 'staff', freeBytes: 5 * GB, minFreeBytes: min }), null);
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 10)], kind: 'staff', freeBytes: 1030 * MB, minFreeBytes: min }), { code: 'disk', name: '' });
  assert.deepEqual(uploadVerdict({ files: [f('a.pdf', 1)], kind: 'customer', freeBytes: 100 * MB, minFreeBytes: min }), { code: 'disk', name: '' });
  // Boş alan okunamıyorsa (null) ya da denetim kapalıysa (0) yükleme engellenmez
  assert.equal(uploadVerdict({ files: [f('a.pdf', 1)], kind: 'staff', freeBytes: null, minFreeBytes: min }), null);
  assert.equal(uploadVerdict({ files: [f('a.pdf', 1)], kind: 'staff', freeBytes: 1, minFreeBytes: 0 }), null);
  assert.equal(await freeBytesOf('/x', async () => ({ bavail: 1000, bsize: 4096 })), 4_096_000);
  assert.equal(await freeBytesOf('/x', async () => ({ bavail: 1000n, bsize: 4096n })), 4_096_000);
  assert.equal(await freeBytesOf('/x', async () => { throw new Error('ENOENT'); }), null);
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/t', AUTH_SECRET: 'x'.repeat(32) };
  assert.equal(validateEnv(base).values.UPLOAD_MIN_FREE_MB, 1024);
  assert.equal(validateEnv({ ...base, UPLOAD_MIN_FREE_MB: '0' }).values.UPLOAD_MIN_FREE_MB, 0);
});

/** Sahte veritabanı: yalnızca checkUpload'ın sorduğu sorgular */
function fakeDb({ user = null, orderFiles = [], draftFiles = [], drawingFiles = [] } = {}) {
  const queries = [];
  const table = (name, rows) => ({ findMany: async (q) => (queries.push([name, q]), rows) });
  return {
    queries,
    user: { findUnique: async (q) => (queries.push(['user', q]), user) },
    orderFile: table('orderFile', orderFiles), orderDraftFile: table('orderDraftFile', draftFiles), drawingFile: table('drawingFile', drawingFiles),
  };
}
const OPTS = { root: '/uploads', minFreeMb: 1024, now: new Date('2026-10-04T12:00:00Z'), statfs: async () => ({ bavail: 10 * 1024, bsize: MB }) };

test('SEC-05: checkUpload — sayı / boyut reddi veritabanına ve diske gitmeden verilir', async () => {
  const db = fakeDb();
  let statCalls = 0;
  const opts = { ...OPTS, statfs: async () => (statCalls++, { bavail: 1, bsize: 1 }) };
  assert.deepEqual(await checkUpload(db, [f('big.zip', 150)], { userId: 'u1', orderId: 'o1' }, opts), { code: 'size', name: 'big.zip' });
  assert.deepEqual(await checkUpload(db, Array.from({ length: 25 }, (_, i) => f(`${i}.pdf`, 1)), { userId: 'u1' }, opts), { code: 'too_many', name: '' });
  assert.equal(await checkUpload(db, [], { userId: 'u1' }, opts), null);
  assert.deepEqual([db.queries.length, statCalls], [0, 0]);
});

test('SEC-05: checkUpload — müşteri kotası firmanın bütün kullanıcılarını sayar; iç ekip yalnızca kendini', async () => {
  const recent = (mb, n) => Array.from({ length: n }, () => ({ size: mb * MB, createdAt: new Date('2026-10-04T11:50:00Z') }));
  const cust = fakeDb({ user: { id: 'u1', customerId: 'c1', type: 'CUSTOMER' }, orderFiles: recent(100, 4), draftFiles: recent(100, 4), drawingFiles: recent(100, 2) });
  assert.deepEqual(await checkUpload(cust, [f('a.pdf', 30)], { userId: 'u1' }, OPTS), { code: 'rate', name: '' });
  const where = cust.queries.find(([n]) => n === 'orderDraftFile')[1].where;
  assert.deepEqual(where.uploadedBy, { customerId: 'c1', type: 'CUSTOMER' });
  assert.deepEqual(where.createdAt, { gte: new Date('2026-10-03T12:00:00Z') });
  // İç ekip de bir firmaya (fabrika) bağlıdır; müşteri sayılmaz
  const staff = fakeDb({ user: { id: 's1', customerId: 'fabrika', type: 'INTERNAL' }, orderFiles: recent(100, 4), draftFiles: recent(100, 4), drawingFiles: recent(100, 2) });
  assert.equal(await checkUpload(staff, [f('a.pdf', 30)], { userId: 's1' }, OPTS), null);
  assert.equal(staff.queries.find(([n]) => n === 'drawingFile')[1].where.uploadedById, 's1');
});

test('SEC-05: checkUpload — sipariş kotası sipariş + çizim dosyalarını sayar; depo bağlantısı yalnızca kendi yüklediklerini', async () => {
  const big = Array.from({ length: 10 }, () => ({ size: 100 * MB }));
  const db = fakeDb({ user: { id: 's1', customerId: 'fabrika', type: 'INTERNAL' }, orderFiles: big, drawingFiles: big });
  assert.deepEqual(await checkUpload(db, [f('a.pdf', 60)], { userId: 's1', orderId: 'o1' }, OPTS), { code: 'order_quota', name: '' });
  assert.deepEqual(db.queries.filter(([n, q]) => n === 'drawingFile' && q.where.drawing)[0][1].where, { drawing: { orderId: 'o1' } });
  // Depo bağlantısı: kullanıcı yok, kota yalnızca depodan yüklenenlerden; kullanıcı sorgusu yapılmaz
  const depot = fakeDb({ orderFiles: Array.from({ length: 10 }, () => ({ size: 19 * MB })) });
  assert.deepEqual(await checkUpload(depot, [f('teslim.pdf', 15)], { userId: null, orderId: 'o1', depot: true }, OPTS), { code: 'order_quota', name: '' });
  assert.deepEqual(depot.queries.map(([n]) => n), ['orderFile']);
  assert.deepEqual(depot.queries[0][1].where, { orderId: 'o1', source: 'DEPOT_LINK' });
  assert.equal(await checkUpload(fakeDb(), [f('teslim.pdf', 15)], { userId: null, orderId: 'o1', depot: true }, OPTS), null);
});

test('SEC-05: checkUpload — disk eşiği altında her yükleme reddedilir; hiçbir dosya silinmez', async () => {
  const db = fakeDb({ user: { id: 's1', customerId: 'fabrika', type: 'INTERNAL' } });
  const low = { ...OPTS, statfs: async () => ({ bavail: 900, bsize: MB }) };
  assert.deepEqual(await checkUpload(db, [f('a.pdf', 1)], { userId: 's1', orderId: 'o1' }, low), { code: 'disk', name: '' });
  assert.equal(await checkUpload(db, [f('a.pdf', 1)], { userId: 's1', orderId: 'o1' }, { ...low, minFreeMb: 0 }), null);
  assert.equal(await checkUpload(db, [f('a.pdf', 1)], { userId: 's1', orderId: 'o1' }, OPTS), null);
  // Sahte veritabanında yalnızca okuma işlevleri var: silme / güncelleme çağrısı olsaydı hata verirdi
});

// ---------- SEC-17: sandık satırı ----------
test('SEC-17: müşteriye giden sandık satırında yalnızca KENDİ siparişleri; iç ekipte tümü', () => {
  assert.deepEqual(crateOrdersWhere({ appRole: 'MUSTERI', customerId: 'c1' }), { order: { customerId: 'c1' } });
  // Firması olmayan müşteri kullanıcısı hiçbir sipariş göremez (hepsini değil)
  assert.deepEqual(crateOrdersWhere({ appRole: 'MUSTERI', customerId: null }), { order: { customerId: '__none__' } });
  // İç ekip: süzgeç yok (fabrikaya bağlı olsalar da)
  for (const appRole of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI']) assert.deepEqual(crateOrdersWhere({ appRole, customerId: 'fabrika' }), {});
});
