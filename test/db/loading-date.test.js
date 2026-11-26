// Sabit tahmini yükleme tarihi (4.2.34) — veritabanıyla: yeni cam siparişinin kayıtlı tarihi, mevcut siparişlerin
// değişmemesi, profil müşteri seçimi (alt sınır) ve yöneticinin etkilenmemesi.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { runBaseSeed } from '../../prisma/seed/base.mjs';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { createProfileOrder } from '../../server/profile/create.js';
import { profileOrderItems } from '../../server/profile/rules.js';
import { runProfileAction } from '../../server/profile/transitions.js';
import { earliestPickup } from '../../server/profile/dates.js';
import { getEnv } from '../../server/env.js';
import { glassLoadingDate } from '../../server/orders/rules.js';
import { LOADING_DATE_SETTING_KEY, getLoadingDateSetting, localDayKey, saveLoadingDateSetting } from '../../server/orders/loading-date-setting.js';

let db;
const people = {};
let firm;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const key = (d) => d.toISOString().slice(0, 10);
let n = 0;
const fileMeta = () => ({ storageKey: `2026/11/ld${++n}.pdf`, name: `ld-${n}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' });
const newGlass = async () => {
  const next = await suggestNextNo(db, firm.id);
  const o = await createGlassOrder(db, { actor: actor(people.cust), firm, title: 'LD', requestedNo: next, suggestedNo: next, items: [{ glassName: '8mm Temperli', camAdedi: 1 }], files: [fileMeta()] });
  return db.order.findUniqueOrThrow({ where: { id: o.id } });
};
/** Bugünden ~50 gün sonraki bir Cuma (açık depo günü; ileri tarihli olduğu için takvim ilerleyince bozulmaz) */
const futureFriday = () => {
  const d = new Date(`${localDayKey(new Date(), 'Europe/Bucharest')}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 50);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  // Romanya tatiline denk gelirse bir hafta ileri (Cuma tatilleri nadir)
  return key(d);
};
const save = (glass, profile, who = 'admin') => saveLoadingDateSetting(db, { glass, profile, actor: actor(people[who]), timeZone: getEnv().APP_TIMEZONE });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  await runBaseSeed(db, { log: () => {} });
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  const mk = (k, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${k}@ld.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[k] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
});
after(closeDb);

dbTest('varsayılan (ayar yok): yeni cam siparişi otomatik hesabı alır — bugünkü davranış', async () => {
  assert.equal(await db.integrationSetting.count({ where: { key: LOADING_DATE_SETTING_KEY } }), 0);
  const o = await newGlass();
  assert.equal(o.estimatedShipDate.toISOString(), glassLoadingDate(o.createdAt, getEnv().APP_TIMEZONE).toISOString());
});

dbTest('cam sabit: yeni sipariş sabit günü alır; mevcut sipariş değişmez; satış yine değiştirebilir; otomatiğe dönünce eski kural', async () => {
  const old = await newGlass();
  const day = futureFriday();
  assert.equal((await save({ fixed: true, date: day }, { fixed: false }, 'sales')).code, 'FORBIDDEN', 'satış ayarı değiştiremez');
  assert.deepEqual(await save({ fixed: true, date: day }, { fixed: false }), { ok: true, changed: true });
  assert.equal((await getLoadingDateSetting(db)).glass.date, day);
  assert.equal(await db.auditLog.count({ where: { action: 'LOADING_DATE_SETTING' } }), 1);

  const o = await newGlass();
  assert.equal(key(o.estimatedShipDate), day);
  assert.equal(o.estimatedShipDate.toISOString(), `${day}T12:00:00.000Z`);
  const oldNow = await db.order.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(oldNow.estimatedShipDate.toISOString(), old.estimatedShipDate.toISOString(), 'mevcut sipariş aynı');

  assert.deepEqual(await save({ fixed: false, date: day }, { fixed: false }), { ok: true, changed: true });
  const back = await newGlass();
  assert.equal(back.estimatedShipDate.toISOString(), glassLoadingDate(back.createdAt, getEnv().APP_TIMEZONE).toISOString());
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).estimatedShipDate.toISOString(), `${day}T12:00:00.000Z`, 'sabit günle açılan sipariş de değişmez');
});

dbTest('geçmişte kalmış sabit gün (eski kayıt): yok sayılır, otomatik hesap', async () => {
  await db.integrationSetting.upsert({ where: { key: LOADING_DATE_SETTING_KEY }, create: { key: LOADING_DATE_SETTING_KEY, value: { glass: { mode: 'FIXED', date: '2026-01-15' } } }, update: { value: { glass: { mode: 'FIXED', date: '2026-01-15' } } } });
  const o = await newGlass();
  assert.equal(o.estimatedShipDate.toISOString(), glassLoadingDate(o.createdAt, getEnv().APP_TIMEZONE).toISOString());
  await db.integrationSetting.delete({ where: { key: LOADING_DATE_SETTING_KEY } });
});

dbTest('profil sabit: müşteri sabit günden önce alış seçemez, sabit günü seçebilir; yönetici kısıtlanmaz; cam ayarı profili etkilemez', async () => {
  const day = futureFriday();
  const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
  assert.equal(products.length, 1, 'profil kataloğu seed edildi');
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { listPrice: '12.50' } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 2 }], products);
  const mkOrder = async () => {
    const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
    const { id } = await createProfileOrder(db, { actor: actor(people.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
    await runProfileAction(db, { orderId: id, action: 'send_profile_offer', actor: actor(people.admin), payload: { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) } });
    const sent = await db.offer.findFirstOrThrow({ where: { orderId: id }, orderBy: { createdAt: 'desc' } });
    return { id, offerId: sent.id };
  };
  const auto = earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
  const approve = (o, d) => runProfileAction(db, { orderId: o.id, action: 'approve_profile_offer', actor: actor(people.cust), payload: { offerId: o.offerId, pickupDate: d, phone: '+40 723 000 000', plate: 'B 1 ABC' } });

  // Yalnızca CAM sabit: profil eski kural (otomatik en erken gün geçerli)
  await save({ fixed: true, date: day }, { fixed: false });
  const a = await mkOrder();
  assert.equal(await codeOf(approve(a, auto)), 'OK');

  await save({ fixed: false }, { fixed: true, date: day });
  const b = await mkOrder();
  assert.equal(await codeOf(approve(b, auto)), 'PICKUP_TOO_EARLY', 'sabit günden önce');
  assert.equal(await codeOf(approve(b, new Date(`${day}T12:00:00.000Z`))), 'OK', 'sabit gün');
  // Yönetici teslim gününü sabit günden önceye alabilir (en erken kural yöneticiye uygulanmaz)
  assert.equal(await codeOf(runProfileAction(db, { orderId: b.id, action: 'update_pickup', actor: actor(people.admin), payload: { pickupDate: auto } })), 'OK');
  const saved = await db.profileOrder.findUniqueOrThrow({ where: { orderId: b.id } });
  assert.equal(key(saved.pickupDate), key(auto));
  await db.integrationSetting.delete({ where: { key: LOADING_DATE_SETTING_KEY } });
});
