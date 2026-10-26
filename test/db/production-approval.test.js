// Müşteri üretim onayı (4.2.1) — veritabanıyla: ayar kapalıyken eski davranış, eski siparişler, onaysız üretime geçmeme,
// onay sonrası olağan üretim kuralı, ölçü değişikliği → yeni sürüm → yeniden onay, eski sürümün onaylanamaması, yetkisiz /
// mükerrer / eşzamanlı onay, süre ve gecikme bildirimi (bir kez), yönetici + satışçı bildirimleri, proformanın onaydan
// önce de kesilebilmesi, mali kilit. FGO'ya GERÇEK istek yapılmaz (sahte fetchImpl; diğer her ağ isteği testi düşürür).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { approvalDeadline } from '../../server/orders/production-approval.js';
import { getApprovalSetting, remindApprovalOverdue, saveApprovalSetting } from '../../server/orders/production-approval-service.js';
import { dispatchInAppFor } from '../../server/notifications/inapp.js';
import { saveFgoSettings } from '../../server/integrations/fgo.js';
import { saveDailyRate } from '../../server/fx/bt.js';
import { writeAudit } from '../../server/orders/journal.js';
import { localDay } from '../../server/profile/dates.js';
import { billingState, dispatchGlassJobs, requestGlassDocument } from '../../server/glass/billing.js';

const SECRET = 'p'.repeat(40);
let db;
let firm;
let other;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
let fileNo = 0;
const newOrder = async (title, f = firm, who = 'cust') => {
  const next = await suggestNextNo(db, f.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: actor(people[who]), firm: f, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/pa-${fileNo}.pdf`, name: `pa-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false, ...extra });
const versions = (orderId) => db.offer.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const latest = async (orderId) => (await versions(orderId)).at(-1);
const form = (l, extra = {}) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), ...extra,
});
const adminForm = (lines, price = '50') => lines.map((l) => form(l, { crateFee: l.crateFee, offerPrice: price }));
const orderOf = (id) => db.order.findUnique({ where: { id } });
/** Satış teklifi hazırlar → yönetici fiyatlar ve müşteriye gönderir. Dönen: gönderilen sürüm */
async function sendOffer(orderId, { drawing = false } = {}) {
  await run(orderId, drawing ? 'send_to_drawing' : 'no_drawing', 'sales');
  await run(orderId, 'submit_offer', 'sales', { lines: [glass()] });
  const draft = await latest(orderId);
  await run(orderId, 'approve_offer', 'admin', { lines: adminForm(draft.lines) });
  return latest(orderId);
}
const setApproval = (enabled) => saveApprovalSetting(db, { enabled, actor: actor(people.admin) });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-pa.test', taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1' } });
  other = await db.customer.create({ data: { name: 'Alegrad', prefix: 'ALE', email: 'office@ale-pa.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@pa.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('sales2', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('custNoRight', 'MUSTERI', firm.id, { canApprove: false });
  await mk('otherCust', 'MUSTERI', other.id, { canApprove: true });
});
after(closeDb);

dbTest('ayar: yalnızca SETTINGS_MANAGE değiştirir; denetim kaydı; varsayılan kapalı', offline(async () => {
  assert.deepEqual((await getApprovalSetting(db)).enabled, false);
  for (const who of ['sales', 'drawer', 'inspector', 'cust', 'assistant']) {
    assert.deepEqual(await saveApprovalSetting(db, { enabled: true, actor: actor(people[who]) }), { ok: false, code: 'FORBIDDEN' }, who);
  }
  assert.equal((await getApprovalSetting(db)).enabled, false);
  assert.deepEqual(await setApproval(true), { ok: true, changed: true });
  assert.deepEqual(await setApproval(true), { ok: true, changed: false });
  assert.deepEqual(await setApproval(false), { ok: true, changed: true });
  const logs = await db.auditLog.findMany({ where: { action: 'PRODUCTION_APPROVAL_SETTING' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(logs.map((l) => [l.details.before, l.details.after, l.userId]), [[false, true, people.admin.id], [true, false, people.admin.id]]);
}));

dbTest('ayar kapalı: davranış değişmez — teklif müşteriye gidince üretime geçer, onay alanı yazılmaz, müşteri onay işlemi yapamaz', offline(async () => {
  await setApproval(false);
  const o = await newOrder('Kapalı');
  assert.equal((await orderOf(o.id)).productionApprovalRequired, false);
  const sent = await sendOffer(o.id);
  assert.equal(sent.approvalDueAt, null);
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: sent.id })), 'NOT_ALLOWED');
  const ev = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_SENT' } });
  assert.equal(ev.payload.approval, undefined);
}));

