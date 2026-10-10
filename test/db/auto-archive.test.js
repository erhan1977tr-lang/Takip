// Otomatik arşiv (karar 158) — veritabanıyla. Fiziksel yüklemesi kanıtlı cam siparişi (kişinin "Yüklendi"si ya da eksiksiz
// yükleme onayı) yükleme gününden 45 gün sonra mevcut arşiv durumuna geçer; kanıtı olmayan (planlanan tarihi geçmiş ama
// onaylanmamış, kalanı açık / aktarılmış, beklemedeki, teklifine sonradan cam eklenmiş) sipariş üretimde kalır. 3.51.0'ın
// tarihe bakarak verdiği "Yüklendi"ler önce geri alınır. Geçmiş ve denetim kaydı yazılır; teklif, sandık, yükleme onayı ve
// FGO belgeleri değişmez; bildirim yoktur; yinelenen ya da eşzamanlı tur hiçbir şeyi çoğaltmaz.
// Kuralın "bugün"ü sabit verilir (saate bağlı değildir). Hiçbir ağ çağrısı yapılmaz (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { ARCHIVE_ACTOR, autoArchiveOrders, repairAutoShipped } = await import('../../server/orders/auto-archive.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { eventsFor } = await import('../../server/orders/order-view.js');
const { orderScope } = await import('../../server/orders/scope.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const comp = await import('../../server/orders/compensation.js');
const n = await import('../../server/notifications/inapp.js');

// Kuralın "bugün"ü: 15.09.2026 → 45 gün öncesi 01.08.2026
const NOW = new Date('2026-09-15T10:00:00Z');
const NEXT_DAY = new Date('2026-09-16T10:00:00Z');
const [DUE, EDGE, LATER] = ['2026-08-01', '2026-08-02', '2026-08-10'];
// Aktarım / telafi hedefi gerçek saate göre ileride olmalı (yalnızca gelecek güne yapılır)
const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const at = (day) => new Date(`${day}T12:00:00Z`);
const dmy = (day) => day.split('-').reverse().join('.');
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
const U = {};
const O = {};
let db, A, no = 0;

const glassLine = (adet) => ({ description: 'Temper Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 2000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '66.96', listPrice: '30', weightKgM2: '20.8' });
const FULL = { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } };
async function order(key, day, extra = {}) {
  no++;
  O[key] = await db.order.create({
    data: {
      orderNo: `ABC${no}`, customerOrderNo: no, title: `Proje ${key}`, orderTypeCode: 'GLASS_ORDER', customerId: A.id, createdById: U.admin.id, status: 'URETIMDE',
      estimatedShipDate: at(day), ...extra,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '300', offerAmount: '669.60', createdById: U.admin.id, sentAt: new Date('2026-05-01T09:00:00Z'), lines: { create: [{ sortOrder: 0, ...glassLine(10) }] } } },
    },
    include: FULL,
  });
  return O[key];
}
/** Günün yüklemesini onaylar (yönetici); notLoaded: { siparişAnahtarı: adet } — o siparişin camından yüklenmeyen adet */
async function confirm(day, notLoaded = {}) {
  const preview = await c.previewLoading(db, day);
  const input = Object.entries(notLoaded).map(([k, quantity]) => ({ key: `l:${O[k].offers[0].lines[0].id}`, quantity, reason: 'BROKEN' }));
  const r = await c.confirmLoading(db, { day, key: preview.key, notLoaded: input, actor: act(U.admin) });
  assert.equal(r.ok, true, `${day}: ${r.code ?? ''}`);
}
/** 3.51.0'ın bıraktığı kayıt: tarihe bakılarak "Yüklendi" yapılmış sipariş (durum + AUTO_SHIPPED olayı + kuyruk olayı) */
async function autoShipped51(key, to = 'YUKLENDI') {
  await db.order.update({ where: { id: O[key].id }, data: { status: to, version: { increment: 1 } } });
  const ev = await db.orderEvent.create({ data: { orderId: O[key].id, event: 'AUTO_SHIPPED', fromStatus: 'URETIMDE', toStatus: 'YUKLENDI', createdAt: new Date(Date.now() - 3_600_000) } });
  await db.notificationOutbox.create({ data: { type: 'ORDER_AUTO_SHIPPED', orderId: O[key].id, payload: { from: 'URETIMDE', to: 'YUKLENDI', actorId: null } } });
  return ev;
}
const status = async (key) => (await db.order.findUniqueOrThrow({ where: { id: O[key].id } })).status;
const statuses = async (...keys) => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await status(k)])));
const events = (key) => db.orderEvent.findMany({ where: { orderId: O[key].id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const autoEvents = async (key) => (await events(key)).filter((e) => e.event.startsWith('AUTO_')).map((e) => [e.event, e.fromStatus, e.toStatus, e.userId, e.note]);
const snapshot = async (key) => JSON.stringify({
  offers: await db.offer.findMany({ where: { orderId: O[key].id }, orderBy: { id: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } }),
  price: await db.price.findUnique({ where: { orderId: O[key].id } }),
  crates: await db.crateOrder.findMany({ where: { orderId: O[key].id }, orderBy: { crateId: 'asc' } }),
  items: await db.loadingConfirmationItem.findMany({ where: { orderId: O[key].id }, orderBy: { id: 'asc' } }),
  replans: await db.loadingReplan.findMany({ where: { orderId: O[key].id }, orderBy: { id: 'asc' } }),
  docs: await db.fgoDocument.findMany({ where: { orderId: O[key].id }, orderBy: { id: 'asc' } }),
  billing: await db.glassBilling.findMany({ where: { orderId: O[key].id } }),
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

  // Kanıtı OLMAYANLAR (yükleme günü 45 günden eski olsa da üretimde kalır)
  await order('planned', '2026-05-04'); // planlanan gün çoktan geçti, yükleme onayı yok
  await order('partial', '2026-06-01'); // onayda 2 cam yüklenmedi, aktarılmadı
  await order('active', '2026-06-03'); // 2 cam yüklenmedi, ileri güne aktarıldı (henüz yüklenmedi)
  await order('hold', '2026-06-04'); // eksiksiz yüklendi ama beklemede
  await order('changed', '2026-06-05'); // eksiksiz yüklendi, sonra teklife cam eklendi (yeni sürüm: 12 adet)
  await order('auto', '2026-05-05'); // 3.51.0: tarihe bakılarak "Yüklendi" yapılmış, hiç yüklenmemiş
  // Kanıtı OLANLAR
  await order('loaded', DUE); // tam 45 gün önce eksiksiz yüklendi
  await order('edge', EDGE); // 44 gün önce eksiksiz yüklendi
  await order('chain', '2026-06-02'); // 2 cam yüklenmedi → 10.08'e aktarıldı ve o gün yüklendi
  await order('shipped', '2026-06-06'); // satış "Yüklendi" dedi (kişi) ama yükleme onayı YOK — karar 245: kanıt değil
  await order('autoLoaded', '2026-06-08'); // 3.51.0'ın "Yüklendi"si, ama yüklemesi gerçekten onaylı
  await order('autoThenArchived', '2026-05-06'); // 3.51.0'ın "Yüklendi"sinden sonra bir kişi arşivledi

  await confirm('2026-06-01', { partial: 2 });
  await confirm('2026-06-02', { chain: 2 });
  await confirm('2026-06-03', { active: 2 });
  await confirm('2026-06-04');
  await confirm('2026-06-05');
  await confirm('2026-06-08');
  await confirm(DUE);
  await confirm(EDGE);
  // chain: kalan 2 cam geçmiş bir güne (10.08) aktarılmış ve o gün yüklenmiş — aktarım kaydı doğrudan yazılır (hizmet
  // yalnızca gelecek güne aktarır; geçmiş zinciri kurmak için), onay olağan hizmetle
  const src = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: O.chain.id, status: 'NOT_LOADED' }, include: { confirmation: true } });
  await db.loadingReplan.create({
    data: {
      sourceItemId: src.id, orderId: O.chain.id, customerId: A.id, quantity: 2, m2: '4.00', reason: 'BROKEN', fromDay: src.confirmation.shipDay,
      shipDay: c.shipDayDate(LATER), activeKey: `${src.confirmationId}|l:${src.offerLineId}|${LATER}`, createdById: U.admin.id,
    },
  });
  await confirm(LATER);
  // active: kalan gelecek güne aktarıldı (etkin aktarım)
  const rest = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: O.active.id, status: 'NOT_LOADED' } });
  assert.equal((await rp.replanNotLoaded(db, { itemId: rest.id, day: FUTURE, quantity: 2, actor: act(U.admin) })).ok, true);
  await db.order.update({ where: { id: O.hold.id }, data: { onHold: true } });
  // changed: yükleme onayından sonra müşterideki teklifin yeni (en yeni) sürümü 12 adet — 2 cam hiçbir onayda yok
  await db.offer.create({
    data: { orderId: O.changed.id, status: 'GONDERILDI', currency: 'EUR', amount: '360', offerAmount: '803.52', createdById: U.admin.id, sentAt: new Date(), createdAt: new Date(Date.now() + 1000), lines: { create: [{ sortOrder: 0, ...glassLine(12) }] } },
  });
  // shipped: satışın "Yüklendi" düğmesi (gerçek işlem: SHIPPED olayı); fiili yükleme günü 06.06.2026 kabul edilir
  await runOrderAction(db, { orderId: O.shipped.id, action: 'mark_shipped', actor: act(U.sales) });
  await db.order.update({ where: { id: O.shipped.id }, data: { actualShipDate: at('2026-06-06') } });
  // 3.51.0'ın bıraktığı kayıtlar
  O.autoEvent = await autoShipped51('auto');
  O.autoLoadedEvent = await autoShipped51('autoLoaded');
  await autoShipped51('autoThenArchived');
  await runOrderAction(db, { orderId: O.autoThenArchived.id, action: 'archive', actor: act(U.sales) });
  // Önceden kesilmiş FGO belgesi (proforma): arşiv belgeye dokunmaz
  await db.fgoDocument.create({ data: { orderId: O.loaded.id, kind: 'PROFORMA', series: 'PRF', number: '9101', issuedAt: new Date('2026-07-20T09:00:00Z'), currency: 'RON', total: '3999.00', paid: '0' } });
});
after(async () => {
  await closeDb();
});

