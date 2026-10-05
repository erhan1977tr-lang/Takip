// "TAKİP'ten kaldır" (karar 132): FGO'da ELLE silinmiş belgenin TAKİP'teki kaydı, FGO yalnızca KESİN "belge yok" derse ve
// yalnızca mevcut temizlik yoluyla (removeDeletedDocument) kaldırılır. FGO'da hiçbir şey silinmez.
// Bu dosyada ağ yoktur: FGO sahte bir yanıtlayıcıdır, veritabanı bellekte; global fetch kapalıdır.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { absentInFgo, refreshDocuments, removeDocumentDeletedInFgo, syncFgoDocuments } from '../server/accounting/receivables.js';
import { FGO_NOT_FOUND, FgoError, fgoAbsentMessage, fgoDocumentAbsent } from '../server/integrations/fgo.js';
import { can } from '../server/auth/permissions.js';
import { sealSecret } from '../server/crypto/secret.js';
import tr from '../server/i18n/tr/accounting.js';
import ro from '../server/i18n/ro/accounting.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const realFetch = globalThis.fetch;
let leaked = 0;
before(() => {
  globalThis.fetch = async () => {
    leaked += 1;
    throw new Error('test: gerçek ağ isteği yapılmamalı');
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(leaked, 0, 'hiçbir test ağa çıkmadı');
});

const SECRET = 's'.repeat(40);
const ON = { enabled: true, cui: '1', keySealed: sealSecret('KEY', SECRET, 'fgo-key') };
const ADMIN = { id: 'u-admin', role: 'ADMIN', ip: '10.0.0.1' };
const fdoc = (id, series, number, extra = {}) => ({ id, orderId: `o-${id}`, batchId: null, kind: series === 'PRF' ? 'PROFORMA' : 'INVOICE', series, number, currency: 'RON', total: '100.00', paid: '0', checkedAt: null, checkError: null, ...extra });

/** Bellekte veritabanı: FGO ayarı, eşitleme kilidi, belgeler, denetim kayıtları */
function memDb(docs, { settings = ON, sync = null } = {}) {
  const rows = { fgo: { value: settings, updatedAt: new Date(1) }, ...(sync ? { 'fgo-sync': { value: sync, updatedAt: new Date(1) } } : {}) };
  const audits = [];
  const writes = [];
  let tick = 2;
  const live = () => docs.filter((d) => !d.deleted);
  return {
    rows, audits, writes, docs,
    integrationSetting: {
      findUnique: async ({ where }) => rows[where.key] ?? null,
      create: async ({ data }) => { rows[data.key] = { value: data.value, updatedAt: new Date(tick++) }; },
      update: async ({ where, data }) => { rows[where.key] = { value: data.value, updatedAt: new Date(tick++) }; },
      updateMany: async ({ where, data }) => {
        const row = rows[where.key];
        if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        rows[where.key] = { value: data.value, updatedAt: new Date(tick++) };
        return { count: 1 };
      },
    },
    fgoDocument: {
      findUnique: async ({ where }) => live().find((d) => d.id === where.id) ?? null,
      findMany: async () => live(),
      update: async ({ where, data }) => { writes.push({ id: where.id, data }); return Object.assign(live().find((d) => d.id === where.id), data); },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
  };
}
/** Mevcut temizlik yolunun yerine geçen casus (gerçeği veritabanı testinde): kaydı kaldırır, çağrıyı yazar */
function spyCleanup(db) {
  const calls = [];
  const fn = async (d, row, reason) => {
    assert.equal(d, db);
    calls.push({ id: row.id, doc: `${row.series}${row.number}`, reason });
    row.deleted = true;
  };
  return Object.assign(fn, { calls });
}
/** Sahte FGO: belge no → yanıt. Her isteğin adresi, yöntemi ve gövdesi kaydedilir. */
function fgo(answers) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    asked.push({ url: String(url), method: init.method, doc: `${form.Serie}${form.Numar}`, form });
    const a = answers[`${form.Serie}${form.Numar}`] ?? { Valoare: '100.00', ValoareAchitata: '0' };
    return typeof a === 'function' ? a() : new Response(JSON.stringify({ Success: true, Factura: a }));
  };
  return { asked, fetchImpl };
}
const refuse = (Message, status = 200) => () => new Response(JSON.stringify({ Success: false, Message }), { status });
const GONE = refuse('Factura nu exista');
const snap = (db) => JSON.stringify(db.docs);
const run = (db, f, o = {}) => removeDocumentDeletedInFgo(db, { docId: 'p563', actor: ADMIN, secret: SECRET, appUrl: 'https://takip.test', fetchImpl: f.fetchImpl, now: new Date('2026-10-05T16:00:00Z'), ...o });

