// 3.93.0 regresyon düzeltmeleri (karar 288) — FGO ve mali belgeler, gerçek PostgreSQL ile:
//   O2  profil nihai faturası avans düşümünü fatura tutarıyla sınırlar; avans toplamı faturayı aşarsa eksi fatura FGO'ya gitmez
//   O4  FGO belgeyi kestikten sonra TAKİP kaydı yazılamazsa iş otomatik yeniden gönderilmez: belirsiz (yönetici incelemesi)
//   D7  belirsiz işte "FGO'daki belgeyi kaydet" elle girilen tek seferlik fatura numarasını da temizler
//   D8  avans faturası FGO'ya TVA dahil toplamla (PretTotal) gider: avans = tahsilat, kuruşu kuruşuna
//   D10 başka bir faturada düşülmüş avans faturası "FGO'da silindi" diye TAKİP'ten kaldırılmaz (çift düşüm engeli)
//   D11 mali belge e-postası: sonucu belirsiz gönderim ve yarıda kalan gönderim otomatik yinelenmez (mükerrer e-posta yok)
// FGO / BNR / SMTP'ye GERÇEK istek yok: tek sahte FGO, sahte BNR, sahte e-posta taşıyıcısı; offline (ağ çağrısı testi düşürür).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings, getFgoSettings } = await import('../../server/integrations/fgo.js');
const { removeDeletedDocument } = await import('../../server/integrations/fgo-deleted.js');
const { dayDate, earliestPickup, localDay } = await import('../../server/profile/dates.js');
const g = await import('../../server/glass/billing.js');
const f = await import('../../server/finance/service.js');
const u = await import('../../server/finance/uncertain.js');
const { UNCERTAIN_RECORDERS } = await import('../../server/finance/recorders.js');
const d = await import('../../server/documents/delivery.js');
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { dispatchFgoJobs, dispatchProfileAdvanceJobs } = await import('../../server/profile/fgo-jobs.js');

const SECRET = 'r'.repeat(40);
const TZ = 'Europe/Bucharest';
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let db, admin, fgo, seq = 0;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const bnrImpl = async () => ({ ok: true, rate: '5.0000', date: localDay(new Date(), TZ), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const key = () => crypto.randomBytes(12).toString('hex');
const today = () => localDay(new Date(), TZ);

/** Sahte FGO: emitere belgeyi kaydeder (TVA %21); mode lost = belge kesildi ama yanıt kayboldu (504) */
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const state = new Map();
  const fake = { calls, state, mode: 'ok', last: null, fetchImpl: null };
  fake.fetchImpl = async (url, init = {}) => {
    const s = String(url);
    if (!s.includes('api-testuat.fgo.ro')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (s.endsWith('/factura/getstatus')) {
      const doc = state.get(`${form.Serie}${form.Numar}`);
      if (!doc) return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: doc.total.toFixed(2), ValoareAchitata: doc.paid.toFixed(2) } }));
    }
    if (s.endsWith('/factura/print')) return new Response(JSON.stringify({ Success: true, Factura: { Link: `https://www.fgo.ro/print/${form.Serie}${form.Numar}.pdf` } }));
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null
        ? Number(form[`Continut[${i}][PretTotal]`])
        : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, { total: Math.round(total * 100) / 100, paid: 0 });
    fake.last = String(n);
    if (fake.mode === 'lost') return new Response('Gateway Timeout', { status: 504 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://www.fgo.ro/facturi/${form.Serie}${n}.pdf` } }));
  };
  return fake;
}
async function inMode(mode, fn) {
  fgo.mode = mode;
  try { return await fn(); } finally { fgo.mode = 'ok'; }
}
const ctx = (extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, bnrImpl, ...extra });
const customer = (name, prefix, data = {}) => db.customer.create({
  data: { name, prefix, email: `${prefix.toLowerCase()}@r393.test`, taxId: '998877', regCom: 'J40/1/2020', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR', ...data },
});
/** 2 m² × 50 EUR → 500 RON + TVA = 605 RON */
async function order(c) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: String(seq), title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 10 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}
const request = (o, kind, extra = {}) => g.requestGlassDocument(db, { orderId: o.id, kind, actor: actor(), ...extra });
const dispatch = (o, extra = {}) => g.dispatchGlassJobs(db, ctx({ onlyOrderId: o.id, ...extra }));
const pay = (o, amount) => f.recordManualPayment(db, { orderId: o.id, input: { paidOn: today(), amount, currency: 'EUR', method: 'BANK_TRANSFER', reference: `OP ${amount}` }, requestKey: key(), actor: actor() });
async function proforma(o) {
  assert.deepEqual(await request(o, 'PROFORMA'), { ok: true });
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  return db.fgoDocument.findFirstOrThrow({ where: { orderId: o.id, kind: 'PROFORMA' } });
}
const settings = (extra = {}) => saveFgoSettings(db, {
  enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, invoiceNext: null, ...extra,
}, { key: 'K', secret: SECRET }, actor());

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@r393-fgo.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await settings();
  fgo = fakeFgo(700);
});
after(closeDb);

