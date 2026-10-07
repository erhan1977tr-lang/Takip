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
const { NOTE_LIMITS, createNoteLimits } = await import('../../server/notes/limits.js');
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
// Sınır sayaçları (karar 147): çeviri testleri her çağrıda TAZE sayaç kullanır (sınırlar bu testlerin konusu değil);
// sınır testleri kendi ortak sayacını `limits` ile verir.
const add = (u, order, text, { internal = false, p = provider(), now = undefined, limits = createNoteLimits() } = {}) =>
  tr.addNote(db, { orderId: order.id, actor: act(u), text, internal, translator: p.fn, secret: SECRET, limits, ...(now ? { now } : {}) });
const retry = (u, noteId, order, p = provider(), extra = {}) =>
  tr.retryNoteTranslation(db, { noteId, orderId: order.id, actor: act(u), translator: p.fn, secret: SECRET, limits: createNoteLimits(), ...extra });
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

// ───────── Not ve çeviri sınırları (karar 147; güvenlik denetimi 3.50.9 AUD-9) ─────────
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const at = (ms) => new Date(T0 + ms);
let seq = 100;
const newOrder = (f = A, extra = {}) => {
  seq += 1;
  return db.order.create({ data: { orderNo: `${f.prefix}${seq}`, customerOrderNo: seq, title: `Sınır ${seq}`, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: U.admin.id, status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI', ...extra } });
};
const noteCount = (order, where = {}) => db.orderNote.count({ where: { orderId: order.id, ...where } });
const seed = (order, n, user = U.custA, extra = {}) => db.orderNote.createMany({ data: Array.from({ length: n }, (_, i) => ({ orderId: order.id, userId: user.id, text: `eski not ${i + 1}`, ...extra })) });
const codes = (rs) => rs.map((r) => (r.ok ? 'ok' : r.code));
const tally = (list, v) => list.filter((x) => x === v).length;
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

dbTest('not hızı: müşteri 10 dakikada 20 not (21. reddedilir, yazılmaz), pencere sonrası yeniden; iç ekip 60 / 61; sınır kullanıcıya özeldir', offline(async () => {
  await enable(false);
  const O = await newOrder();
  const limits = createNoteLimits();
  const rs = [];
  for (let i = 0; i < 21; i++) rs.push(await add(U.custA, O, `Nota ${i + 1}`, { limits, now: at(i * 1000) }));
  assert.deepEqual([tally(codes(rs), 'ok'), rs[20]], [20, { ok: false, code: 'RATE_LIMIT' }]);
  assert.equal(await noteCount(O), 20, '21. not yazılmadı');
  assert.equal(await noteCount(O, { text: 'Nota 21' }), 0);
  // Pencere dolmadan: hâlâ kapalı (başka siparişte de — hak kullanıcınındır)
  const O2 = await newOrder();
  assert.deepEqual(await add(U.custA, O2, 'x', { limits, now: at(9 * MIN + 59_000) }), { ok: false, code: 'RATE_LIMIT' });
  assert.equal(await noteCount(O2), 0);
  // Başka firmanın müşterisi kendi siparişinde, iç ekip aynı siparişte etkilenmez
  const OB2 = await newOrder(B);
  assert.equal((await add(U.custB, OB2, 'Altă firmă', { limits, now: at(30_000) })).ok, true);
  assert.equal((await add(U.sales, O, 'Ekip notu', { limits, now: at(30_000) })).ok, true);
  // İlk notlar 10 dakikayı doldurunca yeniden kabul; bütün pencere geçince 20 hak yeniden
  assert.equal((await add(U.custA, O, 'Nota după fereastră', { limits, now: at(10 * MIN) })).ok, true);
  const again = [];
  for (let i = 0; i < 21; i++) again.push(await add(U.custA, O, `Runda 2 – ${i + 1}`, { limits, now: at(25 * MIN + i) }));
  assert.deepEqual([tally(codes(again), 'ok'), tally(codes(again), 'RATE_LIMIT')], [20, 1]);
  assert.equal(await noteCount(O, { userId: U.custA.id }), 41);

  // İç ekip: 60 kabul, 61. ret (iç not da sayılır); her kullanıcı ayrı
  for (const u of [U.admin, U.sales, U.drawer]) {
    const S = await newOrder();
    const l = createNoteLimits();
    const out = [];
    for (let i = 0; i < 61; i++) out.push(await add(u, S, `Not ${i + 1}`, { limits: l, now: at(i * 100), internal: i % 3 === 0 }));
    assert.deepEqual([tally(codes(out), 'ok'), out[60]], [60, { ok: false, code: 'RATE_LIMIT' }], u.name);
    assert.equal(await noteCount(S), 60, u.name);
    assert.equal((await add(u, S, 'Pencere sonrası', { limits: l, now: at(10 * MIN + 6100) })).ok, true, u.name);
  }
  // Denetimci not yazamaz (yetki değişmedi)
  assert.deepEqual(await add(U.inspector, O, 'x', { limits }), { ok: false, code: 'FORBIDDEN' });
}));

dbTest('paralel isteklerle not hızı sınırı aşılamaz: aynı kullanıcıdan aynı anda 60 istek → veritabanında tam 20 not', offline(async () => {
  await enable(false);
  const O = await newOrder();
  const O2 = await newOrder();
  const limits = createNoteLimits();
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => add(U.custA, i % 2 ? O : O2, `Paralel ${i}`, { limits, now: at(0) })));
  assert.deepEqual([tally(codes(rs), 'ok'), tally(codes(rs), 'RATE_LIMIT')], [20, 40]);
  assert.equal(await noteCount(O) + await noteCount(O2), 20);
}));

dbTest('sipariş başına 500 not: 500. yazılır, 501. reddedilir (her rol, iç not dahil); başka sipariş etkilenmez; dolu siparişte sağlayıcı çağrılmaz', offline(async () => {
  await enable();
  assert.equal(NOTE_LIMITS.perOrder, 500);
  const O = await newOrder();
  await seed(O, 300);
  await seed(O, 198, U.sales, { internal: true });
  const p = provider();
  assert.deepEqual(await add(U.custA, O, 'Nota 499', { p }).then((r) => [r.ok, r.translation]), [true, 'DONE']);
  assert.deepEqual(await add(U.sales, O, '500. not (iç)', { p, internal: true }).then((r) => [r.ok, r.translation]), [true, null]);
  assert.equal(await noteCount(O), 500);
  const calls = p.calls.length;
  for (const u of [U.custA, U.admin, U.sales, U.drawer]) {
    assert.deepEqual(await add(u, O, '501. not', { p }), { ok: false, code: 'ORDER_LIMIT' }, u.name);
    assert.deepEqual(await add(u, O, '501. iç not', { p, internal: true }), { ok: false, code: 'ORDER_LIMIT' }, u.name);
  }
  assert.deepEqual([await noteCount(O), await noteCount(O, { text: { startsWith: '501.' } }), p.calls.length], [500, 0, calls], 'yazılmadı, sağlayıcı çağrılmadı');
  // Başka sipariş ve başka firmanın siparişi etkilenmez; başka firmanın müşterisi dolu siparişi yine GÖREMEZ (NOT_FOUND)
  assert.equal((await add(U.custA, await newOrder(), 'Altă comandă', { p })).ok, true);
  assert.equal((await add(U.custB, await newOrder(B), 'Altă firmă', { p })).ok, true);
  assert.deepEqual(await add(U.custB, O, 'x', { p }), { ok: false, code: 'NOT_FOUND' });
  // Dolu siparişin notları okunur; "yeniden dene" (not yazmaz) çalışmaya devam eder
  assert.equal((await seen(U.custA, O)).length, 301, 'müşteri: 300 eski + kendi notu (iç notlar yok)');
  const failed = await db.orderNote.findFirstOrThrow({ where: { orderId: O.id, internal: false, userId: U.custA.id, text: 'eski not 1' } });
  await db.orderNote.update({ where: { id: failed.id }, data: { translationLang: 'tr', translationStatus: 'FAILED', translationError: 'RATE_LIMIT', translationAt: new Date() } });
  assert.deepEqual(await retry(U.sales, failed.id, O, p), { ok: true, translation: 'DONE' });
  assert.equal(await noteCount(O), 500);
}));

dbTest('paralel isteklerle sipariş sınırı aşılamaz: 490 notlu siparişe farklı kullanıcılardan aynı anda 24 istek → tam 10 not, toplam 500', offline(async () => {
  await enable();
  const O = await newOrder();
  await seed(O, 490);
  const p = provider();
  const users = [U.custA, U.admin, U.sales, U.drawer];
  // Her istek kendi sayacıyla (kullanıcı hızı devre dışı): yalnızca sipariş sınırı sınanır
  const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => add(users[i % 4], O, `Paralel ${i}`, { p, internal: i % 4 === 2 && i % 8 === 2 })));
  assert.deepEqual([tally(codes(rs), 'ok'), tally(codes(rs), 'ORDER_LIMIT')], [10, 14]);
  assert.equal(await noteCount(O), 500, 'sınırın üstüne çıkılmadı');
  // Sağlayıcı yalnızca yazılan, müşteriye açık notlar için çağrıldı
  const written = await db.orderNote.findMany({ where: { orderId: O.id, text: { startsWith: 'Paralel ' } } });
  assert.deepEqual([written.length, p.calls.length], [10, written.filter((n) => !n.internal).length]);
  // Bir daha: sınırdaki siparişe 12 paralel istek → hiçbiri yazılmaz
  const more = await Promise.all(Array.from({ length: 12 }, (_, i) => add(users[i % 4], O, `Fazla ${i}`, { p })));
  assert.deepEqual([tally(codes(more), 'ORDER_LIMIT'), await noteCount(O)], [12, 500]);
}));