test('"belge FGO\'da yok" sınıflandırması: yalnızca FGO\'nun kalıcı "Factura nu exista" yanıtı kesindir; kimlik / firma / sınır / geçici hata değildir', () => {
  // Kesin: FGO'nun kendi (kalıcı) yanıtı, belgeden söz ediyor
  for (const m of ['Factura nu exista', 'Factura nu există', 'Documentul nu a fost găsit', 'Factura inexistenta', 'Invoice not found', 'Proforma nu exista']) {
    assert.equal(fgoAbsentMessage(m), true, m);
    assert.equal(fgoDocumentAbsent(new FgoError(m, { retry: false })), true, m);
    // Aynı metin geçici hatada (5xx / 429 / ağ) kanıt DEĞİLDİR
    assert.equal(fgoDocumentAbsent(new FgoError(m, { retry: true })), false, `${m} (geçici)`);
    // FgoError olmayan hata (programlama hatası, zaman aşımı nesnesi) kanıt değildir
    assert.equal(fgoDocumentAbsent(new Error(m)), false, `${m} (FgoError değil)`);
  }
  // Belirsiz: "yok" diyor ama belgeden söz etmiyor (firma, kullanıcı, seri, müşteri…) — eski geniş kural bunları da "yok" sayardı
  for (const m of ['Firma nu exista', 'Codul unic nu exista in sistem', 'Utilizatorul nu exista', 'Clientul nu a fost gasit', 'Seria nu exista', 'Not found', 'nu exista']) {
    assert.equal(FGO_NOT_FOUND.test(m), true, `${m}: geniş kural eşleşir`);
    assert.equal(fgoAbsentMessage(m), false, m);
    assert.equal(fgoDocumentAbsent(new FgoError(m, { retry: false })), false, m);
  }
  // Kimlik / yetki / sınır / biçim hatası: belgeden söz etse bile kanıt değil
  for (const m of ['Hash invalid', 'Hash-ul facturii nu exista', 'Cheie privata invalida: factura nu exista', 'Neautorizat: document inexistent', 'Unauthorized', 'Prea multe cereri: factura nu a fost găsit', 'Limita de facturi depasita, factura nu exista', 'Numar factura invalid']) {
    assert.equal(fgoAbsentMessage(m), false, m);
    assert.equal(fgoDocumentAbsent(new FgoError(m, { retry: false })), false, m);
  }
  for (const m of ['', null, undefined, 'HTTP 200', 'FGO yanıtı okunamadı (HTTP 200)', "FGO'ya ulaşılamadı: getaddrinfo ENOTFOUND api.fgo.ro"]) assert.equal(fgoAbsentMessage(m), false, String(m));
  assert.equal(fgoDocumentAbsent(null), false);
  assert.equal(fgoDocumentAbsent('Factura nu exista'), false, 'düz metin hata nesnesi değildir');
  // Ekran ipucu (düğme hangi satırda görünür): kayıtlı son hata kesin "belge yok" ise
  assert.equal(absentInFgo({ checkError: 'Factura nu exista' }), true);
  for (const checkError of [null, '', 'Hash invalid', "FGO'ya ulaşılamadı: Factura nu exista", 'FGO HTTP 503: Factura nu exista', 'FGO yanıtı okunamadı (HTTP 502)']) assert.equal(absentInFgo({ checkError }), false, String(checkError));
  assert.equal(absentInFgo(null), false);
});

