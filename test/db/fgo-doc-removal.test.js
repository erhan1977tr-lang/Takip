// "TAKİP'ten kaldır" (karar 132) — veritabanıyla ve GERÇEK temizlik yoluyla (removeDeletedDocument): FGO'da elle silinmiş
// belgenin TAKİP kaydı yalnızca FGO kesin "belge yok" derse kalkar; sipariş belgeden önceki hâline döner (düğme yeniden
// çıkar), zincir bozulmaz, saatlik eşitleme kaydı artık sormaz. Belge FGO'da duruyorsa ya da FGO doğrulanamıyorsa hiçbir
// şey değişmez.
// FGO GERÇEKTİR: buradaki her FGO isteği sahte bir yanıtlayıcıya gider; gerçek ağ isteği yapılırsa test düşer (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const { absentInFgo, removeDocumentDeletedInFgo, syncFgoDocuments, syncStatus } = await import('../../server/accounting/receivables.js');
const g = await import('../../server/glass/billing.js');

const SECRET = 'r'.repeat(40);
let db, admin, firm;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const fgoOn = (enabled = true) => saveFgoSettings(db, {
  enabled, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21,
}, { key: 'K', secret: SECRET }, actor());

/** Belge kesen sahte FGO (emitere + getstatus). */
function issuer(start) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '1210.00', ValoareAchitata: '0' } }));
    calls.push(form);
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
/** Yalnızca durum yanıtlayan sahte FGO: belge no → yanıt; her isteğin adresi ve yöntemi kaydedilir. */
function status(answers) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    asked.push({ url: String(url), method: init.method, doc: `${form.Serie}${form.Numar}` });
    const a = answers[`${form.Serie}${form.Numar}`] ?? { Valoare: '1210.00', ValoareAchitata: '0' };
    return typeof a === 'function' ? a() : new Response(JSON.stringify({ Success: true, Factura: a }));
  };
  return { asked, fetchImpl };
}
const refuse = (Message, code = 200) => () => new Response(JSON.stringify({ Success: false, Message }), { status: code });
const GONE = refuse('Factura nu exista');
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: 'Europe/Bucharest', fetchImpl: fgo.fetchImpl, ...extra });
const remove = (docId, fgo, who = actor()) => removeDocumentDeletedInFgo(db, { docId, actor: who, secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl });

