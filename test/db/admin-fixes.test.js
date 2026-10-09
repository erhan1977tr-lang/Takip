// Yönetici Paneli Düzeltme Paketi 1 (veritabanıyla): yöneticinin e-postaları (karar 218) — müşterinin yeni siparişi, satışın
// fabrika fiyatını GERÇEKTEN değiştirmesi (aynı fiyatın yeniden gönderimi bildirim üretmez), satışın yöneticiye gönderdiği
// teklifi geri alması (yöneticinin bekleyen kuyruğu ve zili güncel durumu gösterir), telafi camında müşteri fiyatının
// değişmesi (aynı fiyat → e-posta yok); olay başına bir e-posta (yeniden işleme, yeniden deneme ve çift tıklama kopya
// üretmez); pasif yönetici hesabı ve işlemi yapan yönetici e-posta almaz. "Profil Siparişleri" sayacı (karar 216).
// Gerçek SMTP / FGO / ağ yok: sahte gönderici; her ağ çağrısı testi düşürür (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { adminOfferGroups, newProfileCount } from '../../server/orders/queues.js';
import { dispatchNotifications } from '../../server/notifications/email.js';
import { dispatchInApp, dispatchInAppFor } from '../../server/notifications/inapp.js';
import { createCompensation } from '../../server/orders/compensation.js';
import { savePrices, saveTable } from '../../server/pricing/tables.js';

let db;
let firm;
let glass;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);

// Sahte SMTP: gönderilen her e-posta burada; fail kümesindeki adrese bir kez hata verir (yeniden deneme)
const sent = [];
const fail = new Set();
const transport = {
  sendMail: async (m) => {
    if (fail.has(m.to)) { fail.delete(m.to); throw new Error('SMTP 451 geçici hata'); }
    sent.push(m);
    return { messageId: `m${sent.length}` };
  },
};
const opts = { transport, from: 'takip@yp.test', appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest' };
/** İşçinin e-posta turu: kuyruk boşalana kadar */
async function pump() {
  for (let i = 0; i < 30; i++) {
    const r = await dispatchNotifications(db, opts);
    if (r.sent + r.failed + r.skipped === 0) return;
  }
}
const mailsTo = (email) => sent.filter((m) => m.to === email);
const outbox = (orderId, type) => db.notificationOutbox.count({ where: { orderId, type } });
let fileNo = 0;
const newOrder = async (title) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: actor(people.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '8 MM TEMPER', glassNameRo: 'SECURIZAT 8 MM', glassWeightKgM2: 20, camAdedi: 2 }],
    files: [{ storageKey: `2026/10/yp-${fileNo}.pdf`, name: `yp-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
const offerOf = (orderId) => db.offer.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const lineOf = (l, price) => ({ id: l.id, description: l.description, poz: l.poz, enMm: l.enMm ?? 1000, boyMm: l.boyMm ?? 1000, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free, unitPrice: price ?? Number(l.unitPrice).toFixed(2) });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Yonetici Paketi Cam SRL', prefix: 'YPC', email: 'firma@yp.test' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@yp.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, language: 'tr', ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('admin2', 'ADMIN', factory.id);
  // Pasif yönetici hesabı: yöneticinin e-postaları yalnızca etkin hesaplara gider
  await mk('eski', 'ADMIN', factory.id, { isActive: false });
  await mk('sales', 'SATIS', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  glass = await db.glassProduct.create({ data: { nameTr: '8 MM TEMPER', colorTr: '', nameRo: 'SECURIZAT 8 MM', colorRo: '', weightKgM2: 20 } });
  const table = await saveTable(db, null, { name: 'Fabrika 2026', currency: 'EUR', holePrice: 3, cncPrice: 10 }, actor(people.admin));
  await savePrices(db, table.id, { [glass.id]: 30 }, actor(people.admin));
  // E-posta gönderiminin başlangıç anı: önceki olaylar gönderilmez
  await dispatchNotifications(db, { ...opts, now: new Date(Date.now() - 1000) });
});
after(closeDb);

dbTest('yeni sipariş (A): müşterinin cam siparişi satışa VE etkin yöneticilere bir kez; pasif hesaba değil; yeniden işleme kopya üretmez', offline(async () => {
  const o = await newOrder('Yeni sipariş e-postası');
  assert.equal(await outbox(o.id, 'ORDER_CREATED'), 1);
  await pump();
  for (const who of ['admin', 'admin2', 'sales']) {
    const m = mailsTo(people[who].email).filter((x) => x.subject.startsWith(o.orderNo));
    assert.equal(m.length, 1, who);
    assert.equal(m[0].subject, `${o.orderNo} — Yeni sipariş`);
    assert.match(m[0].text, new RegExp(`https://takip\\.test/siparisler/${o.id}`), 'güvenli sipariş bağlantısı');
    assert.match(m[0].html, /cid:gkh-logo@takip/, 'ortak GKH şablonu');
  }
  assert.equal(mailsTo(people.eski.email).length, 0, 'pasif yönetici');
  assert.equal(mailsTo(people.cust.email).filter((x) => x.subject.startsWith(o.orderNo)).length, 0, 'müşteriye yeni sipariş e-postası yok');
  const before = sent.length;
  await pump();
  await pump();
  assert.equal(sent.length, before, 'yeniden işleme yeni e-posta üretmez');
}));