// ================================================================= O2

dbTest('O2: profil teslim faturası — avans toplamı fatura tutarını aşarsa eksi / geçersiz fatura FGO\'ya gitmez; gerekçeli uyarı', offline(async () => {
  const c = await customer('Fazla Avans SRL', 'FAV');
  const cust = await db.user.create({ data: { email: 'cust@fav.test', name: 'M', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: c.id, canApprove: true } });
  const custActor = { id: cust.id, role: 'MUSTERI', canApprove: true, customerId: c.id, ip: '127.0.0.1' };
  const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 4 }], products);
  const next = await suggestNextNo(db, c.id, 'PROFILE_ORDER');
  const { id } = await createProfileOrder(db, { actor: custActor, firm: c, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  const load = () => db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
  let o = await load();
  await runProfileAction(db, { orderId: id, action: 'send_profile_offer', actor: actor(), payload: { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '12.5' })) } });
  o = await load();
  await runProfileAction(db, { orderId: id, action: 'approve_profile_offer', actor: custActor, payload: { offerId: o.offers[0].id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 1 FAV' } });
  assert.deepEqual(await dispatchFgoJobs(db, ctx()), { done: 1, failed: 0 });
  // Proforma 302,50 RON; yanlış / fazla elle ödeme 80 EUR = 400 RON → avans faturası 400 RON (karar 207: fazla tahsilat incelemeye düşer)
  assert.equal((await pay({ id }, '80')).ok, true);
  assert.equal((await f.requestProfileAdvance(db, { orderId: id, actor: actor() })).ok, true);
  assert.deepEqual(await dispatchProfileAdvanceJobs(db, ctx()), { done: 1, failed: 0 });
  await runProfileAction(db, { orderId: id, action: 'mark_paid', actor: actor(), payload: { paidDate: dayDate(today()) } });
  await runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: actor() });
  const calls = fgo.calls.length;
  const r = await dispatchFgoJobs(db, ctx());
  assert.equal(r.done, 0);
  assert.equal(fgo.calls.length, calls, 'eksi tutarlı fatura FGO\'ya gönderilmedi');
  assert.equal(await db.fgoDocument.count({ where: { orderId: id, kind: 'INVOICE' } }), 0);
  const job = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: id, type: 'FGO_INVOICE' } });
  assert.equal(job.status, 'FAILED', 'kalıcı engel: yönetici mutabakatı gerekir');
  assert.match(job.lastError, /avans/i);
  assert.ok(await db.adminAlert.findFirst({ where: { orderId: id, type: 'FGO_FAILED', resolvedAt: null } }));
}));

// ================================================================= O4

dbTest('O4: FGO belgeyi kesti ama TAKİP kaydı yazılamadı → iş otomatik yeniden GÖNDERİLMEZ (ikinci emitere yok); kesilen numarayla yönetici incelemesine düşer', offline(async () => {
  const c = await customer('Kayit Hatasi SRL', 'KHT');
  const o = await order(c);
  const holder = await order(c);
  // FGO'nun vereceği numara TAKİP'te başka belgede kayıtlı (kayıt aşaması benzersizlik hatası verir — gerçek DB hatası)
  const nextNo = String(Number(fgo.last ?? 700) + 1);
  await db.fgoDocument.create({ data: { orderId: holder.id, kind: 'PROFORMA', series: 'PRF', number: nextNo, issuedAt: new Date() } });
  assert.deepEqual(await request(o, 'PROFORMA'), { ok: true });
  const before = fgo.calls.length;
  assert.deepEqual(await dispatch(o), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, before + 1);
  const [job] = await db.notificationOutbox.findMany({ where: { orderId: o.id, type: 'FGO_GLASS' } });
  assert.equal(u.isParked(job), true, 'iş belirsiz olarak bekletildi');
  assert.deepEqual(job.payload.uncertain.issued, { series: 'PRF', number: nextNo }, 'FGO\'nun verdiği numara saklandı');
  assert.ok(await db.adminAlert.findFirst({ where: { orderId: o.id, type: 'FGO_UNCERTAIN', resolvedAt: null } }));
  // İşçi tekrar tekrar çalışsa da (saatler sonra) FGO'ya ikinci belge kesme isteği gitmez
  for (const h of [1, 6, 30]) await dispatch(o, { now: new Date(Date.now() + h * 3_600_000) });
  assert.equal(fgo.calls.length, before + 1, 'mükerrer belge riski yok');
}));

