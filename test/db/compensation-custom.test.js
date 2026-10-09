// Telafi "Farklı fiyat" — teklif tutarlılığı (karar 157; 3.51.1 doğrulaması) — veritabanıyla.
//   - Fiyatlandırma penceresi: kaynak adedi yeni sürümle düşer (eski sürüm aynen durur), telafi siparişinin teklifi yöneticide
//     bekler; müşteriye giden (gönderilmiş) hiçbir teklifte ve fiyat kaydında onaylanmamış fiyat yoktur — yönetici fiyatı
//     taslak olarak kaydetse de. Yönetici onaylayınca müşteri nihai teklifi görür (olağan "teklif hazır" bildirimi).
//   - Miktarlar: kaynak + telafi = önceki adet / m²; adet değişikliği denetim kaydında (önce → sonra, yeni sürüm).
//   - Yüklenmiş ya da FGO belgeli kaynakta güvenli davranış: kaynak teklif ve belge değişmez, telafi ek üretimdir.
//   - Eşzamanlı değişiklik: kaynak sipariş okunduktan sonra başka bir işlemle değiştiyse hiçbir şey yazılmaz (CONFLICT).
// FGO'ya / ağa hiçbir istek yapılmaz (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const comp = await import('../../server/orders/compensation.js');
const c = await import('../../server/loading/confirmation.js');
const n = await import('../../server/notifications/inapp.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');