dbTest('fabrika fiyatı (B): satış liste fiyatını gerçekten değiştirince yöneticiye e-posta + zil; aynı fiyatın yeniden gönderimi bildirim üretmez; yeni fark yeniden bildirilir', offline(async () => {
  const o = await newOrder('Fiyat değişikliği');
  await run(o.id, 'no_drawing', 'sales');
  let offer = await offerOf(o.id);
  assert.equal(Number(offer.lines[0].listPrice), 30, 'fabrika fiyat tablosundan');
  // Liste fiyatıyla gönderim: fark yok, olay yok
  await run(o.id, 'submit_offer', 'sales', { lines: [lineOf(offer.lines[0])] });
  assert.equal(await outbox(o.id, 'ORDER_PRICE_OVERRIDE'), 0);
  offer = await offerOf(o.id);
  await run(o.id, 'return_offer', 'admin', { lines: [lineOf(offer.lines[0])], returnNote: 'kontrol' });
  // Satış fiyatı değiştirir → olay (tutar taşımaz)
  offer = await offerOf(o.id);
  const changed = await run(o.id, 'submit_offer', 'sales', { lines: [lineOf(offer.lines[0], '27.50')] });
  assert.equal(await outbox(o.id, 'ORDER_PRICE_OVERRIDE'), 1);
  const ev = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: o.id, type: 'ORDER_PRICE_OVERRIDE' } });
  assert.deepEqual([ev.payload.qty, ev.payload.actorId], [1, people.sales.id]);
  assert.ok(!JSON.stringify(ev.payload).includes('27.5'), 'olayda tutar yok');
  await dispatchInAppFor(db, changed.outboxIds);
  assert.equal(await db.notification.count({ where: { orderId: o.id, type: 'ORDER_PRICE_OVERRIDE', userId: people.admin.id } }), 1);
  assert.equal(await db.notification.count({ where: { orderId: o.id, type: 'ORDER_PRICE_OVERRIDE', userId: people.sales.id } }), 0, 'işlemi yapana değil');
  // Aynı fiyatlar yeniden gönderilir (yönetici geri gönderdi): yeni olay / e-posta yok
  offer = await offerOf(o.id);
  await run(o.id, 'return_offer', 'admin', { lines: [lineOf(offer.lines[0])], returnNote: 'tekrar' });
  offer = await offerOf(o.id);
  assert.equal(Number(offer.lines[0].unitPrice), 27.5, 'satışın fiyatı duruyor');
  await run(o.id, 'submit_offer', 'sales', { lines: [lineOf(offer.lines[0])] });
  assert.equal(await outbox(o.id, 'ORDER_PRICE_OVERRIDE'), 1, 'aynı fiyat: bildirim yok');
  // Yönetici "Gördüm" dese de aynı fark yeniden bildirilmez; yeni fiyat bildirilir
  await db.adminAlert.updateMany({ where: { orderId: o.id, resolvedAt: null }, data: { resolvedAt: new Date() } });
  offer = await offerOf(o.id);
  await run(o.id, 'return_offer', 'admin', { lines: [lineOf(offer.lines[0])], returnNote: 'tekrar' });
  offer = await offerOf(o.id);
  await run(o.id, 'submit_offer', 'sales', { lines: [lineOf(offer.lines[0], '26.00')] });
  assert.equal(await outbox(o.id, 'ORDER_PRICE_OVERRIDE'), 2);
  await pump();
  const mails = mailsTo(people.admin.email).filter((m) => m.subject === `${o.orderNo} — Satış fabrika fiyatını değiştirdi`);
  assert.equal(mails.length, 2, 'iki gerçek değişiklik, iki e-posta');
  assert.match(mails[0].text, /Açıklama: Satış, teklifi 1 satırda fabrika fiyat tablosundaki fiyattan farklı/);
  assert.ok(mails.every((m) => !/27[.,]50\b|26[.,]00\b|EUR/.test(m.text)), 'e-postada tutar yok');
  assert.equal(mailsTo(people.sales.email).filter((m) => m.subject.includes('fabrika fiyatını')).length, 0, 'satışa gitmez');
  assert.equal(mailsTo(people.eski.email).length, 0);
}));