dbTest('eski siparişler: ayar açıldıktan sonra da onay istemez; ayar kapatılınca kapsamdaki sipariş onay istemeye devam eder', offline(async () => {
  await setApproval(false);
  const old = await newOrder('Eski');
  await setApproval(true);
  const flagged = await newOrder('Yeni');
  await setApproval(false);
  assert.equal((await orderOf(old.id)).productionApprovalRequired, false);
  assert.equal((await orderOf(flagged.id)).productionApprovalRequired, true);
  await sendOffer(old.id);
  assert.equal((await orderOf(old.id)).status, 'URETIMDE', 'eski sipariş eski kuralla');
  await sendOffer(flagged.id);
  assert.equal((await orderOf(flagged.id)).status, 'HAZIRLANIYOR', 'kapsamdaki sipariş onay bekler');
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_CREATE', entityId: flagged.id } });
  assert.equal(audit.details.productionApproval, true);
}));

dbTest('onaysız üretime geçmez; onay → olağan kural (üretim), kayıt: zaman, kullanıcı, sürüm; geçmiş + denetim; mükerrer onay engellenir', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Onay');
  const sent = await sendOffer(o.id);
  let order = await orderOf(o.id);
  assert.equal(order.status, 'HAZIRLANIYOR');
  assert.equal(order.drawingTrack, 'YOK');
  // Son tarih: gönderim anından 2 Romanya iş günü (tek kural)
  assert.equal(sent.approvalDueAt.toISOString(), approvalDeadline(sent.sentAt).due.toISOString());
  const ev = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_SENT' } });
  assert.equal(ev.payload.approval.due, sent.approvalDueAt.toISOString());
  assert.ok(['ro', 'tr'].includes(ev.payload.lang));
  const shipBefore = order.estimatedShipDate?.toISOString();

  // Yetkisiz: iç roller, onay yetkisi olmayan müşteri kullanıcısı, başka firmanın müşterisi
  for (const who of ['admin', 'assistant', 'sales', 'inspector']) assert.equal(await codeOf(run(o.id, 'approve_production', who, { offerId: sent.id })), 'NOT_ALLOWED', who);
  assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(o.id, 'approve_production', 'drawer', { offerId: sent.id }))));
  assert.equal(await codeOf(run(o.id, 'approve_production', 'custNoRight', { offerId: sent.id })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'approve_production', 'otherCust', { offerId: sent.id })), 'NOT_FOUND');
  // Ekranda görülen sürüm değil / sipariş sürümü eski
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: 'baska' })), 'STALE_OFFER');
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: sent.id, expectedVersion: order.version - 1 })), 'CONFLICT');
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');

  const res = await run(o.id, 'approve_production', 'cust', { offerId: sent.id, expectedVersion: order.version });
  order = await orderOf(o.id);
  assert.equal(order.status, 'URETIMDE', 'diğer koşullar tamam → otomatik üretim');
  assert.equal(res.result.produced, true);
  assert.equal(order.estimatedShipDate?.toISOString(), shipBefore, 'yükleme tarihi değişmez');
  const after = await db.offer.findUnique({ where: { id: sent.id } });
  assert.equal(after.approvedById, people.cust.id);
  assert.ok(after.approvedAt instanceof Date);
  const events = (await db.orderEvent.findMany({ where: { orderId: o.id } })).map((e) => e.event);
  assert.ok(events.includes('PRODUCTION_APPROVED') && events.includes('PRODUCTION'), events.join(','));
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'approve_production' } } });
  assert.ok(audit, 'denetim kaydı');
  const d = audit.details.audit ?? audit.details;
  assert.equal(JSON.stringify(d).includes(sent.id), true);
  assert.equal(JSON.stringify(d).includes(people.cust.id), true);
  assert.equal(JSON.stringify(d).includes(firm.id), true);
  // Mükerrer onay (sipariş artık üretimde)
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: sent.id })), 'NOT_ALLOWED');
  assert.equal((await db.orderEvent.count({ where: { orderId: o.id, event: 'PRODUCTION_APPROVED' } })), 1);

  // Yönetici + siparişin satışçısı bilgilendirilir (uygulama içi); müşteriye kendi işlemi bildirilmez
  const row = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_PRODUCTION_APPROVED' } });
  await dispatchInAppFor(db, [row.id]);
  const notified = (await db.notification.findMany({ where: { dedupeKey: `outbox:${row.id}` } })).map((n) => n.userId).sort();
  assert.deepEqual(notified, [people.admin.id, people.assistant.id, people.sales.id].sort());
  // Müşterinin "teklif gönderildi" bildirimi onay bilgisini taşır
  await dispatchInAppFor(db, [ev.id]);
  const custN = await db.notification.findFirst({ where: { userId: people.cust.id, dedupeKey: `outbox:${ev.id}` } });
  assert.equal(custN.params.approval, 1);
  assert.match(custN.params.due, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
}));

