// Sipariş notlarının otomatik çevirisi (karar 127) — veritabanıyla.
//   - müşterinin notu Türkçeye, yönetici / satış / çizim notu Romenceye BİR KEZ çevrilir ve saklanır
//   - özgün metin değişmez; çeviri başarısız olsa da not kaydedilir; sayfa açılışı çeviri yapmaz
//   - çeviri notun görünürlüğünü aşamaz: iç not çevrilmez, müşteriye hata kodu / başka firmanın notu gitmez
//   - ayarı yalnızca yönetici değiştirir; anahtar şifreli saklanır, hiçbir kayıtta açık hâli yoktur
// Google'a GERÇEK istek yapılmaz: sağlayıcı her testte sahte işlevdir ve testler ağ engeliyle (offline) çalışır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const tr = await import('../../server/notes/translation.js');
const { TranslateError } = await import('../../server/notes/provider.js');
const { orderScope } = await import('../../server/orders/scope.js');
const { openSecret } = await import('../../server/crypto/secret.js');

const SECRET = 'n'.repeat(40);
const KEY = 'AIzaSyTESTONLY-not-a-real-key-0123456789';
const U = {};
let db, A, B, OA, OB, OP, ONODRAW;
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });

/** Sahte sağlayıcı: çağrıları sayar (gerçek Google yok) */
function provider(impl = async ({ text, target }) => ({ text: `[${target}] ${text}` })) {
  const calls = [];
  return { calls, fn: async (o) => { calls.push({ ...o }); return impl(o); } };
}
const add = (u, order, text, { internal = false, p = provider(), now = undefined } = {}) =>
  tr.addNote(db, { orderId: order.id, actor: act(u), text, internal, translator: p.fn, secret: SECRET, ...(now ? { now } : {}) });
const retry = (u, noteId, order, p = provider(), extra = {}) =>
  tr.retryNoteTranslation(db, { noteId, orderId: order.id, actor: act(u), translator: p.fn, secret: SECRET, ...extra });
const rowOf = (id) => db.orderNote.findUniqueOrThrow({ where: { id } });
const fields = (n) => [n.translation, n.translationLang, n.translationStatus, n.translationError];
/** Ayar: açık + anahtar kayıtlı (yönetici) */
async function enable(enabled = true) {
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled }, { key: KEY, secret: SECRET }, act(U.admin)), { ok: true });
}
/**
 * Kullanıcının sipariş sayfasında gördüğü notlar — lib/orders.ts ile aynı iki kural: sipariş kapsamı (orderScope) +
 * notesFor. Sipariş kullanıcının kapsamında değilse null (sayfa 404).
 */
