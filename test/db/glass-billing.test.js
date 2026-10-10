// Cam siparişi FGO belge akışı — veritabanıyla: proforma → ödeme → avans → ONAYLI yükleme → nihai fatura (yükleme gününün
// Faturalama kartından, siparişin zincirinde; avans düşümü), tekrar kesim engeli, günlük sınır, müşteriye e-posta, Muhasebe
// ile aynı kayıt. Karar 239: sipariş düzeyinde nihai fatura yok. FGO'ya GERÇEK istek yapılmaz (sahte fetchImpl).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const { listDocuments } = await import('../../server/accounting/receivables.js');
const { snapshotLine } = await import('../../server/loading/confirmation.js');
const { dayKey } = await import('../../server/orders/loading.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');

const SECRET = 'g'.repeat(40);
let db, admin, firm;
const actor = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });
const fgoOn = (dailyLimit = 0, extra = {}) => saveFgoSettings(db, {
  ...extra, enabled: true, fxMode: 'manual', dailyLimit, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: 'https://bt.example',
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
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: 'Europe/Bucharest', fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });
const never = async () => { throw new Error('BNR çağrılmamalıydı (kur proformanın kur kaydı)'); };
let dayNo = 30;
/** Her onay için ayrı, geçmiş bir yükleme günü (gün başına tek onay) */
const pastDay = () => dayKey(new Date(`${new Date(Date.now() - (dayNo += 1) * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`));
/** Onaylı yükleme (karar 92): siparişin gönderilmiş teklifinin kopyası — confirmLoading ile aynı işlev (snapshotLine) */
async function confirm(day, o) {
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date(`${day}T12:00:00Z`) } });
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  const offer = full.offers.find((x) => x.status === 'GONDERILDI');
  const rows = offer.lines.map((l) => snapshotLine(full, offer, l, { quantity: Number(l.adet) }));
  await db.loadingConfirmationItem.createMany({
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
  return conf;
}
/** Yükleme gününün Faturalama kartındaki, siparişin fatura grubu */
const groupOf = async (day, o) => {
  const r = await inv.loadingBilling(db, { day, bnrImpl: never });
  assert.equal(r.ok, true);
  return r.customers.flatMap((c) => c.groups).find((x) => x.orders.some((y) => y.orderId === o.id)) ?? null;
};
const invoiceFor = (day, grp) => inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: never });

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
  assert.equal(pf.Text, 'Curs de vânzare BT: 5.0000 RON/EUR.', 'Paket C (karar 235): açıklamada sipariş başlığı değil, belgenin kuru');
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

  // Ödeme FGO'da görünür (karar 104: tek kaynak FGO) → avans faturası: tek satır, tahsil edilen tutar
  await db.fgoDocument.updateMany({ where: { orderId: o.id, kind: 'PROFORMA' }, data: { paid: '605.00' } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor() }), { ok: true });
  await g.dispatchGlassJobs(db, ctx(fgo));
  const av = fgo.calls[1];
  assert.equal(av.Serie, 'GKH');
  assert.equal(av.IdExtern, 'GLA68-A');
  assert.ok(!('Numar' in av), 'sistemde henüz fatura yok, ayarda başlangıç yok → FGO numaralandırır');
  assert.equal(av['Continut[0][Denumire]'], 'Avans marfă conform proformă PRF552');
  assert.equal(av['Continut[0][PretUnitar]'], '500.00', '605 / 1,21');
  assert.equal(av['Continut[0][NrProduse]'], '1');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'sipariş düzeyinde nihai fatura yok');

  // Tarih geçse de (eski "+2 gün" kuralı) onaylı yükleme yoksa nihai fatura yok — ne sipariş sayfasından ne yükleme gününden
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(Date.now() - 30 * 86_400_000) } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id, type: 'FGO_GLASS', payload: { path: ['kind'], equals: 'INVOICE' } } }), 0);

  // Onaylı yükleme → yükleme gününün Faturalama kartında siparişin zinciriyle fatura: cam satırı + avans düşümü, proforma kuru
  const day = pastDay();
  await confirm(day, o);
  const grp = await groupOf(day, o);
  assert.ok(grp, 'kendi proforması olan sipariş Faturalama kartında (karar 239)');
  assert.deepEqual([grp.orderChainId, grp.chainId, grp.chain.kind, grp.chain.ref, grp.problems], [o.id, null, 'ORDER', 'PRF552', []]);
  assert.equal(grp.fx.rate, 5, 'proformanın kuru — BNR / günün kuru sorulmaz');
  assert.equal(grp.storno.length, 1);
  assert.deepEqual([grp.storno[0].advanceDocId != null, grp.storno[0].advanceBatchId, grp.storno[0].ref], [true, null, 'GKH553']);
  assert.equal(grp.storno[0].gross, grp.ronGross, 'avans en çok faturanın tutarı kadar düşülür');
  const created = await invoiceFor(day, grp);
  assert.equal(created.ok, true);
  assert.deepEqual(await invoiceFor(day, grp), { ok: false, code: 'NOTHING_TO_INVOICE' }, 'aynı kapsam ikinci kez faturalanmaz');
  const batch = await db.billingBatch.findUnique({ where: { id: created.batchId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  assert.deepEqual([batch.chainOrderId, batch.parentId, Number(batch.fxRate), batch.fxSource], [o.id, null, 5, 'MANUAL_DAY']);
  assert.ok(batch.lines.some((l) => l.refDocId && l.name.startsWith('Stornare avans')), 'düşülen avans faturası satırda saklı');
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: created.batchId })), { done: 1, failed: 0 });
  const invForm = fgo.calls[2];
  assert.equal(invForm.IdExtern, `LOT-${created.batchId}`);
  assert.equal(invForm['Continut[0][Denumire]'], 'Comanda GLA68 — Securizat');
  assert.ok(!('Numar' in invForm), 'fatura numarasını FGO verir');
  assert.equal(invForm['Continut[0][PretTotal]'], '726.00', 'faturada CNC cama eklenir: cam 605 + CNC 121 (TVA dahil), proforma kuru');
  assert.equal(invForm['Continut[1][NrProduse]'], '-1');
  assert.match(invForm['Continut[1][Denumire]'], /^Stornare avans conform factură GKH553/);
  assert.equal(invForm['Continut[1][PretUnitar]'], '600.00', 'avans faturanın tutarını aşmadan düşülür (726 TVA dahil → 600)');
  docs = await db.fgoDocument.findMany({ where: { OR: [{ orderId: o.id }, { batch: { chainOrderId: o.id } }] }, orderBy: { issuedAt: 'asc' } });
  assert.deepEqual(docs.map((d) => d.kind), ['PROFORMA', 'ADVANCE', 'INVOICE']);
  assert.equal(docs[2].number, '554', 'kaydedilen numara FGO\'nun döndürdüğü numara');
  assert.equal((await db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'PROFORMA' } })).paid.toString(), '605', 'fatura proformanın ödeme durumunu değiştirmez');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });

  // Muhasebe → Cam Tahsilat aynı kayıtları gösterir
  assert.equal((await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.orderId === o.id || d.batch?.chainOrderId === o.id).length, 3);

  // Müşteriye e-posta (yalnızca TAKİP gönderir — karar 111): firmanın kayıtlı e-postası, Romence, belge no, PDF ekte.
  // Sahte FGO: kayıtlı bağlantı FGO adresi değil → bağlantı factura/print ile alınır, PDF oradan indirilir (ağa çıkılmaz).
  const sent = [];
  const pdfFetch = async (url) => (String(url).endsWith('/factura/print')
    ? new Response(JSON.stringify({ Success: true, Factura: { Link: 'https://www.fgo.ro/facturi/x.pdf' } }))
    : new Response(Buffer.from('%PDF-1.4 sahte')));
  const r = await g.dispatchDocEmails(db, { transport: { sendMail: async (m) => { sent.push(m); return {}; } }, from: 'info@gkh.ro', appUrl: 'https://t', secret: SECRET, fetchImpl: pdfFetch });
  assert.equal(r.sent, 3);
  assert.ok(sent.every((m) => m.to === 'contabil@glass.test'));
  assert.match(sent[0].subject, /^Proformă PRF552 — comanda GLA68$/);
  assert.deepEqual(sent.map((m) => m.attachments[0].filename), ['PRF552.pdf', 'GKH553.pdf', 'GKH554.pdf']);
  assert.match(sent[0].text, /https:\/\/t\/belgeler/);
  assert.equal(fgo.calls.length, 3, 'e-posta belge kesmez');
});