// ================================================================= D7 / D8

dbTest('D8: cam avans faturası TVA dahil tutarla (PretTotal) gider — avans toplamı tahsilata kuruşu kuruşuna eşit', offline(async () => {
  const c = await customer('Kurus SRL', 'KRS');
  const o = await order(c);
  await proforma(o);
  assert.equal((await pay(o, '20')).ok, true); // 100 RON
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  const form = fgo.calls.at(-1);
  assert.equal(form['Continut[0][PretTotal]'], '100.00');
  assert.equal(form['Continut[0][PretUnitar]'], undefined);
  const adv = await db.fgoDocument.findFirstOrThrow({ where: { orderId: o.id, kind: 'ADVANCE' } });
  assert.equal(fgo.state.get(`${adv.series}${adv.number}`).total, 100);
}));

dbTest('D7: belirsiz avans faturası FGO\'dan doğrulanıp kaydedilince elle girilen tek seferlik fatura numarası temizlenir', offline(async () => {
  const c = await customer('Numara SRL', 'NMR');
  const o = await order(c);
  await proforma(o);
  assert.equal((await pay(o, '10')).ok, true);
  await settings({ invoiceNext: 9777 });
  assert.equal((await getFgoSettings(db)).invoiceNext, 9777);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  assert.deepEqual(await inMode('lost', () => dispatch(o)), { done: 0, failed: 1 });
  const job = await db.notificationOutbox.findFirstOrThrow({ where: { orderId: o.id, type: 'FGO_GLASS', payload: { path: ['kind'], equals: 'ADVANCE' } } });
  assert.equal(u.isParked(job), true);
  assert.equal(fgo.calls.at(-1).Numar, '9777', 'elle numara gönderildi');
  const r = await u.resolveUncertainJob(db, { jobId: job.id, action: 'RECORD', series: 'GKH', number: fgo.last, actor: actor(), secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, recorders: UNCERTAIN_RECORDERS });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await getFgoSettings(db)).invoiceNext ?? null, null, 'tek seferlik numara bir daha gönderilmez');
  await settings();
}));

// ================================================================= D10

dbTest('D10: bir faturada düşülmüş avans faturası "FGO\'da silindi" diye kaldırılmaz (avans iki kez düşülmez); düşülmemişse eskisi gibi kaldırılır', offline(async () => {
  const c = await customer('Dusum SRL', 'DSM');
  const o = await order(c);
  await proforma(o);
  assert.equal((await pay(o, '20')).ok, true);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  const adv = await db.fgoDocument.findFirstOrThrow({ where: { orderId: o.id, kind: 'ADVANCE' } });
  const now = new Date();
  // Onaylı yüklemeden kesilmiş, bu avansı düşen nihai fatura (karar 239 zinciri)
  await db.billingBatch.create({
    data: {
      customerId: c.id, kind: 'INVOICE', status: 'ISSUED', currency: 'EUR', selectionKey: 'r393', sourceTotal: '100', ronNet: '417.36', issuedAt: now, chainOrderId: o.id,
      fxRate: '5', fxDate: now, fxSource: 'BNR', fxPolicy: 'BNR', fxCurrency: 'EUR', fxBaseRate: '5', fxSourceDate: now, fxResolvedAt: now, fxManual: false, createdById: admin.id,
      lines: { create: [
        { sortOrder: 0, orderId: o.id, name: 'Sticla', unit: 'mp', quantity: '2', ronNet: '500', ronGross: '605' },
        { sortOrder: 1, orderId: o.id, name: `Stornare avans conform factură ${adv.series}${adv.number}`, unit: 'buc', quantity: '-1', ronUnit: '82.64', ronNet: '-82.64', ronGross: '100', refDocId: adv.id },
      ] },
    },
  });
  await removeDeletedDocument(db, adv, 'Factura nu exista');
  assert.ok(await db.fgoDocument.findUnique({ where: { id: adv.id } }), 'düşülmüş avansın kaydı durur');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REMOVE_REFUSED', details: { path: ['docId'], equals: adv.id } } }));
  // Düşülmemiş avans (başka sipariş): eski davranış — kayıt kalkar
  const o2 = await order(c);
  await proforma(o2);
  assert.equal((await pay(o2, '30')).ok, true);
  assert.deepEqual(await request(o2, 'ADVANCE'), { ok: true });
  assert.deepEqual(await dispatch(o2), { done: 1, failed: 0 });
  const adv2 = await db.fgoDocument.findFirstOrThrow({ where: { orderId: o2.id, kind: 'ADVANCE' } });
  await removeDeletedDocument(db, adv2, 'Factura nu exista');
  assert.equal(await db.fgoDocument.findUnique({ where: { id: adv2.id } }), null);
}));