const U = {};
let db, A;
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const [PAST, F1, F2] = [-5, 15, 25].map(dayOf);
let k = 0;
const key = () => `farkli-${++k}-${'x'.repeat(16)}`;
const FULL = { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } }, price: true };
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: FULL });
/** Müşterinin gördüğü teklifler: yalnızca gönderilmiş sürümler (lib/orders.ts → sanitizeOrder ile aynı kural) */
const customerOffers = (o) => o.offers.filter((x) => x.status === 'GONDERILDI');
const glass = (adet) => ({ description: 'Temper Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 2000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '66.96', listPrice: '30', weightKgM2: '20.8' });
async function order(no, day, adet = 10) {
  const o = await db.order.create({
    data: {
      orderNo: `ABC${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: A.id, createdById: U.admin.id, status: 'URETIMDE', estimatedShipDate: at(day),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: (adet * 2 * 30).toFixed(2), offerAmount: (adet * 2 * 66.96).toFixed(2), createdById: U.admin.id, sentAt: new Date(), lines: { create: [{ sortOrder: 0, ...glass(adet) }] } } },
      price: { create: { amount: (adet * 2 * 66.96).toFixed(2), setById: U.admin.id } },
    },
    include: FULL,
  });
  return o;
}
const custom = (src, p = {}) => comp.createCompensation(db, {
  orderId: src.id, lineId: src.offers[0].lines[0].id, quantity: 3, mode: 'CUSTOM', dest: { type: 'NEW', day: F2 }, requestKey: key(), confirm: true, actor: act(U.sales), ...p,
});
/** Teklif formunun gönderdiği satırlar (yönetici: müşteri fiyatıyla) */
const formLines = (lines, offerPrice) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: Number(l.unitPrice).toFixed(2), offerPrice: l.free ? '0.00' : offerPrice ?? (l.offerPrice == null ? null : Number(l.offerPrice).toFixed(2)),
}));
const pieces = (o) => o.lines.filter((l) => l.kind === 'CAM' && l.unit === 'm2').reduce((s, l) => s + l.adet, 0);
/** Bir dizi string içinde iğnelerden biri geçiyor mu (müşteriye giden kayıtların tamamında arama) */
const contains = (value, needles) => needles.filter((x) => JSON.stringify(value).includes(x));

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'ABC Glass SRL', prefix: 'ABC', email: 'abc@farkli.test' } });
  const user = (name, appRole, customerId, extra = {}) => db.user.create({ data: { email: `${name}@farkli.test`, name, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { U[name] = u; });
  await user('admin', 'ADMIN', factory.id);
  await user('sales', 'SATIS', factory.id);
  await user('custA', 'MUSTERI', A.id, { canApprove: true });
});
after(async () => {
  await closeDb();
});

dbTest('farklı fiyat, temiz kaynak: kaynak yeni sürümle düşer; telafi fiyatlanana kadar müşteriye onaylanmamış fiyat gitmez; onayda nihai teklif', offline(async () => {
  const S = await order(500, F1);
  const v1 = JSON.stringify(S.offers[0]);
  const r = await custom(S);
  assert.deepEqual([r.ok, r.status, r.via, r.direct, r.created], [true, 'APPLIED', 'NEW', false, true]);
  assert.deepEqual(r.source, { reduced: true, reason: null, before: 10, after: 7 });

  // Kaynak: müşterideki teklifin YENİ sürümü 7 cam; eski sürüm (10 cam) aynen durur; fiyat kaydı yeni sürümle aynı tutar
  const src = await load(S.id);
  assert.deepEqual(customerOffers(src).map(pieces), [7, 10]);
  assert.equal(JSON.stringify(src.offers[1]), v1, 'müşteriye gitmiş eski sürüm değişmez');
  assert.deepEqual([src.offers[0].offerAmount.toString(), src.price.amount.toString(), src.version], ['937.44', '937.44', S.version + 1]);
  assert.deepEqual(src.offers[0].lines.map((l) => [l.adet, l.offerPrice.toString(), l.unitPrice.toString()]), [[7, '66.96', '30']], 'kalan camın fiyatları değişmez');
  // Müşteri kaynağın güncellendiğini olağan olayla öğrenir (tutarsız ara durum yok)
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: S.id } })).map((x) => x.type), ['ORDER_OFFER_UPDATED']);

  // Telafi siparişi: teklifi yöneticide, gönderilmemiş, müşteri fiyatı boş; fiyat kaydı yok → müşteriye görünen teklif yok
  let T = await load(r.destOrderId);
  assert.deepEqual([T.orderNo, T.status, T.offers.length, T.offers[0].status, T.offers[0].sentAt, T.price], ['ABC500-T', 'HAZIRLANIYOR', 1, 'YONETIMDE', null, null]);
  assert.deepEqual(T.offers[0].lines.map((l) => [l.adet, l.offerPrice, l.unitPrice.toString(), !!l.compensationId]), [[3, null, '30', true]]);
  assert.deepEqual(customerOffers(T), []);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: T.id, type: { not: 'ORDER_COMPENSATION_PRICE' } } }), 0, 'müşteriye "teklif hazır" gitmez');
  // Yöneticiye e-posta (karar 218): farklı fiyat = müşteri fiyatı değişiyor → telafi başına BİR olay; tutar taşımaz,
  // yöneticinin fiyatını beklediği açıklamada (pending)
  const mail = await db.notificationOutbox.findMany({ where: { orderId: T.id, type: 'ORDER_COMPENSATION_PRICE' } });
  assert.deepEqual(mail.map((m) => [m.payload.compensationId, m.payload.mode, m.payload.qty, m.payload.sourceOrderNo, m.payload.pending]), [[r.compensationId, 'CUSTOM', 3, S.orderNo, true]]);
  assert.deepEqual(contains(mail, ['66.96', '66,96', '81.37']), [], 'e-posta olayında tutar yok');
  // Miktarlar: kaynak + telafi = önceki (adet ve m²)
  assert.equal(pieces(customerOffers(src)[0]) + pieces(T.offers[0]), 10);
  // Denetim: adet değişikliği (önce → sonra) ve kaynağın yeni sürümü
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', entityId: S.id } });
  assert.deepEqual([audit.details.priceMode, audit.details.offerPrice, audit.details.quantity, audit.details.destOrderNo], ['CUSTOM', null, 3, 'ABC500-T']);
  assert.deepEqual(audit.details.source, { reduced: true, reason: null, before: 10, after: 7, offerId: src.offers[0].id });

  // Yönetici fiyatı TASLAK olarak kaydeder (göndermez): teklif yöneticide kalır; telafi kaydına fiyat yazılmaz; müşteriye
  // giden hiçbir kayıtta (gönderilmiş teklifler, fiyat kaydı, kuyruk) bu fiyat yok
  await runOrderAction(db, { orderId: T.id, action: 'save_offer', actor: act(U.admin), payload: { lines: formLines(T.offers[0].lines, '81.37') } });
  T = await load(T.id);
  assert.deepEqual([T.offers[0].status, T.offers[0].lines[0].offerPrice.toString(), T.price], ['YONETIMDE', '81.37', null]);
  assert.equal((await db.compensation.findUniqueOrThrow({ where: { id: r.compensationId } })).offerPrice, null);
  const visible = async () => {
    const all = await db.order.findMany({ where: { customerId: A.id }, include: FULL });
    return { offers: all.flatMap(customerOffers), prices: all.map((o) => o.price), outbox: await db.notificationOutbox.findMany({ where: { orderId: { in: all.map((o) => o.id) } } }) };
  };
  assert.deepEqual(contains(await visible(), ['81.37', '81,37', '488.22']), [], 'onaylanmamış fiyat müşteriye giden kayıtlarda yok');
  await n.dispatchInApp(db);
  assert.deepEqual(contains(await db.notification.findMany({ where: { userId: U.custA.id } }), ['81.37', '81,37']), []);

  // Yönetici onaylar (72): teklif müşteride, fiyat kaydı, telafi kaydına uygulanan fiyat; müşteriye olağan "teklif hazır"
  T = await load(T.id);
  await runOrderAction(db, { orderId: T.id, action: 'approve_offer', actor: act(U.admin), payload: { lines: formLines(T.offers[0].lines, '72.00') } });
  T = await load(T.id);
  assert.deepEqual([T.status, T.offers[0].status, T.offers[0].sentAt instanceof Date, T.offers[0].offerAmount.toString(), T.price.amount.toString()], ['URETIMDE', 'GONDERILDI', true, '432', '432']);
  assert.deepEqual(customerOffers(T).map((o) => o.lines.map((l) => [l.adet, l.offerPrice.toString()])), [[[3, '72']]]);
  assert.equal(Number((await db.compensation.findUniqueOrThrow({ where: { id: r.compensationId } })).offerPrice), 72);
  const approve = (await db.auditLog.findMany({ where: { action: 'ORDER_TRANSITION', entityId: T.id } })).find((x) => x.details.action === 'approve_offer');
  assert.deepEqual(approve.details.compensationPrices, [{ compensationId: r.compensationId, offerPrice: 72, free: false }]);
  assert.ok((await db.notificationOutbox.findMany({ where: { orderId: T.id } })).some((x) => x.type === 'ORDER_OFFER_SENT'));
  await n.dispatchInApp(db);
  assert.ok((await db.notification.findMany({ where: { userId: U.custA.id, orderId: T.id } })).some((x) => x.type === 'ORDER_OFFER_SENT'), 'müşteri nihai teklifi görür');
  // Son durum: kaynak 7 (66,96) + telafi 3 (72) — kaynak bir daha değişmedi
  assert.deepEqual(customerOffers(await load(S.id)).map(pieces), [7, 10]);
}));

dbTest('yüklenmiş ya da FGO belgeli kaynak: teklif, onaylı yükleme ve belge değişmez; farklı fiyat telafisi ek üretim olarak açılır', offline(async () => {
  // Yüklemesi onaylanmış kaynak
  const L = await order(501, PAST);
  assert.equal((await c.confirmLoading(db, { day: PAST, key: (await c.previewLoading(db, PAST)).key, actor: act(U.admin) })).ok, true);
  const loadedBefore = JSON.stringify({ offers: (await load(L.id)).offers, items: await db.loadingConfirmationItem.findMany({ where: { orderId: L.id }, orderBy: { id: 'asc' } }) });
  // FGO proforması kesilmiş kaynak (belge zaten FGO'da; bu testte FGO'ya hiç gidilmez)
  const B = await order(502, F1);
  await db.fgoDocument.create({ data: { orderId: B.id, kind: 'PROFORMA', series: 'PRF', number: '7701', issuedAt: new Date(), currency: 'RON', total: '1620.00', paid: '0' } });
  const docsBefore = JSON.stringify(await db.fgoDocument.findMany({ orderBy: { id: 'asc' } }));
  const billedBefore = JSON.stringify((await load(B.id)).offers);
  const jobs = await db.notificationOutbox.count({ where: { type: { startsWith: 'FGO' } } });

  for (const [S, reason, snap] of [[L, 'LOADED', loadedBefore], [B, 'BILLING', billedBefore]]) {
    const r = await custom(S);
    assert.deepEqual([r.ok, r.status, r.source], [true, 'APPLIED', { reduced: false, reason, before: null, after: null }], reason);
    const now = await load(S.id);
    assert.deepEqual([now.offers.length, pieces(now.offers[0]), now.version], [1, 10, S.version], `${reason}: kaynak teklif değişmez`);
    const T = await load(r.destOrderId);
    assert.deepEqual([T.offers[0].status, pieces(T.offers[0]), customerOffers(T).length], ['YONETIMDE', 3, 0], `${reason}: telafi ek üretim, fiyatlanmadan müşteriye gitmez`);
    if (reason === 'LOADED') {
      assert.equal(JSON.stringify({ offers: now.offers, items: await db.loadingConfirmationItem.findMany({ where: { orderId: L.id }, orderBy: { id: 'asc' } }) }), snap);
    } else assert.equal(JSON.stringify(now.offers), snap);
  }
  assert.equal(JSON.stringify(await db.fgoDocument.findMany({ orderBy: { id: 'asc' } })), docsBefore, 'FGO belgeleri değişmez');
  assert.equal(await db.notificationOutbox.count({ where: { type: { startsWith: 'FGO' } } }), jobs, 'belge işi kuyruğa girmez');
  assert.equal(await db.glassBilling.count(), 0);
}));

dbTest('eşzamanlı değişiklik: kaynak okunduktan sonra başka bir işlem siparişi değiştirdiyse telafi hiçbir şey yazmaz (CONFLICT)', offline(async () => {
  const S = await order(503, F1);
  // Kaynak sipariş işlem içinde okunduktan HEMEN sonra başka bir bağlantıdan güncellenir (ör. yöneticinin "teklifi güncelle"si)
  let fired = 0;
  const bind = (obj, prop) => {
    const v = Reflect.get(obj, prop);
    return typeof v === 'function' ? v.bind(obj) : v;
  };
  const wrapTx = (tx) => new Proxy(tx, {
    get(t, prop) {
      if (prop !== 'order') return bind(t, prop);
      return new Proxy(t.order, {
        get(d, q) {
          if (q !== 'findUnique') return bind(d, q);
          return async (args) => {
            const row = await d.findUnique(args);
            if (row?.id === S.id && args?.include?.fgoDocuments && !fired++) await db.order.update({ where: { id: S.id }, data: { version: { increment: 1 } } });
            return row;
          };
        },
      });
    },
  });
  const racy = new Proxy(db, { get: (t, prop) => (prop === '$transaction' ? (fn, opts) => t.$transaction((tx) => fn(wrapTx(tx)), opts) : bind(t, prop)) });
  const requestKey = key();
  const r = await comp.createCompensation(racy, { orderId: S.id, lineId: S.offers[0].lines[0].id, quantity: 3, mode: 'CUSTOM', dest: { type: 'NEW', day: F2 }, requestKey, confirm: true, actor: act(U.sales) });
  assert.equal(fired, 1);
  assert.deepEqual(r, { ok: false, code: 'CONFLICT' });
  // Hiçbir şey yazılmadı: telafi kaydı, telafi siparişi, kaynağın yeni sürümü, karar kaydı yok
  assert.equal(await db.compensation.count({ where: { requestKey } }), 0);
  assert.equal(await db.order.count({ where: { compOfId: S.id } }), 0);
  const now = await load(S.id);
  assert.deepEqual([now.offers.length, pieces(now.offers[0]), now.version], [1, 10, S.version + 1]);
  assert.equal(await db.adminAlert.count({ where: { orderId: S.id } }), 0);
  // Güncel sürümle yeniden denenince olağan biçimde açılır
  const again = await custom(S);
  assert.deepEqual([again.ok, again.source], [true, { reduced: true, reason: null, before: 10, after: 7 }]);
}));