test('yönetici: FGO kesin "belge yok" derse mevcut temizlik yolu BİR kez çalışır; FGO\'ya yalnızca o belgenin durumu sorulur (silme isteği yok)', async () => {
  const db = memDb([fdoc('p563', 'PRF', '563', { checkError: 'Factura nu exista' }), fdoc('p564', 'PRF', '564'), fdoc('f1', 'GKH', '10')]);
  const cleanup = spyCleanup(db);
  const f = fgo({ PRF563: GONE });
  assert.deepEqual(await run(db, f, { cleanup }), { ok: true, doc: 'PRF563', orderId: 'o-p563' });
  // Mevcut temizlik yolu: tam o kayıt, FGO'nun yanıtıyla
  assert.deepEqual(cleanup.calls, [{ id: 'p563', doc: 'PRF563', reason: 'Factura nu exista' }]);
  // FGO'ya TEK istek: tam seri + numara için durum okuma (POST factura/getstatus). Silme / iptal / storno isteği yok.
  assert.equal(f.asked.length, 1);
  const [q] = f.asked;
  assert.match(q.url, /\/v1\/factura\/getstatus$/);
  assert.deepEqual([q.method, q.form.Serie, q.form.Numar, q.form.CodUnic, q.form.PlatformaUrl], ['POST', 'PRF', '563', '1', 'https://takip.test']);
  assert.deepEqual(Object.keys(q.form).sort(), ['CodUnic', 'Hash', 'Numar', 'PlatformaUrl', 'Serie'], 'yalnızca durum sorgusunun alanları');
  assert.ok(!/sterge|delete|anul|storn|remove/i.test(q.url));
  // Öbür belgelere dokunulmadı; kaldırma servisi belgeye kendisi yazmadı / silmedi (iş temizlik yolunda)
  assert.deepEqual(db.writes, []);
  assert.deepEqual(db.docs.filter((d) => !d.deleted).map((d) => d.id), ['p564', 'f1']);
  // Denetim kaydı: kim, hangi belge, sonuç
  assert.equal(db.audits.length, 1);
  assert.deepEqual([db.audits[0].action, db.audits[0].entityType, db.audits[0].entityId, db.audits[0].userId, db.audits[0].actorRole, db.audits[0].ip], ['FGO_DOC_REMOVE_REQUEST', 'FgoDocument', 'p563', 'u-admin', 'ADMIN', '10.0.0.1']);
  assert.deepEqual(db.audits[0].details, { kind: 'PROFORMA', series: 'PRF', number: '563', orderId: 'o-p563', batchId: null, result: 'REMOVED', reason: 'Factura nu exista' });
  assert.equal(db.rows['fgo-sync'].value.leaseUntil, null, 'kilit bırakıldı');
  assert.equal(db.rows['fgo-sync'].value.lastRun, undefined, 'eşitleme zamanı / sayıları değişmedi');

  // Kaldırılan belge artık eşitlemenin seçtiği belgeler arasında değil (işçi ve elle tur)
  const again = fgo({});
  assert.deepEqual(await syncFgoDocuments(db, { secret: SECRET, fetchImpl: again.fetchImpl, sleep: async () => {}, now: new Date('2026-10-05T17:00:00Z') }), { ran: true, checked: 2, failed: 0 });
  assert.deepEqual(again.asked.map((x) => x.doc).sort(), ['GKH10', 'PRF564']);
  again.asked.length = 0;
  await refreshDocuments(db, { secret: SECRET, fetchImpl: again.fetchImpl, sleep: async () => {} });
  assert.ok(!again.asked.some((x) => x.doc === 'PRF563'));
  // Aynı kayıt için ikinci istek: kayıt yok — FGO'ya gidilmez, temizlik yeniden çalışmaz
  const f2 = fgo({ PRF563: GONE });
  assert.deepEqual(await run(db, f2, { cleanup }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual([f2.asked.length, cleanup.calls.length], [0, 1]);
});

test('yönetici dışındaki roller kaldıramaz: FGO\'ya gidilmez, hiçbir şey değişmez', async () => {
  assert.deepEqual(['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI'].map((r) => can(r, 'ACCOUNTING_MANAGE')), [true, false, false, false, false], 'muhasebe yetkisi yalnızca yöneticide');
  const db = memDb([fdoc('p563', 'PRF', '563', { checkError: 'Factura nu exista' })]);
  const cleanup = spyCleanup(db);
  const f = fgo({ PRF563: GONE });
  const before = snap(db);
  for (const actor of [{ id: 'u', role: 'SATIS' }, { id: 'u', role: 'CIZIM' }, { id: 'u', role: 'DENETIMCI' }, { id: 'u', role: 'MUSTERI' }, { id: 'u', role: 'BILINMEYEN' }, { id: 'u' }, null, undefined]) {
    assert.deepEqual(await run(db, f, { actor, cleanup }), { ok: false, code: 'FORBIDDEN' }, JSON.stringify(actor));
  }
  assert.deepEqual([f.asked.length, cleanup.calls.length, db.audits.length, snap(db), db.rows['fgo-sync']], [0, 0, 0, before, undefined]);
});

test('belge FGO\'da duruyorsa kayıt KALDIRILMAZ (okunan tutar / ödeme eşitlemedeki gibi yazılır, eski hata silinir)', async () => {
  const db = memDb([fdoc('p563', 'PRF', '563', { checkError: 'Factura nu exista', total: '605.00', paid: '0' })]);
  const cleanup = spyCleanup(db);
  const f = fgo({ PRF563: { Valoare: '605.00', ValoareAchitata: '200.00' } });
  assert.deepEqual(await run(db, f, { cleanup }), { ok: false, code: 'EXISTS', doc: 'PRF563' });
  assert.equal(cleanup.calls.length, 0);
  const [d] = db.docs;
  assert.deepEqual([d.deleted ?? false, d.total, d.paid, d.checkError, d.checkedAt instanceof Date], [false, '605.00', '200.00', null, true]);
  assert.equal(absentInFgo(d), false, 'satırdaki "TAKİP\'ten kaldır" da kalkar');
  assert.deepEqual(db.audits.map((a) => a.details.result), ['EXISTS']);
  assert.equal(db.rows['fgo-sync'].value.leaseUntil, null);
  // FGO "başarılı" ama tutarsız / boş yanıt verirse de belge VAR sayılır (yok denmedi): kaldırılmaz, tutarlar korunur
  const f2 = fgo({ PRF563: () => new Response(JSON.stringify({ Success: true })) });
  assert.deepEqual(await run(db, f2, { cleanup }), { ok: false, code: 'EXISTS', doc: 'PRF563' });
  assert.deepEqual([cleanup.calls.length, db.docs[0].total, db.docs[0].paid], [0, '605.00', '200.00']);
});

test('FGO doğrulanamazsa kayıt KALDIRILMAZ ve hiçbir şey değişmez: zaman aşımı, ağ, 5xx, 429, kimlik hatası, belirsiz / okunamayan yanıt', async () => {
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const cases = {
    'zaman aşımı': timeout,
    'ağ hatası': () => { throw new Error('ECONNRESET'); },
    'DNS hatası': () => { throw new Error('getaddrinfo ENOTFOUND api.fgo.ro'); },
    'HTTP 500': refuse('Internal error', 500),
    'HTTP 503 + "nu exista" metni': refuse('Factura nu exista', 503),
    'HTTP 429 (istek sınırı)': refuse('Prea multe cereri', 429),
    'HTTP 429 + "nu exista" metni': refuse('Factura nu exista', 429),
    'kimlik hatası (hash)': refuse('Hash invalid'),
    'kimlik hatası (anahtar)': refuse('Cheie privata invalida'),
    'kimlik hatası 401': refuse('Unauthorized', 401),
    'firma bulunamadı': refuse('Firma nu exista'),
    'CUI bulunamadı': refuse('Codul unic nu exista in sistem'),
    'seri bulunamadı': refuse('Seria nu exista'),
    'mesajsız ret': () => new Response(JSON.stringify({ Success: false })),
    'boş mesaj': refuse(''),
    'başka bir ret': refuse('Eroare interna la procesare'),
    'JSON olmayan yanıt (200)': () => new Response('<html>Bakım</html>', { status: 200 }),
    'JSON olmayan yanıt (502)': () => new Response('Bad gateway', { status: 502 }),
    'boş gövde': () => new Response('', { status: 200 }),
    'null gövde': () => new Response('null', { status: 200 }),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const db = memDb([fdoc('p563', 'PRF', '563', { checkError: 'Factura nu exista', checkedAt: new Date('2026-10-05T15:00:00Z') }), fdoc('f1', 'GKH', '10')]);
    const cleanup = spyCleanup(db);
    const before = snap(db);
    const f = fgo({ PRF563: answer });
    assert.deepEqual(await run(db, f, { cleanup }), { ok: false, code: 'UNVERIFIED', doc: 'PRF563' }, name);
    assert.equal(cleanup.calls.length, 0, `${name}: temizlik çalışmadı`);
    assert.equal(snap(db), before, `${name}: belge kayıtları aynen (hata metni dahil)`);
    assert.deepEqual(db.writes, [], name);
    assert.equal(f.asked.length, 1, `${name}: tek istek, yeniden deneme yok`);
    assert.deepEqual(db.audits.map((a) => a.details.result), ['UNVERIFIED'], name);
    assert.ok(!JSON.stringify(db.audits).includes('KEY'), `${name}: anahtar denetim kaydına yazılmaz`);
    assert.equal(db.rows['fgo-sync'].value.leaseUntil, null, `${name}: kilit bırakıldı`);
  }
});

test('FGO kapalı / anahtar yok / eşitleme sürüyor: FGO\'ya gidilmez, kayıt kaldırılmaz', async () => {
  const docs = () => [fdoc('p563', 'PRF', '563', { checkError: 'Factura nu exista' })];
  const f = fgo({ PRF563: GONE });
  for (const [settings, code] of [[{ ...ON, enabled: false }, 'FGO_DISABLED'], [{ ...ON, cui: '' }, 'FGO_DISABLED'], [{ enabled: true, cui: '1', keySealed: null }, 'FGO_DISABLED']]) {
    const db = memDb(docs(), { settings });
    const cleanup = spyCleanup(db);
    assert.deepEqual(await run(db, f, { cleanup }), { ok: false, code, doc: 'PRF563' });
    assert.deepEqual([f.asked.length, cleanup.calls.length, db.docs[0].deleted ?? false, db.rows['fgo-sync']], [0, 0, false, undefined]);
  }
  // Anahtar bu sunucunun sırrıyla açılamıyor (yanlış sır): doğrulanamadı
  const sealedElsewhere = memDb(docs(), { settings: { ...ON, hasKey: true } });
  let r;
  try { r = await run(sealedElsewhere, f, { secret: 'x'.repeat(40), cleanup: spyCleanup(sealedElsewhere) }); } catch { r = { ok: false, code: 'THROWN' }; }
  assert.equal(r.ok, false);
  assert.deepEqual([f.asked.length, sealedElsewhere.docs[0].deleted ?? false], [0, false]);
  // Saatlik / elle eşitleme sürerken (kilit alınmış) işlem başlamaz
  const now = new Date('2026-10-05T16:00:00Z');
  const busy = memDb(docs(), { sync: { leaseUntil: new Date(now.getTime() + 60_000).toISOString(), lastRun: 'x' } });
  const cleanup = spyCleanup(busy);
  assert.deepEqual(await run(busy, f, { cleanup, now }), { ok: false, code: 'BUSY', doc: 'PRF563' });
  assert.deepEqual([f.asked.length, cleanup.calls.length, busy.rows['fgo-sync'].value.lastRun], [0, 0, 'x']);
  // Süresi dolmuş kilit engel olmaz; işlem sırasında gelen ikinci istek reddedilir (aynı belgeye iki işlem dokunmaz)
  const db = memDb(docs(), { sync: { leaseUntil: new Date(now.getTime() - 1000).toISOString(), lastRun: 'x', checked: 3 } });
  const spy = spyCleanup(db);
  let second = null;
  const slow = { asked: [], fetchImpl: async () => { second = await run(db, f, { cleanup: spy, now }); return GONE(); } };
  assert.deepEqual(await run(db, slow, { cleanup: spy, now }), { ok: true, doc: 'PRF563', orderId: 'o-p563' });
  assert.deepEqual(second, { ok: false, code: 'BUSY', doc: 'PRF563' });
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(db.rows['fgo-sync'].value, { leaseUntil: null, lastRun: 'x', checked: 3 }, 'eşitleme bilgisi korunur');
});

test('temizlik yolu kaydı kaldıramazsa "kaldırıldı" denmez; kilit bırakılır', async () => {
  const f = fgo({ PRF563: GONE });
  const throwing = memDb([fdoc('p563', 'PRF', '563')]);
  assert.deepEqual(await run(throwing, f, { cleanup: async () => { throw Object.assign(new Error('boom'), { code: 'P2034' }); } }), { ok: false, code: 'CLEANUP_FAILED', doc: 'PRF563' });
  assert.deepEqual([throwing.docs[0].deleted ?? false, throwing.audits.map((a) => [a.details.result, a.details.reason]), throwing.rows['fgo-sync'].value.leaseUntil], [false, [['CLEANUP_FAILED', 'P2034']], null]);
  // Temizlik yolu hata vermedi ama kayıt duruyor (ör. profil adımı reddetti): yine "kaldırıldı" denmez
  const silent = memDb([fdoc('p563', 'PRF', '563')]);
  assert.deepEqual(await run(silent, f, { cleanup: async () => {} }), { ok: false, code: 'CLEANUP_FAILED', doc: 'PRF563' });
  assert.deepEqual(silent.audits.map((a) => a.details.result), ['CLEANUP_FAILED']);
});

test('kaynak kodu: FGO\'da silme isteği yok; kayıt silme yalnızca mevcut temizlik yolunda; işlem yönetici yetkisi + onay ister; ekran yalnızca "yok" satırında gösterir', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) files.push(full);
    }
  };
  for (const d of ['app', 'lib', 'server', 'scripts', 'components']) walk(path.join(ROOT, d));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  // FGO'nun çağrılan uçları: yalnızca belge kesme, PDF bağlantısı, durum okuma (+ tür listesi). Silme / iptal / storno ucu yok.
  const endpoints = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/['"`](\/(?:factura|nomenclator|articol|client)\/[a-z]+)['"`}]/gi)) endpoints.add(m[1]);
  assert.deepEqual([...endpoints].sort(), ['/factura/emitere', '/factura/getstatus', '/factura/print']);
  assert.ok(!files.some((f) => /factura\/(sterge|stergere|delete|anulare|anuleaza|stornare|storno)/i.test(fs.readFileSync(f, 'utf8'))), 'FGO silme / iptal ucu hiçbir dosyada yok');
  // FGO'ya giden tek HTTP noktası fgo.js'tedir ve yöntemi POST'tur (DELETE / PUT / PATCH yok)
  assert.ok(!/method:\s*'(DELETE|PUT|PATCH)'/.test(read('server/integrations/fgo.js')));
  // FgoDocument kaydını silen kod yalnızca mevcut temizlik yollarında (yeni işlem kendi silmez)
  const deleters = files.filter((f) => /fgoDocument\.delete(Many)?\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(deleters, ['server/integrations/fgo-deleted.js', 'server/profile/transitions.js']);
  const svc = read('server/accounting/receivables.js');
  const body = svc.slice(svc.indexOf('export async function removeDocumentDeletedInFgo'));
  assert.match(body, /if \(!can\(actor\?\.role, 'ACCOUNTING_MANAGE'\)\) return \{ ok: false, code: 'FORBIDDEN' \}/);
  assert.match(body, /cleanup = removeDeletedDocument/);
  assert.match(body, /if \(!fgoDocumentAbsent\(e\)\) \{/);
  assert.equal((body.match(/await fgoStatus\(/g) ?? []).length, 1, 'FGO\'ya tek okuma');
  assert.ok(!/fgoEmit|fgoPrint|fetchImpl\(/.test(body), 'başka FGO çağrısı yok');
  // Elle "FGO ile Güncelle" ve fatura numarası temizliği de aynı kesin kuralı kullanır (ikinci bir kural yok)
  assert.match(svc, /if \(!auto && fgoDocumentAbsent\(e\)\) \{/);
  assert.match(read('server/integrations/fgo.js'), /const notFound = fgoDocumentAbsent;/);
  // Sunucu işlemi: muhasebe yetkisi (yalnızca yönetici) + onay alanı; hizmete yalnızca belge kimliği gider
  const actions = read('app/(panel)/admin/muhasebe/actions.ts');
  const act = actions.slice(actions.indexOf('export async function removeDeletedDocAction'), actions.indexOf('/** Yükleme gününe nakliye maliyeti */'));
  assert.match(act, /const user = await requirePermission\('ACCOUNTING_MANAGE'\);/);
  assert.ok(act.indexOf("requirePermission('ACCOUNTING_MANAGE')") < act.indexOf('removeDocumentDeletedInFgo('), 'önce yetki');
  assert.match(act, /if \(fd\.get\('confirmed'\) !== '1'\) redirect\(/);
  assert.ok(act.indexOf("fd.get('confirmed')") < act.indexOf('removeDocumentDeletedInFgo('), 'onaysız istek hizmete ulaşmaz');
  assert.ok(!/cleanup|fetchImpl/.test(act), 'işlem temizlik yolunu / FGO yanıtlayıcısını dışarıdan almaz');
  // İşçi bu işlemi çağırmaz (kayıt yalnızca yöneticinin açık isteğiyle kalkar)
  assert.ok(!/removeDocumentDeletedInFgo/.test(read('scripts/worker.mjs')));
  const callers = files.filter((f) => /removeDocumentDeletedInFgo\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(callers, ['app/(panel)/admin/muhasebe/actions.ts', 'server/accounting/receivables.js']);
  // Ekran: düğme yalnızca son kontrolde "belge yok" denen satırda; onay penceresiyle; yalnızca muhasebe ekranında
  const view = read('app/(panel)/admin/muhasebe/ReceivablesView.tsx');
  assert.match(view, /const gone = absentInFgo\(d\);/);
  assert.match(view, /\{gone && \(\s*<form action=\{removeDeletedDocAction\}/);
  assert.match(view, /<ConfirmButton danger name="confirmed" value="1" message=\{t\('accounting\.receivables\.remove\.confirm'/);
  const users = files.filter((f) => /removeDeletedDocAction/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(users, ['app/(panel)/admin/muhasebe/ReceivablesView.tsx', 'app/(panel)/admin/muhasebe/actions.ts']);
  for (const page of ['app/(panel)/admin/muhasebe/cam/page.tsx', 'app/(panel)/admin/muhasebe/profil/page.tsx']) assert.match(read(page), /requirePermission\('ACCOUNTING_MANAGE'\)/, page);
});

test('metinler: iki dilde; "yalnızca TAKİP\'ten kaldırılır, FGO\'da silinmez" açık; ham FGO hatası / anahtar ekrana yazılmaz', () => {
  const R = ro.receivables.remove, T = tr.receivables.remove;
  assert.deepEqual(Object.keys(R).sort(), Object.keys(T).sort());
  assert.deepEqual(Object.keys(R.errors).sort(), ['BUSY', 'CLEANUP_FAILED', 'CONFIRM', 'EXISTS', 'FORBIDDEN', 'NOT_FOUND', 'UNVERIFIED']);
  assert.deepEqual(Object.keys(T.errors).sort(), Object.keys(R.errors).sort());
  assert.equal(R.button, 'Șterge din TAKİP');
  assert.equal(R.confirm, 'Documentul {doc} va fi eliminat doar din TAKİP. Documentele existente în FGO nu pot fi șterse prin această acțiune. Continuăm?');
  assert.equal(R.removed, 'Documentul {doc} nu mai există în FGO și a fost eliminat din TAKİP.');
  assert.equal(R.errors.EXISTS, 'Documentul {doc} există încă în FGO și nu poate fi eliminat din TAKİP.');
  assert.equal(R.errors.UNVERIFIED, 'Nu s-a putut verifica documentul {doc} în FGO. Nu s-a efectuat nicio modificare.');
  assert.match(T.confirm, /yalnızca TAKİP'ten kaldırılacak.*FGO'da duran belgeler bu işlemle silinemez/);
  // Sonuç metinleri sabittir: FGO'nun ham yanıtı / hata kodu için yer tutucu yok
  for (const dict of [R, T]) for (const text of [dict.removed, ...Object.values(dict.errors)]) assert.ok(!/\{(reason|error|message|code)\}/.test(text), text);
});