async function seen(u, order) {
  const o = await db.order.findFirst({ where: { id: order.id, ...orderScope({ appRole: u.appRole, customerId: u.customerId }) }, include: { notes: true } });
  return o ? tr.notesFor(u.appRole, o.notes) : null;
}
const seenNote = async (u, order, id) => (await seen(u, order))?.find((n) => n.id === id) ?? null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const firm = (name, prefix) => db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@ceviri.test` } });
  A = await firm('Alfa Sticla SRL', 'ALF');
  B = await firm('Beta Glass SRL', 'BET');
  const user = (k, appRole, customerId) => db.user.create({ data: { email: `${k}@ceviri.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId } }).then((u) => { U[k] = u; });
  await user('admin', 'ADMIN', factory.id);
  await user('sales', 'SATIS', factory.id);
  await user('drawer', 'CIZIM', factory.id);
  await user('inspector', 'DENETIMCI', factory.id);
  await user('custA', 'MUSTERI', A.id);
  await user('custB', 'MUSTERI', B.id);
  const order = (f, no, extra = {}) => db.order.create({
    data: { orderNo: `${f.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: U.admin.id, status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI', ...extra },
  });
  OA = await order(A, 1);
  OB = await order(B, 1);
  ONODRAW = await order(A, 2, { drawingTrack: 'YOK' }); // çizim ekibinin kapsamında değil
  OP = await order(A, 3, { orderNo: 'ALFP3', orderTypeCode: 'PROFILE_ORDER', drawingTrack: 'YOK', status: 'YENI' }); // satışın kapsamında değil
});
after(closeDb);

dbTest('müşterinin Romence notu → Türkçe çeviri bir kez yapılır ve saklanır; özgün metin değişmez; yönetici / satış / çizim özgün + Türkçe, denetimci yalnızca özgün notu görür', offline(async () => {
  await enable();
  const text = 'Vă rog să modificați dimensiunea la 1200 mm.\n  A doua linie — „ghilimele” & <b>semn</b> 100%';
  const p = provider(async () => ({ text: 'Lütfen ölçüyü 1200 mm olarak değiştirin.' }));
  const r = await add(U.custA, OA, text, { p });
  assert.deepEqual([r.ok, r.translation], [true, 'DONE']);
  // Sağlayıcı BİR kez, özgün metinle ve Türkçe hedefle çağrıldı (yön rolden; anahtar yalnızca sunucuda açılır)
  assert.equal(p.calls.length, 1);
  assert.deepEqual([p.calls[0].text, p.calls[0].target, p.calls[0].key], [text, 'tr', KEY]);
  const row = await rowOf(r.noteId);
  assert.deepEqual([row.text, row.internal, row.userId, row.orderId], [text, false, U.custA.id, OA.id], 'özgün metin aynen saklandı');
  assert.deepEqual(fields(row), ['Lütfen ölçüyü 1200 mm olarak değiştirin.', 'tr', 'DONE', null]);
  assert.ok(row.translationAt instanceof Date);
  // Yönetici, satış, çizim: özgün + Türkçe çeviri
  for (const u of [U.admin, U.sales, U.drawer]) {
    const n = await seenNote(u, OA, r.noteId);
    assert.deepEqual([n.text, n.translation, n.translationLang, n.translationStatus], [text, 'Lütfen ölçüyü 1200 mm olarak değiştirin.', 'tr', 'DONE'], u.name);
  }
  // Denetimci (karar 128): notu görür (erişimi değişmedi) ama yalnızca ÖZGÜN Romence metni — saklanan çeviri ona gitmez
  const insp = await seenNote(U.inspector, OA, r.noteId);
  assert.deepEqual([insp.text, ...fields(insp), insp.translationAt], [text, null, null, null, null, null]);
  assert.ok(!JSON.stringify(await seen(U.inspector, OA)).includes('Lütfen ölçüyü'), 'Türkçe çeviri denetimcinin verisinde yok');
  assert.equal(tr.translationState(insp), null);
  // Müşteri kendi notunu özgün hâliyle görür (kendi notunun Türkçesi ona gönderilmez)
  const own = await seenNote(U.custA, OA, r.noteId);
  assert.deepEqual([own.text, ...fields(own)], [text, null, null, null, null]);
  // Baştaki / sondaki boşluk dışında metne dokunulmaz (eski davranış: kırpma + 4000 karakter)
  const r2 = await add(U.custA, OA, `  \n ${text} \n `, { p });
  assert.equal((await rowOf(r2.noteId)).text, text);
  const long = await add(U.custA, OA, 'ă'.repeat(4100), { p });
  assert.equal((await rowOf(long.noteId)).text.length, 4000);
  assert.equal(p.calls[2].text.length, 4000, 'çevrilen metin = saklanan metin');
}));

dbTest('yönetici / satış / çizim Türkçe notu → Romence çeviri saklanır; müşteri özgün + Romence görür; iç ekip ve denetimci yalnızca özgün Türkçe notu görür', offline(async () => {
  await enable();
  for (const u of [U.admin, U.sales, U.drawer]) {
    const text = `Ölçüyü güncelledik, yeni teklif yarın hazır — ${u.name}`;
    const p = provider(async () => ({ text: `Am actualizat dimensiunea, oferta nouă va fi gata mâine — ${u.name}` }));
    const r = await add(u, OA, text, { p });
    assert.deepEqual([r.ok, r.translation], [true, 'DONE'], u.name);
    assert.deepEqual(p.calls.map((c) => [c.text, c.target]), [[text, 'ro']], u.name);
    const row = await rowOf(r.noteId);
    assert.deepEqual([row.text, row.userId, ...fields(row)], [text, u.id, `Am actualizat dimensiunea, oferta nouă va fi gata mâine — ${u.name}`, 'ro', 'DONE', null], u.name);
    // Müşteri: özgün Türkçe + Romence çeviri; hata kodu alanı boş
    const c = await seenNote(U.custA, OA, r.noteId);
    assert.deepEqual([c.text, c.translation, c.translationLang, c.translationStatus, c.translationError], [text, row.translation, 'ro', 'DONE', null], u.name);
    // İç ekip (karar 130): notu yalnızca özgün Türkçe hâliyle görür — Romence çeviri müşteri içindir, iç ekibe dönmez
    // (yazan da, öbür iki rol de). Çeviri veritabanında durur; nota erişim değişmedi.
    for (const staff of [U.admin, U.sales, U.drawer]) {
      const own = await seenNote(staff, OA, r.noteId);
      assert.deepEqual([own.text, ...fields(own), own.translationAt], [text, null, null, null, null, null], `${u.name} → ${staff.name}`);
      assert.equal(tr.translationState(own), null);
      assert.ok(!JSON.stringify(await seen(staff, OA)).includes('Am actualizat'), `${staff.name}: Romence çeviri verisinde yok`);
    }
    // Denetimci: yalnızca özgün Türkçe not (Romence çeviri gitmez)
    const insp = await seenNote(U.inspector, OA, r.noteId);
    assert.deepEqual([insp.text, ...fields(insp), insp.translationAt], [text, null, null, null, null, null], u.name);
    // Başka firmanın müşterisi: sipariş kapsamında değil → not da çeviri de yok
    assert.equal(await seen(U.custB, OA), null);
  }
}));

dbTest('çeviri kalıcıdır: sayfa açılışı / yenileme Google\'ı yeniden ÇAĞIRMAZ; tamamlanmış çeviri yeniden yapılamaz', offline(async () => {
  await enable();
  const p = provider();
  const r = await add(U.custA, OA, 'Când va fi gata comanda?', { p });
  assert.equal(p.calls.length, 1);
  const before = JSON.stringify(await rowOf(r.noteId));
  // Sipariş sayfasının okuma yolu (kapsam + notesFor) her rol için birkaç kez: sağlayıcıya dokunulmaz, kayıt değişmez
  for (let i = 0; i < 3; i++) {
    for (const u of [U.admin, U.sales, U.drawer, U.inspector, U.custA]) {
      const n = await seenNote(u, OA, r.noteId);
      assert.equal(n.text, 'Când va fi gata comanda?');
      tr.translationState(n);
    }
  }
  assert.equal(p.calls.length, 1, 'okuma çeviri yapmaz');
  assert.equal(JSON.stringify(await rowOf(r.noteId)), before, 'kayıt okumayla değişmez');
  // Tamamlanmış çeviri "yeniden dene" ile de yeniden istenemez
  assert.deepEqual(await retry(U.admin, r.noteId, OA, p), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(p.calls.length, 1);
  assert.equal(JSON.stringify(await rowOf(r.noteId)), before);
}));

dbTest('çeviri başarısız olursa not YİNE kaydedilir: güvenli kod saklanır, özgün metin durur, okuma yeniden denemez', offline(async () => {
  await enable();
  const cases = [
    [async () => { throw new TranslateError('TIMEOUT'); }, 'TIMEOUT'],
    [async () => { throw new TranslateError('QUOTA', `Google: quota for key ${KEY}`); }, 'QUOTA'],
    [async () => { throw new TranslateError('AUTH'); }, 'AUTH'],
    [async () => { throw new Error(`beklenmeyen hata ${KEY}`); }, 'ERROR'],
    [async () => ({ text: '   ' }), 'BAD_RESPONSE'],
    [async () => null, 'BAD_RESPONSE'],
    [async () => ({ text: 42 }), 'BAD_RESPONSE'],
  ];
  for (const [impl, code] of cases) {
    const p = provider(impl);
    const text = `Müşteriye bilgi: sevkiyat ertelendi (${code})`;
    const r = await add(U.sales, OA, text, { p });
    assert.deepEqual([r.ok, r.translation], [true, 'FAILED'], code);
    const row = await rowOf(r.noteId);
    assert.deepEqual([row.text, row.internal, ...fields(row)], [text, false, null, 'ro', 'FAILED', code], code);
    assert.ok(!JSON.stringify(row).includes(KEY), 'anahtar / dış hata metni nota yazılmaz');
    // İç ekip başarısızlığı görür (güvenli kodla); müşteri notu özgün hâliyle görür, hata bilgisi almaz
    const s = await seenNote(U.admin, OA, r.noteId);
    assert.deepEqual([s.text, s.translationStatus, s.translationError, tr.translationState(s).state], [text, 'FAILED', code, 'failed'], code);
    const c = await seenNote(U.custA, OA, r.noteId);
    assert.deepEqual([c.text, ...fields(c), c.translationAt], [text, null, null, null, null, null], code);
    // Denetimci: özgün notu görür; çeviri hatası / durumu ona gitmez (ekranda "yeniden dene" çizilecek veri yok)
    const insp = await seenNote(U.inspector, OA, r.noteId);
    assert.deepEqual([insp.text, ...fields(insp), insp.translationAt, tr.translationState(insp)], [text, null, null, null, null, null, null], code);
    // Okuma yeniden denemez
    for (let i = 0; i < 3; i++) await seen(U.custA, OA);
    assert.equal(p.calls.length, 1, code);
    assert.equal((await rowOf(r.noteId)).translationStatus, 'FAILED');
  }
  // Müşterinin notunda başarısızlık: not durur, iç ekip özgün metni ve "çevrilemedi" durumunu görür
  const p = provider(async () => { throw new TranslateError('NETWORK'); });
  const r = await add(U.custA, OA, 'Mulțumesc, aștept oferta.', { p });
  assert.deepEqual([r.ok, r.translation], [true, 'FAILED']);
  assert.deepEqual(fields(await seenNote(U.drawer, OA, r.noteId)), [null, 'tr', 'FAILED', 'NETWORK']);
  assert.deepEqual(fields(await seenNote(U.custA, OA, r.noteId)), [null, null, null, null]);
  // Kayıtlı anahtar açılamıyorsa (sunucu sırrı değişmiş): sağlayıcıya gidilmez, not kaydedilir
  const q = provider();
  const bad = await tr.addNote(db, { orderId: OA.id, actor: act(U.admin), text: 'Anahtar açılamıyor', translator: q.fn, secret: 'x'.repeat(40) });
  assert.deepEqual([bad.ok, bad.translation, q.calls.length], [true, 'FAILED', 0]);
  assert.deepEqual(fields(await rowOf(bad.noteId)), [null, 'ro', 'FAILED', 'NO_KEY']);
}));

dbTest('yeniden deneme: yalnızca iç ekip, yalnızca çevrilemeyen not için, tek istek bir çeviri yapar; yetkisiz rol ve başka sipariş reddedilir', offline(async () => {
  await enable();
  const fail = provider(async () => { throw new TranslateError('QUOTA'); });
  const text = 'Camlar perşembe günü yüklenecek';
  const r = await add(U.sales, OA, text, { p: fail });
  assert.equal(r.translation, 'FAILED');
  const ok = provider(async () => ({ text: 'Sticla va fi încărcată joi' }));
  // Müşteri ve denetimci çeviriyi değiştiremez
  for (const u of [U.custA, U.custB, U.inspector]) assert.deepEqual(await retry(u, r.noteId, OA, ok), { ok: false, code: 'FORBIDDEN' }, u.name);
  // Not o siparişe ait değilse / sipariş kullanıcının kapsamında değilse bulunamaz
  assert.deepEqual(await retry(U.sales, r.noteId, OB, ok), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await retry(U.sales, 'yok', OA, ok), { ok: false, code: 'NOT_FOUND' });
  assert.equal(ok.calls.length, 0);
  assert.deepEqual(fields(await rowOf(r.noteId)), [null, 'ro', 'FAILED', 'QUOTA'], 'reddedilen istek hiçbir şeyi değiştirmedi');
  // Çeviri kapalıyken yeniden denenmez
  await enable(false);
  assert.deepEqual(await retry(U.sales, r.noteId, OA, ok), { ok: false, code: 'DISABLED' });
  await enable();
  // Yine başarısız olursa not durur, yeni kod yazılır
  assert.deepEqual(await retry(U.sales, r.noteId, OA, provider(async () => { throw new TranslateError('TIMEOUT'); })), { ok: true, translation: 'FAILED' });
  assert.deepEqual(fields(await rowOf(r.noteId)), [null, 'ro', 'FAILED', 'TIMEOUT']);
  // Aynı anda iki istek: yalnızca biri çeviri yapar
  const both = await Promise.all([retry(U.sales, r.noteId, OA, ok), retry(U.admin, r.noteId, OA, ok)]);
  assert.deepEqual(both.map((x) => (x.ok ? x.translation : x.code)).sort(), ['DONE', 'NOT_ALLOWED']);
  assert.deepEqual(ok.calls.map((c) => [c.text, c.target, c.key]), [[text, 'ro', KEY]], 'özgün metin, aynı yön, tek çağrı');
  const row = await rowOf(r.noteId);
  assert.deepEqual([row.text, ...fields(row)], [text, 'Sticla va fi încărcată joi', 'ro', 'DONE', null]);
  assert.equal((await seenNote(U.custA, OA, r.noteId)).translation, 'Sticla va fi încărcată joi');
  assert.deepEqual(await retry(U.sales, r.noteId, OA, ok), { ok: false, code: 'NOT_ALLOWED' }, 'tamamlanan çeviri yeniden yapılmaz');
  const audits = await db.auditLog.findMany({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: r.noteId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.map((a) => [a.details.result, a.actorRole]).sort(), [['DONE', audits.find((a) => a.details.result === 'DONE').actorRole], ['FAILED', 'SATIS']].sort());
  assert.ok(!JSON.stringify(audits).includes(text), 'denetim kaydına not metni yazılmaz');

  // Yarıda kalmış çeviri (sunucu çeviri sırasında kapandı): 2 dakikadan eskiyse yeniden denenebilir, tazeyse denenemez
  const stale = await db.orderNote.create({ data: { orderId: OA.id, userId: U.sales.id, text: 'Yarıda kaldı', translationLang: 'ro', translationStatus: 'PENDING', translationAt: new Date(Date.now() - tr.STALE_PENDING_MS - 1000) } });
  const fresh = await db.orderNote.create({ data: { orderId: OA.id, userId: U.sales.id, text: 'Sürüyor', translationLang: 'ro', translationStatus: 'PENDING', translationAt: new Date() } });
  assert.deepEqual(await retry(U.drawer, fresh.id, OA, ok), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(await retry(U.drawer, stale.id, OA, ok), { ok: true, translation: 'DONE' });
  // Çevirisi hiç istenmemiş (eski) not ve iç not için yeniden deneme yok
  const old = await db.orderNote.create({ data: { orderId: OA.id, userId: U.custA.id, text: 'Notă veche' } });
  const internal = await db.orderNote.create({ data: { orderId: OA.id, userId: U.sales.id, text: 'iç', internal: true, translationLang: 'ro', translationStatus: 'FAILED' } });
  const calls = ok.calls.length;
  assert.deepEqual(await retry(U.admin, old.id, OA, ok), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(await retry(U.admin, internal.id, OA, ok), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(ok.calls.length, calls);
  await db.orderNote.deleteMany({ where: { id: { in: [internal.id] } } });
}));

dbTest('çeviri kapalıyken: not eskisi gibi kaydedilir, Google çağrılmaz; eski notlar olduğu gibi kalır ve sonradan kendiliğinden çevrilmez', offline(async () => {
  await enable(false);
  const p = provider();
  const r1 = await add(U.custA, OA, 'Notă fără traducere', { p });
  const r2 = await add(U.admin, OA, 'Çevirisiz not', { p });
  assert.deepEqual([r1, r2].map((r) => [r.ok, r.translation]), [[true, null], [true, null]]);
  assert.equal(p.calls.length, 0);
  for (const r of [r1, r2]) {
    const row = await rowOf(r.noteId);
    assert.deepEqual([...fields(row), row.translationAt], [null, null, null, null, null]);
  }
  assert.equal((await seenNote(U.custA, OA, r2.noteId)).text, 'Çevirisiz not');
  assert.equal((await seenNote(U.sales, OA, r1.noteId)).text, 'Notă fără traducere');
  // Ayar satırı hiç yokken / anahtarsız açıkken de aynı
  const saved = await db.integrationSetting.findUniqueOrThrow({ where: { key: 'translate' } });
  await db.integrationSetting.delete({ where: { key: 'translate' } });
  assert.deepEqual(await tr.getTranslateSettings(db), { enabled: false, hasKey: false });
  assert.equal((await add(U.custA, OA, 'Fără setare', { p })).translation, null);
  await db.integrationSetting.create({ data: { key: 'translate', value: { enabled: true, keySealed: null } } });
  assert.equal((await add(U.custA, OA, 'Fără cheie', { p })).translation, null);
  assert.equal(p.calls.length, 0);
  await db.integrationSetting.update({ where: { key: 'translate' }, data: { value: saved.value } });

  // Çeviri açıldıktan sonra: eski notlar okunurken çevrilmez (geriye dönük otomatik çeviri yok)
  await enable();
  for (let i = 0; i < 2; i++) for (const u of [U.admin, U.custA]) await seen(u, OA);
  assert.equal(p.calls.length, 0);
  assert.deepEqual(fields(await rowOf(r1.noteId)), [null, null, null, null]);
  assert.deepEqual(await retry(U.admin, r1.noteId, OA, p), { ok: false, code: 'NOT_ALLOWED' });
}));

dbTest('iç not: çevrilmez, Google\'a gitmez ve müşteriye hiçbir biçimde ulaşmaz (çeviri alanı yanlışlıkla dolu olsa bile)', offline(async () => {
  await enable();
  const p = provider();
  const secret = 'İÇ: müşteriyle fiyatı telefonda konuştuk, indirim %7';
  for (const u of [U.admin, U.sales, U.drawer]) {
    const r = await add(u, OA, `${secret} (${u.name})`, { internal: true, p });
    assert.deepEqual([r.ok, r.translation], [true, null], u.name);
    const row = await rowOf(r.noteId);
    assert.deepEqual([row.internal, ...fields(row), row.translationAt], [true, null, null, null, null, null], u.name);
    assert.equal(await seenNote(U.custA, OA, r.noteId), null, 'müşteri iç notu görmez');
    assert.equal((await seenNote(U.inspector, OA, r.noteId)).text, `${secret} (${u.name})`);
  }
  assert.equal(p.calls.length, 0, 'iç not Google\'a gönderilmez');
  // Müşteri "iç not" işaretleyemez: notu herkese açıktır ve Türkçeye çevrilir
  const c = await add(U.custA, OA, 'Notă publică', { internal: true, p });
  assert.deepEqual([(await rowOf(c.noteId)).internal, c.translation, p.calls.at(-1).target], [false, 'DONE', 'tr']);
  // Savunma: iç notun satırında çeviri alanları dolu olsa bile ne müşteriye gider ne de iç ekibe "çeviri" olarak döner
  const leaky = await db.orderNote.create({ data: { orderId: OA.id, userId: U.sales.id, text: secret, internal: true, translation: 'INTERN: reducere 7%', translationLang: 'ro', translationStatus: 'DONE', translationAt: new Date() } });
  const forCustomer = JSON.stringify(await seen(U.custA, OA));
  assert.ok(!forCustomer.includes('telefonda') && !forCustomer.includes('reducere 7%') && !forCustomer.includes(leaky.id));
  assert.deepEqual(fields(await seenNote(U.admin, OA, leaky.id)), [null, null, null, null]);
  await db.orderNote.delete({ where: { id: leaky.id } });
}));

dbTest('firmalar arası gizlilik ve sipariş kapsamı: başka firmanın siparişine not yazılamaz, notu / çevirisi görülemez; Google çağrılmaz', offline(async () => {
  await enable();
  const p = provider();
  const count = () => db.orderNote.count();
  const n0 = await count();
  // Başka firmanın müşterisi, satışın kapsamı dışındaki profil siparişi, çizimin kapsamı dışındaki sipariş, silinmiş sipariş
  assert.deepEqual(await add(U.custB, OA, 'Nu este comanda mea', { p }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(U.custA, OB, 'Nu este comanda mea', { p }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(U.sales, OP, 'Satış profil siparişini görmez', { p }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(U.drawer, ONODRAW, 'Çizim gerekmeyen sipariş', { p }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(U.custA, { id: 'olmayan-siparis' }, 'x', { p }), { ok: false, code: 'NOT_FOUND' });
  await db.order.update({ where: { id: ONODRAW.id }, data: { removedAt: new Date() } });
  assert.deepEqual(await add(U.custA, ONODRAW, 'Silinmiş sipariş', { p }), { ok: false, code: 'NOT_FOUND' });
  await db.order.update({ where: { id: ONODRAW.id }, data: { removedAt: null } });
  // Denetimci not yazamaz; boş not kaydedilmez
  assert.deepEqual(await add(U.inspector, OA, 'Denetimci yazamaz', { p }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await add({ ...U.custA, appRole: 'BILINMEYEN' }, OA, 'x', { p }), { ok: false, code: 'FORBIDDEN' });
  for (const empty of ['', '   \n ', null, undefined]) assert.deepEqual(await add(U.custA, OA, empty, { p }), { ok: false, code: 'EMPTY' });
  assert.deepEqual([await count(), p.calls.length], [n0, 0], 'reddedilen isteklerde not yazılmadı, Google çağrılmadı');

  // B firmasının kendi siparişindeki yazışma: A firması hiçbirini göremez (not, çeviri, kimlik); tersi de geçerli
  const b1 = await add(U.custB, OB, 'Mesaj confidențial al firmei Beta', { p });
  const b2 = await add(U.admin, OB, 'Beta firmasına özel yanıt', { p });
  assert.deepEqual([b1.translation, b2.translation], ['DONE', 'DONE']);
  assert.equal(await seen(U.custA, OB), null);
  const mine = JSON.stringify(await seen(U.custA, OA));
  for (const s of ['confidențial', 'Beta firmasına', b1.noteId, b2.noteId, OB.id, '[ro] Beta', '[tr] Mesaj']) assert.ok(!mine.includes(s), s);
  const theirs = JSON.stringify(await seen(U.custB, OB));
  assert.ok(theirs.includes('[ro] Beta firmasına özel yanıt') && !theirs.includes(OA.id) && !theirs.includes('1200 mm'));
  // Yönetici profil siparişine not yazar (satıştan geçmez): çeviri aynı kuralla; müşteri görür, satış ve çizim görmez
  const pr = await add(U.admin, OP, 'Profil siparişiniz depoda', { p });
  assert.equal((await seenNote(U.custA, OP, pr.noteId)).translation, '[ro] Profil siparişiniz depoda');
  assert.equal(await seen(U.sales, OP), null);
  assert.equal(await seen(U.drawer, OP), null);
}));

dbTest('ayar ve anahtar: yalnızca yönetici değiştirir / dener; anahtar şifreli saklanır, hiçbir kayıtta ve yanıtta açık hâli yoktur', offline(async () => {
  await enable(false);
  const row = () => db.integrationSetting.findUniqueOrThrow({ where: { key: 'translate' } });
  const before = JSON.stringify((await row()).value);
  // Yetkisiz roller ayarı değiştiremez, bağlantıyı deneyemez
  const p = provider();
  for (const u of [U.sales, U.drawer, U.inspector, U.custA]) {
    assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { key: `${KEY}-baska`, secret: SECRET }, act(u)), { ok: false, code: 'FORBIDDEN' }, u.name);
    assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: false }, { clearKey: true, secret: SECRET }, act(u)), { ok: false, code: 'FORBIDDEN' }, u.name);
    assert.deepEqual(await tr.testTranslation(db, { actor: act(u), translator: p.fn, secret: SECRET }), { ok: false, code: 'FORBIDDEN' }, u.name);
  }
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { secret: SECRET }, undefined), { ok: false, code: 'FORBIDDEN' });
  assert.equal(JSON.stringify((await row()).value), before);
  assert.equal(p.calls.length, 0);

  // Anahtar: şifreli; ekrana dönen ayar yalnızca "açık mı / anahtar kayıtlı mı"
  const v = (await row()).value;
  assert.ok(typeof v.keySealed === 'string' && v.keySealed.startsWith('v1:') && !JSON.stringify(v).includes(KEY));
  assert.equal(openSecret(v.keySealed, SECRET, 'translate-key'), KEY);
  assert.equal(openSecret(v.keySealed, 'x'.repeat(40), 'translate-key'), null, 'sunucu sırrı olmadan açılamaz');
  assert.equal(openSecret(v.keySealed, SECRET, 'fgo-key'), null, 'başka amaçla açılamaz');
  assert.deepEqual(await tr.getTranslateSettings(db), { enabled: false, hasKey: true });
  // Boş anahtar kayıtlı olanı korur; geçersiz biçim reddedilir; anahtarsız açılamaz
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { key: '', secret: SECRET }, act(U.admin)), { ok: true });
  assert.equal(openSecret((await row()).value.keySealed, SECRET, 'translate-key'), KEY);
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { key: 'kısa anahtar', secret: SECRET }, act(U.admin)), { ok: false, code: 'KEY_FORMAT' });
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { clearKey: true, secret: SECRET }, act(U.admin)), { ok: false, code: 'KEY' });
  assert.deepEqual(await tr.getTranslateSettings(db), { enabled: true, hasKey: true }, 'reddedilen kayıt ayarı değiştirmedi');

  // Bağlantı denemesi (yönetici): zararsız ifade, hiçbir not okunmaz; hata kodu + anahtarsız ayrıntı
  const notes = await db.orderNote.count();
  assert.deepEqual(await tr.testTranslation(db, { actor: act(U.admin), translator: p.fn, secret: SECRET }), { ok: true, sample: '[tr] Bună ziua' });
  assert.deepEqual(p.calls.map((c) => [c.text, c.target, c.key]), [[tr.TEST_PHRASE, 'tr', KEY]]);
  const failing = provider(async () => { throw new TranslateError('AUTH', 'API key not valid. Please pass a valid API key.'); });
  assert.deepEqual(await tr.testTranslation(db, { actor: act(U.admin), translator: failing.fn, secret: SECRET }), { ok: false, code: 'AUTH', detail: 'API key not valid. Please pass a valid API key.' });
  assert.deepEqual(await tr.testTranslation(db, { actor: act(U.admin), translator: provider(async () => { throw new Error('x'); }).fn, secret: SECRET }), { ok: false, code: 'ERROR' });
  assert.equal(await db.orderNote.count(), notes);
  // Anahtar silinir: çeviri kapanır, deneme "anahtar yok" der, sağlayıcı çağrılmaz
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: false }, { clearKey: true, secret: SECRET }, act(U.admin)), { ok: true });
  assert.deepEqual(await tr.getTranslateSettings(db), { enabled: false, hasKey: false });
  assert.deepEqual(await tr.testTranslation(db, { actor: act(U.admin), translator: p.fn, secret: SECRET }), { ok: false, code: 'NO_KEY' });
  assert.equal(p.calls.length, 1);

  // Denetim kayıtları: ayar değişiklikleri ve denemeler yazıldı; hiçbirinde anahtar (açık ya da şifreli) yok
  const audits = await db.auditLog.findMany({ where: { entityType: 'IntegrationSetting', entityId: 'translate' } });
  assert.ok(audits.some((a) => a.action === 'SETTINGS_UPDATE' && a.details.keyCleared === true));
  assert.ok(audits.some((a) => a.action === 'SETTINGS_UPDATE' && a.details.keyChanged === true));
  assert.deepEqual(audits.filter((a) => a.action === 'TRANSLATE_TEST').map((a) => [a.details.ok, a.details.code]).sort(), [[false, 'AUTH'], [false, 'ERROR'], [false, 'NO_KEY'], [true, null]].sort());
  const dump = JSON.stringify(audits);
  assert.ok(!dump.includes(KEY) && !dump.includes('v1:') && !dump.includes('keySealed'));
  assert.ok(audits.every((a) => a.actorRole === 'ADMIN'));
}));

dbTest('çeviri özgün metinle aynıysa (not zaten hedef dilde): "aynı" olarak işaretlenir, ayrıca gösterilmez', offline(async () => {
  await enable();
  const p = provider(async ({ text }) => ({ text: `  ${text.toUpperCase()}  ` }));
  const r = await add(U.custA, OA, 'tamam', { p });
  assert.deepEqual([r.ok, r.translation], [true, 'SAME']);
  assert.deepEqual(fields(await rowOf(r.noteId)), [null, 'tr', 'SAME', null]);
  for (const u of [U.admin, U.custA]) assert.equal((await seenNote(u, OA, r.noteId)).translation, null);
  assert.equal(tr.translationState(await seenNote(U.admin, OA, r.noteId)).state, 'same');
  assert.deepEqual(await retry(U.admin, r.noteId, OA, p), { ok: false, code: 'NOT_ALLOWED' });
  // Son 7 günün çevrilemeyen not sayısı (Entegrasyonlar ekranı) yalnızca FAILED kayıtları sayar
  const failed = await db.orderNote.count({ where: { translationStatus: 'FAILED' } });
  assert.equal(await tr.failedTranslations(db), failed);
  assert.equal(await tr.failedTranslations(db, { now: new Date(Date.now() + 8 * 86_400_000) }), 0);
}));

dbTest('sayfa açılışı / yenileme / otomatik yenileme hiçbir durumda çeviri isteği yapmaz: DONE, SAME, FAILED, yarıda kalmış ve çevirisiz (eski) notlar okunurken aynen kalır', offline(async () => {
  await enable();
  // Ayrı bir siparişte her durumdan bir not
  const O = await db.order.create({ data: { orderNo: 'ALF9', customerOrderNo: 9, title: 'Yenileme', orderTypeCode: 'GLASS_ORDER', customerId: A.id, createdById: U.admin.id, status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI' } });
  const p = provider(async ({ text, target }) => {
    if (text.includes('HATA')) throw new TranslateError('QUOTA');
    if (text.includes('AYNI')) return { text };
    return { text: `[${target}] ${text}` };
  });
  const done = await add(U.custA, O, 'Notă tradusă', { p });
  const doneRo = await add(U.sales, O, 'Çevrilmiş not', { p });
  const same = await add(U.custA, O, 'AYNI tamam', { p });
  const failed = await add(U.custA, O, 'HATA notă', { p });
  const failedRo = await add(U.admin, O, 'HATA not', { p });
  assert.deepEqual([done, doneRo, same, failed, failedRo].map((r) => r.translation), ['DONE', 'DONE', 'SAME', 'FAILED', 'FAILED']);
  const stale = await db.orderNote.create({ data: { orderId: O.id, userId: U.custA.id, text: 'Yarıda kalmış', translationLang: 'tr', translationStatus: 'PENDING', translationAt: new Date(Date.now() - 10 * 60_000) } });
  const historical = await db.orderNote.create({ data: { orderId: O.id, userId: U.custA.id, text: 'Notă veche, fără traducere', createdAt: new Date('2026-09-01T08:00:00Z') } });
  const historicalStaff = await db.orderNote.create({ data: { orderId: O.id, userId: U.sales.id, text: 'Eski, çevirisiz ekip notu', createdAt: new Date('2026-09-01T09:00:00Z') } });
  const internal = await add(U.sales, O, 'İç not: çevrilmez', { internal: true, p });
  const calls = p.calls.length;
  assert.equal(calls, 5, 'yalnızca not yazılırken, çevrilebilir not başına bir kez');
  const snapshot = async () => JSON.stringify(await db.orderNote.findMany({ where: { orderId: O.id }, orderBy: { id: 'asc' } }));
  const before = await snapshot();

  // Sipariş sayfasının okuma yolu (kapsam + notesFor + ekran durumu), her rol için 10 kez — tarayıcı yenilemesi,
  // 60 saniyelik otomatik yenileme ve sunucu bileşeninin yeniden çizimi tam olarak bunu çalıştırır
  for (let i = 0; i < 10; i++) {
    for (const u of [U.admin, U.sales, U.drawer, U.inspector, U.custA]) {
      for (const n of await seen(u, O)) tr.translationState(n, new Date(Date.now() + i * 60_000));
    }
    // Entegrasyonlar ekranının okudukları da çeviri yapmaz
    await tr.getTranslateSettings(db);
    await tr.failedTranslations(db);
  }
  assert.equal(p.calls.length, calls, 'okuma sağlayıcıyı çağırmadı');
  assert.equal(await snapshot(), before, 'hiçbir not değişmedi: FAILED yeniden denenmedi, SAME / DONE yeniden çevrilmedi, eski notlar çevrilmedi');

  // Durum durum: eski notlar çevirisiz; FAILED / yarıda kalan olduğu gibi; DONE / SAME sabit
  const row = async (id) => fields(await rowOf(id));
  assert.deepEqual(await row(historical.id), [null, null, null, null]);
  assert.deepEqual(await row(historicalStaff.id), [null, null, null, null]);
  assert.deepEqual(await row(failed.noteId), [null, 'tr', 'FAILED', 'QUOTA']);
  assert.deepEqual(await row(failedRo.noteId), [null, 'ro', 'FAILED', 'QUOTA']);
  assert.deepEqual(await row(stale.id), [null, 'tr', 'PENDING', null]);
  assert.deepEqual(await row(same.noteId), [null, 'tr', 'SAME', null]);
  assert.deepEqual(await row(done.noteId), ['[tr] Notă tradusă', 'tr', 'DONE', null]);
  assert.deepEqual(await row(internal.noteId), [null, null, null, null]);

  // Görünürlük, aynı notlar üzerinde: denetimci hepsini (iç not dahil) yalnızca özgün metinle görür
  const insp = await seen(U.inspector, O);
  assert.equal(insp.length, 9);
  assert.ok(insp.every((n) => fields(n).every((x) => x === null) && n.translationAt === null && tr.translationState(n) === null));
  assert.deepEqual(insp.map((n) => n.text).sort(), ['AYNI tamam', 'Eski, çevirisiz ekip notu', 'HATA not', 'HATA notă', 'Notă tradusă', 'Notă veche, fără traducere', 'Yarıda kalmış', 'Çevrilmiş not', 'İç not: çevrilmez'].sort());
  for (const leak of ['[tr] ', '[ro] ', 'QUOTA', 'FAILED', 'PENDING']) assert.ok(!JSON.stringify(insp).includes(leak), `denetimci: ${leak}`);
  // Müşteri: iç not yok; yalnızca ekibin çevrilmiş notunun Romencesi; hata / bekleme bilgisi yok
  const cust = await seen(U.custA, O);
  assert.equal(cust.length, 8);
  assert.deepEqual(cust.filter((n) => n.translation).map((n) => [n.text, n.translation]), [['Çevrilmiş not', '[ro] Çevrilmiş not']]);
  for (const leak of ['İç not', 'QUOTA', 'FAILED', 'PENDING', '[tr] ']) assert.ok(!JSON.stringify(cust).includes(leak), `müşteri: ${leak}`);
  // Yönetici: çeviriler + çevrilemeyen iki not + yarıda kalan (yeniden denenebilir olarak işaretli)
  const adm = await seen(U.admin, O);
  assert.deepEqual(adm.filter((n) => tr.translationState(n)?.state === 'failed').map((n) => n.text).sort(), ['HATA not', 'HATA notă', 'Yarıda kalmış'].sort());
  // İç ekip (karar 130): yalnızca müşteri notunun Türkçesini alır; kendi notunun Romence çevirisi ona dönmez — ama
  // çevrilemeyen KENDİ notunun durumu döner (yukarıdaki 'HATA not'), yoksa müşteriye çeviri hiç gidemezdi
  for (const u of [U.admin, U.sales, U.drawer]) {
    const mine = await seen(u, O);
    assert.deepEqual(mine.filter((n) => n.translation).map((n) => [n.text, n.translation]), [['Notă tradusă', '[tr] Notă tradusă']], u.name);
    assert.ok(!JSON.stringify(mine).includes('[ro] '), `${u.name}: Romence çeviri iç ekibe gitmez`);
    assert.deepEqual(fields(mine.find((n) => n.text === 'Çevrilmiş not')), [null, null, null, null], u.name);
    assert.deepEqual(fields(mine.find((n) => n.text === 'HATA not')), [null, 'ro', 'FAILED', 'QUOTA'], u.name);
  }

  // DONE ve SAME açık istekle de yeniden çevrilemez; denetimci ve müşteri hiçbir notta yeniden deneyemez
  for (const id of [done.noteId, doneRo.noteId, same.noteId, historical.id, internal.noteId]) assert.deepEqual(await retry(U.admin, id, O, p), { ok: false, code: 'NOT_ALLOWED' });
  for (const u of [U.inspector, U.custA]) for (const id of [failed.noteId, failedRo.noteId, stale.id]) assert.deepEqual(await retry(u, id, O, p), { ok: false, code: 'FORBIDDEN' });
  assert.equal(p.calls.length, calls);
  assert.equal(await snapshot(), before);
  // FAILED yalnızca yetkili iç ekibin AÇIK isteğiyle yeniden denenir (bir kez)
  const ok = provider();
  assert.deepEqual(await retry(U.drawer, failed.noteId, O, ok), { ok: true, translation: 'DONE' });
  assert.deepEqual([ok.calls.length, await row(failed.noteId)], [1, ['[tr] HATA notă', 'tr', 'DONE', null]]);
  assert.deepEqual(await row(failedRo.noteId), [null, 'ro', 'FAILED', 'QUOTA'], 'öbür çevrilemeyen not kendiliğinden denenmedi');
}));
