// P4 — proformada aynı teknik cam tek satır (karar 242), veritabanı + işçi + sahte FGO ile:
//   - sipariş proforması: aynı cam farklı ölçü / fiyat → tek satır (TVA dahil toplamla, PretTotal); CNC, delik, sandık parası ayrı;
//     farklı katalog camı ayrı; belge toplamı birleştirilmemiş proformayla kuruşu kuruşuna aynı;
//   - müşteri proforması (parti): aynı kural sipariş İÇİNDE; RON tutarlar partide bir kez saklanır, işçi saklananı gönderir;
//     siparişler arasında birleştirme yok;
//   - nihai fatura satırları değişmez.
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
/** FGO'nun belge toplamı (TVA dahil): PretTotal verilen satır o tutar; diğerleri adet × birim, KDV satır başına */
const formGross = (form, vat = 21) => round2(rowsOf(form).reduce((s, r) => s + (r.total != null ? Number(r.total) : grossOf(round2(Number(r.qty) * Number(r.unit)), vat)), 0));
/** Birleştirmeden önceki (her teklif satırı ayrı) proformanın TVA dahil toplamı — eski kural */
function ungroupedGross(lines, rate, vat = 21) {
  let s = 0;
  for (const l of lines) {
    if (l.free || l.offerPrice == null) continue;
    const isGlass = l.kind === 'CAM' && l.unit === 'm2';
    const qty = isGlass ? Math.round(((l.enMm * l.boyMm * l.adet) / 1e6 + Number.EPSILON) * 100) / 100 : l.adet;
    s = round2(s + grossOf(round2(qty * ronPrice(l.offerPrice, rate)), vat));
  }
  return s;
}

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
      orderNo: `${customer.prefix}${no}`, customerOrderNo: no, title: 'Proje', orderTypeCode: 'GLASS_ORDER', customerId: customer.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
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

dbTest('sipariş proforması: aynı teknik cam tek satır (farklı ölçü / fiyat), CNC / delik / sandık ayrı, başka teknik cam ayrı; toplam kuruşu kuruşuna aynı', offline(async () => {
  const o = await glassOrder(firm, 801, new Date(Date.now() + 10 * 86_400_000));
  const fgo = fakeFgo(700);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  const form = fgo.calls[0];
  const rows = rowsOf(form);
  // Securizat: 1,23 + 1,77 + 1,50 m² = 4,50 m² tek satır (ilk görüldüğü yerde); fiyatlar farklı → TVA dahil toplamla
  assert.deepEqual(rows.map((r) => [r.name, r.um, r.qty]), [
    ['Sticlă securizată 8 mm', 'mp', '4.5'],
    ['Prelucrare CNC', 'buc', '3'],
    ['Gaură', 'buc', '7'],
    ['Sticlă laminată 44.2', 'mp', '0.78'],
    ['Sticlă securizată 10 mm', 'mp', '1'], // başka teknik cam — ayrı
    ['Ambalaj (ladă)', 'buc', '1'],
    ['Gaură', 'buc', '2'], // delik satırları birbirleriyle de birleşmez
  ]);
  assert.equal(rows[0].unit, null, 'birleşmiş satır birim fiyatla değil');
  assert.notEqual(rows[0].total, null, 'birleşmiş satır TVA dahil toplamla (PretTotal)');
  assert.ok(rows.slice(1).every((r) => r.unit != null && r.total == null), 'tek parçalı satırlar eskisi gibi birim fiyatla');
  // Birleşik satırın toplamı = parçalarının (eski satırların) toplamı
  const parts = [[1.23, '47.30'], [1.77, '49.90'], [1.5, '47.30']];
  assert.equal(Number(rows[0].total), round2(parts.reduce((s, [q, p]) => s + grossOf(round2(q * ronPrice(p, RATE)), 21), 0)));
  // Belge toplamı: birleştirmeden önceki proformayla aynı (bedelsiz satır yok)
  assert.equal(formGross(form), ungroupedGross(LINES, RATE));
  // Kayıtlı tutar (TVA hariç) da aynı hesaptan
  const doc = await db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'PROFORMA' } });
  assert.ok(doc, 'proforma kaydedildi');
  // Aynı teklif yeniden hesaplanırsa aynı satırlar (belirleyici)
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  const offer = full.offers[0];
  assert.deepEqual(g.proformaLines(offer), g.proformaLines(structuredClone(offer)));
  // Nihai fatura satırları değişmedi: yalnızca cam (CNC / delik / sandık cama eklenir), aynı ad bir grup
  const inv = g.invoiceLines(offer, RATE, 21);
  assert.deepEqual(inv.map((l) => [l.name, l.qty]), [['Sticla 8 mm', 4.5], ['Sticla 44.2', 0.78], ['Sticla 10 mm', 1]]);
}));

