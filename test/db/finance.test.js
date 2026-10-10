// Paket 10 (kararlar 206–210) — sipariş finansı veritabanıyla: elle ödeme kaydı, avans faturası (cam + profil), aynı ödemenin
// iki kez avanslanmaması, aynı müşteride aynı tutar, sonucu belirsiz FGO belgesi, kur kaydı, mali belge e-postası, yetki.
// FGO'ya / BNR'ye / SMTP'ye GERÇEK istek yapılmaz: bütün FGO çağrıları dosya boyunca TEK sahte FGO'ya gider (belge durumları
// paylaşılır — "FGO ile Güncelle" bütün belgeleri sorar), BNR sahte, e-posta sahte taşıyıcıya.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { closeDb, dbTest, finalInvoiceFor, getDb, nextPastDay, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { refreshDocuments } = await import('../../server/accounting/receivables.js');
const { dayDate, earliestPickup, localDay } = await import('../../server/profile/dates.js');
const g = await import('../../server/glass/billing.js');
const f = await import('../../server/finance/service.js');
const u = await import('../../server/finance/uncertain.js');
const { UNCERTAIN_RECORDERS } = await import('../../server/finance/recorders.js');
const { orderFinanceView } = await import('../../server/finance/view.js');
const d = await import('../../server/documents/delivery.js');
const { customerDocument, customerDocuments } = await import('../../server/documents/customer.js');
const { resolveAlert } = await import('../../server/pricing/alerts.js');
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { dispatchFgoJobs, dispatchProfileAdvanceJobs } = await import('../../server/profile/fgo-jobs.js');