dbTest('önce onarım, sonra arşiv: yalnızca fiziksel yüklemesi kanıtlı ve 45 günü dolmuş sipariş arşivlenir; ötekiler üretimde kalır', offline(async () => {
  const keep = { loaded: await snapshot('loaded'), autoLoaded: await snapshot('autoLoaded'), partial: await snapshot('partial'), planned: await snapshot('planned') };
  const audits = await db.auditLog.count();
  const docs = await db.fgoDocument.findMany({ orderBy: { id: 'asc' } });
  const outboxJobs = await db.notificationOutbox.count({ where: { type: { startsWith: 'FGO' } } });

  // 1) Onarım: 3.51.0'ın "Yüklendi"si hâlâ duran iki sipariş geri alınır; sonradan bir kişinin arşivlediği sipariş değişmez
  assert.deepEqual(await repairAutoShipped(db), { reverted: 2, skipped: 0 });
  assert.deepEqual(await statuses('auto', 'autoLoaded', 'autoThenArchived'), { auto: 'URETIMDE', autoLoaded: 'URETIMDE', autoThenArchived: 'ARSIVLENDI' });
  assert.deepEqual(await autoEvents('auto'), [['AUTO_SHIPPED', 'URETIMDE', 'YUKLENDI', null, null], ['AUTO_SHIP_REVERTED', 'YUKLENDI', 'URETIMDE', null, null]]);
  const revert = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: O.auto.id } });
  assert.deepEqual(
    [revert.userId, revert.actorRole, revert.details.action, revert.details.events, revert.details.from, revert.details.to, revert.details.auto, revert.details.revertOf],
    [null, 'SYSTEM', 'auto_ship_revert', ['AUTO_SHIP_REVERTED'], 'YUKLENDI', 'URETIMDE', true, O.autoEvent.id],
  );
  assert.deepEqual((await autoEvents('autoThenArchived')).map((e) => e[0]), ['AUTO_SHIPPED'], 'kişinin kararından sonra onarım yok');

  // 2) Arşiv
  assert.deepEqual(await autoArchiveOrders(db, { now: NOW }), { archived: 2, skipped: 0 });
  assert.deepEqual(await statuses('planned', 'partial', 'active', 'hold', 'changed', 'auto', 'loaded', 'edge', 'chain', 'shipped', 'autoLoaded', 'autoThenArchived'), {
    planned: 'URETIMDE', partial: 'URETIMDE', active: 'URETIMDE', hold: 'URETIMDE', changed: 'URETIMDE', auto: 'URETIMDE',
    // shipped: onaysız "Yüklendi" — süre dolsa da arşivlenmez, müşterinin Active listesinde kalır (karar 243, 245)
    loaded: 'ARSIVLENDI', edge: 'URETIMDE', chain: 'URETIMDE', shipped: 'YUKLENDI', autoLoaded: 'ARSIVLENDI', autoThenArchived: 'ARSIVLENDI',
  });
  // Kanıtı olmayan sipariş hiçbir şekilde "Yüklendi" yapılmadı: kayıtları aynen durur
  for (const k of ['planned', 'partial', 'active', 'hold', 'changed', 'auto']) assert.ok(!(await events(k)).some((e) => e.event === 'AUTO_ARCHIVED' || (e.toStatus === 'YUKLENDI' && e.event !== 'AUTO_SHIPPED')), k);
  assert.equal(await snapshot('partial'), keep.partial);
  assert.equal(await snapshot('planned'), keep.planned);

  // Arşivlenen: mevcut arşiv durumu; tek geçmiş kaydı (sistem), yükleme günü notta; "Yüklendi" yazılmadı, fiili gün boş
  const loaded = await db.order.findUniqueOrThrow({ where: { id: O.loaded.id } });
  assert.deepEqual([loaded.actualShipDate, loaded.estimatedShipDate.toISOString().slice(0, 10), loaded.version, loaded.onHold, loaded.removedAt], [null, DUE, O.loaded.version + 1, false, null]);
  assert.deepEqual(await autoEvents('loaded'), [['AUTO_ARCHIVED', 'URETIMDE', 'ARSIVLENDI', null, dmy(DUE)]]);
  assert.equal(await snapshot('loaded'), keep.loaded, 'teklif, fiyat, sandık, yükleme onayı, aktarım, FGO belgesi ve faturalama kaydı değişmez');
  assert.equal(await snapshot('autoLoaded'), keep.autoLoaded);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: O.loaded.id } });
  assert.deepEqual(
    [audit.userId, audit.actorRole, audit.details.action, audit.details.events, audit.details.from, audit.details.to, audit.details.auto, audit.details.via, audit.details.loadingDay, audit.details.today],
    [null, 'SYSTEM', 'auto_archive', ['AUTO_ARCHIVED'], 'URETIMDE', 'ARSIVLENDI', true, 'CONFIRMED', DUE, '2026-09-15'],
  );
  const shippedAudit = (await db.auditLog.findMany({ where: { action: 'ORDER_TRANSITION', entityId: O.shipped.id } })).find((a) => a.details.action === 'auto_archive');
  assert.equal(shippedAudit, undefined, 'onaysız "Yüklendi" arşivlenmedi');
  assert.ok(!(await events('shipped')).some((e) => e.event === 'AUTO_ARCHIVED'));
  assert.deepEqual((await autoEvents('autoLoaded')).map((e) => e[0]), ['AUTO_SHIPPED', 'AUTO_SHIP_REVERTED', 'AUTO_ARCHIVED']);
  // Denetim: geri alma başına ve arşiv başına bir kayıt
  assert.equal(await db.auditLog.count(), audits + 2 + 2);

  // Fatura / belge / bildirim yok: FGO belgeleri aynı, yeni FGO işi yok; kuyruk olayları hiçbir bildirim kuralına girmez
  assert.deepEqual(await db.fgoDocument.findMany({ orderBy: { id: 'asc' } }), docs);
  assert.equal(await db.notificationOutbox.count({ where: { type: { startsWith: 'FGO' } } }), outboxJobs);
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: O.loaded.id }, orderBy: { createdAt: 'asc' } })).map((x) => x.type), ['ORDER_AUTO_ARCHIVED']);
  const autoRows = await db.notificationOutbox.findMany({ where: { type: { in: ['ORDER_AUTO_ARCHIVED', 'ORDER_AUTO_SHIP_REVERTED', 'ORDER_AUTO_SHIPPED'] } } });
  assert.equal(autoRows.length, 2 + 2 + 3);
  await n.dispatchInApp(db);
  assert.equal(await db.notification.count({ where: { dedupeKey: { in: autoRows.map((r) => `outbox:${r.id}`) } } }), 0, 'hiçbir kullanıcıya bildirim yok');
  assert.equal(await db.notification.count({ where: { orderId: { in: [O.loaded.id, O.autoLoaded.id, O.auto.id] } } }), 0);

  // Müşteri geçmişi: 3.51.0'ın yanlış "Yüklendi" satırı ve geri alma görünmez; arşiv "Arşivlendi" olarak görünür
  const custView = async (k) => eventsFor('MUSTERI', await events(k)).map((e) => e.event);
  assert.deepEqual(await custView('auto'), []);
  assert.deepEqual(await custView('autoLoaded'), ['AUTO_ARCHIVED']);
  // Sipariş her rolün kapsamında kalır (yalnızca sekmesi değişir)
  for (const u of [U.admin, U.sales, U.custA]) assert.equal(await db.order.count({ where: { id: O.loaded.id, ...orderScope({ appRole: u.appRole, customerId: u.customerId }) } }), 1, u.appRole);

  // Yinelenen tur hiçbir şeyi çoğaltmaz
  assert.deepEqual(await repairAutoShipped(db), { reverted: 0, skipped: 0 });
  assert.deepEqual(await autoArchiveOrders(db, { now: NOW }), { archived: 0, skipped: 0 });
  assert.equal(await db.auditLog.count(), audits + 4);
  assert.equal((await autoEvents('loaded')).length, 1);
}));

