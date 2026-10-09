// Müşteri düzeyinde yükleme öncesi proforma (Aşama 7D-2, karar 100) — veritabanıyla.
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR de sahtedir (ağa çıkılmaz).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { dayKey } = await import('../../server/orders/loading.js');
const { listDocuments, paymentStatus, receivables, refreshDocuments, removeDocumentDeletedInFgo } = await import('../../server/accounting/receivables.js');
const { confirmLoading, previewLoading } = await import('../../server/loading/confirmation.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const { isParked, resolveUncertainJob } = await import('../../server/finance/uncertain.js');
const { UNCERTAIN_RECORDERS } = await import('../../server/finance/recorders.js');

const SECRET = 'b'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, abc, other, seq = 0;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
// Yükleme günleri gün ortası (12:00 UTC): Romanya günü ile UTC günü aynı. "Bugün" Romanya gününden alınır — UTC gününden
// alınırsa 21:00–24:00 UTC arasında (Romanya'da gece yarısından sonra) "bugün" dünü gösterir ve test saate bağlı kalır.
const noon = (offset) => new Date(`${dayKey(new Date(Date.now() + offset * 86_400_000))}T12:00:00Z`);
const D1 = noon(10), D2 = noon(17), D3 = noon(24);
const [K1, K2, K3] = [D1, D2, D3].map((d) => dayKey(d));
const fgoOn = () => saveFgoSettings(db, {
  enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21,
}, { key: 'K', secret: SECRET }, actor());

/** Sahte FGO: emitere çağrıları sayılır; getstatus yanıtı ayarlanabilir. Gerçek FGO adresine hiçbir şey gitmez. */
function fakeFgo(start, { status = () => ({ Valoare: '1210.00', ValoareAchitata: '0' }), emit = null } = {}) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const s = status(form);
      return new Response(JSON.stringify(s.gone ? { Success: false, Message: 'Factura nu exista' } : { Success: true, Factura: s }));
    }
    if (emit) { const r = emit(form); if (r) return r; }
    calls.push(form);
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const never = (name) => async () => { throw new Error(`${name} çağrılmamalıydı`); };
const bnr = (rate, date = dayKey(new Date())) => async () => ({ ok: true, rate, date, url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, ...extra });

