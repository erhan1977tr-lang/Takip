// Otomatik "Yüklendi" (karar 156) — veritabanıyla: yükleme gününden 45 gün geçmiş, hâlâ üretimde duran cam siparişi mevcut
// durum geçişiyle "Yüklendi" olur ("Yüklenen ve arşiv" sekmesi); geçmiş ve denetim kaydı yazılır; yükleme günü, sandık,
// teklif ve belge kayıtları değişmez; müşteriye bildirim gitmez. Kuralın "bugün"ü sabit verilir (saate bağlı değildir).
// Hiçbir ağ çağrısı yapılmaz (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { autoShipOrders } = await import('../../server/orders/auto-ship.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { orderScope } = await import('../../server/orders/scope.js');
const { CLOSED } = await import('../../server/orders/rules.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const n = await import('../../server/notifications/inapp.js');

// Kuralın "bugün"ü: 15.09.2026 (Romanya saatiyle de aynı gün) → 45 gün öncesi 01.08.2026
const NOW = new Date('2026-09-15T10:00:00Z');
const NEXT_DAY = new Date('2026-09-16T10:00:00Z');
const [DUE, EDGE, OLD, REPLAN_DAY] = ['2026-08-01', '2026-08-02', '2026-06-01', '2026-07-20'];
// Aktarımın hedef günü gerçek saate göre ileride olmalı (aktarım yalnızca gelecek güne yapılır)
const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const at = (day) => new Date(`${day}T12:00:00Z`);
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
const U = {};
const O = {};
let db, A;

const glassLine = (adet) => ({ description: 'Temper Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 2000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '66.96', listPrice: '30', weightKgM2: '20.8' });
async function order(key, no, day, extra = {}) {
  O[key] = await db.order.create({
    data: {
      orderNo: `ABC${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: A.id, createdById: U.admin.id, status: 'URETIMDE',
      estimatedShipDate: day ? at(day) : null, ...extra,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: U.admin.id, sentAt: new Date('2026-05-01T09:00:00Z'), lines: { create: [{ sortOrder: 0, ...glassLine(10) }] } } },
    },
    include: { offers: { include: { lines: true } } },
  });
}
const status = async (key) => (await db.order.findUniqueOrThrow({ where: { id: O[key].id } })).status;
const statuses = async (...keys) => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await status(k)])));
const events = (orderId) => db.orderEvent.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const snapshot = async (orderId) => JSON.stringify({
  offers: await db.offer.findMany({ where: { orderId }, orderBy: { id: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } }),
  crates: await db.crateOrder.findMany({ where: { orderId }, orderBy: { crateId: 'asc' } }),
  items: await db.loadingConfirmationItem.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
  docs: await db.fgoDocument.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
});

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'ABC Glass SRL', prefix: 'ABC', email: 'abc@otomatik.test' } });
  const user = (key, appRole, customerId, extra = {}) => db.user.create({ data: { email: `${key}@otomatik.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { U[key] = u; });
  await user('admin', 'ADMIN', factory.id);
  await user('sales', 'SATIS', factory.id);
  await user('drawer', 'CIZIM', factory.id);
  await user('custA', 'MUSTERI', A.id, { canApprove: true });

  await order('due', 1, DUE); // tam 45 gün
  await order('edge', 2, EDGE); // 44 gün
  await order('old', 3, OLD);
  await order('hold', 4, OLD, { onHold: true });
  await order('prep', 5, OLD, { status: 'HAZIRLANIYOR' });
  await order('fresh', 6, OLD, { status: 'YENI' });
  await order('done', 7, OLD, { status: 'YUKLENDI', actualShipDate: at(OLD) });
  await order('gone', 8, OLD, { status: 'IPTAL', removedAt: new Date('2026-06-10T09:00:00Z'), removedById: U.admin.id, removedStatus: 'URETIMDE' });
  await order('nodate', 9, null);
  await order('replan', 10, REPLAN_DAY);
});
after(async () => {
  await closeDb();
});

dbTest('45 gün dolunca üretimdeki sipariş "Yüklendi" olur; 44. günde, beklemede, hazırlanırken, tarihsiz, silinmiş ve etkin aktarımlı sipariş olmaz', offline(async () => {
  // "replan" siparişi: 20.07 yüklemesinde 10 camdan 2'si yüklenmedi ve ileri güne aktarıldı (etkin aktarım)
  const line = O.replan.offers[0].lines[0];
  assert.equal((await c.confirmLoading(db, { day: REPLAN_DAY, key: (await c.previewLoading(db, REPLAN_DAY)).key, notLoaded: [{ key: `l:${line.id}`, quantity: 2, reason: 'BROKEN' }], actor: act(U.admin) })).ok, true);
  const item = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: O.replan.id, status: 'NOT_LOADED' } });
  const moved = await rp.replanNotLoaded(db, { itemId: item.id, day: FUTURE, quantity: 2, actor: act(U.admin) });
  assert.equal(moved.ok, true);

  const before = { due: await snapshot(O.due.id), replan: await snapshot(O.replan.id) };
  const audits = await db.auditLog.count();
  assert.deepEqual(await autoShipOrders(db, { now: NOW }), { shipped: 2, skipped: 0 });
  assert.deepEqual(await statuses('due', 'old', 'edge', 'hold', 'prep', 'fresh', 'done', 'gone', 'nodate', 'replan'), {
    due: 'YUKLENDI', old: 'YUKLENDI', edge: 'URETIMDE', hold: 'URETIMDE', prep: 'HAZIRLANIYOR', fresh: 'YENI', done: 'YUKLENDI', gone: 'IPTAL', nodate: 'URETIMDE', replan: 'URETIMDE',
  });

  // Mevcut durum, mevcut sekme: "Yüklenen ve arşiv" bu durumu gösterir; ikinci bir durum / işaret yok
  const due = await db.order.findUniqueOrThrow({ where: { id: O.due.id } });
  assert.ok(CLOSED.includes(due.status));
  assert.deepEqual([due.actualShipDate, due.estimatedShipDate.toISOString().slice(0, 10), due.version, due.onHold, due.removedAt], [null, DUE, O.due.version + 1, false, null], 'yükleme günü değişmez; sürüm bir artar');
  assert.equal(await snapshot(O.due.id), before.due, 'teklif, sandık, yükleme ve belge kayıtları değişmez');
  // Geçmiş: tek "otomatik yüklendi" kaydı, kullanıcısız (sistem), üretimde → yüklendi
  const ev = await events(O.due.id);
  assert.deepEqual(ev.map((e) => [e.event, e.fromStatus, e.toStatus, e.userId, e.note]), [['AUTO_SHIPPED', 'URETIMDE', 'YUKLENDI', null, null]]);
  // Denetim kaydı: iş akışı geçişi, sistem rolüyle; kural ve yükleme günü ayrıntıda
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: O.due.id } });
  assert.deepEqual(
    [audit.userId, audit.actorRole, audit.details.action, audit.details.events, audit.details.from, audit.details.to, audit.details.auto, audit.details.days, audit.details.shipDay],
    [null, 'SYSTEM', 'auto_shipped', ['AUTO_SHIPPED'], 'URETIMDE', 'YUKLENDI', true, 45, DUE],
  );
  assert.equal(await db.auditLog.count(), audits + 2, 'kapanan sipariş başına bir denetim kaydı');
  // Müşteriye "yüklendi" bildirimi / e-postası gitmez: kuyruk olayı hiçbir bildirim kuralına girmez
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: O.due.id } })).map((x) => x.type), ['ORDER_AUTO_SHIPPED']);
  await n.dispatchInApp(db);
  assert.equal(await db.notification.count({ where: { orderId: { in: [O.due.id, O.old.id] } } }), 0);
  // Zaten "Yüklendi" olan ve silinmiş sipariş: yeni kayıt yok
  assert.equal((await events(O.done.id)).length, 0);
  assert.equal((await events(O.gone.id)).length, 0);
  // Etkin aktarımı olan sipariş (camı henüz yüklenmedi) kapanmadı; kayıtları değişmedi
  assert.equal(await snapshot(O.replan.id), before.replan);
  assert.ok(!(await events(O.replan.id)).some((e) => e.event === 'AUTO_SHIPPED'));

  // Yinelenen tur hiçbir şeyi çoğaltmaz
  assert.deepEqual(await autoShipOrders(db, { now: NOW }), { shipped: 0, skipped: 0 });
  assert.equal((await events(O.due.id)).length, 1);
  assert.equal(await db.auditLog.count(), audits + 2);

  // Sipariş her rolün kapsamında kalır (yalnızca sekmesi değişir); satış isterse mevcut "Arşivle" ile arşivler
  for (const u of [U.admin, U.sales, U.custA]) assert.equal(await db.order.count({ where: { id: O.due.id, ...orderScope({ appRole: u.appRole, customerId: u.customerId }) } }), 1, u.appRole);
  await runOrderAction(db, { orderId: O.old.id, action: 'archive', actor: act(U.sales) });
  assert.equal(await status('old'), 'ARSIVLENDI');
}));

