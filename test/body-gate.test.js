// Gövde kapısı (güvenlik denetimi AUD-4, karar 143): vekil büyük bir gövdeyi uygulamaya iletmeden önce uygulamaya sorar.
//   - kural: yükleme sayfalarında geçerli oturum, /depo/<anahtar>'da geçerli depo bağlantısı; başka her şey "izin yok"
//   - kapı salt okunurdur (hiçbir kayıt değişmez) ve mevcut iki denetimi kullanır (peekSession = liveSession'ın kuralı;
//     findDepotOrder) — ikinci bir kimlik doğrulama yoktur
//   - Caddyfile ile uygulamadaki sabitler birbirini tutar; kapının sorusu gövdesizdir, kendine dönmez, kapalı tarafa düşer
// Gerçek Caddy arkasındaki davranış (iletilen bayt, bozuk yanıt, zaman aşımı, Caddy 2.6 → güncel): deploy/test/body-gate.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_UPLOAD_PAGES, DEPOT_PREFIX, GATE_ALLOW, GATE_ALLOW_STATUS, GATE_DENY_STATUS, GATE_HEADER, GATE_PATH, GATE_SMALL_BYTES, GATE_URI_HEADER,
  SESSION_UPLOAD_PREFIX, bodyGate, declaredSmall, gateDecision, gateResponse, gateTarget,
} from '../server/security/body-gate.js';
import { SESSION_IDLE_MS, SESSION_TTL_MS, liveSession, peekSession } from '../server/auth/session-policy.js';
import { hashToken } from '../server/profile/warehouse.js';
import { readCaddyfile } from './caddyfile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Yorumsuz kaynak: önce satır yorumları (içlerinde "/siparisler/*" gibi yazımlar blok yorum sanılmasın), sonra blok yorumlar */
const noComments = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const MIN = 60_000;
const NOW = Date.parse('2026-10-06T10:00:00Z');
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf';

/**
 * Bellek içi veritabanı: yalnızca kapının kullanması GEREKEN iki okuma (session.findUnique, profileOrder.findUnique) vardır.
 * Başka herhangi bir erişim (silme, güncelleme, ekleme, sayma, başka tablo) hata fırlatır ve `writes` listesine yazılır.
 */
function readOnlyDb({ sessions = {}, depots = {} } = {}) {
  const calls = [];
  const writes = [];
  const table = (name, find) => new Proxy({}, {
    get: (_t, method) => {
      if (method === 'findUnique') return async (args) => { calls.push(`${name}.findUnique`); return find(args); };
      return async () => { writes.push(`${name}.${String(method)}`); throw new Error(`salt okunur olmalıydı: ${name}.${String(method)}`); };
    },
  });
  const db = new Proxy({}, {
    get: (_t, name) => {
      if (name === 'session') return table('session', ({ where }) => sessions[where.tokenHash] ?? null);
      if (name === 'profileOrder') return table('profileOrder', ({ where }) => depots[where.depotTokenHash] ?? null);
      if (name === 'then') return undefined;
      writes.push(String(name));
      throw new Error(`kapı bu tabloya / işleve dokunmamalı: ${String(name)}`);
    },
  });
  return { db, calls, writes };
}
const session = ({ lastSeenAt = NOW - MIN, createdAt = NOW - 60 * MIN, isActive = true } = {}) => ({
  id: 's1', userId: 'u1', user: { isActive }, createdAt: new Date(createdAt), expiresAt: new Date(createdAt + SESSION_TTL_MS), lastSeenAt: new Date(lastSeenAt),
});
const depot = ({ expiresAt = NOW + 86_400_000, status = 'URETIMDE' } = {}) => ({ id: 'p1', orderId: 'o1', stage: 'DEPODA', depotTokenExpiresAt: new Date(expiresAt), order: { status } });

