// Cam kataloğu (Excel yükleme, düzenleme) ve taslak sipariş — veritabanıyla (Aşama 3).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { applyCatalogImport, changeGlass, glassOrderItems, saveGlass, validateGlass } from '../../server/catalog/glass.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { deleteDraft, isLegacyMultiGlass, keepDraftGlass, readDraftItems, saveDraft } from '../../server/orders/drafts.js';

let db;
let admin;
let cust;
let other;
let firm;
let otherFirm;
const actor = (u) => ({ id: u.id, role: u.appRole, ip: '10.0.0.1' });
const glass = (nameTr, colorTr, extra = {}) => validateGlass({ nameTr, colorTr, nameRo: `${nameTr} RO`, colorRo: colorTr, weightKgM2: 25, ...extra }).value;
let n = 0;
const file = () => ({ storageKey: `2026/09/taslak-${++n}.pdf`, name: `dosya-${n}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  otherFirm = await db.customer.create({ data: { name: 'Alegrad', prefix: 'ALE' } });
  admin = await db.user.create({ data: { email: 'y@k.test', name: 'Y', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  cust = await db.user.create({ data: { email: 'm@k.test', name: 'M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id } });
  other = await db.user.create({ data: { email: 'o@k.test', name: 'O', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: otherFirm.id } });
});
after(closeDb);

dbTest('katalog: Excel yüklemesi ekler, günceller, dosyadakine göre sıralar; dosyada olmayana dokunmaz; denetime yazar', async () => {
  const eski = await db.glassProduct.create({ data: { nameTr: 'ESKİ CAM', nameRo: 'VECHE', weightKgM2: 10, sortOrder: 5 } });
  const r1 = await applyCatalogImport(db, [glass('8 MM', 'ŞEFFAF'), glass('10 MM', 'BRONZ')], actor(admin));
  assert.deepEqual(r1, { created: 2, updated: 0, unchanged: 0, untouched: 1 });
  const r2 = await applyCatalogImport(db, [glass('10 mm', 'bronz', { weightKgM2: 26 }), glass('8 MM', 'ŞEFFAF'), glass('6 MM', '', { isActive: 'Hayır' })], actor(admin));
  assert.deepEqual(r2, { created: 1, updated: 1, unchanged: 1, untouched: 1 });
  const list = await db.glassProduct.findMany({ orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(list.map((g) => [g.nameTr, g.colorTr, Number(g.weightKgM2), g.isActive]), [
    ['10 mm', 'bronz', 26, true], ['8 MM', 'ŞEFFAF', 25, true], ['6 MM', '', 25, false], ['ESKİ CAM', '', 10, true],
  ]);
  assert.equal((await db.glassProduct.findUnique({ where: { id: eski.id } })).nameRo, 'VECHE');
  const a = await db.auditLog.findMany({ where: { action: 'GLASS_IMPORT' }, orderBy: { createdAt: 'asc' } });
  assert.equal(a.length, 2);
  assert.deepEqual([a[1].actorRole, a[1].ip, a[1].details.counts.updated], ['ADMIN', '10.0.0.1', 1]);
  assert.deepEqual(a[1].details.changed[0].fields, ['nameTr', 'colorTr', 'nameRo', 'colorRo', 'weightKgM2']);
});

dbTest('katalog: aynı Türkçe ad + renk ikinci kez eklenemez; düzenleme ve pasifleştirme denetime önce/sonra yazılır', async () => {
  assert.deepEqual(await saveGlass(db, null, glass('8 mm', 'şeffaf'), actor(admin)), { ok: false, code: 'EXISTS' });
  const g = await db.glassProduct.findFirstOrThrow({ where: { nameTr: '8 MM' } });
  assert.ok((await saveGlass(db, g.id, glass('8 MM', 'ŞEFFAF', { nameRo: 'STICLĂ 8' }), actor(admin))).ok);
  assert.ok(await changeGlass(db, g.id, 'toggle', actor(admin)));
  const logs = await db.auditLog.findMany({ where: { action: 'GLASS_UPDATE', entityId: g.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(logs.map((l) => l.details.fields), [['nameRo'], ['isActive']]);
  assert.deepEqual([logs[0].details.before.nameRo, logs[0].details.after.nameRo], ['8 MM RO', 'STICLĂ 8']);
  assert.equal(await changeGlass(db, 'yok', 'toggle', actor(admin)), false);
});

dbTest('sipariş: cam adı ve ağırlığı sipariş anındaki haliyle kalır (katalog sonradan değişse de)', async () => {
  const g = await db.glassProduct.findFirstOrThrow({ where: { nameTr: '10 mm' } });
  const res = glassOrderItems([{ id: g.id, qty: '4' }], [g]);
  const next = await suggestNextNo(db, firm.id);
  const o = await createGlassOrder(db, { actor: actor(cust), firm, title: 'Kopya', requestedNo: next, suggestedNo: next, items: res.items, files: [file()] });
  await saveGlass(db, g.id, glass('10 MM YENİ', 'BRONZ', { nameRo: 'NOU', weightKgM2: 40 }), actor(admin));
  const it = await db.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
  assert.deepEqual([it.glassName, it.glassNameRo, Number(it.glassWeightKgM2), it.camAdedi, it.glassProductId], ['10 mm — bronz', '10 mm RO — bronz', 26, 4, g.id]);
});

dbTest('taslak: kaydedilir, dosya çıkarılır/eklenir; gönderilince dosyalar ve not siparişe geçer, taslak silinir', async () => {
  const g = await db.glassProduct.findFirstOrThrow({ where: { nameTr: '8 MM' } });
  const f1 = file();
  const f2 = file();
  const d = await saveDraft(db, { actor: actor(cust), firm, draftId: null, values: { title: '', note: '', customerOrderNo: null, lines: [] }, files: [f1, f2] });
  const row = await db.orderDraft.findUniqueOrThrow({ where: { id: d.id }, include: { files: true } });
  assert.deepEqual([row.title, row.customerOrderNo, row.files.length], [null, null, 2]);
  const drop = row.files.find((f) => f.storageKey === f1.storageKey);
  const d2 = await saveDraft(db, {
    actor: actor(cust), firm, draftId: d.id,
    values: { title: 'Duş', note: 'Kenarlar rodajlı', customerOrderNo: 900, lines: [{ id: g.id, qty: '2' }] }, files: [file()], removeFileIds: [drop.id],
  });
  assert.deepEqual(d2.removed.map((f) => f.storageKey), [f1.storageKey], 'çıkarılan dosya diskten silinmek üzere döner');
  const saved = await db.orderDraft.findUniqueOrThrow({ where: { id: d.id }, include: { files: true } });
  assert.deepEqual([saved.title, saved.note, saved.customerOrderNo, saved.items, saved.files.length], ['Duş', 'Kenarlar rodajlı', 900, [{ glassProductId: g.id, qty: 2 }], 2]);
  // Taslak satışın listesinde değildir: sipariş sayısı değişmez
  const before = await db.order.count();
  // Başka firma taslağı göremez / gönderemez / silemez
  assert.equal(await codeOf(saveDraft(db, { actor: actor(other), firm: otherFirm, draftId: d.id, values: { title: 'x', note: '', customerOrderNo: null, lines: [] } })), 'DRAFT_GONE');
  assert.equal(await deleteDraft(db, { firm: otherFirm, draftId: d.id }), null);
  // Taslaktaki cam bu arada pasifleşti (önceki test): gönderimde reddedilir; müşteri etkin bir cam seçer.
  // (Eskiden bu sonuç denetlenmiyordu ve kalemsiz sipariş açılabiliyordu; artık sipariş tam bir cam ister — karar 85.)
  assert.deepEqual(glassOrderItems([{ id: g.id, qty: '2' }], [g]), { ok: false, code: 'GLASS_GONE' });
  const active = await db.glassProduct.findFirstOrThrow({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  const res = glassOrderItems([{ id: active.id, qty: '2' }], [active]);
  assert.ok(res.ok);
  const keep = saved.files.find((f) => f.storageKey === f2.storageKey);
  const other2 = saved.files.find((f) => f.id !== keep.id);
  assert.equal(await codeOf(createGlassOrder(db, { actor: actor(other), firm: otherFirm, title: 'x', requestedNo: 1, items: res.items, draftId: d.id })), 'DRAFT_GONE');
  const o = await createGlassOrder(db, {
    actor: actor(cust), firm, title: 'Duş', requestedNo: 900, items: res.items, note: 'Kenarlar rodajlı', draftId: d.id, dropDraftFileIds: [other2.id],
  });
  assert.equal(o.orderNo, 'GLA900');
  assert.deepEqual(o.dropped.map((f) => f.id), [other2.id]);
  assert.deepEqual((await db.orderItem.findMany({ where: { orderId: o.id } })).map((i) => [i.glassProductId, i.camAdedi]), [[active.id, 2]], 'siparişte tam bir cam');
  assert.equal(await db.order.count(), before + 1);
  assert.equal(await db.orderDraft.count({ where: { id: d.id } }), 0);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { files: true, notes: true } });
  assert.deepEqual(order.files.map((f) => [f.storageKey, f.uploadedById]), [[f2.storageKey, cust.id]]);
  assert.deepEqual(order.notes.map((x) => [x.text, x.internal]), [['Kenarlar rodajlı', false]]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_CREATE', entityId: o.id } });
  assert.equal(audit.details.fromDraft, true);
});

dbTest('taslak: dosyasız sipariş gönderilemez; taslak silinince dosyaları döner', async () => {
  const d = await saveDraft(db, { actor: actor(cust), firm, draftId: null, values: { title: 'Boş', note: '', customerOrderNo: null, lines: [] } });
  const one = [{ glassName: 'Cam', camAdedi: 1 }];
  assert.equal(await codeOf(createGlassOrder(db, { actor: actor(cust), firm, title: 'Boş', requestedNo: 950, items: one, draftId: d.id })), 'NO_FILES');
  assert.equal(await db.orderDraft.count({ where: { id: d.id } }), 1, 'başarısız gönderimde taslak kalır');
  const f = file();
  await saveDraft(db, { actor: actor(cust), firm, draftId: d.id, values: { title: 'Boş', note: '', customerOrderNo: null, lines: [] }, files: [f] });
  assert.deepEqual((await deleteDraft(db, { firm, draftId: d.id })).map((x) => x.storageKey), [f.storageKey]);
  assert.equal(await db.orderDraft.count({ where: { id: d.id } }), 0);
});

dbTest('eski çok camlı taslak: bakmak değiştirmez; çözülmeden gönderilemez ve formla ezilemez; açık seçimle tek cama iner (karar 86)', async () => {
  const [a, b] = await db.glassProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, take: 2 });
  const gone = await db.glassProduct.findFirstOrThrow({ where: { isActive: false } });
  assert.ok(a && b, 'iki etkin cam var');
  // Tek cam kuralından önce kaydedilmiş taslak gibi: üç cam satırı, dosya, not, müşterinin numarası
  const f = file();
  const legacy = await saveDraft(db, {
    actor: actor(cust), firm, draftId: null, files: [f],
    values: { title: 'Eski taslak', note: 'Eski not', customerOrderNo: 777, lines: [{ id: a.id, qty: '2' }, { id: b.id, qty: '5' }, { id: gone.id, qty: '1' }] },
  });
  const all = [{ glassProductId: a.id, qty: 2 }, { glassProductId: b.id, qty: 5 }, { glassProductId: gone.id, qty: 1 }];
  const snap = async () => {
    const d = await db.orderDraft.findUniqueOrThrow({ where: { id: legacy.id }, include: { files: { orderBy: { createdAt: 'asc' } } } });
    return JSON.stringify([d.title, d.note, d.customerOrderNo, d.items, d.updatedAt, d.customerId, d.createdById, d.files.map((x) => [x.id, x.storageKey, x.name])]);
  };
  const before = await snap();
  // Eski, gönderilmiş çok camlı sipariş: bu işlemlerden hiç etkilenmemeli
  const old = await createGlassOrder(db, { actor: actor(cust), firm, title: 'Eski sipariş', requestedNo: 960, items: [{ glassName: 'A', camAdedi: 1 }], files: [file()] });
  await db.orderItem.create({ data: { orderId: old.id, glassName: 'B', camAdedi: 3 } });
  const oldItems = async () => JSON.stringify(await db.orderItem.findMany({ where: { orderId: old.id }, orderBy: { camAdedi: 'asc' } }));
  const oldBefore = await oldItems();
  const orders = await db.order.count();

  // 1) Sayfanın yaptığı okuma: tanınır, bütün camlar okunur, hiçbir şey yazılmaz
  const row = await db.orderDraft.findFirst({ where: { id: legacy.id, customerId: firm.id }, include: { files: true } });
  assert.equal(isLegacyMultiGlass(row.items), true);
  assert.deepEqual(readDraftItems(row.items), all, 'hiçbir cam gizlenmez');
  assert.equal(await snap(), before, 'bakmak taslağı değiştirmez');

  // 2) Çözülmeden gönderilemez; normal formun kaydı da camları ezemez
  const oneItem = glassOrderItems([{ id: a.id, qty: '2' }], [a]).items;
  assert.equal(await codeOf(createGlassOrder(db, { actor: actor(cust), firm, title: 'Eski taslak', requestedNo: 777, items: oneItem, draftId: legacy.id })), 'DRAFT_LEGACY_GLASS');
  assert.equal(await codeOf(saveDraft(db, { actor: actor(cust), firm, draftId: legacy.id, values: { title: 'x', note: '', customerOrderNo: null, lines: [{ id: a.id, qty: '1' }] } })), 'DRAFT_LEGACY_GLASS');
  assert.equal(await codeOf(saveDraft(db, { actor: actor(cust), firm, draftId: legacy.id, values: { title: 'x', note: '', customerOrderNo: null, lines: [] } })), 'DRAFT_LEGACY_GLASS');
  // 3) Geçersiz seçim: başka firma, listede olmayan cam, sıra ile cam uyuşmuyor
  const keep = (who, f2, index, glassProductId) => keepDraftGlass(db, { actor: actor(who), firm: f2, draftId: legacy.id, index, glassProductId });
  assert.equal(await codeOf(keep(other, otherFirm, 1, b.id)), 'DRAFT_GONE');
  assert.equal(await codeOf(keep(cust, firm, 1, a.id)), 'GLASS_NOT_IN_DRAFT');
  assert.equal(await codeOf(keep(cust, firm, 9, b.id)), 'GLASS_NOT_IN_DRAFT');
  assert.equal(await codeOf(keep(cust, firm, NaN, b.id)), 'GLASS_NOT_IN_DRAFT');
  assert.equal(await snap(), before, 'reddedilen işlemler taslağı değiştirmez');
  assert.equal(await db.order.count(), orders);
  assert.equal(await db.auditLog.count({ where: { action: 'DRAFT_GLASS_KEPT' } }), 0);

  // 4) Açık seçim: yalnızca seçilen cam kalır; dosya, not, ad, numara ve taslak kimliği aynı
  const res = await keep(cust, firm, 1, b.id);
  assert.deepEqual([res.id, res.kept, res.dropped], [legacy.id, all[1], [all[0], all[2]]]);
  const d = await db.orderDraft.findUniqueOrThrow({ where: { id: legacy.id }, include: { files: true } });
  assert.deepEqual([d.items, d.title, d.note, d.customerOrderNo, d.files.map((x) => x.storageKey)], [[all[1]], 'Eski taslak', 'Eski not', 777, [f.storageKey]]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'DRAFT_GLASS_KEPT', entityId: legacy.id } });
  assert.deepEqual([audit.userId, audit.actorRole, audit.details.kept, audit.details.dropped], [cust.id, 'MUSTERI', all[1], [all[0], all[2]]], 'çıkan camlar denetim kaydında');
  assert.equal(await codeOf(keep(cust, firm, 0, b.id)), 'DRAFT_NOT_LEGACY', 'artık normal taslak');
  assert.equal(await oldItems(), oldBefore, 'gönderilmiş eski çok camlı sipariş değişmedi');

  // 5) Sonrası normal tek cam akışı: taslak kaydedilir ve gönderilir
  assert.equal(await codeOf(saveDraft(db, { actor: actor(cust), firm, draftId: legacy.id, values: { title: 'Eski taslak', note: 'Eski not', customerOrderNo: 777, lines: [{ id: b.id, qty: '5' }] } })), 'OK');
  const items = glassOrderItems([{ id: b.id, qty: '5' }], [b]).items;
  const o = await createGlassOrder(db, { actor: actor(cust), firm, title: 'Eski taslak', requestedNo: 777, items, note: 'Eski not', draftId: legacy.id });
  assert.equal(o.orderNo, 'GLA777');
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { items: true, files: true } });
  assert.deepEqual([order.items.map((i) => [i.glassProductId, i.camAdedi]), order.files.map((x) => x.storageKey)], [[[b.id, 5]], [f.storageKey]]);
  assert.equal(await oldItems(), oldBefore);
});

dbTest('normal tek camlı taslak değişmedi: eski taslak sayılmaz, kaydedilir, güncellenir ve gönderilir', async () => {
  const g = await db.glassProduct.findFirstOrThrow({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  const f = file();
  const d = await saveDraft(db, { actor: actor(cust), firm, draftId: null, files: [f], values: { title: 'Yeni', note: '', customerOrderNo: null, lines: [{ id: g.id, qty: '3' }] } });
  const row = await db.orderDraft.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(isLegacyMultiGlass(row.items), false);
  assert.deepEqual(row.items, [{ glassProductId: g.id, qty: 3 }]);
  assert.equal(await codeOf(keepDraftGlass(db, { actor: actor(cust), firm, draftId: d.id, index: 0, glassProductId: g.id })), 'DRAFT_NOT_LEGACY');
  assert.equal(await codeOf(saveDraft(db, { actor: actor(cust), firm, draftId: d.id, values: { title: 'Yeni 2', note: 'n', customerOrderNo: null, lines: [{ id: g.id, qty: '4' }] } })), 'OK');
  assert.deepEqual((await db.orderDraft.findUniqueOrThrow({ where: { id: d.id } })).items, [{ glassProductId: g.id, qty: 4 }]);
  const next = await suggestNextNo(db, firm.id);
  const o = await createGlassOrder(db, { actor: actor(cust), firm, title: 'Yeni 2', requestedNo: next, suggestedNo: next, items: glassOrderItems([{ id: g.id, qty: '4' }], [g]).items, draftId: d.id });
  assert.deepEqual((await db.orderItem.findMany({ where: { orderId: o.id } })).map((i) => [i.glassProductId, i.camAdedi]), [[g.id, 4]]);
  assert.equal(await db.orderDraft.count({ where: { id: d.id } }), 0);
});
