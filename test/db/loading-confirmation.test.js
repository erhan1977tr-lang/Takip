// Yükleme onayı (karar 92), onaylı yüklemeden kârlılık ve eksik maliyet düzeltmesi (karar 93) — veritabanıyla.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const c = await import('../../server/loading/confirmation.js');
const { supplierData } = await import('../../server/accounting/supplier.js');
const { correctMissingCost } = await import('../../server/accounting/cost-correction.js');

let db, admin, sales, firmA, firmB;
let seq = 100;
const actor = (role = 'ADMIN') => ({ id: role === 'ADMIN' ? admin.id : sales.id, role, ip: '127.0.0.1' });
// Gün ortası (12:00 UTC) tarih: sipariş tarihleri böyle saklanır (parseDateOnly)
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const tomorrow = () => new Date(`${dayOf(1)}T00:00:00Z`);
const D1 = dayOf(-20), D2 = dayOf(-19), D3 = dayOf(-10), D4 = dayOf(-5), D5 = dayOf(-7), D7 = dayOf(-30);

const glassLine = (extra = {}) => ({ description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', kind: 'CAM', unitPrice: '60', offerPrice: '100', ...extra });
const cncLine = () => ({ description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' });

async function glassOrder(firm, day, lines, { offerStatus = 'GONDERILDI', ...extra } = {}) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id,
      status: 'URETIMDE', estimatedShipDate: at(day), ...extra,
      offers: { create: { status: offerStatus, currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
}
const dayData = async (day) => (await supplierData(db, tomorrow())).days.find((d) => d.day === day);
const confirm = async (day, who = actor()) => c.confirmLoading(db, { day, key: (await c.previewLoading(db, day)).key, actor: who });

let a1, a2, b1;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firmA = await db.customer.create({ data: { name: 'ABC SRL', prefix: 'ABC' } });
  firmB = await db.customer.create({ data: { name: 'XYZ SRL', prefix: 'XYZ' } });
  admin = await db.user.create({ data: { email: 'admin@yukleme.test', name: 'Yönetici', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  sales = await db.user.create({ data: { email: 'satis@yukleme.test', name: 'Satış', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id } });
});
after(closeDb);

dbTest('yükleme onayı: tek, değişmez kayıt; doğru müşteri / sipariş / kalem; adet, m², maliyet ve müşteri fiyatı kopyası; denetim ve geçmiş', async () => {
  a1 = await glassOrder(firmA, D1, [glassLine(), cncLine()]);
  a2 = await glassOrder(firmA, D1, [glassLine({ description: 'Lamine', descriptionRo: 'Laminat', boyMm: 1000, adet: 2, unitPrice: '80', offerPrice: '120' })]);
  b1 = await glassOrder(firmB, D1, [glassLine({ enMm: 500, boyMm: 1000, adet: 4, unitPrice: '30', offerPrice: '50' })]);
  const noOffer = await glassOrder(firmA, D1, [glassLine()], { offerStatus: 'YONETIMDE' });
  await glassOrder(firmA, D1, [glassLine()], { onHold: true });
  await glassOrder(firmA, D1, [glassLine()], { status: 'IPTAL' });
  await glassOrder(firmA, D2, [glassLine()]);

  // Önizleme hiçbir şey yazmaz: o günün uygun siparişleri (bekleyen, iptal ve başka günün siparişi yok)
  const plan = await c.previewLoading(db, D1);
  assert.deepEqual(plan.orders.map((o) => o.orderNo).sort(), [a1.orderNo, a2.orderNo, b1.orderNo].sort());
  assert.deepEqual(plan.skipped.map((s) => [s.orderNo, s.reason]), [[noOffer.orderNo, 'NO_SENT_OFFER']]);
  assert.equal(plan.items.length, 4);
  assert.equal(await db.loadingConfirmation.count(), 0);

  // Yetkisiz roller sunucuda reddedilir; yönetici de yalnızca gördüğü önizlemeyi onaylayabilir
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) {
    assert.deepEqual(await c.confirmLoading(db, { day: D1, key: plan.key, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  }
  assert.deepEqual(await c.confirmLoading(db, { day: D1, key: 'yanlis', actor: actor() }), { ok: false, code: 'STALE_PREVIEW' });
  assert.deepEqual(await c.confirmLoading(db, { day: dayOf(3), key: 'x', actor: actor() }), { ok: false, code: 'FUTURE_DAY' });
  assert.equal(await db.loadingConfirmation.count(), 0);

  const now = new Date();
  const r = await c.confirmLoading(db, { day: D1, key: plan.key, note: '  TIR 34 ABC 123  ', actor: actor(), now });
  assert.deepEqual([r.ok, r.orders, r.items], [true, 3, 4]);
  const conf = await db.loadingConfirmation.findMany({ include: { items: { orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }] } } });
  assert.equal(conf.length, 1);
  assert.equal(conf[0].shipDay.toISOString().slice(0, 10), D1);
  assert.equal(conf[0].confirmedById, admin.id);
  assert.equal(conf[0].confirmedAt.getTime(), now.getTime());
  assert.equal(conf[0].note, 'TIR 34 ABC 123');
  assert.equal(conf[0].items.length, 4);
  const item = (lineId) => conf[0].items.find((i) => i.offerLineId === lineId);
  const g = item(a1.offers[0].lines[0].id);
  assert.deepEqual(
    [g.orderId, g.customerId, g.kind, g.unit, g.description, g.descriptionRo, g.quantity, Number(g.m2), g.currency, Number(g.unitCost), Number(g.unitSale), Number(g.costAmount), Number(g.saleAmount), g.status, g.notLoadedReason],
    [a1.id, firmA.id, 'CAM', 'm2', 'Temper', 'Securizat', 5, 10, 'EUR', 60, 100, 600, 1000, 'LOADED', null],
  );
  const cn = item(a1.offers[0].lines[1].id);
  assert.deepEqual([cn.kind, cn.quantity, Number(cn.m2), Number(cn.costAmount), Number(cn.saleAmount)], ['CNC', 2, 0, 10, 20]);
  const bg = item(b1.offers[0].lines[0].id);
  assert.deepEqual([bg.customerId, bg.orderId, bg.quantity, Number(bg.m2), Number(bg.costAmount), Number(bg.saleAmount)], [firmB.id, b1.id, 4, 2, 60, 100], 'gerçek ticari sahip: müşteri ve sipariş');

  // Denetim kaydı: gün, onaylayan, zaman, siparişler / müşteriler, özet
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'LOADING_CONFIRMED', entityId: conf[0].id } });
  assert.equal(audit.userId, admin.id);
  assert.equal(audit.actorRole, 'ADMIN');
  assert.equal(audit.details.shipDay, D1);
  assert.equal(audit.details.confirmedAt, now.toISOString());
  assert.deepEqual(audit.details.orders.map((o) => o.orderNo).sort(), [a1.orderNo, a2.orderNo, b1.orderNo].sort());
  assert.deepEqual(audit.details.customers.map((x) => x.name).sort(), ['ABC SRL', 'XYZ SRL']);
  assert.deepEqual([audit.details.items, audit.details.pieces, audit.details.m2], [4, 11, 14]);
  assert.deepEqual(audit.details.totals, { EUR: { sale: 1360, cost: 830 } });
  assert.deepEqual(audit.details.skipped, [{ orderNo: noOffer.orderNo, reason: 'NO_SENT_OFFER' }]);
  // Her siparişin geçmişinde; sipariş durumu değişmez
  for (const o of [a1, a2, b1]) {
    assert.ok(await db.orderEvent.findFirst({ where: { orderId: o.id, event: 'LOADING_CONFIRMED', userId: admin.id } }), o.orderNo);
    assert.equal((await db.order.findUnique({ where: { id: o.id } })).status, 'URETIMDE');
  }
  assert.equal(await db.orderEvent.count({ where: { orderId: noOffer.id, event: 'LOADING_CONFIRMED' } }), 0);

  // Aynı gün ikinci kez onaylanamaz — uygulamada da veritabanında da
  assert.deepEqual(await confirm(D1), { ok: false, code: 'ALREADY_CONFIRMED' });
  await assert.rejects(db.loadingConfirmation.create({ data: { shipDay: new Date(`${D1}T00:00:00Z`), confirmedById: admin.id } }), { code: 'P2002' });
  assert.equal(await db.loadingConfirmation.count(), 1);
  assert.equal(await db.loadingConfirmationItem.count(), 4);
});

dbTest('yükleme onayı: aynı anda gelen iki istekten yalnızca biri kaydedilir', async () => {
  const key = (await c.previewLoading(db, D2)).key;
  const results = await Promise.all([1, 2, 3].map(() => c.confirmLoading(db, { day: D2, key, actor: actor() })));
  assert.deepEqual(results.map((r) => (r.ok ? 'ok' : r.code)).sort(), ['ALREADY_CONFIRMED', 'ALREADY_CONFIRMED', 'ok']);
  const conf = await db.loadingConfirmation.findMany({ where: { shipDay: new Date(`${D2}T00:00:00Z`) }, include: { items: true } });
  assert.equal(conf.length, 1);
  assert.equal(conf[0].items.length, 1, 'kalemler çoğalmadı');
  assert.equal(await db.auditLog.count({ where: { action: 'LOADING_CONFIRMED', entityId: conf[0].id } }), 1);
});

dbTest('onaylı yükleme sonradan değişmez: teklif, fiyat, cam adı, yeni teklif sürümü ya da yükleme tarihi değişse de kayıt ve kârlılık aynı', async () => {
  await db.loadingCost.create({ data: { shipDay: new Date(`${D1}T00:00:00Z`), amount: '150.00', currency: 'EUR', note: 'TIR' } });
  await db.loadingCost.create({ data: { shipDay: new Date(`${D1}T00:00:00Z`), amount: '80.00', currency: 'RON', note: 'vama' } });
  await db.factoryPayment.create({ data: { paidOn: new Date(`${D3}T00:00:00Z`), amount: '500.00', currency: 'EUR' } });
  const before = await dayData(D1);
  assert.equal(before.confirmed, true);
  assert.equal(before.orders, 3);
  assert.equal(before.m2, 14);
  // Satış − maliyet − transport; transport yalnızca kendi para biriminde; fabrika ödemesi kârdan düşülmez
  assert.deepEqual(before.byCur.EUR, { sale: 1360, cost: 830, transport: 150, profit: 380 });
  assert.deepEqual(before.byCur.RON, { sale: 0, cost: 0, transport: 80, profit: -80 });

  // 1) Teklif satırı sonradan değişir (adet, maliyet, müşteri fiyatı, cam adı)
  await db.offerLine.update({ where: { id: a1.offers[0].lines[0].id }, data: { adet: 9, unitPrice: '75', offerPrice: '150', description: 'DEĞİŞTİ', descriptionRo: 'SCHIMBAT' } });
  // 2) Yönetici teklifi günceller: yeni sürüm (farklı fiyatlarla)
  await db.offer.create({ data: { orderId: a2.id, status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: [glassLine({ sortOrder: 0, adet: 3, unitPrice: '99', offerPrice: '199' })] } } });
  // 3) Fiyat tablosu ve katalog değişir
  const g = await db.glassProduct.create({ data: { nameTr: 'Temper', colorTr: '', nameRo: 'Securizat', colorRo: '', weightKgM2: 25 } });
  const t = await db.priceTable.create({ data: { name: 'Fabrika', currency: 'EUR', items: { create: [{ glassProductId: g.id, unitPrice: '999' }] } } });
  await db.priceTableItem.updateMany({ where: { tableId: t.id }, data: { unitPrice: '1' } });
  await db.glassProduct.update({ where: { id: g.id }, data: { nameTr: 'Başka ad' } });
  // 4) Sipariş başka yükleme gününe alınır; onaylı güne sonradan yeni sipariş eklenir
  await db.order.update({ where: { id: b1.id }, data: { estimatedShipDate: at(D3) } });
  const late = await glassOrder(firmB, D1, [glassLine({ adet: 1 })]);

  const stored = await c.loadConfirmation(db, D1);
  const s = c.summarize(stored.orders);
  assert.deepEqual(s.totals, { orders: 3, adet: 11, m2: 14, items: 4, byCur: { EUR: { sale: 1360, cost: 830 } }, noCost: 0 });
  assert.deepEqual(s.customers.find((x) => x.name === 'ABC SRL').orders.find((o) => o.orderId === a1.id).glass, [{ name: 'Temper', adet: 5, m2: 10, cost: 610, sale: 1020 }]);
  const after = await dayData(D1);
  assert.deepEqual(after.byCur, before.byCur, 'kârlılık onay kopyasından: sonraki değişiklikler etkilemedi');
  assert.equal(after.orders, 3);
  assert.deepEqual(after.outside, [{ orderId: late.id, orderNo: late.orderNo }], 'onaydan sonra o güne eklenen sipariş sayılmaz, ayrıca gösterilir');
  // Tarihi değişen sipariş yeni gününde yeniden sayılmaz; o gün onaylanmak istenirse "zaten onaylandı" olarak dışarıda kalır
  assert.equal(await dayData(D3), undefined);
  const p3 = await c.previewLoading(db, D3);
  assert.deepEqual(p3.skipped.map((x) => [x.orderNo, x.reason, x.day]), [[b1.orderNo, 'ALREADY_CONFIRMED', D1]]);
  assert.deepEqual(await c.confirmLoading(db, { day: D3, key: p3.key, actor: actor() }), { ok: false, code: 'NOTHING_TO_CONFIRM' });
  // Onaylı yüklemeye girmiş teklif satırı silinemez (kaynak izi korunur)
  await assert.rejects(db.offerLine.delete({ where: { id: a1.offers[0].lines[1].id } }));
  // Fabrika bakiyesi maliyet − ödeme; ödeme hiçbir yüklemenin kârından düşülmedi
  const all = await supplierData(db, tomorrow());
  assert.equal(all.summary.EUR.paid, 500);
  assert.equal(all.summary.EUR.profit, Math.round(all.days.reduce((n, d) => n + (d.byCur.EUR?.profit ?? 0), 0) * 100) / 100);
});

dbTest('onaylanmamış gün: eski (planlanan) hesap sürer ve ayrı işaretlenir', async () => {
  const o = await glassOrder(firmA, D4, [glassLine({ adet: 1, unitPrice: '40', offerPrice: '70' })]);
  const d = await dayData(D4);
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.byCur.EUR, { sale: 140, cost: 80, transport: 0, profit: 60 });
  // Teklif değişince planlanan hesap da değişir (onaylanana kadar kopya yok)
  await db.offerLine.update({ where: { id: o.offers[0].lines[0].id }, data: { offerPrice: '90' } });
  assert.equal((await dayData(D4)).byCur.EUR.sale, 180);
});

dbTest('eksik maliyet düzeltmesi: yalnızca yönetici, yalnızca eksik maliyet; müşteri fiyatı değişmez; denetim kaydı; onaylı yüklemede reddedilir', async () => {
  const m = await glassOrder(firmA, D4, [
    glassLine(),
    { description: 'Özel işlem', adet: 2, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '25' }, // yöneticinin eklediği, maliyeti kayıtlı olmayan satır
    { description: 'Hediye cam', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', kind: 'CAM', unitPrice: '0', offerPrice: '0', free: true }, // satışın bedelsiz yaptığı satır
  ]);
  const offer = m.offers[0];
  await db.offer.update({ where: { id: offer.id }, data: { amount: '600.00', offerAmount: '1050.00' } });
  await db.price.create({ data: { orderId: m.id, amount: '1050.00', setById: admin.id } });
  const [glassL, extra, gift] = offer.lines;
  const missing = (await supplierData(db, tomorrow())).missing.find((x) => x.orderId === m.id);
  assert.deepEqual(missing.lines.map((l) => [l.lineId, l.description, l.adet, l.offerPrice]), [[extra.id, 'Özel işlem', 2, 25]], 'yalnızca müşterinin ödediği, maliyeti olmayan satır');
  assert.deepEqual((await dayData(D4)).noCost.map((x) => x.orderNo), [m.orderNo]);

  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) {
    assert.deepEqual(await correctMissingCost(db, { lineId: extra.id, cost: 15, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, role);
  }
  // Kayıtlı (geçerli) maliyetin üzerine yazılamaz; bedelsiz satır "eksik maliyet" değildir
  assert.deepEqual(await correctMissingCost(db, { lineId: glassL.id, cost: 1, actor: actor() }), { ok: false, code: 'COST_EXISTS' });
  assert.deepEqual(await correctMissingCost(db, { lineId: gift.id, cost: 1, actor: actor() }), { ok: false, code: 'NOT_MISSING' });
  assert.deepEqual(await correctMissingCost(db, { lineId: 'yok', cost: 1, actor: actor() }), { ok: false, code: 'NOT_FOUND' });
  assert.equal(Number((await db.offerLine.findUnique({ where: { id: glassL.id } })).unitPrice), 60);

  assert.deepEqual(await correctMissingCost(db, { lineId: extra.id, cost: 15, actor: actor() }), { ok: true, orderId: m.id });
  const line = await db.offerLine.findUnique({ where: { id: extra.id } });
  assert.deepEqual([Number(line.unitPrice), Number(line.offerPrice)], [15, 25], 'yalnızca maliyet yazıldı; müşteri fiyatı aynı');
  const o2 = await db.offer.findUnique({ where: { id: offer.id } });
  assert.deepEqual([Number(o2.amount), Number(o2.offerAmount)], [630, 1050], 'satış tutarı yeniden hesaplandı (600 + 2 × 15); müşteri tutarı aynı');
  assert.equal(Number((await db.price.findUnique({ where: { orderId: m.id } })).amount), 1050);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'OFFER_COST_CORRECTION', entityId: extra.id } });
  assert.equal(audit.userId, admin.id);
  assert.deepEqual([audit.details.oldUnitCost, audit.details.newUnitCost, audit.details.orderNo, audit.details.offerPriceUnchanged], [0, 15, m.orderNo, 25]);
  assert.ok(audit.createdAt instanceof Date);
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: m.id, event: 'COST_CORRECTED', userId: admin.id } }));
  // İkinci kez (ya da aynı anda) yazılamaz
  assert.deepEqual(await correctMissingCost(db, { lineId: extra.id, cost: 99, actor: actor() }), { ok: false, code: 'COST_EXISTS' });
  assert.equal(Number((await db.offerLine.findUnique({ where: { id: extra.id } })).unitPrice), 15);
  const d = await dayData(D4);
  assert.ok(!d.noCost.some((x) => x.orderId === m.id), 'artık maliyeti eksik değil');
  assert.equal((await supplierData(db, tomorrow())).missing.some((x) => x.orderId === m.id), false);

  // Eski teklif sürümündeki satır bu yoldan değişmez
  const v = await glassOrder(firmB, D4, [{ description: 'Eski', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '25' }]);
  await db.offer.create({ data: { orderId: v.id, status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), createdAt: new Date(Date.now() + 1000), lines: { create: [glassLine({ sortOrder: 0 })] } } });
  assert.deepEqual(await correctMissingCost(db, { lineId: v.offers[0].lines[0].id, cost: 5, actor: actor() }), { ok: false, code: 'NOT_CURRENT' });

  // Onaylı yüklemeye girmiş sipariş: düzeltme reddedilir, onay kopyası sessizce yeniden yazılmaz
  const n = await glassOrder(firmA, D5, [glassLine(), { description: 'Ek işlem', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '40' }]);
  const r = await confirm(D5);
  assert.equal(r.ok, true);
  assert.deepEqual(await correctMissingCost(db, { lineId: n.offers[0].lines[1].id, cost: 12, actor: actor() }), { ok: false, code: 'CONFIRMED' });
  assert.equal(Number((await db.offerLine.findUnique({ where: { id: n.offers[0].lines[1].id } })).unitPrice), 0);
  const snap = await db.loadingConfirmationItem.findFirstOrThrow({ where: { offerLineId: n.offers[0].lines[1].id } });
  assert.deepEqual([Number(snap.unitCost), Number(snap.costAmount), Number(snap.saleAmount)], [0, 0, 40]);
  const d5 = await dayData(D5);
  assert.deepEqual([d5.confirmed, d5.noCost.map((x) => x.orderNo)], [true, [n.orderNo]], 'onaylı yüklemede eksik maliyet görünür kalır');
  assert.equal((await supplierData(db, tomorrow())).missing.some((x) => x.orderId === n.id), false, 'düzeltilebilir listede yok');
});

