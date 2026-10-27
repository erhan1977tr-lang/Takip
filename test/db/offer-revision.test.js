// Müşteri teklif revizyonu (4.2.10, karar 306 — ürün sahibinin 27.10.2026 kararları), veritabanıyla:
//   - üretimdeki (URETIMDE) siparişte müşterinin değişiklik talebi satışa revizyon taslağı açar; sipariş durumu değişmez
//   - satış YALNIZCA açık revizyonun taslağını düzenler ve "Yönetici Onayına Gönder"ir (submit_offer); müşteriye gönderemez
//   - yönetici geri gönderir / onaylayıp müşteriye gönderir → yeni sürüm, 4.2.9 kuralıyla yeni üretim onayı talebi; yükleme
//     engeli yeni sürüm onaylanana kadar sürer; sınırsız döngü; eski sürümler / notlar / onaylar / olaylar kalır
//   - satış listesi ve menü sayacı (tek kural); yetkisiz roller; mali kilit; telafi koruması; özellik kapalıyken davranış
//   - eski talep (ALE81 gibi: 4.2.10 öncesinde üretimde alınmış, taslaksız): tek seferlik "Revizyon taslağını aç" — talep kaydı
//     değişmez, çift tıklamada tek taslak, denetim kaydı, not bir kez çevrilir
//   - not çevirisi (müşteri → Türkçe): bir kez, saklanır, yeniden çevrilmez; hata notu bozmaz; "yeniden dene"; görünürlük
//   - satışçıya e-posta (ilgili satışçı; not + Türkçe çeviri) ve uygulama içi bildirim; mükerrer yok
// Google / FGO / SMTP'ye GERÇEK istek yapılmaz: sağlayıcı sahte işlevdir, e-posta sahte taşıyıcıya yazılır, testler ağ
// engeliyle (offline) çalışır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { saveApprovalSetting } from '../../server/orders/production-approval-service.js';
import { loadingApprovalBlocks } from '../../server/orders/loading-approval.js';
import { awaitingSalesRevision, customerRevision, revisionCandidateWhere, REVISION_OFFER_SELECT } from '../../server/orders/offer-revision.js';
import { offerRevisionCount, salesOfferGroups } from '../../server/orders/queues.js';
import { orderScope } from '../../server/orders/scope.js';
import { dispatchInAppFor } from '../../server/notifications/inapp.js';
import { CHANGE_MAIL_DELAY_MS, dispatchNotifications } from '../../server/notifications/email.js';
import { destinationCheck, sourceReducible } from '../../server/orders/compensation.js';

const tr = await import('../../server/notes/translation.js');
const { TranslateError } = await import('../../server/notes/provider.js');
const { NOTE_LIMITS, createNoteLimits } = await import('../../server/notes/limits.js');