// ---------- adres → denetim ----------
test('adres: yükleme sayfaları oturuma, /depo/<anahtar> depo bağlantısına bağlıdır; başka her adres ve her tuhaf yazım "bilinmeyen"dir', () => {
  const sessionPaths = [
    '/siparisler/yeni', '/siparisler/yeni?tip=GLASS_ORDER', '/siparisler/yeni?tip=PROFILE_ORDER&x=%2F', '/siparisler/cmabc123', '/siparisler/cmabc123?ok=created#notlar',
    '/siparisler/cmabc123/cizim/cmdef456', '/siparisler/taslak/cmabc', '/siparisler/',
    ...ADMIN_UPLOAD_PAGES, '/admin/katalog?ok=1',
  ];
  for (const p of sessionPaths) assert.deepEqual(gateTarget(p), { kind: 'session' }, p);
  assert.deepEqual(gateTarget(`/depo/${TOKEN}`), { kind: 'depot', token: TOKEN });
  assert.deepEqual(gateTarget(`/depo/${TOKEN}?e=file`), { kind: 'depot', token: TOKEN });
  assert.deepEqual(gateTarget(`/depo/${TOKEN}/`), { kind: 'depot', token: TOKEN });
  // Anahtarın biçimine burada bakılmaz (findDepotOrder bakar): kısa / tuhaf anahtar depo denetimine gider ve orada reddedilir
  assert.deepEqual(gateTarget('/depo/kisa'), { kind: 'depot', token: 'kisa' });
  const unknown = [
    // büyük kademede olmayan adresler
    '/', '/login', '/setup', '/siparisler', '/siparislerim/x', '/depo', '/depo/', '/yuklemeler', '/admin', '/admin/users', '/admin/katalog/', '/admin/katalog/x',
    '/admin/katalog-yedek', '/oturum/govde-izni', '/oturum/etkinlik', '/belgeler',
    // depo: tek parça değil
    `/depo/${TOKEN}/ek`, '/depo//x',
    // başka yazımlar (Caddy'nin eşleştiricisi kabul etse de kapı etmez): büyük harf, çift eğik çizgi, %-kodlama, nokta parçaları, ters eğik çizgi
    '/SIPARISLER/yeni', '/Siparisler/yeni', '/ADMIN/katalog', `/Depo/${TOKEN}`, '//siparisler/yeni', '/siparisler//yeni', '/%73iparisler/yeni', '/siparisler/%79eni',
    '/siparisler/../admin/users', '/siparisler/./yeni', '/siparisler/..', '/x/../siparisler/yeni', '/siparisler\\yeni', `/depo/%41${TOKEN.slice(1)}`,
    // adres değil
    '', 'siparisler/yeni', 'https://kotu.example/siparisler/yeni', '?x=/siparisler/yeni', '#/siparisler/yeni', `/${'a'.repeat(3000)}`,
  ];
  for (const p of unknown) assert.equal(gateTarget(p), null, p);
  for (const v of [null, undefined, 42, {}, ['/siparisler/yeni'], true]) assert.equal(gateTarget(v), null, String(v));
  // Sabitler
  assert.equal(SESSION_UPLOAD_PREFIX, '/siparisler/');
  assert.equal(DEPOT_PREFIX, '/depo/');
  assert.deepEqual([...ADMIN_UPLOAD_PAGES], ['/admin/fiyatlar', '/admin/musteri-fiyatlari', '/admin/katalog', '/admin/profil-katalogu', '/admin/stok']);
});

// ---------- karar ----------
test('karar: oturum sayfasında yalnızca oturum, depo adresinde yalnızca depo denetimi sorulur; bilinmeyen adreste hiçbiri', async () => {
  const run = async (uri, { s = false, d = false } = {}) => {
    const asked = [];
    const ok = await bodyGate({ uri, sessionOk: async () => { asked.push('oturum'); return s; }, depotOk: async (t) => { asked.push(`depo:${t}`); return d; } });
    return { ok, asked };
  };
  assert.deepEqual(await run('/siparisler/yeni', { s: true }), { ok: true, asked: ['oturum'] });
  assert.deepEqual(await run('/siparisler/yeni', { s: false, d: true }), { ok: false, asked: ['oturum'] }, 'depo bağlantısı sipariş sayfasında işe yaramaz');
  assert.deepEqual(await run('/admin/stok', { s: true }), { ok: true, asked: ['oturum'] });
  assert.deepEqual(await run(`/depo/${TOKEN}`, { d: true }), { ok: true, asked: [`depo:${TOKEN}`] });
  assert.deepEqual(await run(`/depo/${TOKEN}`, { s: true, d: false }), { ok: false, asked: [`depo:${TOKEN}`] }, 'oturum depo adresinde anahtarın yerini tutmaz');
  for (const uri of ['/login', '/siparisler', '/SIPARISLER/yeni', '', null]) assert.deepEqual(await run(uri, { s: true, d: true }), { ok: false, asked: [] }, String(uri));
});

