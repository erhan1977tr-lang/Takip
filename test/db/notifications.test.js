// Uygulama içi bildirimler (Aşama 8, karar 107) — veritabanıyla: olayların alıcılara dağıtımı, tekrar engeli (işçi
// yeniden denemesi / eşzamanlı işçi), firma adı maskesi, müşteri yalıtımı, çizim kararlarının yönü, yükleme ve muhasebe
// olayları. FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR de sahtedir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit, writeHistory, enqueueOutbox } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const { refreshDocuments } = await import('../../server/accounting/receivables.js');
const n = await import('../../server/notifications/inapp.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const co = await import('../../server/loading/correction.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');

const SECRET = 'n'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, U, A, B, seq = 900;
const actor = (u = U.admin) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1' });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const bnr = (rate) => async () => ({ ok: true, rate, date: dayOf(0), url: 'https://curs.bnr.ro/nbrfxrates.xml' });

/** Sahte FGO: emitere belge keser (ya da emit ile reddeder); getstatus testin yazdığı tahsilatı döner */
function fakeFgo(start, { emit = null } = {}) {
  let num = start;
  const calls = [];
  const state = new Map();
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const s = state.get(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: (s?.total ?? 0).toFixed(2), ValoareAchitata: (s?.paid ?? 0).toFixed(2) } }));
    }
    if (emit) return emit(form);
    calls.push(form);
    num += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${num}`, { total: Math.round(total * 100) / 100, paid: 0 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(num), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${num}.pdf` } }));
  };
  return { calls, fetchImpl, state };
}
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });

