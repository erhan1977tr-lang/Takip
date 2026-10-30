// Fabrika PDF'i aktarımı (karar 255) — veritabanıyla: kayıt, ön izleme, aktarma, mükerrer / yanlış müşteri / yanlış proje,
// yetki (yönetici ve satış evet; müşteri, denetimci, çizim hayır), satışın düzenlemesi ve elle "Yöneticiye gönder",
// antivirüs taraması, yükleme kotası ve dosya temizliği. Fikstürler sentetiktir (test/fixtures/factory-pdf.js).
// Ağ yok (offline): FGO / SMTP / çeviri çağrılmaz. pdf.js yerine çıkarma adımı enjekte edilir (satırlar fikstürden).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { importPreview, importTarget, recordUploads, emptyGlassLines } from '../../server/orders/pdf-import/service.js';
import { scanPending } from '../../server/files/antivirus.js';
import { checkUpload, UPLOAD_LIMITS } from '../../server/files/limits.js';
import { removeOrphanFiles } from '../../server/customers/deletion.js';
import { eventsFor } from '../../server/orders/order-view.js';
import { DESC_BRONZE, DESC_NORMAL, DESC_SHAPED, DESC_TENTESOL, DESC_UC_838, DOT_FORM_1, DOT_FORM_3, FORM_CNC, dotForm, form, itemsOf, shapedForm } from '../fixtures/factory-pdf.js';
import { offerTotals } from '../../server/orders/rules.js';

let db;
let firm;
let other;
const g = {};
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = (p) => p.then(() => 'OK', (e) => e.code ?? e.message);

// "PDF" dosyaları: depolama anahtarı → sentetik satırlar (çıkarma adımı enjekte edilir; pdf.js birim testinde)
const FILES = new Map();
let seq = 0;
function pdf(lines, checksum = null) {
  seq += 1;
  const key = `2026/10/fab-${seq}.pdf`;
  FILES.set(key, lines);
  return { storageKey: key, name: `fabrika-${seq}.pdf`, size: 1000 + seq, mime: 'application/pdf', checksum: checksum ?? `sum-${seq}`, scanStatus: 'CLEAN', scannedAt: new Date() };
}
const readFile = async (key) => new TextEncoder().encode(key);
const extract = async (data) => {
  const lines = FILES.get(new TextDecoder().decode(data));
  return lines ? { ok: true, items: itemsOf(lines) } : { ok: false, error: 'UNREADABLE' };
};
const upload = (who, orderId, files) => recordUploads(db, { actor: actor(people[who]), orderId, stored: files, readFile, extract });
const preview = (who, orderId, ids, choices = {}) => importPreview(db, { actor: actor(people[who]), orderId, importIds: ids, choices, locale: 'tr' });
const apply = (who, orderId, version, imports, extra = {}) => run(orderId, 'import_offer_pdf', who, { imports, choices: {}, dropEmpty: [], expectedVersion: version, ...extra });
const fp = (p) => p.imports.map((i) => ({ id: i.id, fingerprint: i.fingerprint }));
const latest = async (orderId) => db.offer.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const versionOf = async (orderId) => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).version;