dbTest('sınır ve aktarım: 44. gündeki sipariş ertesi gün kapanır; aktarımdan vazgeçilince sipariş kapanır', offline(async () => {
  assert.deepEqual(await autoShipOrders(db, { now: NEXT_DAY }), { shipped: 1, skipped: 0 });
  assert.equal(await status('edge'), 'YUKLENDI');
  assert.equal(await status('replan'), 'URETIMDE');
  const replan = await db.loadingReplan.findFirstOrThrow({ where: { orderId: O.replan.id, status: 'ACTIVE' } });
  assert.deepEqual(await rp.cancelReplan(db, { replanId: replan.id, actor: act(U.admin) }), { ok: true });
  assert.deepEqual(await autoShipOrders(db, { now: NEXT_DAY }), { shipped: 1, skipped: 0 });
  assert.equal(await status('replan'), 'YUKLENDI');
  // Onaylı yükleme (8 yüklendi / 2 yüklenmedi) olduğu gibi durur
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId: O.replan.id }, orderBy: { status: 'asc' } });
  assert.deepEqual(items.map((i) => [i.status, i.quantity]), [['LOADED', 8], ['NOT_LOADED', 2]]);
  // Kalanlar yerinde: beklemede, hazırlanan, yeni ve tarihsiz sipariş hiçbir turda kapanmaz
  assert.deepEqual(await statuses('hold', 'prep', 'fresh', 'nodate'), { hold: 'URETIMDE', prep: 'HAZIRLANIYOR', fresh: 'YENI', nodate: 'URETIMDE' });
}));

