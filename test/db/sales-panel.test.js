// Satış paneli düzeltme paketi 1 (veritabanıyla): satışın sandık ücreti (karar 211) ve "Yöneticiye göndermeyi geri al"
// (karar 212) — satış ↔ yönetici çapraz yetki, eşzamanlılık, kuyruk, geçmiş ve denetim.
// FGO'ya GERÇEK istek yapılmaz: bu dosyada FGO'ya hiç gidilmez (offline — her ağ çağrısı testi düşürür).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { CRATE_LINE, atOfferPrice, isSalesCrate, offerTotals } from '../../server/orders/rules.js';
import { queuesFor, salesOfferGroups } from '../../server/orders/queues.js';
import { glassTotals, proformaLines } from '../../server/glass/billing.js';

let db;
let firm;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
let fileNo = 0;
const newOrder = async (title) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/sp-${fileNo}.pdf`, name: `sp-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
// 1000 × 500 mm × 2 = 1 m²; satış fiyatı 40
const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false, ...extra });
const cnc = (extra = {}) => ({ description: '', poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', unitPrice: '10.00', kind: 'CNC', free: false, ...extra });
// Satışın sandık parası: ekranın "+ Sandık parası" satırı (işaretsiz, adetli, ölçüsüz; bağımsız kalem — karar 214)
const salesCrate = (extra = {}) => ({ description: CRATE_LINE.tr, poz: null, enMm: null, boyMm: null, adet: 2, unit: 'adet', unitPrice: '25.00', kind: 'CAM', free: false, ...extra });
const versions = (orderId) => db.offer.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const latest = async (orderId) => (await versions(orderId)).at(-1);
const form = (l, extra = {}) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), ...extra,
});
/** Yöneticinin formu: tüm satırlar + müşteri fiyatı (price verilmezse kayıtlı) */
const adminForm = (lines, price = (l) => l.offerPrice) => lines.map((l) => form(l, { crateFee: l.crateFee, offerPrice: price(l) == null ? null : String(price(l)) }));
/** Satışın formu: satışa giden satırlar (yöneticinin sandık bedeli satışa hiç gitmez — lib/orders.ts → offerPrices) */
const salesForm = (lines) => lines.filter((l) => !l.crateFee).map((l) => form(l));
const plain = (lines) => lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice), offerPrice: l.offerPrice == null ? null : String(l.offerPrice) }));
const queueRows = () => db.order.findMany({
  include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 }, drawings: true, events: { where: { event: 'OFFER_CHECKED' }, orderBy: { createdAt: 'desc' }, take: 1 } },
});
const priceQueue = async () => queuesFor(await queueRows(), { review: false, send: true, drawing: false }).find((q) => q.key === 'priceApproval').rows.map((o) => o.id);
const awaitingSales = async () => salesOfferGroups(await queueRows()).find((g) => g.key === 'awaitingPrice').rows.map((o) => o.id);

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-sp.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@sp.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('sales2', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
});
after(closeDb);

