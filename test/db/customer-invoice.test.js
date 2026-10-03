// Onaylı yüklemeden müşteri faturası ve müşteri proformasının avans zinciri (Aşama 7D-3, karar 101) — veritabanıyla.
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR de sahtedir (ağa çıkılmaz).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { dayKey } = await import('../../server/orders/loading.js');
const { listDocuments, receivables, refreshDocuments } = await import('../../server/accounting/receivables.js');
const { snapshotLine } = await import('../../server/loading/confirmation.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');

const SECRET = 'i'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, seq = 0, dayNo = 1;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const noon = (offset) => new Date(`${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
/** Her onay için ayrı, geçmiş bir yükleme günü (gün başına tek onay) */
const pastDay = () => dayKey(noon(-(dayNo += 1)));

/**
 * Sahte FGO: emitere çağrıları sayılır; belge toplamı gönderilen satırlardan hesaplanır (getstatus bunu döner), ödenen
 * tutar testte ayarlanır. Gerçek FGO adresine hiçbir şey gitmez.
 */
function fakeFgo(start, { emit = null } = {}) {
  let n = start;
  const calls = [];
  const state = new Map(); // "GKH101" → { total, paid, gone }
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const s = state.get(`${form.Serie}${form.Numar}`);
      if (s?.gone) return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: (s?.total ?? 0).toFixed(2), ValoareAchitata: (s?.paid ?? 0).toFixed(2) } }));
    }
    if (emit) { const r = emit(form); if (r) return r; }
    calls.push(form);
    n += 1;
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      const q = Number(form[`Continut[${i}][NrProduse]`]);
      total += form[`Continut[${i}][PretTotal]`] != null ? Number(form[`Continut[${i}][PretTotal]`]) : Math.round(q * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, { total: Math.round(total * 100) / 100, paid: 0 });
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl, state };
}
const never = (name) => async () => { throw new Error(`${name} çağrılmamalıydı`); };
const bnr = (rate, date = dayKey(new Date())) => async () => ({ ok: true, rate, date, url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });
const names = (form) => Object.keys(form).filter((k) => /^Continut\[\d+\]\[Denumire\]$/.test(k)).map((k) => form[k]);

async function customer(name, prefix, data = {}) {
  return db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@inv.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR', ...data } });
}
/** Cam: adet × 1 m² × 50 (müşteri fiyatı), maliyet 30; isteğe bağlı CNC 2 × 10 */
async function order(c, { pieces = 2, cnc = false, currency = 'EUR', shipDate = noon(-1) } = {}) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${String(seq).padStart(3, '0')}`, customerOrderNo: seq, title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency, amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: pieces, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          ...(cnc ? [{ sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' }] : []),
        ] } } },
    },
  });
}
/**
 * Yükleme onayı (7C kaydı): her sipariş için teklif satırlarının kopyası — confirmLoading ile aynı fonksiyon (snapshotLine).
 * loaded: cam satırının yüklenen adedi (verilmezse tamamı; 0 = hiç yüklenmedi). Kalan adet NOT_LOADED kaydedilir.
 */
async function confirm(day, entries) {
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id } });
  const rows = [];
  for (const { order: o, loaded } of entries) {
    const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
    const offer = full.offers.find((x) => x.status === 'GONDERILDI');
    for (const l of offer.lines) {
      const all = Number(l.adet);
      const glass = (l.kind ?? 'CAM') === 'CAM';
      const qty = loaded == null || !glass ? (loaded === 0 ? 0 : all) : loaded;
      if (qty > 0) rows.push(snapshotLine(full, offer, l, { quantity: qty }));
      if (qty < all) rows.push(snapshotLine(full, offer, l, { quantity: all - qty, status: 'NOT_LOADED', reason: 'test' }));
    }
  }
  await db.loadingConfirmationItem.createMany({
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
  return conf;
}
const billing = (day, extra = {}) => inv.loadingBilling(db, { day, bnrImpl: bnr('5.0000'), ...extra });
const groupsOf = (r, c) => r.customers.find((x) => x.customerId === c.id)?.groups ?? [];
const createInvoice = (day, grp, extra = {}) => inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: bnr('5.0000'), ...extra });
const batchOf = (id) => db.billingBatch.findUnique({ where: { id }, include: { orders: { orderBy: { orderNo: 'asc' } }, lines: { orderBy: { sortOrder: 'asc' } }, document: true } });
const setPaid = (fgo, doc, paid) => {
  const key = `${doc.series}${doc.number}`;
  fgo.state.set(key, { ...fgo.state.get(key), paid });
  return db.fgoDocument.update({ where: { id: doc.id }, data: { paid: paid.toFixed(2) } });
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@inv.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());
});
after(closeDb);