test('karar: kapalı tarafa düşer — denetim hata verirse ya da tam olarak "true" dönmezse izin yok', async () => {
  const boom = async () => { throw new Error('veritabanı yok'); };
  assert.equal(await bodyGate({ uri: '/siparisler/yeni', sessionOk: boom, depotOk: async () => true }), false);
  assert.equal(await bodyGate({ uri: `/depo/${TOKEN}`, sessionOk: async () => true, depotOk: boom }), false);
  for (const v of [1, 'evet', {}, [], null, undefined, 'true']) {
    assert.equal(await bodyGate({ uri: '/siparisler/yeni', sessionOk: async () => v, depotOk: async () => true }), false, String(v));
    assert.equal(await bodyGate({ uri: `/depo/${TOKEN}`, sessionOk: async () => true, depotOk: async () => v }), false, String(v));
  }
  // Veritabanı erişimi hata verirse gateDecision da "izin yok" der (hata dışarı taşmaz)
  const broken = { session: { findUnique: boom }, profileOrder: { findUnique: boom } };
  assert.equal(await gateDecision(broken, { uri: '/siparisler/yeni', tokenHash: 'h', now: NOW }), false);
  assert.equal(await gateDecision(broken, { uri: `/depo/${TOKEN}`, tokenHash: null, now: NOW }), false);
});

test('yanıt: izin yalnızca "204 + X-Takip-Govde: izin"; izin yok 401 ve başlıksız; ikisi de önbelleğe alınmaz', () => {
  assert.deepEqual(gateResponse(true), { status: 204, headers: { 'Cache-Control': 'no-store', 'x-takip-govde': 'izin' } });
  assert.deepEqual(gateResponse(false), { status: 401, headers: { 'Cache-Control': 'no-store' } });
  for (const v of [1, 'true', {}, null, undefined]) assert.equal(gateResponse(v).status, 401, String(v));
  assert.deepEqual([GATE_ALLOW_STATUS, GATE_DENY_STATUS, GATE_HEADER, GATE_ALLOW, GATE_PATH, GATE_URI_HEADER], [204, 401, 'x-takip-govde', 'izin', '/oturum/govde-izni', 'x-forwarded-uri']);
});