dbTest('satışın sandık ücreti: satış ekler / değiştirir (işaretsiz, adetli, ölçüsüz); yönetici görür ve fiyatlar; müşteri ve belge tutarına bir kez girer', offline(async () => {
  const o = await newOrder('Satış sandığı');
  await run(o.id, 'no_drawing', 'sales');
  // Satış: cam + CNC + kendi sandık parası (bağımsız kalem; tablodaki yeri serbest) — ölçü / m² birimiyle gelse de adetli, ölçüsüz yazılır
  await run(o.id, 'save_offer', 'sales', { lines: [glass({ adet: 1 }), cnc(), salesCrate({ unit: 'm2', enMm: 700, boyMm: 700 }), glass({ description: 'Temper' })] });
  let offer = await latest(o.id);
  const row = (l) => [l.kind, l.unit, l.adet, l.enMm, String(l.unitPrice), l.crateFee, l.descriptionRo];
  assert.deepEqual(offer.lines.map(row)[2], ['CAM', 'adet', 2, null, '25', false, CRATE_LINE.ro]);
  assert.equal(isSalesCrate(offer.lines[2]), true);
  // Satış kendi sandık ücretini değiştirir (adet, fiyat)
  await run(o.id, 'save_offer', 'sales', { lines: salesForm(offer.lines).map((l) => (l.description === CRATE_LINE.tr ? { ...l, adet: 3, unitPrice: '20.00' } : l)) });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.map((l) => [l.description, l.adet, String(l.unitPrice), l.crateFee]), [['Cam', 1, '40', false], ['', 1, '10', false], [CRATE_LINE.tr, 3, '20', false], ['Temper', 2, '40', false]]);
  // Fiyatı boş sandık ücreti yöneticiye gönderilemez (satışın diğer satırları gibi)
  assert.equal(await codeOf(run(o.id, 'submit_offer', 'sales', { lines: salesForm(offer.lines).map((l) => (l.description === CRATE_LINE.tr ? { ...l, unitPrice: '0.00' } : l)) })), 'SALES_PRICE_MISSING');
  await run(o.id, 'submit_offer', 'sales', { lines: salesForm(offer.lines) });
  offer = await latest(o.id);
  // Satış tutarı: 0,5 × 40 + 10 + 3 × 20 + 1 × 40 = 130
  assert.deepEqual([offer.status, String(offer.amount)], ['YONETIMDE', '130']);

  // Yönetici: satışın sandık ücretini görür; müşteri fiyatı girilmeden müşteriye gönderemez
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines, (l) => (l.description === CRATE_LINE.tr ? null : '50')) })), 'OFFER_PRICE_MISSING');
  // Yönetici kendi sandık bedelini ekler — işaretsiz, elle yazılmış adla da olsa yöneticinindir (satış görmez); satışın
  // sandık satırını taklit işaretle gizleyemez (satırın sahibi değişmez)
  const adminLines = adminForm(offer.lines, (l) => (l.description === CRATE_LINE.tr ? '30' : '50')).map((l) => (l.description === CRATE_LINE.tr ? { ...l, crateFee: true } : l));
  await run(o.id, 'save_offer', 'admin', { lines: [...adminLines, { description: 'ambalaj (LADĂ)', poz: null, enMm: 500, boyMm: 500, adet: 1, unit: 'm2', kind: 'CAM', free: false, unitPrice: '0.00', offerPrice: '45' }] });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.map((l) => [l.description, l.unit, l.enMm, l.crateFee, l.offerPrice == null ? null : String(l.offerPrice)]), [
    ['Cam', 'm2', 1000, false, '50'], ['', 'adet', null, false, '50'], [CRATE_LINE.tr, 'adet', null, false, '30'], ['Temper', 'm2', 1000, false, '50'], [CRATE_LINE.tr, 'adet', null, true, '45'],
  ]);
  // Satışın kaydı yöneticinin sandık bedelini korur ve görmez; yöneticinin satırının kimliğiyle gelemez
  await run(o.id, 'return_offer', 'admin', { lines: adminForm(offer.lines), returnNote: 'kontrol' });
  offer = await latest(o.id);
  const hidden = offer.lines.find((l) => l.crateFee);
  assert.equal(await codeOf(run(o.id, 'save_offer', 'sales', { lines: [...salesForm(offer.lines), form(hidden)] })), 'CRATE_FEE_ADMIN');
  await run(o.id, 'submit_offer', 'sales', { lines: salesForm(offer.lines) });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.map((l) => [l.description, l.crateFee]), [['Cam', false], ['', false], [CRATE_LINE.tr, false], ['Temper', false], [CRATE_LINE.tr, true]]);
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines) });
  const sent = await latest(o.id);
  // Müşteri: 0,5 × 50 + 50 + 3 × 30 + 1 × 50 + 45 = 260 · satış (maliyet): 130 + 0 = 130 — her satır bir kez
  assert.deepEqual([sent.status, String(sent.offerAmount), String(sent.amount)], ['GONDERILDI', '260', '130']);
  const lines = plain(sent.lines);
  assert.deepEqual([offerTotals(atOfferPrice(lines)).amount, offerTotals(lines).crate, offerTotals(lines).adet], [260, 4, 3]);
  // Belgeler: fatura gruplarının toplamı = müşteri toplamı (sandık parası üstündeki camın grubunda); proformada ayrı satır
  // (ürün sahibinin kararı, karar 214 — proforma değişmedi)
  const groups = glassTotals({ lines });
  assert.equal(Math.round(groups.reduce((s, g) => s + g.total, 0) * 100) / 100, 260);
  const pro = proformaLines({ lines });
  assert.deepEqual(pro.filter((r) => r.name === CRATE_LINE.ro).map((r) => [r.qty, r.eur]), [[3, 30], [1, 45]]);
  assert.equal(Math.round(pro.reduce((s, r) => s + r.qty * r.eur, 0) * 100) / 100, 260);
}));