dbTest('onaylı yükleme → müşteri başına TEK fatura: yalnızca LOADED kalemler, proforma şart değil, iki müşteri ayrı fatura, sipariş numaraları satırlarda', async () => {
  const abc = await customer('ABC Glass SRL', 'ABC');
  const xyz = await customer('XYZ Glass SRL', 'XYZ');
  const a1 = await order(abc, { cnc: true });
  const a2 = await order(abc);
  const a3 = await order(abc); // yüklenmedi
  const x1 = await order(xyz);
  const day = pastDay();
  const conf = await confirm(day, [{ order: a1 }, { order: a2 }, { order: a3, loaded: 0 }, { order: x1 }]);

  const r = await billing(day);
  assert.equal(r.ok, true);
  assert.deepEqual(r.customers.map((c) => [c.name, c.groups.length, c.issued.length]), [['ABC Glass SRL', 1, 0], ['XYZ Glass SRL', 1, 0]]);
  const ga = groupsOf(r, abc)[0];
  assert.deepEqual(ga.orders.map((o) => o.orderNo), [a1.orderNo, a2.orderNo], 'NOT_LOADED sipariş faturaya girmez');
  // Fatura kuralı (sipariş faturasıyla aynı): yalnızca cam satırı, CNC cama eklenir; önizleme = kesilecek belge
  assert.deepEqual(ga.orders[0].lines, [{ name: `Comanda ${a1.orderNo} — Sticlă securizată 10 mm`, pieces: 2, m2: 2, amount: 120, net: 600, gross: 726 }]);
  assert.deepEqual([ga.chain, ga.currency, ga.sourceTotal, ga.ronNet, ga.ronGross, ga.payable, ga.problems, ga.storno], [null, 'EUR', 220, 1100, 1331, 1331, [], []]);
  assert.deepEqual([ga.fx.policy, ga.fx.finalRate, ga.fx.source], ['BNR', '5.0000', 'BNR'], 'doğrudan fatura: kur müşterinin kur politikasından');
  assert.ok(!/unitCost|costAmount|unitPrice/.test(JSON.stringify(r)), 'fabrika maliyeti önizlemede yok');

  // Yetki sunucuda
  for (const role of ['CUSTOMER', 'SALES', 'DRAWING', 'INSPECTOR', null]) {
    assert.deepEqual(await inv.createInvoiceBatch(db, { day, groupKey: ga.key, previewKey: ga.previewKey, actor: actor(role), bnrImpl: bnr('5.0000') }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  // Önizlemeden sonra kur değiştiyse fatura oluşturulmaz
  assert.deepEqual(await createInvoice(day, ga, { bnrImpl: bnr('5.3000') }), { ok: false, code: 'STALE_PREVIEW' });

  // Çift tıklama / eşzamanlı istek: tek parti
  const results = await Promise.all([createInvoice(day, ga), createInvoice(day, ga), createInvoice(day, ga)]);
  assert.equal(results.filter((x) => x.ok).length, 1);
  assert.ok(results.filter((x) => !x.ok).every((x) => ['NOTHING_TO_INVOICE', 'ALREADY_INVOICED', 'STALE_PREVIEW'].includes(x.code)));
  assert.deepEqual(await createInvoice(day, ga), { ok: false, code: 'NOTHING_TO_INVOICE' });
  const batchId = results.find((x) => x.ok).batchId;
  assert.equal(await db.billingBatch.count({ where: { confirmationId: conf.id, customerId: abc.id } }), 1);

  // İşçi: eşzamanlı iki tur tek fatura keser; kur ve satırlar partiden (BNR yeniden istenmez)
  const fgo = fakeFgo(100);
  const turns = await Promise.all([b.dispatchBatchJobs(db, ctx(fgo, { bnrImpl: never('BNR') })), b.dispatchBatchJobs(db, ctx(fgo))]);
  assert.equal(turns.reduce((s, x) => s + x.done, 0), 1);
  assert.equal(fgo.calls.length, 1, 'tek FGO faturası');
  const f = fgo.calls[0];
  assert.deepEqual([f.Serie, f.Valuta, f.IdExtern, f.TipFactura], ['GKH', 'RON', `LOT-${batchId}`, 'Factura']);
  assert.deepEqual(names(f), [`Comanda ${a1.orderNo} — Sticlă securizată 10 mm`, `Comanda ${a2.orderNo} — Sticlă securizată 10 mm`]);
  assert.deepEqual([f['Continut[0][NrProduse]'], f['Continut[0][UM]'], f['Continut[0][PretTotal]'], f['Continut[1][PretTotal]']], ['2', 'mp', '726.00', '605.00']);
  assert.equal(f.Text, `Comenzi: ${a1.orderNo}, ${a2.orderNo}. Încărcare confirmată: ${day.split('-').reverse().join('.')}.`);
  assert.ok(!('Numar' in f), 'numarayı FGO verir');
  assert.ok(![a3.orderNo, x1.orderNo, 'XYZ'].some((s) => JSON.stringify(f).includes(s)), 'yüklenmeyen sipariş ve başka müşteri faturada yok');
  const bt = await batchOf(batchId);
  assert.deepEqual([bt.kind, bt.status, bt.confirmationId, bt.parentId, bt.document.kind, `${bt.document.series}${bt.document.number}`, bt.document.orderId, bt.document.total.toString()],
    ['INVOICE', 'ISSUED', conf.id, null, 'INVOICE', 'GKH101', null, '1331']);
  assert.deepEqual([bt.fxRate.toString(), bt.fxSource, bt.fxPolicy, bt.sourceTotal.toString(), bt.ronNet.toString()], ['5', 'BNR', 'BNR', '220', '1100'], 'kur bir kez çözülüp kaydedildi');
  assert.deepEqual(bt.lines.map((l) => [l.pieces, l.quantity.toString(), l.amount.toString(), l.ronNet.toString(), l.ronGross.toString()]), [[2, '2', '120', '600', '726'], [2, '2', '100', '500', '605']]);

  // Kesilen fatura bölümde görünür; aynı kapsam yeniden faturalanamaz; sipariş başına fatura da istenemez
  const r2 = await billing(day);
  assert.deepEqual(groupsOf(r2, abc), []);
  assert.deepEqual(r2.customers.find((c) => c.customerId === abc.id).issued.map((i) => [i.ref, i.status, i.orders]), [['GKH101', 'ISSUED', [a1.orderNo, a2.orderNo]]]);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: a1.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  await assert.rejects(db.billingBatch.create({ data: { ...Object.fromEntries(Object.entries(bt).filter(([k]) => !['id', 'orders', 'lines', 'document'].includes(k))) } }), /Unique constraint/, 'aynı onay + müşteri + kapsam için ikinci fatura partisi veritabanında da olamaz');

  // İkinci müşteri: kendi faturası
  const gx = groupsOf(r2, xyz)[0];
  const rx = await createInvoice(day, gx);
  assert.equal(rx.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo));
  assert.equal(fgo.calls.length, 2);
  assert.deepEqual(names(fgo.calls[1]), [`Comanda ${x1.orderNo} — Sticlă securizată 10 mm`]);
  assert.equal(fgo.calls[1]['Client[Denumire]'], 'XYZ Glass SRL');
  // Yükleme onayı değişmedi
  assert.equal(await db.loadingConfirmationItem.count({ where: { confirmationId: conf.id } }), 5);
});

dbTest('kısmi yükleme: 10 adedin 8\'i yüklendiyse yalnızca 8 faturalanır; kalan 2 sonraki onaylı yüklemede faturalanır; onay kopyası kullanılır', async () => {
  const c = await customer('Partial SRL', 'PRT');
  const o = await order(c, { pieces: 10 });
  const d1 = pastDay();
  await confirm(d1, [{ order: o, loaded: 8 }]);
  // Onaydan sonra teklif ve sipariş değişir: fatura yine onay anındaki kopyadan
  await db.offerLine.updateMany({ where: { offer: { orderId: o.id } }, data: { offerPrice: '99', adet: 3, descriptionRo: 'ALTCEVA' } });
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: noon(30) } });
  const g1 = groupsOf(await billing(d1), c)[0];
  assert.deepEqual(g1.orders[0].lines, [{ name: `Comanda ${o.orderNo} — Sticlă securizată 10 mm`, pieces: 8, m2: 8, amount: 400, net: 2000, gross: 2420 }]);
  const r1 = await createInvoice(d1, g1);
  const fgo = fakeFgo(200);
  await b.dispatchBatchJobs(db, ctx(fgo));
  assert.deepEqual([fgo.calls[0]['Continut[0][NrProduse]'], fgo.calls[0]['Continut[0][PretTotal]']], ['8', '2420.00']);

  // Kalan 2 adet sonra yüklenir: yeni onay → yeni fatura, yalnızca 2 adet (ilk 8 yeniden faturalanmaz)
  await db.offerLine.updateMany({ where: { offer: { orderId: o.id } }, data: { offerPrice: '50', adet: 2, descriptionRo: 'Sticlă securizată 10 mm' } });
  const d2 = pastDay();
  await confirm(d2, [{ order: o }]);
  assert.deepEqual(groupsOf(await billing(d1), c), [], 'ilk onayın kapsamı faturalandı');
  const g2 = groupsOf(await billing(d2), c)[0];
  assert.deepEqual(g2.orders[0].lines.map((l) => [l.pieces, l.m2, l.gross]), [[2, 2, 605]]);
  const r2 = await createInvoice(d2, g2);
  await b.dispatchBatchJobs(db, ctx(fgo));
  assert.equal(fgo.calls[1]['Continut[0][NrProduse]'], '2');
  assert.notEqual(r1.batchId, r2.batchId);
  const rows = await db.billingBatchOrder.findMany({ where: { orderId: o.id }, orderBy: { batch: { createdAt: 'asc' } } });
  assert.equal(new Set(rows.map((x) => x.activeKey)).size, 2, 'aynı sipariş iki onaydan iki ayrı faturada; anahtarlar ayrı');
  assert.equal(await db.fgoDocument.count({ where: { batch: { customerId: c.id } } }), 2);
});

