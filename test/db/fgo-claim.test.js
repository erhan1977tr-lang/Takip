// FGO işlerinin sahiplenilmesi ve işlem kirası (3.41.1) — cam, müşteri partisi ve profil işçileri, veritabanıyla.
// FGO'ya GERÇEK istek yapılmaz: bütün çağrılar sahte fetchImpl'e gider; BNR de sahtedir (ağa çıkılmaz).
// Testler zamanlamaya bağlı değildir: FGO yanıtı bir kapıyla bekletilir, saat "now" ile verilir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { FGO_LEASE_MS, claimFgoJob } = await import('../../server/integrations/fgo-claim.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { dayKey } = await import('../../server/orders/loading.js');
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { earliestPickup, localDay } = await import('../../server/profile/dates.js');
const { dispatchFgoJobs } = await import('../../server/profile/fgo-jobs.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');

const SECRET = 'c'.repeat(40);
const TZ = 'Europe/Bucharest';
const MIN = 60_000;
let db, admin, buyer, firm, seq = 0;
const actor = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });
const SHIP = new Date(`${new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
const bnrImpl = async () => ({ ok: true, rate: '5.0000', date: dayKey(new Date()), url: 'https://curs.bnr.ro/nbrfxrates.xml' });

/**
 * Sahte FGO. calls: FGO'ya giden HER belge isteği (başarısız olanlar dahil). failNext: sıradaki istek ağ hatasıyla düşer.
 * hold(): sıradaki isteğin yanıtı release() çağrılana kadar bekletilir; inFlight istek FGO'ya ulaşınca çözülür.
 */
function fakeFgo(start) {
  let n = start;
  let entered = () => {};
  let gate = Promise.resolve();
  const fgo = { calls: [], failNext: 0, inFlight: Promise.resolve(), release: () => {}, hold: () => {}, fetchImpl: null };
  fgo.hold = () => {
    fgo.inFlight = new Promise((r) => { entered = r; });
    gate = new Promise((r) => { fgo.release = r; });
  };
  fgo.fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '605.00', ValoareAchitata: '0' } }));
    fgo.calls.push(form);
    if (fgo.failNext > 0) {
      fgo.failNext -= 1;
      throw new Error('bağlantı koptu');
    }
    entered();
    await gate;
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return fgo;
}
const base = (fgo) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, bnrImpl });

async function customer() {
  seq += 1;
  const prefix = `K${String.fromCharCode(65 + Math.floor(seq / 26))}${String.fromCharCode(65 + (seq % 26))}`;
  return db.customer.create({ data: { name: `Kira ${seq} SRL`, prefix, email: `c${seq}@kira.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR' } });
}
/** 2 m² × 50 EUR = 100 EUR (müşteri fiyatı); gönderilmiş teklif, yükleme 10 gün sonra */
async function glassOrder(c) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: seq, title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: SHIP,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}

/**
 * Her işçi için yeni bir bekleyen FGO işi hazırlar. Dönen: extern (FGO IdExtern), job() (kuyruk satırı),
 * dispatch(fgo, { now }) (o işçinin dağıtıcısı), docs() (bu iş için kayıtlı FGO belgesi sayısı).
 */
