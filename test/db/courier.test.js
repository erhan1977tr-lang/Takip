// 4.2.24 (karar 324) — veritabanıyla: profil siparişinde "Kurye ile gönderim". Kurye seçilince plaka istenmez, sipariş
// plakasız depoya iletilebilir; kurye seçilmeyen sipariş eskisi gibi plaka ister. Ağ yok (FGO / e-posta çağrılmaz).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { addStockMovement } = await import('../../server/profile/stock.js');
const { earliestPickup } = await import('../../server/profile/dates.js');

let db;
const people = {};
let firm;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const pickDay = () => earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });

async function offered() {
  const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 2 }], products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  const { id } = await createProfileOrder(db, { actor: actor(people.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  const o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  return { id, offerId: (await load(id)).offers[0].id };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Kurye Firma', prefix: 'KUR' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@kurye.test`, name: `${key} kişi`, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  const gk = await db.profileProduct.findUnique({ where: { code: 'GK15' } });
  await addStockMovement(db, { productId: gk.id, kind: 'GIRIS', qty: 100 }, actor(people.admin));
});
after(async () => { await closeDb(); });

dbTest('kurye: onayda plaka istenmez, sipariş plakasız depoya gider; depo e-postası kuyruğa girer', offline(async () => {
  const { id, offerId } = await offered();
  await run(id, 'approve_profile_offer', 'cust', { offerId, pickupDate: pickDay(), phone: '0723000000', plate: '', courier: '1' });
  let o = await load(id);
  assert.deepEqual([o.profile.stage, o.profile.courier, o.profile.vehiclePlate], ['ONAYLANDI', true, null]);
  await run(id, 'mark_proforma', 'admin', { proformaNo: 'PF-K1' });
  await run(id, 'send_to_warehouse', 'admin');
  o = await load(id);
  assert.equal(o.profile.stage, 'DEPODA');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'WAREHOUSE_EMAIL' } }), 1);
}));

dbTest('kurye seçilince yazılan plaka silinir; kurye seçilmeyen onay eskisi gibi plaka ister', offline(async () => {
  const a = await offered();
  assert.equal(await codeOf(run(a.id, 'approve_profile_offer', 'cust', { offerId: a.offerId, pickupDate: pickDay(), phone: '0723000000', plate: '' })), 'BAD_PLATE');
  assert.equal(await codeOf(run(a.id, 'approve_profile_offer', 'cust', { offerId: a.offerId, pickupDate: pickDay(), phone: '0723000000', plate: '', courier: false })), 'BAD_PLATE');
  await run(a.id, 'approve_profile_offer', 'cust', { offerId: a.offerId, pickupDate: pickDay(), phone: '0723000000', plate: 'B 9 XYZ', courier: true });
  const o = await load(a.id);
  assert.deepEqual([o.profile.courier, o.profile.vehiclePlate], [true, null]);
}));

dbTest('teslim bilgisini değiştir: kuryeden araca geçişte plaka gerekir (depoda); kutusuz istek kurye seçimini değiştirmez', offline(async () => {
  const { id, offerId } = await offered();
  await run(id, 'approve_profile_offer', 'cust', { offerId, pickupDate: pickDay(), phone: '0723000000', plate: 'B 1 ABC' });
  let o = await load(id);
  assert.deepEqual([o.profile.courier, o.profile.vehiclePlate], [false, 'B 1 ABC']);
  // Müşteri kuryeye geçer: plaka silinir
  await run(id, 'update_pickup', 'cust', { phone: '0723000000', plate: 'B 1 ABC', courier: '1', expectedVersion: o.version });
  o = await load(id);
  assert.deepEqual([o.profile.courier, o.profile.vehiclePlate], [true, null]);
  // Formda kurye kutusu hiç yoksa (undefined) seçim değişmez
  await run(id, 'update_pickup', 'admin', { phone: '0723111111' });
  o = await load(id);
  assert.deepEqual([o.profile.courier, o.profile.contactPhone], [true, '0723111111']);
  await run(id, 'mark_proforma', 'admin', { proformaNo: 'PF-K2' });
  await run(id, 'send_to_warehouse', 'admin');
  // Depodaki siparişte yönetici araca geçerse plaka zorunlu
  assert.equal(await codeOf(run(id, 'update_pickup', 'admin', { phone: '0723111111', plate: '', courier: false })), 'BAD_PLATE');
  await run(id, 'update_pickup', 'admin', { phone: '0723111111', plate: 'b 2 def', courier: false });
  o = await load(id);
  assert.deepEqual([o.profile.courier, o.profile.vehiclePlate], [false, 'B 2 DEF']);
}));