dbTest('müşteri proforması zinciri: yalnızca onaylanan kapsam faturalanır; ödenmiş proforma → önce avans (yüklemeden sonra da); avans faturada düşülür; borç bir kez sayılır', async () => {
  const c = await customer('Chain SRL', 'CHN');
  const future = [noon(10), noon(17), noon(24)];
  const [c1, c2, c3] = [await order(c, { shipDate: future[0] }), await order(c, { shipDate: future[1] }), await order(c, { shipDate: future[2] })];
  // 7D-2: üç yükleme gününü kapsayan TEK müşteri proforması, kur 5,0000
  const days = future.map((d) => dayKey(d));
  const pv = await b.previewBatch(db, { customerId: c.id, days, bnrImpl: bnr('5.0000') });
  const pr = await b.createBatch(db, { customerId: c.id, days, key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') });
  const fgo = fakeFgo(300);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: pr.batchId }));
  const P = await batchOf(pr.batchId);
  assert.deepEqual([`${P.document.series}${P.document.number}`, P.document.total.toString()], ['PRF301', '1815']);

  // Yalnızca c1 yüklendi (ilk gün)
  const d1 = pastDay();
  await confirm(d1, [{ order: c1 }]);
  // Zincir tanınır: kur proformanın kuru (BNR artık farklı olsa da yeniden çözülmez)
  let g1 = groupsOf(await billing(d1, { bnrImpl: never('BNR') }), c)[0];
  assert.deepEqual([g1.chainId, g1.chain.ref, g1.orders.map((o) => o.orderNo), g1.fx.finalRate, g1.ronGross, g1.problems], [pr.batchId, 'PRF301', [c1.orderNo], '5.0000', 605, []]);

  // Proformaya kısmi tahsilat (FGO): 600 / 1815 — avans faturası yok → fatura kesilmez, avans yüklemeden SONRA kesilebilir
  await setPaid(fgo, P.document, 600);
  const docsNow = () => listDocuments(db, 'GLASS_ORDER').then((all) => all.filter((d) => d.batch?.customer.name === 'Chain SRL'));
  assert.deepEqual(receivables(await docsNow()).sums, { RON: { total: 1815, paid: 600, rest: 1215 } }, 'kısmi ödeme: ne ödenmemiş ne tam ödenmiş');
  g1 = groupsOf(await billing(d1), c)[0];
  assert.deepEqual([g1.problems, g1.chain.paid, g1.chain.advanced, g1.chain.advanceRequired], [['ADVANCE_REQUIRED'], 600, 0, 600]);
  assert.deepEqual(await createInvoice(d1, g1), { ok: false, code: 'ADVANCE_REQUIRED' });
  for (const role of ['SALES', 'CUSTOMER']) assert.deepEqual(await inv.createAdvanceBatch(db, { proformaBatchId: pr.batchId, actor: actor(role) }), { ok: false, code: 'FORBIDDEN' });
  const [av1, av2] = await Promise.all([inv.createAdvanceBatch(db, { proformaBatchId: pr.batchId, actor: actor() }), inv.createAdvanceBatch(db, { proformaBatchId: pr.batchId, actor: actor() })]);
  assert.deepEqual([av1.ok, av2.ok].sort(), [false, true], 'eşzamanlı iki istek: tek avans partisi');
  const av = av1.ok ? av1 : av2;
  assert.equal(av.amount, 600, 'avans tutarı = FGO\'da görünen tahsilat (uydurma yok)');
  assert.deepEqual((await billing(d1)).customers[0].groups[0].problems, ['ADVANCE_PENDING']);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: av.batchId }));
  const fa = fgo.calls[1];
  assert.deepEqual([fa.Serie, fa['Continut[0][Denumire]'], fa['Continut[0][NrProduse]'], fa['Continut[0][PretUnitar]'], fa.IdExtern], ['GKH', 'Avans marfă conform proformă PRF301', '1', '495.87', `LOT-${av.batchId}`]);
  const A = await batchOf(av.batchId);
  assert.deepEqual([A.kind, A.parentId, A.status, `${A.document.series}${A.document.number}`, A.orders.map((o) => o.activeKey)], ['ADVANCE', pr.batchId, 'ISSUED', 'GKH302', [null, null, null]]);
  await setPaid(fgo, A.document, 600);
  assert.deepEqual(await inv.createAdvanceBatch(db, { proformaBatchId: pr.batchId, actor: actor() }), { ok: false, code: 'NOTHING_TO_ADVANCE' });

  // Avans kesildi → fatura açılır: yalnızca yüklenen c1; avans, faturanın tutarını aşmadan düşülür
  g1 = groupsOf(await billing(d1), c)[0];
  assert.deepEqual([g1.problems, g1.storno.map((s) => [s.ref, s.gross, s.net]), g1.payable], [[], [['GKH302', 600, 495.87]], 5]);
  const i1 = await createInvoice(d1, g1, { bnrImpl: never('BNR') });
  assert.equal(i1.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i1.batchId }));
  const f1 = fgo.calls[2];
  assert.deepEqual(names(f1), [`Comanda ${c1.orderNo} — Sticlă securizată 10 mm`, 'Stornare avans conform factură GKH302']);
  assert.deepEqual([f1['Continut[0][PretTotal]'], f1['Continut[1][NrProduse]'], f1['Continut[1][PretUnitar]']], ['605.00', '-1', '495.87']);
  assert.ok(![c2.orderNo, c3.orderNo].some((x) => JSON.stringify(f1).includes(x)), 'proformanın kalan kapsamı bu faturada yok');
  const I1 = await batchOf(i1.batchId);
  assert.deepEqual([I1.parentId, I1.fxRate.toString(), I1.fxResolvedAt.toISOString(), I1.fxSourceDate.toISOString()], [pr.batchId, P.fxRate.toString(), P.fxResolvedAt.toISOString(), P.fxSourceDate.toISOString()], 'zincirin kur kaydı yeniden kullanılır');

  // Cam Tahsilat: proforma + avans + fatura üç ayrı borç değil, TEK ticari borç (1815)
  let rec = receivables(await docsNow());
  assert.deepEqual(rec.sums, { RON: { total: 1815, paid: 600, rest: 1215 } });
  const share = (id) => rec.shares.get(id);
  assert.deepEqual([share(P.document.id), share(A.document.id), share(I1.document.id)], [
    { debt: 1210, rest: 1210, replaced: false }, { debt: 600, rest: 0, replaced: false }, { debt: 5, rest: 5, replaced: false },
  ], 'fatura faturalanan kapsamın kaydıdır; proforma yalnızca kalan kapsamı temsil eder');

  // Proforma tümüyle "faturalandı" sayılmaz: c2 ve c3 hâlâ proformada, başka belgeye giremez
  assert.equal((await batchOf(pr.batchId)).status, 'ISSUED');
  assert.deepEqual((await db.billingBatchOrder.findMany({ where: { batchId: pr.batchId }, orderBy: { orderNo: 'asc' } })).map((o) => o.activeKey != null), [true, true, true]);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: c2.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });

  // Sonra c2 yüklenir; bu arada proformaya 400 daha gelmiş: önce ikinci avans, sonra fatura (avans 400 düşülür)
  const d2 = pastDay();
  await confirm(d2, [{ order: c2 }]);
  await setPaid(fgo, P.document, 1000);
  let g2 = groupsOf(await billing(d2), c)[0];
  assert.deepEqual([g2.problems, g2.chain.advanceRequired, g2.storno], [['ADVANCE_REQUIRED'], 400, []]);
  const avb = await inv.createAdvanceBatch(db, { proformaBatchId: pr.batchId, actor: actor() });
  assert.deepEqual([avb.ok, avb.amount], [true, 400]);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: avb.batchId }));
  g2 = groupsOf(await billing(d2), c)[0];
  assert.deepEqual([g2.problems, g2.storno.map((s) => [s.ref, s.gross]), g2.payable], [[], [['GKH304', 400]], 205]);
  const i2 = await createInvoice(d2, g2);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i2.batchId }));
  rec = receivables(await docsNow());
  // 1815 = avanslar 600 + 400 · faturalar 5 + 205 · proformanın kalan kapsamı (c3) 605
  assert.equal(rec.sums.RON.total, 1815);
  assert.deepEqual(rec.shares.get(P.document.id), { debt: 605, rest: 605, replaced: false });
  // Son yükleme: c3 → proforma tümüyle faturaya döner
  const d3 = pastDay();
  await confirm(d3, [{ order: c3 }]);
  const g3 = groupsOf(await billing(d3), c)[0];
  assert.deepEqual([g3.storno, g3.payable], [[], 605], 'avanslar önceki faturalarda tükendi');
  const i3 = await createInvoice(d3, g3);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i3.batchId }));
  rec = receivables(await docsNow());
  assert.equal(rec.sums.RON.total, 1815);
  assert.deepEqual(rec.shares.get(P.document.id), { debt: 0, rest: 0, replaced: true });
  assert.equal(fgo.calls.filter((x) => x.Serie === 'GKH').length, 5, '2 avans + 3 fatura');
});