// ---------- oturum: mevcut kural, salt okunur ----------
test('oturum: peekSession, liveSession ile aynı kararı verir ama hiçbir şey yazmaz (geçersiz satırı bile silmez)', async () => {
  const cases = {
    gecerli: session(),
    '29dk59sn': session({ lastSeenAt: NOW - SESSION_IDLE_MS + 1000 }),
    bosta: session({ lastSeenAt: NOW - SESSION_IDLE_MS }),
    'cok-bosta': session({ lastSeenAt: NOW - 5 * 60 * MIN, createdAt: NOW - 6 * 60 * MIN }),
    'suresi-doldu': session({ createdAt: NOW - SESSION_TTL_MS, lastSeenAt: NOW - MIN }),
    pasif: session({ isActive: false }),
  };
  const expected = { gecerli: 'ok', '29dk59sn': 'ok', bosta: 'idle', 'cok-bosta': 'idle', 'suresi-doldu': 'expired', pasif: 'inactive', yok: 'none', '': 'none' };
  for (const [key, reason] of Object.entries(expected)) {
    // 1) Salt okunur veritabanında: tek okuma, yazma yok
    const ro = readOnlyDb({ sessions: cases });
    const peek = await peekSession(ro.db, key, { now: NOW });
    assert.equal(peek.reason, reason, key);
    assert.equal(peek.session !== null, reason === 'ok', key);
    assert.deepEqual(ro.calls, key ? ['session.findUnique'] : [], key);
    assert.deepEqual(ro.writes, [], key);
    // 2) liveSession aynı sonucu verir; farkı yalnızca geçersiz satırı silmesidir
    const deleted = [];
    const rw = { session: { findUnique: async ({ where }) => cases[where.tokenHash] ?? null, deleteMany: async ({ where }) => { deleted.push(where.id); return { count: 1 }; } } };
    const live = await liveSession(rw, key, { now: NOW });
    assert.equal(live.reason, peek.reason, key);
    assert.equal(live.remainingMs, peek.remainingMs, key);
    assert.equal(live.session, peek.session, key);
    assert.equal('deadId' in live, false);
    assert.deepEqual(deleted, ['idle', 'expired'].includes(reason) ? ['s1'] : [], key);
    // 3) Kapının kararı = oturum geçerli mi
    const g = readOnlyDb({ sessions: cases });
    assert.equal(await gateDecision(g.db, { uri: '/siparisler/yeni', tokenHash: key || null, now: NOW }), reason === 'ok', key);
    assert.deepEqual(g.writes, [], key);
    assert.ok(g.calls.every((c) => c === 'session.findUnique'), 'oturum sayfasında depo tablosuna bakılmaz');
  }
  // Çerez yoksa veritabanına hiç gidilmez
  const none = readOnlyDb();
  assert.equal(await gateDecision(none.db, { uri: '/siparisler/yeni', tokenHash: null, now: NOW }), false);
  assert.equal(await gateDecision(none.db, { uri: '/siparisler/yeni', tokenHash: undefined, now: NOW }), false);
  assert.deepEqual(none.calls, []);
  // Kapı sorusu oturumu uzatmaz: aynı oturumla 1.000 soru → kalan süre değişmez, 30. dakikada yine biter
  const many = readOnlyDb({ sessions: { t: session({ lastSeenAt: NOW }) } });
  for (let i = 0; i < 1000; i++) assert.equal(await gateDecision(many.db, { uri: '/siparisler/yeni', tokenHash: 't', now: NOW + i * 1000 }), true);
  assert.equal(await gateDecision(many.db, { uri: '/siparisler/yeni', tokenHash: 't', now: NOW + SESSION_IDLE_MS - 1 }), true);
  assert.equal(await gateDecision(many.db, { uri: '/siparisler/yeni', tokenHash: 't', now: NOW + SESSION_IDLE_MS }), false);
  assert.deepEqual(many.writes, []);
});

// ---------- depo: mevcut denetim, salt okunur ----------
test('depo: geçerli bağlantı oturumsuz geçer; biçimsiz, bilinmeyen, süresi dolmuş anahtar ve iptal edilmiş sipariş geçmez; hiçbir şey yazılmaz', async () => {
  const depots = { [hashToken(TOKEN)]: depot() };
  const ask = async (uri, d = depots, tokenHash = null) => {
    const ro = readOnlyDb({ depots: d, sessions: { oturum: session() } });
    const ok = await gateDecision(ro.db, { uri, tokenHash, now: NOW });
    assert.deepEqual(ro.writes, [], uri);
    return { ok, calls: ro.calls };
  };
  assert.deepEqual(await ask(`/depo/${TOKEN}`), { ok: true, calls: ['profileOrder.findUnique'] });
  assert.deepEqual(await ask(`/depo/${TOKEN}?ok=added`), { ok: true, calls: ['profileOrder.findUnique'] });
  // Bilinmeyen (biçimi doğru) anahtar: tek okuma, sonuç yok
  assert.deepEqual(await ask(`/depo/${TOKEN.slice(0, -1)}X`), { ok: false, calls: ['profileOrder.findUnique'] });
  // Biçimsiz anahtar: findDepotOrder veritabanına hiç gitmez
  for (const bad of ['kisa', 'x'.repeat(39), 'x'.repeat(61), `${TOKEN.slice(0, 42)}!`, `${TOKEN.slice(0, 42)}.`]) assert.deepEqual(await ask(`/depo/${bad}`), { ok: false, calls: [] }, bad);
  // Süresi dolmuş bağlantı / süre bilgisi yok / sipariş iptal
  assert.equal((await ask(`/depo/${TOKEN}`, { [hashToken(TOKEN)]: depot({ expiresAt: NOW }) })).ok, false);
  assert.equal((await ask(`/depo/${TOKEN}`, { [hashToken(TOKEN)]: { ...depot(), depotTokenExpiresAt: null } })).ok, false);
  assert.equal((await ask(`/depo/${TOKEN}`, { [hashToken(TOKEN)]: depot({ status: 'IPTAL' }) })).ok, false);
  // Geçerli OTURUM depo adresinde anahtarın yerini tutmaz; geçerli ANAHTAR başka adreste işe yaramaz
  assert.equal((await ask(`/depo/${TOKEN.slice(0, -1)}X`, depots, 'oturum')).ok, false);
  assert.equal((await ask(`/siparisler/${TOKEN}`)).ok, false);
  assert.equal((await ask(`/admin/katalog?depo=${TOKEN}`)).ok, false);
  // Anahtar veritabanında özetiyle aranır (düz anahtar sorguya girmez)
  let where = null;
  await gateDecision({ profileOrder: { findUnique: async (a) => { where = a.where; return null; } } }, { uri: `/depo/${TOKEN}`, tokenHash: null, now: NOW });
  assert.deepEqual(where, { depotTokenHash: hashToken(TOKEN) });
});