let fileNo = 0;
async function newOrder(no, f = firm, glass = g.ref) {
  fileNo += 1;
  const o = await createGlassOrder(db, {
    actor: actor(f === firm ? people.cust : people.cust2), firm: f, title: `Proje ${no}`, requestedNo: no, suggestedNo: null,
    items: [{ glassProductId: glass.id, glassName: `${glass.nameTr} — ${glass.colorTr}`, glassNameRo: glass.nameRo, glassWeightKgM2: 30, camAdedi: 0 }],
    files: [{ storageKey: `2026/10/cust-${fileNo}.pdf`, name: `musteri-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: `c${fileNo}`, scanStatus: 'CLEAN' }],
  });
  await run(o.id, 'no_drawing', 'sales');
  return o;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Musterix Test SRL', prefix: 'ABC', email: 'office@abc-pdf.test' } });
  other = await db.customer.create({ data: { name: 'Baska Firma SRL', prefix: 'XYZ', email: 'office@xyz-pdf.test' } });
  g.ref = await db.glassProduct.create({ data: { nameTr: '6.3.6 Temperli Lamine', colorTr: 'Füme Reflekte-Şeffaf', nameRo: 'Sticlă 6.3.6.', colorRo: 'Gri reflectiv-Transparent', weightKgM2: 30 } });
  g.brz = await db.glassProduct.create({ data: { nameTr: '6.3.6 Temperli Lamine', colorTr: 'Bronz-Şeffaf', nameRo: 'Sticlă 6.3.6.', colorRo: 'Bronz-Transparent', weightKgM2: 30 } });
  // 4.2.11: noktalı ondalık biçimli PDF'lerin (ALE106 / ALE107 eşdeğeri) camları
  g.uc838 = await db.glassProduct.create({ data: { nameTr: '8.3.8 Temperli Lamine', colorTr: 'Ultra Clear', nameRo: 'STICLĂ SECURIZATĂ LAMINATĂ 8.3.8.', colorRo: 'Extra clar', weightKgM2: 40 } });
  g.duz8 = await db.glassProduct.create({ data: { nameTr: '8 mm Temperli', colorTr: 'Şeffaf', nameRo: 'Sticlă securizată 8 mm', colorRo: 'Transparent', weightKgM2: 20 } });
  const table = await db.priceTable.create({ data: { name: 'Satış 2026', currency: 'EUR', isDefault: true, cncPrice: 6, holePrice: 3, items: { create: [{ glassProductId: g.ref.id, unitPrice: 95 }] } } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@pdf.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id, { priceTableId: table.id });
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('cust2', 'MUSTERI', other.id, { canApprove: true });
});
after(closeDb);

dbTest('tek + çoklu PDF (aynı proje): ön izleme → onay → satırlar sona eklenir; alış fiyatı satış fiyatında, müşteri fiyatı boş; teklif yöneticiye gitmez', offline(async () => {
  const o = await newOrder(40);
  const before = await latest(o.id);
  assert.equal(before.lines.length, 1, 'müşterinin camından açılan ölçüsüz ilk satır');
  const second = form({ no: '90002', rows: [`1 ${DESC_TENTESOL}`, '2000 1000 1 2,000 2,000 100,00 TL 0,0 200,00 ABC 40'], total: '1 2,000 200,00', sub: '200,00', grand: '240,00' });
  const up = await upload('sales', o.id, [pdf(FORM_CNC), pdf(second)]);
  assert.equal(up.ok, true);
  assert.equal(up.ids.length, 2);
  const p = await preview('sales', o.id, up.ids);
  assert.equal(p.ok, true);
  assert.deepEqual(p.imports.map((i) => [i.factoryNo, i.blocking, i.warnings.map((w) => w.code)]), [
    ['90001', [], []], ['90002', [], []],
  ]);
  // m² PDF'ten 3 ondalıkla aynen (karar 261): 1,235 m² × 100 = 123,50 — 2 ondalığa yuvarlamadan doğan fark yok
  assert.deepEqual(p.imports[0].plan.checks.b, { takipTotal: 43350, pdfSum: 43350, subtotal: 43350, diff: 0, explained: true });
  assert.ok(!JSON.stringify(p).includes('MUSTERIX'), 'proje metni (müşteri adı) satışa dönmez');
  assert.deepEqual(p.empty.map((e) => e.id), [before.lines[0].id]);
  // Önizleme hiçbir şey yazmaz
  assert.equal((await latest(o.id)).lines.length, 1);

  await apply('sales', o.id, await versionOf(o.id), fp(p), { dropEmpty: [before.lines[0].id] });
  const offer = await latest(o.id);
  assert.equal(offer.status, 'HAZIRLANIYOR', 'yöneticiye gönderilmedi');
  assert.deepEqual(offer.lines.map((l) => [l.kind, l.description, l.poz, l.enMm, l.boyMm, l.adet, String(l.unitPrice), l.offerPrice, l.sourceRow, l.glassProductId]), [
    ['CAM', '6.3.6 Temperli Lamine — Füme Reflekte-Şeffaf', 'ABC 40', 3000, 1000, 1, '100', null, 1, g.ref.id],
    ['CNC', 'CNC İŞLEMİ', '', null, null, 1, '5', null, 1, null],
    ['CAM', '6.3.6 Temperli Lamine — Füme Reflekte-Şeffaf', 'ABC 40', 1235, 1000, 1, '100', null, 2, g.ref.id],
    ['CNC', 'CNC İŞLEMİ', '', null, null, 1, '5', null, 2, null],
    ['CAM', '6.3.6 Temperli Lamine — Füme Reflekte-Şeffaf', 'ABC 40', 2000, 1000, 1, '100', null, 1, g.ref.id],
  ]);
  // Liste fiyatı (fiyat tablosu) karşılaştırma için durur: 95 / CNC 6 — fark gönderimde "Önemli kararlar"a düşer
  assert.deepEqual(offer.lines.map((l) => (l.listPrice == null ? null : Number(l.listPrice))), [95, 6, 95, 6, 95]);
  assert.equal(String(offer.amount), '633.5', 'TAKİP hesabı: 300 + 123,50 + 10 + 200 (PDF m²’si aynen — karar 261)');
  assert.deepEqual(offer.lines.map((l) => (l.pieceM2 == null ? null : Number(l.pieceM2))), [3, null, 1.235, null, 2]);
  // Özgün PDF saklanmaz: kayıt dosyasız, okunan her dosya silinmek üzere döner; ayrıştırılmış kopya ve özet durur
  assert.deepEqual(up.discard.map((d) => d.storageKey).sort(), [...FILES.keys()].slice(-2).sort());
  const imports = await db.offerImport.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(imports.map((i) => [i.storageKey, !!i.parsed, i.checksum.length > 0, i.name.endsWith('.pdf')]), [[null, true, true, true], [null, true, true, true]]);
  assert.deepEqual(imports.map((i) => [i.status, i.offerId, !!i.appliedAt, i.appliedById, !!i.fingerprint]), [['APPLIED', offer.id, true, people.sales.id, true], ['APPLIED', offer.id, true, people.sales.id, true]]);
  assert.deepEqual(new Set(offer.lines.map((l) => l.importId)), new Set(imports.map((i) => i.id)));
  const ev = await db.orderEvent.findMany({ where: { orderId: o.id, event: 'OFFER_PDF_IMPORTED' } });
  assert.deepEqual(ev.map((e) => e.note), ['90001, 90002']);
  const audit = await db.auditLog.findFirst({ where: { entityId: o.id, action: 'ORDER_TRANSITION' }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit.details.action, 'import_offer_pdf');
  assert.deepEqual(audit.details.pdfImport.map((x) => [x.factoryNo, x.lines, x.subtotal, x.rowSum, x.subtotalDiff, x.takipTotal, x.diff]), [['90001', 4, 43350, 43350, 0, 43350, 0], ['90002', 1, 20000, 20000, 0, 20000, 0]]);
  // Geçmiş satırı yalnızca teklif hazırlayanlara (çizim / denetimci / müşteri görmez)
  for (const [role, seen] of [['ADMIN', true], ['SATIS', true], ['CIZIM', false], ['DENETIMCI', false], ['MUSTERI', false]]) {
    assert.equal(eventsFor(role, ev).length === 1, seen, role);
  }
}));

dbTest('mükerrer: aynı dosya bir kez kaydedilir; aynı fabrika no (satırları teklifte) ikinci kez aktarılmaz; başka siparişe hiç', offline(async () => {
  const o = await newOrder(41);
  const lines = form({ no: '91001', project: 'MUSTERIX ABC 41', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 41'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' });
  const a = await upload('sales', o.id, [pdf(lines, 'same-sum')]);
  const p = await preview('sales', o.id, a.ids);
  await apply('sales', o.id, await versionOf(o.id), fp(p));
  // Aynı dosya (aynı SHA-256): yeni kayıt yok, yeni saklanan dosya silinmek üzere döner
  const again = await upload('sales', o.id, [pdf(lines, 'same-sum')]);
  assert.deepEqual(again.ids, a.ids);
  assert.equal(again.discard.length, 1);
  assert.deepEqual((await preview('sales', o.id, again.ids)).imports[0].blocking.map((b) => b.code), ['ALREADY_IMPORTED']);
  // Farklı dosya, aynı fabrika numarası → bu teklifte zaten var
  const copy = await upload('sales', o.id, [pdf(lines)]);
  const cp = await preview('sales', o.id, copy.ids);
  assert.deepEqual(cp.imports[0].blocking.map((b) => b.code), ['DUPLICATE_FACTORY_ORDER']);
  assert.equal(await codeOf(apply('sales', o.id, await versionOf(o.id), fp(cp))), 'PDF_IMPORT_BLOCKED');
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 1, 'mükerrer satır yok');
  // Bir aktarımda iki PDF aynı numarayı taşıyamaz
  const o2 = await newOrder(42);
  const l42 = form({ no: '91002', project: 'MUSTERIX ABC 42', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 42'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' });
  const twin = await upload('sales', o2.id, [pdf(l42), pdf(l42)]);
  assert.ok((await preview('sales', o2.id, twin.ids)).imports.every((i) => i.blocking.some((b) => b.code === 'DUPLICATE_IN_BATCH')));
  // Başka siparişe aktarılmış fabrika numarası: o siparişin numarasıyla reddedilir
  const elsewhere = await upload('sales', o2.id, [pdf(form({ no: '91001', project: 'MUSTERIX ABC 42', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 42'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' }))]);
  const ep = await preview('sales', o2.id, elsewhere.ids);
  assert.deepEqual(ep.imports[0].blocking, [{ code: 'FACTORY_ORDER_ON_OTHER', factoryNo: '91001', orderNo: 'ABC41' }]);
}));

dbTest('yanlış müşteri / yanlış proje / bozuk PDF / sipariş camıyla uyuşmayan cam aktarılmaz; hiçbir satır yazılmaz', offline(async () => {
  const o = await newOrder(43);
  const rows = [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 43'];
  const up = await upload('sales', o.id, [
    pdf(form({ no: '92001', project: 'BASKA XYZ 43', rows, total: '1 1,000 100,00', sub: '100,00', grand: '120,00' })),
    pdf(form({ no: '92002', project: 'MUSTERIX ABC 44', rows, total: '1 1,000 100,00', sub: '100,00', grand: '120,00' })),
    { ...pdf([]), storageKey: 'yok/kayıp.pdf' },
    pdf(form({ no: '92004', project: 'MUSTERIX ABC 43', rows: [`1 ${DESC_BRONZE}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 43'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' })),
  ]);
  const p = await preview('sales', o.id, up.ids);
  assert.deepEqual(p.imports.map((i) => i.blocking.map((b) => b.code)), [['WRONG_CUSTOMER'], ['WRONG_PROJECT'], ['PDF_UNREADABLE'], ['GLASS_ORDER_MISMATCH']]);
  for (const one of p.imports) {
    assert.equal(await codeOf(apply('sales', o.id, await versionOf(o.id), [{ id: one.id, fingerprint: one.fingerprint ?? '' }])), 'PDF_IMPORT_BLOCKED');
  }
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 0);
}));