dbTest('uyumsuz kapsam tek faturada birleştirilmez: farklı para birimi ve farklı kur zinciri ayrı fatura grubu; sipariş başına zinciri olan sipariş dışarıda', async () => {
  const c = await customer('Split SRL', 'SPL');
  const eur = await order(c);
  const ron = await order(c, { currency: 'RON' });
  const inProforma = await order(c, { shipDate: noon(12) });
  const own = await order(c);
  await db.fgoDocument.create({ data: { orderId: own.id, kind: 'PROFORMA', series: 'PRF', number: '9100', issuedAt: new Date() } });
  const pv = await b.previewBatch(db, { customerId: c.id, days: [dayKey(noon(12))], bnrImpl: bnr('4.9000') });
  const pr = await b.createBatch(db, { customerId: c.id, days: [dayKey(noon(12))], key: pv.key, actor: actor(), bnrImpl: bnr('4.9000') });
  const fgo = fakeFgo(400);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: pr.batchId }));
  const day = pastDay();
  const conf = await confirm(day, [{ order: eur }, { order: ron }, { order: inProforma }, { order: own }]);
  const r = await billing(day);
  const cb = r.customers.find((x) => x.customerId === c.id);
  assert.deepEqual(cb.groups.map((x) => [x.currency, x.chainId, x.fx.finalRate, x.orders.map((o) => o.orderNo)]).sort(), [
    ['EUR', null, '5.0000', [eur.orderNo]], ['EUR', pr.batchId, '4.9000', [inProforma.orderNo]], ['RON', null, '1.0000', [ron.orderNo]],
  ].sort(), 'kurlar ortalanmaz: zincir kendi kuruyla, doğrudan fatura bugünkü kurla, RON çevrimsiz');
  assert.equal(new Set(cb.groups.map((x) => x.key)).size, 3);
  assert.deepEqual(cb.excluded.map((o) => [o.orderNo, o.reason, o.ref]), [[own.orderNo, 'ORDER_CHAIN', 'PRF9100']], 'sipariş başına zinciri olan sipariş: faturası sipariş sayfasından');
  for (const grp of cb.groups) assert.equal((await createInvoice(day, grp)).ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo));
  assert.equal(await db.billingBatch.count({ where: { confirmationId: conf.id, kind: 'INVOICE' } }), 3);
  const totals = fgo.calls.slice(1).map((f) => f['Continut[0][PretTotal]']).sort();
  assert.deepEqual(totals, ['121.00', '592.90', '605.00'], 'RON 100 · EUR 100 × 4,9 · EUR 100 × 5,0 (TVA dahil)');
});