dbTest('geri alma (C): yöneticiye e-posta; bekleyen kuyruk ve zil güncel — eski "yöneticiye gönderildi" okunmuş sayılır; yeniden gönderim yeni bildirimdir', offline(async () => {
  const o = await newOrder('Geri alma e-postası');
  await pump(); // siparişin "yeni sipariş" e-postası (bu testin yeniden deneme denetimine karışmasın)
  await run(o.id, 'no_drawing', 'sales');
  const offer = await offerOf(o.id);
  const submitted = await run(o.id, 'submit_offer', 'sales', { lines: [lineOf(offer.lines[0])] });
  await dispatchInAppFor(db, submitted.outboxIds);
  const pendingFor = (u) => db.notification.count({ where: { orderId: o.id, userId: u.id, type: 'ORDER_OFFER_SUBMITTED', isRead: false } });
  assert.deepEqual([await pendingFor(people.admin), await pendingFor(people.admin2)], [1, 1]);
  const queue = async () => adminOfferGroups(await db.order.findMany({ where: { id: o.id }, include: { offers: { orderBy: { createdAt: 'desc' } } } })).find((g) => g.key === 'YONETIMDE').rows.length;
  assert.equal(await queue(), 1, 'yöneticinin bekleyen kuyruğunda');

  const res = await run(o.id, 'withdraw_offer', 'sales');
  assert.equal(await outbox(o.id, 'ORDER_OFFER_WITHDRAWN'), 1);
  await dispatchInAppFor(db, res.outboxIds);
  assert.equal(await queue(), 0, 'bekleyen kuyruktan çıktı');
  assert.deepEqual([await pendingFor(people.admin), await pendingFor(people.admin2)], [0, 0], 'eski bildirim okunmuş sayıldı');
  assert.equal(await db.notification.count({ where: { orderId: o.id, type: 'ORDER_OFFER_WITHDRAWN', isRead: false, userId: { in: [people.admin.id, people.admin2.id] } } }), 2);
  assert.equal(await db.notification.count({ where: { orderId: o.id, type: 'ORDER_OFFER_WITHDRAWN', userId: people.sales.id } }), 0);
  // Çift tıklama: ikinci geri alma reddedilir, ikinci olay yazılmaz
  assert.equal(await codeOf(run(o.id, 'withdraw_offer', 'sales')), 'NOT_ALLOWED');
  assert.equal(await outbox(o.id, 'ORDER_OFFER_WITHDRAWN'), 1);
  // E-posta: etkin iki yöneticiye birer; biri geçici hata alırsa yeniden denemede yalnızca ona gider
  fail.add(people.admin2.email);
  await pump();
  const row = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: o.id, type: 'ORDER_OFFER_WITHDRAWN' } });
  assert.equal(row.status, 'PENDING', 'hata alan alıcı için kuyrukta');
  await db.notificationOutbox.update({ where: { id: row.id }, data: { availableAt: new Date() } });
  await pump();
  const subject = `${o.orderNo} — Satış, yöneticiye gönderdiği teklifi geri aldı`;
  assert.deepEqual([mailsTo(people.admin.email).filter((m) => m.subject === subject).length, mailsTo(people.admin2.email).filter((m) => m.subject === subject).length], [1, 1], 'alıcı başına bir e-posta');
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).status, 'SENT');
  assert.match(mailsTo(people.admin.email).find((m) => m.subject === subject).text, /Açıklama: Teklif yeniden satışta/);
  // Yeniden gönderim: yeni ve okunmamış "yöneticiye gönderildi" bildirimi (geri alma onu etkilemez)
  const again = await run(o.id, 'submit_offer', 'sales', { lines: [lineOf((await offerOf(o.id)).lines[0])] });
  await dispatchInAppFor(db, again.outboxIds);
  assert.deepEqual([await pendingFor(people.admin), await queue()], [1, 1]);
}));

