// Karar 323 — cam proforması faturanın düzeninde, birim fiyat 2 hane; veritabanı + işçi + sahte FGO ile:
//   - sipariş proforması: aynı cam tek satır, CNC / delik / sandık camın tutarında; FGO'ya PretUnitar (2 hane), PretTotal yok;
//     satırlar ve tutar nihai faturanın kuralıyla (invoiceLines) aynı;
//   - müşteri proforması (parti): aynı kural sipariş İÇİNDE; RON birim fiyat / tutar partide bir kez saklanır, işçi saklananı
//     gönderir; siparişler arasında birleştirme yok.
// FGO'ya / BNR'ye GERÇEK istek yapılmaz (sahte fetchImpl / bnrImpl; offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings, ronPrice, grossOf } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const { dayKey } = await import('../../server/orders/loading.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');

const SECRET = 'p'.repeat(40);
const RATE = 5.0912;
let db, admin, firm, bnrFirm;
const actor = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const bnr = (rate) => async () => ({ ok: true, rate, date: dayKey(new Date()), url: 'https://curs.bnr.ro/nbrfxrates.xml' });

function fakeFgo(start) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '0', ValoareAchitata: '0' } }));
    calls.push(form);
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://www.fgo.ro/print/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: 'Europe/Bucharest', fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });

/** FGO formunun satırları */
function rowsOf(form) {
  const out = [];
  for (let i = 0; `Continut[${i}][Denumire]` in form; i++) {
    out.push({
      name: form[`Continut[${i}][Denumire]`], qty: form[`Continut[${i}][NrProduse]`], um: form[`Continut[${i}][UM]`],
      unit: form[`Continut[${i}][PretUnitar]`] ?? null, total: form[`Continut[${i}][PretTotal]`] ?? null,
    });
  }
  return out;
}
/** FGO'nun belge toplamı (TVA dahil): adet × birim, KDV satır başına (PretTotal verilen satır o tutar) */
const formGross = (form, vat = 21) => round2(rowsOf(form).reduce((s, r) => s + (r.total != null ? Number(r.total) : grossOf(round2(Number(r.qty) * Number(r.unit)), vat)), 0));
const SEC = (en, boy, adet, price, extra = {}) => ({ description: 'Temper 8', descriptionRo: 'Sticlă securizată 8 mm', glassProductId: 'gp-sec8', enMm: en, boyMm: boy, adet, unit: 'm2', unitPrice: '30', offerPrice: price, kind: 'CAM', ...extra });
const LINES = [
  SEC(1234, 1000, 1, '47.30'),
  { description: 'CNC', adet: 3, unit: 'adet', unitPrice: '5', offerPrice: '12.70', kind: 'CNC' },
  { description: 'Delik', adet: 7, unit: 'adet', unitPrice: '1', offerPrice: '1.33', kind: 'DELIK' },
  SEC(887, 1000, 2, '49.90'), // aynı cam, başka ölçü ve fiyat
  { description: 'Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', glassProductId: 'gp-lam', enMm: 777, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '40', offerPrice: '83.17', kind: 'CAM' },
  SEC(1500, 333, 3, '47.30'), // aynı cam, ilk satırla aynı fiyat
  // Başka teknik cam (kalınlık farklı): birleşmez — fiyatı ilk satırla aynı olsa da
  SEC(1000, 1000, 1, '47.30', { description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', glassProductId: 'gp-sec10' }),
  { description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, unit: 'adet', unitPrice: '0', offerPrice: '25.00', kind: 'CAM', crateFee: true },
  { description: 'Delik', adet: 2, unit: 'adet', unitPrice: '1', offerPrice: '1.33', kind: 'DELIK' },
  SEC(1000, 1000, 1, '47.30', { free: true, offerPrice: '0' }), // bedelsiz: proformaya girmez
];

async function glassOrder(customer, no, shipDate, lines = LINES) {
  return db.order.create({
    data: {
      orderNo: `${customer.prefix}${no}`, customerOrderNo: String(no), title: 'Proje', orderTypeCode: 'GLASS_ORDER', customerId: customer.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '1', offerAmount: '1', createdById: admin.id, sentAt: new Date(),
        lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } },
    },
  });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Grup Cam', prefix: 'GRP', email: 'grp@belge.test', taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1' } });
  bnrFirm = await db.customer.create({ data: { name: 'Parti Cam', prefix: 'PAR', email: 'par@belge.test', taxId: '998878', county: 'Ilfov', city: 'Voluntari', address: 'Str. 2', fxPolicy: 'BNR' } });
  admin = await db.user.create({ data: { email: 'admin@grup.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, {
    enabled: true, fxMode: 'manual', dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: 'https://bt.example',
  }, { key: 'K', secret: SECRET }, actor());
  await saveDailyRate(db, { day: localDay(new Date(), 'Europe/Bucharest'), rate: RATE }, actor(), writeAudit);
});
after(closeDb);

