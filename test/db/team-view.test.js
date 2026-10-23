// Satış ekibinin ortak GÖRÜNTÜLEMESİ (4.3.17, karar 301) — veritabanıyla. Murat ve Hamza aynı (etkin) çizimciye bağlı:
// birbirinin siparişini, dosyasını, çizim dosyasını, sandığını ve nakliye bölümünü GÖRÜR; hiçbir işlemi, notu, telafiyi,
// sandık kaydını, okundu işaretini yazamaz. Başka çizimciye bağlı, çizimcisi olmayan ve çizimcisi pasif satışçı yalnızca
// kendi siparişlerini görür. Hiçbir dış servise gidilmez (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { ORDER_ACTIONS, runOrderAction } from '../../server/orders/transitions.js';
import { orderScope, orderViewScope } from '../../server/orders/scope.js';
import { loadSalesTeam } from '../../server/orders/sales-team.js';
import { addNote } from '../../server/notes/translation.js';
import { markNotesRead, unreadCounts, unreadTotal } from '../../server/notes/unread.js';
import { markOrderSeen, orderAlertCounts } from '../../server/notifications/order-alerts.js';
import { findDrawingFile } from '../../server/orders/drawing-access.js';
import { removeGuestCrate, saveDayCrates } from '../../server/loading/crates.js';
import { transportList } from '../../server/loading/transport.js';
import { createCompensation } from '../../server/orders/compensation.js';

let db, factory, firm, glass;
const U = {};
const O = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Oturumdaki kullanıcı nesnesi gibi: ekip her istekte okunur (lib/auth/session.ts) */
const viewer = async (k) => {
  const u = await db.user.findUniqueOrThrow({ where: { id: U[k].id } });
  return { ...u, salesTeam: await loadSalesTeam(db, u) };
};
const sees = async (k, orderId) => !!(await db.order.findFirst({ where: { id: orderId, ...orderViewScope(await viewer(k)) }, select: { id: true } }));
const owns = async (k, orderId) => !!(await db.order.findFirst({ where: { id: orderId, ...orderScope(U[k]) }, select: { id: true } }));
let fileNo = 0;
async function orderOf(owner, drawer, title) {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  const o = await createGlassOrder(db, {
    actor: act(U.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '8mm', glassNameRo: 'Sticlă 8', glassWeightKgM2: 20, camAdedi: 1 }],
    files: [{ storageKey: `2026/10/tv-${fileNo}.pdf`, name: `tv-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: `c${fileNo}`, scanStatus: 'CLEAN' }],
  });
  return db.order.update({
    where: { id: o.id },
    data: { salesUserId: U[owner].id, assignedDrawerId: drawer ? U[drawer].id : null, salesAssignedVia: 'MANUAL', estimatedShipDate: new Date(`${dayOf(10)}T00:00:00Z`) },
  });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db, { singleTeam: false });
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-tv.test' } });
  glass = await db.glassProduct.create({ data: { nameTr: '8mm', colorTr: '', nameRo: 'Sticlă 8', colorRo: '', weightKgM2: 20 } });
  const mk = async (k, appRole, extra = {}) => {
    U[k] = await db.user.create({ data: { email: `${k}@tv.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId: appRole === 'MUSTERI' ? firm.id : factory.id, ...extra } });
  };
  await mk('admin', 'ADMIN');
  await mk('meltem', 'CIZIM');
  await mk('erhan', 'CIZIM');
  await mk('pasif', 'CIZIM', { isActive: false });
  await mk('murat', 'SATIS', { defaultDrawerId: U.meltem.id });
  await mk('hamza', 'SATIS', { defaultDrawerId: U.meltem.id });
  await mk('xavier', 'SATIS', { defaultDrawerId: U.erhan.id });
  await mk('nodraw', 'SATIS');
  await mk('pdraw', 'SATIS', { defaultDrawerId: U.pasif.id });
  await mk('olduser', 'SATIS', { defaultDrawerId: U.meltem.id, isActive: false });
  await mk('cust', 'MUSTERI', { canApprove: true });
  O.murat = await orderOf('murat', 'meltem', 'Murat siparişi');
  O.hamza = await orderOf('hamza', 'meltem', 'Hamza siparişi');
  O.xavier = await orderOf('xavier', 'erhan', 'Xavier siparişi');
  O.nodraw = await orderOf('nodraw', null, 'Çizimcisiz satışçı');
  O.pdraw = await orderOf('pdraw', 'pasif', 'Pasif çizimcili satışçı');
});
after(async () => { if (db) await closeDb(); });