dbTest('sipariş sınırı kilitle korunur: siparişin kilidi başka işlemdeyken not yazımı BEKLER; kilit bırakılınca güncel sayıya göre karar verir (499 → 500 olduysa reddedilir)', offline(async () => {
  await enable(false);
  const O = await newOrder();
  await seed(O, 499);
  const key = `order-notes:${O.id}`;
  /** Bu siparişin kilidini bekleyen (henüz alamamış) oturum sayısı */
  const waiting = async () => (await db.$queryRaw`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`)[0].n;
  let release;
  const gate = new Promise((r) => { release = r; });
  let locked;
  const isLocked = new Promise((r) => { locked = r; });
  // Başka bir işlem siparişin kilidini tutuyor ve (bırakmadan önce) 500. notu yazacak
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    locked();
    await gate;
    await tx.orderNote.create({ data: { orderId: O.id, userId: U.admin.id, text: '500. not (kilidi tutan işlem)' } });
  }, { timeout: 30_000 });
  await isLocked;
  let done = false;
  const pending = add(U.custA, O, 'Nota care așteaptă').then((r) => { done = true; return r; });
  // Not yazımı kilitte bekliyor: veritabanı bekleyen oturumu gösterene kadar bakılır (en çok 10 sn)
  let seenWaiting = 0;
  for (let i = 0; i < 200 && !seenWaiting && !done; i++) {
    seenWaiting = await waiting();
    if (!seenWaiting) await new Promise((r) => setTimeout(r, 50));
  }
  try {
    assert.equal(done, false, 'not yazımı kilidi beklemeden bitmemeli');
    assert.equal(seenWaiting, 1, 'not yazımı siparişin kilidinde bekliyor');
    assert.equal(await noteCount(O), 499, 'beklerken hiçbir şey yazılmadı');
  } finally {
    release();
    await holder;
  }
  // Kilit bırakıldı: bekleyen istek GÜNCEL sayıyı (500) görür ve reddedilir — eski sayıyla (499) yazsaydı 501 olurdu
  assert.deepEqual(await pending, { ok: false, code: 'ORDER_LIMIT' });
  assert.deepEqual([await noteCount(O), await noteCount(O, { text: 'Nota care așteaptă' }), await waiting()], [500, 0, 0]);
  // Kilit siparişe özeldir: başka siparişin kilidi tutulurken bu siparişe yazım beklemez
  const P = await newOrder();
  const Q = await newOrder();
  let free;
  const hold2 = new Promise((r) => { free = r; });
  let got;
  const has2 = new Promise((r) => { got = r; });
  const other = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-notes:${P.id}`}, 0))`;
    got();
    await hold2;
  }, { timeout: 30_000 });
  await has2;
  try {
    assert.equal((await add(U.custA, Q, 'Altă comandă, fără așteptare')).ok, true);
  } finally {
    free();
    await other;
  }
}));