async function glassOrder(no) {
  return db.order.create({
    data: {
      orderNo: `GLA${no}`, customerOrderNo: no, title: 'Ușă duș', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: new Date(Date.now() + 10 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}
async function issue(o, kind, fgo) {
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind, actor: actor() }), { ok: true });
  return g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id }));
}
const docsOf = (orderId) => db.fgoDocument.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { number: 'asc' }] });
const mailsOf = (docId) => db.notificationOutbox.findMany({ where: { type: g.DOC_EMAIL, payload: { path: ['docId'], equals: docId } }, orderBy: { createdAt: 'asc' } });
const requests = (docId) => db.auditLog.findMany({ where: { action: 'FGO_DOC_REMOVE_REQUEST', entityId: docId }, orderBy: { createdAt: 'asc' } });
/** Siparişin belge zinciriyle ilgili her şey (değişmedi mi diye karşılaştırmak için) */
const state = async (orderId) => JSON.stringify({
  docs: await docsOf(orderId),
  billing: await db.glassBilling.findUnique({ where: { orderId } }),
  order: await db.order.findUnique({ where: { id: orderId } }),
  mails: await db.notificationOutbox.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
  events: await db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
  removed: await db.auditLog.count({ where: { action: 'FGO_DOC_REMOVED' } }),
});

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'contabil@glass.test', taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1' } });
  admin = await db.user.create({ data: { email: 'admin@kaldir.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveDailyRate(db, { day: localDay(new Date(), 'Europe/Bucharest'), rate: 5 }, actor(), writeAudit);
  await fgoOn();
});
after(closeDb);

dbTest('FGO\'da silinmiş proforma: yönetici kaldırır → kayıt kalkar, kur kaydı sıfırlanır, bekleyen e-posta atlanır, proforma düğmesi yeniden çıkar; yeni proforma tek belge olarak kesilir; eşitleme eski kaydı sormaz', offline(async () => {
  const o = await glassOrder(563);
  assert.deepEqual(await issue(o, 'PROFORMA', issuer(562)), { done: 1, failed: 0 });
  const [doc] = await docsOf(o.id);
  assert.deepEqual([doc.kind, `${doc.series}${doc.number}`], ['PROFORMA', 'PRF563']);
  assert.equal(Number((await db.glassBilling.findUnique({ where: { orderId: o.id } })).fxRate), 5);
  assert.deepEqual((await mailsOf(doc.id)).map((m) => m.status), ['PENDING']);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'proforma varken ikinci proforma istenemez');

  // Saatlik eşitleme FGO'nun "belge yok" yanıtını yalnızca belgeye yazar (kayıt durur): ekrandaki düğme bundan çıkar
  const hourly = status({ PRF563: GONE });
  assert.deepEqual(await syncFgoDocuments(db, { secret: SECRET, fetchImpl: hourly.fetchImpl, sleep: async () => {} }), { ran: true, checked: 0, failed: 1 });
  let row = await db.fgoDocument.findUnique({ where: { id: doc.id } });
  assert.deepEqual([row.checkError, absentInFgo(row)], ['Factura nu exista', true]);
  const untouched = await state(o.id);

  // --- Yönetici olmayan roller: reddedilir, FGO'ya gidilmez
  const never = status({ PRF563: GONE });
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', 'BILINMEYEN']) {
    assert.deepEqual(await remove(doc.id, never, actor(role)), { ok: false, code: 'FORBIDDEN' }, role);
  }
  assert.equal(never.asked.length, 0);
  assert.equal(await state(o.id), untouched);
  assert.deepEqual(await requests(doc.id), []);

  // --- FGO doğrulanamıyor (zaman aşımı, kimlik hatası, geçici hata, belirsiz yanıt): hiçbir şey değişmez
  const unverified = {
    timeout: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    network: () => { throw new Error('ECONNRESET'); },
    auth: refuse('Hash invalid'),
    http500: refuse('Eroare', 500),
    http429: refuse('Factura nu exista', 429),
    firm: refuse('Firma nu exista'),
    html: () => new Response('<html>mentenanță</html>'),
    empty: () => new Response(JSON.stringify({ Success: false })),
  };
  for (const [name, answer] of Object.entries(unverified)) {
    const f = status({ PRF563: answer });
    assert.deepEqual(await remove(doc.id, f), { ok: false, code: 'UNVERIFIED', doc: 'PRF563' }, name);
    assert.equal(f.asked.length, 1, name);
    assert.equal(await state(o.id), untouched, `${name}: sipariş, belge, kur kaydı, e-posta işi, geçmiş aynen`);
    assert.equal((await syncStatus(db)).leaseUntil, null, `${name}: kilit bırakıldı`);
  }
  // FGO kapalıyken de: doğrulanamaz
  await fgoOn(false);
  assert.deepEqual(await remove(doc.id, never), { ok: false, code: 'FGO_DISABLED', doc: 'PRF563' });
  await fgoOn(true);
  // Eşitleme sürerken (kilit alınmış): başlamaz
  const sync = await db.integrationSetting.findUnique({ where: { key: 'fgo-sync' } });
  await db.integrationSetting.update({ where: { key: 'fgo-sync' }, data: { value: { ...sync.value, leaseUntil: new Date(Date.now() + 60_000).toISOString() } } });
  assert.deepEqual(await remove(doc.id, never), { ok: false, code: 'BUSY', doc: 'PRF563' });
  await db.integrationSetting.update({ where: { key: 'fgo-sync' }, data: { value: { ...sync.value, leaseUntil: null } } });
  assert.equal(never.asked.length, 0);
  assert.equal(await state(o.id), untouched);

  // --- Belge FGO'da DURUYOR: kayıt kaldırılmaz; kur kaydı, e-posta işi, geçmiş aynen; okunan durum yazılır, eski hata silinir
  const exists = status({ PRF563: { Valoare: '1210.00', ValoareAchitata: '300.00' } });
  assert.deepEqual(await remove(doc.id, exists), { ok: false, code: 'EXISTS', doc: 'PRF563' });
  row = await db.fgoDocument.findUnique({ where: { id: doc.id } });
  assert.deepEqual([row.paid.toString(), row.checkError, absentInFgo(row)], ['300', null, false]);
  assert.equal(Number((await db.glassBilling.findUnique({ where: { orderId: o.id } })).fxRate), 5);
  assert.deepEqual((await mailsOf(doc.id)).map((m) => m.status), ['PENDING']);
  assert.equal(await db.auditLog.count({ where: { action: 'FGO_DOC_REMOVED' } }), 0);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'FGO_DOC_DELETED' } }), 0);
  await db.fgoDocument.update({ where: { id: doc.id }, data: { paid: '0' } });

  // --- FGO kesin "belge yok" dedi: mevcut temizlik yolu çalışır
  const gone = status({ PRF563: GONE });
  assert.deepEqual(await remove(doc.id, gone), { ok: true, doc: 'PRF563', orderId: o.id });
  // FGO'ya yalnızca o belgenin durumu soruldu (tek POST factura/getstatus); silme / kesme isteği yok
  assert.deepEqual(gone.asked.map((q) => [q.method, q.doc, /\/factura\/getstatus$/.test(q.url)]), [['POST', 'PRF563', true]]);
  for (const f of [never, exists, gone, hourly]) assert.ok(f.asked.every((q) => q.method === 'POST' && /\/factura\/getstatus$/.test(q.url)));
  assert.deepEqual(await docsOf(o.id), [], 'belge kaydı kalktı');
  const billing = await db.glassBilling.findUnique({ where: { orderId: o.id } });
  assert.deepEqual([billing.fxRate, billing.fxDate, billing.fxSource, billing.fxPolicy, billing.fxResolvedAt], [null, null, null, null, null], 'proforma yok → kur kaydı sıfır (yeni proforma günün kuruyla)');
  assert.deepEqual((await mailsOf(doc.id)).map((m) => m.status), ['SKIPPED'], 'silinmiş belgenin bekleyen e-postası gönderilmez');
  assert.equal((await db.order.findUnique({ where: { id: o.id } })).status, 'URETIMDE', 'sipariş durumu değişmez');
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: o.id, event: 'FGO_DOC_DELETED', note: 'PRF563' } }), 'sipariş geçmişinde "FGO\'da silindi"');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REMOVED', entityType: 'Order', entityId: o.id } }), 'mevcut temizlik yolunun denetim kaydı');
  // İstek denetimi: kim istedi, sonuç ne oldu (reddedilenler dahil; yetkisiz roller hizmete hiç ulaşmadı)
  const log = await requests(doc.id);
  const results = {};
  for (const a of log) results[a.details.result] = (results[a.details.result] ?? 0) + 1;
  assert.deepEqual(results, { UNVERIFIED: Object.keys(unverified).length, FGO_DISABLED: 1, EXISTS: 1, REMOVED: 1 });
  assert.ok(log.every((a) => a.userId === admin.id && a.actorRole === 'ADMIN' && a.ip === '127.0.0.1' && a.details.series === 'PRF' && a.details.number === '563'));
  assert.ok(!JSON.stringify(log).includes(SECRET));
  assert.equal((await syncStatus(db)).leaseUntil, null);

  // Kayıt yokken yeniden istenirse: FGO'ya gidilmez
  const again = status({ PRF563: GONE });
  assert.deepEqual(await remove(doc.id, again), { ok: false, code: 'NOT_FOUND' });
  assert.equal(again.asked.length, 0);

  // --- Saatlik eşitleme kaldırılan kaydı artık sormaz (özel "yoksay" listesi yok: kayıt yok)
  const other = await glassOrder(600);
  assert.deepEqual(await issue(other, 'PROFORMA', issuer(599)), { done: 1, failed: 0 });
  const next = status({});
  assert.deepEqual(await syncFgoDocuments(db, { secret: SECRET, fetchImpl: next.fetchImpl, sleep: async () => {}, now: new Date(Date.now() + 2 * 3_600_000) }), { ran: true, checked: 1, failed: 0 });
  assert.deepEqual(next.asked.map((q) => q.doc), ['PRF600']);

  // --- İş akışı geri geldi: proforma yeniden istenebilir ve TEK belge olarak kesilir (çift / yetim kayıt yok)
  assert.deepEqual(await issue(o, 'PROFORMA', issuer(700)), { done: 1, failed: 0 });
  const docs = await docsOf(o.id);
  assert.deepEqual(docs.map((d) => [d.kind, `${d.series}${d.number}`, d.seq]), [['PROFORMA', 'PRF701', 1]]);
  assert.equal(Number((await db.glassBilling.findUnique({ where: { orderId: o.id } })).fxRate), 5, 'yeni proformayla kur kaydı yeniden yazıldı');
  assert.equal(await db.glassBilling.count({ where: { orderId: o.id } }), 1);
  assert.deepEqual((await mailsOf(docs[0].id)).map((m) => m.status), ['PENDING'], 'yeni belgenin kendi e-posta işi');
  assert.equal(await db.fgoDocument.count({ where: { series: 'PRF', number: '563' } }), 0);
  assert.equal(await db.notificationOutbox.count({ where: { type: g.DOC_EMAIL, status: 'PENDING', payload: { path: ['docId'], equals: doc.id } } }), 0, 'kaldırılan belgeye bağlı bekleyen iş kalmadı');
}));