const user = (email, name, appRole, customerId, extra = {}) => db.user.create({ data: { email, name, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } });
async function glassOrder(firm, day, { drawer = null, type = 'GLASS_ORDER', adet = 10 } = {}) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: type, customerId: firm.id, createdById: U.a1.id, status: 'URETIMDE', estimatedShipDate: at(day),
      assignedDrawerId: drawer?.id ?? null,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: U.admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată', enMm: 1000, boyMm: 1000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '50' }] } } },
    },
    include: { offers: { include: { lines: true } } },
  });
}
/** İş akışının yazdığı gibi bir kuyruk olayı (aynı yazıcıyla) */
const event = (type, order, payload = {}) => db.$transaction((tx) => enqueueOutbox(tx, { type, orderId: order.id, payload }));
const notes = (where = {}) => db.notification.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const names = new Map();
/** Bir olay türünün alıcıları (kullanıcı adlarıyla, sıralı) */
const receivers = async (type, orderId) => (await notes({ type, orderId })).map((x) => names.get(x.userId)).sort();
const lineKey = (o) => `l:${o.offers[0].lines[0].id}`;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'GLASSANDMORE SRL', prefix: 'GLA', email: 'a@gla.test', taxId: '556677', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 2', fxPolicy: 'BNR' } });
  B = await db.customer.create({ data: { name: 'ALEGRAD SRL', prefix: 'ALE', email: 'b@ale.test', taxId: '112233', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 3', fxPolicy: 'BNR' } });
  U = {
    admin: await user('admin@n.test', 'Yönetici 1', 'ADMIN', factory.id),
    admin2: await user('admin2@n.test', 'Yönetici 2', 'ADMIN', factory.id),
    sales1: await user('satis1@n.test', 'Satış 1', 'SATIS', factory.id),
    sales2: await user('satis2@n.test', 'Satış 2', 'SATIS', factory.id),
    drawer: await user('cizim@n.test', 'Çizim 1', 'CIZIM', factory.id),
    drawer2: await user('cizim2@n.test', 'Çizim 2', 'CIZIM', factory.id),
    inspector: await user('denetim@n.test', 'Denetim', 'DENETIMCI', factory.id),
    a1: await user('a1@gla.test', 'A müşteri 1', 'MUSTERI', A.id),
    a2: await user('a2@gla.test', 'A müşteri 2', 'MUSTERI', A.id),
    aOff: await user('a3@gla.test', 'A pasif', 'MUSTERI', A.id, { isActive: false }),
    b1: await user('b1@ale.test', 'B müşteri', 'MUSTERI', B.id),
  };
  for (const [k, u] of Object.entries(U)) names.set(u.id, k);
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
  await saveDailyRate(db, { day: localDay(new Date(), TZ), rate: 5 }, actor(), writeAudit);
});
after(closeDb);

dbTest('dağıtım: her olay yalnızca ilgili alıcılara; çizim kararları atanmış çizimci + ilgili satışçıya; işlemi yapana bildirilmez; işçi yeniden denese de tek kayıt', async () => {
  // Bu sürümden önceki (zaten dağıtılmış sayılan) olay hiçbir zaman bildirime dönüşmez
  const o = await glassOrder(A, dayOf(20), { drawer: U.drawer });
  const legacy = await db.notificationOutbox.create({ data: { type: 'ORDER_OFFER_SENT', orderId: o.id, payload: {}, inAppAt: new Date() } });
  const pending = { orderId: o.id, id: { not: legacy.id } };
  assert.deepEqual(await n.dispatchInApp(db), { events: 0, created: 0 });
  // Siparişle ilgilenen satışçı: çizime gönderen satış kullanıcısı (mevcut kayıttan)
  await db.$transaction((tx) => writeHistory(tx, { orderId: o.id, event: 'SENT_TO_DRAWING', actorId: U.sales1.id }));

  await event('ORDER_CREATED', o, { actorId: U.a1.id });
  await event('ORDER_SENT_TO_DRAWING', o, { actorId: U.sales1.id });
  await event('ORDER_DRAWING_UPLOADED', o, { actorId: U.drawer.id });
  await event('ORDER_REVISION_REQUESTED', o, { actorId: U.a1.id });
  await event('ORDER_DRAWING_APPROVED', o, { actorId: U.a1.id });
  await event('ORDER_OFFER_SUBMITTED', o, { actorId: U.sales1.id });
  await event('ORDER_OFFER_SENT', o, { actorId: U.admin.id });
  await event('ORDER_HOLD', o, { actorId: U.admin.id }); // bildirim kuralı olmayan olay: kimseye gitmez
  const first = await n.dispatchInApp(db);
  assert.equal(first.events, 8);

  assert.deepEqual(await receivers('ORDER_CREATED', o.id), ['admin', 'admin2', 'sales1', 'sales2'], 'yeni cam siparişi: satış + yönetici');
  assert.deepEqual(await receivers('ORDER_SENT_TO_DRAWING', o.id), ['drawer'], 'yalnızca atanmış çizimci');
  assert.deepEqual(await receivers('ORDER_DRAWING_UPLOADED', o.id), ['a1', 'a2'], 'firmanın etkin kullanıcıları; pasif ve başka firma yok');
  assert.deepEqual(await receivers('ORDER_REVISION_REQUESTED', o.id), ['drawer', 'sales1'], 'atanmış çizimci + ilgili satışçı; yönetici / öbür satışçı / öbür çizimci yok');
  assert.deepEqual(await receivers('ORDER_DRAWING_APPROVED', o.id), ['drawer', 'sales1']);
  assert.deepEqual(await receivers('ORDER_OFFER_SUBMITTED', o.id), ['admin', 'admin2'], 'satışın teklifi yöneticiye; müşteriye gitmez');
  assert.deepEqual(await receivers('ORDER_OFFER_SENT', o.id), ['a1', 'a2', 'sales1'], 'müşteri + ilgili satışçı; gönderen yönetici kendine bildirim almaz');
  assert.equal(await db.notification.count({ where: { type: 'ORDER_HOLD' } }), 0);
  assert.equal(first.created, await db.notification.count());
  // Denetimci ve başka firmanın müşterisi hiçbir bildirim almaz
  assert.equal(await db.notification.count({ where: { userId: { in: [U.inspector.id, U.b1.id, U.aOff.id, U.drawer2.id] } } }), 0);

  // Kayıt: olay kimliği, bağlantı, okunmamış; metin alıcının göreceği kadar
  const forSales = (await notes({ type: 'ORDER_REVISION_REQUESTED', userId: U.sales1.id }))[0];
  const outboxRow = await db.notificationOutbox.findFirstOrThrow({ where: { type: 'ORDER_REVISION_REQUESTED', orderId: o.id } });
  assert.deepEqual([forSales.dedupeKey, forSales.link, forSales.isRead, forSales.orderId], [`outbox:${outboxRow.id}`, `/siparisler/${o.id}`, false, o.id]);
  assert.ok(outboxRow.inAppAt instanceof Date);

  // --- Firma adı: satış ve çizim MASKELİ, yönetici tam, müşteride firma alanı yok
  const all = await notes({ orderId: o.id });
  for (const x of all) {
    const who = names.get(x.userId);
    const json = JSON.stringify([x.message, x.params]);
    if (['sales1', 'sales2', 'drawer'].includes(who)) {
      assert.equal(x.params.firm, 'GLA**********', who);
      assert.ok(!json.includes('GLASSANDMORE'), `${who}: tam firma adı saklanmaz`);
    } else if (who.startsWith('admin')) assert.equal(x.params.firm, 'GLASSANDMORE SRL');
    else assert.ok(x.params.firm === undefined && !json.includes('GLASSANDMORE'), `${who}: müşteriye firma yazılmaz`);
    assert.ok(!/50|30/.test(JSON.stringify(x.params)), 'bildirimde fiyat / tutar yok');
  }
  assert.deepEqual(n.renderInApp('ro', forSales), { title: 'Clientul a cerut revizie', body: `${o.orderNo} · GLA**********` });

  // --- Tekrar engeli: işçi olayı işaretleyemeden yarıda kalmış gibi → yeniden dağıtım hiçbir kayıt eklemez
  const total = await db.notification.count();
  await db.notificationOutbox.updateMany({ where: pending, data: { inAppAt: null } });
  const again = await n.dispatchInApp(db);
  assert.deepEqual([again.events, again.created, await db.notification.count()], [8, 0, total]);
  // İki işçi aynı anda
  await db.notificationOutbox.updateMany({ where: pending, data: { inAppAt: null } });
  await Promise.all([n.dispatchInApp(db), n.dispatchInApp(db)]);
  assert.equal(await db.notification.count(), total);
  // Veritabanı: aynı olay aynı kullanıcıya ikinci kez yazılamaz
  const { id: _id, createdAt: _c, ...copy } = forSales;
  await assert.rejects(db.notification.create({ data: copy }), /Unique constraint/);
  // Okundu işaretlenmiş bildirim yeniden dağıtımda geri gelmez / okunmamışa dönmez
  await db.notification.update({ where: { id: forSales.id }, data: { isRead: true, readAt: new Date() } });
  await db.notificationOutbox.updateMany({ where: pending, data: { inAppAt: null } });
  await n.dispatchInApp(db);
  assert.equal((await db.notification.findUniqueOrThrow({ where: { id: forSales.id } })).isRead, true);

  // --- Profil siparişi satışa bildirilmez; müşteri yalıtımı: B'nin siparişi yalnızca B'nin kullanıcısına
  const p = await glassOrder(B, dayOf(25), { type: 'PROFILE_ORDER' });
  await event('ORDER_CREATED', p, { actorId: U.b1.id });
  await event('ORDER_PROFILE_OFFER_SENT', p, { actorId: U.admin.id });
  await n.dispatchInApp(db);
  assert.deepEqual(await receivers('ORDER_CREATED', p.id), ['admin', 'admin2']);
  assert.deepEqual(await receivers('ORDER_PROFILE_OFFER_SENT', p.id), ['b1']);
  assert.equal(await db.notification.count({ where: { userId: U.b1.id, orderId: { not: p.id } } }), 0, 'B müşterisi A\'nın hiçbir olayını görmez');
  assert.equal(await db.notification.count({ where: { userId: { in: [U.a1.id, U.a2.id] }, orderId: p.id } }), 0, 'A müşterisi B\'nin olayını görmez');
});

dbTest('ses tercihi kullanıcı başına saklanır (varsayılan açık); yalnızca sesi etkiler — bildirim yine yazılır', async () => {
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: U.a2.id } })).notificationSound, true, 'varsayılan: açık');
  await db.user.update({ where: { id: U.a2.id }, data: { notificationSound: false } });
  const o = await glassOrder(A, dayOf(22));
  await event('ORDER_OFFER_UPDATED', o, { actorId: U.admin.id });
  await n.dispatchInApp(db);
  assert.deepEqual(await receivers('ORDER_OFFER_UPDATED', o.id), ['a1', 'a2'], 'sesi kapalı kullanıcı da bildirimi alır');
  const u = await db.user.findUniqueOrThrow({ where: { id: U.a2.id } });
  assert.deepEqual([u.notificationSound, u.emailNotifications], [false, true], 'tercih kalıcı; e-posta tercihi ayrı');
  await db.user.update({ where: { id: U.a2.id }, data: { notificationSound: true } });
});