dbTest('kesilemeyen fatura kapsamı tutar ve yeniden denenir; vazgeçilirse ya da fatura FGO\'da silinirse yalnızca belge durumu geri alınır — yükleme onayı değişmez', async () => {
  const c = await customer('Retry SRL', 'RTY');
  const o = await order(c);
  const day = pastDay();
  const conf = await confirm(day, [{ order: o }]);
  const items = () => db.loadingConfirmationItem.findMany({ where: { confirmationId: conf.id }, orderBy: { sortOrder: 'asc' } });
  const before = JSON.stringify(await items());
  const grp = groupsOf(await billing(day), c)[0];
  const r = await createInvoice(day, grp);
  const reject = fakeFgo(500, { emit: () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' })) });
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(reject, { onlyBatchId: r.batchId })), { done: 0, failed: 1 });
  const view = (await billing(day)).customers.find((x) => x.customerId === c.id);
  assert.deepEqual([view.groups.length, view.issued.map((i) => [i.status, /Client invalid/.test(i.lastError)])], [0, [['FAILED', true]]], 'kapsam ayrılmış durumda; gerçek FGO hatası görünür');
  assert.deepEqual(await createInvoice(day, grp), { ok: false, code: 'NOTHING_TO_INVOICE' });
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r.batchId, action: 'retry', actor: actor() }), { ok: true });
  const fgo = fakeFgo(500);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId })), { done: 1, failed: 0 });
  assert.equal(await db.billingBatch.count({ where: { confirmationId: conf.id } }), 1, 'yeniden deneme yeni parti / belge üretmez');

  // Fatura FGO'da silinmiş: elle "FGO ile Güncelle" belge kaydını kaldırır, parti geçersiz olur, kapsam yeniden faturalanabilir
  fgo.state.set('GKH501', { gone: true });
  const res = await refreshDocuments(db, { orderType: 'GLASS_ORDER', secret: SECRET, fetchImpl: fgo.fetchImpl, sleep: async () => {} });
  assert.equal(res.ok, true);
  const bt = await batchOf(r.batchId);
  assert.deepEqual([bt.status, bt.voidReason, bt.uniqueKey, bt.document, bt.orders.map((x) => x.activeKey), bt.lines.length], ['VOID', 'FGO_DELETED', null, null, [null], 1]);
  assert.equal(JSON.stringify(await items()), before, 'yükleme onayı kalemleri değişmedi');
  assert.equal(await db.loadingConfirmation.count({ where: { id: conf.id } }), 1);
  await assert.rejects(db.loadingConfirmationItem.updateMany({ where: { confirmationId: conf.id }, data: { quantity: 1 } }), 'onay veritabanında da değiştirilemez');
  const again = groupsOf(await billing(day), c)[0];
  assert.deepEqual(again.orders.map((x) => x.orderNo), [o.orderNo]);
  const r2 = await createInvoice(day, again);
  assert.equal(r2.ok, true);
  // Vazgeçme: kesilemeyen partiden vazgeçilince kapsam serbest kalır
  await b.dispatchBatchJobs(db, ctx(reject, { onlyBatchId: r2.batchId }));
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: r2.batchId, action: 'void', actor: actor() }), { ok: true });
  assert.equal(groupsOf(await billing(day), c).length, 1);
  assert.equal(JSON.stringify(await items()), before);
  // Onaylanmamış gün: faturalama yok
  assert.deepEqual(await inv.loadingBilling(db, { day: dayKey(noon(40)) }), { ok: false, code: 'NOT_CONFIRMED' });
});
