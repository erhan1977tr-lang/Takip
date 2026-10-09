// Sipariş başına cam belge zincirinde avans (Aşama 7F-1, karar 104) — veritabanıyla.
//   proforma → FGO'da tahsilat → avans faturası (tahsilat − avansı kesilen) → kapanış faturası (her avans için düşüm).
//   Ödemenin tek kaynağı FGO'dur; yönetici tutar giremez. Avans yüklemeden önce de sonra da kesilir; sonradan gelen her
//   tahsilat için yeni bir avans faturası (seq). Avansı kesilmemiş tahsilat varken kapanış faturası kesilmez.
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları (emitere, getstatus) sahte fetchImpl'e gider.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const { listDocuments, receivables, refreshDocuments } = await import('../../server/accounting/receivables.js');
const g = await import('../../server/glass/billing.js');

const SECRET = 'a'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, firm, seq = 300;
const actor = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });

/**
 * Sahte FGO: emitere çağrıları sayılır, belge toplamı gönderilen satırlardan hesaplanır; getstatus toplamı ve testin
 * yazdığı tahsilatı (state.paid) döner. failNext: sıradaki emitere isteği ağ hatasıyla düşer (yeniden deneme testi).
 */
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const state = new Map();
  const fgo = { calls, state, failNext: 0, fetchImpl: null };
  fgo.fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const s = state.get(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: (s?.total ?? 0).toFixed(2), ValoareAchitata: (s?.paid ?? 0).toFixed(2) } }));
    }
    if (fgo.failNext > 0) {
      fgo.failNext -= 1;
      // Bağlantı hiç kurulamadı (ECONNREFUSED): istek FGO'ya gitmedi — sonuç kesin, mevcut yeniden deneme kuralı (karar 209)
      throw Object.assign(new TypeError('fetch failed: bağlantı koptu'), { cause: { code: 'ECONNREFUSED' } });
    }
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, { total: Math.round(total * 100) / 100, paid: 0 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return fgo;
}
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, ...extra });
const lines = (form) => Object.keys(form).filter((k) => /^Continut\[\d+\]\[Denumire\]$/.test(k)).map((k) => {
  const i = k.match(/\[(\d+)\]/)[1];
  return [form[k], form[`Continut[${i}][NrProduse]`], form[`Continut[${i}][PretUnitar]`] ?? null];
});
/** Müşteri FGO'da proformayı öder → durum eşitlemesi (elle "FGO ile Güncelle" ile aynı yol) tahsilatı kayda yazar */
async function fgoPays(fgo, ref, paid) {
  fgo.state.get(ref).paid = paid;
  const r = await refreshDocuments(db, { orderType: 'GLASS_ORDER', secret: SECRET, appUrl: 'https://t', fetchImpl: fgo.fetchImpl, sleep: async () => {} });
  assert.equal(r.ok, true);
}
const docsOf = (orderId) => db.fgoDocument.findMany({ where: { orderId }, orderBy: [{ issuedAt: 'asc' }, { seq: 'asc' }] });
const stateOf = async (o, loaded) => g.billingState({ status: 'URETIMDE', loaded, docs: await docsOf(o.id), pending: [], hasOffer: true });
const request = (o, kind) => g.requestGlassDocument(db, { orderId: o.id, kind, actor: actor() });
const jobs = (o, kind) => db.notificationOutbox.findMany({ where: { orderId: o.id, type: 'FGO_GLASS', payload: { path: ['kind'], equals: kind } }, orderBy: { createdAt: 'asc' } });