dbTest('eski ön izleme / sipariş sürümü değiştiyse aktarma reddedilir (yarım kayıt yok)', offline(async () => {
  const o = await newOrder(45);
  const up = await upload('sales', o.id, [pdf(form({ no: '93001', project: 'MUSTERIX ABC 45', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 45'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' }))]);
  const p = await preview('sales', o.id, up.ids);
  assert.equal(await codeOf(apply('sales', o.id, await versionOf(o.id), [{ id: up.ids[0], fingerprint: 'eski' }])), 'PDF_IMPORT_STALE');
  assert.equal(await codeOf(apply('sales', o.id, (await versionOf(o.id)) - 1, fp(p))), 'CONFLICT');
  assert.equal(await codeOf(apply('sales', o.id, await versionOf(o.id), [])), 'PDF_IMPORT_EMPTY');
  assert.equal((await db.offerImport.findUnique({ where: { id: up.ids[0] } })).status, 'PREVIEW');
  // Aynı ön izleme iki kez gönderilirse ikincisi sürüm kilidine takılır
  const v = await versionOf(o.id);
  const [x, y] = await Promise.all([codeOf(apply('sales', o.id, v, fp(p))), codeOf(apply('sales', o.id, v, fp(p)))]);
  assert.deepEqual([x, y].sort(), ['CONFLICT', 'OK']);
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 1);
}));

dbTest('yetki: yönetici ve yönetici yardımcısı evet; müşteri, denetimci, çizimci hayır (yükleme, ön izleme, aktarma); başka firmanın müşterisi siparişi görmez', offline(async () => {
  const o = await newOrder(46);
  const files = [pdf(form({ no: '94001', project: 'MUSTERIX ABC 46', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 46'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' }))];
  for (const who of ['cust', 'inspector', 'drawer']) {
    assert.deepEqual(await importTarget(db, { orderId: o.id, actor: actor(people[who]) }), { ok: false, code: 'FORBIDDEN' }, who);
    assert.deepEqual(await upload(who, o.id, files), { ok: false, code: 'FORBIDDEN' }, who);
    assert.deepEqual(await preview(who, o.id, []), { ok: false, code: 'FORBIDDEN' }, who);
  }
  const up = await upload('admin', o.id, files);
  assert.equal(up.ok, true);
  const p = await preview('assistant', o.id, up.ids);
  assert.equal(p.ok, true);
  for (const who of ['cust', 'inspector', 'drawer']) {
    assert.ok(['NOT_ALLOWED', 'NOT_FOUND', 'FORBIDDEN'].includes(await codeOf(apply(who, o.id, await versionOf(o.id), fp(p)))), who);
  }
  assert.equal((await db.offerImport.findUnique({ where: { id: up.ids[0] } })).status, 'PREVIEW');
  // Yöneticiye gönderilmiş teklif satışa kapalı; yönetici (fiyat onayı) aktarabilir — satış fiyatı PDF'ten, müşteri fiyatı boş
  await run(o.id, 'save_offer', 'sales', { lines: [{ description: 'Cam', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '50.00', kind: 'CAM', free: false }] });
  await run(o.id, 'submit_offer', 'sales', { lines: (await latest(o.id)).lines.map((l) => ({ id: l.id, description: l.description, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, unitPrice: Number(l.unitPrice).toFixed(2), kind: l.kind, free: l.free })) });
  assert.equal((await importTarget(db, { orderId: o.id, actor: actor(people.sales) })).code, 'NOT_EDITABLE');
  const pa = await preview('admin', o.id, up.ids);
  await apply('admin', o.id, await versionOf(o.id), fp(pa));
  const offer = await latest(o.id);
  assert.equal(offer.status, 'YONETIMDE');
  const imported = offer.lines.find((l) => l.importId);
  assert.deepEqual([String(imported.unitPrice), imported.offerPrice], ['100', null]);
}));