// ================================================================= D11

dbTest('D11: mali belge e-postası — sonucu belirsiz SMTP hatası ve yarıda kalan gönderim otomatik yinelenmez (mükerrer e-posta yok; "Tekrar gönder" yöneticide)', offline(async () => {
  const c = await customer('Eposta SRL', 'EPS', { email: 'muhasebe@eps.test' });
  // Önceki testlerin kuyruktaki belge e-postaları bu testin sayımına karışmasın
  await db.notificationOutbox.updateMany({ where: { type: d.DOC_EMAIL, status: 'PENDING' }, data: { status: 'SKIPPED', lastError: 'test' } });
  const mine = () => sent.filter((x) => x === 'muhasebe@eps.test').length;
  const mk = async () => {
    const o = await order(c);
    const doc = await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: String(9000 + (seq += 1)), issuedAt: new Date(), total: '605', paid: '0', link: 'https://www.fgo.ro/facturi/x.pdf' } });
    const job = await db.notificationOutbox.create({ data: { type: d.DOC_EMAIL, orderId: o.id, payload: { docId: doc.id } } });
    return { o, doc, job };
  };
  const sent = [];
  // a) SMTP iletiyi kabul etti ama yanıt beklenirken bağlantı koptu (kod yok): sonucu belirsiz
  const ambiguous = { sendMail: async (m) => { sent.push(m.to); throw Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'DATA' }); } };
  const a = await mk();
  const mctx = (transport, now = new Date()) => ({ transport, from: 'info@gkh.test', appUrl: 'https://takip.test', secret: SECRET, timeZone: TZ, fetchImpl: fgo.fetchImpl, now });
  await d.dispatchDocEmails(db, mctx(ambiguous));
  const ok = { sendMail: async (m) => { sent.push(m.to); return {}; } };
  for (const h of [1, 5, 24]) await d.dispatchDocEmails(db, mctx(ok, new Date(Date.now() + h * 3_600_000)));
  assert.equal(mine(), 1, 'belirsiz gönderim otomatik yinelenmedi');
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: a.job.id } })).status, 'FAILED');
  // b) Önceki işçi gönderim sırasında çöktü (gönderim işareti var, SENT yazılmadı): yeniden gönderilmez
  const b = await mk();
  await db.notificationOutbox.update({ where: { id: b.job.id }, data: { payload: { docId: b.doc.id, sendingAt: new Date(Date.now() - 600_000).toISOString() } } });
  const n = mine();
  await d.dispatchDocEmails(db, mctx(ok));
  assert.equal(mine(), n, 'yarıda kalan gönderim yinelenmedi');
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: b.job.id } })).status, 'FAILED');
  // c) Bağlantı hiç kurulamadı (ileti gitmedi): eskisi gibi yeniden denenir ve bir kez gider
  const cjob = await mk();
  const refused = { sendMail: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION', command: 'CONN' }); } };
  await d.dispatchDocEmails(db, mctx(refused));
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: cjob.job.id } })).status, 'PENDING');
  await d.dispatchDocEmails(db, mctx(ok, new Date(Date.now() + 3_600_000)));
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: cjob.job.id } })).status, 'SENT');
}));
