// Müşterinin DWG/DXF çizimi için çizimcinin kararı (karar 167) ve çizim alanının not çevirisi (karar 168) — veritabanıyla.
//   - üç karar ayrı sunucu işlemleri: Üretime Hazır (müşteri onayı yok → "Müşteriden onaylı çizimler"), Çizim Hatalı
//     (müşteriye bildirim; müşteri düzeltilmiş dosya gönderir ya da fabrika çizimi ister), Çizimi Güncelle (dosya korunur;
//     olağan taslak → kontrol → müşteriye gönder → onay / revizyon döngüsü)
//   - kayıtlar ve dosyalar silinmez / üzerine yazılmaz; her karar geçmiş + denetim (kim, ne zaman, hangi karar) + kuyruk yazar
//   - bildirim: işlemden HEMEN sonra dağıtılır (dispatchInAppFor); işçi aynı olayı yeniden dağıtsa da tek bildirim
//   - çeviri: not yazılırken bir kez; "yeniden dene" yalnızca başarısız çeviride, eşzamanlı isteklerde sağlayıcıya tek istek
// Google'a / FGO'ya GERÇEK istek yapılmaz: çeviri sağlayıcısı sahte işlevdir ve testler ağ engeliyle (offline) çalışır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { createGlassOrder, suggestNextNo } = await import('../../server/orders/create.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { reviewToken } = await import('../../server/orders/review.js');
const { getEnv } = await import('../../server/env.js');
const { drawingFlags } = await import('../../server/orders/rules.js');
const { orderScope } = await import('../../server/orders/scope.js');
const { drawingsView, findDrawingFile } = await import('../../server/orders/drawing-access.js');
const { lastProductionDrawing } = await import('../../server/orders/dwg-review.js');
const { queuesFor, dwgDrawingGroups } = await import('../../server/orders/queues.js');
const n = await import('../../server/notifications/inapp.js');
const { revisionOf } = await import('../../server/notifications/email.js');
const tr = await import('../../server/notes/translation.js');
const { TranslateError } = await import('../../server/notes/provider.js');
const { NOTE_LIMITS, createNoteLimits } = await import('../../server/notes/limits.js');
const { drawingTranslationsFor } = await import('../../server/notes/view.js');