dbTest('son yükleme günü sayılır: 44. gündeki sipariş ertesi gün, aktarımla tamamlanan sipariş son yüklemeden 45 gün sonra arşivlenir', offline(async () => {
  assert.deepEqual(await autoArchiveOrders(db, { now: NEXT_DAY }), { archived: 1, skipped: 0 });
  assert.deepEqual(await statuses('edge', 'chain'), { edge: 'ARSIVLENDI', chain: 'URETIMDE' });
  // chain: ilk yükleme 02.06, kalan 10.08'de yüklendi → 24.09'da (10.08 + 45) arşivlenir, bir gün önce değil
  assert.deepEqual(await autoArchiveOrders(db, { now: new Date('2026-09-23T10:00:00Z') }), { archived: 0, skipped: 0 });
  assert.deepEqual(await autoArchiveOrders(db, { now: new Date('2026-09-24T10:00:00Z') }), { archived: 1, skipped: 0 });
  const audit = (await db.auditLog.findMany({ where: { action: 'ORDER_TRANSITION', entityId: O.chain.id } })).find((a) => a.details.action === 'auto_archive');
  assert.deepEqual([audit.details.via, audit.details.loadingDay], ['CONFIRMED', LATER]);
  // Onaylı yükleme (8 yüklendi / 2 yüklenmedi → aktarım → 2 yüklendi) olduğu gibi durur
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId: O.chain.id }, orderBy: [{ status: 'asc' }, { quantity: 'asc' }] });
  assert.deepEqual(items.map((i) => [i.status, i.quantity, !!i.replanId]), [['LOADED', 2, true], ['LOADED', 8, false], ['NOT_LOADED', 2, false]]);
}));