dbTest('yükleme: yüklenmeyen cam ve aktarım bildirimi; düzeltme "muhasebe işlemi gerekli" bildirimi düzeltme başına bir kez, yalnızca muhasebe yetkisine', async () => {
  const D = dayOf(-12), F = dayOf(9);
  const o = await glassOrder(A, D);
  await db.$transaction((tx) => writeHistory(tx, { orderId: o.id, event: 'SENT_TO_DRAWING', actorId: U.sales1.id }));
  // Onay: 2 adet kırık → takip gerektirir: öbür yönetici + ilgili satışçı (onaylayan yönetici kendine almaz)
  const r = await c.confirmLoading(db, { day: D, key: (await c.previewLoading(db, D)).key, notLoaded: [{ key: lineKey(o), quantity: 2, reason: 'BROKEN' }], actor: actor() });
  assert.equal(r.ok, true);
  await n.dispatchInApp(db);
  assert.deepEqual(await receivers('LOADING_NOT_LOADED', o.id), ['admin2', 'sales1']);
  const nl = (await notes({ type: 'LOADING_NOT_LOADED', userId: U.sales1.id }))[0];
  assert.deepEqual([nl.params.qty, nl.params.day, nl.params.firm, nl.link], [2, D, 'GLA**********', `/yuklemeler?gun=${D}#yuklenmeyen`]);
  // Aktarım: müşteri + ilgili satışçı; yeni gün bağlantısı
  const [row] = await rp.notLoadedOfDay(db, D);
  assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() })).ok, true);
  await n.dispatchInApp(db);
  assert.deepEqual(await receivers('LOADING_REPLANNED', o.id), ['a1', 'a2', 'sales1']);
  const rep = (await notes({ type: 'LOADING_REPLANNED', userId: U.a1.id }))[0];
  assert.deepEqual([rep.params.qty, rep.params.day, rep.params.firm, rep.link], [2, F, undefined, `/yuklemeler?gun=${F}`]);
  assert.deepEqual(n.renderInApp('ro', rep).body, `Comanda ${o.orderNo} · 2 buc. → ${F.split('-').reverse().join('.')}`);

  // Fatura kesildi (8 adet); düzeltme: aslında 7 yüklenmiş → kesilmiş fatura uyuşmuyor
  const fgo = fakeFgo(600);
  const grp = (await inv.loadingBilling(db, { day: D, bnrImpl: bnr('5.0000') })).customers[0].groups[0];
  const made = await inv.createInvoiceBatch(db, { day: D, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: bnr('5.0000') });
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: made.batchId }));
  const input = [{ key: lineKey(o), quantity: 3, reason: 'BROKEN' }];
  const plan = await co.planCorrection(db, { day: D, input });
  const fix = await co.correctLoading(db, { day: D, input, reason: 'Kırık sayısı 3', key: plan.key, actor: actor() });
  assert.deepEqual([fix.ok, fix.actionRequired], [true, true]);
  await n.dispatchInApp(db);
  await n.dispatchInApp(db);
  assert.deepEqual(await receivers('ACCOUNTING_ACTION', o.id), ['admin', 'admin2'], 'muhasebe yetkisi olan herkes (düzeltmeyi yapan dahil); satış / müşteri değil — ve bir kez');
  const acc = (await notes({ type: 'ACCOUNTING_ACTION', userId: U.admin2.id }))[0];
  assert.deepEqual([acc.params.day, acc.params.ref, acc.link], [D, 'GKH601', `/yuklemeler?gun=${D}#faturalama`]);
  assert.equal(fgo.calls.length, 1, 'bildirim belge kesmez');
  // İkinci düzeltme (yalnızca neden değişir): ayrı bir düzeltme olayıdır
  const input2 = [{ key: lineKey(o), quantity: 3, reason: 'MISSING' }];
  const plan2 = await co.planCorrection(db, { day: D, input: input2 });
  // (fatura zaten uyuşmuyor: durum sürüyor → bu düzeltme de muhasebe işlemi gerektirir ve kendi olayını üretir)
  assert.equal((await co.correctLoading(db, { day: D, input: input2, reason: 'Neden düzeltildi', key: plan2.key, actor: actor(U.admin2) })).actionRequired, true);
  await n.dispatchInApp(db);
  assert.equal(await db.notification.count({ where: { type: 'ACCOUNTING_ACTION', orderId: o.id } }), 4, 'her düzeltme olayı için alıcı başına tek bildirim');
});