const SECRET = 'r'.repeat(40);
const KEY = 'AIzaSyTESTONLY-not-a-real-key-revizyon01';
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
    files: [{ storageKey: `2026/10/rv-${fileNo}.pdf`, name: `rv-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
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
const setApproval = (enabled) => saveApprovalSetting(db, { enabled, actor: actor(people.admin) });
const gate = async (orderId) => (await loadingApprovalBlocks(db, { orderIds: [orderId] }))[0]?.reason ?? null;
/** Sahte çeviri sağlayıcısı: çağrıları sayar (gerçek Google yok) */
function provider(impl = async ({ text, target }) => ({ text: `[${target}] ${text}` })) {
  const calls = [];
  return { calls, fn: async (o) => { calls.push({ ...o }); return impl(o); } };
}
const translate = (orderId, offerId, who, p = provider(), extra = {}) =>
  tr.translateOfferChange(db, { offerId, orderId, actor: actor(people[who]), translator: p.fn, secret: SECRET, limits: createNoteLimits(), ...extra });
const retryTr = (orderId, offerId, who, p = provider(), extra = {}) =>
  tr.retryOfferChangeTranslation(db, { offerId, orderId, actor: actor(people[who]), translator: p.fn, secret: SECRET, limits: createNoteLimits(), ...extra });
async function setTranslate(enabled) {
  assert.deepEqual(await tr.saveTranslateSettings(db, { enabled }, { key: KEY, secret: SECRET }, actor(people.admin)), { ok: true });
}
/** Satışın Teklifler sayfasındaki ve menü sayacındaki kural (tek kaynak): kullanıcının kapsamındaki revizyon bekleyenler */
async function salesList(who = 'sales') {
  const u = people[who];
  const rows = await db.order.findMany({
    where: { ...orderScope({ appRole: u.appRole, customerId: u.customerId }), ...revisionCandidateWhere() },
    select: { id: true, status: true, orderTypeCode: true, productionApprovalRequired: true, offers: { orderBy: { createdAt: 'desc' }, select: REVISION_OFFER_SELECT } },
  });
  return rows.filter(awaitingSalesRevision).map((o) => o.id);
}
/** Satış teklifi hazırlar → yönetici fiyatlar ve müşteriye gönderir (v1) → müşteri onaylar (üretim) → yönetici "Teklifi güncelle" (v2, onay bekler) */
async function inProductionPending(title) {
  const o = await newOrder(title);
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines) });
  const v1 = await latest(o.id);
  await run(o.id, 'approve_production', 'cust', { offerId: v1.id });
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  await run(o.id, 'update_offer', 'admin', { lines: adminForm(v1.lines, '55') });
  const v2 = await latest(o.id);
  assert.equal(v2.status, 'GONDERILDI');
  assert.equal(v2.approvedAt, null);
  return { o, v1, v2 };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Alegrad Sticla', prefix: 'ALE', email: 'office@ale-rv.test' } });
  other = await db.customer.create({ data: { name: 'Beta Glass', prefix: 'BET', email: 'office@bet-rv.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@rv.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id, { language: 'tr' });
  await mk('sales2', 'SATIS', factory.id, { language: 'tr' });
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true, language: 'ro' });
  await mk('custNoRight', 'MUSTERI', firm.id, { canApprove: false });
  await mk('otherCust', 'MUSTERI', other.id, { canApprove: true });
  await setApproval(true);
});
after(closeDb);

dbTest('üretimdeki siparişte revizyon döngüsü: talep → taslak → satış düzeltir → yönetici geri gönderir / gönderir → yeni onay; iki tur; sürümler ve kayıtlar korunur', offline(async () => {
  await setApproval(true);
  const { o, v1, v2 } = await inProductionPending('Üretim revizyonu');
  // Revizyon yokken üretimdeki siparişin teklifini satış düzenleyemez (4.2.9 kısıtı aynen)
  assert.equal(await codeOf(run(o.id, 'save_offer', 'sales', { lines: v2.lines.map((l) => form(l)) })), 'NOT_ALLOWED');
  assert.equal(await gate(o.id), 'PENDING');
  assert.equal((await salesList()).includes(o.id), false);

  // Müşteri: değişiklik talebi → satışa revizyon taslağı (gönderilmiş sürümün satırları); sipariş durumu değişmez
  const res = await run(o.id, 'request_offer_change', 'cust', { offerId: v2.id, note: 'Lățimea primului rând trebuie să fie 1200 mm' });
  assert.equal(res.result.offerId, v2.id);
  let all = await versions(o.id);
  assert.equal(all.length, 3);
  const draft = all[2];
  assert.equal(res.result.draftId, draft.id);
  assert.equal(draft.status, 'HAZIRLANIYOR');
  assert.deepEqual(draft.lines.map((l) => [l.description, l.enMm, l.boyMm, l.adet, String(l.unitPrice), String(l.offerPrice)]), v2.lines.map((l) => [l.description, l.enMm, l.boyMm, l.adet, String(l.unitPrice), String(l.offerPrice)]));
  assert.equal((await orderOf(o.id)).status, 'URETIMDE', 'sipariş durumu değişmez');
  assert.equal((await db.offer.findUnique({ where: { id: v2.id } })).status, 'GONDERILDI', 'gönderilmiş sürüm değişmez');
  assert.equal(await gate(o.id), 'CHANGE_REQUESTED', 'yükleme engeli sürer');
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'request_offer_change' } } });
  assert.deepEqual([audit.details.path, audit.details.status, audit.details.draftId], ['SALES_DRAFT', 'URETIMDE', draft.id]);
  assert.equal(customerRevision({ ...(await orderOf(o.id)), offers: [...all].reverse() }).stage, 'SALES');
  // Satış listesi ve menü sayacı (tek kural): bütün satışçılar görür (4.2.x satış kapsamı)
  assert.ok((await salesList()).includes(o.id));
  assert.ok((await salesList('sales2')).includes(o.id));
  assert.equal(await offerRevisionCount(db, { appRole: 'SATIS' }), (await salesList()).length);
  assert.equal(await offerRevisionCount(db, { appRole: 'MUSTERI', customerId: other.id }), 0, 'başka firmanın müşterisi saymaz');

  // Yetkisiz: çizim, denetimci, müşteri, başka müşteri taslağı düzenleyemez / gönderemez; satış müşteriye gönderemez
  for (const who of ['drawer', 'inspector', 'cust', 'otherCust']) {
    assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(o.id, 'save_offer', who, { lines: draft.lines.map((l) => form(l)) }))), who);
    assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(o.id, 'submit_offer', who, { lines: draft.lines.map((l) => form(l)) }))), who);
  }
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'sales', { lines: adminForm(draft.lines) })), 'NOT_ALLOWED');

  // Satış düzeltir ve "Yönetici Onayına Gönder"ir → yöneticide, listeden çıkar
  await run(o.id, 'save_offer', 'sales', { lines: draft.lines.map((l) => form(l, { enMm: 1200 })) });
  await run(o.id, 'submit_offer', 'sales', { lines: (await latest(o.id)).lines.map((l) => form(l)) });
  assert.equal((await latest(o.id)).status, 'YONETIMDE');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  assert.equal((await salesList()).includes(o.id), false, 'yöneticiye gönderilince listeden çıkar');
  // Yönetici geri gönderir → satış listesine döner; satış yeniden gönderir
  await run(o.id, 'return_offer', 'admin', { lines: adminForm((await latest(o.id)).lines), returnNote: 'Fiyatı kontrol edin' });
  assert.equal((await latest(o.id)).status, 'HAZIRLANIYOR');
  assert.ok((await salesList()).includes(o.id), 'geri gönderilince listeye döner');
  await run(o.id, 'submit_offer', 'sales', { lines: (await latest(o.id)).lines.map((l) => form(l)) });
  // Yönetici onaylar ve müşteriye gönderir → yeni sürüm (v3), yeni onay talebi; durum URETIMDE
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, '58') });
  const v3 = await latest(o.id);
  assert.equal(v3.id, draft.id);
  assert.equal(v3.status, 'GONDERILDI');
  assert.ok(v3.approvalRequestedAt instanceof Date, 'yeni sürüm için 4.2.9 kuralıyla yeni onay talebi');
  assert.equal(v3.approvalDueAt, null, 'süre talep iletildiğinde başlar');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  const sentEv = await db.notificationOutbox.findFirst({ where: { orderId: o.id, payload: { path: ['approval', 'offerId'], equals: v3.id } } });
  assert.ok(sentEv, 'müşteriye teklif + onay talebi');
  assert.equal(await gate(o.id), 'PENDING', 'yükleme engeli yeni sürüm onaylanana kadar sürer');
  assert.equal(await codeOf(run(o.id, 'approve_production', 'cust', { offerId: v2.id })), 'OFFER_VERSION_STALE', 'eski sürüm onaylanamaz');

  // İkinci tur: müşteri yeni sürümde yine değişiklik ister → yeni taslak → gönderim → onay
  await run(o.id, 'request_offer_change', 'cust', { offerId: v3.id, note: 'Încă o modificare: 1250 mm' });
  const d2 = await latest(o.id);
  assert.equal(d2.status, 'HAZIRLANIYOR');
  assert.ok((await salesList()).includes(o.id));
  await run(o.id, 'submit_offer', 'sales', { lines: d2.lines.map((l) => form(l, { enMm: 1250 })) });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, '60') });
  const v4 = await latest(o.id);
  assert.equal(v4.status, 'GONDERILDI');
  await run(o.id, 'approve_production', 'cust', { offerId: v4.id });
  assert.equal(await gate(o.id), null, 'yeni sürüm onaylanınca engel kalkar');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  // Bütün sürümler, notlar, onaylar ve olaylar kalır
  all = await versions(o.id);
  assert.deepEqual(all.map((x) => [x.status, !!x.changeRequestedAt, !!x.approvedAt]), [
    ['GONDERILDI', false, true], ['GONDERILDI', true, false], ['GONDERILDI', true, false], ['GONDERILDI', false, true],
  ]);
  assert.equal(all[0].id, v1.id);
  assert.equal(all[1].changeNote, 'Lățimea primului rând trebuie să fie 1200 mm');
  assert.equal(all[2].changeNote, 'Încă o modificare: 1250 mm');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'OFFER_CHANGE_REQUESTED' } }), 2);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'PRODUCTION_APPROVED' } }), 2);
  assert.equal((await salesList()).includes(o.id), false);
}));

dbTest('mali kilit ve telafi: talepten sonra proforma → yönetici gönderemez; açık revizyonda telafi kaynak / hedef sürüm açmaz', offline(async () => {
  await setApproval(true);
  const { o, v2 } = await inProductionPending('Revizyon kilit');
  await run(o.id, 'request_offer_change', 'cust', { offerId: v2.id, note: 'ölçü' });
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
  assert.deepEqual(sourceReducible(full, { inConfirmation: false, coverage: null }), { ok: false, reason: 'REVISION' });
  const dest = destinationCheck({ ...full, offers: full.offers }, { sourceOrderId: 'x', customerId: full.customerId, currency: 'EUR', today: '2000-01-01', day: '2999-01-01', locked: false });
  assert.deepEqual(dest, { ok: false, reason: 'REVISION_OPEN' });
  await run(o.id, 'submit_offer', 'sales', { lines: (await latest(o.id)).lines.map((l) => form(l)) });
  await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: '9306', total: '100', issuedAt: new Date() } });
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines) })), 'PRICE_LOCKED');
  assert.equal((await latest(o.id)).status, 'YONETIMDE', 'hiçbir şey yazılmadı');
}));

dbTest('eski talep (ALE81 gibi): taslaksız; "Revizyon taslağını aç" tek seferlik — talep değişmez, çift tıklamada tek taslak, yetki, denetim, not bir kez çevrilir', offline(async () => {
  await setApproval(true);
  const { o, v2 } = await inProductionPending('Eski talep');
  // 4.2.9'un üretimdeki siparişte yaptığı: talep kaydı yazılır, taslak AÇILMAZ (canlıdaki ALE81 durumu)
  const reqAt = new Date(Date.now() - 86_400_000);
  await db.offer.update({ where: { id: v2.id }, data: { changeRequestedAt: reqAt, changeRequestedById: people.cust.id, changeNote: 'Dimensiunile rândului 2 sunt greșite' } });
  assert.equal((await versions(o.id)).length, 2);
  assert.ok((await salesList()).includes(o.id), 'satış listesinde: taslak bekleniyor');
  // Taslak yokken satış düzenleyemez; müşteri yeniden talep / onay veremez
  assert.equal(await codeOf(run(o.id, 'save_offer', 'sales', { lines: v2.lines.map((l) => form(l)) })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'request_offer_change', 'cust', { offerId: v2.id, note: 'tekrar' })), 'NOT_ALLOWED');
  // Yetkisiz roller; yanlış sürüm
  for (const who of ['drawer', 'inspector', 'cust', 'custNoRight']) assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(o.id, 'open_revision_draft', who, { offerId: v2.id }))), who);
  assert.equal(await codeOf(run(o.id, 'open_revision_draft', 'sales', { offerId: 'yanlis' })), 'OFFER_VERSION_STALE');
  // Çift tıklama / iki satışçı aynı anda: yalnızca bir taslak
  const v = (await orderOf(o.id)).version;
  const results = await Promise.all(['sales', 'sales2'].map((who) => codeOf(run(o.id, 'open_revision_draft', who, { offerId: v2.id, expectedVersion: v }))));
  assert.equal(results.filter((r) => r === 'OK').length, 1, results.join(','));
  assert.equal(await codeOf(run(o.id, 'open_revision_draft', 'sales', { offerId: v2.id })), 'NOT_ALLOWED', 'ikinci kez açılmaz');
  const all = await versions(o.id);
  assert.equal(all.length, 3);
  assert.equal(all[2].status, 'HAZIRLANIYOR');
  // Talep kaydı değişmedi
  const req = await db.offer.findUnique({ where: { id: v2.id } });
  assert.deepEqual([req.status, req.changeRequestedAt.toISOString(), req.changeRequestedById, req.changeNote], ['GONDERILDI', reqAt.toISOString(), people.cust.id, 'Dimensiunile rândului 2 sunt greșite']);
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'open_revision_draft' } } });
  assert.deepEqual([audit.details.legacy, audit.details.offerId, audit.details.draftId, audit.details.status], [true, v2.id, all[2].id, 'URETIMDE']);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'OFFER_REVISION_OPENED' } }), 1);
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'OFFER_CHANGE_REQUESTED' } }), 0, 'talep olayı yeniden yazılmaz');
  // Eski talebin notu taslak açılırken bir kez Türkçeye çevrilir (satış / yönetici isteğiyle); ikinci kez çevrilmez
  await setTranslate(true);
  const p = provider();
  assert.deepEqual(await translate(o.id, v2.id, 'sales', p), { ok: true, translation: 'DONE' });
  assert.deepEqual(await translate(o.id, v2.id, 'admin', p), { ok: false, code: 'NOT_FOUND' });
  assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].target, 'tr');
  const done = await db.offer.findUnique({ where: { id: v2.id } });
  assert.deepEqual([done.translation, done.translationLang, done.translationStatus, done.changeNote], ['[tr] Dimensiunile rândului 2 sunt greșite', 'tr', 'DONE', 'Dimensiunile rândului 2 sunt greșite']);
  for (const who of ['drawer', 'inspector']) assert.deepEqual(await translate(o.id, v2.id, who, p), { ok: false, code: 'FORBIDDEN' }, who);
  await setTranslate(false);
  // Akış olağan: satış düzeltir, yöneticiye; yönetici gönderir → yeni onay talebi
  await run(o.id, 'submit_offer', 'sales', { lines: all[2].lines.map((l) => form(l, { enMm: 900 })) });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines) });
  const v3 = await latest(o.id);
  assert.equal(v3.status, 'GONDERILDI');
  assert.ok(v3.approvalRequestedAt instanceof Date);
  assert.equal(await gate(o.id), 'PENDING');
}));

dbTest('not çevirisi: müşteri talebi bir kez Türkçeye; yeniden çevrilmez; kapalıyken alan yazılmaz; hata talebi bozmaz; "yeniden dene"; hız sınırı; görünürlük', offline(async () => {
  await setApproval(true);
  // Kapalıyken: talep kaydedilir, çeviri alanı yazılmaz, sağlayıcı çağrılmaz
  await setTranslate(false);
  const a = await inProductionPending('Çeviri kapalı');
  await run(a.o.id, 'request_offer_change', 'cust', { offerId: a.v2.id, note: 'Notă fără traducere' });
  const off = provider();
  assert.deepEqual(await translate(a.o.id, a.v2.id, 'cust', off), { ok: true, translation: null });
  assert.equal(off.calls.length, 0);
  const offRow = await db.offer.findUnique({ where: { id: a.v2.id } });
  assert.deepEqual([offRow.translation, offRow.translationLang, offRow.translationStatus, offRow.translationError, offRow.translationAt], [null, null, null, null, null]);

  await setTranslate(true);
  // Açıkken: talebi yazan müşteri için bir kez; başka müşteri / başkasının talebi bulunmaz
  const b = await inProductionPending('Çeviri açık');
  await run(b.o.id, 'request_offer_change', 'cust', { offerId: b.v2.id, note: 'Rândul 1: lățimea 1200 mm' });
  const p = provider();
  assert.deepEqual(await translate(b.o.id, b.v2.id, 'otherCust', p), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await translate(b.o.id, b.v2.id, 'custNoRight', p), { ok: false, code: 'NOT_FOUND' }, 'talebi yazan değil');
  assert.deepEqual(await translate(b.o.id, b.v2.id, 'cust', p), { ok: true, translation: 'DONE' });
  assert.deepEqual(await translate(b.o.id, b.v2.id, 'cust', p), { ok: false, code: 'NOT_FOUND' }, 'yeniden çevrilmez (sayfa yenileme / tekrar gönderim)');
  assert.equal(p.calls.length, 1);
  const row = await db.offer.findUnique({ where: { id: b.v2.id } });
  assert.deepEqual([row.translation, row.translationLang, row.translationStatus, row.changeNote], ['[tr] Rândul 1: lățimea 1200 mm', 'tr', 'DONE', 'Rândul 1: lățimea 1200 mm']);
  // Görünürlük (sipariş sayfasının kuralı): iç ekip Türkçesini alır; müşteri ve denetimci yalnızca özgün
  const seen = (role) => tr.offerChangeView(role, row);
  assert.equal(seen('SATIS').translation, '[tr] Rândul 1: lățimea 1200 mm');
  assert.equal(seen('ADMIN').translation, '[tr] Rândul 1: lățimea 1200 mm');
  for (const role of ['MUSTERI', 'DENETIMCI']) assert.deepEqual([seen(role).translation, seen(role).translationStatus, seen(role).changeNote], [null, null, row.changeNote], role);
  // Tamamlanmış çeviri "yeniden dene" ile de yeniden yapılmaz
  assert.deepEqual(await retryTr(b.o.id, b.v2.id, 'sales', p), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(p.calls.length, 1);

  // Hata: talep durur, FAILED + güvenli kod; iç ekip "yeniden dene" (yalnızca satış / yönetici); denetim kaydı
  const c = await inProductionPending('Çeviri hata');
  await run(c.o.id, 'request_offer_change', 'cust', { offerId: c.v2.id, note: 'Notă cu eroare' });
  const down = provider(async () => { throw new TranslateError('TIMEOUT'); });
  assert.deepEqual(await translate(c.o.id, c.v2.id, 'cust', down), { ok: true, translation: 'FAILED' });
  let failed = await db.offer.findUnique({ where: { id: c.v2.id } });
  assert.deepEqual([failed.translationStatus, failed.translationError, failed.changeNote, failed.changeRequestedAt != null], ['FAILED', 'TIMEOUT', 'Notă cu eroare', true]);
  assert.equal((await latest(c.o.id)).status, 'HAZIRLANIYOR', 'taslak durur');
  assert.equal(tr.offerChangeView('SATIS', failed).translationError, 'TIMEOUT');
  assert.equal(tr.offerChangeView('MUSTERI', failed).translationError, null);
  for (const who of ['cust', 'drawer', 'inspector']) assert.deepEqual(await retryTr(c.o.id, c.v2.id, who), { ok: false, code: 'FORBIDDEN' }, who);
  const ok = provider();
  assert.deepEqual(await retryTr(c.o.id, c.v2.id, 'sales', ok), { ok: true, translation: 'DONE' });
  assert.equal(ok.calls.length, 1);
  failed = await db.offer.findUnique({ where: { id: c.v2.id } });
  assert.deepEqual([failed.translationStatus, failed.translation], ['DONE', '[tr] Notă cu eroare']);
  const retryAudit = await db.auditLog.findFirst({ where: { action: 'OFFER_TRANSLATION_RETRY', entityId: c.v2.id } });
  assert.deepEqual([retryAudit.details.before, retryAudit.details.beforeError, retryAudit.details.result], ['FAILED', 'TIMEOUT', 'DONE']);
  // Kapalıyken "yeniden dene" sağlayıcıyı çağırmaz
  const d = await inProductionPending('Çeviri sınır');
  await run(d.o.id, 'request_offer_change', 'cust', { offerId: d.v2.id, note: 'Notă la limită' });
  // Hız sınırı (karar 147): müşterinin çeviri hakkı doluysa sağlayıcı çağrılmaz, not FAILED + RATE_LIMIT
  const none = provider();
  const limits = createNoteLimits({ ...NOTE_LIMITS, customerTranslations: { limit: 0, windowMs: 60_000 } });
  assert.deepEqual(await translate(d.o.id, d.v2.id, 'cust', none, { limits }), { ok: true, translation: 'FAILED' });
  assert.equal(none.calls.length, 0);
  assert.equal((await db.offer.findUnique({ where: { id: d.v2.id } })).translationError, 'RATE_LIMIT');
  await setTranslate(false);
  assert.deepEqual(await retryTr(d.o.id, d.v2.id, 'sales', none), { ok: false, code: 'DISABLED' });
  assert.equal(none.calls.length, 0);
}));

dbTest('bildirim: talep ilgili satışçıya uygulama içi + e-posta (not ve Türkçe çeviri), yöneticiye uygulama içi; e-posta gecikmeli ve bir kez; mükerrer yok', offline(async () => {
  await setApproval(true);
  const sentMails = [];
  const transport = { sendMail: async (m) => { sentMails.push(m); return { messageId: `m${sentMails.length}` }; } };
  const opts = { transport, from: 'takip@rv.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
  // E-posta gönderiminin başlangıç anı: önceki olaylar gönderilmez
  await dispatchNotifications(db, { ...opts, now: new Date(Date.now() - 1000) });
  await setTranslate(true);
  const { o, v2 } = await inProductionPending('Revizyon bildirimi');
  // Önceki olayların (sipariş, teklif, onay talebi) e-postaları gönderilir; kuyruk boşalır
  for (let i = 0; i < 10; i++) await dispatchNotifications(db, { ...opts, now: new Date(Date.now() + 3_600_000) });
  const before = sentMails.length;
  await run(o.id, 'request_offer_change', 'cust', { offerId: v2.id, note: 'Lățimea 1200 mm, sunați la ofis@ale-rv.test' });
  assert.deepEqual(await translate(o.id, v2.id, 'cust'), { ok: true, translation: 'DONE' });
  const ev = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_OFFER_CHANGE_REQUESTED' } });
  assert.equal(ev.payload.offerId, v2.id);
  // Uygulama içi: yönetici, yardımcısı ve ilgili satışçı (teklifi hazırlayan); iki kez dağıtılsa da tek bildirim
  await dispatchInAppFor(db, [ev.id]);
  await dispatchInAppFor(db, [ev.id]);
  const inApp = await db.notification.findMany({ where: { dedupeKey: `outbox:${ev.id}` } });
  assert.deepEqual(inApp.map((n) => n.userId).sort(), [people.admin.id, people.assistant.id, people.sales.id].sort());
  // E-posta: olaydan CHANGE_MAIL_DELAY_MS geçmeden gönderilmez (çeviri yetişsin); satır dokunulmadan bekler
  await dispatchNotifications(db, { ...opts, now: new Date(ev.createdAt.getTime() + 1000) });
  assert.equal(sentMails.length, before, 'gecikme dolmadan e-posta yok');
  assert.deepEqual(await db.notificationOutbox.findUnique({ where: { id: ev.id }, select: { status: true, attempts: true } }), { status: 'PENDING', attempts: 0 });
  const later = new Date(ev.createdAt.getTime() + CHANGE_MAIL_DELAY_MS + 1000);
  for (let i = 0; i < 5; i++) await dispatchNotifications(db, { ...opts, now: later });
  const mine = sentMails.slice(before).filter((m) => String(m.text).includes(o.orderNo) && /Lățimea 1200 mm/.test(String(m.text)));
  assert.equal(sentMails.length - before, 1, 'talep için tek e-posta');
  assert.deepEqual(mine.map((m) => m.to), [people.sales.email], 'yalnızca ilgili satışçıya; yöneticiye e-posta yok');
  const text = String(mine[0].text);
  assert.match(text, /Müşterinin notu: Lățimea 1200 mm, sunați la \*\*\*/);
  assert.match(text, /Türkçe çeviri \(otomatik\): \[tr\] Lățimea 1200 mm, sunați la \*\*\*/);
  assert.match(text, new RegExp(`Teklif sürümü: v2`));
  assert.ok(!text.includes('ofis@ale-rv.test'), 'satışa e-posta adresi maskeli');
  assert.ok(!String(mine[0].html).includes('Alegrad Sticla'), 'satışa firma adı maskeli');
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: ev.id } })).status, 'SENT');
  await setTranslate(false);
}));

dbTest('özellik kapalı: yeni talep yok; açılmış revizyon taslağı akış içinde tamamlanır (kilitlenmez), yeni onay talebi açılmaz', offline(async () => {
  await setApproval(true);
  const { o, v2 } = await inProductionPending('Kapalı revizyon');
  // Onay bekleyen ikinci sipariş (ayar açıkken hazırlanır — kapalıyken müşteri onayı istenmez, kurulum yapılamaz)
  const other2 = await inProductionPending('Kapalı yeni');
  await run(o.id, 'request_offer_change', 'cust', { offerId: v2.id, note: 'ölçü' });
  await setApproval(false);
  // Kapalıyken müşteri yeni talep / onay işlemi yapamaz
  assert.equal(await codeOf(run(other2.o.id, 'request_offer_change', 'cust', { offerId: other2.v2.id, note: 'x' })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(other2.o.id, 'approve_production', 'cust', { offerId: other2.v2.id })), 'NOT_ALLOWED');
  // Açık taslak tamamlanır: satış gönderir, yönetici gönderir; onay talebi açılmaz, engel yok (4.2.0 davranışı)
  await run(o.id, 'submit_offer', 'sales', { lines: (await latest(o.id)).lines.map((l) => form(l, { enMm: 1100 })) });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines) });
  const v3 = await latest(o.id);
  assert.equal(v3.status, 'GONDERILDI');
  assert.equal(v3.approvalRequestedAt, null, 'kapalıyken yeni onay talebi açılmaz');
  assert.equal((await orderOf(o.id)).status, 'URETIMDE');
  assert.equal(await gate(o.id), null);
  assert.equal((await salesList()).includes(o.id), false);
  await setApproval(true);
}));

dbTest('satış listesi (Teklifler) ve hazırlanan siparişler: revizyon taslağı "Fiyatımı bekleyenler"de yeniden görünmez; profil siparişi hiç girmez', offline(async () => {
  await setApproval(true);
  const o = await newOrder('Hazırlıkta revizyon');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines) });
  const v1 = await latest(o.id);
  await run(o.id, 'request_offer_change', 'cust', { offerId: v1.id, note: 'ölçü' });
  const rows = await db.order.findMany({ where: { id: o.id }, include: { offers: { orderBy: { createdAt: 'desc' } } } });
  const g = salesOfferGroups(rows);
  assert.deepEqual(g.map((x) => [x.key, x.rows.map((r) => r.id)]), [['customerRevision', [o.id]], ['awaitingPrice', []], ['notOpened', []]]);
  assert.equal((await orderOf(o.id)).status, 'HAZIRLANIYOR');
}));