dbTest('zincir bozulmaz: FGO\'da silinmiş AVANS faturası kaldırılınca proforma ve kur kaydı durur, tahsilat yeniden "avansı kesilmemiş" olur; proforma FGO\'da durduğu için kaldırılamaz', offline(async () => {
  const o = await glassOrder(810);
  const fgo = issuer(810);
  assert.deepEqual(await issue(o, 'PROFORMA', fgo), { done: 1, failed: 0 });
  await db.fgoDocument.updateMany({ where: { orderId: o.id, kind: 'PROFORMA' }, data: { paid: '605.00' } });
  assert.deepEqual(await issue(o, 'ADVANCE', fgo), { done: 1, failed: 0 });
  let docs = await docsOf(o.id);
  assert.deepEqual(docs.map((d) => d.kind).sort(), ['ADVANCE', 'PROFORMA']);
  const proforma = docs.find((d) => d.kind === 'PROFORMA');
  const advance = docs.find((d) => d.kind === 'ADVANCE');
  assert.equal(g.orderChain(docs).advanceRequired, 0, 'tahsilatın avansı kesilmiş');
  const answers = { [`${advance.series}${advance.number}`]: GONE, [`${proforma.series}${proforma.number}`]: { Valoare: '1210.00', ValoareAchitata: '605.00' } };

  // Proforma FGO'da duruyor: kaldırılamaz, zincir aynen
  assert.deepEqual(await remove(proforma.id, status(answers)), { ok: false, code: 'EXISTS', doc: `${proforma.series}${proforma.number}` });
  assert.equal((await docsOf(o.id)).length, 2);

  // Avans faturası FGO'da silinmiş: yalnızca o kayıt kalkar
  assert.deepEqual(await remove(advance.id, status(answers)), { ok: true, doc: `${advance.series}${advance.number}`, orderId: o.id });
  docs = await docsOf(o.id);
  assert.deepEqual(docs.map((d) => [d.kind, d.id]), [['PROFORMA', proforma.id]], 'proforma yerinde');
  assert.equal(Number((await db.glassBilling.findUnique({ where: { orderId: o.id } })).fxRate), 5, 'proforma durduğu için kur kaydı durur (zincir aynı kurla sürer)');
  const chain = g.orderChain(docs);
  assert.deepEqual([chain.paid, chain.advanced, chain.advanceRequired, chain.nextSeq], [605, 0, 605, 1], 'tahsilat yeniden avansı kesilmemiş; sıradaki avans yine 1.');
  // Avans yeniden kesilebilir (aynı sıra numarasıyla tek kayıt)
  assert.deepEqual(await issue(o, 'ADVANCE', fgo), { done: 1, failed: 0 });
  docs = await docsOf(o.id);
  assert.deepEqual(docs.filter((d) => d.kind === 'ADVANCE').map((d) => d.seq), [1]);
  assert.equal(g.orderChain(docs).advanceRequired, 0);
}));
