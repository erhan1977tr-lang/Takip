// Paket C (kararlar 230–237) — gerçek PostgreSQL üzerinde: tahmini yükleme tarihi kilidi ve yetkisi, otomatik sandık bağı,
// FGO açıklaması / nihai fatura adı (sahte FGO). Gerçek FGO / ANAF / BNR isteği yok (offline + sahte fetchImpl).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { saveDayCrates, validateCrates } from '../../server/loading/crates.js';
import { snapshotLine } from '../../server/loading/confirmation.js';

let db;
let firmA;
let firmB;
const U = {};
const DAY = '2027-06-11';
const ship = new Date(`${DAY}T09:00:00Z`);
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: true, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = (p) => p.then(() => 'OK', (e) => e.code ?? String(e));
const rows = (list) => {
  const v = validateCrates(list);
  assert.equal(v.ok, true);
  return v.rows;
};
let seq = 1;
async function order(firm, extra = {}) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${firm.prefix}${no}`, customerOrderNo: no, customerId: firm.id, createdById: U.cust.id, status: 'URETIMDE', estimatedShipDate: ship, orderTypeCode: 'GLASS_ORDER', drawingTrack: 'YOK',
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60', offerAmount: '100', createdById: U.admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
      ...extra,
    },
    include: { offers: { include: { lines: true } } },
  });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firmA = await db.customer.create({ data: { name: 'Alfa Paket C', prefix: 'APC' } });
  firmB = await db.customer.create({ data: { name: 'Beta Paket C', prefix: 'BPC' } });
  const user = (key, appRole, customerId, type = 'INTERNAL') => db.user.create({ data: { email: `${key}@paketc.test`, name: key, type, appRole, customerId } }).then((u) => { U[key] = u; });
  await user('admin', 'ADMIN', factory.id);
  await user('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await user('sales', 'SATIS', factory.id);
  await user('drawer', 'CIZIM', factory.id);
  await user('inspector', 'DENETIMCI', factory.id);
  await user('cust', 'MUSTERI', firmA.id, 'CUSTOMER');
});
after(closeDb);

dbTest('tahmini yükleme tarihi (karar 230): satış ve yönetici yardımcısı değiştirir (denetimde eski → yeni); müşteri / çizim / denetimci değiştiremez; aynı gün yazılmaz', async () => {
  const o = await order(firmA);
  const moved = new Date('2027-06-18T12:00:00Z');
  // Çizim ekibinin kapsamı çizimsiz siparişi hiç görmeyebilir (NOT_FOUND) — her iki durumda da değiştiremez
  for (const u of [U.cust, U.drawer, U.inspector]) assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(runOrderAction(db, { orderId: o.id, action: 'set_ship_date', actor: act(u), payload: { date: moved } }))), u.appRole);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'SHIP_DATE' } }), 0);
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'set_ship_date', actor: act(U.sales), payload: { date: moved } })), 'OK');
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'set_ship_date' } }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit.userId, U.sales.id);
  assert.equal(audit.details.fromDate, DAY);
  assert.equal(audit.details.toDate, '2027-06-18');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'SHIP_DATE' } }), 1);
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'set_ship_date', actor: act(U.assistant), payload: { date: new Date('2027-06-18T08:00:00Z') } })), 'SHIP_DATE_UNCHANGED');
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'set_ship_date', actor: act(U.assistant), payload: { date: new Date('2027-06-25T12:00:00Z') } })), 'OK');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'SHIP_DATE' } }), 2);
});

dbTest('tahmini yükleme tarihi: yükleme tamamlanınca kilitli — Yüklendi / Arşiv ve onaylı yükleme kalemi (kısmi yükleme dahil); yönetici de değiştiremez', async () => {
  const shipped = await order(firmA, { status: 'YUKLENDI', actualShipDate: ship });
  const archived = await order(firmA, { status: 'ARSIVLENDI', actualShipDate: ship });
  for (const o of [shipped, archived]) assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'set_ship_date', actor: act(U.admin), payload: { date: new Date('2027-07-01T12:00:00Z') } })), 'NOT_ALLOWED', o.status);
  // Üretimde ama onaylı yüklemesi var (kısmi: 1 yüklendi, 1 yüklenmedi) → kilitli
  const partial = await order(firmA);
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), confirmedById: U.admin.id } });
  const line = partial.offers[0].lines[0];
  for (const [status, quantity] of [['LOADED', 1], ['NOT_LOADED', 1]]) {
    const i = snapshotLine(partial, partial.offers[0], line, { quantity, status, reason: status === 'NOT_LOADED' ? 'BROKEN' : null });
    await db.loadingConfirmationItem.create({
      data: { ...i, confirmationId: conf.id, scopeKey: `l:${line.id}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) },
    });
  }
  const before = (await db.order.findUniqueOrThrow({ where: { id: partial.id } })).estimatedShipDate.toISOString();
  for (const u of [U.admin, U.assistant, U.sales]) assert.equal(await codeOf(runOrderAction(db, { orderId: partial.id, action: 'set_ship_date', actor: act(u), payload: { date: new Date('2027-07-02T12:00:00Z') } })), 'SHIP_DATE_LOCKED', u.appRole);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: partial.id } })).estimatedShipDate.toISOString(), before, 'tarih değişmedi');
});

