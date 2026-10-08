// Fonksiyonel paket 4 — yönetici paneli (veritabanıyla): müşteri fiyatı değişikliği (gönderilmemiş teklif olağan akışta,
// gönderilmişte yeni sürüm; eski sürüm ve denetim kaydı durur), mali kilit (FGO belgesi, müşteri belgesi kapsamı, bekleyen
// belge isteği, onaylı yükleme), sandık bedeli (yalnızca yöneticinin satırı), teklif gönderiminde satışa bildirim yok ve
// iki aşamalı silme.
// FGO'ya GERÇEK istek yapılmaz: bu dosyada FGO'ya hiç gidilmez (offline — her ağ çağrısı testi düşürür).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { priceLock } from '../../server/orders/financial-lock.js';
import { removalPreview, removeOrder, restoreOrder } from '../../server/orders/removal.js';
import { dispatchInAppFor } from '../../server/notifications/inapp.js';
import { recipientsFor } from '../../server/notifications/email.js';
import { atOfferPrice, offerTotals } from '../../server/orders/rules.js';
import { confirmLoading, previewLoading } from '../../server/loading/confirmation.js';

let db;
let firm;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
let fileNo = 0;
const newOrder = async (title) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/p4-${fileNo}.pdf`, name: `p4-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
// 1000 × 500 mm × 2 = 1 m²; satış fiyatı 40
const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false, ...extra });
const crate = (extra = {}) => ({ description: 'Sandık parası', poz: null, enMm: null, boyMm: null, adet: 1, unit: 'adet', unitPrice: '0.00', kind: 'CAM', free: false, crateFee: true, ...extra });
const versions = (orderId) => db.offer.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const latest = async (orderId) => (await versions(orderId)).at(-1);
/** Yöneticinin formu: kayıtlı satırlar + müşteri fiyatı (price verilmezse kayıtlı müşteri fiyatı) */
const adminForm = (lines, price = (l) => l.offerPrice) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  crateFee: l.crateFee, unitPrice: Number(l.unitPrice).toFixed(2), offerPrice: price(l) == null ? null : String(price(l)),
}));
/** Satışın formu: satışa giden satırlar (yöneticinin sandık bedeli satışa hiç gitmez — lib/orders.ts), müşteri fiyatı yok */
const salesForm = (lines) => lines.filter((l) => !l.crateFee).map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2),
}));
const priceAudits = (orderId) => db.auditLog.findMany({ where: { action: 'OFFER_PRICE_CHANGED', entityId: orderId }, orderBy: { createdAt: 'asc' } });
/** Teklifi müşteriye gönderilmiş (yönetici onayı → otomatik üretim) sipariş */
async function sentOrder(title, price = '50') {
  const o = await newOrder(title);
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => price) });
  return db.order.findUniqueOrThrow({ where: { id: o.id } });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-p4.test' } });
  const other = await db.customer.create({ data: { name: 'Alegrad', prefix: 'ALE' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@p4.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('other', 'MUSTERI', other.id, { canApprove: true });
});
after(closeDb);

dbTest('müşteri fiyatı: gönderilmemiş teklifte yöneticinin taslağı müşteriye gitmez; gönderilmişte yeni sürüm — eski sürüm, fiyat geçmişi ve denetim kaydı durur', offline(async () => {
  const o = await newOrder('Fiyat güncelleme');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  // Gönderilmemiş teklif (yönetici onayında): yöneticinin taslak kaydı olağan akış; müşteri yalnızca gönderilmiş teklifi görür
  await run(o.id, 'save_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => '50') });
  const offer = await latest(o.id);
  assert.deepEqual([offer.status, String(offer.lines[0].offerPrice), await db.offer.count({ where: { orderId: o.id, status: 'GONDERILDI' } })], ['YONETIMDE', '50', 0]);
  let audits = await priceAudits(o.id);
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].userId, audits[0].details.orderNo, audits[0].details.version, audits[0].details.intent, audits[0].details.sent, audits[0].details.offerId],
    [people.admin.id, o.orderNo, 1, 'save', false, offer.id]);
  assert.deepEqual(audits[0].details.changes.map((x) => [x.no, x.change, x.old, x.new]), [[1, 'PRICE', null, '50.00']]);
  // Satış fiyatlı teklifi müşteriye gönderemez ve müşterideki teklifi güncelleyemez (hiçbir durumda)
  assert.equal(await codeOf(run(o.id, 'approve_offer', 'sales', { lines: salesForm(offer.lines) })), 'NOT_ALLOWED');
  // "Onayla ve müşteriye gönder" (açık gönderim): müşteri artık görür; sipariş üretime geçer
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines, () => '55') });
  const v1 = await latest(o.id);
  assert.deepEqual([v1.status, String(v1.offerAmount), String(v1.amount)], ['GONDERILDI', '55', '40']);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'URETIMDE');
  audits = await priceAudits(o.id);
  assert.deepEqual([audits.length, audits[1].details.intent, audits[1].details.sent, audits[1].details.version], [2, 'approve', true, 1]);
  assert.deepEqual(audits[1].details.changes.map((x) => [x.change, x.old, x.new]), [['PRICE', '50.00', '55.00']]);
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) {
    assert.equal(await codeOf(run(o.id, 'update_offer', who, { lines: adminForm(v1.lines, () => '1') })), 'NOT_ALLOWED', who);
  }
  assert.equal(await codeOf(run(o.id, 'update_offer', 'other', { lines: adminForm(v1.lines, () => '1') })), 'NOT_FOUND', 'başka firmanın müşterisi siparişi bulamaz');

  // Müşterideki teklif: yönetici yeni fiyatı yeni sürümle gönderir (eski sürüm olduğu gibi kalır)
  const frozen = JSON.stringify(v1);
  const res = await run(o.id, 'update_offer', 'admin', { lines: adminForm(v1.lines, () => '60'), note: 'fiyat düzeltmesi' });
  const all = await versions(o.id);
  assert.equal(all.length, 2);
  assert.equal(JSON.stringify(all[0]), frozen, 'eski sürüm (satırlar, fiyatlar, tutarlar) değişmedi');
  assert.deepEqual([all[1].status, String(all[1].lines[0].offerPrice), String(all[1].lines[0].unitPrice), String(all[1].offerAmount), String(all[1].amount)], ['GONDERILDI', '60', '40', '60', '40']);
  assert.equal(String((await db.price.findUniqueOrThrow({ where: { orderId: o.id } })).amount), '60');
  audits = await priceAudits(o.id);
  const last = audits.at(-1);
  assert.deepEqual([last.userId, last.details.orderNo, last.details.version, last.details.intent, last.details.sent, last.details.offerId, last.details.currency, last.details.oldTotal, last.details.newTotal],
    [people.admin.id, o.orderNo, 2, 'update', true, all[1].id, 'EUR', '55.00', '60.00']);
  assert.deepEqual(last.details.changes.map((x) => [x.no, x.change, x.old, x.new]), [[1, 'PRICE', '55.00', '60.00']]);
  // İşlemin denetim kaydı değişikliğin özetini taşır; geçmiş notunda tutar yok (satış geçmişi görür — AUD-1)
  const tr = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'update_offer' } } });
  assert.deepEqual(tr.details.priceChange, { version: 2, count: 1 });
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, event: 'OFFER_UPDATED' } });
  assert.equal(ev.note, 'fiyat düzeltmesi');
  assert.ok((await db.orderEvent.findMany({ where: { orderId: o.id } })).every((e) => !/(55|60)[.,]00/.test(e.note ?? '')));
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { id: { in: res.outboxIds } } })).map((r) => r.type), ['ORDER_OFFER_UPDATED']);
  // Fiyatı değiştirmeyen güncelleme yeni sürüm açar ama fiyat değişikliği kaydı yazmaz
  await run(o.id, 'update_offer', 'admin', { lines: adminForm(all[1].lines) });
  assert.deepEqual([(await versions(o.id)).length, (await priceAudits(o.id)).length], [3, 3]);

  // "Her zaman": yüklendi olarak işaretlenmiş siparişte de (onaylı yükleme / belge yoksa); arşivlenmiş siparişte değil
  await db.order.update({ where: { id: o.id }, data: { status: 'YUKLENDI' } });
  await run(o.id, 'update_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => '61') });
  assert.deepEqual([(await versions(o.id)).length, String((await latest(o.id)).lines[0].offerPrice)], [4, '61']);
  await db.order.update({ where: { id: o.id }, data: { status: 'ARSIVLENDI' } });
  assert.equal(await codeOf(run(o.id, 'update_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => '62') })), 'NOT_ALLOWED');
  assert.equal((await versions(o.id)).length, 4);
}));

dbTest('fiyat kilidi: FGO belgesi, müşteri belgesi kapsamı, bekleyen belge isteği ya da onaylı yükleme varken geçmiş fiyat değişmez (PRICE_LOCKED + neden); hiçbir şey yazılmaz', offline(async () => {
  const attempt = async (o, price = '70') => run(o.id, 'update_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => price) }).then(() => null, (e) => e);
  const untouched = async (o) => {
    const fresh = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { price: true } });
    assert.deepEqual([await db.offer.count({ where: { orderId: o.id } }), fresh.version, String(fresh.price.amount), (await priceAudits(o.id)).length], [1, o.version, '50', 1]);
  };
  // a) Kuyrukta bekleyen sipariş belgesi isteği (FGO'ya gitmeden önce) — sonuçlanmamış istek fiyatı kilitler
  const a = await sentOrder('Kilit — bekleyen istek');
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: a.id, payload: { kind: 'PROFORMA' } } });
  let e = await attempt(a);
  assert.deepEqual([e?.code, e?.details?.reasons], ['PRICE_LOCKED', [{ code: 'PENDING_DOCUMENT', kind: null, ref: null }]]);
  assert.deepEqual(await priceLock(db, a.id), e.details.reasons, 'sayfadaki gerekçe aynı kuraldan');
  await untouched(a);
  // Başarısız / vazgeçilen istek kapsamı bırakır (coverageOf ile aynı): fiyat yeniden değişebilir
  await db.notificationOutbox.update({ where: { id: job.id }, data: { status: 'FAILED' } });
  assert.deepEqual(await priceLock(db, a.id), []);
  assert.equal(await attempt(a, '52'), null);

  // b) Siparişin kendi FGO belgesi
  const b = await sentOrder('Kilit — FGO belgesi');
  await db.fgoDocument.create({ data: { orderId: b.id, kind: 'PROFORMA', series: 'PRF', number: '4401', issuedAt: new Date() } });
  e = await attempt(b);
  assert.deepEqual([e?.code, e?.details?.reasons], ['PRICE_LOCKED', [{ code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF4401' }]]);
  await untouched(b);

  // c) Müşteri belgesinin (müşteri proforması) etkin kapsamı; geçersiz (VOID) parti kapsamı bırakır
  const cc = await sentOrder('Kilit — müşteri belgesi');
  const now = new Date();
  const batch = await db.billingBatch.create({
    data: {
      customerId: firm.id, kind: 'PROFORMA', status: 'ISSUED', currency: 'EUR', selectionKey: 'p4', sourceTotal: '50', ronNet: '250',
      fxRate: '5', fxDate: now, fxSource: 'BNR', fxPolicy: 'BNR', fxCurrency: 'EUR', fxBaseRate: '5', fxSourceDate: now, fxResolvedAt: now, fxManual: false,
      createdById: people.admin.id, orders: { create: { orderId: cc.id, orderNo: cc.orderNo, loadingDay: now, sourceAmount: '50', activeKey: `PROFORMA:${cc.id}` } },
    },
  });
  e = await attempt(cc);
  assert.deepEqual([e?.code, e?.details?.reasons], ['PRICE_LOCKED', [{ code: 'BILLING_BATCH', kind: 'PROFORMA', ref: null }]]);
  await untouched(cc);
  await db.billingBatchOrder.updateMany({ where: { batchId: batch.id }, data: { activeKey: null } });
  await db.billingBatch.update({ where: { id: batch.id }, data: { status: 'VOID', voidedAt: now } });
  assert.deepEqual(await priceLock(db, cc.id), []);

  // d) Onaylı yükleme: onay kalemi o fiyatın değişmez kopyasıdır
  const d = await sentOrder('Kilit — onaylı yükleme');
  const day = dayOf(-3);
  await db.order.update({ where: { id: d.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  const dd = await db.order.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal((await confirmLoading(db, { day, key: (await previewLoading(db, day)).key, actor: actor(people.admin) })).ok, true);
  e = await attempt(dd);
  assert.deepEqual([e?.code, e?.details?.reasons], ['PRICE_LOCKED', [{ code: 'CONFIRMED_LOADING', ref: day }]]);
  await untouched(dd);
}));

dbTest('fiyat kilidi eşzamanlılık: yükleme onayı ile fiyat güncellemesi aynı anda — biri kazanır, öbürü tutarlı biçimde reddedilir (kilitlenme yok)', offline(async () => {
  const o = await sentOrder('Yarış');
  const day = dayOf(-4);
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  const key = (await previewLoading(db, day)).key;
  const lines = adminForm((await latest(o.id)).lines, () => '77');
  const [upd, conf] = await Promise.all([
    run(o.id, 'update_offer', 'admin', { lines }).then(() => 'OK', (e) => e.code),
    confirmLoading(db, { day, key, actor: actor(people.admin) }),
  ]);
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId: o.id } });
  if (upd === 'OK') {
    // Fiyat önce değişti: onay eski önizlemeyle kaydedilmez (yeniden önizlenmeli)
    assert.deepEqual([conf.ok, conf.code, items.length, (await versions(o.id)).length], [false, 'STALE_PREVIEW', 0, 2]);
  } else {
    // Onay önce kaydedildi: fiyat artık o onayın kopyasıdır
    assert.deepEqual([upd, conf.ok, (await versions(o.id)).length], ['PRICE_LOCKED', true, 1]);
    assert.ok(items.length > 0 && items.every((i) => String(i.unitSale) === '50'));
  }
}));

dbTest('sandık bedeli: yalnızca yöneticinin satırı — satışın kaydı satırı korur, satış açamaz / değiştiremez; müşteri tutarına girer, satış tutarına girmez', offline(async () => {
  const o = await newOrder('Sandık bedeli');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  // Yönetici fiyatlandırırken sandık bedeli ekler: adetli, ölçüsüz satır; satış fiyatı (maliyet) yok
  await run(o.id, 'save_offer', 'admin', { lines: [...adminForm((await latest(o.id)).lines, () => '50'), crate({ id: null, offerPrice: '30' })] });
  let offer = await latest(o.id);
  const row = (l) => [l.kind, l.unit, l.adet, l.enMm, String(l.unitPrice), l.offerPrice == null ? null : String(l.offerPrice), l.crateFee];
  assert.deepEqual(offer.lines.map(row), [['CAM', 'm2', 2, 1000, '40', '50', false], ['CAM', 'adet', 1, null, '0', '30', true]]);
  assert.deepEqual([offer.lines[1].description, offer.lines[1].descriptionRo], ['Sandık parası', 'Ambalaj (ladă)']);
  const crateId = offer.lines[1].id;
  // Satışa geri gönderilir; satışın formu sandık satırını hiç almaz — satışın kaydı satırı silmez / değiştirmez
  await run(o.id, 'return_offer', 'admin', { lines: adminForm(offer.lines), returnNote: 'ölçü' });
  offer = await latest(o.id);
  await run(o.id, 'save_offer', 'sales', { lines: salesForm(offer.lines).map((l) => ({ ...l, adet: 4 })) });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.map(row), [['CAM', 'm2', 4, 1000, '40', '50', false], ['CAM', 'adet', 1, null, '0', '30', true]]);
  assert.equal(offer.lines[1].id, crateId, 'aynı satır');
  // Satış sandık satırını kimliğiyle değiştiremez; sandık parası adıyla yeni satır açamaz (Türkçe / Romence, yazım farkıyla da)
  const base = salesForm(offer.lines);
  const fake = { id: crateId, description: 'Sandık parası', poz: null, enMm: null, boyMm: null, adet: 3, unit: 'adet', kind: 'CAM', free: false, unitPrice: '0.00' };
  assert.equal(await codeOf(run(o.id, 'save_offer', 'sales', { lines: [...base, fake] })), 'CRATE_FEE_ADMIN');
  for (const description of ['Sandık parası', ' sandık  PARASI', 'Ambalaj (ladă)']) {
    assert.equal(await codeOf(run(o.id, 'submit_offer', 'sales', { lines: [...base, { ...fake, id: null, description, unitPrice: '25.00' }] })), 'CRATE_FEE_ADMIN', description);
  }
  // İşaretle gelen (taklit) satış satırı olağan satırdır: satışın kaydında sandık bedeli işareti yok sayılır
  await run(o.id, 'save_offer', 'sales', { lines: [...base, { ...fake, id: null, description: 'Ek cam', unit: 'm2', enMm: 500, boyMm: 500, adet: 1, unitPrice: '40.00', crateFee: true }] });
  offer = await latest(o.id);
  assert.deepEqual(offer.lines.map((l) => [l.description, l.crateFee]), [['Cam', false], ['Ek cam', false], ['Sandık parası', true]]);
  // Satış gönderir: sandık satırının satış fiyatı aranmaz (satışın tablosunda yok); satır yöneticiye gider
  await run(o.id, 'submit_offer', 'sales', { lines: salesForm(offer.lines).filter((l) => l.description === 'Cam') });
  offer = await latest(o.id);
  assert.deepEqual([offer.status, offer.lines.map((l) => [l.description, l.crateFee])], ['YONETIMDE', [['Cam', false], ['Sandık parası', true]]]);
  // Yönetici gönderir: müşteri tutarı cam + sandık bedeli; satış tutarı (maliyet) yalnızca cam — tutar kuralı değişmedi
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm(offer.lines) });
  const sent = await latest(o.id);
  // 1000 × 500 × 4 = 2 m² · müşteri 2 × 50 + 30 = 130 · satış 2 × 40 = 80
  assert.deepEqual([sent.status, String(sent.offerAmount), String(sent.amount)], ['GONDERILDI', '130', '80']);
  const plain = sent.lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice), offerPrice: l.offerPrice == null ? null : String(l.offerPrice) }));
  assert.deepEqual([offerTotals(atOfferPrice(plain)).amount, offerTotals(plain).amount], [130, 80]);
  // Yeni sürüm sandık bedelini taşır; değişiklik denetimde sandık satırı olarak işaretli
  await run(o.id, 'update_offer', 'admin', { lines: adminForm(sent.lines, (l) => (l.crateFee ? '35' : l.offerPrice)) });
  const v2 = await latest(o.id);
  assert.deepEqual([v2.lines.map((l) => [String(l.offerPrice), l.crateFee]), String(v2.offerAmount)], [[['50', false], ['35', true]], '135']);
  const last = (await priceAudits(o.id)).at(-1);
  assert.deepEqual([last.details.changes.map((x) => [x.change, x.crateFee, x.old, x.new]), last.details.oldTotal, last.details.newTotal], [[['PRICE', true, '30.00', '35.00']], '130.00', '135.00']);
  // İşareti taşımayan (eski / yarım) yönetici formu: kayıtlı sandık bedeli satırı kimliğiyle gelince işaret korunur (satışa açılmaz)
  await run(o.id, 'update_offer', 'admin', { lines: adminForm(v2.lines).map(({ crateFee: _, ...l }) => l) });
  assert.deepEqual((await latest(o.id)).lines.map((l) => l.crateFee), [false, true]);
}));