dbTest('model kısmi yüklemeyi taşır: aynı satır için yüklenen ve yüklenmeyen kısım ayrı kayıt; yalnızca yüklenen sayılır', async () => {
  // Sipariş 10 cam / 6,40 m² planlı: 8 cam yüklendi, 2 cam kırıldı (tam kırık cam akışı sonraki aşama; burada yalnızca veri modeli)
  const o = await glassOrder(firmB, D7, [glassLine({ enMm: 800, boyMm: 800, adet: 10 })]);
  const line = o.offers[0].lines[0];
  const fromLine = (qty, status, reason = null) => {
    const { costAmount, saleAmount, m2, unitCost, unitSale, ...rest } = c.snapshotLine(o, o.offers[0], line, { quantity: qty, status, reason });
    return { ...rest, m2: m2.toFixed(2), unitCost: unitCost.toFixed(2), unitSale: unitSale.toFixed(2), costAmount: costAmount.toFixed(4), saleAmount: saleAmount.toFixed(4) };
  };
  const conf = await db.loadingConfirmation.create({
    data: { shipDay: new Date(`${D7}T00:00:00Z`), confirmedById: admin.id, items: { create: [fromLine(8, 'LOADED'), fromLine(2, 'NOT_LOADED', 'BROKEN')].map(({ orderId, customerId, offerLineId, ...i }) => ({ ...i, order: { connect: { id: orderId } }, customer: { connect: { id: customerId } }, offerLine: { connect: { id: offerLineId } } })) } },
    include: { items: { orderBy: { quantity: 'desc' } } },
  });
  assert.deepEqual(conf.items.map((i) => [i.status, i.quantity, Number(i.m2), i.notLoadedReason, i.offerLineId, i.orderId]), [
    ['LOADED', 8, 5.12, null, line.id, o.id], ['NOT_LOADED', 2, 1.28, 'BROKEN', line.id, o.id],
  ]);
  // Bir onayda aynı satır için durum başına tek kayıt
  await assert.rejects(db.loadingConfirmationItem.create({ data: { ...fromLine(1, 'LOADED'), confirmationId: conf.id } }), { code: 'P2002' });
  const d = await dayData(D7);
  assert.deepEqual([d.confirmed, d.m2, d.byCur.EUR.sale, d.byCur.EUR.cost], [true, 5.12, 512, 307.2], 'kârlılıkta yalnızca yüklenen 8 cam');
  const s = c.summarize((await c.loadConfirmation(db, D7)).orders);
  assert.deepEqual([s.totals.adet, s.totals.m2], [8, 5.12]);
});