const SECRET = 'p'.repeat(40);
const TZ = 'Europe/Bucharest';
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let db, admin, fgo, seq = 0;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const bnrImpl = async () => ({ ok: true, rate: '5.0000', date: localDay(new Date(), TZ), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const noBnr = async () => { throw new Error('BNR çağrılmamalıydı'); };
const key = () => crypto.randomBytes(12).toString('hex');
const today = () => localDay(new Date(), TZ);
const ROLES = ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', null];

/**
 * Sahte FGO (dosya boyunca tek). emitere: belgeyi kaydeder (toplam gönderilen satırlardan, TVA %21); mode:
 *   ok      — normal yanıt
 *   lost    — FGO belgeyi KESTİ ama yanıt kayboldu (504): belge FGO'da var, TAKİP bilmiyor
 *   reset   — bağlantı istek sırasında koptu (ECONNRESET); FGO belgeyi kesmedi ama TAKİP bunu bilemez
 *   refused — bağlantı hiç kurulamadı (ECONNREFUSED): istek gitmedi, sonuç kesin
 * getstatus: kayıtlı belgenin toplamı / tahsilatı; bilinmeyen belge "Factura nu exista". print: FGO bağlantısı.
 * FGO API adresi dışındaki istek = PDF indirme.
 */
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
    if (fake.mode === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (fake.mode === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
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
/** Sahte FGO'nun modu yalnızca verilen iş boyunca değişir */
async function inMode(mode, fn) {
  fgo.mode = mode;
  try {
    return await fn();
  } finally {
    fgo.mode = 'ok';
  }
}
const ctx = (extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, bnrImpl, ...extra });
/** Müşteri FGO'da proformayı öder → "FGO ile Güncelle" (yönetici) tahsilatı kayda yazar */
async function fgoPays(ref, paid, orderType = 'GLASS_ORDER') {
  fgo.state.get(ref).paid = paid;
  const r = await refreshDocuments(db, { orderType, secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, sleep: async () => {} });
  assert.equal(r.ok, true);
}

const customer = (name, prefix, data = {}) => db.customer.create({
  data: { name, prefix, email: `${prefix.toLowerCase()}@fin.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR', ...data },
});
/** 2 m² × 50 EUR (ya da 250 RON) → kur 5 ile 500 RON + TVA = 605 RON */
async function order(c, { currency = 'EUR' } = {}) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: seq, title: 'Ușă duș', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 10 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency, amount: '60.00', offerAmount: currency === 'EUR' ? '100.00' : '500.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: currency === 'EUR' ? '50' : '250', kind: 'CAM' }] } } },
    },
  });
}
const request = (o, kind, extra = {}) => g.requestGlassDocument(db, { orderId: o.id, kind, actor: actor(), ...extra });
const dispatch = (o, extra = {}) => g.dispatchGlassJobs(db, ctx({ onlyOrderId: o.id, ...extra }));
async function proforma(o, extra = {}) {
  assert.deepEqual(await request(o, 'PROFORMA', extra), { ok: true });
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  return db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'PROFORMA' } });
}
const ref = (doc) => `${doc.series}${doc.number}`;
const input = (amount, currency = 'EUR', extra = {}) => ({ paidOn: today(), amount, currency, method: 'BANK_TRANSFER', reference: `OP ${amount}`, ...extra });
const pay = (o, amount, currency = 'EUR', extra = {}) => f.recordManualPayment(db, { orderId: o.id, input: input(amount, currency), requestKey: key(), actor: actor(), ...extra });
const advances = (o) => db.fgoDocument.findMany({ where: { orderId: o.id, kind: 'ADVANCE' }, orderBy: { seq: 'asc' } });
const advJobs = (o) => db.notificationOutbox.findMany({
  where: { orderId: o.id, OR: [{ type: 'FGO_GLASS', payload: { path: ['kind'], equals: 'ADVANCE' } }, { type: f.PROFILE_ADVANCE }] }, orderBy: { createdAt: 'asc' },
});
const view = (o) => orderFinanceView(db, o.id);
const resolver = (job) => (o) => u.resolveUncertainJob(db, { jobId: job.id, actor: actor(), secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, recorders: UNCERTAIN_RECORDERS, ...o });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db); // profil kataloğu seed'i dahil
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@fin.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, {
    enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, invoiceNext: null,
  }, { key: 'K', secret: SECRET }, actor());
  fgo = fakeFgo(100);
});
after(closeDb);

dbTest('elle avans: kayıt belge kesmez; avans faturası elle kayda dayanır; aynı ödeme sonra FGO\'da görünür → ikinci avans YOK; çift istek / yeniden çalışan işçi tek belge (senaryo 1–3, 10)', offline(async () => {
  const c = await customer('Manual Avans SRL', 'MAV');
  const o = await order(c);
  // Ödemenin dayanağı ve kuru proformadır: proformasız kayıt yok
  assert.deepEqual(await pay(o, '60'), { ok: false, code: 'NO_PROFORMA' });
  const pf = await proforma(o);
  assert.equal(pf.total.toString(), '605');
  const calls0 = fgo.calls.length;

  // 60 EUR × 5 (proformanın kayıtlı kuru) = 300 RON. Aynı form iki kez gönderildi: tek kayıt
  const k = key();
  const p1 = await f.recordManualPayment(db, { orderId: o.id, input: input('60'), requestKey: k, actor: actor() });
  assert.equal(p1.ok, true);
  assert.deepEqual(await f.recordManualPayment(db, { orderId: o.id, input: input('60'), requestKey: k, actor: actor() }), { ok: true, id: p1.id, duplicate: true });
  assert.equal(await db.manualPayment.count({ where: { orderId: o.id } }), 1);
  const row = await db.manualPayment.findUnique({ where: { id: p1.id } });
  assert.deepEqual([row.amount.toString(), row.currency, row.ron.toString(), row.rate.toString(), row.proformaRef, row.batchId, row.createdById], ['60', 'EUR', '300', '5', ref(pf), null, admin.id]);
  assert.equal(fgo.calls.length, calls0, 'elle kayıt FGO\'ya hiçbir şey göndermez');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'FGO_GLASS', status: 'PENDING' } }), 0, 'elle kayıt kuyruğa iş yazmaz');
  let v = await view(o);
  assert.deepEqual([v.state.fgoPaid, v.state.manualRon, v.state.advanceRequired, v.state.advanceBasis, v.state.match, v.state.full], [0, 300, 300, 'MANUAL', 'MANUAL_ONLY', false]);

  // Avans faturası açık istekle; çift tıklama tek iş; tutar ve dayanak istekte dondurulur
  const twice = await Promise.all([request(o, 'ADVANCE'), request(o, 'ADVANCE')]);
  assert.deepEqual(twice.map((x) => x.ok).sort(), [false, true]);
  const [job] = await advJobs(o);
  assert.deepEqual([job.payload.amount, job.payload.basis, job.payload.manualRon, job.payload.fgoPaid], [300, 'MANUAL', 300, 0]);
  // Aynı anda iki işçi: FGO'ya tek istek, tek belge
  const runs = await Promise.all([dispatch(o), dispatch(o)]);
  assert.equal(runs.reduce((s, r) => s + r.done, 0), 1);
  assert.equal(fgo.calls.length, calls0 + 1);
  const [adv] = await advances(o);
  assert.deepEqual([adv.seq, adv.advanced.toString(), adv.basis, adv.total.toString()], [1, '300', 'MANUAL', '300']);
  assert.equal(fgo.calls.at(-1).IdExtern, `${o.orderNo}-A`);
  assert.equal((await db.manualPayment.findUnique({ where: { id: p1.id } })).advanceDocId, adv.id, 'avans karşıladığı elle kayda bağlandı');
  assert.deepEqual(await f.voidManualPayment(db, { paymentId: p1.id, reason: 'yanlış', actor: actor() }), { ok: false, code: 'INVOICED' });

  // Aynı ödeme şimdi FGO'da görünür (eşitleme): avansı kesilecek tutar 0 — ikinci avans YOK
  await fgoPays(ref(pf), 300);
  v = await view(o);
  assert.deepEqual([v.state.fgoPaid, v.state.manualRon, v.state.advanced, v.state.advanceRequired, v.state.match], [300, 300, 300, 0, 'MATCHED']);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(await dispatch(o, { now: new Date(Date.now() + 3_600_000) }), { done: 0, failed: 0 }, 'işçi yeniden çalışır: yeni belge yok');
  assert.equal(fgo.calls.length, calls0 + 1);
  assert.equal((await advJobs(o)).length, 1);
  await f.financeReviewTick(db);
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id, type: 'FINANCE_REVIEW' } }), 0, 'eşleşen kayıtta inceleme açılmaz');

  // Geçmiş + denetim (kim, ne zaman, önce / sonra, FGO dayanağı)
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: o.id, event: 'PAYMENT_RECORDED', userId: admin.id } }));
  const audit = await db.auditLog.findFirst({ where: { action: 'MANUAL_PAYMENT_RECORDED', entityId: p1.id } });
  assert.deepEqual([audit.userId, audit.actorRole, audit.details.before, audit.details.after.amount, audit.details.after.currency, audit.details.after.ron, audit.details.proforma], [admin.id, 'ADMIN', null, '60.00', 'EUR', '300.00', ref(pf)]);
  const issued = await db.auditLog.findFirst({ where: { action: 'FGO_DOC_ISSUED', entityId: o.id, details: { path: ['kind'], equals: 'ADVANCE' } } });
  assert.deepEqual([issued.details.basis, issued.details.payments], ['MANUAL', [p1.id]]);

  // Onaylı yükleme: nihai fatura yükleme gününün faturalama kartından (sipariş zinciri) kesilir; kesilen avans eksi satırla düşer
  assert.equal((await request(o, 'INVOICE')).code, 'NOT_ALLOWED', 'sipariş düzeyinde kapanış faturası yok');
  const fin = await finalInvoiceFor(db, { order: o, adminId: admin.id, actor: actor(), day: nextPastDay(300), bnrImpl, dispatchCtx: ctx() });
  assert.equal(fin.created?.ok, true, JSON.stringify(fin.group?.problems ?? fin.created));
  assert.deepEqual(fin.run, { done: 1, failed: 0 });
  const inv = fgo.calls.at(-1);
  const names = Object.keys(inv).filter((k) => /^Continut\[\d+\]\[Denumire\]$/.test(k)).map((k) => inv[k]);
  assert.equal(inv.IdExtern, `LOT-${fin.created.batchId}`);
  assert.ok(names.some((n) => n.startsWith(`Comanda ${o.orderNo} — `)), names.join(' | '));
  assert.ok(names.includes(`Stornare avans conform factură ${ref(adv)}`), names.join(' | '));
  assert.equal(await db.fgoDocument.count({ where: { batchId: fin.created.batchId, kind: 'INVOICE' } }), 1);
  assert.ok(await db.notificationOutbox.findFirst({ where: { type: d.DOC_EMAIL, payload: { path: ['docId'], equals: fin.doc.id } } }));
  // Belge başına tek müşteri e-postası işi
  for (const doc of await db.fgoDocument.findMany({ where: { orderId: o.id } })) {
    assert.equal(await db.notificationOutbox.count({ where: { type: d.DOC_EMAIL, payload: { path: ['docId'], equals: doc.id } } }), 1, doc.kind);
  }
}));

dbTest('kısmi ve birden çok ödeme: her avans yalnızca farkı keser (seq); FGO ile uyuşmazlık "Önemli kararlar"a bir kez; geçersiz kılma gerekçeyle, silinmez; kayıt veritabanında değişmez (senaryo 6–7)', offline(async () => {
  const c = await customer('Kismi SRL', 'KSM');
  const o = await order(c);
  const pf = await proforma(o);
  const p1 = await pay(o, '40'); // 200 RON
  assert.equal(p1.ok, true);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  assert.equal((await pay(o, '30')).ok, true); // 150 RON
  let v = await view(o);
  assert.deepEqual([v.state.manualRon, v.state.advanced, v.state.advanceRequired, v.state.full], [350, 200, 150, false], 'kısmi ödeme tam sayılmaz');
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  const advs = await advances(o);
  assert.deepEqual(advs.map((a) => [a.seq, a.advanced.toString(), a.basis]), [[1, '200', 'MANUAL'], [2, '150', 'MANUAL']]);
  assert.equal(fgo.calls.at(-1).IdExtern, `${o.orderNo}-A2`);

  // FGO 400 gösterir (elle 350): uyuşmazlık — büyük olan esas, fark avansı kesilecek; inceleme kaydı tek
  await fgoPays(ref(pf), 400);
  v = await view(o);
  assert.deepEqual([v.state.match, v.state.review, v.state.advanceRequired, v.state.advanceBasis], ['MISMATCH', ['MISMATCH'], 50, 'FGO']);
  await f.financeReviewTick(db);
  const again = await f.financeReviewTick(db);
  assert.equal(again.created, 0, 'aynı durum için ikinci kayıt yok');
  const alerts = await db.adminAlert.findMany({ where: { orderId: o.id, type: 'FINANCE_REVIEW' } });
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].details.code, alerts[0].details.fgoPaid, alerts[0].details.manualRon, alerts[0].details.proforma], ['MISMATCH', 400, 350, ref(pf)]);

  // Üçüncü kayıt (10 EUR = 50 RON) → eşleşir; sonra gerekçeyle geçersiz kılınır (silinmez, görünür kalır)
  const p3 = await pay(o, '10');
  assert.equal((await view(o)).state.match, 'MATCHED');
  assert.deepEqual(await f.voidManualPayment(db, { paymentId: p3.id, reason: '   ', actor: actor() }), { ok: false, code: 'REASON' });
  assert.deepEqual(await f.voidManualPayment(db, { paymentId: p3.id, reason: 'Çift kayıt', actor: actor() }), { ok: true });
  assert.deepEqual(await f.voidManualPayment(db, { paymentId: p3.id, reason: 'Yine', actor: actor() }), { ok: false, code: 'ALREADY_VOID' });
  const voided = await db.manualPayment.findUnique({ where: { id: p3.id } });
  assert.deepEqual([voided.voidReason, voided.voidedById, voided.amount.toString()], ['Çift kayıt', admin.id, '10']);
  v = await view(o);
  assert.deepEqual([v.state.manualRon, v.payments.length, v.payments.find((x) => x.id === p3.id).voidedAt != null], [350, 3, true]);
  const va = await db.auditLog.findFirst({ where: { action: 'MANUAL_PAYMENT_VOIDED', entityId: p3.id } });
  assert.deepEqual([va.userId, va.details.reason, va.details.before.amount, va.details.after.voided], [admin.id, 'Çift kayıt', '10', true]);
  // Veritabanı: elle kayıt silinemez, tutarı değiştirilemez, geçersiz kılma ikinci kez değiştirilemez
  await assert.rejects(db.manualPayment.delete({ where: { id: p3.id } }), /immutable/);
  await assert.rejects(db.manualPayment.update({ where: { id: p1.id }, data: { amount: '1.00' } }), /immutable/);
  await assert.rejects(db.manualPayment.update({ where: { id: p3.id }, data: { voidReason: 'başka' } }), /immutable/);
}));

dbTest('aynı müşteri, iki proforma, aynı tutar: avans kendiliğinden kesilmez — yönetici eşleşmeleri görüp açıkça onaylar; aynı anda iki onaylı kayıt tek kayıt (senaryo 4–5)', offline(async () => {
  const c = await customer('Twin SRL', 'TWN');
  const a = await order(c);
  const b = await order(c);
  await proforma(a);
  const pb = await proforma(b);
  const payA = await pay(a, '50'); // 250 RON
  assert.equal(payA.ok, true);
  assert.deepEqual(await request(a, 'ADVANCE'), { ok: true });
  await dispatch(a);
  const [advA] = await advances(a);

  // B'nin proformasında FGO'da AYNI tutar (ayrı ödeme mi, yanlış eşleşme mi — bilinmez): durur
  await fgoPays(ref(pb), 250);
  const r1 = await request(b, 'ADVANCE');
  assert.equal(r1.code, 'DUPLICATE_RISK');
  assert.deepEqual(r1.matches.map((m) => m.key).sort(), [`D:${advA.id}`, `P:${payA.id}`].sort());
  assert.equal((await advJobs(b)).length, 0, 'onaysız kuyruğa iş yazılmaz');
  assert.equal((await request(b, 'ADVANCE', { ack: 'yanlis-anahtar' })).code, 'DUPLICATE_RISK');
  assert.deepEqual(await request(b, 'ADVANCE', { ack: r1.ackKey }), { ok: true });
  assert.equal((await advJobs(b)).length, 1);
  const dup = await db.adminAlert.findMany({ where: { orderId: b.id, type: 'DUPLICATE_RISK' } });
  assert.equal(dup.length, 1);
  assert.deepEqual([dup[0].details.subject, dup[0].details.amountRon, dup[0].createdById], ['ADVANCE', 250, admin.id]);
  const req = await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REQUEST', entityId: b.id, details: { path: ['kind'], equals: 'ADVANCE' } } });
  assert.deepEqual([...req.details.duplicateAck].sort(), r1.matches.map((m) => m.key).sort());

  // Elle kayıt da aynı kural: aynı müşteride aynı tutar → durur; aynı anda iki onaylı istek → yalnızca biri yazılır
  const first = await f.recordManualPayment(db, { orderId: b.id, input: input('50', 'EUR', { method: 'CASH' }), requestKey: key(), actor: actor() });
  assert.equal(first.code, 'DUPLICATE_RISK');
  const both = await Promise.all([1, 2].map(() => f.recordManualPayment(db, { orderId: b.id, input: input('50', 'EUR', { method: 'CASH' }), requestKey: key(), ack: first.ackKey, actor: actor() })));
  assert.deepEqual(both.map((x) => (x.ok ? 'ok' : x.code)).sort(), ['DUPLICATE_RISK', 'ok']);
  assert.equal(await db.manualPayment.count({ where: { orderId: b.id } }), 1);
  assert.equal(await db.adminAlert.count({ where: { orderId: b.id, type: 'DUPLICATE_RISK' } }), 2, 'onaylanan her risk bir kayıt');
}));

dbTest('para birimi: RON zincirinde EUR ödeme kaydedilmez (kur uydurulmaz); EUR zincirinde RON ödeme aynen; zincirin kuru proformanın kayıtlı kuru (senaryo 8)', offline(async () => {
  const c = await customer('Lei SRL', 'LEI');
  const r = await order(c, { currency: 'RON' });
  await proforma(r);
  assert.deepEqual(await pay(r, '100', 'EUR'), { ok: false, code: 'CURRENCY' });
  const p = await pay(r, '100', 'RON');
  const row = await db.manualPayment.findUnique({ where: { id: p.id } });
  assert.deepEqual([row.ron.toString(), row.rate], ['100', null]);
  assert.deepEqual([(await view(r)).chain.currency, (await view(r)).chain.rate], ['RON', null]);
  const e = await order(c);
  await proforma(e);
  const p2 = await pay(e, '123.45', 'RON');
  const row2 = await db.manualPayment.findUnique({ where: { id: p2.id } });
  assert.deepEqual([row2.currency, row2.ron.toString(), row2.rate], ['RON', '123.45', null]);
  const v = await view(e);
  assert.deepEqual([v.chain.currency, v.chain.rate, v.state.manualRon], ['EUR', '5', 123.45]);
}));

dbTest('belirsiz FGO yanıtı: iş körlemesine yeniden denenmez, sipariş tutulur; yönetici FGO\'daki belgeyi seri + numarayla doğrulayıp kaydeder — ikinci belge kesilmez (senaryo 9)', offline(async () => {
  const c = await customer('Belirsiz SRL', 'BEL');
  const o = await order(c);
  await proforma(o);
  const p = await pay(o, '22'); // 110 RON
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  const before = fgo.calls.length;
  assert.deepEqual(await inMode('lost', () => dispatch(o)), { done: 0, failed: 1 });
  const lostNo = fgo.last;
  let [job] = await advJobs(o);
  assert.equal(job.status, 'PENDING');
  assert.ok(u.isParked(job));
  assert.equal(job.availableAt.getUTCFullYear(), 9999);
  assert.deepEqual([job.payload.uncertain.expectedGross, job.payload.uncertain.series, job.payload.uncertain.idExtern], [110, 'GKH', `${o.orderNo}-A`]);
  assert.equal(await db.fgoDocument.count({ where: { orderId: o.id, kind: 'ADVANCE' } }), 0);
  const alerts = await db.adminAlert.findMany({ where: { orderId: o.id, type: 'FGO_UNCERTAIN', resolvedAt: null } });
  assert.equal(alerts.length, 1);
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: o.id, event: 'FGO_UNCERTAIN' } }));
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_UNCERTAIN', entityId: job.id } }));
  assert.equal(await db.notification.count({ where: { userId: admin.id, type: 'FGO_UNCERTAIN' } }), 1);

  // İşçi (yarın da) almaz; FGO'ya yeniden gidilmez. Bekleyen iş siparişi tutar; "Gördüm" ile kapanmaz
  assert.deepEqual(await dispatch(o, { now: new Date(Date.now() + 86_400_000) }), { done: 0, failed: 0 });
  assert.equal(fgo.calls.length, before + 1);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(await f.voidManualPayment(db, { paymentId: p.id, reason: 'x', actor: actor() }), { ok: false, code: 'BUSY' });
  assert.equal(await resolveAlert(db, alerts[0].id, actor()), false);

  const resolve = resolver(job);
  for (const role of ROLES) assert.deepEqual(await resolve({ action: 'RECORD', series: 'GKH', number: lostNo, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, String(role));
  assert.deepEqual(await resolve({ action: 'RETRY' }), { ok: false, code: 'CONFIRM' });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'PRF', number: lostNo }), { ok: false, code: 'SERIES' });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'GKH', number: '99999' }), { ok: false, code: 'NOT_IN_FGO' });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'GKH', number: 'x y' }), { ok: false, code: 'BAD_NUMBER' });
  fgo.state.set('GKH7777', { total: 1, paid: 0 });
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'GKH', number: '7777' }), { ok: false, code: 'TOTAL_MISMATCH', fgoTotal: 1, expected: 110 });

  // Belge FGO'da var ve toplam tutuyor: işçinin başarı yoluyla kaydedilir; FGO'ya belge kesme isteği GİTMEZ
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'gkh', number: lostNo }), { ok: true, doc: `GKH${lostNo}` });
  assert.equal(fgo.calls.length, before + 1);
  const [adv] = await advances(o);
  assert.deepEqual([ref(adv), adv.advanced.toString(), adv.basis, adv.total.toString()], [`GKH${lostNo}`, '110', 'MANUAL', '110']);
  job = await db.notificationOutbox.findUnique({ where: { id: job.id } });
  assert.equal(job.status, 'SENT');
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id, type: 'FGO_UNCERTAIN', resolvedAt: null } }), 0);
  assert.equal(await db.notificationOutbox.count({ where: { type: d.DOC_EMAIL, payload: { path: ['docId'], equals: adv.id } } }), 1, 'belge başına tek e-posta');
  assert.equal((await db.manualPayment.findUnique({ where: { id: p.id } })).advanceDocId, adv.id);
  assert.deepEqual(await resolve({ action: 'RECORD', series: 'GKH', number: lostNo }), { ok: false, code: 'NOT_UNCERTAIN' });
  const done = await db.auditLog.findFirst({ where: { action: 'FGO_UNCERTAIN_RESOLVED', entityId: job.id } });
  assert.deepEqual([done.userId, done.details.after, done.details.series], [admin.id, 'SENT', 'GKH']);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: false, code: 'NOT_ALLOWED' }, 'tahsilat avanslandı');
}));

dbTest('belirsiz FGO yanıtı: FGO\'da belge yoksa yönetici açık onayla aynı IdExtern ile yeniden gönderir ya da vazgeçer; bağlantı hiç kurulamadıysa mevcut yeniden deneme', offline(async () => {
  const c = await customer('Tekrar SRL', 'TKR');
  const o = await order(c);
  await proforma(o);
  await pay(o, '24'); // 120 RON
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  // Bağlantı hiç kurulamadı (ECONNREFUSED): istek gitmedi — belirsiz değil, mevcut bekleme kuralı
  assert.deepEqual(await inMode('refused', () => dispatch(o)), { done: 0, failed: 1 });
  let [job] = await advJobs(o);
  assert.equal(u.isParked(job), false);
  assert.ok(job.availableAt.getUTCFullYear() < 9999);
  // Bağlantı istek sırasında koptu: FGO işledi mi bilinmez → bekletilir
  assert.deepEqual(await inMode('reset', () => dispatch(o, { now: new Date(Date.now() + 3_600_000) })), { done: 0, failed: 1 });
  [job] = await advJobs(o);
  assert.ok(u.isParked(job));
  const extern = fgo.calls.at(-1).IdExtern;
  // Yönetici FGO'da belgenin olmadığını doğruladı → aynı iş aynı IdExtern ile
  assert.deepEqual(await resolver(job)({ action: 'RETRY', confirm: true }), { ok: true });
  job = await db.notificationOutbox.findUnique({ where: { id: job.id } });
  assert.deepEqual([job.status, job.lastError, u.isParked(job)], ['PENDING', null, false]);
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id, type: 'FGO_UNCERTAIN', resolvedAt: null } }), 0);
  assert.deepEqual(await dispatch(o), { done: 1, failed: 0 });
  assert.equal(fgo.calls.at(-1).IdExtern, extern);
  assert.equal((await advances(o)).length, 1);

  // Vazgeç: iş FAILED, uyarı kapanır; avans yeniden istenebilir
  const o2 = await order(c);
  await proforma(o2);
  await pay(o2, '26'); // 130 RON
  assert.deepEqual(await request(o2, 'ADVANCE'), { ok: true });
  assert.deepEqual(await inMode('lost', () => dispatch(o2)), { done: 0, failed: 1 });
  const [j2] = await advJobs(o2);
  assert.deepEqual(await resolver(j2)({ action: 'ABANDON' }), { ok: false, code: 'CONFIRM' });
  assert.deepEqual(await resolver(j2)({ action: 'ABANDON', confirm: true }), { ok: true });
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: j2.id } })).status, 'FAILED');
  assert.equal(await db.adminAlert.count({ where: { orderId: o2.id, type: 'FGO_UNCERTAIN', resolvedAt: null } }), 0);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_UNCERTAIN_RESOLVED', entityId: j2.id, details: { path: ['after'], equals: 'FAILED' } } }));
  assert.equal((await request(o2, 'ADVANCE')).ok, true);
}));

dbTest('profil siparişi: elle ödeme → isteğe bağlı avans faturası (camla aynı kural); teslim faturası avansları eksi satırla düşer, avansı kesilmemiş tahsilat yüzünden BEKLEMEZ; kuyruktaki avansı bekler', offline(async () => {
  const c = await customer('Profil Finans SRL', 'PFN', { regCom: 'J40/1/2020' });
  const cust = await db.user.create({ data: { email: 'cust@pfn.test', name: 'Müşteri', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: c.id, canApprove: true } });
  const custActor = { id: cust.id, role: 'MUSTERI', canApprove: true, customerId: c.id, ip: '127.0.0.1' };
  const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 4 }], products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, c.id, 'PROFILE_ORDER');
  const { id, orderNo } = await createProfileOrder(db, { actor: custActor, firm: c, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  const load = () => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
  let o = await load();
  await runProfileAction(db, { orderId: id, action: 'send_profile_offer', actor: actor(), payload: { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '12.5' })) } });
  o = await load();
  await runProfileAction(db, { orderId: id, action: 'approve_profile_offer', actor: custActor, payload: { offerId: o.offers[0].id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 1 PFN' } });
  assert.deepEqual(await dispatchFgoJobs(db, ctx()), { done: 1, failed: 0 });
  const pf = await db.fgoDocument.findFirst({ where: { orderId: id, kind: 'PROFORMA' } });
  assert.equal(pf.total.toString(), '302.5', '4 × 12,50 EUR × 5 = 250 RON + TVA');

  // Yönetici 20 EUR'yu elle kaydeder → 100 RON; avans isteğe bağlı ve yalnızca yönetici
  const p1 = await pay({ id }, '20');
  assert.equal(p1.ok, true);
  let v = await orderFinanceView(db, id);
  assert.deepEqual([v.chain.kind, v.state.advanceRequired, v.canProfileAdvance], ['ORDER', 100, true]);
  for (const role of ROLES) assert.deepEqual(await f.requestProfileAdvance(db, { orderId: id, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' }, String(role));
  const twice = await Promise.all([f.requestProfileAdvance(db, { orderId: id, actor: actor() }), f.requestProfileAdvance(db, { orderId: id, actor: actor() })]);
  assert.deepEqual(twice.map((x) => (x.ok ? 'ok' : x.code)).sort(), ['PENDING', 'ok']);
  assert.deepEqual(await dispatchProfileAdvanceJobs(db, ctx()), { done: 1, failed: 0 });
  assert.deepEqual(await dispatchProfileAdvanceJobs(db, ctx()), { done: 0, failed: 0 }, 'yeniden çalışan işçi yeni belge kesmez');
  const [adv] = await advances({ id });
  assert.deepEqual([adv.seq, adv.advanced.toString(), adv.basis], [1, '100', 'MANUAL']);
  const af = fgo.calls.at(-1);
  assert.deepEqual([af.Serie, af.IdExtern, af['Continut[0][Denumire]'], af['Continut[0][PretUnitar]']], ['GKH', `${orderNo}-A`, `Avans marfă conform proformă ${ref(pf)}`, '82.64']);
  assert.equal((await db.manualPayment.findUnique({ where: { id: p1.id } })).advanceDocId, adv.id);
  assert.equal(await db.notificationOutbox.count({ where: { type: d.DOC_EMAIL, payload: { path: ['docId'], equals: adv.id } } }), 1);

  // İkinci ödeme (10 EUR = 50 RON) avanslanır ama iş henüz kesilmeden teslim: fatura kuyruktaki avansı BEKLER
  assert.equal((await pay({ id }, '10')).ok, true);
  assert.equal((await f.requestProfileAdvance(db, { orderId: id, actor: actor() })).ok, true);
  await runProfileAction(db, { orderId: id, action: 'mark_paid', actor: actor(), payload: { paidDate: dayDate(today()) } });
  await runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: actor() });
  const t0 = new Date();
  assert.deepEqual(await dispatchFgoJobs(db, ctx({ now: t0 })), { done: 0, failed: 1 });
  assert.equal(await db.fgoDocument.count({ where: { orderId: id, kind: 'INVOICE' } }), 0);
  assert.deepEqual(await dispatchProfileAdvanceJobs(db, ctx()), { done: 1, failed: 0 });
  const advs = await advances({ id });
  assert.deepEqual(advs.map((a) => [a.seq, a.advanced.toString()]), [[1, '100'], [2, '50']]);
  // Üçüncü ödeme (6 EUR = 30 RON) avanslanmadı: fatura bunun için BEKLEMEZ (karar 207 — profil)
  assert.equal((await pay({ id }, '6')).ok, true);
  assert.deepEqual(await dispatchFgoJobs(db, ctx({ now: new Date(t0.getTime() + 2 * 3_600_000) })), { done: 1, failed: 0 });
  const inv = fgo.calls.at(-1);
  assert.equal(inv.IdExtern, `${orderNo}-F`);
  assert.deepEqual(
    [1, 2].map((i) => [inv[`Continut[${i}][Denumire]`], inv[`Continut[${i}][NrProduse]`], inv[`Continut[${i}][PretUnitar]`]]),
    [[`Stornare avans conform factură ${ref(advs[0])}`, '-1', '82.64'], [`Stornare avans conform factură ${ref(advs[1])}`, '-1', '41.32']],
  );
  o = await load();
  assert.equal(o.profile.stage, 'FATURALANDI');
  assert.deepEqual(await f.requestProfileAdvance(db, { orderId: id, actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'fatura kesildi: yeni avans yok');
  v = await orderFinanceView(db, id);
  assert.equal(v.canProfileAdvance, false);
}));

dbTest('kur: BT kuru yoksa belge bekler (FGO\'ya gidilmez, başka kaynağa geçilmez); yönetici elle kur girer; belgede saklanan kur sonradan değişmez, elle ödeme o kurla çevrilir (senaryo 13)', offline(async () => {
  const c = await customer('Bt SRL', 'BTK', { fxPolicy: 'BT_UNIT_SELL' });
  const o = await order(c);
  const before = fgo.calls.length;
  assert.deepEqual(await request(o, 'PROFORMA'), { ok: true });
  assert.deepEqual(await dispatch(o, { bnrImpl: noBnr }), { done: 0, failed: 1 });
  const [job] = await db.notificationOutbox.findMany({ where: { orderId: o.id, type: 'FGO_GLASS' } });
  assert.deepEqual([job.status, u.isParked(job)], ['PENDING', false], 'kur yok: iş bekler (belirsiz değil, FAILED değil)');
  assert.ok(job.lastError);
  assert.equal(fgo.calls.length, before, 'kur yokken FGO\'ya istek gitmez');
  assert.deepEqual(await pay(o, '10'), { ok: false, code: 'NO_PROFORMA' });

  // Yönetici bu belge için elle kur girer (başka sipariş: aynı politika)
  const o2 = await order(c);
  const pf = await proforma(o2, { manualRate: '5,1000' });
  const gb = await db.glassBilling.findUnique({ where: { orderId: o2.id } });
  assert.deepEqual([gb.fxRate.toString(), gb.fxSource, gb.fxManual], ['5.1', 'MANUAL', true]);
  assert.equal(pf.total.toString(), '617.1', '2 × 255 RON + TVA');
  // Politika sonradan değişse de zincirin kuru aynı; elle ödeme kayıtlı kurla çevrilir
  await db.customer.update({ where: { id: c.id }, data: { fxPolicy: 'BNR' } });
  const p = await pay(o2, '10');
  const row = await db.manualPayment.findUnique({ where: { id: p.id } });
  assert.deepEqual([row.rate.toString(), row.ron.toString()], ['5.1', '51']);
  assert.equal((await db.glassBilling.findUnique({ where: { orderId: o2.id } })).fxRate.toString(), '5.1');
}));

dbTest('mali belge e-postası: tek mekanizma (TAKİP); alıcı billingEmail → müşteri e-postası → "Email yok"; kullanıcı bildirim tercihinden bağımsız; PDF ekli, Romence (senaryo 11–12)', offline(async () => {
  const billing = await customer('Mail SRL', 'MLS', { billingEmail: 'facturi@mls.test' });
  const plain = await customer('Plain SRL', 'PLN');
  const none = await customer('Nomail SRL', 'NOM', { email: null });
  await db.user.create({ data: { email: 'user@mls.test', name: 'Kullanıcı', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: billing.id, emailNotifications: false } });
  const docs = [];
  for (const c of [billing, plain, none]) docs.push(await proforma(await order(c)));
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  for (let i = 0; i < 30; i++) {
    const r = await d.dispatchDocEmails(db, { transport, from: 'info@gkh.ro', appUrl: 'https://takip.test', secret: SECRET, timeZone: TZ, fetchImpl: fgo.fetchImpl });
    if (r.sent + r.failed + r.skipped === 0) break;
  }
  const jobOf = async (doc) => db.notificationOutbox.findMany({ where: { type: d.DOC_EMAIL, payload: { path: ['docId'], equals: doc.id } } });
  const mailOf = (doc) => sent.filter((m) => String(m.subject).includes(ref(doc)));
  const [j1] = await jobOf(docs[0]);
  assert.equal(j1.status, 'SENT');
  assert.deepEqual(mailOf(docs[0]).map((m) => m.to), ['facturi@mls.test'], 'önce E-mail facturare; kullanıcının giriş adresi ve bildirim tercihi kullanılmaz');
  assert.match(mailOf(docs[0])[0].subject, /^Proformă /);
  assert.ok(mailOf(docs[0])[0].attachments.some((a) => /\.pdf$/i.test(a.filename ?? '')), 'PDF ekli');
  assert.deepEqual(mailOf(docs[1]).map((m) => m.to), ['pln@fin.test'], 'yoksa firmanın e-postası');
  const [j3] = await jobOf(docs[2]);
  assert.deepEqual([j3.status, j3.lastError, mailOf(docs[2]).length], ['SKIPPED', d.NO_EMAIL, 0], 'adres yok: "Email yok", belge geçerli');
  for (const doc of docs) assert.equal((await jobOf(doc)).length, 1, 'belge başına tek iş');
}));

dbTest('yetki ve gizlilik: yönetici dışındaki roller ödeme kaydedemez / geçersiz kılamaz / avans isteyemez / belirsiz işi çözemez; müşteri başka firmanın belgesini göremez (senaryo 14–15)', offline(async () => {
  const owner = await customer('Sahip SRL', 'SHP');
  const stranger = await customer('Yabanci SRL', 'YAB');
  const o = await order(owner);
  const pf = await proforma(o);
  const p = await pay(o, '33'); // 165 RON
  assert.equal(p.ok, true);
  for (const role of ROLES) {
    const a = actor(role);
    assert.deepEqual(await f.recordManualPayment(db, { orderId: o.id, input: input('1'), requestKey: key(), actor: a }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await f.voidManualPayment(db, { paymentId: p.id, reason: 'x', actor: a }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: a }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await f.requestProfileAdvance(db, { orderId: o.id, actor: a }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await u.resolveUncertainJob(db, { jobId: 'x', action: 'ABANDON', confirm: true, actor: a, recorders: UNCERTAIN_RECORDERS }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  assert.equal(await db.manualPayment.count({ where: { orderId: o.id } }), 1);
  assert.equal((await db.manualPayment.findUnique({ where: { id: p.id } })).voidedAt, null);
  assert.equal((await advJobs(o)).length, 0);
  // Müşterinin "Documente financiare" görünümü: yalnızca kendi firmasının belgeleri
  assert.ok((await customerDocuments(db, owner.id)).some((x) => x.id === pf.id));
  assert.deepEqual((await customerDocuments(db, stranger.id)).map((x) => x.id), []);
  assert.equal(await customerDocument(db, { docId: pf.id, customerId: stranger.id }), null);
  assert.equal((await customerDocument(db, { docId: pf.id, customerId: owner.id })).id, pf.id);
}));