dbTest('teklif müşteriye gönderilince yalnızca müşteri bilgilendirilir (zil + e-posta); satışa ne zil ne e-posta; satışın öbür bildirimi durur; yeniden dağıtım çoğaltmaz', offline(async () => {
  const o = await newOrder('Bildirim');
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  // Satışın öbür olayı değişmedi: yöneticinin geri gönderdiği teklif satışa bildirilir
  const back = await run(o.id, 'return_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => '50'), returnNote: 'ölçü' });
  await dispatchInAppFor(db, back.outboxIds);
  assert.equal(await db.notification.count({ where: { orderId: o.id, userId: people.sales.id, type: 'ORDER_OFFER_RETURNED' } }), 1);
  await run(o.id, 'submit_offer', 'sales', { lines: salesForm((await latest(o.id)).lines) });
  const sent = await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines) });
  assert.ok((await db.notificationOutbox.findMany({ where: { id: { in: sent.outboxIds } } })).some((r) => r.type === 'ORDER_OFFER_SENT'));
  const n1 = await dispatchInAppFor(db, sent.outboxIds);
  const n2 = await dispatchInAppFor(db, sent.outboxIds);
  assert.equal(n2.created, 0, 'aynı olay ikinci kez dağıtılmaz');
  assert.ok(n1.created >= 1);
  const upd = await run(o.id, 'update_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, () => '52') });
  await dispatchInAppFor(db, upd.outboxIds);
  for (const type of ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED']) {
    const got = await db.notification.findMany({ where: { orderId: o.id, type }, select: { userId: true } });
    assert.deepEqual(got.map((x) => x.userId), [people.cust.id], `${type}: yalnızca müşteri`);
  }
  const staff = [people.sales.id, people.admin.id, people.drawer.id, people.inspector.id];
  assert.equal(await db.notification.count({ where: { orderId: o.id, userId: { in: staff }, type: { in: ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED'] } } }), 0);
  // E-posta alıcıları: yalnızca müşteri (siparişi açan + firma adresi); ilgili satışçı bilinse de adresi yok
  const full = { ...(await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { customer: true, createdBy: true } })), salesUsers: [people.sales] };
  for (const type of ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED']) {
    assert.deepEqual((await recipientsFor(db, type, full)).map((r) => r.email).sort(), [people.cust.email, firm.email].sort(), type);
  }
  assert.deepEqual((await recipientsFor(db, 'ORDER_OFFER_RETURNED', full)).map((r) => r.email), [], 'e-posta kuralları değişmedi (geri gönderme e-postası yok)');
}));

dbTest('siparişi silme: yalnızca yönetici; 2. adımda sipariş numarası ve önizlemedeki sürüm; mali / operasyonel geçmişi olan sipariş silinmez (LOCKED + denetim); kuyrukta iş varken BUSY', offline(async () => {
  const clean = await sentOrder('Silinecek');
  const locked = await sentOrder('Belgeli');
  const shipped = await sentOrder('Yüklendi');
  await db.fgoDocument.create({ data: { orderId: locked.id, kind: 'PROFORMA', series: 'PRF', number: '5501', issuedAt: new Date() } });
  await db.order.update({ where: { id: shipped.id }, data: { status: 'YUKLENDI', actualShipDate: new Date() } });
  // Yönetici dışında hiçbir rol (satış dahil) hiçbir adımda silemez
  for (const who of ['sales', 'drawer', 'inspector', 'cust', 'other']) {
    assert.deepEqual(await removeOrder(db, { orderId: clean.id, confirmNo: clean.orderNo, actor: actor(people[who]) }), { ok: false, code: 'FORBIDDEN' }, who);
  }
  // 1. adım (önizleme — yalnızca okur): sipariş numarası, sürüm, sonuç ve engeller
  const p = await removalPreview(db, clean.id);
  assert.deepEqual([p.orderNo, p.version, p.busy, p.reasons, p.kept.offers, p.kept.files], [clean.orderNo, clean.version, false, [], 1, 1]);
  assert.deepEqual((await removalPreview(db, locked.id)).reasons, [{ code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF5501' }]);
  assert.deepEqual((await removalPreview(db, shipped.id)).reasons, [{ code: 'SHIPPED', ref: null }]);
  assert.equal(await removalPreview(db, 'yok'), null);
  // 2. adım: numara yazılmadan / yanlış (ya da başka siparişin) numarasıyla silinmez; önizlemeden sonra değişen sipariş STALE
  for (const confirmNo of ['', '   ', null, 'GLA9999', locked.orderNo, 'ALE1']) {
    assert.deepEqual(await removeOrder(db, { orderId: clean.id, confirmNo, expectedVersion: p.version, actor: actor(people.admin) }), { ok: false, code: 'CONFIRM_REQUIRED' }, String(confirmNo));
  }
  assert.deepEqual(await removeOrder(db, { orderId: clean.id, confirmNo: clean.orderNo, expectedVersion: p.version - 1, actor: actor(people.admin) }), { ok: false, code: 'STALE' });
  assert.deepEqual(await removeOrder(db, { orderId: 'yok', confirmNo: 'GLA1', actor: actor(people.admin) }), { ok: false, code: 'NOT_FOUND' });
  // Kuyrukta belge isteği varken: önce iş bitmeli (BUSY)
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: clean.id, payload: {} } });
  assert.equal((await removalPreview(db, clean.id)).busy, true);
  assert.deepEqual(await removeOrder(db, { orderId: clean.id, confirmNo: clean.orderNo, actor: actor(people.admin) }), { ok: false, code: 'BUSY' });
  await db.notificationOutbox.delete({ where: { id: job.id } });
  // Mali / operasyonel geçmiş: silinmez — neden döner, engellenen deneme denetime yazılır, sipariş hiç değişmez
  const lockedBefore = await db.order.findUniqueOrThrow({ where: { id: locked.id } });
  const r = await removeOrder(db, { orderId: locked.id, confirmNo: locked.orderNo, actor: actor(people.admin) });
  assert.deepEqual(r, { ok: false, code: 'LOCKED', reasons: [{ code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF5501' }] });
  assert.deepEqual(await db.order.findUniqueOrThrow({ where: { id: locked.id } }), lockedBefore);
  const blocked = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REMOVE_BLOCKED', entityId: locked.id } });
  assert.deepEqual([blocked.userId, blocked.details.orderNo, blocked.details.status, blocked.details.reasons], [people.admin.id, locked.orderNo, 'URETIMDE', r.reasons]);
  assert.deepEqual(await removeOrder(db, { orderId: shipped.id, confirmNo: shipped.orderNo, actor: actor(people.admin) }), { ok: false, code: 'LOCKED', reasons: [{ code: 'SHIPPED', ref: null }] });
  assert.equal(await db.auditLog.count({ where: { action: 'ORDER_REMOVED' } }), 0);
  // Temiz sipariş: numara büyük-küçük harf / boşluk farkıyla da kabul edilir; yumuşak silme, kayıtlar durur
  const res = await removeOrder(db, { orderId: clean.id, confirmNo: ` ${clean.orderNo.toLowerCase()} `, expectedVersion: p.version, actor: actor(people.admin) });
  assert.deepEqual(res, { ok: true, orderNo: clean.orderNo });
  const gone = await db.order.findUniqueOrThrow({ where: { id: clean.id }, include: { offers: { include: { lines: true } }, files: true } });
  assert.deepEqual([gone.status, gone.removedStatus, !!gone.removedAt, gone.removedById, gone.offers.length, gone.offers[0].lines.length, gone.files.length],
    ['IPTAL', 'URETIMDE', true, people.admin.id, 1, 1, 1]);
  assert.equal(await removalPreview(db, clean.id), null, 'silinmiş siparişin silme önizlemesi yok');
  assert.deepEqual(await removeOrder(db, { orderId: clean.id, confirmNo: clean.orderNo, actor: actor(people.admin) }), { ok: false, code: 'ALREADY_REMOVED' });
  const removed = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REMOVED', entityId: clean.id } });
  assert.deepEqual([removed.userId, removed.details.orderNo, removed.details.statusBefore, removed.details.kept.offers], [people.admin.id, clean.orderNo, 'URETIMDE', 1]);
  // Geri yükleme önceki durumu getirir (silme geri alınabilir; hiçbir kayıt yeniden üretilmez)
  assert.deepEqual(await restoreOrder(db, { orderId: clean.id, actor: actor(people.admin) }), { ok: true, orderNo: clean.orderNo, status: 'URETIMDE' });
  assert.equal(await db.offer.count({ where: { orderId: clean.id } }), 1);
}));