dbTest('müşteri çevirisi: saatte 30 sağlayıcı çağrısı — sonraki notlar YİNE kaydedilir, sağlayıcı çağrılmaz; iç ekip nedeni görür, müşteri / denetimci görmez; okuma yeniden denemez; iç ekip sonra "yeniden dene" ile çevirtir', offline(async () => {
  await enable();
  const O = await newOrder();
  const limits = createNoteLimits();
  const p = provider();
  const a = [];
  for (let i = 0; i < 20; i++) a.push(await add(U.custA, O, `Nota ${i + 1}`, { p, limits, now: at(i * 1000) }));
  const b = [];
  for (let i = 0; i < 20; i++) b.push(await add(U.custA, O, `Nota ${i + 21}`, { p, limits, now: at(11 * MIN + i * 1000) }));
  assert.equal(tally(codes([...a, ...b]), 'ok'), 40, 'çeviri sınırı notu engellemez: 40 notun hepsi kabul');
  assert.deepEqual([...a, ...b].map((r) => r.translation), [...Array(30).fill('DONE'), ...Array(10).fill('FAILED')]);
  assert.equal(p.calls.length, 30, 'tam 30 sağlayıcı çağrısı');
  assert.deepEqual(p.calls.map((c) => c.text), Array.from({ length: 30 }, (_, i) => `Nota ${i + 1}`));
  assert.equal(await noteCount(O), 40);
  const limited = await db.orderNote.findMany({ where: { orderId: O.id, translationError: 'RATE_LIMIT' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(limited.map((n) => [n.text, n.internal, ...fields(n)]), Array.from({ length: 10 }, (_, i) => [`Nota ${i + 31}`, false, null, 'tr', 'FAILED', 'RATE_LIMIT']));
  const id = limited[0].id;
  // İç ekip: özgün not + "çevrilemedi" durumu ve güvenli kod (yeniden denenebilir)
  for (const u of [U.admin, U.sales, U.drawer]) {
    const n = await seenNote(u, O, id);
    assert.deepEqual([n.text, ...fields(n), tr.translationState(n)], ['Nota 31', null, 'tr', 'FAILED', 'RATE_LIMIT', { state: 'failed', code: 'RATE_LIMIT' }], u.name);
  }
  // Müşteri ve denetimci: yalnızca özgün not; durum / kod / "RATE_LIMIT" verilerinde yok
  for (const u of [U.custA, U.inspector]) {
    const n = await seenNote(u, O, id);
    assert.deepEqual([n.text, ...fields(n), n.translationAt, tr.translationState(n)], ['Nota 31', null, null, null, null, null, null], u.name);
    const all = JSON.stringify(await seen(u, O));
    for (const leak of ['RATE_LIMIT', 'FAILED']) assert.ok(!all.includes(leak), `${u.name}: ${leak}`);
  }
  assert.equal(await seen(U.custB, O), null, 'başka firma siparişi göremez');
  // Okuma (sayfa açılışı / yenileme) sağlayıcıyı çağırmaz, kayıt değişmez
  const snapshot = async () => JSON.stringify(await db.orderNote.findMany({ where: { orderId: O.id }, orderBy: { id: 'asc' } }));
  const before = await snapshot();
  for (let i = 0; i < 5; i++) {
    for (const u of [U.admin, U.sales, U.drawer, U.inspector, U.custA]) for (const n of await seen(u, O)) tr.translationState(n, at(12 * MIN + i * MIN));
    await tr.failedTranslations(db);
  }
  assert.deepEqual([p.calls.length, await snapshot()], [30, before]);
  // Başka müşteri kullanıcısının hakkı ayrıdır; iç ekibin notu müşteri çeviri sınırına takılmaz
  assert.equal((await add(U.custB, await newOrder(B), 'Altă firmă', { p, limits, now: at(11 * MIN + 30_000) })).translation, 'DONE');
  assert.equal((await add(U.sales, O, 'Ekip notu', { p, limits, now: at(11 * MIN + 30_000) })).translation, 'DONE');
  assert.equal(p.calls.length, 32);
  // Müşteri ve denetimci yeniden deneyemez; iç ekip dener → çevrilir (tek çağrı); öteki notlar kendiliğinden denenmez
  for (const u of [U.custA, U.custB, U.inspector]) assert.deepEqual(await retry(u, id, O, p, { limits }), { ok: false, code: 'FORBIDDEN' }, u.name);
  assert.equal(p.calls.length, 32);
  assert.deepEqual(await retry(U.sales, id, O, p, { limits, now: at(12 * MIN) }), { ok: true, translation: 'DONE' });
  assert.deepEqual([p.calls.length, fields(await rowOf(id))], [33, ['[tr] Nota 31', 'tr', 'DONE', null]]);
  assert.equal(await noteCount(O, { translationError: 'RATE_LIMIT', translationStatus: 'FAILED' }), 9);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: id } });
  assert.deepEqual([audit.details.before, audit.details.beforeError, audit.details.result], ['FAILED', 'RATE_LIMIT', 'DONE']);
  // İlk çağrıların üzerinden bir saat geçince müşterinin çeviri hakkı yeniden açılır
  assert.equal((await add(U.custA, O, 'Nota după o oră', { p, limits, now: at(61 * MIN) })).translation, 'DONE');
}));