// ---------- vekildeki "küçük gövde" kuralı ----------
test('küçük gövde: Caddyfile\'daki Content-Length ifadesi ile uygulamadaki kural aynıdır (0 … 2.000.000 bayt kapıya sorulmaz)', () => {
  const { matchers, tiers } = readCaddyfile(path.join(ROOT, 'deploy/Caddyfile'));
  const patterns = ['yukleme', 'yonetim_excel'].map((n) => matchers[n].smallLength);
  assert.equal(patterns[0], patterns[1], 'iki kademede aynı ifade');
  assert.doesNotMatch(patterns[0], /[{}\s"`]/, 'Caddyfile\'da tırnaksız yazılabilir (süslü ayraç / boşluk yok)');
  const re = new RegExp(patterns[0]);
  const values = ['0', '1', '9', '10', '99999', '100000', '999999', '1000000', '1999999', '2000000', '2000001', '2000010', '2999999', '3000000', '9999999', '10000000', '260000000',
    '', ' ', '-1', '+5', '5 ', ' 5', '1e3', '0x10', '1.5', '2000000.0', 'abc', '５', '000005', '0000005', '02000000', '2000000, 5', '5,5'];
  for (const v of values) assert.equal(re.test(v), declaredSmall(v), JSON.stringify(v));
  for (let n = 0; n <= 2_100_000; n += 997) assert.equal(re.test(String(n)), n <= GATE_SMALL_BYTES, String(n));
  for (const n of [1_999_999, 2_000_000]) assert.equal(declaredSmall(String(n)), true);
  for (const n of [2_000_001, 2_000_002, 20_000_000]) assert.equal(declaredSmall(String(n)), false);
  for (const v of [null, undefined, 5, 2_000_000]) assert.equal(declaredSmall(v), false, 'başlık yoksa (boyu bilinmiyor) küçük sayılmaz');
  // Eşik, varsayılan kademenin sınırıyla aynı: kapıya sorulmayan gövde zaten 2 MB'ı aşamaz
  assert.equal(tiers.find((t) => !t.name).max, GATE_SMALL_BYTES);
  // İki kademede de GET / HEAD kapıya sorulmaz
  for (const n of ['yukleme', 'yonetim_excel']) assert.deepEqual(matchers[n].notMethods, ['GET', 'HEAD'], n);
});

// ---------- Caddyfile ↔ uygulama ----------
test('Caddyfile: kapının sorusu gövdesiz GET, özgün adres Caddy\'den; izin yalnızca tam yanıtla; başka her şey 401; kendine dönmez', () => {
  const { code, matchers, blocked, tiers, gate, routeFor } = readCaddyfile(path.join(ROOT, 'deploy/Caddyfile'));
  assert.ok(gate, 'govde_kapisi tanımı');
  const lines = gate.split('\n').map((l) => l.trim()).filter(Boolean);
  // Soru doğrudan uygulamaya gider (vekilin kendi kurallarından geçmez → kendine dönemez), gövdesiz GET, sorgu atılır
  assert.equal(lines[0], 'reverse_proxy app:3000 {');
  assert.ok(lines.includes('method GET'));
  assert.ok(lines.includes(`rewrite ${GATE_PATH}?`));
  // Özgün adres ve yöntem istemciden değil Caddy'den (istemcinin yazdığı aynı adlı başlık ezilir)
  assert.ok(lines.includes('header_up X-Forwarded-Uri {uri}'));
  assert.ok(lines.includes('header_up X-Forwarded-Method {method}'));
  assert.equal(GATE_URI_HEADER, 'x-forwarded-uri');
  for (const h of ['Expect', 'CF-Connecting-IP', 'CF-IPCountry', 'True-Client-IP', 'X-Real-IP']) assert.ok(lines.includes(`header_up -${h}`), h);
  // Süre sınırı: uygulama yanıt vermezse istek bekletilmez
  assert.match(gate, /transport http \{\n\t\t\tdial_timeout 3s\n\t\t\tresponse_header_timeout 10s\n\t\t\}/);
  // İzin = tam olarak 204 + X-Takip-Govde: izin → zincir sürer (vars: yanıt yazmayan bir adım); başka her yanıt → 401
  assert.match(gate, new RegExp(`@izin \\{\\n\\t\\t\\tstatus ${GATE_ALLOW_STATUS}\\n\\t\\t\\theader X-Takip-Govde ${GATE_ALLOW}\\n\\t\\t\\}`));
  assert.equal('X-Takip-Govde'.toLowerCase(), GATE_HEADER);
  assert.match(gate, /handle_response @izin \{\n\t\t\tvars govde_izni evet\n\t\t\}\n\t\thandle_response \{\n\t\t\trespond 401\n\t\t\}/);
  assert.equal((gate.match(/handle_response/g) ?? []).length, 2);
  assert.equal(GATE_DENY_STATUS, 401);
  // Kapının yanıtından isteğe başlık kopyalanmaz; yanıt gövdesi istemciye aktarılmaz
  for (const never of ['copy_headers', 'copy_response', 'request_header', 'lb_', 'health_', 'buffer_requests', 'request_buffers']) assert.ok(!gate.includes(never), never);
  // Kapı yalnızca iki büyük kademede çağrılır; her birinde sıra: kapı → gövde sınırı → uygulama (route içinde, okuyucu bu biçimi arar)
  assert.deepEqual(tiers.filter((t) => t.gated).map((t) => t.name), ['yukleme', 'yonetim_excel']);
  assert.equal(tiers.find((t) => !t.name).gated, false, 'varsayılan kademe kapısız');
  assert.equal((code.match(/\broute \{/g) ?? []).length, 2);
  // Kapının adresi dışarıya kapalı ve hiçbir büyük kademede değil
  assert.deepEqual(blocked, [{ name: 'govde_izni', paths: [GATE_PATH, `${GATE_PATH}/*`] }]);
  assert.equal(gateTarget(GATE_PATH), null);
  for (const m of ['GET', 'POST', 'HEAD', 'PUT']) assert.equal(routeFor({ path: GATE_PATH, method: m }).blocked, true, m);
  // Kademelerin adresleri uygulamadaki listelerle aynı
  assert.deepEqual(matchers.yukleme.paths, [`${SESSION_UPLOAD_PREFIX}*`, `${DEPOT_PREFIX}*`]);
  assert.deepEqual(matchers.yonetim_excel.paths, [...ADMIN_UPLOAD_PAGES]);
  // Caddy'nin kapıya sorduğu her adres sınıfı uygulamada tanımlı; kapıya sorulmayan adresler uygulamada da "bilinmeyen"
  for (const p of ['/siparisler/yeni', '/siparisler/cmabc/cizim/cmdef', `/depo/${TOKEN}`, ...ADMIN_UPLOAD_PAGES]) {
    assert.equal(routeFor({ path: p, method: 'POST' }).gated, true, p);
    assert.notEqual(gateTarget(p), null, p);
  }
  for (const p of ['/login', '/setup', '/siparisler', '/yuklemeler', '/admin/users', '/depo', '/oturum/etkinlik']) {
    assert.equal(routeFor({ path: p, method: 'POST' }).gated, false, p);
    assert.equal(gateTarget(p), null, p);
  }
});

// ---------- yapı ----------
test('yapı: kapının adresi yalnızca GET, gövde okumaz, yazmaz, günlüğe yazmaz; oturum ve depo denetimi mevcut işlevlerdir', () => {
  const route = read('app/oturum/govde-izni/route.ts');
  const src = noComments(route);
  assert.deepEqual(route.match(/export async function (\w+)/g), ['export async function GET'], 'başka yöntemler 405');
  assert.match(src, /export const dynamic = 'force-dynamic'/);
  for (const never of ['.json()', '.text()', '.formData()', '.arrayBuffer()', '.blob()', 'req.body', 'console.', 'audit(', 'cookies()', '.set(', '.delete(', 'fetch(', 'authFailure', 'requestIp', 'redirect(']) {
    assert.ok(!src.includes(never), `${never} kapının adresinde olmamalı`);
  }
  for (const need of ['gateDecision(db', 'sessionKey()', 'GATE_URI_HEADER', 'gateResponse(']) assert.ok(src.includes(need), need);
  // sessionKey: çerezi yalnızca okur
  const sessionTs = read('lib/auth/session.ts');
  const key = sessionTs.slice(sessionTs.indexOf('export async function sessionKey'), sessionTs.indexOf('export type CurrentUser'));
  assert.match(key, /\.get\(COOKIE\)/);
  assert.doesNotMatch(key, /\.set\(|\.delete\(|db\./);
  // Kural dosyası: mevcut iki denetimi kullanır; veritabanına kendisi dokunmaz; dış istek / günlük yok
  const gate = noComments(read('server/security/body-gate.js'));
  assert.match(gate, /import \{ peekSession \} from '\.\.\/auth\/session-policy\.js'/);
  assert.match(gate, /import \{ findDepotOrder \} from '\.\.\/profile\/warehouse\.js'/);
  for (const never of ['db.', 'fetch(', 'console.', 'process.env', 'liveSession', 'recordActivity', 'authFailure']) assert.ok(!gate.includes(never), never);
  // peekSession yazmaz; liveSession kuralı ondan alır (ikinci bir oturum kuralı yok)
  const policy = read('server/auth/session-policy.js');
  const peek = noComments(policy.slice(policy.indexOf('export async function peekSession'), policy.indexOf('export async function liveSession')));
  assert.doesNotMatch(peek, /delete|update|upsert|create/);
  assert.match(peek, /db\.session\.findUnique\(/);
  const live = noComments(policy.slice(policy.indexOf('export async function liveSession'), policy.indexOf('export async function recordActivity')));
  assert.match(live, /await peekSession\(db, tokenHash, o\)/);
  assert.doesNotMatch(live, /findUnique|sessionState|isActive/, 'kural tek yerde (peekSession)');
  assert.equal((noComments(policy).match(/sessionState\(session, now\)/g) ?? []).length, 1);
  // findDepotOrder salt okunur (depo sayfası da onu çağırır)
  const wh = read('server/profile/warehouse.js');
  const find = noComments(wh.slice(wh.indexOf('export async function findDepotOrder'), wh.indexOf('// ---------- PDF ----------')));
  assert.doesNotMatch(find, /\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\(/);
  assert.match(read('app/depo/[token]/page.tsx'), /findDepotOrder\(db, token\)/);
  assert.match(read('app/depo/[token]/actions.ts'), /findDepotOrder\(db, token\)/);
  // Kapıyı çağıran tek yer kendi adresidir; peekSession'ı çağıran tek yer kapıdır (ve liveSession)
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.(js|mjs|ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const sources = ['app', 'components', 'lib', 'server', 'scripts'].flatMap(walk);
  const users = (name) => sources.filter((f) => new RegExp(`\\b${name}\\b`).test(noComments(read(f)))).sort();
  assert.deepEqual(users('gateDecision'), ['app/oturum/govde-izni/route.ts', 'server/security/body-gate.js']);
  assert.deepEqual(users('peekSession'), ['server/auth/session-policy.js', 'server/security/body-gate.js']);
  // Uygulamanın kendisi kapının adresine istek yollamaz (yalnızca Caddy sorar)
  assert.deepEqual(sources.filter((f) => /govde-izni/.test(noComments(read(f)))).sort(), ['server/security/body-gate.js']);
});

test('yapı: sunucu işlemleri kendi denetimini yapmaya devam eder (kapı yetkilendirme değildir)', () => {
  // Dosya yükleyen her işlem dosyası hâlâ kendi oturum / yetki / anahtar denetimini içerir
  const guards = {
    'app/(panel)/siparisler/yeni/actions.ts': /requirePermission\(/,
    'app/(panel)/siparisler/[id]/actions.ts': /requirePermission\(|requireUser\(/,
    'app/(panel)/siparisler/[id]/profile-actions.ts': /requirePermission\(|requireUser\(/,
    'app/(panel)/admin/fiyatlar/actions.ts': /requirePermission\(/,
    'app/(panel)/admin/katalog/actions.ts': /requirePermission\(/,
    'app/(panel)/admin/profil-katalogu/actions.ts': /requirePermission\(/,
    'app/(panel)/admin/stok/actions.ts': /requirePermission\(/,
    'app/depo/[token]/actions.ts': /findDepotOrder\(db, token\)/,
  };
  for (const [file, re] of Object.entries(guards)) assert.match(read(file), re, file);
  // Depo işleminin hatalı deneme sayacı işlemdedir (kapı saymaz, işlem saymaya devam eder)
  assert.match(read('app/depo/[token]/actions.ts'), /db\.authFailure\.create\(/);
  // Next sınırı ve bellek sınırı bu değişiklikte de yok / aynı (SEC-12)
  assert.match(read('next.config.mjs'), /bodySizeLimit: '250mb'/);
  const compose = read('deploy/docker-compose.yml');
  for (const k of ['mem_limit', 'mem_reservation', 'memswap_limit', 'cpus', 'pids_limit', 'deploy', 'ulimits']) assert.doesNotMatch(compose, new RegExp(`^\\s*${k}:`, 'm'), k);
});

test('yapı: gerçek Caddy denemesi yalnızca CI\'da çalışır, sözdizimi geçerli, iş akışında çağrılır; sahte uygulama imaja girmez', () => {
  const script = read('deploy/test/body-gate.sh');
  assert.match(script, /^\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{ .*exit 2; \}$/m);
  for (const f of ['deploy/test/body-gate.sh', 'deploy/test/body-gate-matrix.sh']) execFileSync('bash', ['-n', path.join(ROOT, f)]);
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'deploy/test/body-gate-mock.mjs')]);
  const wf = read('.github/workflows/deploy-test.yml');
  assert.match(wf, /bash deploy\/test\/body-gate\.sh\b/);
  assert.match(wf, /shellcheck [^\n]*deploy\/test\/body-gate\.sh deploy\/test\/body-gate-matrix\.sh/);
  // Kapı denemesi, depoyu bozuk bırakan adımdan önce çalışır
  assert.ok(wf.indexOf('bash deploy/test/body-gate.sh') < wf.indexOf('Derlemesi bozuk sürüm yayınlanmaz'));
  assert.match(read('.dockerignore'), /^deploy\/test\/?$/m);
  // Deneme, gerçek Caddy sürümlerini ve gerçek kurulumu kapsar; sahte uygulama yalnızca vekilin arkasındadır
  for (const tag of ['2.6.4', '2.7.6', '2.8.4']) assert.ok(script.includes(tag), tag);
  // Sahte uygulamanın "izin" yanıtı uygulamadaki sabitlerle aynı
  const mock = read('deploy/test/body-gate-mock.mjs');
  assert.ok(mock.includes(`const GATE = '${GATE_PATH}'`));
  assert.ok(mock.includes(`res.writeHead(${GATE_ALLOW_STATUS}, { 'X-Takip-Govde': '${GATE_ALLOW}'`));
});