dbTest('cam FGO: onaylı yüklemesi olan sipariş — sipariş düzeyi proforma / fatura yok; günlük sınır; firma bilgisi eksikse fatura kesilmez; kuyrukta kalmış eski fatura isteği FGO\'ya gitmez', async () => {
  const o = await glassOrder(70, new Date(Date.now() - 5 * 86_400_000));
  await fgoOn(1);
  const st = g.billingState({ status: 'URETIMDE', loaded: true, docs: [], billing: null, pending: [], hasOffer: true });
  assert.deepEqual([st.actions, st.wait], [[], 'final_from_loading']);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'FGO_DAILY_LIMIT' }, 'bugün zaten belge kesildi');
  await fgoOn(0);
  // Tarih geçmiş ama onaylı yükleme yok: proforma hâlâ istenebilir (tarih yükleme kanıtı değildir)
  assert.equal((await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() })).code, 'NOT_ALLOWED');
  const day = pastDay();
  await confirm(day, o);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'onaylı yüklemesi olan siparişte proforma yok');
  // Proformasız, ödemesiz: doğrudan fatura yükleme gününden (müşterinin kur politikası; BT günün kuru 5)
  await db.customer.update({ where: { id: firm.id }, data: { county: null } });
  const r = await inv.loadingBilling(db, { day, bnrImpl: never });
  const grp = r.customers.flatMap((c) => c.groups).find((x) => x.orders.some((y) => y.orderId === o.id));
  assert.deepEqual([grp.orderChainId, grp.chainId], [null, null]);
  assert.ok(grp.problems.includes('BILLING_MISSING'));
  const fgo = fakeFgo(700);
  assert.deepEqual(await invoiceFor(day, grp), { ok: false, code: 'BILLING_MISSING' });
  assert.equal(fgo.calls.length, 0);
  await db.customer.update({ where: { id: firm.id }, data: { county: 'Ilfov' } });
  // Sürüm öncesinden kuyrukta kalmış sipariş düzeyi fatura isteği: FGO'ya gitmeden reddedilir, yöneticiye bildirilir
  await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: o.id, payload: { kind: 'INVOICE', orderNo: o.orderNo } } });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, 0, 'FGO\'ya istek yok');
  const job = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'FGO_GLASS' } });
  assert.equal(job.status, 'FAILED');
  assert.match(job.lastError, /Sipariş düzeyinde kapanış faturası kesilmez/);
  assert.equal(await db.fgoDocument.count({ where: { orderId: o.id } }), 0);
});