dbTest('paralel müşteri notları çeviri sınırını aşamaz; sağlayıcı hatası notu kaybettirmez ve hakkı harcar; iç not sağlayıcıyı çağırmaz', offline(async () => {
  await enable();
  const O = await newOrder();
  // Not hızı bu testte geniş (yalnızca çeviri sınırı sınanır)
  const wide = { ...NOTE_LIMITS, customerNotes: { limit: 1000, windowMs: 10 * MIN } };
  const limits = createNoteLimits(wide);
  const p = provider();
  const rs = await Promise.all(Array.from({ length: 36 }, (_, i) => add(U.custA, O, `Paralel ${i}`, { p, limits, now: at(0) })));
  assert.equal(tally(codes(rs), 'ok'), 36, 'hepsi kaydedildi');
  assert.deepEqual([tally(rs.map((r) => r.translation), 'DONE'), tally(rs.map((r) => r.translation), 'FAILED'), p.calls.length], [30, 6, 30]);
  assert.deepEqual([await noteCount(O), await noteCount(O, { translationStatus: 'DONE' }), await noteCount(O, { translationStatus: 'FAILED', translationError: 'RATE_LIMIT' })], [36, 30, 6]);
  // Sağlayıcı hatası: not durur (güvenli kod), çağrı sayılır; sınırdan sonra sağlayıcı çağrılmaz
  const O2 = await newOrder();
  const l2 = createNoteLimits(wide);
  const failing = provider(async () => { throw new TranslateError('QUOTA', `Google: quota for key ${KEY}`); });
  const out = await quiet(async () => { const list = []; for (let i = 0; i < 33; i++) list.push(await add(U.custA, O2, `Eroare ${i + 1}`, { p: failing, limits: l2, now: at(i) })); return list; });
  assert.deepEqual([tally(codes(out), 'ok'), failing.calls.length, await noteCount(O2)], [33, 30, 33]);
  assert.deepEqual([await noteCount(O2, { translationError: 'QUOTA' }), await noteCount(O2, { translationError: 'RATE_LIMIT' })], [30, 3]);
  assert.ok(!JSON.stringify(await db.orderNote.findMany({ where: { orderId: O2.id } })).includes(KEY));
  // İç not: çeviri alanı yok, sağlayıcı çağrılmaz (sınır dolu olsa da olmasa da)
  const q = provider();
  const l3 = createNoteLimits();
  for (const u of [U.admin, U.sales, U.drawer]) for (let i = 0; i < 5; i++) assert.deepEqual((await add(u, O2, `İç not ${u.name} ${i}`, { p: q, limits: l3, internal: true })).translation, null);
  assert.equal(q.calls.length, 0);
  assert.equal(await noteCount(O2, { internal: true, translationStatus: { not: null } }), 0);
}));