dbTest('eşzamanlı iki onay: yalnızca biri yazılır', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Eşzamanlı');
  const sent = await sendOffer(o.id, { drawing: true });
  // Çizim sürüyor: onay üretime geçirmez (sipariş HAZIRLANIYOR kalır, iki onay da aynı durumda yarışır)
  const results = await Promise.all([1, 2].map(() => codeOf(run(o.id, 'approve_production', 'cust', { offerId: sent.id }))));
  assert.deepEqual(results.filter((r) => r === 'OK').length, 1, results.join(','));
  assert.ok(results.every((r) => ['OK', 'CONFLICT', 'APPROVAL_DECIDED', 'NOT_ALLOWED'].includes(r)), results.join(','));
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'PRODUCTION_APPROVED' } }), 1);
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR', 'çizim onaylanmadan üretime geçmez');
  // Çizim tamamlanınca (olağan kural) — onay zaten var → üretim
  await db.order.update({ where: { id: o.id }, data: { drawingTrack: 'ONAYLANDI' } });
  await run(o.id, 'hold', 'sales');
  await run(o.id, 'unhold', 'sales');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
}));

dbTest('çizim önce onaylanır, müşteri onayı yoksa üretime geçmez; onay gelince geçer', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Çizim önce');
  const sent = await sendOffer(o.id, { drawing: true });
  await db.order.update({ where: { id: o.id }, data: { drawingTrack: 'ONAYLANDI' } });
  await run(o.id, 'hold', 'sales');
  await run(o.id, 'unhold', 'sales');
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR', 'müşteri onayı bekleniyor');
  await run(o.id, 'approve_production', 'cust', { offerId: sent.id });
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
}));