const SECRET = 'n'.repeat(40);
const KEY = 'AIzaSyTESTONLY-not-a-real-key-0123456789';
let db, firm, other;
const P = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(P[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
let fileNo = 0;
const meta = (name, extra = {}) => ({ storageKey: `2026/10/dwg-${++fileNo}`, name, size: 10, mime: 'application/octet-stream', checksum: `sum-${fileNo}`, scanStatus: 'CLEAN', ...extra });
const pdf = (name) => meta(name, { mime: 'application/pdf' });
const ITEM = { glassName: '8mm Temperli', camAdedi: 1 };

/** Müşterinin DWG/DXF dosyalı cam siparişi; satış çizim ekibine gönderir (tek çizimci → kendiliğinden atanır) */
async function dwgOrder(files = [meta('plan.dwg'), pdf('olcu.pdf')], { toDrawing = true } = {}) {
  const next = await suggestNextNo(db, firm.id);
  const o = await createGlassOrder(db, { actor: actor(P.cust), firm, title: 'DWG', requestedNo: next, suggestedNo: next, items: [ITEM], files });
  if (toDrawing) await run(o.id, 'send_to_drawing', 'sales');
  return o;
}
const orderOf = (id) => db.order.findUniqueOrThrow({
  where: { id },
  include: {
    drawings: { orderBy: { version: 'asc' }, include: { files: true, revisions: { orderBy: { createdAt: 'asc' } } } },
    files: { orderBy: { createdAt: 'asc' } }, events: { orderBy: { createdAt: 'asc' } }, offers: { orderBy: { createdAt: 'desc' } },
  },
});
/** "Kontrol Et" ekranının kanıtı (son sürüm + bu kullanıcı + o andaki dosyalar) */
const reviewOf = async (orderId, who) => {
  const d = await db.drawing.findFirstOrThrow({ where: { orderId }, orderBy: { version: 'desc' }, include: { files: true } });
  return reviewToken({ secret: getEnv().AUTH_SECRET, drawingId: d.id, userId: P[who].id, files: d.files });
};
/** Sahte çeviri sağlayıcısı: çağrıları sayar (gerçek Google yok) */
function provider(impl = async ({ text, target }) => ({ text: `[${target}] ${text}` })) {
  const calls = [];
  return { calls, fn: async (o) => { calls.push({ ...o }); return impl(o); } };
}
const translation = (r) => [r.translation, r.translationLang, r.translationStatus, r.translationError];
/** Kullanıcının sipariş sayfasında gördüğü çizim verisi: kapsam + sürüm erişimi + çeviri görünümü (lib/orders.ts ile aynı kurallar) */
async function seenDrawings(who, orderId) {
  const u = P[who];
  const o = await db.order.findFirst({ where: { id: orderId, ...orderScope({ appRole: u.appRole, customerId: u.customerId }) }, include: { drawings: { orderBy: { version: 'asc' }, include: { revisions: true } } } });
  return o ? drawingTranslationsFor(u.appRole, drawingsView(u.appRole, o.drawings)) : null;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'GLASSANDMORE SRL', prefix: 'GLA', email: 'firma@dwg.test' } });
  other = await db.customer.create({ data: { name: 'Alegrad SRL', prefix: 'ALE' } });
  const mk = (key, appRole, customerId, extra = {}) => db.user.create({ data: { email: `${key}@dwg.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
    .then((u) => { P[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('custView', 'MUSTERI', firm.id, { canApprove: false });
  await mk('other', 'MUSTERI', other.id, { canApprove: true });
});
after(closeDb);

dbTest('Üretime Hazır: müşteri onayı beklenmez, sipariş "Müşteriden onaylı çizimler"e geçer (teklif müşterideyse üretime); kayıt, geçmiş, denetim, dosyalar korunur', offline(async () => {
  const o = await dwgOrder();
  const before = await orderOf(o.id);
  assert.deepEqual([before.drawingTrack, before.assignedDrawerId, drawingFlags(before).dwgPending], ['GEREKLI', P.drawer.id, true]);
  // Karar verilmeden sürüm yüklenmez; kararı yalnızca çizim yetkisi verir (sunucu); başka firmanın müşterisi siparişi bulamaz
  assert.equal(await codeOf(run(o.id, 'upload_drawing', 'drawer', { files: [pdf('erken.pdf')] })), 'NOT_ALLOWED');
  for (const who of ['sales', 'inspector', 'cust']) {
    for (const a of ['dwg_ready', 'dwg_update']) assert.equal(await codeOf(run(o.id, a, who)), 'NOT_ALLOWED', `${who} ${a}`);
    assert.equal(await codeOf(run(o.id, 'dwg_faulty', who, { note: 'x' })), 'NOT_ALLOWED', who);
  }
  assert.equal(await codeOf(run(o.id, 'dwg_ready', 'other')), 'NOT_FOUND');

  // Teklif müşteride (satış hazırlar, yönetici fiyatlar ve gönderir); çizim kararı beklenirken üretime geçmez
  const lines = [{ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 1, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false }];
  await run(o.id, 'save_offer', 'sales', { lines });
  await run(o.id, 'submit_offer', 'sales', { lines });
  const saved = await db.offerLine.findMany({ where: { offer: { orderId: o.id } } });
  await run(o.id, 'approve_offer', 'admin', { lines: lines.map((l, i) => ({ ...l, id: saved[i].id, offerPrice: '41.00' })) });
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');

  const res = await run(o.id, 'dwg_ready', 'drawer');
  assert.equal(res.result.produced, true, 'çizim hazır + teklif müşteride → olağan kuralla üretim');
  const after = await orderOf(o.id);
  assert.deepEqual([after.status, after.drawingTrack, after.assignedDrawerId], ['URETIMDE', 'ONAYLANDI', P.drawer.id]);
  assert.equal(after.drawings.length, 1);
  const [rec] = after.drawings;
  const dwg = before.files.find((f) => f.name === 'plan.dwg');
  assert.deepEqual([rec.source, rec.version, rec.status, rec.decidedById, rec.files.length, rec.uploadedById, rec.sentAt], ['MUSTERI_DXF_DWG', 1, 'ONAYLANDI', P.drawer.id, 0, P.cust.id, null]);
  assert.deepEqual(rec.sourceFiles, [{ id: dwg.id, name: 'plan.dwg', checksum: dwg.checksum }], 'yalnızca DWG/DXF — kararın dosyaları değişmez kopya');
  assert.ok(rec.decidedAt instanceof Date);
  // Dosya geçmişi korunur: müşterinin sipariş dosyaları aynen
  assert.deepEqual(after.files.map((f) => [f.id, f.name, f.storageKey, f.checksum]), before.files.map((f) => [f.id, f.name, f.storageKey, f.checksum]));
  // Geçmiş + denetim: işlemi yapan, tarih, karar
  assert.ok(after.events.some((e) => e.event === 'DWG_READY' && e.note === 'v1' && e.userId === P.drawer.id));
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'dwg_ready' } } });
  assert.deepEqual([audit.userId, audit.actorRole, audit.details.decision, audit.details.drawingId, audit.details.files.map((f) => f.name)], [P.drawer.id, 'CIZIM', 'READY', rec.id, ['plan.dwg']]);
  assert.deepEqual(audit.details.events, ['DWG_READY', 'PRODUCTION']);
  // Kuyruk olayı: işlemin döndürdüğü kimliklerle aynı (uygulama bunları hemen dağıtır)
  const ev = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: o.id, type: 'ORDER_DWG_READY' } });
  assert.equal(ev.payload.drawingId, rec.id);
  assert.ok(res.outboxIds.includes(ev.id));
  // Üretim çizimi müşterinin kaydı; "Müşteriden onaylı çizimler" kuyruğunda (çizim ekibi)
  assert.equal(lastProductionDrawing(after.drawings).drawing.id, rec.id);
  const rows = await db.order.findMany({ where: { id: o.id }, include: { offers: true, drawings: true, events: { where: { event: 'OFFER_CHECKED' } } } });
  assert.deepEqual(queuesFor(rows, { review: false, send: false, drawing: true, userId: P.drawer.id }).find((q) => q.key === 'approvedDrawings').rows.map((r) => r.id), [o.id]);
  // Bir kez: kararın ardından yeni karar yok
  assert.equal(await codeOf(run(o.id, 'dwg_ready', 'drawer')), 'NOT_ALLOWED');
}));

dbTest('Çizim Hatalı: açıklama zorunlu; müşteriye hemen bildirim (tek kez); müşteri düzeltilmiş dosya gönderir → yeni karar; hatalı dosya ve karar geçmişte', offline(async () => {
  const o = await dwgOrder([meta('kat.DXF')]);
  assert.equal(await codeOf(run(o.id, 'dwg_faulty', 'drawer', { note: '   ' })), 'DWG_NOTE');
  assert.equal(await codeOf(run(o.id, 'dwg_faulty', 'drawer', { note: 'x'.repeat(2001) })), 'DWG_NOTE_LONG');
  const res = await run(o.id, 'dwg_faulty', 'drawer', { note: 'Ölçü katmanı eksik' });
  // Bildirim hemen: siparişin firmasının etkin müşteri kullanıcılarına (başka firma yok), bağlantı kırmızı bilgilendirmeye
  const d = await n.dispatchInAppFor(db, res.outboxIds);
  assert.equal(d.events, res.outboxIds.length);
  const sent = await db.notification.findMany({ where: { orderId: o.id, type: 'ORDER_DWG_FAULTY' } });
  assert.deepEqual(sent.map((x) => x.userId).sort(), [P.cust.id, P.custView.id].sort());
  assert.ok(sent.every((x) => x.link === `/siparisler/${o.id}#cizim-hatali` && x.params.firm === undefined));
  assert.equal(await db.notification.count({ where: { userId: P.other.id } }), 0);
  // İşçi aynı olayı yeniden dağıtsa da ikinci bildirim yok; e-posta kuyruğunda tek olay
  await db.notificationOutbox.updateMany({ where: { id: { in: res.outboxIds } }, data: { inAppAt: null } });
  await Promise.all([n.dispatchInApp(db), n.dispatchInAppFor(db, res.outboxIds)]);
  assert.equal(await db.notification.count({ where: { orderId: o.id, type: 'ORDER_DWG_FAULTY' } }), 2);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'ORDER_DWG_FAULTY' } }), 1);

  const after = await orderOf(o.id);
  assert.equal(after.drawingTrack, 'DUZELTME_BEKLIYOR');
  const [rec] = after.drawings;
  assert.deepEqual([rec.status, rec.revisions.map((r) => [r.kind, r.comment, r.requestedById])], ['REVIZYON_ISTENDI', [['HATALI', 'Ölçü katmanı eksik', P.drawer.id]]]);
  assert.equal(res.result.revisionId, rec.revisions[0].id);
  // Revizyon e-postası (müşterinin talebi) çizimcinin "hatalı" açıklamasını taşımaz
  assert.equal(await revisionOf(db, o.id, new Date()), null);
  // Müşteri geçmişinde "hatalı" olayı var ama çevirisiz Türkçe açıklama yok (açıklama sayfada Romence çevirisiyle)
  const custEvents = after.events.filter((e) => e.event === 'DWG_FAULTY');
  assert.equal(custEvents.length, 1);

  // Müşterinin yanıtı: onay yetkisi şart; yalnızca kendi siparişinde; en az bir DWG / DXF
  assert.equal(await codeOf(run(o.id, 'dwg_resubmit', 'custView', { files: [meta('duz.dwg')] })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'dwg_request_drawing', 'custView')), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'dwg_resubmit', 'other', { files: [meta('duz.dwg')] })), 'NOT_FOUND');
  assert.equal(await codeOf(run(o.id, 'dwg_resubmit', 'drawer', { files: [meta('duz.dwg')] })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'dwg_resubmit', 'cust', { files: [pdf('duz.pdf')] })), 'DWG_FILE');
  assert.equal(await codeOf(run(o.id, 'dwg_resubmit', 'cust', { files: [] })), 'DWG_FILE');
  // Çizimci beklemeden de karar verebilir: yalnızca "Çizimi Güncelle" (öbür iki karar yok)
  assert.equal(await codeOf(run(o.id, 'dwg_ready', 'drawer')), 'NOT_ALLOWED');

  const fix = await run(o.id, 'dwg_resubmit', 'cust', { files: [meta('duzeltilmis.dwg'), pdf('aciklama.pdf')] });
  await n.dispatchInAppFor(db, fix.outboxIds);
  const toTeam = await db.notification.findMany({ where: { orderId: o.id, type: 'ORDER_DWG_RESUBMITTED' } });
  assert.deepEqual(toTeam.map((x) => x.userId).sort(), [P.drawer.id, P.sales.id].sort(), 'atanmış çizimci + ilgili satışçı');
  assert.ok(toTeam.every((x) => x.params.firm === 'GLA**********'), 'çizim ve satışta firma adı maskeli');
  const o2 = await orderOf(o.id);
  assert.equal(o2.drawingTrack, 'GEREKLI');
  assert.equal(drawingFlags(o2).dwgPending, true, 'yeni dosya çizimcinin DXF/DWG kuyruğuna düştü');
  const groups = dwgDrawingGroups([{ ...o2, _count: { drawings: o2.drawings.length } }]);
  assert.deepEqual(groups.find((g) => g.key === 'pending').rows.map((r) => r.id), [o.id]);
  const [v1, v2] = o2.drawings;
  assert.deepEqual([v1.status, v2.version, v2.status, v2.source, v2.uploadedById], ['REVIZYON_ISTENDI', 2, 'BEKLIYOR', 'MUSTERI_DXF_DWG', P.cust.id]);
  const added = o2.files.filter((f) => ['duzeltilmis.dwg', 'aciklama.pdf'].includes(f.name));
  assert.deepEqual(added.map((f) => [f.name, f.kind, f.uploadedById]), [['duzeltilmis.dwg', 'CUSTOMER', P.cust.id], ['aciklama.pdf', 'CUSTOMER', P.cust.id]]);
  assert.deepEqual(v2.sourceFiles.map((f) => [f.id, f.name]), added.map((f) => [f.id, f.name]));
  // Hatalı dosya ve karar geçmişte: ilk dosya ve ilk kayıt (açıklamasıyla) değişmedi
  assert.ok(o2.files.some((f) => f.name === 'kat.DXF'));
  assert.deepEqual([v1.sourceFiles.map((f) => f.name), v1.revisions.map((r) => r.comment)], [['kat.DXF'], ['Ölçü katmanı eksik']]);

  // Yeni dosyaya karar
  await run(o.id, 'dwg_ready', 'drawer');
  const o3 = await orderOf(o.id);
  assert.deepEqual(o3.drawings.map((x) => [x.version, x.status]), [[1, 'REVIZYON_ISTENDI'], [2, 'ONAYLANDI']]);
  assert.equal(o3.drawingTrack, 'ONAYLANDI');
  // Müşterinin karar kayıtları müşteriye açık (kendi dosyaları); başka firmaya hiç gelmez; çizim dosyası yolu bu kayıtlardan
  // dosya vermez (dosyalar sipariş dosyasıdır — /dosya/siparis kendi kuralıyla)
  assert.deepEqual((await seenDrawings('cust', o.id)).map((x) => [x.version, x.status]), [[1, 'REVIZYON_ISTENDI'], [2, 'ONAYLANDI']]);
  assert.equal(await seenDrawings('other', o.id), null);
  for (const who of ['cust', 'drawer', 'admin']) {
    assert.equal(await findDrawingFile(db, { id: v1.id, scope: orderScope(P[who]), role: P[who].appRole }), null, who);
  }
}));

