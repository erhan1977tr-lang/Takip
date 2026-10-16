// Yönetici raporları 3.89.0 (karar 284) — gerçek PostgreSQL ile: yetki (yönetici / yardımcı açık; satış, çizim, denetimci,
// müşteri kapalı), birleşik tarih + müşteri filtreleri, cam m² (TAKİP kuralı, 3 ondalık), bedelsiz telafi ayrımı, kısmi
// yükleme (yalnızca onaylı miktar gerçekleşmiş), kaldırılmış / iptal sipariş dışarıda, stok giriş (mal kabulü / elle) / çıkış /
// iade / sayım bir kez, kısmi mal kabulü, EUR / RON ayrı, finansal çift sayım yok (proforma + avans + fatura), Excel = panel,
// Telegram aracı = panel, büyük rapor (sorgu sayısı sipariş sayısından bağımsız — N+1 yok). Yükleme verisi GERÇEK servislerle
// kurulur (confirmLoading, replanNotLoaded). Raporlar READ ONLY işlemde de çalışır ve hiçbir tabloyu değiştirmez. Ağ yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { runReport, REPORT_LIMITS } = await import('../../server/reports/service.js');
const { reportSheets, reportForAi } = await import('../../server/reports/present.js');
const { readOnly } = await import('../../server/assistant/readonly.js');
const { runTool } = await import('../../server/assistant/tools.js');
const { receivables } = await import('../../server/accounting/receivables.js');
const { supplierData } = await import('../../server/accounting/supplier.js');
const { writeReportXlsx } = await import('../../server/files/xlsx-report.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');

const TZ = 'Europe/Bucharest';
const NOW = new Date('2026-10-15T09:00:00Z');
const DAY = '2026-10-10';
const FUTURE = '2026-10-20';
const at = (day) => new Date(`${day}T12:00:00Z`);
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
let db, admin, deputy, sales, drawer, inspector, customerUser, ale, gla, o40, ro, fbl, mc;