dbTest('ölçü değişikliği: açıklama zorunlu; sürüm korunur ve onaylanamaz; satışa yeni taslak; yönetici yeni sürümü gönderir; yeniden onay; yeni süre', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Değişiklik');
  const v1 = await sendOffer(o.id);
  assert.equal(await codeOf(run(o.id, 'request_offer_change', 'cust', { offerId: v1.id, note: '   ' })), 'CHANGE_NOTE_REQUIRED');
  assert.equal(await codeOf(run(o.id, 'request_offer_change', 'cust', { offerId: v1.id, note: 'x'.repeat(2001) })), 'CHANGE_NOTE_TOO_LONG');
  assert.equal(await codeOf(run(o.id, 'request_offer_change', 'custNoRight', { offerId: v1.id, note: 'a' })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'request_offer_change', 'sales', { offerId: v1.id, note: 'a' })), 'NOT_ALLOWED');
  await run(o.id, 'request_offer_change', 'cust', { offerId: v1.id, note: '2. satır 1200 × 800 olmalı' });
  const all = await versions(o.id);
  assert.equal(all.length, 2);
  const old = all[0];
  assert.equal(old.status, 'GONDERILDI', 'gönderilen sürüm değişmez');
  assert.equal(old.changeNote, '2. satır 1200 × 800 olmalı');
  assert.equal(old.changeRequestedById, people.cust.id);
  assert.equal(old.approvedAt, null);
  const draft = all[1];
  assert.equal(draft.status, 'HAZIRLANIYOR');
  assert.deepEqual(draft.lines.map((l) => [l.description, l.enMm, l.boyMm, l.adet, String(l.unitPrice)]), old.lines.map((l) => [l.description, l.enMm, l.boyMm, l.adet, String(l.unitPrice)]));
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');
  // Eski sürüm artık onaylanamaz; müşteri yeni bir karar veremez (yeni sürüm henüz gelmedi)
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: old.id })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'request_offer_change', 'cust', { offerId: old.id, note: 'tekrar' })), 'NOT_ALLOWED');
  // Olay: geçmişte müşterinin notuyla; yöneticiye + satışçıya bildirim
  const evRow = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_CHANGE_REQUESTED' } });
  await dispatchInAppFor(db, [evRow.id]);
  const notified = (await db.notification.findMany({ where: { dedupeKey: `outbox:${evRow.id}` } })).map((n) => n.userId).sort();
  assert.deepEqual(notified, [people.admin.id, people.assistant.id, people.sales.id].sort());
  const hist = await db.orderEvent.findFirst({ where: { orderId: o.id, event: 'OFFER_CHANGE_REQUESTED' } });
  assert.equal(hist.note, '2. satır 1200 × 800 olmalı');

  // Mevcut satış akışı: satış düzeltir ve yöneticiye gönderir — müşteriye doğrudan gidemez
  await run(o.id, 'save_offer', 'sales', { lines: draft.lines.map((l) => form(l, { enMm: 1200, boyMm: 800 })) });
  await run(o.id, 'submit_offer', 'sales', { lines: (await latest(o.id)).lines.map((l) => form(l)) });
  assert.equal((await latest(o.id)).status, 'YONETIMDE');
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');
  const pending = await latest(o.id);
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(pending.lines, '55') });
  const v2 = await latest(o.id);
  assert.equal(v2.status, 'GONDERILDI');
  assert.ok(v2.approvalDueAt instanceof Date, 'yeni sürüm için yeni süre');
  assert.equal(v2.approvalDueAt.toISOString(), approvalDeadline(v2.sentAt).due.toISOString());
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR', 'yeni sürüm yeniden onay bekler');
  // Eski sürüm onaylanamaz; yeni sürüm onaylanır
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: v1.id })), 'STALE_OFFER');
  await run(o.id, 'approve_production', 'cust', { offerId: v2.id });
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  assert.equal((await db.offer.findUnique({ where: { id: v1.id } })).approvedAt, null, 'eski sürüm onaysız kalır');
}));

dbTest('yöneticinin "teklifi güncelle"si hazırlıkta yeni sürüm açar → yeniden onay; eski sürüm onaylanamaz', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Güncelle');
  const v1 = await sendOffer(o.id, { drawing: true });
  await run(o.id, 'approve_production', 'cust', { offerId: v1.id });
  await run(o.id, 'update_offer', 'admin', { lines: adminForm(v1.lines, '60') });
  const v2 = await latest(o.id);
  assert.notEqual(v2.id, v1.id);
  assert.equal(v2.approvedAt, null);
  assert.ok(v2.approvalDueAt instanceof Date);
  const ev = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_UPDATED' } });
  assert.equal(ev.payload.approval.due, v2.approvalDueAt.toISOString());
  await db.order.update({ where: { id: o.id }, data: { drawingTrack: 'ONAYLANDI' } });
  await run(o.id, 'hold', 'sales');
  await run(o.id, 'unhold', 'sales');
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR', 'v2 onaylanmadı');
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: v1.id })), 'STALE_OFFER');
  await run(o.id, 'approve_production', 'cust', { offerId: v2.id });
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
}));

dbTest('süre dolunca yöneticiye BİR KEZ bildirim; müşteri onay hakkını kaybetmez; yükleme tarihi değişmez', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Gecikme');
  const sent = await sendOffer(o.id);
  const ship = (await orderOf(o.id)).estimatedShipDate?.toISOString();
  const now = new Date(sent.approvalDueAt.getTime() + 60_000);
  const mine = () => db.notification.findMany({ where: { type: 'PRODUCTION_APPROVAL_OVERDUE', orderId: o.id } });
  await remindApprovalOverdue(db, { now: new Date(sent.approvalDueAt.getTime() - 60_000) });
  assert.equal((await mine()).length, 0, 'süre dolmadan yok');
  assert.equal((await db.offer.findUnique({ where: { id: sent.id } })).approvalOverdueAt, null);
  await remindApprovalOverdue(db, { now });
  assert.equal((await mine()).length, 2, 'yönetici + yönetici yardımcısı');
  await remindApprovalOverdue(db, { now: new Date(now.getTime() + 3_600_000) });
  assert.equal((await mine()).length, 2, 'ikinci kez yok');
  const rows = await mine();
  assert.deepEqual(rows.map((r) => r.userId).sort(), [people.admin.id, people.assistant.id].sort());
  assert.ok((await db.offer.findUnique({ where: { id: sent.id } })).approvalOverdueAt instanceof Date);
  assert.equal((await orderOf(o.id)).estimatedShipDate?.toISOString(), ship);
  // Müşteri süre dolduktan sonra da onaylar
  await run(o.id, 'approve_production', 'cust', { offerId: sent.id });
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'approve_production' } } });
  assert.ok(JSON.stringify(audit.details).includes('"late":true'));
  // Onaylanmış siparişte yeniden bildirim yok
  await remindApprovalOverdue(db, { now: new Date(now.getTime() + 7_200_000) });
  assert.equal((await mine()).length, 2);
}));

