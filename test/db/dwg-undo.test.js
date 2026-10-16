// DWG kararının güvenli geri alınması (3.90.0, karar 285) — veritabanıyla. İzole test verisi; gerçek SMTP / FGO / Google yok
// (bildirim yalnızca giden kuyruk satırı + uygulama içi dağıtım; testler ağ engeliyle çalışır).
//   Üretime almayı geri al · Çizim hatalı kararını geri al · Çizim güncellemesini geri al
//   - ters işlem: karar kaydı GERI_CEKILDI (silinmez), aynı dosyalar için yeni karar kaydı; dosyalar ve sürümler korunur
//   - engeller: üretimden sonra kayıtlı adım, müşterinin yanıtı, sonraki sürüm, yetki, tekrar, eşzamanlılık, rollback
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { createGlassOrder, suggestNextNo } = await import('../../server/orders/create.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { drawingFlags } = await import('../../server/orders/rules.js');
const { orderScope } = await import('../../server/orders/scope.js');
const { drawingsView } = await import('../../server/orders/drawing-access.js');
const { dwgReview, lastProductionDrawing } = await import('../../server/orders/dwg-review.js');
const { dwgUndoCheck } = await import('../../server/orders/dwg-undo.js');
const { priceLock } = await import('../../server/orders/financial-lock.js');
const n = await import('../../server/notifications/inapp.js');
const { NOTIFY_RULES } = await import('../../server/notifications/email.js');

let db, firm, other;
const P = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}, client = db) => runOrderAction(client, { orderId, action, actor: actor(P[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
let fileNo = 0;
const meta = (name, extra = {}) => ({ storageKey: `2026/10/undo-${++fileNo}`, name, size: 10, mime: 'application/octet-stream', checksum: `sum-u${fileNo}`, scanStatus: 'CLEAN', ...extra });
const pdf = (name) => meta(name, { mime: 'application/pdf' });
const ITEM = { glassName: '8mm Temperli', camAdedi: 1 };
const LINES = [{ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 1, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false }];

async function dwgOrder() {
  const next = await suggestNextNo(db, firm.id);
  const o = await createGlassOrder(db, { actor: actor(P.cust), firm, title: 'DWG geri al', requestedNo: next, suggestedNo: next, items: [ITEM], files: [meta('plan.dwg'), pdf('olcu.pdf')] });
  await run(o.id, 'send_to_drawing', 'sales');
  return o;
}
/** Teklif müşteride (satış hazırlar, yönetici fiyatlayıp gönderir) */
async function sendOffer(id) {
  await run(id, 'save_offer', 'sales', { lines: LINES });
  await run(id, 'submit_offer', 'sales', { lines: LINES });
  const saved = await db.offerLine.findMany({ where: { offer: { orderId: id } } });
  await run(id, 'approve_offer', 'admin', { lines: LINES.map((l, i) => ({ ...l, id: saved[i].id, offerPrice: '41.00' })) });
}
const orderOf = (id) => db.order.findUniqueOrThrow({
  where: { id },
  include: {
    drawings: { orderBy: { version: 'asc' }, include: { files: true, revisions: { orderBy: { createdAt: 'asc' } } } },
    files: { orderBy: { createdAt: 'asc' } }, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, offers: { orderBy: { createdAt: 'desc' } },
  },
});
const lastRecord = async (id) => (await orderOf(id)).drawings.at(-1);
const undo = async (id, kind, who, extra = {}) => {
  const o = await orderOf(id);
  const st = await dwgUndoCheck(db, o, actor(P[who]), { priceLock });
  return run(id, `dwg_${kind}_undo`, who, { reason: 'Yanlışlıkla verildi', drawingId: st?.record?.id ?? o.drawings.at(-1)?.id, expectedVersion: o.version, ...extra });
};
/** Değişmez anlık görüntü: siparişin durumu, kayıtları, dosyaları, geçmişi, denetimi ve kuyruğu */
async function snapshot(id) {
  const o = await orderOf(id);
  return {
    order: [o.status, o.drawingTrack, o.version, o.assignedDrawerId],
    drawings: o.drawings.map((d) => [d.id, d.version, d.status, d.decidedById, d.withdrawReason, JSON.stringify(d.sourceFiles), d.files.map((f) => f.storageKey), d.revisions.map((r) => r.comment)]),
    files: o.files.map((f) => [f.id, f.storageKey, f.checksum]),
    events: o.events.length,
    audit: await db.auditLog.count({ where: { entityId: id } }),
    outbox: await db.notificationOutbox.count({ where: { orderId: id } }),
  };
}
async function seenDrawings(who, orderId) {
  const u = P[who];
  const o = await db.order.findFirst({ where: { id: orderId, ...orderScope({ appRole: u.appRole, customerId: u.customerId }) }, include: { drawings: { orderBy: { version: 'asc' }, include: { revisions: true } } } });
  return o ? drawingsView(u.appRole, o.drawings) : null;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'GLASSANDMORE SRL', prefix: 'GLA', email: 'firma@undo.test' } });
  other = await db.customer.create({ data: { name: 'Alegrad SRL', prefix: 'ALE' } });
  const mk = (key, appRole, customerId, extra = {}) => db.user.create({ data: { email: `${key}@undo.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
    .then((u) => { P[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('drawer2', 'CIZIM', factory.id, { isActive: false });
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('other', 'MUSTERI', other.id, { canApprove: true });
});
after(closeDb);

dbTest('1 · Üretime almayı geri al (hazırlanırken): kayıt GERI_CEKILDI, aynı dosyalar için yeni karar kaydı, karar yeniden bekleniyor; geçmiş, denetim, bildirim', offline(async () => {
  const o = await dwgOrder();
  await run(o.id, 'dwg_ready', 'drawer');
  const before = await orderOf(o.id);
  const rec = before.drawings.at(-1);
  assert.deepEqual([before.status, before.drawingTrack, rec.status], ['HAZIRLANIYOR', 'ONAYLANDI', 'ONAYLANDI']);
  assert.equal(drawingFlags(before).dwgUndo, 'READY');

  const res = await undo(o.id, 'ready', 'drawer');
  assert.deepEqual([res.result.undone, res.result.production], ['READY', false]);
  const after = await orderOf(o.id);
  assert.deepEqual([after.status, after.drawingTrack], ['HAZIRLANIYOR', 'GEREKLI']);
  assert.equal(after.drawings.length, 2, 'eski kayıt silinmedi; yeni kayıt eklendi');
  const [old, fresh] = after.drawings;
  assert.deepEqual([old.id, old.status, old.decidedById, old.withdrawReason], [rec.id, 'GERI_CEKILDI', P.drawer.id, 'Yanlışlıkla verildi']);
  assert.ok(old.decidedAt instanceof Date && old.withdrawnAt instanceof Date, 'kararın zamanı ve geri alma zamanı');
  assert.deepEqual([fresh.version, fresh.status, fresh.source, fresh.uploadedById, fresh.decidedById], [2, 'BEKLIYOR', 'MUSTERI_DXF_DWG', P.cust.id, null]);
  assert.deepEqual(fresh.sourceFiles, old.sourceFiles, 'aynı dosyalar yeniden karara');
  assert.deepEqual(after.files.map((f) => [f.id, f.storageKey]), before.files.map((f) => [f.id, f.storageKey]), 'müşteri dosyaları aynen');
  assert.equal(dwgReview(after).pending, true, 'karar yeniden çizimcinin DXF/DWG listesinde');
  assert.equal(lastProductionDrawing(after.drawings), null, 'geri alınan karar üretim çizimi sayılmaz');
  // Geçmiş: ters işlem satırı (gerekçe notta); denetim: kim, gerekçe, önceki ve yeni durum
  const ev = after.events.at(-1);
  assert.deepEqual([ev.event, ev.note, ev.userId, ev.fromStatus, ev.toStatus], ['DWG_READY_UNDONE', 'Yanlışlıkla verildi', P.drawer.id, 'HAZIRLANIYOR', 'HAZIRLANIYOR']);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'dwg_ready_undo' } } });
  assert.deepEqual([audit.userId, audit.actorRole, audit.details.undo, audit.details.reason, audit.details.drawingId], [P.drawer.id, 'CIZIM', 'READY', 'Yanlışlıkla verildi', rec.id]);
  assert.deepEqual(audit.details.before, { status: 'HAZIRLANIYOR', track: 'ONAYLANDI', record: { id: rec.id, version: 1, status: 'ONAYLANDI' } });
  assert.deepEqual([audit.details.after.status, audit.details.after.track, audit.details.after.record.id, audit.details.after.undoneRecordStatus], ['HAZIRLANIYOR', 'GEREKLI', fresh.id, 'GERI_CEKILDI']);
  assert.ok(audit.createdAt instanceof Date);
  // Bildirim: kararı alan taraf (siparişin satışçısı) — uygulama içi; e-posta kuralı yok
  const out = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: o.id, type: 'ORDER_DWG_READY_UNDONE' } });
  assert.ok(res.outboxIds.includes(out.id));
  assert.equal(NOTIFY_RULES.ORDER_DWG_READY_UNDONE, undefined, 'e-posta yok');
  // Yeniden karar: olağan akış değişmedi (regresyon)
  await run(o.id, 'dwg_ready', 'drawer');
  const again = await orderOf(o.id);
  assert.deepEqual([again.drawingTrack, again.drawings.at(-1).status, again.drawings.length], ['ONAYLANDI', 'ONAYLANDI', 2]);
}));

dbTest('1b · Üretime almayı geri al (sipariş üretimde): yalnızca yönetici; sipariş Hazırlanıyor\'a döner, teklif müşteride kalır, yeniden karar → yeniden üretim', offline(async () => {
  const o = await dwgOrder();
  await sendOffer(o.id);
  const r = await run(o.id, 'dwg_ready', 'drawer');
  assert.equal(r.result.produced, true);
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  // Çizimci kararı veren olsa da üretimi geri alamaz (sunucu)
  assert.equal(await codeOf(undo(o.id, 'ready', 'drawer')), 'UNDO_PRODUCTION_ADMIN');
  const res = await undo(o.id, 'ready', 'admin');
  assert.equal(res.result.production, true);
  const after = await orderOf(o.id);
  assert.deepEqual([after.status, after.drawingTrack, after.offers[0].status], ['HAZIRLANIYOR', 'GEREKLI', 'GONDERILDI']);
  const ev = after.events.at(-1);
  assert.deepEqual([ev.event, ev.fromStatus, ev.toStatus], ['DWG_READY_UNDONE', 'URETIMDE', 'HAZIRLANIYOR'], 'geçmiş: üretimden hazırlanıyor\'a ters işlem');
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, details: { path: ['action'], equals: 'dwg_ready_undo' } } });
  assert.deepEqual([audit.details.before.status, audit.details.after.status], ['URETIMDE', 'HAZIRLANIYOR']);
  // Yeniden "Üretime Hazır" → olağan kuralla yeniden üretim
  const again = await run(o.id, 'dwg_ready', 'drawer');
  assert.equal(again.result.produced, true);
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  // Yardımcı yönetici de (aynı yetki) geri alabilir
  await undo(o.id, 'ready', 'assistant');
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');
}));

dbTest('2 · Üretim başlamışsa reddedilir: sandık, mali belge, yüklendi — hiçbir şey yazılmaz', offline(async () => {
  // Sandık girilmiş
  const a = await dwgOrder();
  await sendOffer(a.id);
  await run(a.id, 'dwg_ready', 'drawer');
  const crate = await db.crate.create({ data: { shipDay: new Date('2026-11-02'), customerId: firm.id, crateNo: 7 } });
  await db.crateOrder.create({ data: { crateId: crate.id, orderId: a.id } });
  let snap = await snapshot(a.id);
  assert.equal(await codeOf(undo(a.id, 'ready', 'admin')), 'UNDO_CRATES');
  assert.deepEqual(await snapshot(a.id), snap, 'reddedilen geri alma hiçbir şey yazmaz');
  const shown = await dwgUndoCheck(db, await orderOf(a.id), actor(P.admin), { priceLock });
  assert.deepEqual([shown.kind, shown.block], ['READY', 'UNDO_CRATES'], 'ekran nedeni gösterir');
  // Mali belge (proforma)
  const b = await dwgOrder();
  await sendOffer(b.id);
  await run(b.id, 'dwg_ready', 'drawer');
  await db.fgoDocument.create({ data: { orderId: b.id, kind: 'PROFORMA', series: 'PRF', number: `U${Date.now()}`, issuedAt: new Date() } });
  snap = await snapshot(b.id);
  assert.equal(await codeOf(undo(b.id, 'ready', 'admin')), 'UNDO_DOCUMENTS');
  assert.deepEqual(await snapshot(b.id), snap);
  // Yüklendi olarak işaretlenmiş: geri alma yok (düğme de yok)
  const c = await dwgOrder();
  await sendOffer(c.id);
  await run(c.id, 'dwg_ready', 'drawer');
  await run(c.id, 'mark_shipped', 'sales');
  const cur = await orderOf(c.id);
  assert.equal(drawingFlags(cur).dwgUndo, null);
  assert.equal((await dwgUndoCheck(db, cur, actor(P.admin), { priceLock })).block, 'UNDO_SHIPPED');
  snap = await snapshot(c.id);
  assert.equal(await codeOf(undo(c.id, 'ready', 'admin')), 'NOT_ALLOWED');
  assert.deepEqual(await snapshot(c.id), snap);
}));

dbTest('3 · Çizim hatalı kararını geri al: hatalı kaydı ve açıklaması korunur; müşteri ve iç ekip aynı durumu görür; müşteriye bildirim', offline(async () => {
  const o = await dwgOrder();
  await run(o.id, 'dwg_faulty', 'drawer', { note: 'Ölçü katmanı eksik' });
  const rec = await lastRecord(o.id);
  assert.equal(drawingFlags(await orderOf(o.id)).dwgUndo, 'FAULTY');
  // Müşterinin yanıt işlemleri kararla birlikte açıktı
  const res = await undo(o.id, 'faulty', 'drawer', { reason: 'Dosya doğruymuş' });
  const after = await orderOf(o.id);
  assert.deepEqual([after.status, after.drawingTrack], ['HAZIRLANIYOR', 'GEREKLI']);
  const [old, fresh] = after.drawings;
  assert.deepEqual([old.id, old.status, old.revisions.map((r) => [r.kind, r.comment])], [rec.id, 'GERI_CEKILDI', [['HATALI', 'Ölçü katmanı eksik']]], 'hatalı kaydı ve açıklaması geçmişte');
  assert.deepEqual([fresh.status, fresh.version], ['BEKLIYOR', 2]);
  // Müşteri artık düzeltme göndermez (düzeltme işlemleri kapalı); çizimci yeniden karar verir
  assert.equal(await codeOf(run(o.id, 'dwg_request_drawing', 'cust')), 'NOT_ALLOWED');
  assert.equal(dwgReview(after).pending, true);
  // Müşteri: satır görünür (durum + tarih), gerekçe ve dosya listesi gelmez; iç ekip gerekçeyi görür
  const cv = await seenDrawings('cust', o.id);
  const cOld = cv.find((d) => d.id === old.id);
  assert.deepEqual([cOld.status, cOld.withdrawReason, cOld.sourceFiles], ['GERI_CEKILDI', null, null]);
  assert.equal((await seenDrawings('drawer', o.id)).find((d) => d.id === old.id).withdrawReason, 'Dosya doğruymuş');
  // Geçmiş satırı müşteriye görünür, notu (gerekçe) görünmez — kural EVENTS'te (note: false)
  assert.equal(after.events.at(-1).event, 'DWG_FAULTY_UNDONE');
  // Bildirim: müşteriye uygulama içi + e-posta (giden kuyruk; tek satır — işçi tekrar dağıtsa da tek bildirim)
  const out = await db.notificationOutbox.findMany({ where: { orderId: o.id, type: 'ORDER_DWG_FAULTY_UNDONE' } });
  assert.equal(out.length, 1);
  assert.deepEqual(NOTIFY_RULES.ORDER_DWG_FAULTY_UNDONE(), ['customer']);
  await n.dispatchInAppFor(db, res.outboxIds);
  await n.dispatchInAppFor(db, res.outboxIds);
  const notes = await db.notification.findMany({ where: { type: 'ORDER_DWG_FAULTY_UNDONE', orderId: o.id } });
  assert.deepEqual(notes.map((x) => x.userId), [P.cust.id], 'müşteriye bir kez; kararı veren çizimciye değil');
}));

dbTest('4 · Hatalı kararı: müşteri yanıt verdiyse reddedilir (düzeltilmiş dosya / fabrikadan çizim)', offline(async () => {
  const a = await dwgOrder();
  await run(a.id, 'dwg_faulty', 'drawer', { note: 'Eksik' });
  await run(a.id, 'dwg_resubmit', 'cust', { files: [meta('plan-v2.dwg')] });
  let cur = await orderOf(a.id);
  assert.equal(drawingFlags(cur).dwgUndo, null, 'yeni karar kaydı: hatalı kararı geri alınamaz');
  let snap = await snapshot(a.id);
  assert.equal(await codeOf(run(a.id, 'dwg_faulty_undo', 'drawer', { reason: 'x', drawingId: cur.drawings[0].id, expectedVersion: cur.version })), 'NOT_ALLOWED');
  assert.deepEqual(await snapshot(a.id), snap);
  const b = await dwgOrder();
  await run(b.id, 'dwg_faulty', 'drawer', { note: 'Eksik' });
  await run(b.id, 'dwg_request_drawing', 'cust');
  cur = await orderOf(b.id);
  assert.equal((await dwgUndoCheck(db, cur, actor(P.drawer), { priceLock })).block, 'UNDO_CUSTOMER_ANSWERED');
  snap = await snapshot(b.id);
  assert.equal(await codeOf(undo(b.id, 'faulty', 'drawer')), 'NOT_ALLOWED');
  assert.deepEqual(await snapshot(b.id), snap);
}));

dbTest('5 · Çizim güncellemesini geri al: kayıt GERI_CEKILDI + yeni karar kaydı; hatalı sonrası güncellemede yalnızca hat geri döner', offline(async () => {
  const a = await dwgOrder();
  await run(a.id, 'dwg_update', 'drawer');
  const rec = await lastRecord(a.id);
  await undo(a.id, 'update', 'drawer');
  let cur = await orderOf(a.id);
  assert.deepEqual([cur.drawingTrack, cur.drawings.map((d) => [d.version, d.status])], ['GEREKLI', [[1, 'GERI_CEKILDI'], [2, 'BEKLIYOR']]]);
  assert.equal(cur.drawings[0].id, rec.id);
  // Güncellemenin bildirimi yoktu, geri almanın da yok: kuyruk satırı yazılır (her olay gibi) ama alıcı kuralı yok
  assert.equal(await db.notificationOutbox.count({ where: { orderId: a.id, type: 'ORDER_DWG_UPDATE_UNDONE' } }), 1);
  assert.deepEqual([n.INAPP_RULES.ORDER_DWG_UPDATE_UNDONE, NOTIFY_RULES.ORDER_DWG_UPDATE_UNDONE], [undefined, undefined]);
  // Hatalı → güncelle → geri al: müşterinin düzeltmesi yeniden beklenir, kayıt (hatalı) değişmez
  const b = await dwgOrder();
  await run(b.id, 'dwg_faulty', 'drawer', { note: 'Eksik' });
  await run(b.id, 'dwg_update', 'drawer');
  const before = await orderOf(b.id);
  await undo(b.id, 'update', 'drawer');
  cur = await orderOf(b.id);
  assert.deepEqual([cur.drawingTrack, cur.drawings.map((d) => [d.id, d.status])], ['DUZELTME_BEKLIYOR', before.drawings.map((d) => [d.id, d.status])]);
  // Müşterinin yanıt işlemleri yeniden açık
  await run(b.id, 'dwg_request_drawing', 'cust');
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: b.id, details: { path: ['action'], equals: 'dwg_update_undo' } } });
  assert.deepEqual([audit.details.variant, audit.details.after.record, audit.details.after.track], ['AFTER_FAULTY', null, 'DUZELTME_BEKLIYOR']);
}));

dbTest('6 · Sonraki sürüm varsa güncelleme geri alınmaz; önceki dosyalar ve sürüm geçmişi korunur', offline(async () => {
  const o = await dwgOrder();
  await run(o.id, 'dwg_update', 'drawer');
  await run(o.id, 'upload_drawing', 'drawer', { files: [pdf('fabrika-v2.pdf')] });
  const cur = await orderOf(o.id);
  assert.deepEqual(cur.drawings.map((d) => [d.version, d.source, d.status]), [[1, 'MUSTERI_DXF_DWG', 'YAPILIYOR'], [2, 'FABRIKA', 'TASLAK']]);
  assert.equal((await dwgUndoCheck(db, cur, actor(P.drawer), { priceLock })).block, 'UNDO_LATER_DRAWING');
  const snap = await snapshot(o.id);
  assert.equal(await codeOf(run(o.id, 'dwg_update_undo', 'drawer', { reason: 'x', drawingId: cur.drawings[0].id, expectedVersion: cur.version })), 'NOT_ALLOWED');
  assert.deepEqual(await snapshot(o.id), snap, 'taslak dosyası, kayıt ve geçmiş aynen');
}));

dbTest('7-8 · Müşteri erişimi ve yetki: yalnızca kararı veren çizimci / yönetici; satış, denetimci, müşteri, başka firma, başka çizimci reddedilir', offline(async () => {
  const o = await dwgOrder();
  await run(o.id, 'dwg_ready', 'drawer');
  const cur = await orderOf(o.id);
  const rec = cur.drawings.at(-1);
  const payload = { reason: 'x', drawingId: rec.id, expectedVersion: cur.version };
  for (const who of ['sales', 'inspector', 'cust']) assert.equal(await codeOf(run(o.id, 'dwg_ready_undo', who, payload)), 'NOT_ALLOWED', who);
  assert.equal(await codeOf(run(o.id, 'dwg_ready_undo', 'other', payload)), 'NOT_FOUND');
  // Başka çizimci (kararı vermeyen): ekran nedeni gösterir, sunucu reddeder
  await db.user.update({ where: { id: P.drawer2.id }, data: { isActive: true } });
  assert.equal((await dwgUndoCheck(db, cur, actor(P.drawer2), { priceLock })).block, 'UNDO_NOT_OWNER');
  assert.equal(await codeOf(run(o.id, 'dwg_ready_undo', 'drawer2', payload)), 'UNDO_NOT_OWNER');
  await db.user.update({ where: { id: P.drawer2.id }, data: { isActive: false } });
  // Müşteri / satış için ekran denetimi yok (çizim yetkisi yok)
  for (const who of ['cust', 'sales', 'inspector']) assert.equal(await dwgUndoCheck(db, cur, actor(P[who]), { priceLock }), null, who);
  // Müşterinin gördüğü sürümler: dosyası olmayan karar kayıtları; geri alma sonrası eski kayıt yalnızca satır
  await run(o.id, 'dwg_ready_undo', 'drawer', payload);
  const cv = await seenDrawings('cust', o.id);
  assert.deepEqual(cv.map((d) => [d.version, d.status, d.withdrawReason ?? null, d.sourceFiles === null]), [[1, 'GERI_CEKILDI', null, true], [2, 'BEKLIYOR', null, false]]);
}));

dbTest('9-10 · Tekrar ve eşzamanlılık: aynı karar iki kez geri alınamaz; eski ekran / eski kayıt reddedilir; eşzamanlı istekte tek kazanan', offline(async () => {
  const o = await dwgOrder();
  await run(o.id, 'dwg_update', 'drawer');
  const cur = await orderOf(o.id);
  const rec = cur.drawings.at(-1);
  const payload = { reason: 'x', drawingId: rec.id, expectedVersion: cur.version };
  // Eşzamanlı iki geri alma + eşzamanlı taslak yükleme: biri kazanır, ötekiler CONFLICT / NOT_ALLOWED
  const results = await Promise.all([
    codeOf(run(o.id, 'dwg_update_undo', 'drawer', payload)),
    codeOf(run(o.id, 'dwg_update_undo', 'admin', payload)),
    codeOf(run(o.id, 'upload_drawing', 'drawer', { files: [pdf('yaris.pdf')], expectedVersion: cur.version })),
  ]);
  assert.equal(results.filter((r) => r === 'OK').length, 1, results.join(','));
  for (const r of results.filter((x) => x !== 'OK')) assert.ok(['CONFLICT', 'NOT_ALLOWED'].includes(r), r);
  const after = await orderOf(o.id);
  if (results[2] === 'OK') {
    assert.deepEqual(after.drawings.map((d) => d.status), ['YAPILIYOR', 'TASLAK'], 'yükleme kazandı: geri alma yazılmadı');
  } else {
    assert.deepEqual(after.drawings.map((d) => d.status), ['GERI_CEKILDI', 'BEKLIYOR'], 'geri alma kazandı: tek yeni kayıt');
    assert.equal(await db.auditLog.count({ where: { entityId: o.id, details: { path: ['action'], equals: 'dwg_update_undo' } } }), 1);
    // Tekrar istek (aynı form): eski sürüm → CONFLICT; güncel sürümle → artık geri alınacak karar yok
    assert.equal(await codeOf(run(o.id, 'dwg_update_undo', 'drawer', payload)), 'CONFLICT');
    assert.equal(await codeOf(run(o.id, 'dwg_update_undo', 'drawer', { ...payload, expectedVersion: after.version })), 'NOT_ALLOWED');
  }
  // Ekrandaki kayıttan farklı kayıt → STALE_DRAWING
  const p = await dwgOrder();
  await run(p.id, 'dwg_ready', 'drawer');
  const pc = await orderOf(p.id);
  assert.equal(await codeOf(run(p.id, 'dwg_ready_undo', 'drawer', { reason: 'x', drawingId: 'baska-kayit', expectedVersion: pc.version })), 'STALE_DRAWING');
  assert.equal(await codeOf(run(p.id, 'dwg_ready_undo', 'drawer', { reason: 'x', expectedVersion: pc.version })), 'STALE_DRAWING');
}));

dbTest('11-12 · İşlem ortasında hata → tam rollback; gerekçe zorunlu', offline(async () => {
  const o = await dwgOrder();
  await sendOffer(o.id);
  await run(o.id, 'dwg_ready', 'drawer');
  const snap = await snapshot(o.id);
  // Gerekçe zorunlu / uzunluk
  assert.equal(await codeOf(undo(o.id, 'ready', 'admin', { reason: '   ' })), 'UNDO_REASON');
  assert.equal(await codeOf(undo(o.id, 'ready', 'admin', { reason: 'x'.repeat(1001) })), 'UNDO_REASON_LONG');
  assert.deepEqual(await snapshot(o.id), snap);
  // Yeni karar kaydı yazılırken hata: eski kaydın durumu, sipariş durumu (üretim), geçmiş, denetim, kuyruk aynen
  const wrap = (obj, override) => new Proxy(obj, { get(t, k) { if (Object.hasOwn(override, k)) return override[k]; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  const failing = wrap(db, {
    $transaction: (fn, ...rest) => db.$transaction((tx) => fn(wrap(tx, { drawing: wrap(tx.drawing, { create: async () => { throw new Error('YAZMA_HATASI'); } }) })), ...rest),
  });
  const cur = await orderOf(o.id);
  const st = await dwgUndoCheck(db, cur, actor(P.admin), { priceLock });
  assert.equal(await codeOf(run(o.id, 'dwg_ready_undo', 'admin', { reason: 'Yanlış', drawingId: st.record.id, expectedVersion: cur.version }, failing)), 'YAZMA_HATASI');
  assert.deepEqual(await snapshot(o.id), snap, 'tam rollback');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  // Hata yokken aynı istek çalışır
  await undo(o.id, 'ready', 'admin');
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');
}));