dbTest('işlem yalnızca işçiye açık: hiçbir kullanıcı (yönetici dahil) "otomatik yüklendi"yi tetikleyemez', offline(async () => {
  for (const u of [U.admin, U.sales, U.drawer, U.custA]) {
    await assert.rejects(runOrderAction(db, { orderId: O.nodate.id, action: 'auto_shipped', actor: act(u) }), /NOT_ALLOWED|NOT_FOUND/, u.appRole);
    // Kullanıcı isteği "system" / "autoShip" taşısa bile işçi sayılmaz: kimlik bilgisi sunucuda kurulur (lib/actor.ts)
    await assert.rejects(runOrderAction(db, { orderId: O.nodate.id, action: 'auto_shipped', actor: { ...act(u), autoShip: true } }), /NOT_ALLOWED|NOT_FOUND/, u.appRole);
  }
  assert.equal(await status('nodate'), 'URETIMDE');
  assert.equal((await events(O.nodate.id)).length, 0);
  // Beklemedeki sipariş işçi için de geçersizdir (kural sorguda ve iş akışı denetiminde)
  await assert.rejects(runOrderAction(db, { orderId: O.hold.id, action: 'auto_shipped', actor: { id: null, role: 'SYSTEM', system: true, autoShip: true, ip: null } }), /NOT_ALLOWED/);
  assert.equal(await status('hold'), 'URETIMDE');
}));