dbTest('ekip: aynı geçerli çizimci → ortak görüntüleme; farklı / yok / pasif çizimci → yalnızca kendisi; pasif satışçı ekip değil', offline(async () => {
  assert.deepEqual((await viewer('murat')).salesTeam.sort(), [U.murat.id, U.hamza.id].sort());
  assert.deepEqual((await viewer('xavier')).salesTeam, [U.xavier.id]);
  assert.deepEqual((await viewer('nodraw')).salesTeam, [U.nodraw.id]);
  assert.deepEqual((await viewer('pdraw')).salesTeam, [U.pdraw.id]);
  assert.equal(await loadSalesTeam(db, U.admin), null, 'satış dışı rolde ekip yok');
  // Görüntüleme matrisi
  const matrix = {};
  for (const k of ['murat', 'hamza', 'xavier', 'nodraw', 'pdraw']) {
    matrix[k] = [];
    for (const o of ['murat', 'hamza', 'xavier', 'nodraw', 'pdraw']) if (await sees(k, O[o].id)) matrix[k].push(o);
  }
  assert.deepEqual(matrix, {
    murat: ['murat', 'hamza'], hamza: ['murat', 'hamza'], xavier: ['xavier'], nodraw: ['nodraw'], pdraw: ['pdraw'],
  });
  // Yazma kapsamı (sorumlu satışçı) ekipten etkilenmez
  assert.equal(await owns('murat', O.hamza.id), false);
  assert.equal(await owns('murat', O.murat.id), true);
}));

dbTest('ekip arkadaşının siparişi: GÖRÜR ama hiçbir iş akışı işlemini yapamaz (her işlem NOT_FOUND)', offline(async () => {
  const before = await db.order.findUniqueOrThrow({ where: { id: O.hamza.id } });
  const actions = ORDER_ACTIONS.filter((a) => !a.startsWith('auto_'));
  assert.ok(actions.length >= 30, 'işlem listesi');
  for (const action of actions) {
    const code = await codeOf(runOrderAction(db, { orderId: O.hamza.id, action, actor: act(U.murat), payload: { expectedVersion: before.version } }));
    assert.equal(code, 'NOT_FOUND', `${action} ekip arkadaşının siparişinde reddedilmeli`);
  }
  const afterRow = await db.order.findUniqueOrThrow({ where: { id: O.hamza.id } });
  assert.deepEqual([afterRow.version, afterRow.status, afterRow.salesUserId, afterRow.estimatedShipDate?.toISOString()], [before.version, before.status, before.salesUserId, before.estimatedShipDate?.toISOString()]);
  assert.equal(await db.orderEvent.count({ where: { orderId: O.hamza.id, userId: U.murat.id } }), 0);
  // Kendi siparişinde aynı aktörün işlemi çalışır (yetki kaybı yok)
  assert.equal(await codeOf(runOrderAction(db, { orderId: O.murat.id, action: 'no_drawing', actor: act(U.murat), payload: {} })), 'OK');
}));

dbTest('ekip arkadaşının siparişi: not, telafi, sandık kaydı, misafir sandık, okundu işareti yazılamaz; sayaçlar kendi siparişleriyle sınırlı', offline(async () => {
  assert.equal((await addNote(db, { orderId: O.hamza.id, actor: act(U.murat), text: 'yazamam' })).code, 'NOT_FOUND');
  assert.equal((await addNote(db, { orderId: O.hamza.id, actor: act(U.murat), text: 'iç not', internal: true })).code, 'NOT_FOUND');
  assert.equal(await db.orderNote.count({ where: { orderId: O.hamza.id } }), 0);
  const comp = await createCompensation(db, { orderId: O.hamza.id, lineId: 'x'.repeat(25), quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: dayOf(20) }, requestKey: `tv-${'k'.repeat(20)}`, confirm: true, actor: act(U.murat) });
  assert.deepEqual([comp.ok, comp.code], [false, 'NOT_FOUND']);
  // Sandık: başka satışçının bölümüne kayıt yok
  const day = dayOf(10);
  const row = { crateNo: 7, lengthMm: 1000, widthMm: 500, heightMm: 800, netKg: 100, grossKg: 150, note: null, orderIds: [] };
  assert.deepEqual(await saveDayCrates(db, { day, customerId: firm.id, rows: [row], actor: act(U.murat), links: 'auto', team: U.hamza.id }), { ok: false, code: 'TEAM_FORBIDDEN' });
  const own = await saveDayCrates(db, { day, customerId: firm.id, rows: [row], actor: act(U.hamza), links: 'auto' });
  assert.ok(own.ok, JSON.stringify(own));
  const crate = await db.crate.findFirstOrThrow({ where: { crateNo: 7 } });
  assert.equal(crate.salesUserId, U.hamza.id);
  assert.equal((await removeGuestCrate(db, { orderId: O.hamza.id, crateId: crate.id, actor: act(U.murat) })).ok, false);
  // Hamza'nın siparişine mesaj (müşteriden) → Murat'ın sayaçlarına girmez, Murat okundu yazamaz
  await addNote(db, { orderId: O.hamza.id, actor: act(U.cust), text: 'müşteri mesajı', requestKey: `tv-note-${'n'.repeat(16)}` });
  const mv = await viewer('murat');
  assert.equal((await unreadCounts(db, mv, [O.hamza.id, O.murat.id])).get(O.hamza.id) ?? 0, 0);
  assert.equal(await unreadTotal(db, mv), 0);
  assert.equal((await orderAlertCounts(db, mv, [O.hamza.id])).get(O.hamza.id) ?? 0, 0);
  assert.deepEqual(await markNotesRead(db, { user: mv, orderId: O.hamza.id }), { ok: false, code: 'NOT_FOUND' });
  assert.equal((await markOrderSeen(db, { user: mv, orderId: O.hamza.id })).ok, false);
  assert.equal(await db.orderNoteRead.count({ where: { userId: U.murat.id } }), 0);
  // Hamza'nın kendi sayacı çalışır
  assert.equal((await unreadCounts(db, await viewer('hamza'), [O.hamza.id])).get(O.hamza.id), 1);
}));