const MODELS = ['order', 'offer', 'offerLine', 'loadingConfirmation', 'loadingConfirmationItem', 'loadingReplan', 'stockMovement', 'fgoDocument', 'manualPayment', 'auditLog', 'notificationOutbox', 'supplierReceipt'];
const snapshot = async () => JSON.stringify(await Promise.all(MODELS.map((m) => db[m].count())));
const report = (input, actor = act(admin)) => runReport(db, input, { actor, now: NOW, timeZone: TZ });
const card = (rep, key, unit) => rep.cards.find((x) => x.key === key && (unit == null || x.unit === unit))?.value;
const tbl = (rep, key) => {
  const tb = rep.tables.find((x) => x.key === key);
  return tb.rows.map((r) => Object.fromEntries(tb.columns.map((col, i) => [col.key, r[i]])));
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  ro = readOnly(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  ale = await db.customer.create({ data: { name: 'ALEGRAD SRL', prefix: 'ALE' } });
  gla = await db.customer.create({ data: { name: 'Glass and More SRL', prefix: 'GLA' } });
  const mk = (email, appRole, customerId = factory.id, type = 'INTERNAL') => db.user.create({ data: { email, name: appRole, type, appRole, customerId } });
  admin = await mk('admin@rapor.test', 'ADMIN');
  deputy = await mk('yard@rapor.test', 'YONETICI_YARDIMCISI');
  sales = await mk('satis@rapor.test', 'SATIS');
  drawer = await mk('cizim@rapor.test', 'CIZIM');
  inspector = await mk('denetim@rapor.test', 'DENETIMCI');
  customerUser = await mk('musteri@rapor.test', 'MUSTERI', ale.id, 'CUSTOMER');

  // ALE40 (Ekim): 10 cam (parça m² 1,234321 → 12,343 m²) + 2 CNC + bedelsiz telafi 2 cam (0,60 m²) + yöneticinin sandık bedeli
  o40 = await db.order.create({
    data: {
      orderNo: 'ALE40', customerOrderNo: '40', orderTypeCode: 'GLASS_ORDER', customerId: ale.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: at(DAY), createdAt: new Date('2026-10-02T09:00:00Z'),
      items: { create: [{ glassName: 'Temper 8 mm — Şeffaf', camAdedi: 0 }] },
      offers: {
        create: {
          status: 'GONDERILDI', currency: 'EUR', amount: '400', offerAmount: '900', createdById: admin.id, sentAt: new Date('2026-10-03T09:00:00Z'),
          lines: {
            create: [
              { sortOrder: 0, description: 'Temper 8 mm', enMm: 1111, boyMm: 1111, adet: 10, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '60', pieceM2: '1.234321' },
              { sortOrder: 1, description: 'CNC kesim', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '9' },
              { sortOrder: 2, description: 'Temper 8 mm', enMm: 500, boyMm: 600, adet: 2, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '0', free: true },
              { sortOrder: 3, description: 'Sandık parası', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '40', crateFee: true },
            ],
          },
        },
      },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
  // GLA68 (Ekim): teklif tablosu yok — miktar bilinmiyor (sıfır sayılmaz)
  await db.order.create({ data: { orderNo: 'GLA68', customerOrderNo: '68', customerId: gla.id, createdById: admin.id, status: 'HAZIRLANIYOR', estimatedShipDate: at('2026-10-25'), createdAt: new Date('2026-10-05T09:00:00Z'), offers: { create: { status: 'HAZIRLANIYOR', currency: 'EUR', createdById: admin.id } } } });
  // GLA70 (Eylül): RON, 3 × 2 m² = 6 m², maliyeti eksik (satış fiyatı 0) — 12.10'a planlı, onaysız
  await db.order.create({
    data: {
      orderNo: 'GLA70', customerOrderNo: '70', customerId: gla.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: at('2026-10-12'), createdAt: new Date('2026-09-15T09:00:00Z'),
      offers: { create: { status: 'GONDERILDI', currency: 'RON', amount: '0', offerAmount: '600', createdById: admin.id, sentAt: new Date('2026-09-16T09:00:00Z'), lines: { create: [{ sortOrder: 0, description: 'Lamine 44.2', enMm: 1000, boyMm: 2000, adet: 3, unit: 'm2', kind: 'CAM', unitPrice: '0', offerPrice: '100' }] } } },
    },
  });
  // Kaldırılmış ve iptal edilmiş siparişler: hiçbir rapora girmez
  for (const [no, extra] of [['ALE55', { removedAt: NOW, removedStatus: 'YENI', numberActive: null }], ['ALE56', {}]]) {
    await db.order.create({
      data: {
        orderNo: no, customerOrderNo: no.slice(3), customerId: ale.id, createdById: admin.id, status: 'IPTAL', estimatedShipDate: at(DAY), createdAt: new Date('2026-10-04T09:00:00Z'), ...extra,
        offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '1', offerAmount: '999', createdById: admin.id, sentAt: NOW, lines: { create: [{ sortOrder: 0, description: 'Temper 8 mm', enMm: 1000, boyMm: 1000, adet: 50, unit: 'm2', kind: 'CAM', unitPrice: '1', offerPrice: '20' }] } } },
      },
    });
  }

  // 10.10 yükleme onayı (gerçek servis): ALE40'ın 4 camı yüklenmedi; 3'ü 20.10'a aktarıldı, 1'i planlanmadı
  const line = o40.offers[0].lines[0];
  const preview = await c.previewLoading(db, DAY);
  const r = await c.confirmLoading(db, { day: DAY, key: preview.key, notLoaded: [{ key: `l:${line.id}`, quantity: 4, reason: 'BROKEN' }], actor: act(admin), now: NOW });
  assert.equal(r.ok, true, r.code);
  const rest = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: o40.id, status: 'NOT_LOADED' } });
  const rr = await rp.replanNotLoaded(db, { itemId: rest.id, day: FUTURE, quantity: 3, actor: act(admin), now: NOW });
  assert.equal(rr.ok, true, rr.code);
  await db.loadingCost.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), amount: '50', currency: 'EUR' } });

  // Profil: ürünler, tedarikçi siparişi + KISMİ mal kabulü (30 → 20), stok hareketleri, iki profil siparişi
  const cat = await db.profileCategory.create({ data: { code: 'RPTCAT', nameRo: 'Profile', nameTr: 'Profil' } });
  fbl = await db.profileProduct.create({ data: { code: 'RPT-FBL90-7016', categoryId: cat.id, nameRo: 'Profil FBL90', nameTr: 'FBL90 profil', unitCode: 'BARA', packContent: '6', packMeasure: 'M', criticalStock: 10 } });
  mc = await db.profileProduct.create({ data: { code: 'RPT-MC12', categoryId: cat.id, nameRo: 'Garnitură MC12', nameTr: 'MC12 conta', unitCode: 'CUTII', packContent: '27', packMeasure: 'M', criticalStock: 5 } });
  const sup = await db.supplier.create({ data: { name: 'Profil Tedarik', currency: 'EUR' } });
  const so = await db.supplierOrder.create({ data: { orderNo: 'TS-2026-001', supplierId: sup.id, currency: 'EUR', status: 'GONDERILDI', sentAt: new Date('2026-10-03T10:00:00Z') } });
  // Kesinleşmiş revizyona satır eklenemez (veritabanı tetikleyicisi): önce taslak satır, sonra kesinleştir
  const rev = await db.supplierOrderRevision.create({ data: { orderId: so.id, revision: 1, orderDate: new Date('2026-10-03T00:00:00Z'), total: '300' } });
  const sol = await db.supplierOrderLine.create({ data: { revisionId: rev.id, productId: fbl.id, code: fbl.code, description: 'FBL90', color: 'RAL7016', qty: 30, unitCode: 'BARA', unitPrice: '10', lineTotal: '300' } });
  await db.supplierOrderRevision.update({ where: { id: rev.id }, data: { finalizedAt: new Date('2026-10-03T10:00:00Z') } });
  const rec = await db.supplierReceipt.create({ data: { orderId: so.id, revisionId: rev.id, seq: 1, receivedOn: new Date('2026-10-07T00:00:00Z'), requestKey: 'rapor-test-kabul-1' } });
  await db.supplierReceiptLine.create({ data: { receiptId: rec.id, orderLineId: sol.id, productId: fbl.id, code: fbl.code, nameRo: 'Profil FBL90', description: 'FBL90', color: 'RAL7016', lengthM: '6', qty: 20, unitCode: 'BARA' } });
  const mv = (productId, qty, kind, extra = {}) => db.stockMovement.create({ data: { productId, qty, kind, createdAt: new Date('2026-10-07T10:00:00Z'), ...extra } });
  await mv(fbl.id, 20, 'GIRIS', { supplierReceiptId: rec.id });
  await mv(mc.id, 5, 'GIRIS');
  const profileOrder = async (no, created, stage, items, extra = {}) => {
    const o = await db.order.create({ data: { orderNo: no, customerOrderNo: no.slice(4), orderTypeCode: 'PROFILE_ORDER', customerId: ale.id, createdById: admin.id, status: 'HAZIRLANIYOR', createdAt: new Date(created) } });
    const offer = await db.offer.create({ data: { orderId: o.id, status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '200', createdById: admin.id, sentAt: new Date(created) } });
    await db.profileOrder.create({ data: { orderId: o.id, stage, approvedAt: new Date(created), approvedOfferId: offer.id, ...extra } });
    await db.profileOrderItem.createMany({ data: items.map(([p, qty], i) => ({ orderId: o.id, productId: p.id, code: p.code, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode, categoryCode: 'RPTCAT', qty, sortOrder: i })) });
    return o;
  };
  const p1 = await profileOrder('ALEP1', '2026-10-06T09:00:00Z', 'DEPODA', [[fbl, 6], [mc, 2]], { stockDeducted: true, pickupDate: new Date('2026-10-14T00:00:00Z') });
  await profileOrder('ALEP2', '2026-10-09T09:00:00Z', 'ONAYLANDI', [[fbl, 15]], { pickupDate: new Date('2026-10-28T00:00:00Z') });
  await mv(fbl.id, -6, 'CIKIS', { orderId: p1.id });
  await mv(mc.id, -2, 'CIKIS', { orderId: p1.id });
  await mv(mc.id, 2, 'IADE', { note: 'iptal' });
  await mv(mc.id, -1, 'SAYIM');

  // FGO belgeleri (ALE40, RON): proforma 1000 (500 ödendi) + avans 500 + nihai fatura 600 (avansı eksi satırla düşer)
  const doc = (kind, series, number, total, paid, seq = 1) => db.fgoDocument.create({ data: { orderId: o40.id, kind, series, number, issuedAt: new Date('2026-10-08T10:00:00Z'), currency: 'RON', total, paid, seq } });
  await doc('PROFORMA', 'PRF', '1', '1000', '500');
  await doc('ADVANCE', 'GKH', '1', '500', '500');
  await doc('INVOICE', 'GKH', '2', '600', '0');
  // Elle tahsilat: 500 RON (geçerli) + 300 RON (iptal edilmiş — sayılmaz)
  const pay = (amount, key, extra = {}) => db.manualPayment.create({ data: { orderId: o40.id, customerId: ale.id, proformaRef: 'PRF 1', paidOn: new Date('2026-10-08T00:00:00Z'), amount, currency: 'RON', method: 'BANK_TRANSFER', ron: amount, requestKey: key, createdById: admin.id, ...extra } });
  await pay('500', 'rapor-pay-1');
  const voided = await pay('300', 'rapor-pay-2');
  await db.manualPayment.update({ where: { id: voided.id }, data: { voidedAt: NOW, voidedById: admin.id, voidReason: 'hata' } });
});
after(async () => { await closeDb(); });

