// Misafir yük sandık kuralları (Paket 7, karar 188) — veritabanıyla. Misafir sipariş (başka firmanın sandıklarıyla giden) kendi
// firmasının sandığına konamaz (GUEST_ORDER); firmanın o gün misafir olmayan siparişi yoksa yeni sandık açılamaz (GUEST_ONLY) —
// var olan sandık düzeltilir / silinir; misafir siparişe kendiliğinden sandık bağlanmaz; ev sahibi seçilince siparişin kendi
// firmasındaki sandık bağı kalkar (sandık durur, denetim kaydında); ilişki kalkınca normal sandık yönetimi. Kural ekrandakiyle
// aynı (server/loading/day-firms.js): aktarılan kalan, ev sahibi o gün yüklemiyorsa misafir değildir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { guestOrdersOn, saveDayCrates, setGuestHost, validateCrates } from '../../server/loading/crates.js';

let db, sales, admin;
const firms = {};
const orders = {};
const D = '2027-08-10';
const D2 = '2027-08-17';
const at = (day) => new Date(`${day}T09:00:00Z`);
const sale = () => ({ id: sales.id, role: 'SATIS', ip: '127.0.0.1' });
const boss = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });
const rows = (list) => {
  const v = validateCrates(list);
  assert.equal(v.ok, true);
  return v.rows;
};
const save = (firm, list) => saveDayCrates(db, { day: D, customerId: firms[firm].id, actor: sale(), rows: rows(list) });
const linksOf = (orderId) => db.crateOrder.count({ where: { orderId } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  for (const [k, name, prefix] of [['A', 'Alfa Cam', 'ALF'], ['B', 'Beta Cam', 'BET'], ['C', 'Ceta Cam', 'CET'], ['E', 'Epsilon Cam', 'EPS']]) {
    firms[k] = await db.customer.create({ data: { name, prefix } });
  }
  sales = await db.user.create({ data: { email: 's@guest.test', name: 'Satış', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id } });
  admin = await db.user.create({ data: { email: 'a@guest.test', name: 'Yönetici', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  const cust = await db.user.create({ data: { email: 'c@guest.test', name: 'M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firms.A.id } });
  const mk = async (key, firm, no, extra = {}) => {
    orders[key] = await db.order.create({
      data: { orderNo: `${firms[firm].prefix}${no}`, customerOrderNo: no, orderTypeCode: 'GLASS_ORDER', customerId: firms[firm].id, createdById: cust.id, status: 'URETIMDE', estimatedShipDate: at(D), ...extra },
    });
  };
  await mk('a1', 'A', 1, { guestHostId: null }); // misafir yapılacak
  await mk('a2', 'A', 2); // A'nın kendi siparişi
  await mk('b1', 'B', 1); // ev sahibi
  await mk('c1', 'C', 1); // C'nin tek siparişi: misafir yapılacak
  await mk('e1', 'E', 1); // E: kendi sandığındayken ev sahibi seçilecek
  await db.order.update({ where: { id: orders.a1.id }, data: { guestHostId: firms.B.id } });
});
after(closeDb);

dbTest('misafir sipariş kendi firmasının sandığına konamaz (GUEST_ORDER); firmanın kendi siparişi için sandık açılır; iki siparişli günde misafir siparişe kendiliğinden bağlanmaz', async () => {
  assert.deepEqual(await save('A', [{ crateNo: '21', orderIds: [orders.a1.id] }]), { ok: false, code: 'GUEST_ORDER' });
  assert.deepEqual(await save('A', [{ crateNo: '21', orderIds: [orders.a2.id, orders.a1.id] }]), { ok: false, code: 'GUEST_ORDER' });
  assert.equal(await db.crate.count({ where: { customerId: firms.A.id } }), 0, 'reddedilen kayıt hiçbir şey yazmaz');
  assert.deepEqual(await save('A', [{ crateNo: '21', orderIds: [orders.a2.id] }, { crateNo: '22' }]), { ok: true, count: 2 });
  const crates = await db.crate.findMany({ where: { customerId: firms.A.id }, include: { orders: true }, orderBy: { crateNo: 'asc' } });
  assert.deepEqual(crates.map((c) => [c.crateNo, c.orders.map((o) => o.orderId)]), [[21, [orders.a2.id]], [22, []]]);
  assert.equal(await linksOf(orders.a1.id), 0, 'misafir sipariş bu firmanın hiçbir sandığında değil');
  // Ev sahibinin o gün yüklemesi yokken de (bayat ilişki) misafir sayılır: kendi gününde ev sahibi seçiliyse
  assert.deepEqual([...(await guestOrdersOn(db, firms.A.id, D, [orders.a1, orders.a2].map((o) => ({ ...o, guestHostId: o.id === orders.a1.id ? firms.B.id : null }))))], [orders.a1.id]);
});

dbTest('siparişlerinin tamamı misafir olan firmaya yeni sandık açılamaz (GUEST_ONLY); önceden girilmiş sandık düzeltilir / silinir; tek misafir siparişe kendiliğinden bağlanmaz', async () => {
  // C'nin, ev sahibi seçilmeden önce girilmiş sandığı (siparişe bağlı)
  const old = await db.crate.create({ data: { shipDay: new Date(`${D}T00:00:00Z`), customerId: firms.C.id, crateNo: 30, orders: { create: [{ orderId: orders.c1.id }] } } });
  // Yönetici ev sahibini seçer: C'nin kendi sandığıyla bağ kalkar (sandık durur)
  assert.deepEqual(await setGuestHost(db, { orderId: orders.c1.id, hostId: firms.B.id, actor: boss() }), { ok: true, changed: true, hostId: firms.B.id });
  assert.equal(await db.crateOrder.count({ where: { crateId: old.id } }), 0);
  assert.equal(await db.crate.count({ where: { id: old.id } }), 1, 'sandığın kendisi silinmez');
  assert.deepEqual(await save('C', [{ crateNo: '30' }, { crateNo: '31' }]), { ok: false, code: 'GUEST_ONLY' });
  assert.deepEqual(await save('C', [{ crateNo: '31' }]), { ok: false, code: 'GUEST_ONLY' }, 'numara değiştirmek de yeni sandıktır');
  assert.deepEqual(await save('C', [{ crateNo: '30', netKg: '120', grossKg: '170' }]), { ok: true, count: 1 }, 'var olan sandık düzeltilir');
  const kept = await db.crate.findFirstOrThrow({ where: { customerId: firms.C.id }, include: { orders: true } });
  assert.deepEqual([kept.crateNo, Number(kept.netAgirlik), kept.orders.length], [30, 120, 0], 'tek sipariş misafir: sandık ona kendiliğinden bağlanmaz');
  assert.deepEqual(await save('C', []), { ok: true, count: 0 }, 'var olan sandık silinebilir');
  assert.equal(await db.crate.count({ where: { customerId: firms.C.id } }), 0);
  // İlişki kaldırılınca normal sandık yönetimi: yeni sandık açılır ve tek siparişe bağlanır
  assert.deepEqual(await setGuestHost(db, { orderId: orders.c1.id, hostId: null, actor: boss() }), { ok: true, changed: true, hostId: null });
  assert.deepEqual(await save('C', [{ crateNo: '31' }]), { ok: true, count: 1 });
  assert.deepEqual((await db.crate.findFirstOrThrow({ where: { customerId: firms.C.id }, include: { orders: true } })).orders.map((o) => o.orderId), [orders.c1.id]);
});

dbTest('ev sahibi seçilince siparişin kendi firmasındaki sandık bağı kalkar; denetim kaydında (ownCratesUnlinked); diğer siparişlerin bağı durur', async () => {
  const own = await db.crate.create({ data: { shipDay: new Date(`${D}T00:00:00Z`), customerId: firms.E.id, crateNo: 40, orders: { create: [{ orderId: orders.e1.id }] } } });
  assert.deepEqual(await setGuestHost(db, { orderId: orders.e1.id, hostId: firms.B.id, actor: sale() }), { ok: false, code: 'FORBIDDEN' }, 'firma seçimi yalnızca yönetici');
  assert.equal(await linksOf(orders.e1.id), 1);
  assert.equal((await setGuestHost(db, { orderId: orders.e1.id, hostId: firms.B.id, actor: boss() })).ok, true);
  assert.equal(await linksOf(orders.e1.id), 0);
  assert.equal(await db.crate.count({ where: { id: own.id } }), 1);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CROSS_CUSTOMER_HOST_SET', entityId: orders.e1.id } });
  assert.deepEqual(audit.details.ownCratesUnlinked, [{ crateNo: 40, day: D }]);
  assert.equal(await linksOf(orders.a2.id), 1, 'başka siparişin sandık bağı durur');
  // Kaldırma: kendi sandığına bağ geri gelmez (yeniden kurmak satışın sandık formudur); denetimde bağ kaldırma yok
  assert.equal((await setGuestHost(db, { orderId: orders.e1.id, hostId: null, actor: boss() })).ok, true);
  const removed = await db.auditLog.findFirstOrThrow({ where: { action: 'CROSS_CUSTOMER_HOST_REMOVED', entityId: orders.e1.id } });
  assert.equal('ownCratesUnlinked' in removed.details, false);
  assert.equal(await linksOf(orders.e1.id), 0);
});

dbTest('aktarılan kalan (kendi günü değil): ev sahibi o gün yüklemiyorsa misafir değildir; ev sahibinin o gün siparişi ya da sandığı varsa misafirdir; başka firmanın sandığındaki sipariş her zaman misafir', async () => {
  // a1'in kalanı D2'ye aktarılmış gibi (kendi günü D): D2'de ev sahibi B'nin yüklemesi yok
  const carried = [{ id: orders.a1.id, guestHostId: firms.B.id, estimatedShipDate: at(D), actualShipDate: null }];
  assert.deepEqual([...(await guestOrdersOn(db, firms.A.id, D2, carried))], [], 'kendi firmasıyla gider');
  // B'nin D2'de sandığı var → misafir
  const bCrate = await db.crate.create({ data: { shipDay: new Date(`${D2}T00:00:00Z`), customerId: firms.B.id, crateNo: 7 } });
  assert.deepEqual([...(await guestOrdersOn(db, firms.A.id, D2, carried))], [orders.a1.id]);
  // Ev sahibi seçilmemiş ama o gün başka firmanın sandığına konmuş (eski kayıt): misafir
  await db.crateOrder.create({ data: { crateId: bCrate.id, orderId: orders.a2.id } });
  const plain = [{ id: orders.a2.id, guestHostId: null, estimatedShipDate: at(D), actualShipDate: null }];
  assert.deepEqual([...(await guestOrdersOn(db, firms.A.id, D2, plain))], [orders.a2.id]);
  assert.deepEqual([...(await guestOrdersOn(db, firms.A.id, D2, []))], []);
});