dbTest('telafi fiyatı (E): farklı fiyat ya da bedelsiz → yöneticiye e-posta; aynı fiyat → yok; çift tıklama tek olay; işlemi yapan yöneticiye kendi işlemi gitmez', offline(async () => {
  const src = await db.order.create({
    data: {
      orderNo: 'YPC900', customerOrderNo: 900, title: 'Telafi kaynağı', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: people.admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(`${dayOf(-3)}T12:00:00Z`),
      offers: {
        create: {
          status: 'GONDERILDI', currency: 'EUR', amount: '300', offerAmount: '500', createdById: people.admin.id, sentAt: new Date(),
          lines: { create: [{ sortOrder: 0, description: '8 MM TEMPER', descriptionRo: 'SECURIZAT 8 MM', enMm: 1000, boyMm: 1000, adet: 10, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '50', listPrice: '30' }] },
        },
      },
    },
  });
  await db.price.create({ data: { orderId: src.id, amount: '500', setById: people.admin.id } });
  const lineId = async () => (await db.offer.findFirstOrThrow({ where: { orderId: src.id, status: 'GONDERILDI' }, orderBy: { createdAt: 'desc' }, include: { lines: true } })).lines[0].id;
  const compEvents = () => db.notificationOutbox.findMany({ where: { type: 'ORDER_COMPENSATION_PRICE' }, orderBy: { createdAt: 'asc' } });
  let k = 0;
  const create = async (who, mode, extra = {}) => createCompensation(db, {
    orderId: src.id, lineId: await lineId(), quantity: 1, mode, dest: { type: 'NEW', day: dayOf(30) }, requestKey: `yp-${++k}-${'x'.repeat(16)}`, confirm: true, actor: actor(people[who]), ...extra,
  });
  // Aynı fiyat: e-posta yok
  const same = await create('sales', 'NORMAL');
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal((await compEvents()).length, 0);
  // Bedelsiz (fiyat değişti) ve farklı fiyat (satış seçer, fiyatı yönetici belirler): birer olay
  const free = await create('sales', 'FREE');
  const custom = await create('sales', 'CUSTOM');
  assert.ok(free.ok && custom.ok);
  // Çift tıklama: aynı istek anahtarı ilk sonucu döner, ikinci olay yazılmaz
  const key = `yp-dup-${'x'.repeat(16)}`;
  const first = await createCompensation(db, { orderId: src.id, lineId: await lineId(), quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: dayOf(31) }, requestKey: key, confirm: true, actor: actor(people.sales) });
  const second = await createCompensation(db, { orderId: src.id, lineId: await lineId(), quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: dayOf(31) }, requestKey: key, confirm: true, actor: actor(people.sales) });
  assert.deepEqual([first.ok, second.duplicate, second.compensationId], [true, true, first.compensationId]);
  // Yönetici farklı fiyatı kendisi yazar: olay var; kendisine değil öbür etkin yöneticiye gider
  const byAdmin = await create('admin', 'CUSTOM', { price: '45' });
  assert.equal(byAdmin.ok, true, JSON.stringify(byAdmin));
  const evs = await compEvents();
  assert.deepEqual(evs.map((e) => [e.payload.mode, e.payload.qty, e.payload.sourceOrderNo, !!e.payload.pending]), [
    ['FREE', 1, 'YPC900', false], ['CUSTOM', 1, 'YPC900', true], ['FREE', 1, 'YPC900', false], ['CUSTOM', 1, 'YPC900', true],
  ]);
  assert.ok(evs.every((e) => !/"(offerPrice|price|amount)"/.test(JSON.stringify(e.payload))), 'olayda tutar yok');
  await pump();
  const comp = (u) => mailsTo(u.email).filter((m) => /Telafi camı/.test(m.subject));
  assert.deepEqual(comp(people.admin).map((m) => m.subject.split(' — ')[1]).sort(), ['Telafi camı bedelsiz açıldı', 'Telafi camı bedelsiz açıldı', 'Telafi camı için farklı fiyat seçildi']);
  assert.equal(comp(people.admin2).length, 4, 'öbür yönetici, yöneticinin kendi telafisi dahil');
  assert.equal(comp(people.eski).length, 0);
  assert.equal(comp(people.sales).length, 0);
  assert.ok(comp(people.admin2).some((m) => /kaynak sipariş YPC900\. Müşteri fiyatı yöneticinin onayını bekliyor\./.test(m.text)));
}));

