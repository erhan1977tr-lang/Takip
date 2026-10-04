// Fiyat tabloları ve Önemli kararlar — veritabanıyla (Aşama 3b, karar 26).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { assignCustomerTable, assignTable, changeTable, pricingForUser, savePrices, saveTable } from '../../server/pricing/tables.js';
import { openAlertCount, resolveAlert } from '../../server/pricing/alerts.js';
import { can } from '../../server/auth/permissions.js';

let db;
const people = {};
let firm;
let glass;
let other;
let tables = {};

const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const newOrder = async () => {
  const next = await suggestNextNo(db, firm.id);
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title: 'Fiyat', requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '10 MM TEMPER CAM — BRONZ', glassNameRo: 'STICLĂ 10 MM — BRONZ', glassWeightKgM2: 25, camAdedi: 2 }],
    files: [{ storageKey: `2026/09/f${next}.pdf`, name: 'f.pdf', size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
const lineOf = (l) => ({
  description: l.description, poz: l.poz, enMm: l.enMm ?? 1000, boyMm: l.boyMm ?? 1000, adet: l.adet, unit: l.unit,
  unitPrice: Number(l.unitPrice).toFixed(2), kind: l.kind, free: l.free,
});
const offerOf = (orderId) => db.offer.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Fiyat Test', prefix: 'FIY' } });
  const mk = (key, appRole, customerId) =>
    db.user.create({ data: { email: `${key}@fiyat.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('sales2', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('cust', 'MUSTERI', firm.id);
  glass = await db.glassProduct.create({ data: { nameTr: '10 MM TEMPER CAM', colorTr: 'BRONZ', nameRo: 'STICLĂ 10 MM', colorRo: 'BRONZ', weightKgM2: 25 } });
  other = await db.glassProduct.create({ data: { nameTr: '4 MM FLOAT', colorTr: '', nameRo: 'FLOAT 4 MM', colorRo: '', weightKgM2: 10 } });
});
after(closeDb);

const admin = () => actor(people.admin);

dbTest('fiyat tablosu: ilk tablo varsayılan olur; aynı ad reddedilir; varsayılan pasif yapılamaz', async () => {
  const a = await saveTable(db, null, { name: 'GKH 2026', currency: 'EUR', holePrice: 3, cncPrice: 12 }, admin());
  const b = await saveTable(db, null, { name: 'Özel', currency: 'EUR', holePrice: null, cncPrice: null }, admin());
  assert.ok(a.ok && b.ok);
  tables = { std: a.id, special: b.id };
  assert.deepEqual((await db.priceTable.findMany({ orderBy: { name: 'asc' } })).map((t) => [t.name, t.isDefault]), [['GKH 2026', true], ['Özel', false]]);
  assert.deepEqual(await saveTable(db, null, { name: 'gkh 2026', currency: 'EUR', holePrice: null, cncPrice: null }, admin()), { ok: false, code: 'EXISTS' });
  assert.deepEqual(await changeTable(db, tables.std, 'toggle', admin()), { ok: false, code: 'IS_DEFAULT' });
  assert.deepEqual(await changeTable(db, tables.std, 'delete', admin()), { ok: false, code: 'IS_DEFAULT' });

  const r = await savePrices(db, tables.std, { [glass.id]: 30, [other.id]: null }, admin());
  assert.deepEqual(r, { ok: true, changed: 1 });
  await savePrices(db, tables.special, { [glass.id]: 26 }, admin());
  const audit = await db.auditLog.findFirst({ where: { action: 'PRICE_UPDATE', entityId: tables.std } });
  assert.deepEqual(audit.details.prices, [{ glass: '10 MM TEMPER CAM — BRONZ', before: null, after: 30 }]);
  assert.equal(audit.actorRole, 'ADMIN');
});

dbTest('fiyat tablosu: satışçı kendi tablosunu, ataması yoksa varsayılanı kullanır', async () => {
  const canPrepare = (role) => can(role, 'OFFER_PREPARE');
  assert.deepEqual(await assignTable(db, people.sales2.id, tables.special, admin(), canPrepare), { ok: true });
  assert.deepEqual(await assignTable(db, people.drawer.id, tables.special, admin(), canPrepare), { ok: false, code: 'NOT_FOUND' }, 'çizimci teklif hazırlamaz');
  assert.equal((await pricingForUser(db, people.sales.id)).id, tables.std);
  assert.equal((await pricingForUser(db, people.sales2.id)).id, tables.special);
  assert.equal(await db.auditLog.count({ where: { action: 'PRICE_TABLE_ASSIGN', entityId: people.sales2.id } }), 1);
});

dbTest('teklif: satışçının taslağına liste fiyatı gelir; farklı fiyatla gönderirse Önemli kararlar listesine düşer', async () => {
  const o = await newOrder();
  await run(o.id, 'no_drawing', 'sales');
  let offer = await offerOf(o.id);
  assert.equal(offer.priceTableId, tables.std);
  assert.deepEqual(offer.lines.map((l) => [l.glassProductId, Number(l.listPrice), Number(l.unitPrice), l.adet, l.descriptionRo, Number(l.weightKgM2)]),
    [[glass.id, 30, 30, 2, 'STICLĂ 10 MM — BRONZ', 25]]);

  // Satışçı liste fiyatıyla gönderirse uyarı yok
  const same = [lineOf(offer.lines[0])];
  await run(o.id, 'submit_offer', 'sales', { lines: same, amount: '60.00' });
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id } }), 0);

  // Yönetici geri gönderir; satışçı fiyatı düşürür, delik ekler (tablonun sabit fiyatından farklı) ve yeniden gönderir
  await run(o.id, 'return_offer', 'admin', { lines: same, amount: '60.00', returnNote: 'kontrol' });
  offer = await offerOf(o.id);
  // (delik TEK bir cama aittir — karar 113: işlemli cam satırı tek adettir)
  const changed = [
    { ...lineOf(offer.lines[0]), unitPrice: '27.50', adet: 1 },
    { description: '', poz: null, enMm: null, boyMm: null, adet: 4, unit: 'adet', unitPrice: '2.00', kind: 'DELIK', free: false },
  ];
  await run(o.id, 'submit_offer', 'sales', { lines: changed, amount: '63.00' });
  const alert = await db.adminAlert.findFirstOrThrow({ where: { orderId: o.id, resolvedAt: null } });
  assert.equal(alert.type, 'PRICE_OVERRIDE');
  assert.equal(alert.createdById, people.sales.id);
  assert.deepEqual(alert.details.lines.map((l) => [l.kind, l.listPrice, l.unitPrice]), [['CAM', 30, 27.5], ['DELIK', 3, 2]]);
  assert.equal(await db.auditLog.count({ where: { action: 'PRICE_OVERRIDE', entityId: offer.id } }), 1);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'submit_offer' } }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit.details.priceOverrides, 2);

  // Tarayıcıdan gelen liste fiyatına güvenilmez: satır liste fiyatını sunucu yazar
  offer = await offerOf(o.id);
  assert.deepEqual(offer.lines.map((l) => Number(l.listPrice)), [30, 3]);

  // Yeniden gönderimde eski uyarı kapanır, yenisi açılır (liste son durumu gösterir)
  await run(o.id, 'return_offer', 'admin', { lines: changed, amount: '63.00', returnNote: 'tekrar' });
  await run(o.id, 'submit_offer', 'sales', { lines: changed, amount: '63.00' });
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id } }), 2);
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id, resolvedAt: null } }), 1);
  assert.equal(await openAlertCount(db), 1);

  const open = await db.adminAlert.findFirstOrThrow({ where: { orderId: o.id, resolvedAt: null } });
  assert.equal(await resolveAlert(db, open.id, admin()), true);
  assert.equal(await resolveAlert(db, open.id, admin()), false, 'ikinci kez kapatılmaz');
  const closed = await db.adminAlert.findUniqueOrThrow({ where: { id: open.id } });
  assert.equal(closed.resolvedById, people.admin.id);
  assert.equal(await openAlertCount(db), 0);
  assert.equal(await db.auditLog.count({ where: { action: 'ALERT_RESOLVE', entityId: open.id } }), 1);
});

dbTest('fiyat tablosu: teklifte kullanılan tablo silinemez, para birimi değişmez; tablo değişince açık teklif değişmez', async () => {
  assert.deepEqual(await changeTable(db, tables.std, 'delete', admin()), { ok: false, code: 'IS_DEFAULT' });
  assert.deepEqual(await changeTable(db, tables.special, 'default', admin()), { ok: true });
  assert.deepEqual(await changeTable(db, tables.std, 'delete', admin()), { ok: false, code: 'IN_USE' });
  assert.deepEqual(await saveTable(db, tables.std, { name: 'GKH 2026', currency: 'RON', holePrice: 3, cncPrice: 12 }, admin()), { ok: false, code: 'CURRENCY_LOCKED' });

  const o = await newOrder();
  await run(o.id, 'no_drawing', 'sales2');
  const before = await offerOf(o.id);
  assert.equal(Number(before.lines[0].listPrice), 26);
  await savePrices(db, tables.special, { [glass.id]: 40 }, admin());
  await run(o.id, 'save_offer', 'sales2', { lines: before.lines.map(lineOf), amount: '52.00' });
  const afterSave = await offerOf(o.id);
  assert.deepEqual([Number(afterSave.lines[0].listPrice), Number(afterSave.lines[0].unitPrice)], [26, 26]);
});

dbTest('iki kademeli fiyat: müşteri fiyatı müşterinin tablosundan gelir; satırlar ortak, fiyatlar ayrı (karar 4, 32)', async () => {
  const ct = await saveTable(db, null, { name: 'Müşteri Özel', currency: 'EUR', holePrice: 5, cncPrice: null }, admin(), 'CUSTOMER');
  assert.ok(ct.ok);
  const t = await db.priceTable.findUniqueOrThrow({ where: { id: ct.id } });
  assert.deepEqual([t.kind, t.isDefault], ['CUSTOMER', false], 'müşteri tablosu varsayılan olmaz');
  assert.deepEqual(await changeTable(db, ct.id, 'default', admin()), { ok: false, code: 'NOT_FOUND' });
  await savePrices(db, ct.id, { [glass.id]: 50 }, admin());
  assert.deepEqual(await assignCustomerTable(db, firm.id, ct.id, admin()), { ok: true });
  assert.deepEqual(await assignCustomerTable(db, firm.id, tables.std, admin()), { ok: false, code: 'NOT_FOUND' }, 'satış tablosu müşteriye bağlanamaz');

  const o = await newOrder();
  await run(o.id, 'no_drawing', 'sales');
  let offer = await offerOf(o.id);
  const salesLines = [
    // İşlemli cam tek adettir (karar 113): 1000 × 2000, 1 adet = 2 m²
    { ...lineOf(offer.lines[0]), id: offer.lines[0].id, unitPrice: '30.00', adet: 1, boyMm: 2000 },
    { id: null, description: '', poz: null, enMm: null, boyMm: null, adet: 4, unit: 'adet', unitPrice: '3.00', kind: 'DELIK', free: false },
  ];
  await run(o.id, 'submit_offer', 'sales', { lines: salesLines });
  offer = await offerOf(o.id);
  // cam 2 m² × 1 adet: satış 30 → 60 + delik 4 × 3 = 72 · müşteri 50 → 100 + delik 4 × 5 = 120
  assert.deepEqual(offer.lines.map((l) => [l.kind, Number(l.unitPrice), Number(l.offerPrice)]), [['CAM', 30, 50], ['DELIK', 3, 5]]);
  assert.deepEqual([Number(offer.amount), Number(offer.offerAmount)], [72, 120]);

  // Yönetici ölçüyü değiştirir, müşteri fiyatını düzeltir, satır ekler → mevcut satırların satış fiyatı değişmez, satır
  // satışta da değişir. Eklenen satır eklendiği andaki fabrika fiyatını alır (teklifin tablosu: CNC 12; karar 89) —
  // tarayıcıdan gelen satış fiyatı (0) kullanılmaz, maliyet sessizce 0 kalmaz.
  assert.ok((await saveTable(db, tables.special, { name: 'Özel', currency: 'EUR', holePrice: null, cncPrice: 12 }, admin())).ok);
  const adminLines = [
    { ...lineOf(offer.lines[0]), id: offer.lines[0].id, boyMm: 4000, offerPrice: '55.00', unitPrice: '1.00' },
    { ...lineOf(offer.lines[1]), id: offer.lines[1].id, offerPrice: '5.00' },
    { id: null, description: '', poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', unitPrice: '0', kind: 'CNC', free: false, offerPrice: '20.00' },
  ];
  await run(o.id, 'save_offer', 'admin', { lines: adminLines });
  offer = await offerOf(o.id);
  assert.deepEqual(offer.lines.map((l) => [l.kind, Number(l.unitPrice), Number(l.offerPrice)]),
    [['CAM', 30, 55], ['DELIK', 3, 5], ['CNC', 12, 20]]);
  assert.equal(offer.lines[0].boyMm, 4000);
  // cam 4 m² × 1 adet = 4 m²: satış tutarı 120 + 12 + 12 (yöneticinin eklediği CNC'nin fabrika fiyatı)
  assert.equal(Number(offer.amount), 144);
  // Yönetici satışa geri gönderir; satış yeniden kaydeder → müşteri fiyatları korunur
  await run(o.id, 'return_offer', 'admin', { lines: adminLines, returnNote: 'bak' });
  offer = await offerOf(o.id);
  await run(o.id, 'save_offer', 'sales', { lines: offer.lines.map((l) => ({ ...lineOf(l), id: l.id, unitPrice: l.kind === 'CNC' ? '15.00' : String(l.unitPrice) })) });
  offer = await offerOf(o.id);
  assert.deepEqual(offer.lines.map((l) => [Number(l.unitPrice), Number(l.offerPrice)]), [[30, 55], [3, 5], [15, 20]]);
  await run(o.id, 'submit_offer', 'sales', { lines: offer.lines.map((l) => ({ ...lineOf(l), id: l.id })) });
  offer = await offerOf(o.id);
  await run(o.id, 'approve_offer', 'admin', { lines: offer.lines.map((l) => ({ ...lineOf(l), id: l.id, offerPrice: String(l.offerPrice) })) });
  const sent = await db.offer.findFirstOrThrow({ where: { orderId: o.id, status: 'GONDERILDI' }, include: { lines: true } });
  const price = await db.price.findUniqueOrThrow({ where: { orderId: o.id } });
  // cam 2 m² × 2 adet = 4 m²: satış 120 + 12 + 15 = 147 · müşteri 220 + 20 + 20 = 260
  assert.deepEqual([Number(sent.amount), Number(sent.offerAmount), Number(price.amount)], [147, 260, 260]);
  // Olay geçmişi (satış da görür) müşteri tutarını içermez
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, event: 'OFFER_SENT' } });
  assert.equal(ev.note, null);
  // Gönderilmiş teklif değişmez: güncelleme yeni sürüm açar, satış fiyatları taşınır
  await run(o.id, 'update_offer', 'admin', { lines: sent.lines.sort((x, y) => x.sortOrder - y.sortOrder).map((l) => ({ ...lineOf(l), id: l.id, offerPrice: l.kind === 'CAM' ? '60.00' : String(l.offerPrice) })), note: 'indirim yok' });
  const versions = await db.offer.findMany({ where: { orderId: o.id, status: 'GONDERILDI' }, orderBy: { createdAt: 'asc' }, include: { lines: true } });
  assert.equal(versions.length, 2);
  assert.equal(Number(versions[0].offerAmount), 260, 'eski sürüm değişmedi');
  assert.deepEqual([Number(versions[1].amount), Number(versions[1].offerAmount)], [147, 280]);
});