dbTest('görüntüleme: dosya ve çizim dosyası ekip kapsamıyla bulunur, yazma kapsamıyla bulunmaz; farklı çizimci ekibi bulamaz', offline(async () => {
  const d = await db.drawing.create({ data: { orderId: O.hamza.id, version: 1, status: 'ONAY_BEKLIYOR', uploadedById: U.meltem.id, sentAt: new Date() } });
  const f = await db.drawingFile.create({ data: { drawingId: d.id, storageKey: '2026/10/tv-d.pdf', name: 'cizim.pdf', size: 10, mime: 'application/pdf', checksum: 'd1', scanStatus: 'CLEAN', uploadedById: U.meltem.id } });
  const mv = await viewer('murat');
  assert.ok(await findDrawingFile(db, { id: f.id, scope: orderViewScope(mv), role: 'SATIS' }), 'ekip arkadaşı çizim dosyasını görür');
  assert.equal(await findDrawingFile(db, { id: f.id, scope: orderScope(mv), role: 'SATIS' }), null, 'yazma kapsamı açmaz');
  assert.equal(await findDrawingFile(db, { id: f.id, scope: orderViewScope(await viewer('xavier')), role: 'SATIS' }), null, 'başka çizimci ekibi açamaz');
  const file = await db.orderFile.findFirstOrThrow({ where: { orderId: O.hamza.id } });
  assert.ok(await db.orderFile.findFirst({ where: { id: file.id, order: orderViewScope(mv) } }));
  assert.equal(await db.orderFile.findFirst({ where: { id: file.id, order: orderViewScope(await viewer('nodraw')) } }), null);
}));

dbTest('nakliye: ekip bölümleri görünür (her satışçı ayrı bölüm), başka ekip yok; "Sıra bende" yalnızca kendi siparişleri', offline(async () => {
  const day = dayOf(10);
  const list = await transportList(db, day, { salesUserId: (await viewer('murat')).salesTeam, teamName: (id) => id ?? '-' });
  const teams = list.sections.map((s) => s.team).sort();
  assert.ok(teams.every((t) => [U.murat.id, U.hamza.id].includes(t)), JSON.stringify(teams));
  assert.ok(teams.includes(U.hamza.id), 'ekip arkadaşının sandık bölümü listede');
  const other = await transportList(db, day, { salesUserId: (await viewer('xavier')).salesTeam, teamName: (id) => id ?? '-' });
  assert.ok(other.sections.every((s) => s.team === U.xavier.id));
  // Görev listesi: Murat'ın kuyrukları yalnızca orderScope satırlarından kurulur (sayfa: view === 'work' → orderScope)
  const rows = await db.order.findMany({ where: { ...orderScope(U.murat) }, select: { salesUserId: true } });
  assert.ok(rows.length > 0 && rows.every((r) => r.salesUserId === U.murat.id));
}));

dbTest('varsayılan çizimci değişince ekip bir sonraki istekte değişir; çizimci pasifleşince ortak görüntüleme kapanır', offline(async () => {
  await db.user.update({ where: { id: U.hamza.id }, data: { defaultDrawerId: U.erhan.id } });
  assert.equal(await sees('murat', O.hamza.id), false);
  assert.equal(await sees('xavier', O.hamza.id), true, 'Hamza artık Erhan ekibinde');
  await db.user.update({ where: { id: U.hamza.id }, data: { defaultDrawerId: U.meltem.id } });
  assert.equal(await sees('murat', O.hamza.id), true);
  await db.user.update({ where: { id: U.meltem.id }, data: { isActive: false } });
  assert.equal(await sees('murat', O.hamza.id), false);
  assert.equal(await sees('murat', O.murat.id), true, 'kendi siparişi her zaman');
  await db.user.update({ where: { id: U.meltem.id }, data: { isActive: true } });
}));