dbTest('profil bölümü sayacı (karar 216): kullanıcının kapsamında fiyat bekleyen profil siparişleri; iptal, arşiv, silinmiş ve öbür adımlar sayılmaz', offline(async () => {
  let no = 0;
  const profile = (stage, status = 'YENI', extra = {}) => db.order.create({
    data: {
      orderNo: `YPCP${++no}`, customerOrderNo: no, title: 'Profil', orderTypeCode: 'PROFILE_ORDER', customerId: firm.id, createdById: people.cust.id, status, ...extra,
      profile: { create: { stage } },
    },
  });
  const admin = { appRole: 'ADMIN', customerId: null };
  const before = await newProfileCount(db, admin);
  await profile('FIYAT_BEKLIYOR');
  await profile('FIYAT_BEKLIYOR');
  await profile('TEKLIF_GONDERILDI', 'HAZIRLANIYOR');
  await profile('FIYAT_BEKLIYOR', 'IPTAL');
  await profile('FATURALANDI', 'ARSIVLENDI');
  await profile('FIYAT_BEKLIYOR', 'YENI', { removedAt: new Date() });
  assert.equal(await newProfileCount(db, admin), before + 2);
  // Kapsam: satış profil siparişlerini hiç görmez; başka firmanın müşterisi kendi firması dışını saymaz
  assert.equal(await newProfileCount(db, { appRole: 'SATIS', customerId: null }), 0);
  assert.equal(await newProfileCount(db, { appRole: 'MUSTERI', customerId: 'baska-firma' }), 0);
  // Uygulama içi dağıtım her olayı bir kez işler (sayaç kuyruktan bağımsızdır)
  await dispatchInApp(db);
}));
