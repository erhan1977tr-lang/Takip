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
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'yüklenmeden fatura yok');

  // Yükleme gününden 2 gün geçti → fatura: cam satırı + avans düşümü (eksi satır), proforma kuru
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(Date.now() - 3 * 86_400_000) } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: true });
  await g.dispatchGlassJobs(db, ctx(fgo));
  const inv = fgo.calls[2];
  assert.equal(inv.IdExtern, 'GLA68-F');
  assert.equal(inv['Continut[0][Denumire]'], 'Securizat');
  assert.ok(!('Numar' in inv), 'fatura numarası gönderilmez (sistemde GKH553 olsa da 554 üretilmez): FGO numaralandırır');
  assert.ok(!('Numar' in pf), 'proformayı FGO numaralandırır');
  // Faturada CNC cama TVA hariç eklenir; satırın TVA dahil toplamı proformadaki satırların toplamı: 500 + 105 + 100 + 21
  assert.equal(inv['Continut[0][PretTotal]'], '726.00', 'faturada CNC cama eklenir: cam 605 + CNC 121 (TVA dahil)');
  assert.ok(!('Continut[0][PretUnitar]' in inv));
  assert.equal(inv['Continut[1][NrProduse]'], '-1');
  assert.match(inv['Continut[1][Denumire]'], /^Stornare avans conform factură GKH553/);
  assert.equal(inv['Continut[1][PretUnitar]'], '1000.00', 'avans faturasının TVA hariç tutarı (FGO toplamı 1210)');
  docs = await db.fgoDocument.findMany({ where: { orderId: o.id }, orderBy: { issuedAt: 'asc' } });
  assert.deepEqual(docs.map((d) => d.kind), ['PROFORMA', 'ADVANCE', 'INVOICE']);
  assert.equal(docs[2].number, '554', 'kaydedilen numara FGO\'nun döndürdüğü numara');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  await assert.rejects(db.fgoDocument.create({ data: { orderId: o.id, kind: 'INVOICE', series: 'GKH', number: '999', issuedAt: new Date() } }), /Unique constraint/, 'veritabanı da engeller');

  // Muhasebe → Cam Tahsilat aynı kayıtları gösterir
  assert.equal((await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.orderId === o.id).length, 3);

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
  const issue = async (no, fgo) => {
    const o = await glassOrder(no, new Date(Date.now() - 5 * 86_400_000));
    assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: true });
    const r = await g.dispatchGlassJobs(db, { ...ctx(fgo), onlyOrderId: o.id });
    return { o, r, doc: await db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'INVOICE' } }) };
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
  const b = await issue(72, fake({ gone: ['553'] }));
  assert.deepEqual(b.r, { done: 1, failed: 0 });
  assert.equal(calls[1].Numar, '553', 'tam girilen numara');
  assert.equal(b.doc.number, '553', 'silinmiş eski kayıt kaldırıldı, numara yeni faturada');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'FGO_DOC_REMOVED', entityId: stale.orderId } }));
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
  const job = await db.notificationOutbox.findFirst({ where: { orderId: d.o.id, type: 'FGO_GLASS' } });
  assert.equal(job.status, 'FAILED');
  assert.equal(job.lastError, 'Numarul facturii exista deja');
  const failed = await db.adminAlert.findFirst({ where: { orderId: d.o.id, type: 'FGO_FAILED' } });
  assert.equal(failed?.details?.error, 'Numarul facturii exista deja');
  assert.equal(await setting(), 600, 'reddedilen numara alanda kalır; yönetici düzeltir ya da boşaltır');

  // 5) Elle numara hem sistemde hem FGO'da var: FGO'ya belge isteği gitmez, sonraki numaraya geçilmez
  await fgoOn(0, { invoiceNext: 812 });
  const e = await issue(75, fake());
  assert.deepEqual(e.r, { done: 0, failed: 1 });
  assert.equal(calls.length, 4, 'belge isteği gönderilmedi');
  const job5 = await db.notificationOutbox.findFirst({ where: { orderId: e.o.id, type: 'FGO_GLASS' } });
  assert.equal(job5.status, 'FAILED');
  assert.match(job5.lastError, /GKH812.*başka numara denenmedi/);

  // 6) FGO gönderilen numarayı dinlemezse: kaydedilen numara FGO'nun kestiği, yöneticiye uyarı, alan boşalır
  await fgoOn(0, { invoiceNext: 800 });
  const f = await issue(76, fake({ ignoreNumar: true }));
  assert.deepEqual(f.r, { done: 1, failed: 0 });
  assert.equal(calls[4].Numar, '800');
  assert.equal(f.doc.number, '814');
  const alert = await db.adminAlert.findFirst({ where: { orderId: f.o.id, type: 'FGO_NUMBER' } });
  assert.equal(alert?.details?.error, '800 → 814');
  assert.equal(await setting(), null);
});