dbTest('Çizim Hatalı → müşteri fabrikadan çizim ister: sipariş olağan çizim kuyruğuna döner, çizimci çizer; çizimciye bildirim', offline(async () => {
  const o = await dwgOrder();
  await run(o.id, 'dwg_faulty', 'drawer', { note: 'Katmanlar okunmuyor' });
  const r = await run(o.id, 'dwg_request_drawing', 'cust');
  await n.dispatchInAppFor(db, r.outboxIds);
  assert.deepEqual((await db.notification.findMany({ where: { orderId: o.id, type: 'ORDER_DWG_FACTORY_REQUESTED' } })).map((x) => x.userId).sort(), [P.drawer.id, P.sales.id].sort());
  const after = await orderOf(o.id);
  assert.deepEqual([after.drawingTrack, drawingFlags(after).dwgPending], ['GEREKLI', false]);
  assert.equal(await codeOf(run(o.id, 'dwg_request_drawing', 'cust')), 'NOT_ALLOWED', 'tek yanıt');
  // Olağan kuyruk ("Yapılacak çizimler") ve olağan yükleme
  const rows = await db.order.findMany({ where: { id: o.id }, include: { offers: true, drawings: true, events: { where: { event: 'OFFER_CHECKED' } } } });
  assert.deepEqual(queuesFor(rows, { review: false, send: false, drawing: true, userId: P.drawer.id }).find((q) => q.key === 'drawingJobs').rows.map((x) => x.id), [o.id]);
  const up = await run(o.id, 'upload_drawing', 'drawer', { files: [pdf('fabrika.pdf')] });
  assert.equal(up.result.version, 2, 'v1 = müşterinin hatalı kaydı (geçmişte kalır)');
}));

