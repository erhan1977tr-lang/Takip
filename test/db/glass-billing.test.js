// Cam siparişi FGO belge akışı — veritabanıyla: proforma → ödeme → avans → yükleme → fatura (avans düşümü),
// tekrar kesim engeli, günlük sınır, müşteriye e-posta, Muhasebe ile aynı kayıt.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const { listDocuments } = await import('../../server/accounting/receivables.js');
const g = await import('../../server/glass/billing.js');

const SECRET = 'g'.repeat(40);
let db, admin, firm;
const actor = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });
const fgoOn = (dailyLimit = 0) => saveFgoSettings(db, {
  enabled: true, fxMode: 'manual', dailyLimit, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: 'https://bt.example',
}, { key: 'K', secret: SECRET }, actor());
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '1210.00', ValoareAchitata: '0' } }));
    calls.push(form);
    // Numar gönderildiyse FGO o numarayla keser
    n = form.Numar ? Number(form.Numar) : n + 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: 'Europe/Bucharest', fetchImpl: fgo.fetchImpl, ...extra });

async function glassOrder(no, shipDate) {
  return db.order.create({
    data: {
      orderNo: `GLA${no}`, customerOrderNo: no, title: 'Ușă duș', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          { sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' },
        ] } } },
    },
  });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'contabil@glass.test', taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1' } });
  admin = await db.user.create({ data: { email: 'admin@cam.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveDailyRate(db, { day: localDay(new Date(), 'Europe/Bucharest'), rate: 5 }, actor(), writeAudit);
});
after(closeDb);

dbTest('cam FGO: proforma → ödeme → avans → yüklenince fatura (avans düşülür); tekrar kesim engellenir; müşteriye e-posta', async () => {
  await fgoOn();
  const future = new Date(Date.now() + 10 * 86_400_000);
  const o = await glassOrder(68, future);
  const fgo = fakeFgo(551);
  // Proforma
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'sıra proformada');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'kuyrukta: ikinci istek yok');
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  const pf = fgo.calls[0];
  assert.equal(pf.Serie, 'PRF');
  assert.equal(pf.IdExtern, 'GLA68-P');
  assert.equal(pf['Continut[0][UM]'], 'mp');
  assert.equal(pf['Continut[0][NrProduse]'], '2');
  assert.equal(pf['Continut[0][PretUnitar]'], '250.00', '50 EUR × 5');
  assert.equal(pf['Continut[0][Denumire]'], 'Securizat', 'yalnızca cam niteliği, Romence');
  assert.equal(pf.Text, 'Ușă duș', 'açıklamada yalnızca sipariş açıklaması');
  assert.equal(pf['Continut[1][Denumire]'], 'Prelucrare CNC', 'proformada CNC ayrı satır');
  assert.equal(pf['Continut[1][PretUnitar]'], '50.00');
  let docs = await db.fgoDocument.findMany({ where: { orderId: o.id } });
  assert.deepEqual(docs.map((d) => `${d.kind}:${d.series}${d.number}`), ['PROFORMA:PRF552']);
  assert.equal(docs[0].total.toString(), '1210');
  const bill = await db.glassBilling.findUnique({ where: { orderId: o.id } });
  assert.equal(Number(bill.fxRate), 5);
  assert.equal(bill.fxSource, 'MANUAL_DAY');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'proforma bir kez');
  const ord = await db.order.findUnique({ where: { id: o.id } });
  assert.equal(ord.status, 'URETIMDE', 'sipariş durumu değişmez (müşteri onayı yok)');

  // Ödeme (elle) → avans faturası: tek satır, tahsil edilen tutar
  assert.deepEqual(await g.markGlassPaid(db, { orderId: o.id, amount: 605, actor: actor() }), { ok: true });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor() }), { ok: true });
  await g.dispatchGlassJobs(db, ctx(fgo));
  const av = fgo.calls[1];
  assert.equal(av.Serie, 'GKH');
  assert.equal(av.IdExtern, 'GLA68-A');
  assert.ok(!('Numar' in av), 'sistemde henüz fatura yok, ayarda başlangıç yok → FGO numaralandırır');
  assert.equal(av['Continut[0][Denumire]'], 'Avans marfă conform proformă PRF552');
  assert.equal(av['Continut[0][PretUnitar]'], '500.00', '605 / 1,21');
  assert.equal(av['Continut[0][NrProduse]'], '1');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'yüklenmeden fatura yok');

  // Yükleme gününden 2 gün geçti → fatura: cam satırı + avans düşümü (eksi satır), proforma kuru
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(Date.now() - 3 * 86_400_000) } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: true });
  await g.dispatchGlassJobs(db, ctx(fgo));
  const inv = fgo.calls[2];
  assert.equal(inv.IdExtern, 'GLA68-F');
  assert.equal(inv['Continut[0][Denumire]'], 'Securizat');
  assert.equal(inv.Numar, '554', 'sistemdeki son fatura (avans GKH553) + 1');
  assert.ok(!('Numar' in pf), 'proformayı FGO numaralandırır');
  // Faturada CNC cama TVA hariç eklenir; satırın TVA dahil toplamı proformadaki satırların toplamı: 500 + 105 + 100 + 21
  assert.equal(inv['Continut[0][PretTotal]'], '726.00', 'faturada CNC cama eklenir: cam 605 + CNC 121 (TVA dahil)');
  assert.ok(!('Continut[0][PretUnitar]' in inv));
  assert.equal(inv['Continut[1][NrProduse]'], '-1');
  assert.match(inv['Continut[1][Denumire]'], /^Stornare avans conform factură GKH553/);
  assert.equal(inv['Continut[1][PretUnitar]'], '1000.00', 'avans faturasının TVA hariç tutarı (FGO toplamı 1210)');
  docs = await db.fgoDocument.findMany({ where: { orderId: o.id }, orderBy: { issuedAt: 'asc' } });
  assert.deepEqual(docs.map((d) => d.kind), ['PROFORMA', 'ADVANCE', 'INVOICE']);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  await assert.rejects(db.fgoDocument.create({ data: { orderId: o.id, kind: 'INVOICE', series: 'GKH', number: '999', issuedAt: new Date() } }), /Unique constraint/, 'veritabanı da engeller');

  // Muhasebe → Cam Tahsilat aynı kayıtları gösterir
  assert.equal((await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.orderId === o.id).length, 3);

  // Müşteriye e-posta: firmanın kayıtlı e-postası, Romence, belge no + bağlantı
  const sent = [];
  const r = await g.dispatchDocEmails(db, { transport: { sendMail: async (m) => { sent.push(m); return {}; } }, from: 'info@gkh.ro' });
  assert.equal(r.sent, 3);
  assert.ok(sent.every((m) => m.to === 'contabil@glass.test'));
  assert.match(sent[0].subject, /^Factură proformă PRF552 — comanda GLA68$/);
  assert.match(sent[0].text, /https:\/\/fgo\.example\/PRF552\.pdf/);
});

dbTest('cam FGO: yüklenmiş ve avanssız sipariş doğrudan fatura; günlük sınır; firma bilgisi eksikse kesilmez', async () => {
  const o = await glassOrder(70, new Date(Date.now() - 5 * 86_400_000));
  await fgoOn(1);
  const st = g.billingState({ status: 'URETIMDE', loaded: true, docs: [], billing: null, pending: [], hasOffer: true });
  assert.deepEqual(st.actions, ['invoice']);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'FGO_DAILY_LIMIT' }, 'bugün zaten belge kesildi');
  await fgoOn(0);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'yüklenmiş siparişte proforma yok');
  await db.customer.update({ where: { id: firm.id }, data: { county: null } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: true });
  const fgo = fakeFgo(700);
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo)), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, 0);
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id, type: 'FGO_FAILED' } }), 1);
});