dbTest('satış aktarılan satırları düzenler (kaynak işareti korunur), elle "Yöneticiye gönder": fiyat farkı Önemli kararlar’a düşer', offline(async () => {
  const o = await newOrder(47);
  const up = await upload('sales', o.id, [pdf(form({ no: '95001', project: 'MUSTERIX ABC 47', rows: [`1 ${DESC_TENTESOL}`, '3000 1000 1 3,000 3,000 100,00 TL 0,0 300,00 ABC 47', 'CNC İŞLEMİ ADET 1,000 1,000 5,00 TL 0,0 5,00'], total: '1 3,000 305,00', sub: '305,00', grand: '366,00' }))]);
  const p = await preview('sales', o.id, up.ids);
  await apply('sales', o.id, await versionOf(o.id), fp(p), { dropEmpty: p.empty.map((e) => e.id) });
  let offer = await latest(o.id);
  const formLines = offer.lines.map((l) => ({ id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, unitPrice: Number(l.unitPrice).toFixed(2), kind: l.kind, free: l.free }));
  // Satış ölçüyü ve fiyatı değiştirir; satır kimliği aynı → kaynak (importId / sourceRow) korunur
  formLines[0] = { ...formLines[0], boyMm: 900, unitPrice: '98.00' };
  await run(o.id, 'save_offer', 'sales', { lines: formLines, expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  assert.deepEqual([offer.lines[0].boyMm, String(offer.lines[0].unitPrice), offer.lines[0].sourceRow, !!offer.lines[0].importId], [900, '98', 1, true]);
  assert.equal(offer.status, 'HAZIRLANIYOR');
  await run(o.id, 'submit_offer', 'sales', { lines: formLines, expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  assert.equal(offer.status, 'YONETIMDE');
  const alert = await db.adminAlert.findFirst({ where: { orderId: o.id, type: 'PRICE_OVERRIDE' } });
  assert.ok(alert, 'liste fiyatından farklı alış fiyatı → mevcut uyarı');
  // Yönetici müşteri fiyatını girip gönderir; aktarılan satırın satış fiyatına (maliyet) dokunulmaz
  const adminLines = offer.lines.map((l) => ({ id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, unitPrice: '0.00', kind: l.kind, free: l.free, offerPrice: l.kind === 'CAM' ? '150.00' : '9.00' }));
  await run(o.id, 'approve_offer', 'admin', { lines: adminLines, expectedVersion: await versionOf(o.id) });
  const sent = await latest(o.id);
  assert.deepEqual(sent.lines.map((l) => [String(l.unitPrice), String(l.offerPrice), !!l.importId]), [['98', '150', true], ['5', '9', true]]);
}));

dbTest('özgün PDF saklanmaz: taranmamış (bekleyen) PDF aktarılamaz (antivirüs zorunlu — karar 263); arka plan taraması ve sipariş kotası dosyasız kayıtları saymaz; anahtarı kayıtsız kalan dosya temizlenir', offline(async () => {
  const o = await newOrder(48);
  const file = { ...pdf(form({ no: '96001', project: 'MUSTERIX ABC 48', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 48'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' })), scanStatus: 'PENDING' };
  const up = await upload('sales', o.id, [file]);
  assert.deepEqual(up.discard, [{ storageKey: file.storageKey }]);
  const row = await db.offerImport.findUnique({ where: { id: up.ids[0] } });
  assert.deepEqual([row.storageKey, row.scanStatus, row.factoryOrderNo], [null, 'PENDING', '96001']);
  assert.deepEqual((await preview('sales', o.id, up.ids)).imports[0].blocking.map((w) => w.code), ['NOT_SCANNED']);
  // Arka plan taraması fabrika PDF kayıtlarına bakmaz (dosya yok)
  let scanned = 0;
  await scanPending(db, { enabled: true, host: '127.0.0.1', port: 1 }, { scan: async () => { scanned++; return { status: 'clean' }; } });
  assert.equal((await db.offerImport.findUnique({ where: { id: up.ids[0] } })).scanStatus, 'PENDING');
  assert.equal(scanned, 0);
  // Sipariş kotası diskte duran dosyaları sayar: dosyasız kayıt (büyük de olsa) sayılmaz
  const limits = { ...UPLOAD_LIMITS, order: { bytes: 1_000_000, files: 400 } };
  await db.offerImport.update({ where: { id: up.ids[0] }, data: { size: 999_985 } });
  assert.equal(await checkUpload(db, [{ name: 'x.pdf', size: 10 }], { userId: people.sales.id, orderId: o.id }, { root: '/tmp', minFreeMb: 0, limits }), null);
  // Dosya temizliği: hiçbir kaydın göstermediği anahtar silinir
  const removed = [];
  assert.deepEqual(await removeOrphanFiles(db, [file.storageKey], async (k) => { removed.push(k); }), { removed: 1, kept: 0, failed: 0 });
  assert.deepEqual(removed, [file.storageKey]);
}));

dbTest('boş satır kuralı: yalnızca ölçüsüz, işlemsiz, sandık / telafi / aktarım olmayan cam satırı', () => {
  const lines = [
    { id: 'a', kind: 'CAM', enMm: null, boyMm: null, description: 'Cam' },
    { id: 'b', kind: 'CAM', enMm: null, boyMm: null, description: 'Cam' }, { id: 'b2', kind: 'CNC' },
    { id: 'c', kind: 'CAM', enMm: null, boyMm: null, description: 'Cam', crateFee: true },
    { id: 'd', kind: 'CAM', enMm: 100, boyMm: 100, description: 'Cam' },
    { id: 'e', kind: 'CAM', enMm: null, boyMm: null, description: 'Cam', importId: 'x' },
  ];
  assert.deepEqual(emptyGlassLines(lines).map((l) => l.id), ['a']);
});

// ---------- 3.77.0 (karar 261–263) ----------
const offerTotalsOf = (offer) => offerTotals(offer.lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice) })));
const formLines = (lines, extra = () => ({})) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), splitGroup: l.splitGroup, pieceM2: l.pieceM2 == null ? null : String(l.pieceM2), shaped: l.shaped, ...extra(l),
}));