dbTest('FGO: kesilemeyen belge muhasebeye bir kez bildirilir; proformaya gelen tahsilat "avans gerekli" bildirimi üretir — yinelenen eşitleme yeni bildirim üretmez', async () => {
  const o = await glassOrder(A, dayOf(15), { adet: 2 });
  // --- Kesilemeyen belge (FGO reddetti): yönetici uyarısıyla birlikte uygulama içi bildirim, yalnızca muhasebe yetkisine
  const reject = fakeFgo(9000, { emit: () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' })) });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(reject, { onlyOrderId: o.id })), { done: 0, failed: 1 });
  assert.deepEqual(await receivers('FGO_FAILED', o.id), ['admin', 'admin2']);
  const failed = (await notes({ type: 'FGO_FAILED', userId: U.admin.id }))[0];
  assert.deepEqual([failed.link, /Client invalid/.test(failed.params.error), failed.params.firm], [`/siparisler/${o.id}#finans`, true, 'GLASSANDMORE SRL']);
  // İşçi aynı işi yeniden görse de (iş FAILED: yeniden işlenmez) ikinci bildirim yok
  await g.dispatchGlassJobs(db, ctx(reject, { onlyOrderId: o.id }));
  assert.equal(await db.notification.count({ where: { type: 'FGO_FAILED', orderId: o.id } }), 2);

  // --- Proforma kesilir; FGO'da tahsilat görünür → "avans faturası gerekli" (belge + tahsilat tutarıyla tekil)
  const fgo = fakeFgo(700);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  const sync = () => refreshDocuments(db, { orderType: 'GLASS_ORDER', auto: true, secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, sleep: async () => {} });
  await sync(); // tahsilat yok: bildirim yok
  assert.equal(await db.notification.count({ where: { type: 'ADVANCE_REQUIRED' } }), 0);
  fgo.state.get('PRF701').paid = 200;
  for (let i = 0; i < 3; i++) assert.equal((await sync()).ok, true); // saatlik eşitleme aynı tahsilatı üç kez görür
  assert.deepEqual(await receivers('ADVANCE_REQUIRED', o.id), ['admin', 'admin2'], 'yinelenen eşitleme bildirim yağdırmaz; satış / müşteri almaz');
  const adv = (await notes({ type: 'ADVANCE_REQUIRED', userId: U.admin.id }))[0];
  assert.deepEqual([adv.params.ref, adv.params.amount, adv.link], ['PRF701', '200,00', `/siparisler/${o.id}#finans`]);
  // Okundu işaretlendikten sonra da aynı tahsilat yeniden bildirilmez
  await db.notification.updateMany({ where: { type: 'ADVANCE_REQUIRED' }, data: { isRead: true } });
  await sync();
  assert.equal(await db.notification.count({ where: { type: 'ADVANCE_REQUIRED', isRead: false } }), 0);
  // Tahsilat artarsa (yeni olay) yeni bildirim
  fgo.state.get('PRF701').paid = 350;
  await sync();
  await sync();
  assert.equal(await db.notification.count({ where: { type: 'ADVANCE_REQUIRED', orderId: o.id } }), 4);
  assert.equal((await notes({ type: 'ADVANCE_REQUIRED', userId: U.admin.id, isRead: false }))[0].params.amount, '350,00');
  // Bildirimler hiçbir FGO belgesi kesmedi (yalnızca proforma)
  assert.equal(fgo.calls.length, 1);
  assert.equal(await db.notification.count({ where: { userId: { in: [U.sales1.id, U.sales2.id, U.drawer.id, U.a1.id, U.a2.id, U.b1.id, U.inspector.id] }, type: { in: ['FGO_FAILED', 'ADVANCE_REQUIRED', 'ACCOUNTING_ACTION'] } } }), 0);
});
