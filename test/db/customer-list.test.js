// P5 — müşteri sipariş listesi (karar 243), gerçek PostgreSQL: arşiv / Active ayrımı kayıtlardan (onaylı yükleme), sıra,
// firma izolasyonu. Ağ yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { snapshotLine } = await import('../../server/loading/confirmation.js');
const { customerStatusWhere, partitionCustomerOrders } = await import('../../server/orders/customer-list.js');

let db, admin, firm, other;
let dayNo = 60;
const pastDay = () => new Date(Date.now() - (dayNo += 1) * 86_400_000).toISOString().slice(0, 10);
const at = (offset) => new Date(Date.now() + offset * 86_400_000);

async function order(c, no, { status = 'URETIMDE', ship = at(5), adet = 3 } = {}) {
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${no}`, customerOrderNo: String(no), title: `Liste ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status, estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '1', offerAmount: '1', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}
/** Onaylı yükleme: siparişin gönderilmiş teklifinin kopyası; loaded adet YÜKLENDİ, kalanı YÜKLENMEDİ */
async function confirm(o, loaded) {
  const day = pastDay();
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date(`${day}T12:00:00Z`) } });
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { include: { lines: true } } } });
  const offer = full.offers[0];
  const rows = [];
  for (const l of offer.lines) {
    if (loaded > 0) rows.push({ ...snapshotLine(full, offer, l, { quantity: loaded }), status: 'LOADED' });
    if (l.adet - loaded > 0) rows.push({ ...snapshotLine(full, offer, l, { quantity: l.adet - loaded }), status: 'NOT_LOADED', notLoadedReason: 'BROKEN' });
  }
  await db.loadingConfirmationItem.createMany({
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
}
/** Müşteri listesi: sayfadaki gibi firma kapsamı + bölüm koşulu, sonra tek ayrım kuralı */
async function list(c, bucket) {
  const found = await db.order.findMany({ where: { AND: [{ customerId: c.id, removedAt: null }, customerStatusWhere(bucket)] }, include: { profile: { select: { pickupDate: true } } } });
  return (await partitionCustomerOrders(db, found, bucket)).map((o) => o.orderNo);
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Liste Cam', prefix: 'LST' } });
  other = await db.customer.create({ data: { name: 'Başka Cam', prefix: 'BSK' } });
  admin = await db.user.create({ data: { email: 'admin@liste.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
});
after(closeDb);

dbTest('müşteri listesi: arşivde kapanmış, onaylı eksiksiz yüklenmiş ve tahmini günü 4 gün geçmiş (karar 316); yakın tarihli gecikmiş / kısmi / yalnızca "Yüklendi" Active; Active tarihe göre artan; başka firma yok', offline(async () => {
  const late = await order(firm, 1, { ship: at(-10) }); // tarihi 10 gün geçmiş, yüklenmemiş → tarih kuralıyla arşiv (karar 316)
  const soon = await order(firm, 2, { ship: at(3) });
  const later = await order(firm, 3, { ship: at(20) });
  const partial = await order(firm, 4, { ship: at(-5) }); // 5 gün geçmiş → arşiv (karar 316)
  await confirm(partial, 2); // 3'ün 2'si yüklendi, 1 kırık (açık kalan)
  const full = await order(firm, 5, { ship: at(-7) });
  await confirm(full, 3);
  const shippedOnly = await order(firm, 6, { status: 'YUKLENDI', ship: at(-2) }); // yalnızca "Yüklendi" düğmesi, onay yok
  const fullShipped = await order(firm, 7, { status: 'YUKLENDI', ship: at(-9) });
  await confirm(fullShipped, 3);
  await order(firm, 8, { status: 'ARSIVLENDI', ship: at(-90) });
  await order(firm, 9, { status: 'IPTAL', ship: at(4) });
  const foreign = await order(other, 1, { ship: at(1) });
  await confirm(foreign, 3);
  const noDate = await order(firm, 10, { ship: null });
  const recent = await order(firm, 11, { ship: at(-1) }); // 1 gün geçmiş, yüklenmemiş → Active (4 gün dolmadı)
  const held = await order(firm, 12, { ship: at(-30) });
  await db.order.update({ where: { id: held.id }, data: { onHold: true } }); // beklemede → tarih kuralı yok
  const preparing = await order(firm, 13, { status: 'HAZIRLANIYOR', ship: at(-30) }); // iş akışı bekliyor → Active

  assert.deepEqual(await list(firm, 'active'), [held, preparing, shippedOnly, recent, soon, later, noDate].map((o) => o.orderNo), 'gün artan; gecikmiş üstte; tarihsiz sonda');
  assert.deepEqual(new Set(await list(firm, 'archive')), new Set([full.orderNo, fullShipped.orderNo, 'LST8', 'LST9', late.orderNo, partial.orderNo]));
  // Firma izolasyonu: başka firmanın (eksiksiz yüklenmiş) siparişi hiçbir bölümde yok
  for (const b of ['active', 'archive']) assert.ok(!(await list(firm, b)).includes(foreign.orderNo), b);
  assert.deepEqual(await list(other, 'archive'), [foreign.orderNo]);
  // Durumlar değişmedi (liste yalnızca okur)
  const st = await db.order.findMany({ where: { id: { in: [late.id, partial.id, full.id, shippedOnly.id] } }, select: { orderNo: true, status: true }, orderBy: { orderNo: 'asc' } });
  assert.deepEqual(st.map((o) => o.status), ['URETIMDE', 'URETIMDE', 'URETIMDE', 'YUKLENDI']);
  // Tarih kuralı yalnızca liste görünümü: arşive geçen siparişin durumu, onay kaydı ve olayları değişmedi
  const lateNow = await db.order.findUnique({ where: { id: late.id }, include: { events: true } });
  assert.equal(lateNow.status, 'URETIMDE');
  assert.equal(lateNow.events.length, 0);
  assert.equal(await db.loadingConfirmationItem.count({ where: { orderId: late.id } }), 0);
}));