dbTest('geri alma: yalnızca gönderen satışçı, yönetici göndermeden; teklif satışa döner, kuyruktan çıkar; geçmiş ve denetim durur; yeniden gönderim kuyruğa girer', offline(async () => {
  const o = await newOrder('Geri alma');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass(), salesCrate()] });
  // Yöneticinin taslak müşteri fiyatı ve kendi sandık bedeli (satış görmez) — geri almada kaybolmaz
  let offer = await latest(o.id);
  await run(o.id, 'save_offer', 'admin', { lines: [...adminForm(offer.lines, () => '55'), { description: CRATE_LINE.tr, poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', kind: 'CAM', free: false, unitPrice: '0.00', crateFee: true, offerPrice: '40' }] });
  const alert = await db.adminAlert.create({ data: { type: 'PRICE_OVERRIDE', orderId: o.id, offerId: offer.id, createdById: people.sales.id, details: { orderNo: o.orderNo, lines: [] } } });
  assert.ok((await priceQueue()).includes(o.id), 'yöneticinin fiyat onayı kuyruğunda');

  // Çapraz yetki: başka satışçı, yönetici, çizim, denetimci, müşteri geri alamaz
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'sales2')), 'OFFER_NOT_OWNER');
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'admin')), 'NOT_ALLOWED');
  // Çizim ekibi çizimsiz siparişi kapsamında hiç görmez (NOT_FOUND); denetimci görür ama işlem yapamaz
  for (const who of ['drawer', 'inspector', 'cust']) assert.ok(['NOT_ALLOWED', 'NOT_FOUND'].includes(await codeOf(run(o.id, 'withdraw_offer', who))), who);
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'inspector')), 'NOT_ALLOWED');
  // Satışçı yöneticideki teklifi düzenleyemez / yeniden gönderemez (geri almadan)
  assert.equal(await codeOf(run(o.id, 'save_offer', 'sales', { lines: salesForm(offer.lines) })), 'NOT_ALLOWED');
  // Eski sayfa (sürüm değişti): CONFLICT
  const current = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'sales', { expectedVersion: current.version - 1 })), 'CONFLICT');
  assert.equal((await latest(o.id)).status, 'YONETIMDE', 'reddedilen istek hiçbir şey yazmadı');

  const res = await run(o.id, 'withdraw_offer', 'sales', { expectedVersion: current.version });
  assert.ok(res.outboxIds.length >= 1);
  offer = await latest(o.id);
  assert.equal(offer.status, 'HAZIRLANIYOR');
  // Satırlar, yöneticinin taslak fiyatı ve sandık bedeli durur
  assert.deepEqual(offer.lines.map((l) => [l.description, l.crateFee, String(l.offerPrice)]), [['Cam', false, '55'], [CRATE_LINE.tr, false, '55'], [CRATE_LINE.tr, true, '40']]);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(order.status, 'HAZIRLANIYOR');
  const events = await db.orderEvent.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(events.filter((e) => e.event.startsWith('OFFER_')).map((e) => [e.event, e.userId]), [['OFFER_SUBMITTED', people.sales.id], ['OFFER_WITHDRAWN', people.sales.id]]);
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'withdraw_offer' } } });
  assert.deepEqual([audit?.userId, audit?.details.offerFrom, audit?.details.offerTo, audit?.details.closedAlerts], [people.sales.id, 'YONETIMDE', 'HAZIRLANIYOR', 1]);
  assert.ok((await db.adminAlert.findUniqueOrThrow({ where: { id: alert.id } })).resolvedAt, 'gönderimin açık uyarısı kapandı');
  // Kuyruk: yöneticiden çıktı, satışın "Fiyatımı bekleyenler"inde
  assert.ok(!(await priceQueue()).includes(o.id));
  assert.ok((await awaitingSales()).includes(o.id));
  // İkinci geri alma: teklif artık satışta
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'sales')), 'NOT_ALLOWED');

  // Satış değiştirir ve yeniden gönderir → yöneticinin kuyruğunda; yönetici gönderince geri alma kapanır
  await run(o.id, 'submit_offer', 'sales', { lines: salesForm(offer.lines).map((l) => (l.description === 'Cam' ? { ...l, adet: 4 } : l)) });
  offer = await latest(o.id);
  assert.deepEqual([offer.status, offer.lines.map((l) => [l.adet, l.crateFee])], ['YONETIMDE', [[4, false], [2, false], [1, true]]]);
  assert.ok((await priceQueue()).includes(o.id));
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines) });
  assert.equal((await latest(o.id)).status, 'GONDERILDI');
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'sales')), 'NOT_ALLOWED');
  assert.ok(!(await priceQueue()).includes(o.id));
  assert.equal((await versions(o.id)).length, 1, 'geri alma yeni sürüm açmaz; teklif geçmişi tek kayıtta');
}));