dbTest('Çizimi Güncelle: orijinal dosya korunur; çift onaylı gönderim → müşteri onayı → "Müşteriden onaylı çizimler"; onay bildirimi çizimciye, onaylanan sürüme, tek kez', offline(async () => {
  const o = await dwgOrder();
  const before = await orderOf(o.id);
  const u = await run(o.id, 'dwg_update', 'drawer');
  let cur = await orderOf(o.id);
  assert.deepEqual([cur.drawingTrack, cur.drawings.map((x) => [x.version, x.source, x.status]), drawingFlags(cur).dwgPending], ['YAPILIYOR', [[1, 'MUSTERI_DXF_DWG', 'YAPILIYOR']], false]);
  assert.equal(u.outboxIds.length, 1, 'yalnızca geçmiş olayı (bildirim kuralı yok)');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [pdf('fabrika.pdf'), meta('fabrika.dwg')], noteCustomer: 'Kenar 5 mm düzeltildi' });
  assert.equal(v2.result.version, 2);
  // Mevcut çift onay: "Kontrol Et" kanıtı olmadan gönderilemez
  assert.equal(await codeOf(run(o.id, 'send_drawing', 'drawer')), 'DRAWING_NOT_CHECKED');
  await run(o.id, 'send_drawing', 'drawer', { review: await reviewOf(o.id, 'drawer') });
  cur = await orderOf(o.id);
  assert.equal(cur.drawingTrack, 'ONAY_BEKLIYOR', '"Müşteriden onay beklenenler"');
  const rows = async () => db.order.findMany({ where: { id: o.id }, include: { offers: true, drawings: true, events: { where: { event: 'OFFER_CHECKED' } } } });
  assert.deepEqual(queuesFor(await rows(), { review: false, send: false, drawing: true, userId: P.drawer.id }).find((q) => q.key === 'atCustomer').rows.map((x) => x.id), [o.id]);
  // Onay yetkisi olmayan kullanıcı karar veremez; yetkili müşteri onaylar
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'custView', { drawingId: v2.result.drawingId })), 'NOT_ALLOWED');
  const ap = await run(o.id, 'approve_drawing', 'cust', { drawingId: v2.result.drawingId });
  await n.dispatchInAppFor(db, ap.outboxIds);
  const toDrawer = await db.notification.findMany({ where: { userId: P.drawer.id, type: 'ORDER_DRAWING_APPROVED', orderId: o.id } });
  assert.equal(toDrawer.length, 1);
  assert.equal(toDrawer[0].link, `/siparisler/${o.id}/cizim/${v2.result.drawingId}`, 'bildirim onaylanan sürümün ekranına');
  // Tekrar: işçinin dağıtımı yeni bildirim yazmaz; aynı onay ikinci kez yapılamaz; e-posta kuyruğunda tek olay
  await db.notificationOutbox.updateMany({ where: { id: { in: ap.outboxIds } }, data: { inAppAt: null } });
  await n.dispatchInApp(db);
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v2.result.drawingId })), 'NOT_ALLOWED');
  assert.deepEqual((await db.notification.findMany({ where: { type: 'ORDER_DRAWING_APPROVED', orderId: o.id } })).map((x) => x.userId).sort(), [P.drawer.id, P.sales.id].sort());
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'ORDER_DRAWING_APPROVED' } }), 1);
  cur = await orderOf(o.id);
  assert.equal(cur.drawingTrack, 'ONAYLANDI');
  assert.deepEqual(queuesFor(await rows(), { review: false, send: false, drawing: true, userId: P.drawer.id }).find((q) => q.key === 'approvedDrawings').rows.map((x) => x.id), [o.id]);
  // Orijinal DWG dosyası silinmedi, üzerine yazılmadı; müşterinin kaydı (v1) geçmişte; fabrika sürümü ayrı satırda
  assert.deepEqual(cur.files.map((f) => [f.id, f.storageKey, f.checksum]), before.files.map((f) => [f.id, f.storageKey, f.checksum]));
  assert.deepEqual(cur.drawings.map((x) => [x.version, x.source, x.status, x.files.map((f) => f.name).sort()]),
    [[1, 'MUSTERI_DXF_DWG', 'YAPILIYOR', []], [2, 'FABRIKA', 'ONAYLANDI', ['fabrika.dwg', 'fabrika.pdf']]]);
  // Teklif kontrolü kuralı: müşterinin kaydı araya girdi ama bu yine İLK üretim çizimi
  assert.equal(lastProductionDrawing(cur.drawings).ordinal, 1);
}));