dbTest('müşteri proforması: aynı kural sipariş içinde; RON toplamı partide saklanır, FGO saklananı alır; siparişler arasında birleştirme yok', offline(async () => {
  const day = new Date(Date.now() + 12 * 86_400_000);
  const days = [dayKey(day)];
  const simple = [SEC(1000, 1000, 2, '47.30'), SEC(1000, 500, 1, '50.00')];
  const o1 = await glassOrder(bnrFirm, 901, day, simple);
  const o2 = await glassOrder(bnrFirm, 902, day, simple);
  const p = await b.previewBatch(db, { customerId: bnrFirm.id, days, bnrImpl: bnr('5.0912') });
  assert.equal(p.ok, true);
  // Her sipariş kendi satırı (Comanda …); sipariş içinde iki fiyatlı aynı cam tek satır, gösterilen fiyat ağırlıklı ortalama
  const lines = p.included.flatMap((o) => o.lines);
  assert.deepEqual(lines.map((l) => [l.name, l.qty, l.price, l.amount, l.averaged]), [
    [`Comanda ${o1.orderNo} — Sticlă securizată 8 mm`, 2.5, round2((2 * 47.3 + 0.5 * 50) / 2.5), round2(2 * 47.3 + 0.5 * 50), true],
    [`Comanda ${o2.orderNo} — Sticlă securizată 8 mm`, 2.5, round2((2 * 47.3 + 0.5 * 50) / 2.5), round2(2 * 47.3 + 0.5 * 50), true],
  ]);
  assert.equal(p.sourceTotal, round2(2 * (2 * 47.3 + 0.5 * 50)), 'kaynak toplamı değişmez');
  const expected = round2(2 * (grossOf(round2(2 * ronPrice('47.30', RATE)), 21) + grossOf(round2(0.5 * ronPrice('50.00', RATE)), 21)));
  assert.equal(p.ronGross, expected, 'önizlemedeki RON (TVA dahil) = parça parça');
  const made = await b.createBatch(db, { customerId: bnrFirm.id, days, key: p.key, actor: actor(), bnrImpl: bnr('5.0912') });
  assert.equal(made.ok, true);
  const stored = await db.billingBatchLine.findMany({ where: { batchId: made.batchId }, orderBy: { sortOrder: 'asc' } });
  assert.ok(stored.every((l) => l.ronGross != null && l.ronUnit == null), 'birleşmiş satırın RON toplamı saklandı');
  assert.equal(round2(stored.reduce((s, l) => s + Number(l.ronGross), 0)), expected);
  const fgo = fakeFgo(800);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: made.batchId })), { done: 1, failed: 0 });
  const rows = rowsOf(fgo.calls[0]);
  assert.deepEqual(rows.map((r) => [r.qty, r.total]), stored.map((l) => [String(Number(l.quantity)), Number(l.ronGross).toFixed(2)]));
  assert.equal(formGross(fgo.calls[0]), expected, 'FGO belge toplamı = önizleme');
}));