dbTest('otomatik sandık bağı (karar 234): yeni sandık firmanın o günkü bütün kendi siparişlerine; başka firma / başka gün yok; kayıtlı sandık bağlarını korur; formdaki seçim yok sayılır; çift bağ yok', async () => {
  const DAY2 = '2027-06-14';
  const day2 = new Date(`${DAY2}T09:00:00Z`);
  const a1 = await order(firmA, { estimatedShipDate: day2 });
  const a2 = await order(firmA, { estimatedShipDate: day2 });
  const aOther = await order(firmA, { estimatedShipDate: new Date('2027-06-21T09:00:00Z') });
  const b1 = await order(firmB, { estimatedShipDate: day2 });
  const save = (list) => saveDayCrates(db, { day: DAY2, customerId: firmA.id, actor: act(U.sales), rows: rows(list), links: 'auto' });
  // Formdan başka firmanın / başka günün siparişi gönderilse de yok sayılır
  assert.deepEqual(await save([{ crateNo: '41', netKg: '100', orderIds: [b1.id, aOther.id] }]), { ok: true, count: 1 });
  const linked = async () => (await db.crate.findMany({ where: { customerId: firmA.id, shipDay: new Date(`${DAY2}T00:00:00Z`) }, include: { orders: true }, orderBy: { crateNo: 'asc' } }))
    .map((c) => [c.crateNo, c.orders.map((x) => x.orderId).sort()]);
  assert.deepEqual(await linked(), [[41, [a1.id, a2.id].sort()]]);
  // Kayıtlı sandığın bağı elle daraltılmış olsun (eski kayıt): yeniden kayıtta korunur, yeniden bağlanmaz; yeni sandık hepsine bağlanır
  const c41 = await db.crate.findFirstOrThrow({ where: { customerId: firmA.id, crateNo: 41 } });
  await db.crateOrder.delete({ where: { crateId_orderId: { crateId: c41.id, orderId: a2.id } } });
  assert.deepEqual(await save([{ origNo: '41', crateNo: '41', netKg: '120' }, { crateNo: '42' }]), { ok: true, count: 2 });
  assert.deepEqual(await linked(), [[41, [a1.id]], [42, [a1.id, a2.id].sort()]]);
  // Numarası değişen kayıtlı sandık bağlarını korur; çift bağ yok
  assert.deepEqual(await save([{ origNo: '41', crateNo: '43' }, { origNo: '42', crateNo: '42' }]), { ok: true, count: 2 });
  assert.deepEqual(await linked(), [[42, [a1.id, a2.id].sort()], [43, [a1.id]]]);
  assert.equal(await db.crateOrder.count({ where: { orderId: { in: [b1.id, aOther.id] } } }), 0, 'başka firma / başka gün bağlanmadı');
  const pairs = await db.crateOrder.findMany({ where: { orderId: { in: [a1.id, a2.id] } } });
  assert.equal(new Set(pairs.map((p) => `${p.crateId}|${p.orderId}`)).size, pairs.length);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CRATES_SAVE', entityId: firmA.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit.details.links, 'auto');
});

dbTest('FGO (karar 235–236): bedelsiz telafi camı faturaya / proformaya girmez (çift faturalama yok); nihai fatura adı "Sticla …"; açıklama kur cümlesi', offline(async () => {
  const { invoiceLines, proformaLines, glassDocText } = await import('../../server/glass/billing.js');
  const o = await order(firmA, {
    offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60', offerAmount: '100', createdById: U.admin.id, sentAt: new Date(),
      lines: { create: [
        { sortOrder: 0, description: 'Temper Lamine', descriptionRo: 'STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
        { sortOrder: 1, description: 'Temper Lamine', descriptionRo: 'STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '30', offerPrice: '0', free: true, kind: 'CAM' },
      ] } } },
  });
  const offer = o.offers[0];
  const inv = invoiceLines(offer, 5, 21);
  assert.deepEqual(inv.map((l) => [l.name, l.qty, l.net]), [['Sticla 4.2.4., PVB OPAQUE (GRI+GRI)', 2, 500]], 'bedelsiz cam faturada yok; ad "Sticla …"');
  assert.deepEqual(proformaLines(offer).map((l) => [l.name, l.qty]), [['STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)', 2]], 'proforma adı değişmez; bedelsiz satır yok');
  assert.equal(glassDocText('EUR', { fxRate: '5', fxPolicy: 'BT_UNIT_SELL', fxSource: 'MANUAL_DAY' }), 'Curs de vânzare BT: 5.0000 RON/EUR.');
}));