async function customer(name, prefix, data = {}) {
  return db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@lot.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR', ...data } });
}
/** 2 m² × 50 = 100 (müşteri fiyatı) + isteğe bağlı CNC 2 × 10 */
async function order(c, shipDate, { cnc = false, currency = 'EUR', status = 'URETIMDE', onHold = false, offer = 'GONDERILDI' } = {}) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${String(seq).padStart(3, '0')}`, customerOrderNo: seq, title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status, onHold, estimatedShipDate: shipDate,
      offers: { create: { status: offer, currency, amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          ...(cnc ? [{ sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' }] : []),
        ] } } },
    },
  });
}
const preview = (c, days, extra = {}) => b.previewBatch(db, { customerId: c.id, days, bnrImpl: bnr('5.0000'), ...extra });
async function create(c, days, extra = {}) {
  const p = await preview(c, days, extra);
  return b.createBatch(db, { customerId: c.id, days, key: p.key, actor: actor(), bnrImpl: bnr('5.0000'), ...extra });
}
const batchOf = (id) => db.billingBatch.findUnique({ where: { id }, include: { orders: { orderBy: { orderNo: 'asc' } }, lines: { orderBy: { sortOrder: 'asc' } }, document: true } });
const names = (form) => Object.keys(form).filter((k) => /^Continut\[\d+\]\[Denumire\]$/.test(k)).map((k) => form[k]);

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@lot.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  abc = await customer('ABC Glass SRL', 'ABC');
  other = await customer('Other SRL', 'OTH');
  await fgoOn();
});
after(closeDb);

dbTest('bir müşteri + bir yükleme + bir sipariş → tek parti, tek FGO proforması; yalnızca yönetici', async () => {
  const c = await customer('Solo SRL', 'SOL');
  const o = await order(c, D1);
  const days = await b.customerLoadingDays(db, { customerId: c.id });
  assert.deepEqual(days, [{ day: K1, eligible: 1, excluded: 0 }]);
  assert.ok((await b.batchCustomers(db)).some((x) => x.id === c.id));
  const p = await preview(c, [K1]);
  assert.deepEqual([p.included.length, p.excluded.length, p.problems, p.currency, p.sourceTotal, p.ronNet, p.ronGross], [1, 0, [], 'EUR', 100, 500, 605]);

  // Yetki sunucuda: yönetici dışındaki roller oluşturamaz, yeniden deneyemez, vazgeçemez
  for (const role of ['CUSTOMER', 'SALES', 'DRAWING', 'INSPECTOR', null]) {
    assert.deepEqual(await b.createBatch(db, { customerId: c.id, days: [K1], key: p.key, actor: actor(role), bnrImpl: bnr('5.0000') }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  assert.equal(await db.billingBatch.count({ where: { customerId: c.id } }), 0);

  const r = await b.createBatch(db, { customerId: c.id, days: [K1], key: p.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r.ok, true);
  assert.equal(r.orders, 1);
  const fgo = fakeFgo(100);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId })), { done: 1, failed: 0 });
  assert.equal(fgo.calls.length, 1);
  const f = fgo.calls[0];
  assert.deepEqual([f.Serie, f.Valuta, f.IdExtern, f['Continut[0][Denumire]'], f['Continut[0][NrProduse]'], f['Continut[0][UM]'], f['Continut[0][PretUnitar]']],
    ['PRF', 'RON', `LOT-${r.batchId}`, `Comanda ${o.orderNo} — Sticlă securizată 10 mm`, '2', 'mp', '250.00']);
  assert.match(f.Text, new RegExp(`^Comanda: ${o.orderNo}\\. Încărcare planificată: \\d{2}\\.\\d{2}\\.\\d{4}\\.$`));
  const bt = await batchOf(r.batchId);
  assert.deepEqual([bt.status, bt.document.kind, `${bt.document.series}${bt.document.number}`, bt.document.orderId, bt.document.total.toString()], ['ISSUED', 'PROFORMA', 'PRF101', null, '1210']);
  for (const role of ['SALES', 'CUSTOMER']) assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r.batchId, action: 'void', actor: actor(role) }), { ok: false, code: 'FORBIDDEN' });
  // Sipariş geçmişi ve denetim kaydı
  assert.deepEqual((await db.orderEvent.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.event), ['FGO_DOC_REQUESTED', 'FGO_DOC_ISSUED']);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'BILLING_BATCH_CREATED', entityId: r.batchId } }));
});

dbTest('bir müşteri + birden çok yükleme günü + birden çok sipariş → TEK proforma; seçilmeyen gün ve başka müşteri dışarıda; sipariş no\'ları ve günler korunur', async () => {
  const a1 = await order(abc, D1, { cnc: true });
  const a2 = await order(abc, D1);
  const a4 = await order(abc, D2);
  const a5 = await order(abc, D3); // seçilmeyen gün
  const x1 = await order(other, D1); // başka müşteri, aynı gün
  assert.deepEqual((await b.customerLoadingDays(db, { customerId: abc.id })).map((d) => [d.day, d.eligible]), [[K1, 2], [K2, 1], [K3, 1]]);

  const p = await preview(abc, [K1, K2]);
  assert.deepEqual(p.included.map((o) => o.orderNo), [a1.orderNo, a2.orderNo, a4.orderNo]);
  assert.deepEqual(p.byDay.map((d) => [d.day, d.orders.map((o) => o.orderNo)]), [[K1, [a1.orderNo, a2.orderNo]], [K2, [a4.orderNo]]]);
  assert.equal(p.sourceTotal, 320, '100 + 20 (CNC) + 100 + 100');
  const r = await b.createBatch(db, { customerId: abc.id, days: [K1, K2], key: p.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r.ok, true);
  const fgo = fakeFgo(200);
  await b.dispatchBatchJobs(db, ctx(fgo));
  assert.equal(fgo.calls.length, 1, 'sipariş ya da gün başına değil: tek proforma');
  const f = fgo.calls[0];
  // Satırlar siparişler arasında birleştirilmez; her açıklama kaynak sipariş numarasıyla başlar
  assert.deepEqual(names(f), [
    `Comanda ${a1.orderNo} — Sticlă securizată 10 mm`, `Comanda ${a1.orderNo} — Prelucrare CNC`,
    `Comanda ${a2.orderNo} — Sticlă securizată 10 mm`, `Comanda ${a4.orderNo} — Sticlă securizată 10 mm`,
  ]);
  assert.equal(f['Continut[1][PretUnitar]'], '50.00', 'CNC 10 EUR × 5');
  assert.ok(f.Text.startsWith(`Comenzi: ${a1.orderNo}, ${a2.orderNo}, ${a4.orderNo}. Încărcări planificate: `));
  assert.ok(!JSON.stringify(f).includes(a5.orderNo) && !JSON.stringify(f).includes(x1.orderNo), 'seçilmeyen gün ve başka müşteri belgede yok');
  const bt = await batchOf(r.batchId);
  assert.deepEqual(bt.loadingDays.map((d) => d.toISOString().slice(0, 10)), [K1, K2], 'seçilen günler partide');
  assert.deepEqual(bt.orders.map((o) => [o.orderNo, o.loadingDay.toISOString().slice(0, 10), o.sourceAmount.toString()]), [[a1.orderNo, K1, '120'], [a2.orderNo, K1, '100'], [a4.orderNo, K2, '100']]);
  assert.deepEqual([bt.currency, bt.sourceTotal.toString(), bt.ronNet.toString(), bt.lines.length], ['EUR', '320', '1600', 4]);

  // Cam Tahsilat: müşteri proforması BİR kez; borç bir kez sayılır
  const docs = (await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.batchId === r.batchId);
  assert.equal(docs.length, 1);
  assert.deepEqual([docs[0].orderId, docs[0].batch.customer.name, docs[0].batch.orders.map((o) => o.orderNo)], [null, 'ABC Glass SRL', [a1.orderNo, a2.orderNo, a4.orderNo]]);
  const rec = receivables(docs);
  assert.deepEqual(rec.sums, { RON: { total: 1210, paid: 0, rest: 1210 } });
  assert.equal((await listDocuments(db, 'PROFILE_ORDER')).filter((d) => d.batchId).length, 0, 'profil tahsilatında görünmez');

  // Kapsanan sipariş için sipariş başına belge istenemez (tek çift faturalama denetimi); parti dışındaki sipariş için istenebilir
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: a1.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(g.billingState({ status: 'URETIMDE', loaded: true, docs: [], pending: [], hasOffer: true, inBatch: true }), { actions: [], wait: 'batch', paid: 0, advanced: 0, advanceRequired: 0 });
  // Aynı siparişler yeni partiye giremez: önizlemede nedenleriyle dışarıda
  const again = await preview(abc, [K1, K2, K3]);
  assert.deepEqual(again.included.map((o) => o.orderNo), [a5.orderNo]);
  assert.deepEqual(again.excluded.map((o) => [o.orderNo, o.reason, o.ref]), [[a1.orderNo, 'IN_BATCH', 'PRF201'], [a2.orderNo, 'IN_BATCH', 'PRF201'], [a4.orderNo, 'IN_BATCH', 'PRF201']]);
  // Veritabanı da engeller: aynı sipariş aynı türden iki etkin partide olamaz
  await assert.rejects(db.billingBatchOrder.create({ data: { batchId: r.batchId, orderId: a1.id, orderNo: 'X', offerId: 'x', loadingDay: D1, sourceAmount: '1', activeKey: b.activeKeyOf(a1.id) } }), /Unique constraint/);
  await assert.rejects(db.fgoDocument.create({ data: { batchId: r.batchId, kind: 'PROFORMA', series: 'PRF', number: '9999', issuedAt: new Date() } }), /Unique constraint/, 'parti başına tek FGO belgesi');
});

dbTest('uygun olmayan siparişler nedenleriyle dışarıda: iptal, beklemede, gönderilmiş teklif yok, sipariş belgesi, kuyruktaki istek, onaylı yükleme', async () => {
  const c = await customer('Reasons SRL', 'RSN');
  const okOrder = await order(c, D1);
  const cancelled = await order(c, D1, { status: 'IPTAL' });
  const held = await order(c, D1, { onHold: true });
  const draft = await order(c, D1, { offer: 'YONETIMDE' });
  const withDoc = await order(c, D1);
  await db.fgoDocument.create({ data: { orderId: withDoc.id, kind: 'PROFORMA', series: 'PRF', number: '7001', issuedAt: new Date() } });
  const queued = await order(c, D1);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: queued.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  const noPrice = await order(c, D1);
  await db.offerLine.updateMany({ where: { offer: { orderId: noPrice.id } }, data: { offerPrice: null } });
  const p = await preview(c, [K1]);
  assert.deepEqual(p.included.map((o) => o.orderNo), [okOrder.orderNo]);
  assert.deepEqual(Object.fromEntries(p.excluded.map((o) => [o.orderNo, o.reason])), {
    [cancelled.orderNo]: 'CANCELLED', [held.orderNo]: 'ON_HOLD', [draft.orderNo]: 'NO_SENT_OFFER', [withDoc.orderNo]: 'ORDER_DOCUMENT',
    [queued.orderNo]: 'ORDER_PENDING', [noPrice.orderNo]: 'NO_PRICES',
  });
  assert.equal(p.excluded.find((o) => o.orderNo === withDoc.orderNo).ref, 'PRF7001');
  assert.deepEqual(await b.customerLoadingDays(db, { customerId: c.id }), [{ day: K1, eligible: 1, excluded: 6 }]);
  // Yalnızca uygun olmayanların olduğu gün: parti oluşturulmaz
  const c2 = await customer('Empty SRL', 'EMP');
  await order(c2, D1, { status: 'IPTAL' });
  const e = await preview(c2, [K1]);
  assert.deepEqual(e.problems, ['NOTHING_ELIGIBLE']);
  assert.deepEqual(await b.createBatch(db, { customerId: c2.id, days: [K1], key: e.key, actor: actor(), bnrImpl: bnr('5.0000') }), { ok: false, code: 'NOTHING_ELIGIBLE' });
  assert.deepEqual((await preview(c2, [])).problems, ['NO_DAYS']);
  assert.deepEqual((await preview(c2, [dayKey(noon(-3))])).problems, ['PAST_DAY', 'NOTHING_ELIGIBLE']);

  // Yüklemesi onaylanmış sipariş (7C) yükleme ÖNCESİ proformaya girmez; onayın kendisi değişmez
  const c3 = await customer('Loaded SRL', 'LDD');
  const today = noon(0);
  const loaded = await order(c3, today);
  const day = dayKey(today);
  const plan = await previewLoading(db, day);
  const conf = await confirmLoading(db, { day, key: plan.key, actor: { id: admin.id, role: 'ADMIN' } });
  assert.equal(conf.ok, true);
  const lp = await preview(c3, [day]);
  assert.deepEqual(lp.excluded.map((o) => [o.orderNo, o.reason]), [[loaded.orderNo, 'ALREADY_LOADED']]);
  assert.equal(await db.loadingConfirmationItem.count({ where: { orderId: loaded.id } }), 1);
});

dbTest('ticari kopya ve kur kaydı değişmez: parti oluştuktan sonra teklif, yükleme günü, kur politikası ve BNR değişse de belge partiden kesilir', async () => {
  const c = await customer('Snap SRL', 'SNP', { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' });
  const o = await order(c, D1);
  const p = await b.previewBatch(db, { customerId: c.id, days: [K1], bnrImpl: bnr('5.1000', '2026-10-02') });
  assert.deepEqual([p.fx.policy, p.fx.baseRate, p.fx.markupPercent, p.fx.finalRate, p.fx.sourceDate], ['BNR_PLUS_PERCENT', '5.1000', '2.000', '5.2020', '2026-10-02'], 'müşterinin kur politikası');
  // BNR önizlemeden sonra değiştiyse parti oluşturulmaz (önizlenen = kesilen)
  assert.deepEqual(await b.createBatch(db, { customerId: c.id, days: [K1], key: p.key, actor: actor(), bnrImpl: bnr('5.3000') }), { ok: false, code: 'STALE_PREVIEW' });
  const r = await b.createBatch(db, { customerId: c.id, days: [K1], key: p.key, actor: actor(), bnrImpl: bnr('5.1000', '2026-10-02') });
  assert.equal(r.ok, true);
  const before = await batchOf(r.batchId);
  assert.deepEqual(
    [before.fxRate.toString(), before.fxBaseRate.toString(), before.fxMarkupPercent.toString(), before.fxPolicy, before.fxSource, before.fxCurrency, before.fxManual, before.fxSourceDate.toISOString().slice(0, 10)],
    ['5.202', '5.1', '2', 'BNR_PLUS_PERCENT', 'BNR', 'EUR', false, '2026-10-02'],
  );
  assert.ok(before.fxResolvedAt instanceof Date);

  // Sonradan her şey değişir
  await db.offerLine.updateMany({ where: { offer: { orderId: o.id } }, data: { offerPrice: '99', adet: 9, descriptionRo: 'ALTCEVA' } });
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: D3 } });
  await db.customer.update({ where: { id: c.id }, data: { fxPolicy: 'BT_UNIT_SELL', fxMarkupPercent: null } });
  const fgo = fakeFgo(300);
  await b.dispatchBatchJobs(db, ctx(fgo, { bnrImpl: never('BNR (parti kuru yeniden çözmez)') }));
  const f = fgo.calls[0];
  assert.deepEqual([f['Continut[0][Denumire]'], f['Continut[0][NrProduse]'], f['Continut[0][PretUnitar]']], [`Comanda ${o.orderNo} — Sticlă securizată 10 mm`, '2', '260.10'], '50 EUR × 5,2020 — oluşturma anındaki içerik ve kur');
  const afterB = await batchOf(r.batchId);
  for (const k of ['fxRate', 'fxBaseRate', 'fxMarkupPercent', 'fxPolicy', 'fxSource', 'fxSourceDate', 'fxResolvedAt', 'fxDate', 'sourceTotal', 'ronNet', 'selectionKey']) assert.equal(String(afterB[k]), String(before[k]), k);
  assert.deepEqual(afterB.loadingDays.map((d) => d.toISOString().slice(0, 10)), [K1], 'seçilen gün partide; siparişin yeni günü etkilemez');
  assert.deepEqual(afterB.orders.map((x) => x.loadingDay.toISOString().slice(0, 10)), [K1]);
  assert.deepEqual(afterB.lines.map((l) => [l.name, l.quantity.toString(), l.unitPrice.toString(), l.amount.toString()]), before.lines.map((l) => [l.name, l.quantity.toString(), l.unitPrice.toString(), l.amount.toString()]));
});

dbTest('kur: elle kur (MANUAL); BT politikasında BT XML yok — günün BT kuru girilmeden parti oluşturulamaz; RON tekliflerde çevrim yok; karışık para birimi engellenir', async () => {
  // Elle kur
  const m = await customer('Manual SRL', 'MAN', { fxPolicy: 'BNR' });
  await order(m, D1);
  const pm = await b.previewBatch(db, { customerId: m.id, days: [K1], manualRate: '5,3000', bnrImpl: never('BNR') });
  assert.deepEqual([pm.fx.source, pm.fx.finalRate, pm.fx.manual, pm.ronNet], ['MANUAL', '5.3000', true, 530]);
  const rm = await b.createBatch(db, { customerId: m.id, days: [K1], key: pm.key, manualRate: '5,3000', actor: actor(), bnrImpl: never('BNR') });
  assert.equal(rm.ok, true);
  const bm = await batchOf(rm.batchId);
  assert.deepEqual([bm.fxRate.toString(), bm.fxSource, bm.fxManual, bm.fxPolicy], ['5.3', 'MANUAL', true, 'BNR']);
  const mf = fakeFgo(450);
  await b.dispatchBatchJobs(db, ctx(mf, { onlyBatchId: rm.batchId }));
  assert.equal(mf.calls[0]['Continut[0][PretUnitar]'], '265.00', '50 × 5,3000');
  assert.deepEqual((await preview(m, [K1], { manualRate: 'abc' })).problems, ['NOTHING_ELIGIBLE'], 'siparişler artık partide');

  // BT_UNIT_SELL: otomatik kaynak yok; XML'e giden yol yok
  await db.integrationSetting.deleteMany({ where: { key: 'fx.daily' } });
  const t = await customer('Bt SRL', 'BTS', { fxPolicy: 'BT_UNIT_SELL' });
  await order(t, D1);
  const pt = await b.previewBatch(db, { customerId: t.id, days: [K1], bnrImpl: never('BNR'), rateImpl: never('BT XML') });
  assert.deepEqual([pt.fx, pt.fxError.code, pt.problems], [null, 'BT_MANUAL_REQUIRED', ['FX_UNAVAILABLE']]);
  assert.deepEqual(await b.createBatch(db, { customerId: t.id, days: [K1], key: pt.key, actor: actor(), bnrImpl: never('BNR') }), { ok: false, code: 'FX_UNAVAILABLE' });
  assert.equal(await db.billingBatch.count({ where: { customerId: t.id } }), 0);
  await saveDailyRate(db, { day: dayKey(new Date()), rate: 5.4412 }, actor(), writeAudit);
  const pt2 = await b.previewBatch(db, { customerId: t.id, days: [K1], bnrImpl: never('BNR') });
  assert.deepEqual([pt2.fx.source, pt2.fx.finalRate, pt2.problems], ['MANUAL_DAY', '5.4412', []]);

  // RON teklifler: kur 1; EUR ile karışık seçim engellenir (para birimleri toplanmaz)
  const x = await customer('Mixed SRL', 'MIX');
  await order(x, D1);
  await order(x, D2, { currency: 'RON' });
  const mixed = await preview(x, [K1, K2]);
  assert.deepEqual([mixed.problems, mixed.currency, mixed.ronNet, [...mixed.currencies].sort()], [['MIXED_CURRENCY'], null, null, ['EUR', 'RON']]);
  assert.deepEqual(await b.createBatch(db, { customerId: x.id, days: [K1, K2], key: mixed.key, actor: actor(), bnrImpl: bnr('5.0000') }), { ok: false, code: 'MIXED_CURRENCY' });
  const ron = await b.previewBatch(db, { customerId: x.id, days: [K2], bnrImpl: never('BNR') });
  assert.deepEqual([ron.currency, ron.fx.source, ron.fx.finalRate, ron.sourceTotal, ron.ronNet, ron.problems], ['RON', 'RON', '1.0000', 100, 100, []]);
  const rr = await b.createBatch(db, { customerId: x.id, days: [K2], key: ron.key, actor: actor(), bnrImpl: never('BNR') });
  const fgo = fakeFgo(400);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: rr.batchId }));
  assert.equal(fgo.calls[0]['Continut[0][PretUnitar]'], '50.00', 'RON fiyat olduğu gibi');
});

dbTest('çift tıklama / eşzamanlı istek / işçi yeniden denemesi: tek parti, tek FGO proforması', async () => {
  const c = await customer('Twice SRL', 'TWC');
  await order(c, D1);
  await order(c, D1);
  const p = await preview(c, [K1]);
  const make = () => b.createBatch(db, { customerId: c.id, days: [K1], key: p.key, actor: actor(), bnrImpl: bnr('5.0000') });
  const results = await Promise.all([make(), make(), make()]);
  assert.equal(results.filter((r) => r.ok).length, 1, 'aynı anda üç istekten yalnızca biri parti oluşturur');
  assert.ok(results.filter((r) => !r.ok).every((r) => ['NOTHING_ELIGIBLE', 'STALE_PREVIEW', 'ALREADY_COVERED'].includes(r.code)));
  assert.deepEqual(await make(), { ok: false, code: 'NOTHING_ELIGIBLE' }, 'sayfa yenileme / yeniden gönderme');
  assert.equal(await db.billingBatch.count({ where: { customerId: c.id } }), 1);
  const batchId = results.find((r) => r.ok).batchId;

  // İşçi: geçici FGO hatası → yeniden denenir (kur ve satırlar partiden; yeni parti oluşmaz); eşzamanlı iki tur tek belge keser.
  // 429 = FGO isteği işlemedi (sonuç kesin). 5xx / zaman aşımı belirsizdir ve yöneticiye gider (test/db/finance.test.js).
  let down = true;
  const fgo = fakeFgo(500, { emit: () => (down ? new Response('oops', { status: 429 }) : null) });
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: batchId })), { done: 0, failed: 1 });
  let bt = await batchOf(batchId);
  assert.equal(bt.status, 'PENDING');
  assert.ok(bt.lastError);
  down = false;
  await db.notificationOutbox.updateMany({ where: { type: b.BATCH_FGO, status: 'PENDING' }, data: { availableAt: new Date(0) } });
  const turns = await Promise.all([b.dispatchBatchJobs(db, ctx(fgo)), b.dispatchBatchJobs(db, ctx(fgo))]);
  assert.equal(turns.reduce((s, x) => s + x.done, 0), 1);
  assert.equal(fgo.calls.length, 1, 'tek FGO proforması');
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo)), { done: 0, failed: 0 });
  bt = await batchOf(batchId);
  assert.deepEqual([bt.status, bt.lastError, `${bt.document.series}${bt.document.number}`], ['ISSUED', null, 'PRF501']);
  assert.equal(await db.fgoDocument.count({ where: { batchId } }), 1);
});

dbTest('belirsiz FGO yanıtı (müşteri proforması, karar 209): parti beklemede kalır, siparişler tutulur, yeniden denenmez; yönetici FGO\'daki belgeyi doğrulayıp kaydeder ya da vazgeçer', async () => {
  // FGO belgeyi KESTİ ama yanıt kayboldu (504): belge FGO'da PRF801 olarak var, TAKİP bilmiyor
  let mode = 'lost';
  const inFgo = new Map();
  const fgo = fakeFgo(800, {
    status: (form) => inFgo.get(`${form.Serie}${form.Numar}`) ?? { gone: true },
    emit: () => (mode === 'lost' ? new Response('Gateway Timeout', { status: 504 }) : null),
  });
  const c = await customer('Belirsiz Lot SRL', 'BLT');
  await order(c, D1);
  const r = await create(c, [K1]);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId })), { done: 0, failed: 1 });
  let bt = await batchOf(r.batchId);
  assert.equal(bt.status, 'PENDING');
  assert.match(bt.lastError, /^\[BELIRSIZ\]/);
  const job = await db.notificationOutbox.findFirst({ where: { type: b.BATCH_FGO, payload: { path: ['batchId'], equals: r.batchId } } });
  assert.ok(isParked(job));
  const expected = job.payload.uncertain.expectedGross;
  assert.ok(expected > 0);
  assert.equal(await db.adminAlert.count({ where: { type: 'FGO_UNCERTAIN', resolvedAt: null, details: { path: ['batchId'], equals: r.batchId } } }), 1);
  assert.deepEqual((await preview(c, [K1])).excluded.map((x) => x.reason), ['IN_BATCH'], 'parti siparişleri tutar');
  mode = 'ok';
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { now: new Date(Date.now() + 86_400_000) })), { done: 0, failed: 0 }, 'yeniden denenmez');
  assert.equal(fgo.calls.length, 0);
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r.batchId, action: 'retry', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'belirsiz parti "kesilemedi" değildir');
  const resolve = (o) => resolveUncertainJob(db, { jobId: job.id, actor: actor(), secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, recorders: UNCERTAIN_RECORDERS, ...o });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'PRF', number: '801', actor: actor('SALES') }), { ok: false, code: 'FORBIDDEN' });
  inFgo.set('PRF802', { Valoare: '1210.00', ValoareAchitata: '0' });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'PRF', number: '802' }), { ok: false, code: 'TOTAL_MISMATCH', fgoTotal: 1210, expected });
  inFgo.set('PRF801', { Valoare: expected.toFixed(2), ValoareAchitata: '0' });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'PRF', number: '801' }), { ok: true, doc: 'PRF801' });
  bt = await batchOf(r.batchId);
  assert.deepEqual([bt.status, `${bt.document.series}${bt.document.number}`, bt.lastError], ['ISSUED', 'PRF801', null]);
  assert.equal(fgo.calls.length, 0, 'belge kesme isteği gitmedi');
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: job.id } })).status, 'SENT');
  assert.equal(await db.adminAlert.count({ where: { type: 'FGO_UNCERTAIN', resolvedAt: null, details: { path: ['batchId'], equals: r.batchId } } }), 0);

  // Vazgeç: parti FAILED olur — mevcut "yeniden dene / vazgeç" kararı yöneticide; vazgeçince siparişler yeniden uygun
  const c2 = await customer('Vazgec Lot SRL', 'VZL');
  await order(c2, D1);
  const r2 = await create(c2, [K1]);
  mode = 'lost';
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r2.batchId })), { done: 0, failed: 1 });
  mode = 'ok';
  const job2 = await db.notificationOutbox.findFirst({ where: { type: b.BATCH_FGO, payload: { path: ['batchId'], equals: r2.batchId } } });
  assert.deepEqual(await resolveUncertainJob(db, { jobId: job2.id, action: 'ABANDON', confirm: true, actor: actor(), recorders: UNCERTAIN_RECORDERS }), { ok: true });
  assert.equal((await batchOf(r2.batchId)).status, 'FAILED');
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r2.batchId, action: 'void', actor: actor() }), { ok: true });
  assert.deepEqual((await preview(c2, [K1])).excluded, []);
});

dbTest('FGO kesin reddederse parti FAILED: siparişler tutulur; yönetici yeniden dener ya da vazgeçer (siparişler yeniden uygun)', async () => {
  const c = await customer('Fail SRL', 'FAL');
  const o = await order(c, D1);
  const r = await create(c, [K1]);
  const reject = fakeFgo(600, { emit: () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' })) });
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(reject, { onlyBatchId: r.batchId })), { done: 0, failed: 1 });
  let bt = await batchOf(r.batchId);
  assert.equal(bt.status, 'FAILED');
  assert.match(bt.lastError, /Client invalid/);
  assert.equal(await db.adminAlert.count({ where: { type: 'FGO_FAILED', details: { path: ['batchId'], equals: r.batchId } } }), 1);
  assert.deepEqual((await preview(c, [K1])).excluded.map((x) => x.reason), ['IN_BATCH'], 'başarısız parti siparişi tutar');
  // Yeniden dene → kesilir
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r.batchId, action: 'retry', actor: actor() }), { ok: true });
  const fgo = fakeFgo(600);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId })), { done: 1, failed: 0 });
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r.batchId, action: 'void', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'kesilmiş partiden vazgeçilemez');

  // Vazgeç → siparişler yeniden uygun; parti kaydı denetim için durur
  const c2 = await customer('Void SRL', 'VOI');
  const o2 = await order(c2, D1);
  const r2 = await create(c2, [K1]);
  await b.dispatchBatchJobs(db, ctx(reject, { onlyBatchId: r2.batchId }));
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r2.batchId, action: 'void', actor: actor() }), { ok: true });
  bt = await batchOf(r2.batchId);
  assert.deepEqual([bt.status, bt.voidReason, bt.orders.map((x) => x.activeKey), bt.lines.length], ['VOID', 'ADMIN', [null], 1]);
  assert.deepEqual((await preview(c2, [K1])).included.map((x) => x.orderNo), [o2.orderNo]);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o2.id, kind: 'PROFORMA', actor: actor() }), { ok: true }, 'sipariş başına proforma da yeniden istenebilir');
  assert.ok(o.id);
});

dbTest('FGO durumu mevcut eşitlemeyle: ödenmedi / kısmi / ödendi; FGO\'da silinen müşteri proforması yalnızca belge kaydını kaldırır, siparişler yeniden uygun', async () => {
  const c = await customer('Sync SRL', 'SYN');
  const o1 = await order(c, D1);
  const o2 = await order(c, D2);
  const r = await create(c, [K1, K2]);
  let paid = '0';
  let gone = false;
  // Yalnızca bu partinin belgesi (PRF701) için ödeme / silinme canlandırılır; diğer belgeler ödenmemiş kalır
  const fgo = fakeFgo(700, { status: (form) => (form.Numar !== '701' ? { Valoare: '1210.00', ValoareAchitata: '0' } : gone ? { gone: true } : { Valoare: '1210.00', ValoareAchitata: paid }) });
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  const doc = () => db.fgoDocument.findFirst({ where: { batchId: r.batchId } });
  const sync = (auto = false) => refreshDocuments(db, { orderType: 'GLASS_ORDER', auto, secret: SECRET, fetchImpl: fgo.fetchImpl, sleep: async () => {} });
  let d = await doc();
  assert.equal(paymentStatus(d.total, d.paid), 'UNPAID');
  paid = '400.00';
  assert.equal((await sync()).ok, true);
  d = await doc();
  assert.deepEqual([paymentStatus(d.total, d.paid), d.paid.toString(), d.checkError], ['PARTIAL', '400', null]);
  assert.deepEqual(receivables([d]).sums, { RON: { total: 1210, paid: 400, rest: 810 } });
  paid = '1210.00';
  await sync(true);
  d = await doc();
  assert.equal(paymentStatus(d.total, d.paid), 'PAID');
  await db.fgoDocument.update({ where: { id: d.id }, data: { paid: '0' } });

  // Otomatik tur FGO "belge yok" dese de kaydı silmez; elle "FGO ile Güncelle" kaldırır
  gone = true;
  await sync(true);
  assert.ok(await doc(), 'otomatik tur silmez');
  assert.equal((await batchOf(r.batchId)).status, 'ISSUED');
  const ordersBefore = await db.order.findMany({ where: { customerId: c.id }, orderBy: { orderNo: 'asc' }, include: { offers: { include: { lines: true } } } });
  await sync(false);
  assert.equal(await doc(), null, 'belge kaydı kalktı');
  const bt = await batchOf(r.batchId);
  assert.deepEqual([bt.status, bt.voidReason, bt.orders.map((x) => x.activeKey), bt.lines.length], ['VOID', 'FGO_DELETED', [null, null], 2], 'parti geçersiz; kopyası denetim için durur');
  // Siparişler, teklifler ve yükleme planı değişmedi
  const ordersAfter = await db.order.findMany({ where: { customerId: c.id }, orderBy: { orderNo: 'asc' }, include: { offers: { include: { lines: true } } } });
  assert.deepEqual(ordersAfter.map((x) => [x.status, x.estimatedShipDate.toISOString(), x.offers.length, x.offers[0].lines.length]), ordersBefore.map((x) => [x.status, x.estimatedShipDate.toISOString(), x.offers.length, x.offers[0].lines.length]));
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: o1.id, event: 'FGO_DOC_DELETED', note: 'PRF701' } }));
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REMOVED', entityType: 'BillingBatch', entityId: r.batchId } }));
  // Yeniden uygun: yeni parti oluşturulabilir
  gone = false;
  const again = await preview(c, [K1, K2]);
  assert.deepEqual(again.included.map((x) => x.orderNo), [o1.orderNo, o2.orderNo]);
  const r2 = await b.createBatch(db, { customerId: c.id, days: [K1, K2], key: again.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r2.ok, true);
  assert.notEqual(r2.batchId, r.batchId);
});

dbTest('"TAKİP\'ten kaldır" (karar 132): FGO\'da elle silinmiş müşteri proforması — FGO\'da duruyorsa ya da doğrulanamıyorsa parti aynen; kesin "belge yok"ta yalnızca belge kaydı kalkar, parti geçersiz olur, siparişler yeniden uygun', async () => {
  const c = await customer('Kaldir SRL', 'KLD');
  const o1 = await order(c, D1);
  const o2 = await order(c, D2);
  const r = await create(c, [K1, K2]);
  let mode = 'ok';
  const asked = [];
  const answer = () => {
    if (mode === 'gone') return { gone: true };
    return { Valoare: '1210.00', ValoareAchitata: '0' };
  };
  const fgo = fakeFgo(900, { status: (form) => (form.Numar === '901' ? answer() : { Valoare: '1210.00', ValoareAchitata: '0' }) });
  const fetchImpl = async (url, init) => {
    asked.push(`${init.method} ${String(url).split('/v1')[1]}`);
    if (mode === 'down') throw new Error('ETIMEDOUT');
    if (mode === 'auth') return new Response(JSON.stringify({ Success: false, Message: 'Hash invalid' }));
    return fgo.fetchImpl(url, init);
  };
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  const doc = await db.fgoDocument.findFirst({ where: { batchId: r.batchId } });
  assert.equal(`${doc.series}${doc.number}`, 'PRF901');
  const remove = (who = actor()) => removeDocumentDeletedInFgo(db, { docId: doc.id, actor: who, secret: SECRET, fetchImpl });
  const snapshot = async () => JSON.stringify([await batchOf(r.batchId), await db.order.findMany({ where: { customerId: c.id }, orderBy: { orderNo: 'asc' } }), await db.orderEvent.count({ where: { orderId: { in: [o1.id, o2.id] } } })]);
  const before = await snapshot();

  // Yönetici değil → reddedilir (FGO'ya gidilmez); FGO'da duruyor → kaldırılmaz; doğrulanamıyor → kaldırılmaz
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) assert.deepEqual(await remove(actor(role)), { ok: false, code: 'FORBIDDEN' }, role);
  assert.deepEqual(asked, []);
  assert.deepEqual(await remove(), { ok: false, code: 'EXISTS', doc: 'PRF901' });
  for (const m of ['down', 'auth']) {
    mode = m;
    assert.deepEqual(await remove(), { ok: false, code: 'UNVERIFIED', doc: 'PRF901' }, m);
  }
  assert.equal((await batchOf(r.batchId)).status, 'ISSUED');
  assert.deepEqual((await batchOf(r.batchId)).orders.map((x) => x.activeKey != null), [true, true], 'siparişler partide kalır');
  const kept = JSON.parse(await snapshot());
  const was = JSON.parse(before);
  // Yalnızca belgenin son kontrol zamanı / hatası değişmiş olabilir (FGO'da duruyor yanıtı yazıldı); parti ve siparişler aynen
  assert.deepEqual([kept[0].status, kept[0].voidReason, kept[0].orders, kept[0].lines, kept[1], kept[2]], [was[0].status, was[0].voidReason, was[0].orders, was[0].lines, was[1], was[2]]);

  // Kesin "belge yok": mevcut temizlik yolu — belge kaydı kalkar, parti geçersiz, siparişlere geçmiş satırı
  mode = 'gone';
  assert.deepEqual(await remove(), { ok: true, doc: 'PRF901', orderId: null });
  assert.equal(await db.fgoDocument.findFirst({ where: { batchId: r.batchId } }), null);
  const bt = await batchOf(r.batchId);
  assert.deepEqual([bt.status, bt.voidReason, bt.orders.map((x) => x.activeKey), bt.lines.length], ['VOID', 'FGO_DELETED', [null, null], 2], 'parti geçersiz; kopyası denetim için durur');
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: o1.id, event: 'FGO_DOC_DELETED', note: 'PRF901' } }));
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REMOVED', entityType: 'BillingBatch', entityId: r.batchId } }));
  const reqs = await db.auditLog.findMany({ where: { action: 'FGO_DOC_REMOVE_REQUEST', entityId: doc.id } });
  assert.deepEqual(reqs.map((a) => a.details.result).sort(), ['EXISTS', 'REMOVED', 'UNVERIFIED', 'UNVERIFIED']);
  assert.ok(reqs.every((a) => a.userId === admin.id && a.details.batchId === r.batchId));
  // FGO'ya yalnızca durum soruldu (kesme / silme yok)
  assert.ok(asked.length === 4 && asked.every((q) => q === 'POST /factura/getstatus'), asked.join(' | '));
  // Siparişler yeniden uygun: aynı kapsamla yeni müşteri proforması oluşturulabilir (çift kapsama yok)
  mode = 'ok';
  const again = await preview(c, [K1, K2]);
  assert.deepEqual(again.included.map((x) => x.orderNo), [o1.orderNo, o2.orderNo]);
  const r2 = await b.createBatch(db, { customerId: c.id, days: [K1, K2], key: again.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(r2.ok, true);
  assert.equal(await db.billingBatch.count({ where: { customerId: c.id, status: { not: 'VOID' } } }), 1);
});

dbTest('müşteriye e-posta: müşteri proforması firmanın e-postasına, kaynak sipariş numaralarıyla', async () => {
  const sent = [];
  // Sahte FGO (ağa çıkılmaz): bağlantı factura/print ile alınır, PDF oradan indirilir
  const pdfFetch = async (url) => (String(url).endsWith('/factura/print')
    ? new Response(JSON.stringify({ Success: true, Factura: { Link: 'https://www.fgo.ro/facturi/x.pdf' } }))
    : new Response(Buffer.from('%PDF-1.4 sahte')));
  const res = await g.dispatchDocEmails(db, { transport: { sendMail: async (m) => { sent.push(m); return {}; } }, from: 'info@gkh.ro', appUrl: 'https://t', secret: SECRET, fetchImpl: pdfFetch });
  assert.ok(res.sent >= 1);
  const mail = sent.find((m) => m.to === 'abc@lot.test');
  assert.ok(mail, 'ABC proforması gönderildi');
  assert.match(mail.subject, /^Proformă PRF201 — comenzile ABC\d+, ABC\d+, ABC\d+$/);
  assert.match(mail.text, /Comenzi: ABC\d+, ABC\d+, ABC\d+/);
  assert.equal(mail.attachments[0].filename, 'PRF201.pdf');
});