const WORKERS = {
  // Sipariş başına cam belgesi (server/glass/billing.js)
  cam: async () => {
    const o = await glassOrder(await customer());
    assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
    return {
      extern: `${o.orderNo}-P`,
      job: () => db.notificationOutbox.findFirstOrThrow({ where: { type: g.GLASS_FGO, orderId: o.id } }),
      dispatch: (fgo, extra = {}) => g.dispatchGlassJobs(db, { ...base(fgo), onlyOrderId: o.id, ...extra }),
      docs: () => db.fgoDocument.count({ where: { orderId: o.id } }),
    };
  },
  // Müşteri partisi belgesi (server/glass/batch.js)
  parti: async () => {
    const c = await customer();
    await glassOrder(c);
    const days = [dayKey(SHIP)];
    const p = await b.previewBatch(db, { customerId: c.id, days, bnrImpl });
    const r = await b.createBatch(db, { customerId: c.id, days, key: p.key, actor: actor(), bnrImpl });
    assert.equal(r.ok, true);
    return {
      extern: `LOT-${r.batchId}`,
      job: () => db.notificationOutbox.findFirstOrThrow({ where: { type: b.BATCH_FGO, payload: { path: ['batchId'], equals: r.batchId } } }),
      dispatch: (fgo, extra = {}) => b.dispatchBatchJobs(db, { ...base(fgo), onlyBatchId: r.batchId, sleep: async () => {}, ...extra }),
      docs: () => db.fgoDocument.count({ where: { batchId: r.batchId } }),
    };
  },
  // Profil siparişi proforması (server/profile/fgo-jobs.js): müşteri onayı işi kuyruğa yazar
  profil: async () => {
    const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
    const items = profileOrderItems([{ productId: products[0].id, qty: 2 }], products);
    assert.ok(items.ok);
    const who = { id: buyer.id, role: buyer.appRole, canApprove: true, customerId: firm.id, ip: '127.0.0.1' };
    const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
    const { id, orderNo } = await createProfileOrder(db, { actor: who, firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
    const load = () => db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
    let o = await load();
    await runProfileAction(db, { orderId: id, action: 'send_profile_offer', actor: actor(), payload: { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) } });
    o = await load();
    const pickupDate = earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
    await runProfileAction(db, { orderId: id, action: 'approve_profile_offer', actor: who, payload: { offerId: o.offers[0].id, pickupDate, phone: '0723000000', plate: 'B 1 KIR' } });
    return {
      extern: `${orderNo}-P`,
      job: () => db.notificationOutbox.findFirstOrThrow({ where: { type: 'FGO_PROFORMA', orderId: id } }),
      dispatch: (fgo, extra = {}) => dispatchFgoJobs(db, { ...base(fgo), ...extra }),
      docs: () => db.fgoDocument.count({ where: { orderId: id } }),
    };
  },
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@kira.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  firm = await db.customer.create({ data: { name: 'Profil Kira SRL', prefix: 'PKR', email: 'p@kira.test', taxId: '445566', county: 'Ilfov', city: 'Voluntari', address: 'Str. 2', fxPolicy: 'BNR' } });
  buyer = await db.user.create({ data: { email: 'alici@kira.test', name: 'Alıcı', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, canApprove: true } });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
});
after(closeDb);