dbTest('proforma onaydan ÖNCE de istenir ve kesilir; siparişi üretime geçirmez; onay yine gerekir; mali kayıt varken değişiklik talebi alınmaz', async () => {
  await setApproval(true);
  const o = await newOrder('Proforma');
  const sent = await sendOffer(o.id);
  await saveDailyRate(db, { day: localDay(new Date(), 'Europe/Bucharest'), rate: 5 }, actor(people.admin), writeAudit);
  await saveFgoSettings(db, {
    enabled: true, fxMode: 'manual', dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: 'https://bt.example',
  }, { key: 'K', secret: SECRET }, actor(people.admin));
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: true, fgoDocuments: true } });
  assert.deepEqual(billingState({ status: full.status, loaded: false, docs: full.fgoDocuments, hasOffer: true }).actions, ['proforma'], 'onay öncesi proforma açık');
  assert.deepEqual(await requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor(people.admin) }), { ok: true });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const f = Object.fromEntries(new URLSearchParams(init.body));
    calls.push(String(url));
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: '901', Serie: f.Serie, Link: `https://fgo.example/${f.Serie}901.pdf` } }));
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { throw new Error(`gerçek ağ isteği: ${u}`); };
  try {
    assert.deepEqual(await dispatchGlassJobs(db, { fetchImpl, secret: SECRET, appUrl: 'https://t', timeZone: 'Europe/Bucharest', sleep: async () => {}, onlyOrderId: o.id }), { done: 1, failed: 0 });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(calls.length, 1);
  assert.equal(await db.fgoDocument.count({ where: { orderId: o.id, kind: 'PROFORMA' } }), 1);
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR', 'proforma üretime geçirmez');
  // Mali kayıt (proforma) varken yeni fiyat müşteriye gidemez: değişiklik talebi alınmaz (mevcut mali kilit kuralı)
  const lock = await codeOf(run(o.id, 'request_offer_change', 'cust', { offerId: sent.id, note: 'ölçü' }));
  assert.equal(lock, 'PRICE_LOCKED');
  assert.equal((await db.offer.findUnique({ where: { id: sent.id } })).changeRequestedAt, null);
  // Onay proformadan bağımsız verilir
  await run(o.id, 'approve_production', 'cust', { offerId: sent.id });
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
});

dbTest('bayraklı siparişte değişiklik talebinden sonra proforma kesilirse yeni sürüm müşteriye gönderilemez (mali kilit)', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Talep sonrası belge');
  const v1 = await sendOffer(o.id);
  await run(o.id, 'request_offer_change', 'cust', { offerId: v1.id, note: 'ölçü' });
  const draft = await latest(o.id);
  await run(o.id, 'submit_offer', 'sales', { lines: draft.lines.map((l) => form(l)) });
  // Bu arada (talep sırasında) siparişin FGO proforması kesildi
  await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: '777', total: '100', issuedAt: new Date() } });
  const pending = await latest(o.id);
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'admin', { lines: adminForm(pending.lines) })), 'PRICE_LOCKED');
  assert.equal((await latest(o.id)).status, 'YONETIMDE', 'hiçbir şey yazılmadı');
}));

dbTest('bayraksız siparişte yöneticinin ilk gönderimi kilit almaz ve eskisi gibi çalışır (belge olsa da)', offline(async () => {
  await setApproval(false);
  const o = await newOrder('İlk gönderim');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: '778', total: '100', issuedAt: new Date() } });
  const draft = await latest(o.id);
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(draft.lines) });
  assert.equal((await latest(o.id)).status, 'GONDERILDI');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
}));