// Karar 94 → 104: proforma ödenmiş, avans faturası yok, yüklenmiş. Düşüm uydurulmaz; kapanış faturası kesilmez — ama çıkmaz
// da değildir: FGO'daki tahsilat için avans faturası yüklemeden sonra da kesilir (ayrıntılı senaryolar: order-advance.test.js).
dbTest('ödenmiş proforma + avans faturası yok + yüklenmiş: kapanış faturası kesilmez, avans istenir; ödenmemiş proformada akış aynen', async () => {
  await fgoOn(0);
  const past = new Date(Date.now() - 5 * 86_400_000);
  const proforma = (orderId, number, paid) => db.fgoDocument.create({ data: { orderId, kind: 'PROFORMA', series: 'PRF', number, issuedAt: new Date(), total: '1210.00', paid } });
  const queued = (orderId) => db.notificationOutbox.count({ where: { orderId, type: 'FGO_GLASS' } });

  // A) FGO'da tahsilat görünen proforma: fatura isteği reddedilir, kuyruğa hiçbir şey girmez; avans istenebilir
  const a = await glassOrder(81, past);
  await proforma(a.id, '9001', '1210.00');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: a.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(await queued(a.id), 0);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: a.id, kind: 'ADVANCE', actor: actor() }), { ok: true }, 'yüklemeden sonra da avans');
  assert.equal(await queued(a.id), 1);

  // B) Eski sürümden kalma elle ödeme kaydı ödeme sayılmaz: FGO'da tahsilat yoksa proforma ödenmemiştir (fatura kesilir)
  const b = await glassOrder(82, past);
  await proforma(b.id, '9002', '0');
  await db.glassBilling.create({ data: { orderId: b.id, paidAt: new Date(), paidAmount: '500.00', paidById: admin.id } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: b.id, kind: 'ADVANCE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: b.id, kind: 'INVOICE', actor: actor() }), { ok: true });

  // C) İstek kuyruğa girdikten sonra proforma ödenmiş görünürse (FGO eşitlemesi): kesim anında durur, FGO'ya gidilmez
  const c = await glassOrder(83, past);
  const pc = await proforma(c.id, '9003', '0');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: c.id, kind: 'INVOICE', actor: actor() }), { ok: true }, 'ödenmemiş proforma: istek kabul edilir');
  await db.fgoDocument.update({ where: { id: pc.id }, data: { paid: '300.00' } });
  const blocked = fakeFgo(900);
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(blocked, { onlyOrderId: c.id })), { done: 0, failed: 1 });
  assert.equal(blocked.calls.length, 0, 'belge kesilmedi');
  const job = await db.notificationOutbox.findFirst({ where: { orderId: c.id, type: 'FGO_GLASS' } });
  assert.equal(job.status, 'FAILED');
  assert.match(job.lastError, /PRF9003: FGO'da avansı kesilmemiş 300\.00 RON tahsilat var/);
  assert.equal(await db.adminAlert.count({ where: { orderId: c.id, type: 'FGO_FAILED' } }), 1, 'yöneticiye açıkça bildirilir');
  assert.equal(await db.fgoDocument.count({ where: { orderId: c.id, kind: 'INVOICE' } }), 0);

  // D) Ödenmemiş proforma, avans yok: mevcut akış değişmedi — fatura kesilir, düşüm satırı yok
  const d = await glassOrder(84, past);
  await proforma(d.id, '9004', '0');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: d.id, kind: 'INVOICE', actor: actor() }), { ok: true });
  const fgo = fakeFgo(950);
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: d.id })), { done: 1, failed: 0 });
  assert.equal(fgo.calls[0]['Continut[0][Denumire]'], 'Securizat');
  assert.ok(!('Continut[1][Denumire]' in fgo.calls[0]), 'avans yoksa düşüm satırı yok');
  assert.equal(await db.fgoDocument.count({ where: { orderId: d.id, kind: 'INVOICE' } }), 1);
  // (Avans faturası olan siparişte kapanış faturası + "Stornare avans" ilk testte doğrulanıyor: değişmedi.)
});