let start = 1000;
for (const [name, make] of Object.entries(WORKERS)) {
  dbTest(`${name}: FGO isteği sürerken ikinci dağıtıcı işi alamaz → FGO'ya tam BİR istek, tek belge; kira kur girişiyle bozulmaz`, async () => {
    const w = await make();
    const fgo = fakeFgo(start += 100);
    fgo.hold();
    const now = new Date();
    const first = w.dispatch(fgo, { now }); // 1. dağıtıcı: işi sahiplenir, FGO isteği yanıt bekliyor
    await fgo.inFlight;
    let job = await w.job();
    assert.deepEqual([job.status, job.attempts, job.lastError], ['PENDING', 1, null], 'iş kesilirken: sahiplenilmiş, hâlâ bekliyor görünür');
    assert.ok(job.availableAt.getTime() >= now.getTime() + FGO_LEASE_MS && job.availableAt.getTime() <= Date.now() + FGO_LEASE_MS, 'işlem kirası: availableAt ileri alındı');
    // 2. dağıtıcı (arka plan işçisi / düğme) tam bu sırada kuyruğu okur: iş kirada → dokunmaz, FGO'ya gitmez
    assert.deepEqual(await w.dispatch(fgo, { now: new Date() }), { done: 0, failed: 0 });
    // Yönetici o sırada günün kurunu girer: bekleyen işler öne alınır ama kesilmekte olan iş alınmaz
    await saveDailyRate(db, { day: localDay(new Date(), TZ), rate: 5 }, actor(), writeAudit);
    assert.equal((await w.job()).availableAt.getTime(), job.availableAt.getTime(), 'kira korunur');
    assert.deepEqual(await w.dispatch(fgo, { now: new Date() }), { done: 0, failed: 0 });
    assert.equal(fgo.calls.length, 1);
    fgo.release();
    assert.deepEqual(await first, { done: 1, failed: 0 });
    job = await w.job();
    assert.deepEqual([job.status, job.attempts, job.lastError], ['SENT', 1, null]);
    // Kira süresi geçse de kesilmiş iş yeniden denenmez
    assert.deepEqual(await w.dispatch(fgo, { now: new Date(Date.now() + FGO_LEASE_MS + MIN) }), { done: 0, failed: 0 });
    assert.deepEqual([fgo.calls.length, fgo.calls[0].IdExtern, await w.docs()], [1, w.extern, 1]);
  });

  dbTest(`${name}: aynı satırı okumuş dağıtıcılardan yalnızca biri sahiplenir; işçi çökerse kira dolunca iş yeniden denenir (aynı IdExtern)`, async () => {
    const w = await make();
    const row = await w.job();
    // Üç dağıtıcı aynı anda aynı (eski) satırı okumuş: sahiplenme tek güncellemedir → yalnızca biri kazanır
    const wins = await Promise.all([claimFgoJob(db, row), claimFgoJob(db, row), claimFgoJob(db, row)]);
    assert.deepEqual(wins.filter(Boolean).length, 1);
    // Kazanan işçi FGO'ya gitmeden çöktü: iş sahiplenilmiş kalır (deneme 1, kira sürüyor)
    const leased = await w.job();
    assert.deepEqual([leased.status, leased.attempts], ['PENDING', 1]);
    const fgo = fakeFgo(start += 100);
    assert.deepEqual(await w.dispatch(fgo, { now: new Date() }), { done: 0, failed: 0 }, 'kira sürerken alınmaz');
    assert.deepEqual(await w.dispatch(fgo, { now: new Date(leased.availableAt.getTime() - 1000) }), { done: 0, failed: 0 }, 'kira dolmadan bir saniye önce de alınmaz');
    assert.equal(fgo.calls.length, 0);
    // Kira doldu: iş yeniden denenir ve kesilir
    assert.deepEqual(await w.dispatch(fgo, { now: leased.availableAt }), { done: 1, failed: 0 });
    const job = await w.job();
    assert.deepEqual([job.status, job.attempts], ['SENT', 2]);
    assert.deepEqual([fgo.calls.length, fgo.calls[0].IdExtern, await w.docs()], [1, w.extern, 1]);
  });

  dbTest(`${name}: geçici FGO hatasında mevcut yeniden deneme kuralı sürer (bekleme süresi kira değil); ikinci denemede aynı IdExtern ile kesilir`, async () => {
    const w = await make();
    const fgo = fakeFgo(start += 100);
    fgo.failNext = 1;
    const now = new Date();
    assert.deepEqual(await w.dispatch(fgo, { now }), { done: 0, failed: 1 });
    let job = await w.job();
    // 1. denemeden sonra 5 dk bekleme (mevcut tablo) — 10 dk'lık kira değil
    assert.deepEqual([job.status, job.attempts, job.availableAt.getTime()], ['PENDING', 1, now.getTime() + 5 * MIN]);
    assert.match(job.lastError, /bağlantı koptu/);
    assert.deepEqual(await w.dispatch(fgo, { now: new Date(now.getTime() + 4 * MIN) }), { done: 0, failed: 0 }, 'bekleme dolmadan denenmez');
    assert.deepEqual(await w.dispatch(fgo, { now: new Date(now.getTime() + 5 * MIN) }), { done: 1, failed: 0 });
    job = await w.job();
    assert.deepEqual([job.status, job.attempts, job.lastError], ['SENT', 2, null]);
    assert.deepEqual(fgo.calls.map((f) => f.IdExtern), [w.extern, w.extern], 'iki denemede de aynı IdExtern');
    assert.equal(await w.docs(), 1);
  });
}

dbTest('kur girişi: hata nedeniyle bekleyen iş öne alınır (mevcut davranış), kiradaki iş alınmaz', async () => {
  const waiting = await WORKERS.cam();
  const fgo = fakeFgo(start += 100);
  fgo.failNext = 1;
  const now = new Date();
  assert.deepEqual(await waiting.dispatch(fgo, { now }), { done: 0, failed: 1 });
  const leasedJob = await WORKERS.cam();
  assert.equal(await claimFgoJob(db, await leasedJob.job()), true);
  const lease = (await leasedJob.job()).availableAt.getTime();
  await saveDailyRate(db, { day: localDay(new Date(), TZ), rate: 5 }, actor(), writeAudit);
  assert.ok((await waiting.job()).availableAt.getTime() <= Date.now(), 'bekleyen iş hemen denenebilir');
  assert.equal((await leasedJob.job()).availableAt.getTime(), lease, 'kiradaki işe dokunulmaz');
});
