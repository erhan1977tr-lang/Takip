// DÜZELTME 10 Aşama 2C (karar 295) — müşteri fazla ödemesi ve TAKİP içi mahsup, veritabanıyla. FGO'ya / BNR'ye / SMTP'ye GERÇEK
// istek yapılmaz: proformalar tek sahte FGO ile kesilir; mahsup işlemlerinin FGO'ya hiçbir istek göndermediği, kuyruğa iş
// yazmadığı ve mevcut ödeme / avans / belge kayıtlarını değiştirmediği ayrıca sınanır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { refreshDocuments } = await import('../../server/accounting/receivables.js');
const { earliestPickup, localDay } = await import('../../server/profile/dates.js');
const g = await import('../../server/glass/billing.js');
const f = await import('../../server/finance/service.js');
const cs = await import('../../server/finance/credit-service.js');
const { orderFinanceView } = await import('../../server/finance/view.js');
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { dispatchFgoJobs } = await import('../../server/profile/fgo-jobs.js');

const SECRET = 'c'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, fgo, seq = 0;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const bnrImpl = async () => ({ ok: true, rate: '5.0000', date: localDay(new Date(), TZ), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const key = () => crypto.randomBytes(12).toString('hex');
const today = () => localDay(new Date(), TZ);

/** Sahte FGO: emitere belgeyi kaydeder (TVA %21), getstatus kayıtlı toplam / tahsilatı döner. Başka istek = test hatası. */
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const state = new Map();
  const fetchImpl = async (url, init = {}) => {
    const s = String(url);
    if (!s.includes('api-testuat.fgo.ro')) return new Response(Buffer.from('%PDF-1.4\n%%EOF\n'), { headers: { 'content-type': 'application/pdf' } });
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (s.endsWith('/factura/getstatus')) {
      const doc = state.get(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify(doc ? { Success: true, Factura: { Valoare: doc.total.toFixed(2), ValoareAchitata: doc.paid.toFixed(2) } } : { Success: false, Message: 'Factura nu exista' }));
    }
    if (s.endsWith('/factura/print')) return new Response(JSON.stringify({ Success: true, Factura: { Link: `https://www.fgo.ro/print/${form.Serie}${form.Numar}.pdf` } }));
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, { total: Math.round(total * 100) / 100, paid: 0 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://www.fgo.ro/facturi/${form.Serie}${n}.pdf` } }));
  };
  return { calls, state, fetchImpl };
}
const ctx = () => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, bnrImpl });
const ref = (d) => `${d.series}${d.number}`;
async function fgoPays(r, paid, orderType = 'GLASS_ORDER') {
  fgo.state.get(r).paid = paid;
  assert.equal((await refreshDocuments(db, { orderType, secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, sleep: async () => {} })).ok, true);
}
const customer = (name, prefix) => db.customer.create({
  data: { name, prefix, email: `${prefix.toLowerCase()}@cr.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR' },
});
/** Cam: 2 m² × 50 EUR, kur 5 → proforma 605 RON */
async function glass(c) {
  seq += 1;
  const o = await db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: String(seq), title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 10 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, { ...ctx(), onlyOrderId: o.id }), { done: 1, failed: 0 });
  return { order: o, pf: await db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'PROFORMA' } }) };
}
/** Profil: GK15 × 4 × 12,5 EUR, kur 5 → proforma 302,50 RON */
async function profile(c) {
  const cust = await db.user.create({ data: { email: `u${seq++}@${c.prefix.toLowerCase()}.cr.test`, name: 'Müşteri', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: c.id, canApprove: true } });
  const ca = { id: cust.id, role: 'MUSTERI', canApprove: true, customerId: c.id, ip: '127.0.0.1' };
  const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 4 }], products);
  const next = await suggestNextNo(db, c.id, 'PROFILE_ORDER');
  const { id } = await createProfileOrder(db, { actor: ca, firm: c, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  const load = () => db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
  let o = await load();
  await runProfileAction(db, { orderId: id, action: 'send_profile_offer', actor: actor(), payload: { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '12.5' })) } });
  o = await load();
  await runProfileAction(db, { orderId: id, action: 'approve_profile_offer', actor: ca, payload: { offerId: o.offers[0].id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 1 CRT' } });
  assert.deepEqual(await dispatchFgoJobs(db, ctx()), { done: 1, failed: 0 });
  return { order: o, pf: await db.fgoDocument.findFirst({ where: { orderId: id, kind: 'PROFORMA' } }) };
}
const offset = (c, sourceChain, targetOrderId, amount, extra = {}) => cs.createOffset(db, { customerId: c.id, sourceChain, targetOrderId, amount, note: 'muhasebe kararı', confirm: 'on', requestKey: key(), ...extra }, extra.actor ?? actor());
/** Mevcut finans kayıtlarının parmak izi: mahsup bunları değiştirmemeli */
const fingerprint = async (customerId) => JSON.stringify(await Promise.all([
  db.fgoDocument.findMany({ where: { OR: [{ order: { customerId } }, { batch: { customerId } }] }, orderBy: { id: 'asc' }, select: { id: true, kind: true, total: true, paid: true, advanced: true } }),
  db.manualPayment.findMany({ where: { customerId }, orderBy: { id: 'asc' } }),
  db.notificationOutbox.count(),
  db.billingBatch.count(),
]));

let C, A, B, D, other;
before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@cr.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, {
    enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, invoiceNext: null,
  }, { key: 'K', secret: SECRET }, actor());
  fgo = fakeFgo(500);
  C = await customer('Mahsup Cam Profil SRL', 'MHS');
  A = await glass(C); // fazla ödeme kaynağı: FGO 800 RON / proforma 605 → fazla 195
  B = await profile(C); // hedef: profil proforması 302,50, ödeme yok
  D = await glass(C); // ikinci cam: elle 100 EUR = 500 RON / 605 → açık 105
  other = await customer('Başka Firma SRL', 'BSK');
  await fgoPays(ref(A.pf), 800);
  assert.equal((await f.recordManualPayment(db, { orderId: D.order.id, input: { paidOn: today(), amount: '100', currency: 'EUR', method: 'BANK_TRANSFER', reference: 'OP D' }, requestKey: key(), actor: actor() })).ok, true);
});
after(closeDb);

dbTest('müşteri bazında defter: cam + profil zincirleri, fazla ödeme yalnızca proforma toplamını aşan kısım; FGO çağrılmaz', offline(async () => {
  const calls = fgo.calls.length;
  const v = await cs.customerCredit(db, C.id, actor());
  assert.equal(v.ok, true);
  const row = (o) => v.rows.find((r) => r.key === `order:${o.order.id}`);
  assert.deepEqual([row(A).total, row(A).basis, row(A).overpaid, row(A).remaining, row(A).canSource], [605, 800, 195, 195, true]);
  assert.deepEqual([row(B).total, row(B).basis, row(B).open, row(B).canTarget, row(B).canSource], [302.5, 0, 302.5, true, false]);
  assert.deepEqual([row(D).basis, row(D).open, row(D).overpaid], [500, 105, 0]);
  assert.deepEqual(v.totals, { paid: 1300, overpaid: 195, offset: 0, available: 195, cancelledPaid: 0 });
  // A'nın avansı proforma toplamını aşmaz (karar 295): fazla 195 avanslanmaz
  assert.deepEqual([(await orderFinanceView(db, A.order.id)).state.advanceRequired, (await orderFinanceView(db, A.order.id)).state.overpaid], [605, 195]);
  const list = await cs.creditCustomers(db, actor());
  assert.deepEqual(list.rows.map((r) => [r.customer.prefix, r.totals.available]), [['MHS', 195]]);
  assert.equal(fgo.calls.length, calls, 'okuma FGO\'ya gitmez');
}));

dbTest('mahsup: açık onay, sınırlar, başka müşteri, çift gönderim tek kayıt; FGO / kuyruk / mevcut kayıtlar değişmez; avans dayanağına girmez', offline(async () => {
  const calls = fgo.calls.length;
  const before = await fingerprint(C.id);
  const src = `order:${A.order.id}`;
  assert.equal((await offset(C, src, B.order.id, '10', { confirm: null })).code, 'CONFIRM_REQUIRED');
  assert.equal((await offset(C, src, B.order.id, '195.01')).code, 'OVER_SOURCE');
  assert.equal((await offset(C, src, D.order.id, '105.01')).code, 'OVER_TARGET');
  assert.equal((await offset(C, src, A.order.id, '1')).code, 'SAME_CHAIN');
  assert.equal((await offset(C, `order:${D.order.id}`, B.order.id, '1')).code, 'OVER_SOURCE', 'fazla ödemesi olmayan zincir kaynak olamaz');
  const foreign = await glass(other);
  assert.equal((await offset(C, src, foreign.order.id, '1')).code, 'TARGET_GONE');
  assert.equal((await offset(other, src, foreign.order.id, '1')).code, 'SOURCE_GONE', 'başka müşterinin fazla ödemesi kullanılamaz');
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', null]) {
    assert.deepEqual(await offset(C, src, B.order.id, '1', { actor: { id: admin.id, role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await cs.customerCredit(db, C.id, { id: admin.id, role }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  assert.equal(await db.creditOffset.count(), 0);
  // Geçerli: 120 RON A → B; aynı form iki kez → tek kayıt
  const k = key();
  const first = await offset(C, src, B.order.id, '120', { requestKey: k });
  assert.deepEqual(first, { ok: true, id: first.id, duplicate: false });
  assert.deepEqual(await offset(C, src, B.order.id, '120', { requestKey: k }), { ok: true, id: first.id, duplicate: true });
  assert.equal(await db.creditOffset.count(), 1);
  const row = await db.creditOffset.findUniqueOrThrow({ where: { id: first.id } });
  assert.deepEqual([row.amountRon.toString(), row.sourceRef, row.targetRef, row.status, row.createdById], ['120', ref(A.pf), ref(B.pf), 'ACTIVE', admin.id]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CREDIT_OFFSET_CREATED', entityId: first.id } });
  assert.deepEqual([audit.details.amountRon, audit.details.fgo, audit.details.source.remainingBefore, audit.details.target.openBefore], ['120.00', false, 195, 302.5]);
  // FGO'ya istek yok, kuyruğa iş yok, belge / ödeme / avans kayıtları aynı
  assert.equal(fgo.calls.length, calls);
  assert.equal(await fingerprint(C.id), before);
  // Defter: A kalan 75, B açık 182,50, bakiye 75; B'nin avans dayanağı DEĞİŞMEDİ (mahsup FGO tahsilatı değildir)
  const v = await cs.customerCredit(db, C.id, actor());
  const r = (o) => v.rows.find((x) => x.key === `order:${o.order.id}`);
  assert.deepEqual([r(A).remaining, r(B).offsetIn, r(B).open, r(B).basis], [75, 120, 182.5, 0]);
  assert.deepEqual([v.totals.available, v.totals.offset, v.totals.overpaid], [75, 120, 195]);
  const bv = await orderFinanceView(db, B.order.id);
  assert.deepEqual([bv.state.basis, bv.state.advanceRequired], [0, 0]);
  assert.deepEqual(await f.requestProfileAdvance(db, { orderId: B.order.id, actor: actor() }), { ok: false, code: 'NOTHING_TO_ADVANCE' }, 'mahsup avans faturası doğurmaz');
  // Sipariş kartının verisi: kaynakta çıkan, hedefte gelen
  const oa = await cs.orderOffsets(db, A.order.id, actor());
  const ob = await cs.orderOffsets(db, B.order.id, actor());
  assert.deepEqual([oa.out.length, oa.in.length, ob.out.length, ob.in.length], [1, 0, 0, 1]);
  assert.deepEqual(await cs.orderOffsets(db, B.order.id, actor('SATIS')), { ok: false, code: 'FORBIDDEN' });
}));

dbTest('eşzamanlı mahsup: kalan fazlayı aynı anda isteyen iki form — biri yazılır, diğeri OVER_SOURCE (müşteri kilidi)', offline(async () => {
  const src = `order:${A.order.id}`;
  const remaining = (await cs.customerCredit(db, C.id, actor())).rows.find((x) => x.key === src).remaining;
  assert.equal(remaining, 75);
  const both = await Promise.all([offset(C, src, B.order.id, '75'), offset(C, src, D.order.id, '75')]);
  assert.deepEqual(both.map((x) => (x.ok ? 'OK' : x.code)).sort(), ['OK', 'OVER_SOURCE']);
  const v = await cs.customerCredit(db, C.id, actor());
  assert.deepEqual([v.rows.find((x) => x.key === src).remaining, v.totals.available, v.review], [0, 0, []]);
}));

dbTest('geri alma ve "FGO\'ya işlendi": yalnızca etkin kayıt, bir kez, gerekçe + onay; FGO\'ya işlenen TAKİP\'te geri alınamaz; denetimli', offline(async () => {
  const rows = await db.creditOffset.findMany({ where: { customerId: C.id, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 2);
  const [x, y] = rows;
  const close = (id, mode, extra = {}) => cs.closeOffset(db, { offsetId: id, mode, reason: 'yanlış hedef', confirm: 'on', ...extra }, extra.actor ?? actor());
  assert.equal((await close(x.id, 'REVERSED', { confirm: null })).code, 'CONFIRM_REQUIRED');
  assert.equal((await close(x.id, 'REVERSED', { reason: ' ' })).code, 'REASON');
  assert.equal((await close(x.id, 'DELETE')).code, 'MODE');
  assert.deepEqual(await close(x.id, 'REVERSED', { actor: { id: admin.id, role: 'SATIS' } }), { ok: false, code: 'FORBIDDEN' });
  const twice = await Promise.all([close(x.id, 'REVERSED'), close(x.id, 'REVERSED')]);
  assert.deepEqual(twice.map((r) => (r.ok ? 'OK' : r.code)).sort(), ['ALREADY_CLOSED', 'OK']);
  assert.deepEqual(await close(y.id, 'FGO_RECORDED', { reason: 'FGO incasare 18.10' }), { ok: true });
  assert.equal((await close(y.id, 'REVERSED')).code, 'ALREADY_FGO');
  const v = await cs.customerCredit(db, C.id, actor());
  // x (120) geri alındı → kaynağa döndü; y (75) FGO'ya işlendi → artık mahsup sayılmaz (FGO rakamları güncellenince yansır)
  assert.deepEqual([v.totals.offset, v.totals.available], [0, 195]);
  assert.deepEqual(v.offsets.map((o) => o.status).sort(), ['FGO_RECORDED', 'REVERSED']);
  assert.equal(await db.creditOffset.count({ where: { customerId: C.id } }), 2, 'kayıt silinmez');
  const audits = await db.auditLog.findMany({ where: { entityId: { in: [x.id, y.id] }, action: { in: ['CREDIT_OFFSET_REVERSED', 'CREDIT_OFFSET_FGO_RECORDED'] } } });
  assert.deepEqual(audits.map((a) => a.action).sort(), ['CREDIT_OFFSET_FGO_RECORDED', 'CREDIT_OFFSET_REVERSED']);
  assert.ok(audits.every((a) => a.details.fgo === false && a.details.reason));
}));

dbTest('iptal edilmiş sipariş: kaynağı bakiyeye girmez, hedef olamaz', offline(async () => {
  const E = await glass(C);
  await fgoPays(ref(E.pf), 700);
  await db.order.update({ where: { id: E.order.id }, data: { status: 'IPTAL' } });
  const v = await cs.customerCredit(db, C.id, actor());
  const e = v.rows.find((r) => r.key === `order:${E.order.id}`);
  assert.deepEqual([e.cancelled, e.canSource, e.canTarget], [true, false, false]);
  assert.equal(v.totals.cancelledPaid, 700);
  assert.equal(v.totals.available, 195, 'iptal zincirinin tahsilatı bakiyeye eklenmez');
  assert.ok(v.review.some((r) => r.code === 'CANCELLED_PAID'));
  assert.equal((await offset(C, `order:${A.order.id}`, E.order.id, '1')).code, 'TARGET_CANCELLED');
  assert.equal((await offset(C, `order:${E.order.id}`, D.order.id, '1')).code, 'SOURCE_CANCELLED');
}));
