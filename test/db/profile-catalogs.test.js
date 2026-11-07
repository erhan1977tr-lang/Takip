// Çoklu profil fiyat kataloğu (4.2.16, karar 312): katalog listesi, seçimle fiyat, yetki, parmak izi, sipariş / proforma tutarlılığı,
// sonradan değişen fiyat, taslak, yönetici bağlantı kuralı. Gerçek PostgreSQL; ağ yok, FGO yok, e-posta yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { suggestNextNo } from '../../server/orders/create.js';
import { createProfileOrder } from '../../server/profile/create.js';
import { profileOrderItems } from '../../server/profile/rules.js';
import { assignProfileTable, priceFingerprint, profileCatalogsFor, profilePricesFor } from '../../server/profile/pricing.js';
import { readProfileDraftItems, saveProfileDraft } from '../../server/profile/drafts.js';
import { documentLines } from '../../server/profile/fgo-jobs.js';
import { earliestPickup } from '../../server/profile/dates.js';

let db;
const people = {};
let atico, other, tAtico, tMtm, tOther;
let gk, sp;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const pickDay = () => earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });

async function itemsOf(lines) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  return items.items;
}
async function order(lines, { f = atico, who = 'atico', priceTableId = null, priceFingerprint: fp = null } = {}) {
  const next = await suggestNextNo(db, f.id, 'PROFILE_ORDER');
  return createProfileOrder(db, {
    actor: actor(people[who]), firm: f, title: null, requestedNo: next, suggestedNo: next, items: await itemsOf(lines),
    pickup: { pickupDate: pickDay() }, priceTableId, priceFingerprint: fp,
  });
}
const shown = () => db.profileProduct.findMany({ where: { isActive: true }, select: { id: true, listPrice: true } });
const fpOf = async (firmId, tableId) => { const p = await profilePricesFor(db, firmId, { tableId }); return priceFingerprint(p.tableId, await shown(), p.price); };

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  atico = await db.customer.create({ data: { name: 'ATICO SRL', prefix: 'ATI' } });
  other = await db.customer.create({ data: { name: 'Başka Firma', prefix: 'BSK' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@katalog.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('atico', 'MUSTERI', atico.id, { canApprove: true });
  await mk('other', 'MUSTERI', other.id, { canApprove: true });
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { listPrice: '150.00' } });
  await db.profileProduct.update({ where: { code: 'SPIGOTI' }, data: { listPrice: '3.25' } });
  gk = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
  sp = await db.profileProduct.findUniqueOrThrow({ where: { code: 'SPIGOTI' } });
  tAtico = await db.profilePriceTable.create({ data: { name: 'ATICO', items: { create: [{ productId: gk.id, unitPrice: '137.00' }, { productId: sp.id, unitPrice: '3.00' }] } } });
  tMtm = await db.profilePriceTable.create({ data: { name: 'ATICO - MTM', items: { create: [{ productId: gk.id, unitPrice: '125.00' }] } } }); // SPIGOTI yok → liste fiyatı
  tOther = await db.profilePriceTable.create({ data: { name: 'Başka Firma Fiyatları', items: { create: [{ productId: gk.id, unitPrice: '99.00' }] } } });
  await db.customer.update({ where: { id: atico.id }, data: { profilePriceTableId: tAtico.id } });
  await db.customer.update({ where: { id: other.id }, data: { profilePriceTableId: tOther.id } });
});
after(async () => { await closeDb(); });

dbTest('tek kataloglu müşteri: davranış değişmedi — tek tablo, varsayılan, fiyatlar tablodan / listeden; seçimsiz sipariş eskisi gibi', offline(async () => {
  const p = await profilePricesFor(db, atico.id);
  assert.deepEqual([p.direct, p.tableId, p.tableName, p.tables.map((t) => [t.name, t.isDefault])], [true, tAtico.id, 'ATICO', [['ATICO', true]]]);
  assert.deepEqual([p.price(gk), p.price(sp)], [137, 3]);
  const r = await order([['GK15', 2]]);
  const o = await load(r.id);
  assert.deepEqual([o.profile.direct, o.profile.priceTableId, o.profile.priceTableName, o.offers[0].lines.map((l) => String(l.offerPrice))], [true, tAtico.id, 'ATICO', ['137']]);
}));

