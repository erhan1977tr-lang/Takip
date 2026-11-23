// Toplu (müşteri) proforma 4.2.27 — karar 326: yükleme günü belli olmayan / günü geçmiş yüklenmemiş siparişler ve
// proforma satırından elle ödeme. FGO'ya GERÇEK istek yapılmaz (sahte fetchImpl); BNR de sahtedir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { dayKey } = await import('../../server/orders/loading.js');
const { snapshotLine } = await import('../../server/loading/confirmation.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');
const bp = await import('../../server/finance/batch-payment.js');

const SECRET = 'p'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, seq = 0;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const noon = (offset) => new Date(`${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
const today = () => dayKey(new Date());

function fakeFgo(start) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    calls.push(form);
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const bnr = (rate) => async () => ({ ok: true, rate, date: today(), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });

async function customer(name, prefix) {
  return db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@toplu.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR' } });
}
async function order(c, { shipDate = null, status = 'URETIMDE' } = {}) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: String(seq), title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status, estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}
async function confirmAll(day, o) {
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date(`${day}T12:00:00Z`) } });
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { include: { lines: true } } } });
  const offer = full.offers[0];
  const rows = offer.lines.map((l) => snapshotLine(full, offer, l, { quantity: Number(l.adet) }));
  await db.loadingConfirmationItem.createMany({
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
}
const nos = (list) => list.map((o) => o.orderNo).sort();

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@toplu.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
});
after(closeDb);

dbTest('günü belli olmayan ve günü geçmiş yüklenmemiş siparişler "bekleyen" grubunda; yüklenmiş / çok eski / Yüklendi işaretli olanlar yok', offline(async () => {
  const c = await customer('Open SRL', 'OPN');
  const future = await order(c, { shipDate: noon(7) });
  const undated = await order(c, { shipDate: null, status: 'HAZIRLANIYOR' });
  const late = await order(c, { shipDate: noon(-5) });
  const loaded = await order(c, { shipDate: noon(-3) });
  await confirmAll(dayKey(noon(-3)), loaded);
  const old = await order(c, { shipDate: noon(-(b.OPEN_PAST_DAYS + 5)) });
  const shipped = await order(c, { shipDate: noon(-4), status: 'YUKLENDI' });

  const days = await b.customerLoadingDays(db, { customerId: c.id });
  assert.deepEqual(days.map((d) => [d.day, d.eligible, d.excluded]), [[dayKey(noon(7)), 1, 0], [b.OPEN_SLOT, 2, 1]], 'gelecekteki gün önce, bekleyen grubu sonda');
  const pv = await b.previewBatch(db, { customerId: c.id, days: [b.OPEN_SLOT], bnrImpl: bnr('5.0000') });
  assert.deepEqual(pv.problems, []);
  assert.deepEqual(nos(pv.included), nos([undated, late]));
  assert.deepEqual(pv.excluded.map((o) => [o.orderNo, o.reason]), [[loaded.orderNo, 'ALREADY_LOADED']]);
  assert.ok(![future, old, shipped].some((o) => pv.included.concat(pv.excluded).some((x) => x.orderId === o.id)));
  // Müşteri listesi: yalnızca bekleyen siparişi olan müşteri de görünür; "gün" sayısına bekleyen grubu girmez
  const c2 = await customer('Only Open SRL', 'ONL');
  await order(c2, { shipDate: null, status: 'HAZIRLANIYOR' });
  const list = await b.batchCustomers(db);
  assert.deepEqual(list.filter((x) => x.name === 'Only Open SRL').map((x) => [x.days, x.orders]), [[0, 1]]);
  assert.deepEqual(list.filter((x) => x.name === 'Open SRL').map((x) => [x.days, x.orders]), [[1, 4]], 'sipariş sayısı uygun olmayanları da içerir (eskisi gibi)');
}));

dbTest('bekleyen + gelecek gün tek proforma: günü olmayan siparişin günü boş, belge metnine yalnızca belli günler yazılır; sipariş seçimi çalışır', offline(async () => {
  const c = await customer('Mixed SRL', 'MIX');
  const fut = await order(c, { shipDate: noon(8) });
  const undated = await order(c, { shipDate: null, status: 'HAZIRLANIYOR' });
  const late = await order(c, { shipDate: noon(-2) });
  const days = [dayKey(noon(8)), b.OPEN_SLOT];
  // Seçim: yalnızca iki sipariş (geç kalan seçilmedi → olduğu gibi kalır)
  const pv = await b.previewBatch(db, { customerId: c.id, days, orderIds: [fut.id, undated.id], bnrImpl: bnr('5.0000') });
  assert.deepEqual([pv.problems, nos(pv.included), nos(pv.unselected)], [[], nos([fut, undated]), [late.orderNo]]);
  const r = await b.createBatch(db, { customerId: c.id, days, orderIds: [fut.id, undated.id], key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r.ok, true);
  const P = await db.billingBatch.findUnique({ where: { id: r.batchId }, include: { orders: { orderBy: { orderNo: 'asc' } } } });
  assert.deepEqual(P.loadingDays.map((d) => d.toISOString().slice(0, 10)), [dayKey(noon(8))]);
  assert.deepEqual(P.orders.map((o) => [o.orderNo, o.loadingDay?.toISOString().slice(0, 10) ?? null]), [[fut.orderNo, dayKey(noon(8))], [undated.orderNo, null]].sort());
  const fgo = fakeFgo(500);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  assert.equal((await db.billingBatch.findUnique({ where: { id: r.batchId } })).status, 'ISSUED');
  // Seçilmeyen sipariş bir sonraki proformaya girebilir; partideki siparişler artık "başka müşteri proformasında"
  const again = await b.previewBatch(db, { customerId: c.id, days: [b.OPEN_SLOT], bnrImpl: bnr('5.0000') });
  assert.deepEqual(nos(again.included), [late.orderNo]);
  assert.deepEqual(again.excluded.map((o) => [o.orderNo, o.reason]), [[undated.orderNo, 'IN_BATCH']]);
  // Yalnızca günü belli olmayan sipariş: belgede gün yazılmaz
  const c3 = await customer('Undated SRL', 'UND');
  const u = await order(c3, { shipDate: null, status: 'HAZIRLANIYOR' });
  const p3 = await b.previewBatch(db, { customerId: c3.id, days: [b.OPEN_SLOT], bnrImpl: bnr('5.0000') });
  const r3 = await b.createBatch(db, { customerId: c3.id, days: [b.OPEN_SLOT], key: p3.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r3.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r3.batchId }));
  const docs = fgo.calls.filter((c) => c.TipFactura);
  assert.equal(docs.length, 2);
  assert.match(docs[0].Text, new RegExp(`Comenzi: .*Încărcare planificată: ${dayKey(noon(8)).split('-').reverse().join('\\.')}`), 'karışık partide yalnızca belli gün yazılır');
  assert.equal(docs[1].Text.includes(`Comanda: ${u.orderNo}.`), true);
  assert.equal(/Încărcare/.test(docs[1].Text), false);
  // Geçmiş gün seçimi (bayat form) eskisi gibi engellenir
  const stale = await b.previewBatch(db, { customerId: c.id, days: [dayKey(noon(-2))], bnrImpl: bnr('5.0000') });
  assert.deepEqual(stale.problems.includes('PAST_DAY'), true);
}));

dbTest('proforma satırından elle ödeme: kayıt partinin zincirine (batchId) iptal edilmemiş ilk siparişle yazılır; yetki, kesilmemiş proforma, çift gönderim', offline(async () => {
  const c = await customer('Pay SRL', 'PAY');
  const o1 = await order(c, { shipDate: noon(9) });
  const o2 = await order(c, { shipDate: noon(9) });
  const days = [dayKey(noon(9))];
  const pv = await b.previewBatch(db, { customerId: c.id, days, bnrImpl: bnr('5.0000') });
  const r = await b.createBatch(db, { customerId: c.id, days, key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') });
  const input = { paidOn: today(), amount: '200', currency: 'RON', method: 'BANK_TRANSFER', reference: 'OP 1' };
  // Henüz kesilmemiş proforma → kayıt yok
  assert.deepEqual(await bp.recordBatchPayment(db, { batchId: r.batchId, input, requestKey: 'x'.repeat(24), actor: actor() }), { ok: false, code: 'NO_PROFORMA' });
  await b.dispatchBatchJobs(db, ctx(fakeFgo(700), { onlyBatchId: r.batchId }));
  for (const role of ['SALES', 'CUSTOMER', 'INSPECTOR']) assert.deepEqual(await bp.recordBatchPayment(db, { batchId: r.batchId, input, requestKey: 'y'.repeat(24), actor: actor(role) }), { ok: false, code: 'FORBIDDEN' });
  // İlk sipariş iptal edilmiş: taşıyıcı ikinci sipariş
  await db.order.update({ where: { id: o1.id }, data: { status: 'IPTAL' } });
  const key = 'k'.repeat(24);
  const p = await bp.recordBatchPayment(db, { batchId: r.batchId, input, requestKey: key, actor: actor() });
  assert.equal(p.ok, true);
  const row = await db.manualPayment.findUnique({ where: { id: p.id } });
  assert.deepEqual([row.batchId, row.orderId, row.ron.toString(), row.customerId], [r.batchId, o2.id, '200', c.id]);
  assert.deepEqual(await bp.recordBatchPayment(db, { batchId: r.batchId, input, requestKey: key, actor: actor() }), { ok: true, id: p.id, duplicate: true });
  // Zincir hesabı (proforma satırındaki bilgi ve avans düğmesi) elle kaydı görür; otomatik avans elle kayda dayanmaz
  const st = await inv.chainState(db, r.batchId);
  assert.deepEqual([st.manualRon, st.advanceRequired, st.basis], [200, 200, 'MANUAL']);
  assert.deepEqual(await inv.autoAdvanceBatch(db, { proformaBatchId: r.batchId }), { ok: false, code: 'MANUAL_BASIS' });
  // Yöneticinin düğmesi elle kayda dayanarak keser (değişmedi)
  const av = await inv.createAdvanceBatch(db, { proformaBatchId: r.batchId, actor: actor() });
  assert.deepEqual([av.ok, av.amount], [true, 200]);
  // Bütün siparişleri iptal edilmiş proforma: taşıyıcı yok
  await db.order.update({ where: { id: o2.id }, data: { status: 'IPTAL' } });
  assert.deepEqual(await bp.recordBatchPayment(db, { batchId: r.batchId, input, requestKey: 'z'.repeat(24), actor: actor() }), { ok: false, code: 'ORDER_STATE' });
}));