// Karar 87: fatura numarasını FGO verir; sistem numara üretmez. "Sonraki fatura numarası" yalnızca tek seferlik elle numaradır.
dbTest('fatura numarası: numarayı FGO verir ve dönen numara kaydedilir; elle numara tek seferlik; FGO reddederse gerçek hata saklanır, başka numara denenmez', async () => {
  await db.customer.update({ where: { id: firm.id }, data: { county: 'Ilfov' } });
  await fgoOn(0);
  const calls = [];
  let fgoNext = 812; // FGO'nun kendi sırası (sistemdeki son fatura GKH554; sistem 555 üretmez)
  // gone: FGO'da silinmiş numaralar · reject: FGO belgeyi bu mesajla reddeder · ignoreNumar: FGO gönderilen numarayı dinlemez
  const fake = ({ gone = [], reject = null, ignoreNumar = false } = {}) => ({
    fetchImpl: async (url, init) => {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      if (String(url).endsWith('/factura/getstatus')) {
        if (gone.includes(form.Numar)) return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
        return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '726.00', ValoareAchitata: '0' } }));
      }
      calls.push(form);
      if (reject) return new Response(JSON.stringify({ Success: false, Message: reject }));
      const n = form.Numar && !ignoreNumar ? form.Numar : String(fgoNext++);
      return new Response(JSON.stringify({ Success: true, Factura: { Numar: n, Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
    },
  });
  // Nihai fatura yalnızca onaylı yüklemeden (karar 239): her fatura ayrı bir yükleme gününden, doğrudan (proformasız) fatura
  const issue = async (no, fgo) => {
    const o = await glassOrder(no, new Date(Date.now() - 5 * 86_400_000));
    const day = pastDay();
    await confirm(day, o);
    const r0 = await inv.loadingBilling(db, { day, bnrImpl: never });
    const grp = r0.customers.flatMap((c) => c.groups).find((x) => x.orders.some((y) => y.orderId === o.id));
    const created = await invoiceFor(day, grp);
    assert.equal(created.ok, true, JSON.stringify(created));
    const r = await b.dispatchBatchJobs(db, { ...ctx(fgo), onlyBatchId: created.batchId });
    return { o, r, batchId: created.batchId, doc: await db.fgoDocument.findFirst({ where: { batchId: created.batchId } }) };
  };
  const setting = async () => (await db.integrationSetting.findUnique({ where: { key: 'fgo' } })).value.invoiceNext ?? null;

  // 1) Olağan kesim: Numar gönderilmez; FGO'nun döndürdüğü numara kaydedilir
  const a = await issue(71, fake());
  assert.deepEqual(a.r, { done: 1, failed: 0 });
  assert.ok(!('Numar' in calls[0]), 'sistemdeki son numara + 1 gönderilmez');
  assert.equal(`${a.doc.series}${a.doc.number}`, 'GKH812');
  assert.equal(await setting(), null);

  // 2) Elle numara 553: sistemde kayıtlı (ilk testteki avans faturası) ama FGO'da silinmiş → eski kayıt kaldırılır,
  //    tam 553 istenir, fatura kesilince alan boşalır (554 olmaz)
  await fgoOn(0, { invoiceNext: 553 });
  const stale = await db.fgoDocument.findUnique({ where: { series_number: { series: 'GKH', number: '553' } } });
  assert.ok(stale, 'ilk testteki avans faturası GKH553 sistemde kayıtlı');
  const b2 = await issue(72, fake({ gone: ['553'] }));
  assert.deepEqual(b2.r, { done: 1, failed: 0 });
  assert.equal(calls[1].Numar, '553', 'tam girilen numara');
  assert.equal(b2.doc.number, '553', 'silinmiş eski kayıt kaldırıldı, numara yeni faturada');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REMOVED' } }));
  assert.equal(await setting(), null, 'elle numara tek seferlik: kendiliğinden +1 yapılmaz');

  // 3) Sonraki fatura yine FGO'dan numara alır
  const c = await issue(73, fake());
  assert.ok(!('Numar' in calls[2]));
  assert.equal(c.doc.number, '813');

  // 4) FGO elle numarayı reddeder: FGO'nun kendi mesajı saklanır ve yöneticiye düşer; ikinci bir numara denenmez
  await fgoOn(0, { invoiceNext: 600 });
  const d = await issue(74, fake({ reject: 'Numarul facturii exista deja' }));
  assert.deepEqual(d.r, { done: 0, failed: 1 });
  assert.equal(calls.length, 4, 'FGO\'ya tek istek');
  assert.equal(calls[3].Numar, '600');
  assert.equal(d.doc, null, 'belge kaydedilmedi');
  const job = await db.notificationOutbox.findFirst({ where: { type: 'FGO_BATCH', payload: { path: ['batchId'], equals: d.batchId } } });
  assert.equal(job.status, 'FAILED');
  assert.equal(job.lastError, 'Numarul facturii exista deja');
  const failed = await db.adminAlert.findFirst({ where: { type: 'FGO_FAILED', details: { path: ['batchId'], equals: d.batchId } } });
  assert.equal(failed?.details?.error, 'Numarul facturii exista deja');
  assert.equal(await setting(), 600, 'reddedilen numara alanda kalır; yönetici düzeltir ya da boşaltır');

  // 5) Elle numara hem sistemde hem FGO'da var: FGO'ya belge isteği gitmez, sonraki numaraya geçilmez
  await fgoOn(0, { invoiceNext: 812 });
  const e = await issue(75, fake());
  assert.deepEqual(e.r, { done: 0, failed: 1 });
  assert.equal(calls.length, 4, 'belge isteği gönderilmedi');
  const job5 = await db.notificationOutbox.findFirst({ where: { type: 'FGO_BATCH', payload: { path: ['batchId'], equals: e.batchId } } });
  assert.equal(job5.status, 'FAILED');
  assert.match(job5.lastError, /GKH812.*başka numara denenmedi/);

  // 6) FGO gönderilen numarayı dinlemezse: kaydedilen numara FGO'nun kestiği, yöneticiye uyarı, alan boşalır
  await fgoOn(0, { invoiceNext: 800 });
  const f = await issue(76, fake({ ignoreNumar: true }));
  assert.deepEqual(f.r, { done: 1, failed: 0 });
  assert.equal(calls[4].Numar, '800');
  assert.equal(f.doc.number, '814');
  const alert = await db.adminAlert.findFirst({ where: { type: 'FGO_NUMBER', details: { path: ['error'], equals: '800 → 814' } } });
  assert.equal(alert?.details?.error, '800 → 814');
  assert.equal(await setting(), null);
});