dbTest('D-3 çizimci değiştirme: yalnızca yönetici; çizim sürümleri, dosyaları ve müşteri onayları değişmez; eski çizimcinin erişimi kapanır, yeni çizimci görür ve bildirim alır', offline(async () => {
  const o = await orderOf('murat', 'meltem', 'Çizimci değişimi');
  await db.order.update({ where: { id: o.id }, data: { status: 'HAZIRLANIYOR', drawingTrack: 'ONAYLANDI' } });
  const v1 = await db.drawing.create({ data: { orderId: o.id, version: 1, status: 'ONAYLANDI', uploadedById: U.meltem.id, sentAt: new Date(), decidedAt: new Date(), decidedById: U.cust.id } });
  await db.drawingFile.create({ data: { drawingId: v1.id, storageKey: '2026/10/tv-v1.pdf', name: 'v1.pdf', size: 10, mime: 'application/pdf', checksum: 'v1', scanStatus: 'CLEAN', uploadedById: U.meltem.id } });
  await db.drawingRevision.create({ data: { drawingId: v1.id, comment: '1. kenar', requestedById: U.cust.id } });
  const v2 = await db.drawing.create({ data: { orderId: o.id, version: 2, status: 'TASLAK', uploadedById: U.meltem.id } });
  const snapshot = async () => JSON.stringify(await db.drawing.findMany({ where: { orderId: o.id }, orderBy: { version: 'asc' }, include: { files: true, revisions: true } }));
  const drawingsBefore = await snapshot();
  const v = async () => (await db.order.findUniqueOrThrow({ where: { id: o.id } })).version;

  // Satış, çizimci ve denetimci değiştiremez
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.murat), payload: { drawerId: U.erhan.id, expectedVersion: await v() } })), 'NOT_ALLOWED');
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.meltem), payload: { drawerId: U.erhan.id, expectedVersion: await v() } })), 'NOT_ALLOWED');
  // Geçersiz hedef / aynı çizimci
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.admin), payload: { drawerId: U.pasif.id, expectedVersion: await v() } })), 'DRAWER_TARGET');
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.admin), payload: { drawerId: U.murat.id, expectedVersion: await v() } })), 'DRAWER_TARGET');
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.admin), payload: { drawerId: U.meltem.id, expectedVersion: await v() } })), 'DRAWER_SAME');
  // Eski sürümle (başkası arada değiştirdi) → CONFLICT
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.admin), payload: { drawerId: U.erhan.id, expectedVersion: (await v()) - 1 } })), 'CONFLICT');

  const res = await runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.admin), payload: { drawerId: U.erhan.id, reason: 'izin', expectedVersion: await v() } });
  assert.ok(res);
  const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([after.assignedDrawerId, after.salesUserId, after.status, after.drawingTrack], [U.erhan.id, U.murat.id, 'HAZIRLANIYOR', 'ONAYLANDI']);
  assert.equal(await snapshot(), drawingsBefore, 'sürümler, dosyalar, onay / revizyon kayıtları değişmedi');
  assert.equal(await db.drawing.count({ where: { id: v2.id, status: 'TASLAK' } }), 1, 'taslak korunur');
  // Erişim: eski çizimci göremez, yeni çizimci görür; satışçının varsayılan çizimcisi değişmez
  assert.equal(!!(await db.order.findFirst({ where: { id: o.id, ...orderScope(U.meltem) } })), false);
  assert.equal(!!(await db.order.findFirst({ where: { id: o.id, ...orderScope(U.erhan) } })), true);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: U.murat.id } })).defaultDrawerId, U.meltem.id);
  // Geçmiş, denetim ve bildirim
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'DRAWER_ASSIGNED', userId: U.admin.id } }), 1);
  const audit = await db.auditLog.findFirst({ where: { entityId: o.id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'assign_drawer' } } });
  assert.ok(audit, 'denetim kaydı');
  assert.deepEqual([audit.details.drawerFrom, audit.details.drawerTo, audit.details.reason, audit.details.drawings, audit.details.drafts, audit.details.approved], [U.meltem.id, U.erhan.id, 'izin', 2, 1, 1]);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'ORDER_DRAWER_ASSIGNED' } }), 1);
  // Kapanmış siparişte değiştirilemez
  await db.order.update({ where: { id: o.id }, data: { status: 'ARSIVLENDI' } });
  assert.equal(await codeOf(runOrderAction(db, { orderId: o.id, action: 'assign_drawer', actor: act(U.admin), payload: { drawerId: U.meltem.id, expectedVersion: await v() } })), 'NOT_ALLOWED');
}));
