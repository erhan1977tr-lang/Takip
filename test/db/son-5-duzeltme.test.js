// 3.77.0 — son beş düzeltme, veritabanıyla (karar 259, 260, 261, 262): silinen siparişin numarasının yeniden kullanımı,
// tireli müşteri numarası, metrajın 3 ondalığı (kayıt, yeniden açılış, yeni sürüm, yükleme onayı) ve normal / şekilli cam.
// Fabrika PDF'inin yeniden aktarımı (karar 263): test/db/pdf-import.test.js. Ağ yok (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { saveDraft } from '../../server/orders/drafts.js';
import { removeOrder, restoreOrder } from '../../server/orders/removal.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { offerLineTotals, offerTotals } from '../../server/orders/rules.js';
import { confirmLoading, previewLoading } from '../../server/loading/confirmation.js';
import { orderScope } from '../../server/orders/scope.js';

let db;
let firm;
let other;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
let fileNo = 0;
const files = () => { fileNo += 1; return [{ storageKey: `2026/10/s5-${fileNo}.pdf`, name: `s5-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: `s5${fileNo}`, scanStatus: 'CLEAN' }]; };
// Müşterinin kendi yazdığı numara (öneri değil): suggestedNo null → dolu numara DUPLICATE_NUMBER
const create = (no, f = firm, who = 'cust') => createGlassOrder(db, {
  actor: actor(people[who]), firm: f, title: `Sipariş ${no}`, requestedNo: no, suggestedNo: null,
  items: [{ glassName: '8mm Temperli', camAdedi: 1 }], files: files(),
});
const latest = async (orderId) => db.offer.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const versionOf = async (orderId) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).version;
/** Teklif tablosunun gönderdiği satır biçimi (kayıtlı satırdan) */
const formOf = (lines, extra = () => ({})) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), splitGroup: l.splitGroup, pieceM2: l.pieceM2 == null ? null : String(l.pieceM2), shaped: l.shaped, ...extra(l),
}));

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Alegrad SRL', prefix: 'ALE', email: 'office@ale-s5.test' } });
  other = await db.customer.create({ data: { name: 'Glassandmore SRL', prefix: 'GLA', email: 'office@gla-s5.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@s5.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('cust2', 'MUSTERI', other.id, { canApprove: true });
});
after(closeDb);

// ---------- 1) Silinen siparişin numarası (karar 260) ----------
dbTest('silinen siparişin numarası yeniden kullanılır; etkin siparişte tekillik sürer; diğer firma etkilenmez; geçmiş karışmaz; geri yükleme dolu numarayı reddeder', offline(async () => {
  const a = await create('40');
  assert.equal(a.orderNo, 'ALE40');
  assert.equal(await codeOf(create('40')), 'DUPLICATE_NUMBER', 'etkin siparişin numarası kullanılamaz');
  await db.orderNote.create({ data: { orderId: a.id, userId: people.cust.id, text: 'Eski siparişin notu', internal: false } });
  assert.deepEqual(await removeOrder(db, { orderId: a.id, confirmNo: 'ALE40', actor: actor(people.admin) }), { ok: true, orderNo: 'ALE40' });
  const removed = await db.order.findUniqueOrThrow({ where: { id: a.id } });
  assert.deepEqual([removed.orderNo, removed.customerOrderNo, removed.status, !!removed.removedAt, removed.numberActive], ['ALE40', '40', 'IPTAL', true, null], 'silinen sipariş ve numarası değişmez');

  // Aynı müşteri aynı numarayla yeniden sipariş açar (öneri değil, elle yazılmış numara)
  const b = await create('40');
  assert.deepEqual([b.orderNo, b.customerOrderNo, b.bumped, b.id !== a.id], ['ALE40', '40', false, true]);
  assert.equal(await codeOf(create('40')), 'DUPLICATE_NUMBER', 'yeni etkin sipariş numarayı yine tutar');
  // Geçmiş karışmaz: kayıtlar sipariş kimliğine bağlıdır; yeni sipariş yalnızca kendi kaydını taşır
  assert.deepEqual((await db.orderEvent.findMany({ where: { orderId: b.id } })).map((e) => e.event), ['CREATED']);
  assert.deepEqual((await db.orderEvent.findMany({ where: { orderId: a.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.event), ['CREATED', 'REMOVED']);
  assert.equal(await db.orderNote.count({ where: { orderId: b.id } }), 0);
  // Müşterinin listesinde yalnızca yeni sipariş (silinmiş sipariş hiçbir rolün kapsamında değildir)
  const mine = await db.order.findMany({ where: { ...orderScope({ appRole: 'MUSTERI', customerId: firm.id }), orderNo: 'ALE40' } });
  assert.deepEqual(mine.map((o) => o.id), [b.id]);
  // Diğer firma aynı numarayı kendi kodunda kullanır (etkilenmez)
  assert.equal((await create('40', other, 'cust2')).orderNo, 'GLA40');

  // Geri yükleme: numara artık yeni siparişte → reddedilir, eski sipariş silinmiş kalır
  assert.deepEqual(await restoreOrder(db, { orderId: a.id, actor: actor(people.admin) }), { ok: false, code: 'NUMBER_TAKEN', orderNo: 'ALE40' });
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: a.id } })).numberActive, null);
  // Yeni sipariş silinince eski geri yüklenebilir
  assert.equal((await removeOrder(db, { orderId: b.id, confirmNo: 'ALE40', actor: actor(people.admin) })).ok, true);
  assert.deepEqual(await restoreOrder(db, { orderId: a.id, actor: actor(people.admin) }), { ok: true, orderNo: 'ALE40', status: 'YENI' });
  assert.deepEqual(await db.order.findUniqueOrThrow({ where: { id: a.id }, select: { numberActive: true, removedAt: true } }), { numberActive: true, removedAt: null });

  // Öneri: yalnızca etkin, rakamlı numaralar (silinmiş en büyük numara öneriyi tutmaz)
  const c = await create('77');
  assert.equal(await suggestNextNo(db, firm.id), '78');
  await removeOrder(db, { orderId: c.id, confirmNo: 'ALE77', actor: actor(people.admin) });
  assert.equal(await suggestNextNo(db, firm.id), '41');
  // Veritabanı da iki etkin aynı numarayı kabul etmez (uygulama denetimini atlayan doğrudan yazım)
  await assert.rejects(db.order.create({ data: { orderNo: 'ALE40', customerOrderNo: '40', customerId: firm.id, createdById: people.cust.id } }), { code: 'P2002' });
}));

// ---------- 3) Tireli müşteri numarası (karar 259) ----------
dbTest('tireli numara: 40-1, 40-2, 001-1, ALE40-3 metin olarak saklanır; tekillik, öneri, taslak ve arama aynı değerle', offline(async () => {
  for (const v of ['40-1', '40-2', '001-1']) {
    const o = await create(v);
    assert.deepEqual([o.orderNo, o.customerOrderNo], [`ALE${v}`, v]);
  }
  const prefixed = await create('ALE40-3');
  assert.deepEqual([prefixed.orderNo, prefixed.customerOrderNo], ['ALE40-3', '40-3'], 'firmanın kendi kodu atılır');
  assert.equal(await codeOf(create('40-1')), 'DUPLICATE_NUMBER');
  assert.equal((await create('040-1')).orderNo, 'ALE040-1', 'baştaki sıfır ayrı numaradır');
  for (const bad of ['40--1', '-1', '0', 'GLA40-1', '4O-1', '40 1']) assert.equal(await codeOf(create(bad)), 'BAD_NUMBER', bad);
  // Tireli numaralar öneri sırasını değiştirmez
  const before = await suggestNextNo(db, firm.id);
  await create('999-1');
  assert.equal(await suggestNextNo(db, firm.id), before);
  // Kayıt metin: veritabanından okunan değer aynen
  const row = await db.order.findFirstOrThrow({ where: { customerId: firm.id, customerOrderNo: '001-1' } });
  assert.deepEqual([row.orderNo, typeof row.customerOrderNo], ['ALE001-1', 'string']);
  // Arama: yazıldığı gibi (eşit) — "1-1" ile "001-1" karışmaz
  assert.equal(await db.order.count({ where: { customerId: firm.id, customerOrderNo: { equals: '1-1' } } }), 0);
  // Taslak: aynı kural
  const d = await saveDraft(db, { actor: actor(people.cust), firm: { id: firm.id, prefix: 'ALE' }, draftId: null, values: { title: 'Taslak', note: '', customerOrderNo: 'ale12-7', lines: [] } });
  assert.equal((await db.orderDraft.findUniqueOrThrow({ where: { id: d.id } })).customerOrderNo, '12-7');
  assert.equal(await codeOf(saveDraft(db, { actor: actor(people.cust), firm: { id: firm.id, prefix: 'ALE' }, draftId: null, values: { title: 'x', note: '', customerOrderNo: '12--7', lines: [] } })), 'BAD_NUMBER');
}));

// ---------- 4) Metraj 3 ondalık + 5) Normal / Şekilli (karar 261, 262) ----------
dbTest('metraj ve şekilli cam: elle düzeltilen 3 ondalıklı metraj ve cam türü kaydedilir, yeniden açılışta, sonraki kayıtta ve yeni teklif sürümünde korunur; fiyat / POZ / ölçü / işlem değişmez; yükleme onayı 3 ondalığı saklar', offline(async () => {
  const o = await create('500');
  await run(o.id, 'no_drawing', 'sales');
  // İşlemli tek cam (karar 113): 1183 × 2017 = 2,386 m² (fabrikanın kuralı) + bir CNC
  const glass = { description: '8mm Temperli', poz: 'P-1', enMm: 1183, boyMm: 2017, adet: 1, unit: 'm2', unitPrice: '100.00', kind: 'CAM', free: false, pieceM2: '2.386', shaped: false };
  const cnc = { description: '', poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', unitPrice: '5.00', kind: 'CNC', free: false };
  await run(o.id, 'save_offer', 'sales', { lines: [glass, cnc] });
  let offer = await latest(o.id);
  assert.deepEqual(offer.lines.map((l) => [l.kind, l.pieceM2 == null ? null : Number(l.pieceM2), l.shaped]), [['CAM', 2.386, false], ['CNC', null, false]]);

  // Satış metrajı elle 2,387 yapar (3 ondalık) ve camı "Şekilli" seçer
  await run(o.id, 'save_offer', 'sales', { lines: formOf(offer.lines, (l) => (l.kind === 'CAM' ? { pieceM2: '2.387', shaped: true } : {})), expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  const before = offer.lines.map((l) => [l.id, String(l.unitPrice), l.poz, l.enMm, l.boyMm, l.adet, l.kind]);
  assert.deepEqual([Number(offer.lines[0].pieceM2), offer.lines[0].shaped], [2.387, true], 'Test D: normal → şekilli, kayıtta');
  assert.equal(offerLineTotals({ ...offer.lines[0], unitPrice: String(offer.lines[0].unitPrice) }).metraj, 2.387);
  // Yeniden açılış (form alanları gelmeyen eski istemci): kayıtlı metraj ve tür sessizce değişmez
  const bare = formOf(offer.lines).map(({ pieceM2: _p, shaped: _s, ...rest }) => rest);
  await run(o.id, 'save_offer', 'sales', { lines: bare, expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  assert.deepEqual([Number(offer.lines[0].pieceM2), offer.lines[0].shaped], [2.387, true]);
  // Test C: şekilli → normal; Test E: fiyat, POZ, ölçü, adet, işlem satırı değişmez
  await run(o.id, 'save_offer', 'sales', { lines: formOf(offer.lines, (l) => (l.kind === 'CAM' ? { shaped: false } : {})), expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  assert.equal(offer.lines[0].shaped, false, 'Test C: şekilli → normal, kayıtta');
  assert.deepEqual(offer.lines.map((l) => [l.id, String(l.unitPrice), l.poz, l.enMm, l.boyMm, l.adet, l.kind]), before, 'Test E');
  assert.equal(Number(offer.lines[0].pieceM2), 2.387);
  await run(o.id, 'save_offer', 'sales', { lines: formOf(offer.lines, (l) => (l.kind === 'CAM' ? { shaped: true } : {})), expectedVersion: await versionOf(o.id) });

  // Gönderim ve yeni sürüm: parça m²si ve tür taşınır; müşteri tutarı 3 ondalıklı m²den, fiyat yuvarlaması aynı
  offer = await latest(o.id);
  await run(o.id, 'submit_offer', 'sales', { lines: formOf(offer.lines), expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  await run(o.id, 'approve_offer', 'admin', { lines: formOf(offer.lines, (l) => ({ offerPrice: l.kind === 'CAM' ? '150.00' : '9.00' })), expectedVersion: await versionOf(o.id) });
  const sent = await latest(o.id);
  assert.deepEqual([sent.status, String(sent.offerAmount), String(sent.amount)], ['GONDERILDI', '367.05', '243.7'], '2,387 × 150 = 358,05 + 9 · 2,387 × 100 = 238,70 + 5');
  await run(o.id, 'update_offer', 'admin', { lines: formOf(sent.lines, (l) => ({ offerPrice: l.kind === 'CAM' ? '151.00' : '9.00' })), expectedVersion: await versionOf(o.id) });
  const v2 = await latest(o.id);
  assert.notEqual(v2.id, sent.id);
  assert.deepEqual(v2.lines.map((l) => [l.pieceM2 == null ? null : Number(l.pieceM2), l.shaped, l.poz, l.enMm, l.boyMm, String(l.unitPrice)]), [[2.387, true, 'P-1', 1183, 2017, '100'], [null, false, null, null, null, '5']]);
  assert.equal(offerTotals(v2.lines.map((l) => ({ ...l, unitPrice: String(l.offerPrice) }))).metraj, 2.387);

  // Yükleme onayı: kalem parça m²sini ve 3 ondalıklı m²yi saklar (DECIMAL(12,3))
  const day = dayOf(-3);
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  const preview = await previewLoading(db, day);
  assert.equal((await confirmLoading(db, { day, key: preview.key, actor: actor(people.admin) })).ok, true);
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId: o.id }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(items.map((i) => [i.kind, String(i.m2), i.pieceM2 == null ? null : Number(i.pieceM2)]), [['CAM', '2.387', 2.387], ['CNC', '0', null]]);
}));