dbTest('eşzamanlılık: yönetici gönderirken satış geri alırsa yalnızca biri yazılır; durum ve geçmiş tutarlı', offline(async () => {
  const outcomes = new Set();
  for (let i = 0; i < 6; i++) {
    const o = await newOrder(`Yarış ${i}`);
    await run(o.id, 'no_drawing', 'sales');
    await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
    const offer = await latest(o.id);
    const { version } = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    // Aynı sürümden iki istek (iki ekran): biri sürümü artırır, öbürü CONFLICT / NOT_ALLOWED alır. İlk üç turda ekranın
    // sürümü verilir, sonrakilerde verilmez (yalnızca satır kilidi + teklif durumu korur); başlama sırası değişir.
    const v = i < 3 ? { expectedVersion: version } : {};
    const approveP = () => run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines, () => '50'), ...v });
    const withdrawP = () => run(o.id, 'withdraw_offer', 'sales', v);
    const [approve, withdraw] = i % 2 === 0
      ? await Promise.allSettled([approveP(), withdrawP()])
      : (await Promise.allSettled([withdrawP(), approveP()])).reverse();
    const ok = [approve, withdraw].filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, `tam olarak biri: ${approve.status}/${withdraw.status}`);
    const lost = /** @type {PromiseRejectedResult} */ ([approve, withdraw].find((r) => r.status === 'rejected'));
    assert.ok(['CONFLICT', 'NOT_ALLOWED'].includes(lost.reason.code), String(lost.reason.code ?? lost.reason));
    const final = await latest(o.id);
    const events = (await db.orderEvent.findMany({ where: { orderId: o.id } })).map((e) => e.event);
    if (approve.status === 'fulfilled') {
      outcomes.add('approve');
      assert.equal(final.status, 'GONDERILDI');
      assert.ok(events.includes('OFFER_SENT') && !events.includes('OFFER_WITHDRAWN'));
    } else {
      outcomes.add('withdraw');
      assert.equal(final.status, 'HAZIRLANIYOR');
      assert.ok(events.includes('OFFER_WITHDRAWN') && !events.includes('OFFER_SENT'));
      assert.equal(await db.price.count({ where: { orderId: o.id } }), 0, 'müşteriye fiyat gitmedi');
    }
  }
  assert.ok(outcomes.size >= 1);
}));
