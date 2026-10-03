// Yüklenmeyen camın ileri güne aktarılması (karar 102) ve başka müşterinin sandığına fiziksel yerleşim (karar 103) —
// veritabanıyla. FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR de sahtedir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { listDocuments, receivables } = await import('../../server/accounting/receivables.js');
const { supplierData } = await import('../../server/accounting/supplier.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const cr = await import('../../server/loading/crates.js');
const { transportList } = await import('../../server/loading/transport.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');

const SECRET = 'r'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, seq = 500;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const OTHERS = ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI'];
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const evening = (key) => new Date(`${key}T16:00:00Z`); // o günün akşamı: gelecekteki günün "yükleme yapıldıktan sonra" onayı için
const date = (key) => new Date(`${key}T00:00:00Z`);
const tomorrow = () => date(dayOf(1));

/** Sahte FGO: emitere çağrıları sayılır; belge toplamı gönderilen satırlardan. Gerçek FGO adresine hiçbir şey gitmez. */
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const state = new Map();
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const s = state.get(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: (s?.total ?? 0).toFixed(2), ValoareAchitata: '0.00' } }));
    }
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, { total: Math.round(total * 100) / 100 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const never = (name) => async () => { throw new Error(`${name} çağrılmamalıydı`); };
const bnr = (rate) => async () => ({ ok: true, rate, date: dayOf(0), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });
const names = (form) => Object.keys(form).filter((k) => /^Continut\[\d+\]\[Denumire\]$/.test(k)).map((k) => form[k]);

const firm = (name, prefix, data = {}) => db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@replan.test`, taxId: '556677', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 2', fxPolicy: 'BNR', ...data } });
/** 1 m²'lik cam: maliyet 30, müşteri fiyatı 50 */
const glassLine = (adet, extra = {}) => ({ description: 'Temper', descriptionRo: 'Sticlă securizată', enMm: 1000, boyMm: 1000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '50', ...extra });
const cncLine = () => ({ description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' });
const crateFee = () => ({ description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '25', offerPrice: '30' });
async function glassOrder(f, day, lines, extra = {}) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${f.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: at(day), ...extra,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
}
const lineKey = (o, i = 0) => `l:${o.offers[0].lines[i].id}`;
/** Bir siparişin bir onaydaki kalemleri: [durum, adet, m², neden, aktarımdan mı] */
const itemsOf = async (orderId, day) => (await db.loadingConfirmationItem.findMany({
  where: { orderId, confirmation: { shipDay: date(day) } }, orderBy: [{ sortOrder: 'asc' }, { status: 'asc' }],
})).map((i) => [i.kind, i.status, i.quantity, Number(i.m2), i.notLoadedReason, i.replanId != null]);
const rawItems = async (day) => JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { confirmation: { shipDay: date(day) } }, orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }, { status: 'asc' }] }));
const confirm = async (day, notLoaded = [], now = new Date()) => c.confirmLoading(db, { day, key: (await c.previewLoading(db, day)).key, notLoaded, actor: actor(), now });
const billing = (day) => inv.loadingBilling(db, { day, bnrImpl: bnr('5.0000') });
const groupOf = async (day, f) => (await billing(day)).customers.find((x) => x.customerId === f.id)?.groups[0] ?? null;
async function invoice(day, f, fgo) {
  const grp = await groupOf(day, f);
  const r = await inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  return db.billingBatch.findUnique({ where: { id: r.batchId }, include: { document: true, lines: { orderBy: { sortOrder: 'asc' } } } });
}
const dayProfit = async (day) => (await supplierData(db, tomorrow())).days.find((d) => d.day === day);

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@replan.test', name: 'Yönetici', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
});
after(closeDb);

dbTest('10 planlı → 8 yüklendi + 2 yüklenmedi; kalan 2 ileri güne aktarılır, orada 1 + 1, sonra son 1: zincir izlenir, eski onay değişmez, yalnızca yüklenen faturalanır ve sayılır', async () => {
  const D1 = dayOf(-20), F1 = dayOf(7), F2 = dayOf(14), F3 = dayOf(21);
  const A = await firm('Replan A SRL', 'RPA');
  const B = await firm('Replan B SRL', 'RPB');
  const o = await glassOrder(A, D1, [glassLine(10), cncLine()]);
  const other = await glassOrder(B, D1, [glassLine(3)]);

  // --- Onay: yüklenmeyen adet sunucuda doğrulanır; hatalı girişte hiçbir şey yazılmaz
  const plan = await c.previewLoading(db, D1);
  for (const [input, code] of [
    [[{ key: lineKey(o), quantity: 11, reason: 'BROKEN' }], 'BAD_QUANTITY'],
    [[{ key: lineKey(o), quantity: 2, reason: '' }], 'BAD_REASON'],
    [[{ key: lineKey(o), quantity: 2, reason: 'OTHER', note: ' ' }], 'NOTE_REQUIRED'],
    [[{ key: lineKey(o, 1), quantity: 1, reason: 'BROKEN' }], 'BAD_EXCEPTION'],
    [[{ key: 'l:yok', quantity: 1, reason: 'BROKEN' }], 'BAD_EXCEPTION'],
  ]) assert.deepEqual(await c.confirmLoading(db, { day: D1, key: plan.key, notLoaded: input, actor: actor() }), { ok: false, code });
  assert.equal(await db.loadingConfirmation.count({ where: { shipDay: date(D1) } }), 0);
  const r = await c.confirmLoading(db, { day: D1, key: plan.key, notLoaded: [{ key: lineKey(o), quantity: 2, reason: 'BROKEN' }], actor: actor() });
  assert.deepEqual([r.ok, r.orders, r.items, r.notLoaded], [true, 2, 4, 1]);
  assert.deepEqual(await itemsOf(o.id, D1), [['CAM', 'LOADED', 8, 8, null, false], ['CAM', 'NOT_LOADED', 2, 2, 'BROKEN', false], ['CNC', 'LOADED', 2, 0, null, false]]);
  assert.deepEqual(await itemsOf(other.id, D1), [['CAM', 'LOADED', 3, 3, null, false]]);
  const original = await rawItems(D1);
  const events = async (id) => (await db.orderEvent.findMany({ where: { orderId: id } })).map((e) => e.event).sort();
  assert.deepEqual(await events(o.id), ['LOADING_NOT_LOADED', 'LOADING_PARTIAL']);
  assert.deepEqual(await events(other.id), ['LOADING_CONFIRMED']);

  // --- Yüklenmeyenler listesi: planlanan 10, yüklenen 8, kalan 2
  let [row] = await rp.notLoadedOfDay(db, D1);
  assert.deepEqual([row.orderNo, row.customerName, row.planned, row.loaded, row.remaining, row.m2, row.reason, row.origin, row.replan], [o.orderNo, 'Replan A SRL', 10, 8, 2, 2, 'BROKEN', null, null]);
  const loadedItem = await db.loadingConfirmationItem.findFirst({ where: { orderId: o.id, status: 'LOADED', kind: 'CAM' } });

  // --- Aktarım: yalnızca yönetici, yalnızca kalan adet, yalnızca gelecek ve onaylanmamış bir gün
  for (const role of OTHERS) assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: F1, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  await db.loadingConfirmation.create({ data: { shipDay: date(dayOf(60)), confirmedById: admin.id } });
  for (const [args, code] of [
    [{ itemId: loadedItem.id, day: F1 }, 'NOT_ALLOWED'], // yüklenen adet aktarılamaz
    [{ itemId: row.itemId, day: F1, quantity: 3 }, 'BAD_QUANTITY'], // kalandan fazlası
    [{ itemId: row.itemId, day: F1, quantity: 1 }, 'BAD_QUANTITY'],
    [{ itemId: row.itemId, day: dayOf(0) }, 'NOT_FUTURE'],
    [{ itemId: row.itemId, day: dayOf(-3) }, 'NOT_FUTURE'],
    [{ itemId: row.itemId, day: '2026-13-45' }, 'BAD_DAY'],
    [{ itemId: 'yok', day: F1 }, 'NOT_FOUND'],
    [{ itemId: row.itemId, day: dayOf(60) }, 'DAY_CONFIRMED'],
  ]) assert.deepEqual(await rp.replanNotLoaded(db, { ...args, actor: actor() }), { ok: false, code }, code);
  assert.equal(await db.loadingReplan.count(), 0);
  // Aynı anda üç istek: tek aktarım
  const tries = await Promise.all([1, 2, 3].map(() => rp.replanNotLoaded(db, { itemId: row.itemId, day: F1, quantity: 2, actor: actor() })));
  assert.deepEqual(tries.map((x) => x.ok).sort(), [false, false, true]);
  assert.ok(tries.filter((x) => !x.ok).every((x) => x.code === 'ALREADY_PLANNED'));
  const first = await db.loadingReplan.findFirstOrThrow({ where: { sourceItemId: row.itemId } });
  assert.deepEqual([first.status, first.quantity, Number(first.m2), first.reason, first.orderId, first.customerId, first.activeKey, first.fromDay.toISOString().slice(0, 10), first.shipDay.toISOString().slice(0, 10)],
    ['ACTIVE', 2, 2, 'BROKEN', o.id, A.id, row.itemId, D1, F1]);
  const { id: _id, createdAt: _c, ...copy } = first;
  await assert.rejects(db.loadingReplan.create({ data: copy }), /Unique constraint/, 'aynı kalan için ikinci etkin aktarım veritabanında da olamaz');
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'REPLAN_NOT_LOADED', entityId: o.id } });
  assert.deepEqual([audit.userId, audit.details.quantity, audit.details.m2, audit.details.reason, audit.details.fromLoading, audit.details.previousLoading, audit.details.toLoading, audit.details.sourceItemId, audit.details.replanId],
    [admin.id, 2, 2, 'BROKEN', D1, null, F1, row.itemId, first.id]);
  assert.ok((await events(o.id)).includes('REPLAN_NOT_LOADED'));

  // --- İleri gün: yalnızca kalan 2 adet (siparişin 10 adedi değil, CNC yok); sipariş tarihi o güne alınsa da yeniden plana girmez
  let p1 = await c.previewLoading(db, F1);
  assert.deepEqual(p1.orders.map((x) => [x.orderNo, x.replanFrom, x.items.map((i) => [c.itemKey(i), i.kind, i.quantity, i.m2, i.unitCost, i.unitSale])]), [[o.orderNo, [D1], [[`r:${first.id}`, 'CAM', 2, 2, 30, 50]]]]);
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: at(F1) } });
  await db.offerLine.updateMany({ where: { offer: { orderId: o.id }, kind: 'CAM' }, data: { offerPrice: '99' } });
  p1 = await c.previewLoading(db, F1);
  assert.deepEqual([p1.items.map((i) => [i.quantity, i.unitSale]), p1.skipped], [[[2, 50]], []], 'tam 2 adet, onay anındaki fiyatla');
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: at(D1) } });
  await db.offerLine.updateMany({ where: { offer: { orderId: o.id }, kind: 'CAM' }, data: { offerPrice: '50' } });

  // --- Başka güne alma ve vazgeçme: kayıt silinmez; kalan tek bir etkin aktarımda
  for (const role of OTHERS) assert.deepEqual(await rp.cancelReplan(db, { replanId: first.id, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  const moved = await rp.replanNotLoaded(db, { itemId: row.itemId, day: F3, actor: actor() });
  assert.deepEqual([moved.ok, moved.moved], [true, true]);
  assert.deepEqual((await db.loadingReplan.findMany({ where: { sourceItemId: row.itemId }, orderBy: { createdAt: 'asc' } })).map((x) => [x.status, x.activeKey != null, x.shipDay.toISOString().slice(0, 10)]), [['CANCELLED', false, F1], ['ACTIVE', true, F3]]);
  assert.deepEqual([(await c.previewLoading(db, F1)).items.length, (await c.previewLoading(db, F3)).items.length], [0, 1]);
  assert.deepEqual(await rp.cancelReplan(db, { replanId: moved.replanId, actor: actor() }), { ok: true });
  assert.deepEqual(await rp.cancelReplan(db, { replanId: moved.replanId, actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal((await c.previewLoading(db, F3)).items.length, 0);
  assert.equal((await rp.notLoadedOfDay(db, D1))[0].replan, null);
  const second = await rp.replanNotLoaded(db, { itemId: row.itemId, day: F1, actor: actor() });
  assert.deepEqual([second.ok, second.moved, second.quantity], [true, false, 2]);
  assert.equal(await db.auditLog.count({ where: { action: { in: ['REPLAN_NOT_LOADED', 'REPLAN_CANCELLED'] }, entityId: o.id } }), 4);

  // --- Fatura: yalnızca yüklenen 8 adet (+ işlemler); yüklenmeyen 2 faturalanmaz
  const fgo = fakeFgo(100);
  let grp = await groupOf(D1, A);
  assert.deepEqual(grp.orders[0].lines.map((l) => [l.pieces, l.m2, l.amount]), [[8, 8, 420]]);
  const i1 = await invoice(D1, A, fgo);
  assert.deepEqual([fgo.calls[0]['Continut[0][NrProduse]'], fgo.calls[0]['Continut[0][PretTotal]']], ['8', '2541.00']); // (8 × 50 + 2 × 10) × 5 × 1,21
  // Kârlılık: 16.10'da yalnızca yüklenen (A: 8 cam + CNC; B: 3 cam)
  let profit = await dayProfit(D1);
  assert.deepEqual([profit.m2, profit.byCur.EUR.sale, profit.byCur.EUR.cost], [11, 570, 340]);
  assert.equal(await dayProfit(F1), undefined, 'aktarılan kalan yüklenene kadar gelir / maliyet üretmez');

  // --- F1 onayı: kalan 2'nin 1'i yüklendi, 1'i yine yüklenmedi
  const r1 = await confirm(F1, [{ key: `r:${second.replanId}`, quantity: 1, reason: 'MISSING' }], evening(F1));
  assert.deepEqual([r1.ok, r1.orders, r1.items, r1.notLoaded], [true, 1, 2, 1]);
  assert.deepEqual(await itemsOf(o.id, F1), [['CAM', 'LOADED', 1, 1, null, true], ['CAM', 'NOT_LOADED', 1, 1, 'MISSING', true]]);
  assert.equal((await db.loadingReplan.findUniqueOrThrow({ where: { id: second.replanId } })).status, 'CONFIRMED');
  // Aynı kalan ikinci kez onaylanamaz / aktarılamaz
  assert.deepEqual(await confirm(F1, [], evening(F1)), { ok: false, code: 'ALREADY_CONFIRMED' });
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: F2, actor: actor() }), { ok: false, code: 'ALREADY_LOADED' });
  assert.deepEqual(await rp.cancelReplan(db, { replanId: second.replanId, actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  const spare = await db.loadingConfirmation.create({ data: { shipDay: date(dayOf(-90)), confirmedById: admin.id } });
  const carried = await db.loadingConfirmationItem.findFirstOrThrow({ where: { replanId: second.replanId, status: 'LOADED' } });
  const { id: _i, createdAt: _t, confirmationId: _cf, ...dup } = carried;
  await assert.rejects(db.loadingConfirmationItem.create({ data: { ...dup, confirmationId: spare.id } }), /Unique constraint/, 'aynı aktarım başka bir onayda yeniden yüklenmiş kaydedilemez');

  // --- Son 1 adet yeniden aktarılır ve yüklenir
  const [row2] = await rp.notLoadedOfDay(db, F1);
  assert.deepEqual([row2.planned, row2.loaded, row2.remaining, row2.reason, row2.origin, row2.replan], [2, 1, 1, 'MISSING', D1, null]);
  const third = await rp.replanNotLoaded(db, { itemId: row2.itemId, day: F2, quantity: 1, actor: actor() });
  assert.equal(third.ok, true);
  [row] = await rp.notLoadedOfDay(db, D1);
  assert.deepEqual(row.replan, { id: second.replanId, day: F1, status: 'CONFIRMED', loaded: 1, notLoaded: 1 });
  const r2 = await confirm(F2, [], evening(F2));
  assert.deepEqual([r2.ok, r2.items, r2.notLoaded], [true, 1, 0]);
  assert.deepEqual(await itemsOf(o.id, F2), [['CAM', 'LOADED', 1, 1, null, true]]);
  // Zincir: 16.10 → F1 → F2
  assert.deepEqual(await rp.replanChain(db, row2.itemId), [
    { day: D1, loaded: 8, notLoaded: 2, reason: 'BROKEN', replannedTo: F1 },
    { day: F1, loaded: 1, notLoaded: 1, reason: 'MISSING', replannedTo: F2 },
    { day: F2, loaded: 1, notLoaded: 0, reason: null, replannedTo: null },
  ]);
  // İlk onay sonsuza dek 8 / 2: kaydı değişmedi; değiştirilemez
  assert.equal(await rawItems(D1), original);
  await assert.rejects(db.loadingConfirmationItem.updateMany({ where: { confirmation: { shipDay: date(D1) } }, data: { quantity: 10 } }));
  const loadedTotal = await db.loadingConfirmationItem.aggregate({ where: { orderId: o.id, kind: 'CAM', status: 'LOADED' }, _sum: { quantity: true } });
  assert.equal(loadedTotal._sum.quantity, 10, 'toplam yüklenen = planlanan; fazlası yüklenmedi');
  assert.equal((await c.previewLoading(db, F2)).items.length, 0);

  // --- Fatura: kalan, fiilen yüklendiği onayda ve bir kez; önceki fatura değişmedi
  grp = await groupOf(F1, A);
  assert.deepEqual(grp.orders[0].lines.map((l) => [l.pieces, l.amount]), [[1, 50]]);
  const i2 = await invoice(F1, A, fgo);
  const i3 = await invoice(F2, A, fgo);
  assert.deepEqual(fgo.calls.map((f) => [f['Continut[0][NrProduse]'], f['Continut[0][PretTotal]']]), [['8', '2541.00'], ['1', '302.50'], ['1', '302.50']]);
  assert.equal(await groupOf(F2, A), null, 'aynı kapsam ikinci kez faturalanamaz');
  const after1 = await db.billingBatch.findUnique({ where: { id: i1.id }, include: { document: true, lines: { orderBy: { sortOrder: 'asc' } } } });
  const frozen = (x) => JSON.stringify([x.status, x.sourceTotal, x.ronNet, x.fxRate, x.lines, x.document.series, x.document.number, x.document.total]);
  assert.equal(frozen(after1), frozen(i1), 'kesilmiş fatura (8 adet) aktarımdan ve sonraki faturalardan etkilenmedi');
  assert.deepEqual([i2, i3].map((x) => [x.kind, x.status, x.lines[0].pieces]), [['INVOICE', 'ISSUED', 1], ['INVOICE', 'ISSUED', 1]]);
  // Kârlılık: her adet fiilen yüklendiği günde, bir kez — toplam siparişin tamamı (10 × 50 + 2 × 10 = 520)
  profit = await dayProfit(D1);
  const [pf1, pf2] = [await dayProfit(F1), await dayProfit(F2)];
  assert.deepEqual([profit.byCur.EUR.sale, pf1.byCur.EUR.sale, pf1.byCur.EUR.cost, pf1.m2, pf2.byCur.EUR.sale, pf2.byCur.EUR.cost], [570, 50, 30, 1, 50, 30]);
  assert.equal(profit.byCur.EUR.sale - 150 + pf1.byCur.EUR.sale + pf2.byCur.EUR.sale, 520);
});

dbTest('müşteri proformasındaki siparişin aktarılan kalanı aynı proforma zincirinde kalır: ikinci proforma yok, kalan yüklendiği onayda zincirin kuruyla faturalanır', async () => {
  const FP = dayOf(30), FQ = dayOf(37);
  const C = await firm('Replan Chain SRL', 'RPC');
  const p = await glassOrder(C, FP, [glassLine(10)]);
  const fgo = fakeFgo(200);
  const pv = await b.previewBatch(db, { customerId: C.id, days: [FP], bnrImpl: bnr('5.0000') });
  const pr = await b.createBatch(db, { customerId: C.id, days: [FP], key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(pr.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: pr.batchId })); // PRF201: 10 × 50 × 5 × 1,21 = 3025
  // Yükleme: 8 yüklendi, 2 hazır değil → 2 adet FQ'ya aktarıldı
  const r = await confirm(FP, [{ key: lineKey(p), quantity: 2, reason: 'NOT_READY' }], evening(FP));
  assert.deepEqual([r.ok, r.notLoaded], [true, 1]);
  const [row] = await rp.notLoadedOfDay(db, FP);
  assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: FQ, actor: actor() })).ok, true);
  // Fiziksel gün değişti diye ikinci proforma kesilemez: sipariş aynı zincirde
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: p.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  const again = await b.previewBatch(db, { customerId: C.id, days: [FQ], bnrImpl: bnr('5.5000') });
  assert.equal((await b.createBatch(db, { customerId: C.id, days: [FQ], key: again.key, actor: actor(), bnrImpl: bnr('5.5000') })).ok, false);
  assert.equal(await db.billingBatch.count({ where: { customerId: C.id, kind: 'PROFORMA' } }), 1);
  // 8 adet: zincirin kuruyla (BNR yeniden istenmez)
  let grp = (await inv.loadingBilling(db, { day: FP, bnrImpl: never('BNR') })).customers[0].groups[0];
  assert.deepEqual([grp.chainId, grp.fx.finalRate, grp.orders[0].lines.map((l) => [l.pieces, l.gross])], [pr.batchId, '5.0000', [[8, 2420]]]);
  const i1 = await invoice(FP, C, fgo);
  // Kalan 2 yüklendi: aynı zincir, aynı kur, yalnızca 2 adet
  assert.equal((await confirm(FQ, [], evening(FQ))).ok, true);
  grp = (await inv.loadingBilling(db, { day: FQ, bnrImpl: never('BNR') })).customers[0].groups[0];
  assert.deepEqual([grp.chainId, grp.chain.ref, grp.fx.finalRate, grp.orders[0].lines.map((l) => [l.pieces, l.gross])], [pr.batchId, 'PRF201', '5.0000', [[2, 605]]]);
  const i2 = await invoice(FQ, C, fgo);
  assert.deepEqual([i1.parentId, i2.parentId, i2.fxRate.toString()], [pr.batchId, pr.batchId, '5']);
  // Cam Tahsilat: tek borç (3025) — proforma tümüyle faturaya döndü, iki kez sayılan yok
  const docs = (await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.batch?.customer.name === 'Replan Chain SRL');
  assert.deepEqual(docs.map((d) => d.kind).sort(), ['INVOICE', 'INVOICE', 'PROFORMA']);
  assert.equal(receivables(docs).sums.RON.total, 3025);
});

dbTest('iptal / beklemedeki siparişin kalanı aktarılamaz ve onaya girmez; hiç yüklenmeyen sipariş gelir üretmez', async () => {
  const D = dayOf(-25), F = dayOf(45);
  const Q = await firm('Replan Hold SRL', 'RPH');
  const q = await glassOrder(Q, D, [glassLine(4)]);
  const r = await confirm(D, [{ key: lineKey(q), quantity: 4, reason: 'OTHER', note: 'kamyona sığmadı' }]);
  assert.deepEqual([r.ok, r.notLoaded], [true, 1]);
  assert.deepEqual(await itemsOf(q.id, D), [['CAM', 'NOT_LOADED', 4, 4, 'OTHER', false]]);
  const [row] = await rp.notLoadedOfDay(db, D);
  assert.deepEqual([row.planned, row.loaded, row.remaining, row.note], [4, 0, 4, 'kamyona sığmadı']);
  // Yüklenmeyen kapsam: fatura yok, gelir / maliyet yok, "onay dışı" da değil
  assert.equal(await groupOf(D, Q), null);
  assert.equal(await dayProfit(D), undefined);
  // İptal / beklemede: aktarılamaz
  await db.order.update({ where: { id: q.id }, data: { status: 'IPTAL' } });
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() }), { ok: false, code: 'ORDER_CANCELLED' });
  assert.equal((await rp.notLoadedOfDay(db, D))[0].blocked, 'ORDER_CANCELLED');
  await db.order.update({ where: { id: q.id }, data: { status: 'URETIMDE', onHold: true } });
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() }), { ok: false, code: 'ORDER_ON_HOLD' });
  await db.order.update({ where: { id: q.id }, data: { onHold: false } });
  assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() })).ok, true);
  // Aktarımdan sonra sipariş iptal edilirse kalan o günün onayına girmez (nedeniyle listelenir)
  await db.order.update({ where: { id: q.id }, data: { status: 'IPTAL' } });
  const plan = await c.previewLoading(db, F);
  assert.deepEqual([plan.items.length, plan.skipped.map((s) => [s.orderNo, s.reason])], [0, [[q.orderNo, 'ORDER_CANCELLED']]]);
  assert.deepEqual(await confirm(F, [], evening(F)), { ok: false, code: 'NOTHING_TO_CONFIRM' });
  // Tarihinden de yeniden plana girmez: başka onayda kalemi olan sipariş yalnızca aktarımla gelir
  const D2 = dayOf(-24);
  await db.order.update({ where: { id: q.id }, data: { status: 'URETIMDE', estimatedShipDate: at(D2) } });
  const byDate = await c.previewLoading(db, D2);
  assert.deepEqual([byDate.items.length, byDate.skipped.map((s) => [s.orderNo, s.reason, s.day])], [0, [[q.orderNo, 'ALREADY_CONFIRMED', D]]]);
});

dbTest('başka müşterinin sandığı: yalnızca fiziksel yerleşim — sipariş, fatura, proforma, kur ve sandık parası gerçek müşteride kalır', async () => {
  const X = dayOf(-12), Y = dayOf(40);
  // A: BNR + %2 · B: BNR (kur politikaları farklı; fatura her zaman siparişin kendi müşterisininkiyle)
  const A = await firm('Crate Owner A SRL', 'CRA', { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' });
  const B = await firm('Crate Host B SRL', 'CRB');
  const a1 = await glassOrder(A, X, [glassLine(2), crateFee()]);
  const a9 = await glassOrder(A, dayOf(-11), [glassLine(1)]); // başka günün siparişi
  const b1 = await glassOrder(B, X, [glassLine(3)]);
  const sales = { id: admin.id, role: 'SATIS', ip: '127.0.0.1' };
  const row15 = { crateNo: 15, lengthMm: 2400, widthMm: 1600, heightMm: 900, netKg: 190, grossKg: 260, note: null, orderIds: [b1.id] };
  assert.deepEqual(await cr.saveDayCrates(db, { day: X, customerId: B.id, rows: [row15], actor: sales }), { ok: true, count: 1 });
  const b9 = await glassOrder(B, dayOf(-11), [glassLine(1)]);
  await cr.saveDayCrates(db, { day: dayOf(-11), customerId: B.id, rows: [{ ...row15, crateNo: 9, orderIds: [b9.id] }], actor: sales });
  const crate = await db.crate.findFirstOrThrow({ where: { shipDay: date(X), customerId: B.id } });
  const otherDay = await db.crate.findFirstOrThrow({ where: { shipDay: date(dayOf(-11)), customerId: B.id } });
  const commercial = async () => JSON.stringify(await db.order.findUnique({ where: { id: a1.id }, include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } }, billingBatchOrders: true, fgoDocuments: true } }));
  const before = await commercial();

  // --- Atama: yalnızca yönetici; yalnızca aynı yükleme gününün, başka müşteriye ait sandığı
  for (const role of OTHERS) assert.deepEqual(await cr.assignGuestCrate(db, { day: X, orderId: a1.id, crateId: crate.id, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  for (const [args, code] of [
    [{ day: X, orderId: a1.id, crateId: otherDay.id }, 'NOT_SAME_LOADING'], // başka günün sandığı
    [{ day: dayOf(-11), orderId: a1.id, crateId: otherDay.id }, 'NOT_SAME_LOADING'], // siparişin o gün yüklemesi yok
    [{ day: X, orderId: a9.id, crateId: crate.id }, 'NOT_SAME_LOADING'],
    [{ day: X, orderId: b1.id, crateId: crate.id }, 'OWN_CRATE'],
    [{ day: X, orderId: 'yok', crateId: crate.id }, 'NOT_FOUND'],
    [{ day: X, orderId: a1.id, crateId: 'yok' }, 'NOT_FOUND'],
  ]) assert.deepEqual(await cr.assignGuestCrate(db, { ...args, actor: actor() }), { ok: false, code }, code);
  assert.equal(await db.crateOrder.count({ where: { orderId: a1.id } }), 0);
  const tries = await Promise.all([1, 2].map(() => cr.assignGuestCrate(db, { day: X, orderId: a1.id, crateId: crate.id, actor: actor() })));
  assert.deepEqual(tries.map((x) => x.ok).sort(), [false, true]);
  assert.deepEqual(tries.find((x) => !x.ok), { ok: false, code: 'ALREADY_ASSIGNED' });
  assert.deepEqual((await db.crateOrder.findMany({ where: { crateId: crate.id }, orderBy: { orderId: 'asc' } })).map((x) => x.orderId).sort(), [a1.id, b1.id].sort());
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CROSS_CUSTOMER_CRATE_ASSIGNED', entityId: a1.id } });
  assert.deepEqual([audit.userId, audit.details.ownerCustomerId, audit.details.hostCustomerId, audit.details.crateNo, audit.details.day, audit.details.orderNo], [admin.id, A.id, B.id, 15, X, a1.orderNo]);
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: a1.id, event: 'GUEST_CRATE' } }));

  // --- Ticari hiçbir şey değişmedi: sipariş A'nın, teklif ve sandık parası aynı, sandık B'nin
  assert.equal(await commercial(), before);
  assert.equal((await db.order.findUnique({ where: { id: a1.id } })).customerId, A.id);
  assert.equal((await db.crate.findUnique({ where: { id: crate.id } })).customerId, B.id);
  // Sandık formu (satış) B'nin sandıklarını yeniden kaydeder: A'nın yerleşimi korunur; A'nın siparişi B'nin formundan seçilemez;
  // içinde başka müşterinin camı olan sandık silinemez
  assert.deepEqual(await cr.saveDayCrates(db, { day: X, customerId: B.id, rows: [{ ...row15, note: 'güncel' }], actor: sales }), { ok: true, count: 1 });
  const kept = await db.crate.findFirstOrThrow({ where: { shipDay: date(X), customerId: B.id }, include: { orders: true } });
  assert.deepEqual(kept.orders.map((x) => x.orderId).sort(), [a1.id, b1.id].sort());
  assert.deepEqual(await cr.saveDayCrates(db, { day: X, customerId: B.id, rows: [{ ...row15, orderIds: [a1.id] }], actor: sales }), { ok: false, code: 'BAD_ORDER' });
  assert.deepEqual(await cr.saveDayCrates(db, { day: X, customerId: B.id, rows: [], actor: sales }), { ok: false, code: 'HAS_GUESTS', numbers: [15] });
  assert.deepEqual(await cr.saveDayCrates(db, { day: X, customerId: B.id, rows: [{ ...row15, crateNo: 16 }], actor: sales }), { ok: false, code: 'HAS_GUESTS', numbers: [15] });
  // Nakliye listesi: sandık B'nin grubunda, içinde A'nın siparişi yazıyor; A'nın siparişi "sandığı girilmemiş" değil
  const list = await transportList(db, X);
  assert.deepEqual(list.groups.map((x) => [x.code, x.crates.map((k) => [k.crateNo, k.note])]), [['CRB', [[15, `güncel · + ${a1.orderNo} (CRA)`]]]]);
  assert.deepEqual(list.missing, []);

  // --- Yükleme onayı ve fatura: gerçek müşteriye göre — A'nın siparişi A'nın faturasında, B'ninkinde değil
  assert.equal((await confirm(X)).ok, true);
  assert.deepEqual((await db.loadingConfirmationItem.findMany({ where: { orderId: a1.id } })).map((i) => i.customerId), [A.id, A.id]);
  const view = await billing(X);
  const [ga, gb] = [view.customers.find((x) => x.customerId === A.id).groups[0], view.customers.find((x) => x.customerId === B.id).groups[0]];
  assert.deepEqual([ga.orders.map((x) => x.orderNo), gb.orders.map((x) => x.orderNo)], [[a1.orderNo], [b1.orderNo]]);
  // Kur: A'nın politikası (5,0000 + %2 = 5,1000); B'ninki 5,0000. Sandık parası (30) A'nın cam satırında, B'de yok
  assert.deepEqual([ga.fx.policy, ga.fx.finalRate, gb.fx.policy, gb.fx.finalRate], ['BNR_PLUS_PERCENT', '5.1000', 'BNR', '5.0000']);
  assert.deepEqual([ga.sourceTotal, gb.sourceTotal], [130, 150]);
  const fgo = fakeFgo(300);
  const ia = await invoice(X, A, fgo);
  const ib = await invoice(X, B, fgo);
  assert.deepEqual(fgo.calls.map((f) => [f['Client[Denumire]'], names(f)]), [
    ['Crate Owner A SRL', [`Comanda ${a1.orderNo} — Sticlă securizată`]], ['Crate Host B SRL', [`Comanda ${b1.orderNo} — Sticlă securizată`]],
  ]);
  assert.deepEqual([ia.customerId, ib.customerId, ia.fxRate.toString(), ib.fxRate.toString()], [A.id, B.id, '5.1', '5']);
  assert.ok(!JSON.stringify(fgo.calls[1]).includes(a1.orderNo) && !JSON.stringify(fgo.calls[0]).includes('Crate Host'));
  // Kârlılık: sipariş başına, gerçek siparişinde (sandıktan bağımsız)
  const profit = await dayProfit(X);
  assert.deepEqual([profit.orders, profit.byCur.EUR.sale, profit.byCur.EUR.cost], [2, 280, 175]);

  // --- Yerleşimi kaldırmak faturayı / ticari kaydı değiştirmez
  const batchBefore = JSON.stringify(await db.billingBatch.findUnique({ where: { id: ia.id }, include: { orders: true, lines: true, document: true } }));
  for (const role of OTHERS) assert.deepEqual(await cr.removeGuestCrate(db, { orderId: a1.id, crateId: kept.id, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  assert.deepEqual(await cr.removeGuestCrate(db, { orderId: b1.id, crateId: kept.id, actor: actor() }), { ok: false, code: 'NOT_FOUND' }, 'kendi sandığındaki sipariş bu işlemin konusu değil');
  assert.deepEqual(await cr.removeGuestCrate(db, { orderId: a1.id, crateId: kept.id, actor: actor() }), { ok: true });
  assert.deepEqual(await cr.removeGuestCrate(db, { orderId: a1.id, crateId: kept.id, actor: actor() }), { ok: false, code: 'NOT_FOUND' });
  assert.equal(await db.auditLog.count({ where: { action: 'CROSS_CUSTOMER_CRATE_REMOVED', entityId: a1.id } }), 1);
  assert.equal(JSON.stringify(await db.billingBatch.findUnique({ where: { id: ia.id }, include: { orders: true, lines: true, document: true } })), batchBefore);
  assert.deepEqual((await db.crateOrder.findMany({ where: { crateId: kept.id } })).map((x) => x.orderId), [b1.id]);

  // --- Proforma (ileri gün): A'nın siparişi B'nin sandığında olsa da A'nın proformasına girer, B'ninkine girmez; kapsam denetimi etkilenmez
  const a2 = await glassOrder(A, Y, [glassLine(2)]);
  const b2 = await glassOrder(B, Y, [glassLine(1)]);
  await cr.saveDayCrates(db, { day: Y, customerId: B.id, rows: [{ ...row15, crateNo: 7, orderIds: [b2.id] }], actor: sales });
  const crateY = await db.crate.findFirstOrThrow({ where: { shipDay: date(Y), customerId: B.id } });
  assert.equal((await cr.assignGuestCrate(db, { day: Y, orderId: a2.id, crateId: crateY.id, actor: actor() })).ok, true);
  assert.equal(b.coverageOf(await db.order.findUnique({ where: { id: a2.id }, include: { fgoDocuments: true, billingBatchOrders: true } })), null);
  const pa = await b.previewBatch(db, { customerId: A.id, days: [Y], bnrImpl: bnr('5.0000') });
  const pb = await b.previewBatch(db, { customerId: B.id, days: [Y], bnrImpl: bnr('5.0000') });
  assert.equal((await b.createBatch(db, { customerId: A.id, days: [Y], key: pa.key, actor: actor(), bnrImpl: bnr('5.0000') })).ok, true);
  assert.equal((await b.createBatch(db, { customerId: B.id, days: [Y], key: pb.key, actor: actor(), bnrImpl: bnr('5.0000') })).ok, true);
  const batches = await db.billingBatch.findMany({ where: { kind: 'PROFORMA', customerId: { in: [A.id, B.id] } }, include: { orders: true } });
  assert.deepEqual(batches.map((x) => [x.customerId, x.orders.map((y) => y.orderNo), x.fxRate.toString()]).sort(), [[A.id, [a2.orderNo], '5.1'], [B.id, [b2.orderNo], '5']].sort());
  // Siparişin yükleme günü değişirse başka müşterinin sandığındaki yerleşim kalkar (sandık ev sahibinde kalır); proforma zinciri aynen durur
  const moved = await db.$transaction((tx) => cr.moveOrderCrates(tx, { orderId: a2.id, customerId: A.id, fromDay: Y, toDay: dayOf(41), actor: actor() }));
  assert.deepEqual(moved.guestUnlinked, [7]);
  assert.deepEqual((await db.crateOrder.findMany({ where: { crateId: crateY.id } })).map((x) => x.orderId), [b2.id]);
  assert.equal((await db.crate.findUnique({ where: { id: crateY.id } })).shipDay.toISOString().slice(0, 10), Y);
  assert.equal(await db.billingBatchOrder.count({ where: { orderId: a2.id, activeKey: { not: null } } }), 1);
});

dbTest('aktarılan kalan da aynı günün başka müşteri sandığına konabilir; o günün sandık formunda kendi müşterisinin siparişi sayılır', async () => {
  const D = dayOf(-30), F = dayOf(50);
  const A = await firm('Carry A SRL', 'CYA');
  const B = await firm('Carry B SRL', 'CYB');
  const a = await glassOrder(A, D, [glassLine(5)]);
  const hostOrder = await glassOrder(B, F, [glassLine(1)]);
  assert.equal((await confirm(D, [{ key: lineKey(a), quantity: 2, reason: 'BROKEN' }])).ok, true);
  const [row] = await rp.notLoadedOfDay(db, D);
  const sales = { id: admin.id, role: 'SATIS', ip: '127.0.0.1' };
  const one = { crateNo: 3, lengthMm: null, widthMm: null, heightMm: null, netKg: null, grossKg: null, note: null, orderIds: [] };
  await cr.saveDayCrates(db, { day: F, customerId: B.id, rows: [one], actor: sales });
  const crate = await db.crate.findFirstOrThrow({ where: { shipDay: date(F), customerId: B.id } });
  // Aktarılmadan önce siparişin F gününde yüklemesi yok
  assert.deepEqual(await cr.assignGuestCrate(db, { day: F, orderId: a.id, crateId: crate.id, actor: actor() }), { ok: false, code: 'NOT_SAME_LOADING' });
  assert.deepEqual(await cr.saveDayCrates(db, { day: F, customerId: A.id, rows: [{ ...one, crateNo: 4 }], actor: sales }), { ok: false, code: 'NO_ORDERS' });
  assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: F, actor: actor() })).ok, true);
  assert.deepEqual(await cr.assignGuestCrate(db, { day: F, orderId: a.id, crateId: crate.id, actor: actor() }), { ok: true, crateNo: 3 });
  // Kendi sandığı da girilebilir: aktarılan kalan o günün siparişidir
  assert.deepEqual(await cr.saveDayCrates(db, { day: F, customerId: A.id, rows: [{ ...one, crateNo: 4, orderIds: [a.id] }], actor: sales }), { ok: true, count: 1 });
  const list = await transportList(db, F);
  assert.deepEqual(list.groups.map((x) => [x.code, x.crates.map((k) => [k.crateNo, k.note])]), [['CYA', [[4, '']]], ['CYB', [[3, `+ ${a.orderNo} (CYA)`]]]]);
  assert.deepEqual(list.missing, []);
  // Onay ve fatura yine gerçek müşteride: kalan 2 adet A'nın faturasında
  assert.equal((await confirm(F, [], evening(F))).ok, true);
  const view = await billing(F);
  assert.deepEqual(view.customers.map((x) => [x.name, x.groups[0].orders.map((o) => [o.orderNo, o.lines[0].pieces])]), [['Carry A SRL', [[a.orderNo, 2]]], ['Carry B SRL', [[hostOrder.orderNo, 1]]]]);
});