dbTest('açık kalan kapanınca sipariş arşive geçer: aktarımdan vazgeçmek kalanı açar; kalanın yerine açılan (uygulanmış) telafi kapatır', offline(async () => {
  // active: aktarımdan vazgeçildi → kalan yeniden açık → yine üretimde
  const replan = await db.loadingReplan.findFirstOrThrow({ where: { orderId: O.active.id, status: 'ACTIVE' } });
  assert.deepEqual(await rp.cancelReplan(db, { replanId: replan.id, actor: act(U.admin) }), { ok: true });
  assert.deepEqual(await autoArchiveOrders(db, { now: NOW }), { archived: 0, skipped: 0 });
  assert.equal(await status('active'), 'URETIMDE');
  // partial: yüklenmeyen 2 camın yerine telafi camı açılır (bedelsiz, yeni telafi siparişi; kaynak yüklendiği için ek üretim)
  const item = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: O.partial.id, status: 'NOT_LOADED' } });
  const r = await comp.createCompensation(db, {
    orderId: O.partial.id, lineId: O.partial.offers[0].lines[0].id, quantity: 2, mode: 'FREE', dest: { type: 'NEW', day: FUTURE },
    notLoadedItemId: item.id, requestKey: `arsiv-telafi-${'x'.repeat(16)}`, confirm: true, actor: act(U.sales),
  });
  assert.equal(r.ok, true, r.code);
  assert.deepEqual([r.status, r.source.reduced, r.source.reason], ['APPLIED', false, 'LOADED']);
  assert.deepEqual(await autoArchiveOrders(db, { now: NOW }), { archived: 1, skipped: 0 });
  assert.equal(await status('partial'), 'ARSIVLENDI');
  // Telafi siparişi kendi akışındadır (yükleme onayı yok): arşivlenmez
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: r.destOrderId } })).status, 'URETIMDE');
}));