dbTest('revizyon: müşteri revizyon isteyince çizimciye hemen bildirim (kırmızı kuyruk); önceki karar / onay yeni sürüme taşınmaz; eski sürüm geçmişte', offline(async () => {
  const o = await dwgOrder([pdf('plan.pdf')]);
  const v1 = await run(o.id, 'upload_drawing', 'drawer', { files: [pdf('v1.pdf')] });
  await run(o.id, 'send_drawing', 'drawer', { review: await reviewOf(o.id, 'drawer') });
  const rq = await run(o.id, 'request_revision', 'cust', { comment: '1. Kenar 5 mm\n2. Delik ekleyin', drawingId: v1.result.drawingId });
  const d = await n.dispatchInAppFor(db, rq.outboxIds);
  assert.ok(d.created >= 1);
  const toDrawer = await db.notification.findFirstOrThrow({ where: { userId: P.drawer.id, type: 'ORDER_REVISION_REQUESTED', orderId: o.id } });
  assert.equal(toDrawer.link, `/siparisler/${o.id}#cizim`);
  const rev = await revisionOf(db, o.id, new Date());
  assert.deepEqual([rev.version, rev.note], [1, '1. Kenar 5 mm\n2. Delik ekleyin'], 'revizyon e-postası müşterinin numaralı notunu taşır');
  let cur = await orderOf(o.id);
  assert.deepEqual([cur.drawingTrack, cur.drawings[0].status], ['REVIZYON_ISTENDI', 'REVIZYON_ISTENDI']);
  // Eski sürüme yeni karar verilemez (onay / ikinci revizyon); yeni sürüm gönderilip onaylanana kadar onay yok
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'NOT_ALLOWED');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [pdf('v2.pdf')] });
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v2.result.drawingId })), 'NOT_ALLOWED', 'taslak müşteride değil');
  await run(o.id, 'send_drawing', 'drawer', { review: await reviewOf(o.id, 'drawer') });
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust', { drawingId: v1.result.drawingId })), 'STALE_DRAWING', 'ekrandaki eski sürüm');
  // Savunma: hat "müşteri onayında" görünse bile son sürüm karara bağlanmışsa / müşterinin kaydıysa karar taşınmaz
  const latest = await db.drawing.findFirstOrThrow({ where: { orderId: o.id }, orderBy: { version: 'desc' } });
  await db.drawing.update({ where: { id: latest.id }, data: { status: 'ONAYLANDI' } });
  assert.equal(await codeOf(run(o.id, 'approve_drawing', 'cust')), 'STALE_DRAWING');
  assert.equal(await codeOf(run(o.id, 'request_revision', 'cust', { comment: 'x' })), 'STALE_DRAWING');
  // Eski kayıtlardaki gönderilmiş BEKLIYOR sürümü (eski davranış) karar alabilir
  await db.drawing.update({ where: { id: latest.id }, data: { status: 'BEKLIYOR' } });
  await run(o.id, 'approve_drawing', 'cust');
  cur = await orderOf(o.id);
  assert.deepEqual(cur.drawings.map((x) => [x.version, x.status]), [[1, 'REVIZYON_ISTENDI'], [2, 'ONAYLANDI']], 'eski sürüm ve talebi geçmişte');
  assert.equal(cur.drawings[0].revisions[0].comment, '1. Kenar 5 mm\n2. Delik ekleyin');
}));