dbTest('"yeniden dene": kullanıcı başına 10 dakikada 20 sağlayıcı çağrısı — 21. reddedilir (not, denetim kaydı ve sağlayıcı dokunulmaz); paralel isteklerle aşılamaz; pencere sonrası yeniden', offline(async () => {
  await enable();
  const O = await newOrder();
  await seed(O, 30, U.custA, { translationLang: 'tr', translationStatus: 'FAILED', translationError: 'RATE_LIMIT', translationAt: at(0) });
  const notes = await db.orderNote.findMany({ where: { orderId: O.id }, orderBy: { id: 'asc' } });
  const limits = createNoteLimits();
  const p = provider();
  const audits = () => db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: { in: notes.map((n) => n.id) } } });
  // Sırayla: 20 kabul, 21. ret
  const rs = [];
  for (let i = 0; i < 21; i++) rs.push(await retry(U.sales, notes[i].id, O, p, { limits, now: at(MIN + i * 100) }));
  assert.deepEqual([tally(codes(rs), 'ok'), rs[20], p.calls.length, await audits()], [20, { ok: false, code: 'RATE_LIMIT' }, 20, 20]);
  assert.deepEqual(fields(await rowOf(notes[20].id)), [null, 'tr', 'FAILED', 'RATE_LIMIT'], 'reddedilen istek nota dokunmadı');
  assert.equal(JSON.stringify(await rowOf(notes[20].id)), JSON.stringify(notes[20]));
  // Sınır kullanıcı başınadır: yönetici aynı notu çevirtebilir
  assert.deepEqual(await retry(U.admin, notes[20].id, O, p, { limits, now: at(MIN + 5000) }), { ok: true, translation: 'DONE' });
  // Pencere dolmadan satış yine reddedilir; 10 dakika sonra yeniden
  assert.deepEqual(await retry(U.sales, notes[21].id, O, p, { limits, now: at(10 * MIN) }), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual(await retry(U.sales, notes[21].id, O, p, { limits, now: at(11 * MIN + 2100) }), { ok: true, translation: 'DONE' });
  assert.equal(p.calls.length, 22);
  // Paralel: 30 çevrilemeyen nota aynı anda istek → tam 20 çağrı
  const O2 = await newOrder();
  await seed(O2, 30, U.custA, { translationLang: 'tr', translationStatus: 'FAILED', translationError: 'TIMEOUT', translationAt: at(0) });
  const list = await db.orderNote.findMany({ where: { orderId: O2.id } });
  const l2 = createNoteLimits();
  const q = provider();
  const par = await Promise.all(list.map((n) => retry(U.drawer, n.id, O2, q, { limits: l2, now: at(MIN) })));
  assert.deepEqual([tally(codes(par), 'ok'), tally(codes(par), 'RATE_LIMIT'), q.calls.length], [20, 10, 20]);
  assert.deepEqual([await noteCount(O2, { translationStatus: 'DONE' }), await noteCount(O2, { translationStatus: 'FAILED', translationError: 'TIMEOUT' })], [20, 10], 'kalan notlar olduğu gibi (yeniden denenebilir)');
  // Yetkisiz roller ve başka sipariş: önceki yanıtlar (hak harcanmaz)
  const l3 = createNoteLimits();
  const left = await db.orderNote.findFirstOrThrow({ where: { orderId: O2.id, translationStatus: 'FAILED' } });
  for (let i = 0; i < 25; i++) {
    assert.deepEqual(await retry(U.custA, left.id, O2, q, { limits: l3 }), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await retry(U.sales, left.id, OB, q, { limits: l3 }), { ok: false, code: 'NOT_FOUND' });
  }
  assert.deepEqual(await retry(U.sales, left.id, O2, q, { limits: l3 }), { ok: true, translation: 'DONE' });
}));