dbTest('yönetici bağlantı kuralı: ek katalog, varsayılan yapma (eski varsayılan ek olarak kalır), kaldırma (ilk ek varsayılan olur); diğer firmaya dokunmaz; yetkisiz ret', offline(async () => {
  const admin = actor(people.admin);
  assert.deepEqual((await assignProfileTable(db, { customerId: atico.id, tableId: tMtm.id, intent: 'extra', actor: actor(people.atico) })).code, 'FORBIDDEN');
  let r = await assignProfileTable(db, { customerId: atico.id, tableId: tMtm.id, intent: 'extra', actor: admin });
  assert.deepEqual(r, { ok: true, before: tAtico.id, after: tAtico.id, extras: [tMtm.id] });
  assert.deepEqual((await profileCatalogsFor(db, atico.id)).map((t) => [t.name, t.isDefault]), [['ATICO', true], ['ATICO - MTM', false]]);
  // Diğer firmanın bağlantısı aynen
  assert.deepEqual((await profileCatalogsFor(db, other.id)).map((t) => t.name), ['Başka Firma Fiyatları']);
  // MTM varsayılan yapılır: ATICO ek katalog olarak kalır (bağlantı kaybolmaz)
  r = await assignProfileTable(db, { customerId: atico.id, tableId: tMtm.id, intent: 'assign', actor: admin });
  assert.deepEqual(r, { ok: true, before: tAtico.id, after: tMtm.id, extras: [tAtico.id] });
  assert.deepEqual((await profileCatalogsFor(db, atico.id)).map((t) => [t.name, t.isDefault]), [['ATICO - MTM', true], ['ATICO', false]]);
  // Varsayılan (MTM) kaldırılır → ATICO yeniden varsayılan, ek yok
  r = await assignProfileTable(db, { customerId: atico.id, tableId: tMtm.id, intent: 'unassign', actor: admin });
  assert.deepEqual(r, { ok: true, before: tMtm.id, after: tAtico.id, extras: [] });
  // Testin devamı için: ATICO varsayılan + MTM ek
  r = await assignProfileTable(db, { customerId: atico.id, tableId: tMtm.id, intent: 'extra', actor: admin });
  assert.deepEqual([r.after, r.extras], [tAtico.id, [tMtm.id]]);
  assert.equal(await db.auditLog.count({ where: { action: 'PROFILE_PRICE_TABLE_ASSIGN', entityId: atico.id } }), 4);
  assert.deepEqual((await assignProfileTable(db, { customerId: atico.id, tableId: 'yok', intent: 'extra', actor: admin })).code, 'NOT_FOUND');
}));

dbTest('iki kataloglu müşteri: liste varsayılan önce; seçimle fiyatlar katalogdan, katalogda olmayan ürün liste fiyatına döner; başka firmanın kataloğu listede yok ve seçilemez', offline(async () => {
  const p = await profilePricesFor(db, atico.id);
  assert.deepEqual(p.tables.map((t) => [t.name, t.isDefault]), [['ATICO', true], ['ATICO - MTM', false]]);
  assert.deepEqual([p.tableId, p.price(gk), p.price(sp)], [tAtico.id, 137, 3]);
  const m = await profilePricesFor(db, atico.id, { tableId: tMtm.id });
  assert.deepEqual([m.tableId, m.tableName, m.price(gk), m.price(sp)], [tMtm.id, 'ATICO - MTM', 125, 3.25], 'GK15 125; SPIGOTI MTM’de yok → liste 3,25');
  // Başka firmanın kataloğu: listede yok; seçilirse varsayılana düşer (serviste) ve siparişte reddedilir
  const x = await profilePricesFor(db, atico.id, { tableId: tOther.id });
  assert.deepEqual([x.tableId, x.price(gk)], [tAtico.id, 137]);
  assert.equal(await codeOf(order([['GK15', 1]], { priceTableId: tOther.id })), 'BAD_PRICE_TABLE');
  assert.equal(await codeOf(order([['GK15', 1]], { priceTableId: 'yok' })), 'BAD_PRICE_TABLE');
  // Diğer firma kendi kataloğunu görür, ATICO’nunkileri değil
  const o2 = await profilePricesFor(db, other.id);
  assert.deepEqual([o2.tables.map((t) => t.name), o2.price(gk)], [['Başka Firma Fiyatları'], 99]);
  assert.equal(await codeOf(order([['GK15', 1]], { f: other, who: 'other', priceTableId: tMtm.id })), 'BAD_PRICE_TABLE');
}));

dbTest('parmak izi: gösterilen fiyatlar değiştiyse sipariş açılmaz (PRICES_CHANGED); güncel parmak iziyle açılır', offline(async () => {
  const fp = await fpOf(atico.id, tMtm.id);
  assert.notEqual(fp, await fpOf(atico.id, tAtico.id), 'kataloğa göre farklı');
  await db.profilePriceItem.update({ where: { tableId_productId: { tableId: tMtm.id, productId: gk.id } }, data: { unitPrice: '126.00' } });
  assert.equal(await codeOf(order([['GK15', 1]], { priceTableId: tMtm.id, priceFingerprint: fp })), 'PRICES_CHANGED');
  assert.equal(await db.order.count({ where: { customerId: atico.id } }), 1, 'sipariş açılmadı');
  await db.profilePriceItem.update({ where: { tableId_productId: { tableId: tMtm.id, productId: gk.id } }, data: { unitPrice: '125.00' } });
  assert.equal(await fpOf(atico.id, tMtm.id), fp, 'fiyat geri alınınca aynı parmak izi');
  // Liste fiyatı değişince de (katalogda olmayan ürün) parmak izi değişir
  await db.profileProduct.update({ where: { id: sp.id }, data: { listPrice: '3.30' } });
  assert.notEqual(await fpOf(atico.id, tMtm.id), fp);
  await db.profileProduct.update({ where: { id: sp.id }, data: { listPrice: '3.25' } });
}));