dbTest('yeniden aktarım (karar 263): satırları teklifte durdukça aynı PDF engelli; satırların TAMAMI silinince aynı PDF yeni kayıtla, ön izleme + onayla yeniden aktarılır; eşzamanlı istek mükerrer satır üretmez', offline(async () => {
  const o = await newOrder(60);
  const lines = form({ no: '97601', project: 'MUSTERIX ABC 60', rows: [
    `1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 60',
    `2 ${DESC_TENTESOL}`, '1000 2000 1 2,000 2,000 100,00 TL 0,0 200,00 ABC 60',
  ], total: '2 3,000 300,00', sub: '300,00', grand: '360,00' });
  const first = await upload('sales', o.id, [pdf(lines, 'reimport-sum')]);
  const p1 = await preview('sales', o.id, first.ids);
  assert.deepEqual(p1.imports[0].blocking, []);
  await apply('sales', o.id, await versionOf(o.id), fp(p1), { dropEmpty: p1.empty.map((e) => e.id) });
  let offer = await latest(o.id);
  assert.equal(offer.lines.filter((l) => l.importId).length, 2);

  // Satırlar teklifte: aynı dosya aynı kayda düşer, aktarılamaz (sunucu da reddeder)
  const again = await upload('sales', o.id, [pdf(lines, 'reimport-sum')]);
  assert.deepEqual(again.ids, first.ids);
  assert.deepEqual((await preview('sales', o.id, again.ids)).imports[0].blocking.map((b) => b.code), ['ALREADY_IMPORTED']);
  // Satırların bir kısmı silindi: engel sürer
  await run(o.id, 'save_offer', 'sales', { lines: formLines(offer.lines.slice(1)), expectedVersion: await versionOf(o.id) });
  const partly = await upload('sales', o.id, [pdf(lines, 'reimport-sum')]);
  assert.deepEqual(partly.ids, first.ids);
  assert.ok((await preview('sales', o.id, partly.ids)).imports[0].blocking.some((b) => b.code === 'ALREADY_IMPORTED'));

  // Satırların tamamı silindi (satışçı hata fark etti): aynı PDF yeni kayıtla yeniden aktarılabilir
  await run(o.id, 'save_offer', 'sales', { lines: [{ description: 'Elle satır', poz: null, enMm: 500, boyMm: 500, adet: 1, unit: 'm2', unitPrice: '10.00', kind: 'CAM', free: false }], expectedVersion: await versionOf(o.id) });
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 0);
  const third = await upload('sales', o.id, [pdf(lines, 'reimport-sum')]);
  assert.equal(third.ids.length, 1);
  assert.notEqual(third.ids[0], first.ids[0], 'yeni kayıt; eski aktarım kaydı geçmiş olarak durur');
  assert.equal((await db.offerImport.findUniqueOrThrow({ where: { id: first.ids[0] } })).status, 'APPLIED');
  const p3 = await preview('sales', o.id, third.ids);
  assert.deepEqual(p3.imports[0].blocking, [], 'dosya özeti ve fabrika numarası tek başına engel değil');
  // Yalnızca ön izleme + onayla: önizleme hiçbir şey yazmaz
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 0);
  // Aynı onay iki kez (çift tıklama / iki sekme): biri yazılır, öteki sürüm kilidine takılır — mükerrer satır yok
  const v = await versionOf(o.id);
  const [x, y] = await Promise.all([codeOf(apply('sales', o.id, v, fp(p3))), codeOf(apply('sales', o.id, v, fp(p3)))]);
  assert.deepEqual([x, y].sort(), ['CONFLICT', 'OK']);
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.filter((l) => l.importId).map((l) => [l.importId, l.enMm, l.boyMm]), [[third.ids[0], 1000, 1000], [third.ids[0], 1000, 2000]]);
  // Yeniden aktarılınca engel geri gelir
  const fourth = await upload('sales', o.id, [pdf(lines, 'reimport-sum')]);
  assert.deepEqual(fourth.ids, third.ids);
  assert.ok((await preview('sales', o.id, fourth.ids)).imports[0].blocking.some((b) => b.code === 'ALREADY_IMPORTED'));
  // Eski aktarım kaydı (satırları silinmiş) yeniden aktarılmaya çalışılırsa: ALREADY_IMPORTED (yalnızca yeni kayıt kullanılır)
  assert.ok((await preview('sales', o.id, first.ids)).imports[0].blocking.some((b) => b.code === 'ALREADY_IMPORTED'));
}));

dbTest('yeniden aktarım: aynı dosyanın eşzamanlı iki yüklemesi tek kayıt; aynı dosyanın iki ayrı kaydı aynı anda aktarılamaz; taranamayan dosya yeniden yüklenince yeni tarama sonucu yazılır', offline(async () => {
  const o = await newOrder(61);
  const lines = form({ no: '97611', project: 'MUSTERIX ABC 61', rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 61'], total: '1 1,000 100,00', sub: '100,00', grand: '120,00' });
  const [a, b] = await Promise.all([upload('sales', o.id, [pdf(lines, 'par-sum')]), upload('sales', o.id, [pdf(lines, 'par-sum')])]);
  assert.deepEqual(a.ids, b.ids, 'kilit: aynı sipariş + aynı dosya tek kayıt');
  assert.equal(await db.offerImport.count({ where: { orderId: o.id, checksum: 'par-sum' } }), 1);
  // Antivirüs zorunlu: tarayıcıya ulaşılamadı (PENDING) → engel; dosya temiz taranınca aynı kayıt güncellenir
  const pend = await upload('sales', o.id, [{ ...pdf(lines, 'scan-sum'), scanStatus: 'PENDING' }]);
  assert.ok((await preview('sales', o.id, pend.ids)).imports[0].blocking.some((x) => x.code === 'NOT_SCANNED'));
  const skipped = await upload('sales', o.id, [{ ...pdf(lines, 'scan-sum'), scanStatus: 'SKIPPED' }]);
  assert.deepEqual(skipped.ids, pend.ids);
  assert.ok((await preview('sales', o.id, pend.ids)).imports[0].blocking.some((x) => x.code === 'NOT_SCANNED'), 'tarama kapalıyken de aktarılmaz');
  const clean = await upload('sales', o.id, [pdf(lines, 'scan-sum')]);
  assert.deepEqual(clean.ids, pend.ids);
  assert.equal((await db.offerImport.findUniqueOrThrow({ where: { id: pend.ids[0] } })).scanStatus, 'CLEAN');
  // İki kayıttan biri aktarılınca öteki (aynı dosya özeti) "zaten aktarıldı" olur — aynı numara da olduğu için ikinci engel
  await db.offerImport.create({ data: { orderId: o.id, name: 'kopya.pdf', size: 1, checksum: 'par-sum', scanStatus: 'CLEAN', parsed: (await db.offerImport.findUniqueOrThrow({ where: { id: a.ids[0] } })).parsed, factoryOrderNo: '97611' } });
  const twins = await db.offerImport.findMany({ where: { orderId: o.id, checksum: 'par-sum' }, orderBy: { createdAt: 'asc' } });
  const pa = await preview('sales', o.id, [twins[0].id]);
  await apply('sales', o.id, await versionOf(o.id), fp(pa));
  const pb = await preview('sales', o.id, [twins[1].id]);
  assert.ok(pb.imports[0].blocking.some((x) => x.code === 'ALREADY_IMPORTED'));
  assert.equal(await codeOf(apply('sales', o.id, await versionOf(o.id), fp(pb))), 'PDF_IMPORT_BLOCKED');
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 1);
}));

dbTest('metraj ve şekilli cam (karar 261, 262): PDF’in 3 ondalıklı m²si ve normal / şekilli ayrımı satıra yazılır; aynı teknik cam aynı katalog camıyla eşleşir; satış türü değiştirir — fiyat, POZ, ölçü, metraj, işlem değişmez', offline(async () => {
  const o = await newOrder(62);
  const up = await upload('sales', o.id, [pdf(shapedForm({ no: '97621', code: 'ABC 62' }))]);
  let p = await preview('sales', o.id, up.ids);
  // Fabrika açıklaması bu düzende kod taşımaz: cam elle seçilir (her iki satır için aynı katalog camı)
  const choices = { glass: Object.fromEntries(p.imports[0].plan.glassChoices.map((c) => [c.key, g.ref.id])) };
  p = await preview('sales', o.id, up.ids, choices);
  assert.deepEqual(p.imports[0].blocking, []);
  assert.deepEqual(p.imports[0].plan.rows.map((r) => [r.shaped, r.description]), [[false, DESC_NORMAL], [true, DESC_SHAPED]]);
  await apply('sales', o.id, await versionOf(o.id), fp(p), { choices, dropEmpty: p.empty.map((e) => e.id) });
  let offer = await latest(o.id);
  const glass = offer.lines.filter((l) => l.importId);
  assert.deepEqual(glass.map((l) => [l.shaped, l.glassProductId, Number(l.pieceM2), l.enMm, l.boyMm, l.adet, String(l.unitPrice), l.poz]), [
    [false, g.ref.id, 2.386, 1183, 2017, 2, '100', 'ABC 62'],
    [true, g.ref.id, 1, 1000, 1000, 1, '100', 'ABC 62'],
  ]);
  // PDF metrajı aynen: 4,772 + 1,000 = 5,772 m² ve 577,20 EUR (eskiden 4,77 m² → 577,00)
  assert.deepEqual([offerTotalsOf(offer).metraj, String(offer.amount)], [5.772, '577.2']);
  // Özgün fabrika açıklaması izlenebilir: aktarım kaydındaki ayrıştırılmış kopya
  const imp = await db.offerImport.findUniqueOrThrow({ where: { id: up.ids[0] } });
  assert.deepEqual(imp.parsed.rows.map((r) => r.description), [DESC_NORMAL, DESC_SHAPED]);
  // Satış türleri ters çevirir (normal → şekilli, şekilli → normal) ve kaydeder; yeniden açılınca korunur
  const stamp = (ls) => ls.map((l) => [l.id, String(l.unitPrice), l.poz, l.enMm, l.boyMm, l.adet, l.pieceM2 == null ? null : Number(l.pieceM2), l.importId, l.sourceRow]);
  const before = stamp(offer.lines);
  await run(o.id, 'save_offer', 'sales', { lines: formLines(offer.lines, (l) => ({ shaped: !l.shaped })), expectedVersion: await versionOf(o.id) });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.filter((l) => l.importId).map((l) => l.shaped), [true, false]);
  assert.deepEqual(stamp(offer.lines), before, 'fiyat, POZ, ölçü, adet, metraj ve kaynak değişmez');
  assert.deepEqual([offerTotalsOf(offer).metraj, String(offer.amount)], [5.772, '577.2']);
}));

// ---------- 4.2.11: noktalı ondalık sayı biçimi (ALE106 / ALE107 — satış panelinde aktarılamıyordu) ----------
dbTest('noktalı ondalık biçimli PDF (4.2.11 — ALE106 / ALE107 eşdeğeri): satış ön izler ve aktarır (üç satır); yönetici fiyat onayında aktarır (tek satır); alış fiyatı satış fiyatında, müşteri fiyatı boş; grup özeti satır olmaz', offline(async () => {
  const o = await newOrder(106, firm, g.uc838);
  const up = await upload('sales', o.id, [pdf(DOT_FORM_3)]);
  assert.equal(up.ok, true);
  const p = await preview('sales', o.id, up.ids);
  assert.deepEqual(p.imports.map((i) => [i.factoryNo, i.blocking, i.warnings.map((w) => w.code)]), [['91106', [], ['POZ_FALLBACK']]]);
  assert.deepEqual(p.imports[0].plan.checks.a, { pdfSum: 35415, subtotal: 35415, ok: true, diff: 0 });
  assert.deepEqual(p.imports[0].plan.checks.b, { takipTotal: 35415, pdfSum: 35415, subtotal: 35415, diff: 0, explained: true });
  assert.equal(p.imports[0].plan.lineCount, 3, 'grup özeti satır olarak eklenmez');
  await apply('sales', o.id, await versionOf(o.id), fp(p), { dropEmpty: p.empty.map((e) => e.id) });
  const offer = await latest(o.id);
  assert.equal(offer.status, 'HAZIRLANIYOR', 'yöneticiye gönderilmedi');
  assert.deepEqual(offer.lines.map((l) => [l.kind, l.glassProductId, l.poz, l.enMm, l.boyMm, l.adet, String(l.unitPrice), l.offerPrice, Number(l.pieceM2), l.sourceRow, !!l.importId]), [
    ['CAM', g.uc838.id, '91106', 1582, 1050, 3, '50', null, 1.661, 1, true],
    ['CAM', g.uc838.id, '91106', 1002, 1050, 1, '50', null, 1.052, 2, true],
    ['CAM', g.uc838.id, '91106', 998, 1050, 1, '50', null, 1.048, 3, true],
  ]);
  assert.deepEqual([String(offer.amount), offerTotalsOf(offer).metraj], ['354.15', 7.083], 'PDF ile aynı: 7,083 m² ve 354,15');
  const imp = await db.offerImport.findUniqueOrThrow({ where: { id: up.ids[0] } });
  assert.deepEqual([imp.parsed.numberFormat, imp.parsed.rows.length, imp.parsed.totals.subtotal, imp.storageKey], ['dot', 3, 35415, null]);

  // Yönetici aktarımı (fiyat onayında): tek satır; satış fiyatı (alış) PDF'ten, müşteri fiyatı boş — yöneticinin işlevi değişmedi
  const o2 = await newOrder(107, firm, g.duz8);
  await run(o2.id, 'save_offer', 'sales', { lines: [{ description: 'Cam', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '20.00', kind: 'CAM', free: false }] });
  await run(o2.id, 'submit_offer', 'sales', { lines: (await latest(o2.id)).lines.map((l) => ({ id: l.id, description: l.description, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, unitPrice: Number(l.unitPrice).toFixed(2), kind: l.kind, free: l.free })) });
  assert.equal((await importTarget(db, { orderId: o2.id, actor: actor(people.sales) })).code, 'NOT_EDITABLE');
  const up2 = await upload('admin', o2.id, [pdf(DOT_FORM_1)]);
  const pa = await preview('admin', o2.id, up2.ids);
  assert.deepEqual(pa.imports.map((i) => [i.factoryNo, i.blocking]), [['91107', []]]);
  await apply('admin', o2.id, await versionOf(o2.id), fp(pa));
  const offer2 = await latest(o2.id);
  assert.equal(offer2.status, 'YONETIMDE');
  assert.deepEqual(offer2.lines.filter((l) => l.importId).map((l) => [l.enMm, l.boyMm, l.adet, String(l.unitPrice), l.offerPrice, Number(l.pieceM2), l.glassProductId]), [[2215, 1015, 1, '20', null, 2.248, g.duz8.id]]);
}));

dbTest('yeniden yükleme (4.2.11): aynı PDF aktarılmamış kayda yeniden yüklenince okuma yenilenir (eski başarısız okuma kalmaz); okunamazsa hata yazılır; aktarılmış kaydın okumasına dokunulmaz', offline(async () => {
  const o = await newOrder(108, firm, g.uc838);
  const good = dotForm({ no: '91108', project: 'ABC 108', rows: [`1 ${DESC_UC_838} 1582 1050 3 1.661 4.983 50.00 € 0.0 249.15`], total: '3 4.983 249.15', sub: '249.15', grand: '298.98' });
  const first = await upload('sales', o.id, [pdf(good, 'reparse-sum')]);
  // 4.2.10'un okuyucusunun aynı dosyadan ürettiği sonuç (noktalı ondalık okunamıyordu): satırsız kayıt
  const old = { header: { factoryNo: '91108', orderDate: '2026-10-28', deliveryDate: '2026-11-13', project: 'ABC 108' }, rows: [],
    totals: { count: null, totalM2: null, tableSum: null, subtotal: null, grossSum: null, discount: null, vat: null, grandTotal: null },
    problems: [{ code: 'ROW_INCOMPLETE', line: 12 }, { code: 'TOTAL_LINE_UNREADABLE', line: 13 }, { code: 'SUBTOTAL_MISSING' }, { code: 'NO_ROWS' }] };
  await db.offerImport.update({ where: { id: first.ids[0] }, data: { parsed: old } });
  assert.deepEqual((await preview('sales', o.id, first.ids)).imports[0].blocking.map((b) => b.code), ['ROW_INCOMPLETE', 'TOTAL_LINE_UNREADABLE', 'SUBTOTAL_MISSING', 'NO_ROWS']);
  // Aynı dosya yeniden yüklenir: aynı kayıt (karar 263), okuma güncel okuyucuyla yenilenir
  const again = await upload('sales', o.id, [pdf(good, 'reparse-sum')]);
  assert.deepEqual(again.ids, first.ids);
  const row = await db.offerImport.findUniqueOrThrow({ where: { id: first.ids[0] } });
  assert.deepEqual([row.parsed.numberFormat, row.parsed.rows.length, row.parseError, row.factoryOrderNo, row.storageKey], ['dot', 1, null, '91108', null]);
  const fresh = await preview('sales', o.id, again.ids);
  assert.deepEqual(fresh.imports[0].blocking, []);
  // Okuma bu kez başarısız (dosya okunamadı): aktarılmamış kayıtta hata kodu — ön izleme "okunamadı" der, aktarılamaz
  const o2 = await newOrder(109, firm, g.uc838);
  const two = await upload('sales', o2.id, [pdf(good, 'reparse-2')]);
  await upload('sales', o2.id, [{ ...pdf([], 'reparse-2'), storageKey: 'yok/okunamaz.pdf' }]);
  assert.equal((await db.offerImport.findUniqueOrThrow({ where: { id: two.ids[0] } })).parseError, 'UNREADABLE');
  assert.deepEqual((await preview('sales', o2.id, two.ids)).imports[0].blocking.map((b) => b.code), ['PDF_UNREADABLE']);
  // Aktarılmış kayıt: yeniden yükleme okumasını değiştirmez (satırları teklifte duruyor — "zaten aktarıldı")
  await apply('sales', o.id, await versionOf(o.id), fp(fresh), { dropEmpty: fresh.empty.map((e) => e.id) });
  const applied = JSON.stringify((await db.offerImport.findUniqueOrThrow({ where: { id: first.ids[0] } })).parsed);
  const changed = dotForm({ no: '91108', project: 'ABC 108', rows: [`1 ${DESC_UC_838} 1000 1000 1 1.000 1.000 50.00 € 0.0 50.00`], total: '1 1.000 50.00', sub: '50.00', grand: '60.00' });
  const third = await upload('sales', o.id, [pdf(changed, 'reparse-sum')]);
  assert.deepEqual(third.ids, first.ids);
  assert.equal(JSON.stringify((await db.offerImport.findUniqueOrThrow({ where: { id: first.ids[0] } })).parsed), applied);
  assert.ok((await preview('sales', o.id, third.ids)).imports[0].blocking.some((b) => b.code === 'ALREADY_IMPORTED'));
  assert.equal((await latest(o.id)).lines.filter((l) => l.importId).length, 1, 'mükerrer satır yok');
}));

dbTest('elle cam seçimi (4.2.12 — ADE 15 eşdeğeri): ön izlemede bütün katalog, pasif cam işaretli; pasif cam seçilip aktarılır, cam pasif kalır; başka kodlu cam seçilirse aktarım durur; müşterinin yeni sipariş kataloğu değişmez', offline(async () => {
  // Kodu adından çıkmayan sipariş camı (eşleşme doğrulanamaz → uyarı) ve katalogda PASİF bir 6.3.6 füme-opak cam
  const gen = await db.glassProduct.create({ data: { nameTr: 'Lamine Cam (özel)', colorTr: 'Karışık', nameRo: 'Sticlă laminată', colorRo: 'Mixt', weightKgM2: 30 } });
  const opak = await db.glassProduct.create({ data: { nameTr: '6.3.6 Temperli Lamine', colorTr: 'Füme-Opak-Şeffaf', nameRo: 'Sticlă 6.3.6.', colorRo: 'Gri-Opac-Transparent', weightKgM2: 30, isActive: false } });
  const DESC_ADE = '6 mm Temperli Füme Cam DR+0.38 Opak+0.76 Şeffaf+6 mm Temperli Düz Cam DR';
  const o = await newOrder(115, firm, gen);
  const lines = form({ no: '91115', project: 'ABC 115', rows: [`1 ${DESC_ADE} 1000 1000 2 1,000 2,000 50,00 TL 0,0 100,00`, `2 ${DESC_ADE} 500 1000 1 0,500 0,500 50,00 TL 0,0 25,00`], total: '3 2,500 125,00', sub: '125,00', grand: '150,00' });
  const up = await upload('sales', o.id, [pdf(lines)]);
  const p = await preview('sales', o.id, up.ids);
  const imp = p.imports[0];
  assert.equal(imp.factoryNo, '91115');
  assert.ok(imp.blocking.some((b) => b.code === 'NEEDS_GLASS_CHOICE'), 'otomatik eşleşme yalnızca etkin camlarla');
  const choice = imp.plan.glassChoices[0];
  const all = await db.glassProduct.findMany({ select: { id: true, isActive: true } });
  assert.deepEqual(choice.candidates.map((c) => c.id).sort(), all.map((x) => x.id).sort(), 'bütün katalog (etkin + pasif)');
  assert.deepEqual(choice.candidates.filter((c) => c.inactive).map((c) => c.id), all.filter((x) => !x.isActive).map((x) => x.id));
  assert.match(choice.candidates.find((c) => c.id === opak.id).search, /Opak/);
  // Başka kodlu cam (8.3.8) seçilirse aktarım durur
  const wrong = await preview('sales', o.id, up.ids, { glass: { [choice.key]: g.uc838.id } });
  assert.ok(wrong.imports[0].blocking.some((b) => b.code === 'GLASS_CHOICE_CODE_MISMATCH'));
  assert.equal(await codeOf(apply('sales', o.id, await versionOf(o.id), fp(wrong), { choices: { glass: { [choice.key]: g.uc838.id } } })), 'PDF_IMPORT_BLOCKED');
  // Doğru (pasif) cam: satırlar, ölçüler, adetler, m² ve alış fiyatı PDF'teki gibi
  const ok = await preview('sales', o.id, up.ids, { glass: { [choice.key]: opak.id } });
  assert.deepEqual(ok.imports[0].blocking, []);
  await apply('sales', o.id, await versionOf(o.id), fp(ok), { choices: { glass: { [choice.key]: opak.id } }, dropEmpty: ok.empty.map((e) => e.id) });
  const offer = await latest(o.id);
  assert.deepEqual(offer.lines.filter((l) => l.importId).map((l) => [l.glassProductId, l.enMm, l.boyMm, l.adet, String(l.unitPrice), l.offerPrice, Number(l.pieceM2)]), [
    [opak.id, 1000, 1000, 2, '50', null, 1], [opak.id, 500, 1000, 1, '50', null, 0.5],
  ]);
  assert.equal(String(offer.amount), '125');
  assert.equal((await db.glassProduct.findUniqueOrThrow({ where: { id: opak.id } })).isActive, false, 'seçim camı etkinleştirmez');
  // Müşterinin yeni sipariş seçimi yalnızca etkin camları kabul eder (değişmedi)
  const { glassOrderItems } = await import('../../server/catalog/glass.js');
  assert.deepEqual(glassOrderItems([{ id: opak.id, qty: 1 }], [opak]), { ok: false, code: 'GLASS_GONE' });
}));