dbTest('sipariş proforması: faturanın düzeni — aynı cam tek satır, işlemler ve sandık camın tutarında, başka cam ayrı; birim fiyat 2 hane (PretUnitar); faturayla aynı tutar', offline(async () => {
  const o = await glassOrder(firm, 801, new Date(Date.now() + 10 * 86_400_000));
  const fgo = fakeFgo(700);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  const form = fgo.calls[0];
  const rows = rowsOf(form);
  // Securizat 8: 1,23 + 1,77 + 1,50 = 4,50 m² (CNC ve 7 delik onun tutarında); laminat; securizat 10 (sandık ve son 2 delik onun tutarında)
  assert.deepEqual(rows.map((r) => [r.name, r.um, r.qty]), [
    ['Sticlă securizată 8 mm', 'mp', '4.5'],
    ['Sticlă laminată 44.2', 'mp', '0.78'],
    ['Sticlă securizată 10 mm', 'mp', '1'],
  ]);
  assert.ok(rows.every((r) => r.total == null && /^\d+\.\d{2}$/.test(r.unit)), 'her satır 2 haneli birim fiyatla, PretTotal yok');
  // Aynı teklifin nihai fatura satırları: aynı m², aynı birim fiyat → aynı tutar (ad faturada kısalır)
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  const inv = g.invoiceLines(full.offers[0], RATE, 21);
  assert.deepEqual(inv.map((l) => [String(l.qty), l.ron.toFixed(2)]), rows.map((r) => [r.qty, r.unit]));
  assert.equal(formGross(form), round2(inv.reduce((s, l) => s + l.gross, 0)), 'proforma toplamı = fatura toplamı');
  // Birim fiyat: grubun kesin tutarı / m² — securizat 8: üç cam parçası + 3 CNC + 7 delik
  const exact = round2([[1.23, '47.30'], [1.77, '49.90'], [3, '12.70'], [7, '1.33'], [1.5, '47.30']].reduce((s, [q, p]) => s + round2(q * ronPrice(p, RATE)), 0));
  assert.equal(rows[0].unit, round2(exact / 4.5).toFixed(2));
  assert.ok(await db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'PROFORMA' } }), 'proforma kaydedildi');
}));

dbTest('müşteri proforması: aynı kural sipariş içinde; RON birim fiyat partide saklanır, FGO saklananı alır; siparişler arasında birleştirme yok', offline(async () => {
  const day = new Date(Date.now() + 12 * 86_400_000);
  const days = [dayKey(day)];
  const simple = [SEC(1000, 1000, 2, '47.30'), { description: 'CNC', adet: 3, unit: 'adet', unitPrice: '5', offerPrice: '12.70', kind: 'CNC' }, SEC(1000, 500, 1, '50.00')];
  const o1 = await glassOrder(bnrFirm, 901, day, simple);
  const o2 = await glassOrder(bnrFirm, 902, day, simple);
  const p = await b.previewBatch(db, { customerId: bnrFirm.id, days, bnrImpl: bnr('5.0912') });
  assert.equal(p.ok, true);
  const amount = round2(2 * 47.3 + 3 * 12.7 + 0.5 * 50);
  const lines = p.included.flatMap((o) => o.lines);
  assert.deepEqual(lines.map((l) => [l.name, l.qty, l.amount, l.averaged]), [
    [`Comanda ${o1.orderNo} — Sticlă securizată 8 mm`, 2.5, amount, true],
    [`Comanda ${o2.orderNo} — Sticlă securizată 8 mm`, 2.5, amount, true],
  ]);
  const exact = round2(round2(2 * ronPrice('47.30', RATE)) + round2(3 * ronPrice('12.70', RATE)) + round2(0.5 * ronPrice('50.00', RATE)));
  const unit = round2(exact / 2.5);
  const expected = round2(2 * grossOf(round2(2.5 * unit), 21));
  assert.equal(p.ronGross, expected, 'önizlemedeki RON (TVA dahil) = m² × 2 haneli birim fiyat');
  const made = await b.createBatch(db, { customerId: bnrFirm.id, days, key: p.key, actor: actor(), bnrImpl: bnr('5.0912') });
  assert.equal(made.ok, true);
  const stored = await db.billingBatchLine.findMany({ where: { batchId: made.batchId }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(stored.map((l) => [Number(l.ronUnit), Number(l.ronGross)]), [[unit, expected / 2], [unit, expected / 2]]);
  const fgo = fakeFgo(800);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: made.batchId })), { done: 1, failed: 0 });
  const rows = rowsOf(fgo.calls[0]);
  assert.deepEqual(rows.map((r) => [r.qty, r.unit, r.total]), [['2.5', unit.toFixed(2), null], ['2.5', unit.toFixed(2), null]]);
  assert.equal(formGross(fgo.calls[0]), expected, 'FGO belge toplamı = önizleme');
}));