// Karar 94 → 104 → 239: proforma ödenmiş, avans faturası yok, onaylı yükleme var. Düşüm uydurulmaz; nihai fatura kesilmez —
// ama çıkmaz da değildir: tahsilat için avans faturası yüklemeden sonra da kesilir (ayrıntı: order-advance.test.js).
dbTest('ödenmiş proforma + avans yok + onaylı yükleme: nihai fatura bekler (ADVANCE_REQUIRED), avans istenir; ödenmemiş proforma engel değil', async () => {
  await fgoOn(0);
  const past = new Date(Date.now() - 5 * 86_400_000);
  const proforma = async (orderId, number, paid) => {
    await db.glassBilling.upsert({ where: { orderId }, create: { orderId, fxRate: '5.0000', fxDate: new Date(), fxSource: 'MANUAL_DAY' }, update: {} });
    return db.fgoDocument.create({ data: { orderId, kind: 'PROFORMA', series: 'PRF', number, issuedAt: new Date(), total: '1210.00', paid } });
  };
  const queued = (orderId) => db.notificationOutbox.count({ where: { orderId, type: 'FGO_GLASS' } });

  // A) Tahsilat görünen proforma: nihai fatura grubu ADVANCE_REQUIRED ile bekler, kuyruğa hiçbir şey girmez; avans istenebilir
  const a = await glassOrder(81, past);
  await proforma(a.id, '9001', '1210.00');
  const dayA = pastDay();
  await confirm(dayA, a);
  const ga = await groupOf(dayA, a);
  assert.deepEqual([ga.orderChainId, ga.problems], [a.id, ['ADVANCE_REQUIRED']]);
  assert.deepEqual(await invoiceFor(dayA, ga), { ok: false, code: 'ADVANCE_REQUIRED' });
  assert.equal(await queued(a.id), 0);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: a.id, kind: 'ADVANCE', actor: actor() }), { ok: true }, 'yüklemeden sonra da avans');
  assert.equal(await queued(a.id), 1);
  // Avans isteği kuyruktayken siparişin kapsamı faturaya girmez (ORDER_PENDING); öbür siparişlerin faturası etkilenmez
  const r = await inv.loadingBilling(db, { day: dayA, bnrImpl: never });
  assert.deepEqual(r.customers.flatMap((c) => c.excluded).map((x) => [x.orderNo, x.reason]), [[a.orderNo, 'ORDER_PENDING']]);

  // B) Eski sürümden kalma elle ödeme kaydı ödeme sayılmaz: FGO'da tahsilat yoksa proforma ödenmemiştir → fatura kesilebilir
  const bo = await glassOrder(82, past);
  await proforma(bo.id, '9002', '0');
  await db.glassBilling.update({ where: { orderId: bo.id }, data: { paidAt: new Date(), paidAmount: '500.00', paidById: admin.id } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: bo.id, kind: 'ADVANCE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  const dayB = pastDay();
  await confirm(dayB, bo);
  const gb = await groupOf(dayB, bo);
  assert.deepEqual([gb.orderChainId, gb.problems, gb.storno], [bo.id, [], []], 'ödenmemiş proforma: fatura kesilebilir, düşüm satırı yok');
  const created = await invoiceFor(dayB, gb);
  assert.equal(created.ok, true);
  const fgo = fakeFgo(950);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: created.batchId })), { done: 1, failed: 0 });
  assert.equal(fgo.calls[0]['Continut[0][Denumire]'], `Comanda ${bo.orderNo} — Securizat`);
  assert.ok(!('Continut[1][Denumire]' in fgo.calls[0]), 'avans yoksa düşüm satırı yok');
  assert.equal((await db.fgoDocument.findFirst({ where: { orderId: bo.id, kind: 'PROFORMA' } })).paid.toString(), '0', 'proforma ödenmiş sayılmaz');

  // C) Fatura kesildikten sonra proformada tahsilat görünür (karar 239 — seçenek a): otomatik avans / mahsup yok, muhasebe kararı
  await db.fgoDocument.updateMany({ where: { orderId: bo.id, kind: 'PROFORMA' }, data: { paid: '300.00' } });
  const st = await g.requestGlassDocument(db, { orderId: bo.id, kind: 'ADVANCE', actor: actor() });
  assert.deepEqual(st, { ok: false, code: 'NOT_ALLOWED' }, 'fatura sonrası tahsilat avans sayılmaz');
  assert.equal(g.billingState({ status: 'URETIMDE', loaded: true, docs: await db.fgoDocument.findMany({ where: { orderId: bo.id } }), pending: [], hasOffer: true, invoiced: true }).wait, 'payment_after_invoice');
});
