// Sandık parası fabrika maliyeti (karar 257) — veritabanıyla: yöneticinin teklif tablosuna eklediği "Sandık parası"
// kaleminin fabrika birim maliyeti (OfferLine.unitPrice) kayda GERÇEKTEN 0 yazılır — yeni satırda, taslağın yeniden
// kaydında, gönderimde ve teklifin yeni sürümünde; formdan gelen başka bir değer yok sayılır. Satır "maliyet eksik"
// uyarısına girmez (tedarikçi sayfası, yükleme onayı / kârlılık); müşteri fiyatı (offerPrice) bağımsız girilir; satır ayrı,
// numaralı teklif kalemi olarak kalır ve belge kuralları (proformada ayrı satır, faturada cam tutarına eklenir) değişmez.
// Ağ çağrısı yapılmaz (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { atOfferPrice, offerTotals } from '../../server/orders/rules.js';
import { supplierData } from '../../server/accounting/supplier.js';
import { previewLoading, summarize } from '../../server/loading/confirmation.js';
import { invoiceLines, proformaLines } from '../../server/glass/billing.js';

let db;
let firm;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
let fileNo = 0;
const newOrder = async (title) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/kasa-${fileNo}.pdf`, name: `kasa-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
// 1000 × 500 mm × 2 = 1 m²; satış fiyatı 40
const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false, ...extra });
const crate = (extra = {}) => ({ description: 'Sandık parası', poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', unitPrice: '0.00', kind: 'CAM', free: false, crateFee: true, ...extra });
const latest = async (orderId) => (await db.offer.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } })).at(-1);
const adminForm = (lines, price = (l) => l.offerPrice) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  crateFee: l.crateFee, unitPrice: Number(l.unitPrice).toFixed(2), offerPrice: price(l) == null ? null : String(price(l)),
}));
const row = (l) => [l.description, l.unit, l.adet, String(l.unitPrice), l.offerPrice == null ? null : String(l.offerPrice), l.crateFee];

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Kasa Glass SRL', prefix: 'KAS', email: 'office@kasa.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@kasa.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
});
after(closeDb);

dbTest('sandık parası: fabrika maliyeti kayda 0 EUR yazılır (yeni satır, yeniden kayıt, gönderim, yeni sürüm); maliyet eksik sayılmaz; müşteri fiyatı bağımsız', offline(async () => {
  const o = await newOrder('Sandık maliyeti');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  // Yönetici sandık parası ekler — formdan maliyet gelse bile (taklit / eski form) kayda 0 yazılır
  await run(o.id, 'save_offer', 'admin', { lines: [...adminForm((await latest(o.id)).lines, () => '50'), crate({ id: null, unitPrice: '25.00', offerPrice: '30' })] });
  let offer = await latest(o.id);
  assert.deepEqual(offer.lines.map(row), [['Cam', 'm2', 2, '40', '50', false], ['Sandık parası', 'adet', 1, '0', '30', true]]);
  const crateId = offer.lines[1].id;
  // Gerçekten kayıtlı: veritabanından ayrıca okunur (null / boş değil, sayı 0)
  const stored = await db.offerLine.findUniqueOrThrow({ where: { id: crateId } });
  assert.deepEqual([stored.unitPrice === null, Number(stored.unitPrice), stored.crateFee, stored.sortOrder], [false, 0, true, 1]);

  // Taslak yeniden açılıp kaydedilince de 0 kalır (formda başka değer olsa da); müşteri fiyatı yönetici girdiği gibi değişir
  await run(o.id, 'save_offer', 'admin', { lines: adminForm(offer.lines).map((l) => (l.crateFee ? { ...l, unitPrice: '99.00', offerPrice: '32' } : l)) });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.map(row), [['Cam', 'm2', 2, '40', '50', false], ['Sandık parası', 'adet', 1, '0', '32', true]]);
  assert.equal(offer.lines[1].id, crateId, 'aynı satır');

  // Gönderim: müşteri tutarı cam + sandık (2 × 50… 1 m² × 50 + 32 = 82); satış (maliyet) tutarı yalnızca cam (40)
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines) });
  const sent = await latest(o.id);
  assert.deepEqual([sent.status, String(sent.offerAmount), String(sent.amount)], ['GONDERILDI', '82', '40']);
  const plain = sent.lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice), offerPrice: l.offerPrice == null ? null : String(l.offerPrice) }));
  assert.deepEqual([offerTotals(atOfferPrice(plain)).amount, offerTotals(plain).amount], [82, 40]);
  // Teklifin yeni sürümü (yöneticinin "teklifi güncelle"si): sandık maliyeti yine 0, müşteri fiyatı yeni değer
  await run(o.id, 'update_offer', 'admin', { lines: adminForm(sent.lines, (l) => (l.crateFee ? '35' : l.offerPrice)).map((l) => (l.crateFee ? { ...l, unitPrice: '12.00' } : l)) });
  const v2 = await latest(o.id);
  assert.deepEqual(v2.lines.map(row), [['Cam', 'm2', 2, '40', '50', false], ['Sandık parası', 'adet', 1, '0', '35', true]]);

  // Belge kuralları değişmedi: proformada sandık AYRI satır; nihai faturada cam tutarına eklenir (tek satır)
  assert.deepEqual(proformaLines(v2).map((l) => [l.unit, l.qty, l.eur]), [['mp', 1, 50], ['buc', 1, 35]]);
  const inv = invoiceLines(v2, 5, 21);
  assert.deepEqual([inv.length, inv[0].qty], [1, 1]);

  // "Maliyet eksik" uyarısı yok: tedarikçi sayfası (planlanan gün) ve yükleme onayı önizlemesi
  const day = dayOf(-2);
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  const sd = await supplierData(db, new Date(`${dayOf(1)}T00:00:00Z`));
  assert.ok(!sd.missing.some((m) => m.orderId === o.id), 'eksik maliyet listesinde yok');
  assert.ok(!sd.days.some((d) => d.noCost.some((x) => x.orderId === o.id)), 'gün "maliyet eksik" değil');
  const preview = await previewLoading(db, day);
  assert.ok(preview.orders.some((x) => x.orderId === o.id));
  assert.equal(summarize(preview.orders).totals.noCost, 0);

  // Kural yalnızca sandık satırını muaf tutar: yöneticinin eklediği, fiyat tablosunda maliyeti olmayan başka satır uyarı verir
  await run(o.id, 'update_offer', 'admin', { lines: [...adminForm(v2.lines), { description: 'Özel işlem', poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', kind: 'CAM', free: false, unitPrice: '0.00', offerPrice: '20' }] });
  const sd2 = await supplierData(db, new Date(`${dayOf(1)}T00:00:00Z`));
  const miss = sd2.missing.find((m) => m.orderId === o.id);
  assert.deepEqual(miss?.lines.map((l) => l.description), ['Özel işlem']);
}));