dbTest('seçilen katalogla sipariş: satır fiyatları seçilen katalogdan ve sabit; katalog siparişe kaydedilir; proforma kaydedilen fiyatlardan; sonradan değişen fiyat geçmiş siparişi etkilemez', offline(async () => {
  const fp = await fpOf(atico.id, tMtm.id);
  const r = await order([['GK15', 2], ['SPIGOTI', 4]], { priceTableId: tMtm.id, priceFingerprint: fp });
  let o = await load(r.id);
  assert.deepEqual([o.profile.direct, o.profile.priceTableId, o.profile.priceTableName], [true, tMtm.id, 'ATICO - MTM']);
  assert.deepEqual(o.offers[0].lines.map((l) => [l.adet, String(l.offerPrice)]), [[2, '125'], [4, '3.25']]);
  assert.equal(String(o.offers[0].offerAmount), '263');
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_CREATE', entityId: o.id } });
  assert.deepEqual([audit.details.priceTable, audit.details.priceTableId], ['ATICO - MTM', tMtm.id]);
  // Proforma belge satırları (FGO) yalnızca kaydedilen teklif satırlarından — sipariş fiyatlarıyla birebir
  assert.deepEqual(documentLines(o.offers[0], o.orderNo).map((l) => [l.qty, l.eur]), [[2, 125], [4, 3.25]]);
  // Katalog fiyatı sonradan değişir / katalog firmadan kaldırılır: sipariş satırları ve kayıtlı katalog adı aynen
  await db.profilePriceItem.update({ where: { tableId_productId: { tableId: tMtm.id, productId: gk.id } }, data: { unitPrice: '110.00' } });
  await db.profilePriceTable.update({ where: { id: tMtm.id }, data: { name: 'ATICO - MTM (eski)' } });
  o = await load(r.id);
  assert.deepEqual(o.offers[0].lines.map((l) => String(l.offerPrice)), ['125', '3.25']);
  assert.equal(o.profile.priceTableName, 'ATICO - MTM');
  await db.profilePriceTable.update({ where: { id: tMtm.id }, data: { name: 'ATICO - MTM' } });
  await db.profilePriceItem.update({ where: { tableId_productId: { tableId: tMtm.id, productId: gk.id } }, data: { unitPrice: '125.00' } });
  // Seçimsiz sipariş hâlâ varsayılan (ATICO) kataloğundan
  const d = await order([['GK15', 1]]);
  assert.deepEqual((await load(d.id)).offers[0].lines.map((l) => String(l.offerPrice)), ['137']);
}));

dbTest('taslak: adetler ve not korunur, yeniden açılınca aynı; taslaktan sipariş varsayılan katalogla açılır', offline(async () => {
  const items = await itemsOf([['GK15', 3], ['SPIGOTI', 7]]);
  const saved = await saveProfileDraft(db, { actor: actor(people.atico), firm: atico, draftId: null, values: { title: 'Taslak', note: 'Notum kalsın', lines: items.map((i) => ({ productId: i.productId, qty: i.qty })), customerOrderNo: null } });
  const row = await db.orderDraft.findUniqueOrThrow({ where: { id: saved.id } });
  assert.deepEqual([row.note, readProfileDraftItems(row.items).map((l) => l.qty)], ['Notum kalsın', [3, 7]]);
  const next = await suggestNextNo(db, atico.id, 'PROFILE_ORDER');
  const r = await createProfileOrder(db, { actor: actor(people.atico), firm: atico, title: 'Taslak', requestedNo: next, suggestedNo: next, items, note: 'Notum kalsın', draftId: saved.id, pickup: { pickupDate: pickDay() } });
  const o = await load(r.id);
  assert.deepEqual([o.profile.priceTableName, o.offers[0].lines.map((l) => [l.adet, String(l.offerPrice)])], ['ATICO', [[3, '137'], [7, '3']]]);
  assert.equal(await db.orderDraft.count({ where: { id: saved.id } }), 0);
}));

dbTest('pasif ek katalog listede yok; varsayılan pasifse ilk ek varsayılan olur; hiç etkin katalog yoksa olağan akış', offline(async () => {
  await db.profilePriceTable.update({ where: { id: tMtm.id }, data: { isActive: false } });
  assert.deepEqual((await profilePricesFor(db, atico.id)).tables.map((t) => t.name), ['ATICO']);
  await db.profilePriceTable.update({ where: { id: tMtm.id }, data: { isActive: true } });
  await db.profilePriceTable.update({ where: { id: tAtico.id }, data: { isActive: false } });
  const p = await profilePricesFor(db, atico.id);
  assert.deepEqual([p.tables.map((t) => [t.name, t.isDefault]), p.tableName], [[['ATICO - MTM', true]], 'ATICO - MTM']);
  await db.profilePriceTable.update({ where: { id: tMtm.id }, data: { isActive: false } });
  const n = await profilePricesFor(db, atico.id);
  assert.deepEqual([n.direct, n.tables, n.tableId], [false, [], null]);
  await db.profilePriceTable.update({ where: { id: tAtico.id }, data: { isActive: true } });
  await db.profilePriceTable.update({ where: { id: tMtm.id }, data: { isActive: true } });
}));