dbTest('sınırlar kiracı ayrımını ve yetkileri değiştirmez: başka firmanın siparişi sınır dolu olsa da NOT_FOUND / yazılamaz; ret yanıtı sipariş varlığını sızdırmaz', offline(async () => {
  await enable();
  const O = await newOrder();
  const X = await newOrder(B);
  const limits = createNoteLimits();
  const p = provider();
  // Müşteri A, firma B'nin siparişine yazamaz (sınırdan önce de sonra da); denemeler kendi hakkından düşer
  for (let i = 0; i < 3; i++) assert.deepEqual(await add(U.custA, X, 'încercare', { p, limits, now: at(i) }), { ok: false, code: 'NOT_FOUND' });
  const own = [];
  for (let i = 0; i < 20; i++) own.push(await add(U.custA, O, `Nota ${i}`, { p, limits, now: at(10 + i) }));
  assert.deepEqual([tally(codes(own), 'ok'), tally(codes(own), 'RATE_LIMIT')], [17, 3]);
  // Sınır doluyken: var olan başka firma siparişi ile var olmayan sipariş aynı yanıtı verir
  assert.deepEqual(await add(U.custA, X, 'x', { p, limits, now: at(100) }), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual(await tr.addNote(db, { orderId: 'yok', actor: act(U.custA), text: 'x', translator: p.fn, secret: SECRET, limits, now: at(100) }), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual([await noteCount(X), p.calls.length], [0, 17]);
  // Firma B'nin müşterisi etkilenmez; kendi siparişine yazar, A'nın siparişine yazamaz / notlarını göremez
  assert.equal((await add(U.custB, X, 'Nota firmei B', { p, limits, now: at(100) })).ok, true);
  assert.deepEqual(await add(U.custB, O, 'x', { p, limits, now: at(100) }), { ok: false, code: 'NOT_FOUND' });
  assert.equal(await seen(U.custB, O), null);
  assert.equal((await seen(U.custA, X)), null);
  // Kapsam dışı sipariş (satış: profil siparişi; çizim: çizimsiz sipariş) yine bulunamaz
  assert.deepEqual(await add(U.sales, OP, 'x', { p, limits }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(U.drawer, ONODRAW, 'x', { p, limits }), { ok: false, code: 'NOT_FOUND' });
  // Müşterinin "iç not" işareti yok sayılır (not müşteriye açıktır ve çevrilir); denetimci yazamaz
  const forced = await add(U.custB, X, 'Notă „internă”', { p, limits, internal: true, now: at(200) });
  assert.deepEqual([forced.translation, (await rowOf(forced.noteId)).internal], ['DONE', false]);
  assert.deepEqual(await add(U.inspector, O, 'x', { p, limits }), { ok: false, code: 'FORBIDDEN' });
}));