dbTest('raporlar: yetki — yönetici ve yönetici yardımcısı açık; satış, çizim, denetimci, müşteri sunucuda reddedilir', offline(async () => {
  for (const u of [admin, deputy]) assert.equal((await report({ kind: 'orders' }, act(u))).ok, true, u.appRole);
  for (const u of [sales, drawer, inspector, customerUser]) assert.deepEqual(await report({ kind: 'finance' }, act(u)), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  assert.deepEqual(await report({ kind: 'orders' }, null), { ok: false, code: 'FORBIDDEN' });
}));

dbTest('raporlar: sipariş raporu — oluşturma günü (Romanya), kaldırılmış / iptal dışarıda, teklif tablosu olmayan sıfır sayılmaz, m² 3 ondalık', offline(async () => {
  const r = await report({ kind: 'orders' }); // bu ay: 01.10–15.10
  assert.equal(r.ok, true);
  const rep = r.report;
  assert.deepEqual(rep.range, { from: '2026-10-01', to: '2026-10-15' });
  assert.equal(rep.basis, 'ORDER_CREATED');
  assert.equal(card(rep, 'orders'), 4); // ALE40, GLA68, ALEP1, ALEP2 (ALE55 kaldırılmış, ALE56 iptal, GLA70 Eylül)
  assert.equal(card(rep, 'glassOrders'), 2);
  assert.equal(card(rep, 'profileOrders'), 2);
  assert.equal(card(rep, 'orderedM2'), 12.943);
  assert.equal(card(rep, 'loadedM2'), 8.006); // 6 ticari (7,406) + 2 bedelsiz (0,6) — yalnızca onaylı
  assert.equal(card(rep, 'remainingM2'), 4.937); // 3 aktarılmış (3,703) + 1 planlanmamış (1,234)
  assert.equal(card(rep, 'completed'), 0);
  const rows = tbl(rep, 'orders');
  assert.deepEqual(rows.map((x) => x.orderNo).sort(), ['ALE40', 'ALEP1', 'ALEP2', 'GLA68']);
  const g68 = rows.find((x) => x.orderNo === 'GLA68');
  assert.equal(g68.orderedM2, null, 'teklif tablosu yok: null, sıfır değil');
  assert.ok(rep.notes.includes('NO_OFFER_TABLE'));
  assert.equal(rows.find((x) => x.orderNo === 'ALE40').loading, 'PARTIAL');
  // Birleşik filtre: tarih + müşteri + tür
  const f = (await report({ kind: 'orders', from: '2026-10-01', to: '2026-10-31', customerId: gla.id, orderType: 'GLASS' })).report;
  assert.deepEqual(tbl(f, 'orders').map((x) => x.orderNo), ['GLA68']);
  assert.equal(card((await report({ kind: 'orders', month: '2026-09', customerId: gla.id })).report, 'orders'), 1);
  // Metinle müşteri (Telegram yolu): kod, ad parçası; belirsiz / bulunamadı ayrı kod
  assert.equal((await report({ kind: 'orders', customer: 'ALE' })).report.filters.customer.name, 'ALEGRAD SRL');
  assert.equal((await report({ kind: 'orders', customer: 'SRL' })).code, 'CUSTOMER_AMBIGUOUS');
  assert.equal((await report({ kind: 'orders', customer: 'Yok Böyle' })).code, 'CUSTOMER_NOT_FOUND');
}));

dbTest('raporlar: cam raporu — ticari / bedelsiz telafi ayrı, kısmi yükleme yalnızca onaylı miktar, ürün filtresi', offline(async () => {
  const rep = (await report({ kind: 'glass', month: '2026-10' })).report;
  assert.equal(card(rep, 'commercialM2'), 12.343);
  assert.equal(card(rep, 'commercialPcs'), 10);
  assert.equal(card(rep, 'freeM2'), 0.6);
  assert.equal(card(rep, 'freePcs'), 2);
  assert.equal(card(rep, 'loadedM2'), 8.006);
  assert.equal(card(rep, 'plannedM2'), 3.703);
  assert.equal(card(rep, 'openM2'), 1.234);
  assert.equal(card(rep, 'partialOrders'), 1);
  const row = tbl(rep, 'byCustomerGlass').find((x) => x.customer === 'ALEGRAD SRL');
  assert.deepEqual([row.commercialM2, row.freeM2, row.loadedM2, row.loadedFreeM2, row.plannedM2, row.openM2], [12.343, 0.6, 7.406, 0.6, 3.703, 1.234]);
  assert.deepEqual(tbl(rep, 'partial').map((x) => [x.orderNo, x.loadedDays]), [['ALE40', DAY]]);
  // Kısmi filtresi / ürün filtresi
  assert.equal(card((await report({ kind: 'glass', month: '2026-10', loading: 'LOADED' })).report, 'commercialM2'), 0);
  assert.equal(card((await report({ kind: 'glass', from: '2026-09-01', to: '2026-10-31', product: 'lamine' })).report, 'commercialM2'), 6);
}));

dbTest('raporlar: yükleme raporu — onaylı gün gerçekleşen, onaysız gün ve aktarım planlanan; profil teslimi ayrı', offline(async () => {
  const rep = (await report({ kind: 'loading', month: '2026-10' })).report;
  assert.equal(rep.basis, 'LOADING_DAY');
  assert.equal(card(rep, 'confirmedDays'), 1);
  assert.equal(card(rep, 'loadedM2'), 7.406);
  assert.equal(card(rep, 'loadedFreeM2'), 0.6);
  assert.equal(card(rep, 'loadedPcs'), 8);
  assert.equal(card(rep, 'notLoadedM2'), 4.937);
  assert.equal(card(rep, 'plannedM2'), 9.703); // GLA70 6 m² (12.10) + aktarılan 3 cam 3,703 m² (20.10)
  const orders = tbl(rep, 'loadingOrders');
  assert.deepEqual(orders.map((x) => [x.day, x.dayState, x.orderNo]), [
    [DAY, 'ACTUAL', 'ALE40'], ['2026-10-12', 'PLANNED', 'GLA70'], [FUTURE, 'PLANNED', 'ALE40'], ['2026-10-25', 'PLANNED', 'GLA68'],
  ]);
  assert.equal(orders[2].note, `REPLAN:${DAY}`);
  assert.equal(orders[3].note, 'NO_OFFER');
  assert.ok(!orders.some((x) => ['ALE55', 'ALE56'].includes(x.orderNo)), 'iptal / kaldırılmış yok');
  assert.deepEqual(tbl(rep, 'profileDeliveries').map((x) => [x.day, x.dayState, x.orderNo, x.qtyByUnit]), [['2026-10-14', 'PLANNED', 'ALEP1', '6 BARA, 2 CUTII'], ['2026-10-28', 'PLANNED', 'ALEP2', '15 BARA']]);
  // Geçen ay (Eylül): bu siparişlerin hiçbiri yok (sıfır)
  assert.equal(card((await report({ kind: 'loading', month: '2026-09' })).report, 'loadedM2'), 0);
}));

dbTest('raporlar: profil ve stok — birimler ayrı, giriş (mal kabulü / elle) / çıkış / iade / sayım bir kez, kısmi mal kabulü, kritik / rezerve', offline(async () => {
  const rep = (await report({ kind: 'profile', month: '2026-10', product: 'RPT-' })).report;
  assert.deepEqual(tbl(rep, 'byProduct').map((x) => [x.code, x.unit, x.qty, x.orders, x.packContent]), [['RPT-FBL90-7016', 'BARA', 21, 2, '6 m'], ['RPT-MC12', 'CUTII', 2, 1, '27 m']]);
  const totals = rep.tables.find((x) => x.key === 'byProduct').totals;
  assert.deepEqual(totals.map((r) => [r[2], r[4]]).sort(), [['BARA', 21], ['CUTII', 2]], 'birim başına toplam, birimler toplanmaz');
  assert.deepEqual(tbl(rep, 'movements').map((x) => [x.code, x.inReceipt, x.inManual, x.out, x.returns, x.count, x.net]), [
    ['RPT-FBL90-7016', 20, 0, -6, 0, 0, 14], ['RPT-MC12', 0, 5, -2, 2, -1, 4],
  ]);
  const stock = Object.fromEntries(tbl(rep, 'stock').map((x) => [x.code, [x.stock, x.reserved, x.available, x.stockState]]));
  assert.deepEqual(stock['RPT-FBL90-7016'], [14, 15, -1, 'SHORT']);
  assert.deepEqual(stock['RPT-MC12'], [4, 0, 4, 'CRITICAL']);
  assert.deepEqual(tbl(rep, 'supplierOrders').map((x) => [x.supplierOrderNo, x.color, x.ordered, x.received, x.remaining]), [['TS-2026-001', 'RAL7016', 30, 20, 10]]);
  assert.deepEqual(tbl(rep, 'receipts').map((x) => [x.receivedOn, x.code, x.color, x.lengthM, x.qty]), [['2026-10-07', 'RPT-FBL90-7016', 'RAL7016', 6, 20]]);
  // Hareketlerin toplamı stokla aynı (mükerrer sayım yok)
  const levels = await db.stockMovement.groupBy({ by: ['productId'], where: { productId: { in: [fbl.id, mc.id] } }, _sum: { qty: true } });
  assert.deepEqual(levels.map((l) => l._sum.qty).sort(), [4, 14]);
}));

dbTest('raporlar: finans — EUR / RON ayrı, Muhasebe motoruyla aynı satış / maliyet, eksik maliyette kâr yok, faturada çift sayım yok', offline(async () => {
  const rep = (await report({ kind: 'finance', month: '2026-10' })).report;
  const sum = Object.fromEntries(tbl(rep, 'financeSummary').map((x) => [x.currency, x]));
  // Muhasebe → Tedarikçi Hesap Durumu'nun motoru (supplierData) aynı günler için aynı satış / maliyeti verir
  const acc = await supplierData(db, new Date('2026-10-31T00:00:00Z'));
  const days = acc.days.filter((d) => d.day >= '2026-10-01' && d.day <= '2026-10-31');
  const engine = (cur, key) => Math.round(days.reduce((s, d) => s + (d.byCur[cur]?.[key] ?? 0), 0) * 100) / 100;
  assert.equal(sum.EUR.glassSale, engine('EUR', 'sale'));
  assert.equal(sum.EUR.glassCost, engine('EUR', 'cost'));
  assert.equal(sum.RON.glassSale, engine('RON', 'sale'));
  assert.equal(sum.RON.glassSale, 600);
  assert.equal(sum.EUR.transport, 50);
  assert.equal(sum.EUR.profit, Math.round((sum.EUR.glassSale - sum.EUR.glassCost - 50) * 100) / 100);
  assert.equal(sum.RON.profit, null, 'maliyeti eksik sipariş: kâr verilmez');
  assert.equal(sum.RON.missingCostOrders, 1);
  assert.equal(card(rep, 'profit', 'RON'), null);
  // Profil satışı (müşteri onayı aralıkta): ALEP1 + ALEP2
  assert.equal(sum.EUR.profileSale, 400);
  // Fatura: proforma bilgi; faturalanan = avans + nihai (1100) — 2100 değil
  assert.equal(sum.RON.proforma, 1000);
  assert.equal(sum.RON.invoiced, 1100);
  // Tahsilat: iptal edilen elle kayıt sayılmaz
  assert.equal(sum.RON.collected, 500);
  // Açık alacak: çift sayımsız kural (receivables)
  const docs = await db.fgoDocument.findMany({ select: { id: true, orderId: true, batchId: true, kind: true, currency: true, total: true, paid: true, batch: true } });
  const open = receivables(docs).sums.RON;
  assert.equal(sum.RON.openRest, open.rest);
  assert.equal(sum.RON.openTotal, open.total);
  // EUR ve RON hiçbir satırda toplanmaz
  for (const x of tbl(rep, 'financeByCustomer')) assert.ok(['EUR', 'RON'].includes(x.currency));
  // Müşteri filtresinde nakliye dağıtılmaz (değer yok)
  const ale2 = (await report({ kind: 'finance', month: '2026-10', customerId: ale.id })).report;
  assert.equal(tbl(ale2, 'financeSummary').find((x) => x.currency === 'EUR').transport, null);
  assert.ok(ale2.notes.includes('TRANSPORT_HIDDEN'));
}));

dbTest('raporlar: Excel ve Telegram panelle aynı sayıları verir; READ ONLY işlemde çalışır, hiçbir tablo değişmez', offline(async () => {
  const before = await snapshot();
  for (const kind of ['orders', 'glass', 'profile', 'loading', 'finance']) {
    const panel = (await report({ kind, month: '2026-10' })).report;
    // Excel: her tablonun sayfası aynı satır sayısı ve aynı sayılar
    const sheets = reportSheets(panel, t, { generatedText: 'x' });
    for (const tb of panel.tables) {
      const sh = sheets.find((s) => s.title.endsWith(`reports.tables.${tb.key}`));
      assert.ok(sh, tb.key);
      assert.equal(sh.blocks[0].rows.length, tb.rows.length, `${kind}/${tb.key}`);
      tb.columns.forEach((col, i) => {
        if (['int', 'm2', 'money', 'dec3'].includes(col.type)) assert.deepEqual(sh.blocks[0].rows.map((r) => r[i]), tb.rows.map((r) => r[i]), `${kind}/${tb.key}/${col.key}`);
      });
    }
    const buf = writeReportXlsx({ sheets });
    assert.ok(buf.length > 1000);
    // Telegram: aynı servis, READ ONLY işlem (readOnly) — özet değerleri panelin kartları
    const TUR = { orders: 'siparis', glass: 'cam', profile: 'profil_stok', loading: 'yukleme', finance: 'finans' };
    const bot = await runTool(ro, 'rapor', JSON.stringify({ tur: TUR[kind], ay: '2026-10' }), { tz: TZ, now: NOW });
    assert.equal(bot.hata, undefined, kind);
    assert.deepEqual(bot.aralik, panel.range);
    assert.deepEqual(bot.ozet, reportForAi(panel).ozet, kind);
  }
  // Telegram: "bu ay" (Romanya saatiyle) ve hata / belirsizlik kodları
  const thisMonth = await runTool(ro, 'rapor', JSON.stringify({ tur: 'cam', donem: 'bu_ay' }), { tz: TZ, now: new Date('2026-10-31T22:30:00Z') }); // Bükreş'te 1 Kasım 00:30
  assert.deepEqual(thisMonth.aralik, { from: '2026-11-01', to: '2026-11-01' });
  assert.equal(thisMonth.ozet.find((o) => 'commercialM2' in o).commercialM2, 0);
  assert.deepEqual(await runTool(ro, 'rapor', JSON.stringify({ tur: 'finans', firma: 'SRL' }), { tz: TZ, now: NOW }), { hata: 'CUSTOMER_AMBIGUOUS', adaylar: ['ALEGRAD SRL', 'Glass and More SRL'] });
  assert.deepEqual(await runTool(ro, 'rapor', JSON.stringify({ tur: 'finans', sql: 'DROP TABLE' }), { tz: TZ, now: NOW }), { hata: 'INVALID_ARGS' });
  assert.equal(await snapshot(), before, 'raporlar hiçbir tabloyu değiştirmez');
}));

dbTest('raporlar: büyük rapor — sorgu sayısı sipariş sayısından bağımsız (N+1 yok), süre sınırlı; sınırı aşan rapor eksik toplam vermez', offline(async () => {
  const N = 300;
  const base = await db.order.findFirstOrThrow({ where: { orderNo: 'ALE40' }, select: { createdById: true } });
  for (let i = 0; i < N; i++) {
    await db.order.create({
      data: {
        orderNo: `GLB${i}`, customerOrderNo: `9${i}`, customerId: gla.id, createdById: base.createdById, status: 'URETIMDE', estimatedShipDate: at('2026-10-13'), createdAt: new Date('2026-10-11T09:00:00Z'),
        offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '10', offerAmount: '20', createdById: base.createdById, sentAt: NOW, lines: { create: [{ sortOrder: 0, description: 'Temper 6 mm', enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', kind: 'CAM', unitPrice: '10', offerPrice: '20' }] } } },
      },
    });
  }
  // Model çağrılarını sayan sarmalayıcı
  let calls = 0;
  const counting = new Proxy(db, { get: (target, model) => {
    const m = target[model];
    if (m && typeof m === 'object' && typeof m.findMany === 'function') return new Proxy(m, { get: (mt, fn) => (typeof mt[fn] === 'function' ? (...a) => { calls++; return mt[fn](...a); } : mt[fn]) });
    return m;
  } });
  for (const kind of ['orders', 'glass', 'loading', 'finance', 'profile']) {
    calls = 0;
    const started = Date.now();
    const r = await runReport(counting, { kind, month: '2026-10' }, { actor: act(admin), now: NOW, timeZone: TZ });
    assert.equal(r.ok, true, kind);
    assert.ok(calls <= 15, `${kind}: ${calls} sorgu`);
    assert.ok(Date.now() - started < 15_000, `${kind}: süre`);
  }
  const g = (await report({ kind: 'glass', month: '2026-10' })).report;
  assert.equal(card(g, 'commercialM2'), Math.round((12.343 + N * 1) * 1000) / 1000);
  assert.ok(REPORT_LIMITS.orders >= 1000);
}));