/** 2 m² × 50 EUR + 2 CNC × 10 EUR = 120 EUR; günün kuru 5 → 600 RON, TVA %21 ile 726 RON */
async function glassOrder(shipOffsetDays) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `ADV${no}`, customerOrderNo: no, title: 'Ușă duș', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + shipOffsetDays * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '70.00', offerAmount: '120.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          { sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' },
        ] } } },
    },
  });
}
/** Yükleme günü + 2 gün geçti: sipariş "yüklenmiş" (proforma yüklemeden önce kesilir; yüklenmiş siparişte proforma yoktur) */
const markLoaded = (o) => db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(Date.now() - 5 * 86_400_000) } });
/** Proforma kesilir (sahte FGO); numarası döner */
async function proforma(o, fgo) {
  assert.deepEqual(await request(o, 'PROFORMA'), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  const [p] = await docsOf(o.id);
  assert.deepEqual([p.kind, p.seq, p.total.toString(), p.advanced], ['PROFORMA', 1, '726', null]);
  return `${p.series}${p.number}`;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Advance SRL', prefix: 'ADV', email: 'contabil@adv.test', taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1' } });
  admin = await db.user.create({ data: { email: 'admin@adv.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
  await saveDailyRate(db, { day: localDay(new Date(), TZ), rate: 5 }, actor(), writeAudit);
});
after(closeDb);

dbTest('ödenmiş proforma + yüklenmiş + avans yok: çıkmaz kalktı — avans yüklemeden SONRA kesilir; kısmi ödeme, ek ödeme → ikinci avans; fatura bütün avansları düşer', async () => {
  const o = await glassOrder(10);
  const fgo = fakeFgo(100);
  const pf = await proforma(o, fgo); // PRF101, 726 RON
  await markLoaded(o); // proformadan sonra cam yüklendi; avans faturası henüz yok
  // FGO'da tahsilat yok: avans istenemez, kapanış faturası istenebilir (ödenmemiş proforma — mevcut akış)
  let st = await stateOf(o, true);
  assert.deepEqual([st.actions, st.paid, st.advanced, st.advanceRequired], [['invoice'], 0, 0, 0]);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: false, code: 'NOT_ALLOWED' });

  // --- Kısmi ödeme FGO'da görünür (300 / 726): avans düğmesi YÜKLEMEDEN SONRA da çıkar, fatura engellenir
  await fgoPays(fgo, pf, 300);
  st = await stateOf(o, true);
  assert.deepEqual([st.actions, st.wait, st.paid, st.advanced, st.advanceRequired], [['advance'], 'advance_required', 300, 0, 300]);
  assert.deepEqual(await request(o, 'INVOICE'), { ok: false, code: 'NOT_ALLOWED' }, 'avansı kesilmemiş tahsilat varken kapanış faturası istenemez');
  // Çift tıklama / aynı anda iki istek: tek iş
  const twice = await Promise.all([request(o, 'ADVANCE'), request(o, 'ADVANCE')]);
  assert.deepEqual(twice.map((x) => x.ok).sort(), [false, true]);
  assert.equal(twice.find((x) => !x.ok).code, 'NOT_ALLOWED');
  let [job] = await jobs(o, 'ADVANCE');
  assert.deepEqual([(await jobs(o, 'ADVANCE')).length, job.payload.seq, job.payload.amount], [1, 1, 300], 'sıra ve tutar istekte saklanır (tahsilat − avansı kesilen)');
  // Aynı anda iki işçi: FGO'ya tek istek, tek belge
  const runs = await Promise.all([g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id }))]);
  assert.equal(runs.reduce((n, r) => n + r.done, 0), 1);
  assert.equal(fgo.calls.length, 2);
  const a1 = fgo.calls[1];
  assert.deepEqual([a1.Serie, a1.IdExtern, lines(a1)], ['GKH', `${o.orderNo}-A`, [[`Avans marfă conform proformă ${pf}`, '1', '247.93']]], '300 / 1,21');
  let docs = await docsOf(o.id);
  assert.deepEqual(docs.map((d) => [d.kind, d.seq, d.advanced?.toString() ?? null]), [['PROFORMA', 1, null], ['ADVANCE', 1, '300']]);
  // Tahsilatın tamamının avansı kesildi: şimdi kapanış faturası istenebilir; yeni avans istenemez (1 banlık yuvarlama farkı avans doğurmaz)
  st = await stateOf(o, true);
  assert.deepEqual([st.actions, st.paid, st.advanced, st.advanceRequired], [['invoice'], 300, 300, 0]);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: false, code: 'NOT_ALLOWED' });

  // --- Sonradan ek ödeme (toplam 726): ikinci avans yalnızca fark kadar (426); fatura yine engellenir
  await fgoPays(fgo, pf, 726);
  st = await stateOf(o, true);
  assert.deepEqual([st.actions, st.wait, st.paid, st.advanced, st.advanceRequired], [['advance'], 'advance_required', 726, 300, 426]);
  assert.deepEqual(await request(o, 'INVOICE'), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: true });
  // Yeniden deneme: ilk denemede FGO'ya ulaşılamadı → iş kuyrukta kalır; ikinci denemede aynı IdExtern ile tek belge
  fgo.failNext = 1;
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 0, failed: 1 });
  [, job] = await jobs(o, 'ADVANCE');
  assert.deepEqual([job.status, job.attempts], ['PENDING', 1]);
  assert.equal(fgo.calls.length, 2, 'belge kesilmedi');
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, now: new Date(Date.now() + 10 * 60_000) })), { done: 1, failed: 0 });
  const a2 = fgo.calls[2];
  assert.deepEqual([a2.IdExtern, lines(a2)], [`${o.orderNo}-A2`, [[`Avans marfă conform proformă ${pf}`, '1', '352.07']]], '426 / 1,21; ikinci avansın IdExtern\'i sıralı');
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, now: new Date(Date.now() + 60 * 60_000) })), { done: 0, failed: 0 }, 'iş bitti: yeniden kesilmez');
  docs = await docsOf(o.id);
  assert.deepEqual(docs.map((d) => [d.kind, d.seq, d.advanced?.toString() ?? null]), [['PROFORMA', 1, null], ['ADVANCE', 1, '300'], ['ADVANCE', 2, '426']]);
  const [adv1, adv2] = docs.filter((d) => d.kind === 'ADVANCE');
  // Veritabanı: aynı sıradan ikinci avans olamaz
  await assert.rejects(db.fgoDocument.create({ data: { orderId: o.id, kind: 'ADVANCE', seq: 2, series: 'GKH', number: '9999', issuedAt: new Date() } }), /Unique constraint/);
  // Alacak: proforma + iki avans tek borç (726), iki kez sayılmaz
  const mine = async () => (await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.orderId === o.id);
  assert.equal(receivables(await mine()).sums.RON.total, 726);

  // --- Kapanış faturası: cam satırı + HER avans için düşüm satırı (sırasıyla)
  st = await stateOf(o, true);
  assert.deepEqual([st.actions, st.advanceRequired], [['invoice'], 0]);
  assert.deepEqual(await request(o, 'INVOICE'), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  const inv = fgo.calls[3];
  assert.equal(inv.IdExtern, `${o.orderNo}-F`);
  assert.deepEqual(lines(inv), [
    ['Securizat', '2', null], // cam satırı TVA dahil toplamla gider (PretTotal)
    [`Stornare avans conform factură ${adv1.series}${adv1.number}`, '-1', '247.93'],
    [`Stornare avans conform factură ${adv2.series}${adv2.number}`, '-1', '352.07'],
  ]);
  assert.equal(inv['Continut[0][PretTotal]'], '726.00');
  assert.deepEqual((await stateOf(o, true)).actions, [], 'belge akışı tamam');
  assert.equal(receivables(await mine()).sums.RON.total, 726, 'fatura avansları düştü: borç yine 726');
  // Denetim: avans isteği ve kesimi tutar kaynağıyla (FGO tahsilatı, önceki avans)
  const audits = await db.auditLog.findMany({ where: { entityId: o.id, action: 'FGO_DOC_REQUEST' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.filter((a) => a.details.kind === 'ADVANCE').map((a) => [a.details.seq, a.details.fgoPaid, a.details.advancedBefore, a.details.amountRon]), [[1, 300, 0, 300], [2, 726, 300, 426]]);
});

dbTest('avans yüklemeden ÖNCE de kesilir; ödemenin tek kaynağı FGO: elle girilmiş eski ödeme kaydı avans açmaz, tutar yazılamaz', async () => {
  const o = await glassOrder(10); // yüklenmemiş
  const fgo = fakeFgo(200);
  const pf = await proforma(o, fgo);
  // Eski sürümden kalma elle ödeme kaydı (GlassBilling.paidAmount): okunmaz
  assert.equal(g.markGlassPaid, undefined, 'elle "ödeme alındı" işlemi kaldırıldı');
  await db.glassBilling.update({ where: { orderId: o.id }, data: { paidAt: new Date(), paidAmount: '500.00', paidById: admin.id } });
  let st = await stateOf(o, false);
  assert.deepEqual([st.actions, st.wait, st.paid, st.advanceRequired], [[], 'wait_payment', 0, 0]);
  assert.deepEqual(await request(o, 'ADVANCE'), { ok: false, code: 'NOT_ALLOWED' }, 'FGO\'da tahsilat yokken avans kesilmez');
  // İstekte tutar taşınamaz: fazladan alan yok sayılır, tutar FGO'dan
  await fgoPays(fgo, pf, 726);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor(), amount: 5 }), { ok: true });
  assert.equal((await jobs(o, 'ADVANCE'))[0].payload.amount, 726);
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  assert.deepEqual(lines(fgo.calls[1]), [[`Avans marfă conform proformă ${pf}`, '1', '600.00']], '726 / 1,21 — elle kayıttaki 500 değil');
  st = await stateOf(o, false);
  assert.deepEqual([st.actions, st.wait, st.advanced], [[], 'wait_loading', 726]);
  assert.deepEqual(await request(o, 'INVOICE'), { ok: false, code: 'NOT_ALLOWED' }, 'yüklenmeden kapanış faturası yok');
});