dbTest('işlemler yalnızca işçiye açık; işçi de kanıtsız ya da süresi dolmamış siparişi arşivleyemez; eşzamanlı iki tur tek geçiş yazar', offline(async () => {
  for (const u of [U.admin, U.sales, U.drawer, U.custA]) {
    for (const action of ['auto_archive', 'auto_ship_revert']) {
      await assert.rejects(runOrderAction(db, { orderId: O.changed.id, action, actor: act(u) }), /NOT_ALLOWED|NOT_FOUND/, `${u.appRole} ${action}`);
      // Kullanıcı isteği işçi işaretlerini taşısa bile işçi sayılmaz: kimlik bilgisi sunucuda kurulur (lib/actor.ts)
      await assert.rejects(runOrderAction(db, { orderId: O.changed.id, action, actor: { ...act(u), autoArchive: true } }), /NOT_ALLOWED|NOT_FOUND/, `${u.appRole} ${action}`);
    }
    // 3.51.0'ın tarih kuralı işlemi kaldırıldı (bilinmeyen işlem eşzamanlı reddedilir)
    await assert.rejects(async () => runOrderAction(db, { orderId: O.changed.id, action: 'auto_shipped', actor: { ...act(u), system: true, autoShip: true } }), /UNKNOWN_ACTION/);
  }
  // İşçi: kanıt işlemin içinde yeniden denetlenir (aday seçimi atlansa da)
  await assert.rejects(runOrderAction(db, { orderId: O.planned.id, action: 'auto_archive', actor: ARCHIVE_ACTOR, payload: { today: '2026-09-15' } }), /NOT_LOADED/);
  await assert.rejects(runOrderAction(db, { orderId: O.changed.id, action: 'auto_archive', actor: ARCHIVE_ACTOR, payload: { today: '2026-09-15' } }), /NOT_LOADED/);
  await assert.rejects(runOrderAction(db, { orderId: O.hold.id, action: 'auto_archive', actor: ARCHIVE_ACTOR, payload: { today: '2026-09-15' } }), /NOT_ALLOWED/);
  await assert.rejects(runOrderAction(db, { orderId: O.planned.id, action: 'auto_ship_revert', actor: ARCHIVE_ACTOR }), /NOT_ALLOWED/, 'üretimdeki sipariş geri alınacak bir şey taşımaz');
  // Yakın günde eksiksiz yüklenen sipariş: işçi ileri bir "bugün" verse de gerçek günden ileri gidilmez (erken arşiv yok)
  const recentDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  await order('recent', recentDay);
  await confirm(recentDay);
  await assert.rejects(runOrderAction(db, { orderId: O.recent.id, action: 'auto_archive', actor: ARCHIVE_ACTOR, payload: { today: '2099-01-01' } }), /NOT_DUE/);
  assert.deepEqual(await statuses('planned', 'changed', 'hold', 'recent'), { planned: 'URETIMDE', changed: 'URETIMDE', hold: 'URETIMDE', recent: 'URETIMDE' });

  // Eşzamanlı iki tur: sipariş bir kez arşivlenir (iyimser kilit / durum denetimi), tek geçmiş ve denetim kaydı
  await order('race', '2026-06-10');
  await confirm('2026-06-10');
  const audits = await db.auditLog.count();
  const runs = await Promise.all([autoArchiveOrders(db, { now: NOW }), autoArchiveOrders(db, { now: NOW })]);
  assert.equal(runs[0].archived + runs[1].archived, 1);
  assert.equal(await status('race'), 'ARSIVLENDI');
  assert.deepEqual((await autoEvents('race')).map((e) => e[0]), ['AUTO_ARCHIVED']);
  assert.equal(await db.auditLog.count(), audits + 1);
}));