dbTest('çeviri (karar 168): "hatalı" açıklaması ve sürüm notu bir kez Romence\'ye çevrilir, saklanır; müşteri çeviriyi, iç ekip ve denetimci özgün notu görür; okuma çeviri yapmaz', offline(async () => {
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { key: KEY, secret: SECRET }, actor(P.admin)), { ok: true });
  const o = await dwgOrder();
  const f = await run(o.id, 'dwg_faulty', 'drawer', { note: 'Ölçü katmanı eksik' });
  const p = provider(async () => ({ text: 'Lipsește stratul de cote' }));
  const t1 = await tr.translateRevision(db, { revisionId: f.result.revisionId, orderId: o.id, actor: actor(P.drawer), translator: p.fn, secret: SECRET, limits: createNoteLimits() });
  assert.deepEqual(t1, { ok: true, translation: 'DONE' });
  assert.deepEqual(p.calls.map((c) => [c.text, c.target, c.key]), [['Ölçü katmanı eksik', 'ro', KEY]]);
  // Bir kez: aynı not yeniden çevrilmez; başkasının notu çevrilmez
  assert.deepEqual(await tr.translateRevision(db, { revisionId: f.result.revisionId, orderId: o.id, actor: actor(P.drawer), translator: p.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await tr.translateRevision(db, { revisionId: f.result.revisionId, orderId: o.id, actor: actor(P.admin), translator: p.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' });
  assert.equal(p.calls.length, 1);
  const row = await db.drawingRevision.findUniqueOrThrow({ where: { id: f.result.revisionId } });
  assert.deepEqual([row.comment, ...translation(row)], ['Ölçü katmanı eksik', 'Lipsește stratul de cote', 'ro', 'DONE', null], 'özgün not değişmez');
  // Görünüm (sayfa okuması — sağlayıcı çağrılmaz)
  const revOf = async (who) => (await seenDrawings(who, o.id))[0].revisions[0];
  assert.deepEqual(translation(await revOf('cust')), ['Lipsește stratul de cote', 'ro', 'DONE', null]);
  for (const who of ['admin', 'sales', 'drawer', 'inspector']) assert.deepEqual(translation(await revOf(who)), [null, null, null, null], who);
  assert.equal(p.calls.length, 1, 'okumalar çeviri istemedi');

  // Sürüm notu: gönderimden sonra, yalnızca gönderen için, bir kez
  await run(o.id, 'dwg_update', 'drawer');
  const v2 = await run(o.id, 'upload_drawing', 'drawer', { files: [pdf('v2.pdf')], noteCustomer: 'Kenar 5 mm düzeltildi' });
  assert.deepEqual(await tr.translateDrawingNote(db, { drawingId: v2.result.drawingId, orderId: o.id, actor: actor(P.drawer), translator: p.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' }, 'taslak notu çevrilmez');
  await run(o.id, 'send_drawing', 'drawer', { review: await reviewOf(o.id, 'drawer') });
  const p2 = provider(async () => ({ text: 'Marginea corectată cu 5 mm' }));
  assert.deepEqual(await tr.translateDrawingNote(db, { drawingId: v2.result.drawingId, orderId: o.id, actor: actor(P.admin), translator: p2.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' }, 'gönderen değil');
  assert.deepEqual(await tr.translateDrawingNote(db, { drawingId: v2.result.drawingId, orderId: o.id, actor: actor(P.drawer), translator: p2.fn, secret: SECRET, limits: createNoteLimits() }), { ok: true, translation: 'DONE' });
  assert.deepEqual(await tr.translateDrawingNote(db, { drawingId: v2.result.drawingId, orderId: o.id, actor: actor(P.drawer), translator: p2.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' }, 'bir kez');
  assert.deepEqual(p2.calls.map((c) => [c.text, c.target]), [['Kenar 5 mm düzeltildi', 'ro']]);
  const ver = async (who) => (await seenDrawings(who, o.id)).find((x) => x.id === v2.result.drawingId);
  assert.deepEqual([(await ver('cust')).noteCustomer, (await ver('cust')).translation], ['Kenar 5 mm düzeltildi', 'Marginea corectată cu 5 mm']);
  for (const who of ['admin', 'sales', 'drawer', 'inspector']) assert.equal((await ver(who)).translation, null, who);
  // Geri çekilen sürüm (karar 146): müşteriye satır gelir; not ve çevirisi gelmez
  await run(o.id, 'withdraw_drawing', 'drawer', { reason: 'Yanlış dosya' });
  const w = await ver('cust');
  assert.deepEqual([w.status, w.noteCustomer, w.translation, w.translationStatus], ['GERI_CEKILDI', null, null, null]);
  assert.ok(!JSON.stringify(await seenDrawings('cust', o.id)).includes('Marginea'));
}));

dbTest('çeviri yeniden deneme (karar 168): yalnızca iç ekip, yalnızca başarısız çeviri; eşzamanlı iki istekte sağlayıcıya TEK istek; tamamlanmış çeviri tekrarlanmaz; servis çalışmasa da akış sürer', offline(async () => {
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: true }, { key: KEY, secret: SECRET }, actor(P.admin)), { ok: true });
  const o = await dwgOrder();
  const f = await run(o.id, 'dwg_faulty', 'drawer', { note: 'Katman eksik' });
  // Servis çalışmıyor: çeviri FAILED + güvenli kod; karar ve not kayıtlı, müşterinin yanıtı engellenmez
  const down = provider(async () => { throw new TranslateError('QUOTA', `Google: quota for key ${KEY}`); });
  assert.deepEqual(await tr.translateRevision(db, { revisionId: f.result.revisionId, orderId: o.id, actor: actor(P.drawer), translator: down.fn, secret: SECRET, limits: createNoteLimits() }), { ok: true, translation: 'FAILED' });
  let row = await db.drawingRevision.findUniqueOrThrow({ where: { id: f.result.revisionId } });
  assert.deepEqual([row.comment, ...translation(row)], ['Katman eksik', null, 'ro', 'FAILED', 'QUOTA']);
  assert.ok(!JSON.stringify(row).includes(KEY), 'anahtar hiçbir alanda yok');
  assert.equal((await orderOf(o.id)).drawingTrack, 'DUZELTME_BEKLIYOR');
  // Müşteri ve denetimci hata kodu görmez; iç ekip görür (yeniden deneyebilsin)
  const revOf = async (who) => (await seenDrawings(who, o.id))[0].revisions[0];
  assert.deepEqual(translation(await revOf('cust')), [null, null, null, null]);
  assert.deepEqual(translation(await revOf('inspector')), [null, null, null, null]);
  assert.deepEqual(translation(await revOf('drawer')), [null, 'ro', 'FAILED', 'QUOTA']);

  const retry = (who, p, extra = {}) => tr.retryDrawingTranslation(db, { target: 'revision', id: f.result.revisionId, orderId: o.id, actor: actor(P[who]), translator: p.fn, secret: SECRET, limits: createNoteLimits(), ...extra });
  const p = provider(async ({ text }) => { await new Promise((r) => setTimeout(r, 150)); return { text: `[ro] ${text}` }; });
  for (const who of ['cust', 'inspector']) assert.deepEqual(await retry(who, p), { ok: false, code: 'FORBIDDEN' }, who);
  assert.deepEqual(await tr.retryDrawingTranslation(db, { target: 'revision', id: f.result.revisionId, orderId: o.id, actor: actor(P.drawer), translator: p.fn, secret: SECRET, limits: createNoteLimits({ ...NOTE_LIMITS, retries: { limit: 0, windowMs: 60_000 } }) }), { ok: false, code: 'RATE_LIMIT' });
  assert.equal(p.calls.length, 0, 'hak yokken sağlayıcı çağrılmaz, not sahiplenilmez');
  assert.equal((await db.drawingRevision.findUniqueOrThrow({ where: { id: f.result.revisionId } })).translationStatus, 'FAILED');
  // Eşzamanlı iki "yeniden dene": yalnızca biri sahiplenir → sağlayıcıya tek istek
  const [a, b] = await Promise.all([retry('drawer', p), retry('admin', p)]);
  assert.deepEqual([a, b].map((x) => (x.ok ? x.translation : x.code)).sort(), ['DONE', 'NOT_ALLOWED']);
  assert.equal(p.calls.length, 1);
  row = await db.drawingRevision.findUniqueOrThrow({ where: { id: f.result.revisionId } });
  assert.deepEqual(translation(row), ['[ro] Katman eksik', 'ro', 'DONE', null]);
  // Tamamlanmış çeviri yeniden yapılmaz
  assert.deepEqual(await retry('sales', p), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(p.calls.length, 1);
  const audits = await db.auditLog.findMany({ where: { action: 'DRAWING_TRANSLATION_RETRY', entityId: f.result.revisionId } });
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].details.target, audits[0].details.before, audits[0].details.result], ['revision', 'FAILED', 'DONE']);
  // Başka firmanın siparişi / bilinmeyen kayıt: bulunamaz; çeviri kapalıyken istek yapılmaz
  assert.deepEqual(await tr.retryDrawingTranslation(db, { target: 'revision', id: f.result.revisionId, orderId: 'baska', actor: actor(P.drawer), translator: p.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await tr.retryDrawingTranslation(db, { target: 'nope', id: f.result.revisionId, orderId: o.id, actor: actor(P.drawer), translator: p.fn, secret: SECRET }), { ok: false, code: 'NOT_FOUND' });
  const f2 = await (async () => { const o2 = await dwgOrder(); return { o2, r: await run(o2.id, 'dwg_faulty', 'drawer', { note: 'İkinci' }) }; })();
  await tr.translateRevision(db, { revisionId: f2.r.result.revisionId, orderId: f2.o2.id, actor: actor(P.drawer), translator: down.fn, secret: SECRET, limits: createNoteLimits() });
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled: false }, { secret: SECRET }, actor(P.admin)), { ok: true });
  assert.deepEqual(await tr.retryDrawingTranslation(db, { target: 'revision', id: f2.r.result.revisionId, orderId: f2.o2.id, actor: actor(P.drawer), translator: p.fn, secret: SECRET }), { ok: false, code: 'DISABLED' });
  assert.equal(p.calls.length, 1);
}));