dbTest('kesim anında yeniden bakılır: tahsilat azaldıysa avans kesilmez; fatura kuyruktayken tahsilat geldiyse fatura kesilmez (önce avans)', async () => {
  const fgo = fakeFgo(300);
  // A) Avans isteğinden sonra FGO'daki tahsilat azalır (ödeme geri alınmış): saklanan tutar kesilmez
  const a = await glassOrder(10);
  const pa = await proforma(a, fgo);
  await fgoPays(fgo, pa, 400);
  assert.deepEqual(await request(a, 'ADVANCE'), { ok: true });
  await fgoPays(fgo, pa, 100);
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: a.id })), { done: 0, failed: 1 });
  const [ja] = await jobs(a, 'ADVANCE');
  assert.equal(ja.status, 'FAILED');
  assert.match(ja.lastError, /tahsilat değişti/);
  assert.equal(await db.fgoDocument.count({ where: { orderId: a.id, kind: 'ADVANCE' } }), 0);
  assert.equal(await db.adminAlert.count({ where: { orderId: a.id, type: 'FGO_FAILED' } }), 1);
  // Güncel tahsilat (100) için yeni istek kesilir
  assert.deepEqual(await request(a, 'ADVANCE'), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: a.id })), { done: 1, failed: 0 });
  assert.equal((await docsOf(a.id)).find((d) => d.kind === 'ADVANCE').advanced.toString(), '100');

  // B) Ödenmemiş proformada fatura istenir; iş kuyruktayken tahsilat görünür → kesim anında durur, FGO'ya gidilmez
  const b = await glassOrder(10);
  const pb = await proforma(b, fgo);
  await markLoaded(b);
  assert.deepEqual(await request(b, 'INVOICE'), { ok: true });
  await fgoPays(fgo, pb, 250);
  const callsBefore = fgo.calls.length;
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: b.id })), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, callsBefore, 'fatura kesilmedi');
  const [jb] = await jobs(b, 'INVOICE');
  assert.deepEqual([jb.status, /avansı kesilmemiş 250\.00 RON/.test(jb.lastError)], ['FAILED', true]);
  // Çıkmaz yok: avans kesilir, sonra fatura avansı düşer
  assert.deepEqual((await stateOf(b, true)).actions, ['advance']);
  assert.deepEqual(await request(b, 'ADVANCE'), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: b.id })), { done: 1, failed: 0 });
  assert.deepEqual(await request(b, 'INVOICE'), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: b.id })), { done: 1, failed: 0 });
  const last = fgo.calls.at(-1);
  assert.deepEqual(lines(last).map((l) => l[0].replace(/GKH\d+/, 'GKH#')), ['Securizat', 'Stornare avans conform factură GKH#']);
  assert.equal(lines(last)[1][2], '206.61', '250 / 1,21');
});
