// Onaylı yüklemeden müşteri faturası ve müşteri proformasının avans zinciri (Aşama 7D-3, karar 101) — veritabanıyla.
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR de sahtedir (ağa çıkılmaz).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { dayKey } = await import('../../server/orders/loading.js');
const { listDocuments, receivables, refreshDocuments } = await import('../../server/accounting/receivables.js');
const { snapshotLine } = await import('../../server/loading/confirmation.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');
const un = await import('../../server/accounting/uninvoiced.js');

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
  // "Yükleme yapıldı" kaydı yükleme gününün öğlesinde (fatura bekliyor sayacı bu kayıttan başlar — karar 189)
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date(`${day}T12:00:00Z`) } });
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
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
  return conf;
}
const billing = (day, extra = {}) => inv.loadingBilling(db, { day, bnrImpl: bnr('5.0000'), ...extra });
const groupsOf = (r, c) => r.customers.find((x) => x.customerId === c.id)?.groups ?? [];
const createInvoice = (day, grp, extra = {}) => inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: bnr('5.0000'), ...extra });
const batchOf = (id) => db.billingBatch.findUnique({ where: { id }, include: { orders: { orderBy: { orderNo: 'asc' } }, lines: { orderBy: { sortOrder: 'asc' } }, document: true } });
/** Bir müşterinin Cam Tahsilat belgeleri (müşteri belge zinciri) */
const docsOf = (name) => listDocuments(db, 'GLASS_ORDER').then((all) => all.filter((d) => d.batch?.customer.name === name));
/** Müşteri proforması (7D-2): verilen günlere planlı siparişler için tek proforma, kur 5,0000; kesilmiş parti döner */
async function proformaFor(c, shipDates, fgo, rate = '5.0000') {
  const days = shipDates.map((d) => dayKey(d));
  const pv = await b.previewBatch(db, { customerId: c.id, days, bnrImpl: bnr(rate) });
  const pr = await b.createBatch(db, { customerId: c.id, days, key: pv.key, actor: actor(), bnrImpl: bnr(rate) });
  assert.equal(pr.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: pr.batchId }));
  return batchOf(pr.batchId);
}
const rejecting = () => fakeFgo(9000, { emit: () => new Response(JSON.stringify({ Success: false, Message: 'Client invalid' })) });
const refresh = (fgo) => refreshDocuments(db, { orderType: 'GLASS_ORDER', secret: SECRET, fetchImpl: fgo.fetchImpl, sleep: async () => {}, limit: 500 });
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
  assert.deepEqual(ga.orders[0].lines, [{ name: `Comanda ${a1.orderNo} — Sticla 10 mm`, pieces: 2, m2: 2, amount: 120, net: 600, gross: 726 }]);
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
  assert.deepEqual(names(f), [`Comanda ${a1.orderNo} — Sticla 10 mm`, `Comanda ${a2.orderNo} — Sticla 10 mm`]);
  assert.deepEqual([f['Continut[0][NrProduse]'], f['Continut[0][UM]'], f['Continut[0][PretTotal]'], f['Continut[1][PretTotal]']], ['2', 'mp', '726.00', '605.00']);
  // Paket C (karar 235): parti metninin ardından belgenin kendi kur cümlesi (kayıtlı kur; uydurulmaz)
  assert.match(f.Text, new RegExp(`^Comenzi: ${a1.orderNo}, ${a2.orderNo}\\. Încărcare confirmată: ${day.split('-').reverse().join('\\.')}\\. Curs BNR: 5\\.0000 RON/EUR \\(data \\d{2}\\.\\d{2}\\.\\d{4}\\)\\.$`));
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
  assert.deepEqual(names(fgo.calls[1]), [`Comanda ${x1.orderNo} — Sticla 10 mm`]);
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
  assert.deepEqual(g1.orders[0].lines, [{ name: `Comanda ${o.orderNo} — Sticla 10 mm`, pieces: 8, m2: 8, amount: 400, net: 2000, gross: 2420 }]);
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
  assert.deepEqual(names(f1), [`Comanda ${c1.orderNo} — Sticla 10 mm`, 'Stornare avans conform factură GKH302']);
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

dbTest('avansı ve faturası kesilmiş müşteri proforması FGO\'da silinirse zincirin kökü kalır: borç iki kez doğmaz, avans / fatura izlenir, kalan avans düşülmeye devam eder', async () => {
  const c = await customer('Root SRL', 'ROT');
  const ship = [noon(11), noon(18)];
  const [o1, o2] = [await order(c, { shipDate: ship[0] }), await order(c, { shipDate: ship[1] })];
  const fgo = fakeFgo(600);
  const P = await proformaFor(c, ship, fgo);
  assert.deepEqual([`${P.document.series}${P.document.number}`, P.document.total.toString()], ['PRF601', '1210']);
  // Tahsilat 800 → avans 800; ilk yükleme (o1, 605) faturalanır: avansın 605'i düşülür, 195'i zincirde kalır
  await setPaid(fgo, P.document, 800);
  const av = await inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor() });
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: av.batchId }));
  const A = await batchOf(av.batchId);
  await setPaid(fgo, A.document, 800);
  const d1 = pastDay();
  const conf1 = await confirm(d1, [{ order: o1 }]);
  const g1 = groupsOf(await billing(d1), c)[0];
  assert.deepEqual([g1.storno.map((x) => [x.ref, x.gross]), g1.payable], [[['GKH602', 605]], 0]);
  const i1 = await createInvoice(d1, g1);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i1.batchId }));
  const items = async () => JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { confirmationId: conf1.id }, orderBy: { sortOrder: 'asc' } }));
  const before = await items();

  // Proforma FGO'da silinmiş (elle "FGO ile Güncelle")
  fgo.state.set('PRF601', { gone: true });
  assert.equal((await refresh(fgo)).ok, true);
  const root = await batchOf(P.id);
  assert.deepEqual([root.status, root.document, root.voidReason, root.orders.map((x) => x.activeKey != null)], ['ISSUED', null, null, [true, true]], 'yalnızca belge kaydı kalktı; parti zincirin kökü olarak duruyor');
  assert.deepEqual([root.fxRate.toString(), root.fxResolvedAt.toISOString()], [P.fxRate.toString(), P.fxResolvedAt.toISOString()], 'kur kaydı korunur');
  // Avans ve fatura izlenebilir: belgeleri duruyor, proformaya bağlı
  for (const id of [av.batchId, i1.batchId]) {
    const x = await batchOf(id);
    assert.deepEqual([x.status, x.parentId, x.document != null], ['ISSUED', P.id, true]);
  }
  assert.deepEqual((await docsOf('Root SRL')).map((d) => d.kind).sort(), ['ADVANCE', 'INVOICE']);
  assert.equal(await db.auditLog.count({ where: { action: 'FGO_DOC_REMOVED', entityId: P.id } }), 1);
  // Borç iki kez doğmaz: Cam Tahsilat'ta yalnızca avans (800, ödenmiş) + fatura (0); kalan sipariş başka belgeye giremez
  assert.deepEqual(receivables(await docsOf('Root SRL')).sums, { RON: { total: 800, paid: 800, rest: 0 } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o2.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  const pv = await b.previewBatch(db, { customerId: c.id, days: [dayKey(ship[1])], bnrImpl: bnr('5.0000') });
  assert.deepEqual(await b.createBatch(db, { customerId: c.id, days: [dayKey(ship[1])], key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') }).then((r) => r.ok), false, 'kalan sipariş için ikinci proforma kesilemez');
  assert.deepEqual(await inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'belgesi olmayan proformaya avans kesilmez');

  // Kalan sipariş yüklenir: fatura zincirin kuruyla (yeniden çözülmez) kesilir ve kalan 195 avansı düşer
  const d2 = pastDay();
  await confirm(d2, [{ order: o2 }]);
  const g2 = groupsOf(await billing(d2, { bnrImpl: never('BNR') }), c)[0];
  assert.deepEqual([g2.chainId, g2.chain.ref, g2.fx.finalRate, g2.problems, g2.storno.map((x) => [x.ref, x.gross]), g2.payable], [P.id, null, '5.0000', [], [['GKH602', 195]], 410]);
  const i2 = await createInvoice(d2, g2, { bnrImpl: never('BNR') });
  assert.equal(i2.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i2.batchId }));
  const f2 = fgo.calls.at(-1);
  assert.deepEqual(names(f2), [`Comanda ${o2.orderNo} — Sticla 10 mm`, 'Stornare avans conform factură GKH602']);
  const I2 = await batchOf(i2.batchId);
  assert.deepEqual([I2.parentId, I2.fxRate.toString(), I2.document.total.toString()], [P.id, '5', '410']);
  // Toplam ticari borç değişmedi: 1210 = avans 800 + faturalar 0 + 410
  assert.deepEqual(receivables(await docsOf('Root SRL')).sums, { RON: { total: 1210, paid: 800, rest: 410 } });
  assert.equal(fgo.calls.length, 4, 'proforma + avans + 2 fatura; fazladan belge yok');
  assert.equal(await items(), before, 'yükleme onayı değişmedi');
});

dbTest('kesilemeyen avans faturası: tahsilatı tutar, yeniden deneme tek belge keser; vazgeçilince yalnızca avans isteği bırakılır — fatura avans kesilmeden yine açılmaz', async () => {
  const c = await customer('Advance SRL', 'ADV');
  const ship = [noon(13), noon(20)];
  const [o1, o2] = [await order(c, { shipDate: ship[0] }), await order(c, { shipDate: ship[1] })];
  const fgo = fakeFgo(700);
  const advancesOf = (p) => db.billingBatch.findMany({ where: { parentId: p.id, kind: 'ADVANCE' }, orderBy: { createdAt: 'asc' }, include: { document: true } });

  // --- Yeniden deneme ---
  const P1 = await proformaFor(c, [ship[0]], fgo); // PRF701, 605
  await setPaid(fgo, P1.document, 400);
  const d1 = pastDay();
  await confirm(d1, [{ order: o1 }]);
  const a1 = await inv.createAdvanceBatch(db, { proformaBatchId: P1.id, actor: actor() });
  const reject = rejecting();
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(reject, { onlyBatchId: a1.batchId })), { done: 0, failed: 1 });
  let st = await inv.chainState(db, P1.id);
  assert.deepEqual([st.advancePending, st.advanceRequired, st.advances.map((x) => [x.status, /Client invalid/.test(x.lastError), x.left])], [true, 0, [['FAILED', true, 0]]], 'kesilemeyen avans tahsilatı tutar; gerçek FGO hatası görünür');
  // Tahsilat ayrılmış: ikinci avans istenemez, fatura da kesilemez
  assert.deepEqual(await inv.createAdvanceBatch(db, { proformaBatchId: P1.id, actor: actor() }), { ok: false, code: 'ADVANCE_PENDING' });
  let g1 = groupsOf(await billing(d1), c)[0];
  assert.deepEqual([g1.problems, g1.storno], [['ADVANCE_PENDING'], []]);
  assert.deepEqual(await createInvoice(d1, g1), { ok: false, code: 'ADVANCE_PENDING' });
  assert.equal(await db.fgoDocument.count({ where: { batchId: a1.batchId } }), 0);
  // Yeniden dene: iki kez basılsa da tek istek; işçi iki tur aynı anda çalışsa da tek belge
  for (const role of ['SALES', 'CUSTOMER']) assert.deepEqual(await b.reviewFailedBatch(db, { batchId: a1.batchId, action: 'retry', actor: actor(role) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: a1.batchId, action: 'retry', actor: actor() }), { ok: true });
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: a1.batchId, action: 'retry', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  const turns = await Promise.all([b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: a1.batchId })), b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: a1.batchId }))]);
  assert.equal(turns.reduce((s, x) => s + x.done, 0), 1);
  assert.equal(fgo.calls.filter((f) => f.Serie === 'GKH').length, 1, 'tek avans faturası');
  assert.deepEqual((await advancesOf(P1)).map((x) => [x.id, x.status, `${x.document.series}${x.document.number}`]), [[a1.batchId, 'ISSUED', 'GKH702']], 'yeniden deneme yeni parti üretmedi');
  for (const action of ['retry', 'void']) assert.deepEqual(await b.reviewFailedBatch(db, { batchId: a1.batchId, action, actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'kesilmiş avanstan vazgeçilemez');
  // Avans kesildi → fatura açılır ve avansı düşer
  g1 = groupsOf(await billing(d1), c)[0];
  assert.deepEqual([g1.problems, g1.storno.map((x) => [x.ref, x.gross]), g1.payable], [[], [['GKH702', 400]], 205]);

  // --- Vazgeçme ---
  const P2 = await proformaFor(c, [ship[1]], fgo); // PRF703, 605
  await setPaid(fgo, P2.document, 250);
  const d2 = pastDay();
  const conf2 = await confirm(d2, [{ order: o2 }]);
  const a2 = await inv.createAdvanceBatch(db, { proformaBatchId: P2.id, actor: actor() });
  await b.dispatchBatchJobs(db, ctx(reject, { onlyBatchId: a2.batchId }));
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: a2.batchId, action: 'void', actor: actor() }), { ok: true });
  const dead = await batchOf(a2.batchId);
  assert.deepEqual([dead.status, dead.uniqueKey, dead.document, dead.voidReason], ['VOID', null, null, 'ADMIN']);
  // Yalnızca avans isteği bırakıldı: proforma, belgesi, tahsilatı ve sipariş kapsamı yerinde
  const root = await batchOf(P2.id);
  assert.deepEqual([root.status, `${root.document.series}${root.document.number}`, root.document.paid.toString(), root.orders.map((x) => x.activeKey != null)], ['ISSUED', 'PRF703', '250', [true]]);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o2.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  st = await inv.chainState(db, P2.id);
  assert.deepEqual([st.advancePending, st.advanced, st.advanceRequired, st.advances], [false, 0, 250, []], 'tahsilat yeniden avanslanabilir');
  // Fatura hâlâ kesilemez (avansı kesilmemiş tahsilat var): vazgeçmek faturayı avanssız açmaz
  let g2 = groupsOf(await billing(d2), c)[0];
  assert.deepEqual(g2.problems, ['ADVANCE_REQUIRED']);
  assert.deepEqual(await createInvoice(d2, g2), { ok: false, code: 'ADVANCE_REQUIRED' });
  // Bırakılan istek sonradan da belge kesmez
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: a2.batchId })), { done: 0, failed: 0 });
  assert.deepEqual(await b.reviewFailedBatch(db, { batchId: a2.batchId, action: 'retry', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(await db.fgoDocument.count({ where: { batchId: a2.batchId } }), 0);
  // Yeni avans: aynı tutar, yeni parti, tek belge; sonra fatura avansı düşer
  const a3 = await inv.createAdvanceBatch(db, { proformaBatchId: P2.id, actor: actor() });
  assert.deepEqual([a3.ok, a3.amount, a3.batchId !== a2.batchId], [true, 250, true]);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: a3.batchId }));
  assert.deepEqual((await advancesOf(P2)).map((x) => [x.status, x.document ? `${x.document.series}${x.document.number}` : null]), [['VOID', null], ['ISSUED', 'GKH704']]);
  g2 = groupsOf(await billing(d2), c)[0];
  assert.deepEqual([g2.problems, g2.storno.map((x) => [x.ref, x.gross]), g2.payable], [[], [['GKH704', 250]], 355]);
  assert.equal(fgo.calls.filter((f) => f.Serie === 'GKH').length, 2, 'iki avans faturası; bırakılan istek için belge yok');
  assert.equal(reject.calls.length, 0);
  assert.equal(await db.loadingConfirmationItem.count({ where: { confirmationId: conf2.id } }), 1);
});

dbTest('doğrudan faturada elle kur: partiye MANUAL olarak kaydedilir, fatura tam o kurla kesilir; sonradan kur politikası / BNR değişse de değişmez', async () => {
  const c = await customer('Manual SRL', 'MAN'); // kur politikası BNR
  const o = await order(c);
  const day = pastDay();
  await confirm(day, [{ order: o }]);
  const auto = groupsOf(await billing(day), c)[0];
  assert.deepEqual([auto.fx.finalRate, auto.fx.source, auto.fx.manual, auto.ronGross], ['5.0000', 'BNR', false, 605]);
  // Önizleme elle kurla: BNR'ye gidilmez, tutarlar elle kurla
  const manual = { key: auto.key, rate: '5.25' };
  const man = groupsOf(await billing(day, { manual, bnrImpl: never('BNR') }), c)[0];
  assert.deepEqual([man.fx.finalRate, man.fx.baseRate, man.fx.source, man.fx.manual, man.fx.markupPercent, man.fx.policy], ['5.2500', '5.2500', 'MANUAL', true, null, 'BNR']);
  assert.deepEqual([man.ronNet, man.ronGross, man.payable, man.problems], [525, 635.25, 635.25, []]);
  assert.notEqual(man.previewKey, auto.previewKey);
  // Elle kur gönderilmezse önizlenen (elle kurlu) içerik kesilmez; geçersiz kurla da kesilmez
  assert.deepEqual(await createInvoice(day, man), { ok: false, code: 'STALE_PREVIEW' });
  assert.deepEqual(await createInvoice(day, man, { manualRate: 'abc' }), { ok: false, code: 'FX_UNAVAILABLE' });
  assert.deepEqual(await createInvoice(day, auto, { manualRate: '5.25' }), { ok: false, code: 'STALE_PREVIEW' }, 'kur önizlemeden sonra değiştiyse yeni önizleme gerekir');
  assert.equal(await db.billingBatch.count({ where: { customerId: c.id } }), 0);
  const r = await createInvoice(day, man, { manualRate: '5.25', bnrImpl: never('BNR') });
  assert.equal(r.ok, true);
  const snap = (x) => [x.fxRate.toString(), x.fxBaseRate.toString(), x.fxSource, x.fxManual, x.fxPolicy, x.fxCurrency, x.fxMarkupPercent, x.fxResolvedAt.toISOString(), x.ronNet.toString(), x.lines.map((l) => [l.ronNet.toString(), l.ronGross.toString()])];
  const saved = await batchOf(r.batchId);
  assert.deepEqual(snap(saved).slice(0, 7), ['5.25', '5.25', 'MANUAL', true, 'BNR', 'EUR', null]);
  assert.deepEqual(snap(saved).slice(8), ['525', [['525', '635.25']]]);
  const audit = await db.auditLog.findFirst({ where: { action: 'BILLING_BATCH_CREATED', entityId: r.batchId } });
  assert.deepEqual([audit.details.fxRate, audit.details.fxSource, audit.details.fxManual], ['5.2500', 'MANUAL', true]);

  // Sonradan müşterinin kur politikası ve BNR kuru değişir: kayıt ve kesilen fatura değişmez
  await db.customer.update({ where: { id: c.id }, data: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '5' } });
  const fgo = fakeFgo(800);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId, bnrImpl: never('BNR') })), { done: 1, failed: 0 });
  const f = fgo.calls[0];
  assert.deepEqual([f['Continut[0][NrProduse]'], f['Continut[0][PretTotal]'], f.Valuta], ['2', '635.25', 'RON']);
  assert.match(f.Text, / Curs de schimb aplicat: 5\.2500 RON\/EUR\.$/, 'Paket C (karar 235): belgenin kayıtlı elle kuru yazılır');
  assert.doesNotMatch(f.Text, /%/, 'yüzde hiçbir yerde yazmaz');
  const issued = await batchOf(r.batchId);
  assert.deepEqual(snap(issued), snap(saved), 'kur kaydı değişmedi');
  assert.equal(issued.document.total.toString(), '635.25');
  assert.deepEqual(await createInvoice(day, man, { manualRate: '5.25' }), { ok: false, code: 'NOTHING_TO_INVOICE' });
  assert.deepEqual((await billing(day, { bnrImpl: bnr('6.0000') })).customers[0].issued.map((i) => [i.ref, i.total]), [['GKH801', 635.25]]);
});

dbTest('sipariş başına kapsam yalnızca ŞU AN geçerliyse engeldir: FGO\'da silinen belge ve bırakılan istek siparişi müşteri faturasına açar', async () => {
  const c = await customer('Cover SRL', 'COV');
  const [deleted, failed, pending, active] = [await order(c), await order(c), await order(c), await order(c)];
  // Sipariş başına belgeler / istekler (yalnızca veritabanı kaydı; FGO'ya gidilmez)
  const gone = await db.fgoDocument.create({ data: { orderId: deleted.id, kind: 'PROFORMA', series: 'PRF', number: '9201', issuedAt: new Date(), total: '605.00', paid: '0' } });
  await db.fgoDocument.create({ data: { orderId: active.id, kind: 'PROFORMA', series: 'PRF', number: '9202', issuedAt: new Date(), total: '605.00', paid: '0' } });
  await db.notificationOutbox.create({ data: { type: g.GLASS_FGO, orderId: failed.id, payload: { kind: 'PROFORMA', orderNo: failed.orderNo }, status: 'FAILED', lastError: 'Client invalid' } });
  const job = await db.notificationOutbox.create({ data: { type: g.GLASS_FGO, orderId: pending.id, payload: { kind: 'PROFORMA', orderNo: pending.orderNo } } });
  const day = pastDay();
  await confirm(day, [{ order: deleted }, { order: failed }, { order: pending }, { order: active }]);
  const view = async () => (await billing(day)).customers.find((x) => x.customerId === c.id);
  let v = await view();
  // Kesilemeyip kalan istek kapsam değildir; duran belge ve kuyruktaki istek kapsamdır
  assert.deepEqual(v.groups.map((x) => x.orders.map((o) => o.orderNo)), [[failed.orderNo]]);
  assert.deepEqual(v.excluded.map((x) => [x.orderNo, x.reason, x.ref]), [[deleted.orderNo, 'ORDER_CHAIN', 'PRF9201'], [pending.orderNo, 'ORDER_CHAIN', null], [active.orderNo, 'ORDER_CHAIN', 'PRF9202']]);

  // Belge FGO'da silindi (kaydı kalkar) ve kuyruktaki istek kesilemeyip bırakıldı → kapsam serbest; duran belge hâlâ engel
  const fgo = fakeFgo(900);
  fgo.state.set('PRF9201', { gone: true });
  fgo.state.set('PRF9202', { total: 605, paid: 0 });
  assert.equal((await refresh(fgo)).ok, true);
  assert.equal(await db.fgoDocument.count({ where: { id: gone.id } }), 0);
  await db.notificationOutbox.update({ where: { id: job.id }, data: { status: 'FAILED', lastError: 'Client invalid' } });
  v = await view();
  assert.deepEqual(v.groups.map((x) => x.orders.map((o) => o.orderNo)), [[deleted.orderNo, failed.orderNo, pending.orderNo]], 'geçmişte belgesi / isteği olmuş olmak engel değil');
  assert.deepEqual(v.excluded.map((x) => [x.orderNo, x.ref]), [[active.orderNo, 'PRF9202']]);
  const r = await createInvoice(day, v.groups[0]);
  assert.deepEqual([r.ok, r.orders], [true, 3]);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  assert.deepEqual(names(fgo.calls[0]).map((n) => n.split(' — ')[0]), [deleted, failed, pending].map((o) => `Comanda ${o.orderNo}`));
  // Karşılıklı dışlama iki yönde: müşteri faturasına giren sipariş sipariş başına belge alamaz; kendi belgesi olan faturaya girmedi
  for (const o of [deleted, failed, pending]) assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, o.orderNo);
  assert.equal(await db.billingBatchOrder.count({ where: { orderId: active.id } }), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Sipariş seçimi (karar 125) ve "fatura bekliyor" uyarısı (karar 126)
// ---------------------------------------------------------------------------------------------------------------------
const no = (o) => o.orderNo;
const plus = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
/** Yükleme gününden k gün sonraki an (yerel gün = o gün) */
const on = (day, k) => new Date(`${plus(day, k)}T10:00:00Z`);

dbTest('sipariş seçimi — proforma: uygun siparişlerden seçilenlerle TEK belge; seçilmeyen sipariş olduğu gibi kalır; uygun olmayan / kapsanan / uyumsuz seçim sunucuda reddedilir', offline(async () => {
  const c = await customer('Select SRL', 'SEL');
  const stranger = await customer('Stranger SRL', 'STR');
  const [d1, d2] = [noon(30), noon(31)];
  const [s1, s2, s3] = [await order(c, { shipDate: d1 }), await order(c, { shipDate: d1, cnc: true }), await order(c, { shipDate: d2 })];
  const ron = await order(c, { shipDate: d1, currency: 'RON' }); // başka para birimi
  const held = await order(c, { shipDate: d1 });
  await db.order.update({ where: { id: held.id }, data: { onHold: true } }); // uygun değil
  const foreign = await order(stranger, { shipDate: d1 });
  const days = [dayKey(d1), dayKey(d2)];
  const pv = (orderIds) => b.previewBatch(db, { customerId: c.id, days, orderIds, bnrImpl: bnr('5.0000') });
  const make = (orderIds, key) => b.createBatch(db, { customerId: c.id, days, orderIds, key, actor: actor(), bnrImpl: bnr('5.0000') });

  // Seçim yok = uygun siparişlerin hepsi (eski davranış): karışık para birimi engeller
  const all = await pv(null);
  assert.deepEqual([all.included.map(no), all.unselected, all.excluded.map((o) => [o.orderNo, o.reason]), all.problems], [[s1, s2, s3, ron].map(no), [], [[held.orderNo, 'ON_HOLD']], ['MIXED_CURRENCY']]);

  // Seçim: s1 + s3 → yalnızca onlar hesaplanır; seçilmeyenler ayrı listede (hariç tutulmuş değil)
  const p = await pv([s3.id, s1.id]);
  assert.deepEqual([p.included.map(no), p.unselected.map(no), p.problems, p.currency, p.sourceTotal, p.ronNet, p.ronGross], [[s1, s3].map(no), [s2, ron].map(no), [], 'EUR', 200, 1000, 1210]);
  assert.notEqual(p.key, (await pv([s1.id])).key, 'parmak izi seçimi içerir');

  // Sunucu yetkili: uygun olmayan (beklemede), başka müşterinin, olmayan sipariş; boş seçim; uyumsuz para birimi
  for (const [ids, code] of [[[s1.id, held.id], 'NOT_ELIGIBLE'], [[s1.id, foreign.id], 'NOT_ELIGIBLE'], [[s1.id, 'yok'], 'NOT_ELIGIBLE'], [[], 'NOTHING_SELECTED'], [[s1.id, ron.id], 'MIXED_CURRENCY']]) {
    const bad = await pv(ids);
    assert.deepEqual(bad.problems, [code], code);
    assert.deepEqual(await make(ids, bad.key), { ok: false, code }, code);
  }
  // Önizlenen seçim ≠ gönderilen seçim: parti oluşturulmaz
  assert.deepEqual(await make([s1.id, s2.id, s3.id], p.key), { ok: false, code: 'STALE_PREVIEW' });
  for (const role of ['SATIS', 'MUSTERI', 'DENETIMCI']) assert.deepEqual(await b.createBatch(db, { customerId: c.id, days, orderIds: [s1.id, s3.id], key: p.key, actor: actor(role), bnrImpl: bnr('5.0000') }), { ok: false, code: 'FORBIDDEN' });
  assert.equal(await db.billingBatch.count({ where: { customerId: c.id } }), 0);

  // Parti ve FGO proforması yalnızca seçilen siparişlerden
  const r = await make([s1.id, s3.id], p.key);
  assert.equal(r.ok, true);
  const fgo = fakeFgo(1100);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  assert.equal(fgo.calls.length, 1);
  assert.deepEqual(names(fgo.calls[0]), [`Comanda ${s1.orderNo} — Sticlă securizată 10 mm`, `Comanda ${s3.orderNo} — Sticlă securizată 10 mm`]);
  assert.ok(![s2, ron, held, foreign].some((o) => JSON.stringify(fgo.calls[0]).includes(o.orderNo)), 'seçilmeyen siparişler belgede yok');
  const bt = await batchOf(r.batchId);
  assert.deepEqual([bt.orders.map(no), bt.sourceTotal.toString(), bt.ronNet.toString(), bt.lines.length, bt.status], [[s1, s3].map(no), '200', '1000', 2, 'ISSUED']);
  assert.deepEqual((await db.auditLog.findFirstOrThrow({ where: { action: 'BILLING_BATCH_CREATED', entityId: r.batchId } })).details.notSelected, [s2, ron].map(no));

  // Seçilmeyen sipariş değişmedi ve hâlâ uygun; partideki sipariş yeniden seçilemez (çift faturalama yok)
  assert.equal(b.coverageOf(await db.order.findUnique({ where: { id: s2.id }, include: { fgoDocuments: true, billingBatchOrders: true } })), null);
  const next = await pv(null);
  assert.deepEqual([next.included.map(no), next.excluded.filter((o) => o.reason === 'IN_BATCH').map(no)], [[s2, ron].map(no), [s1, s3].map(no)]);
  const dup = await pv([s1.id, s2.id]);
  assert.deepEqual(dup.problems, ['NOT_ELIGIBLE']);
  assert.deepEqual(await make([s1.id, s2.id], dup.key), { ok: false, code: 'NOT_ELIGIBLE' });
  // Kalan sipariş ayrı bir proformaya girer; belgenin günü yalnızca o siparişin günü
  const p2 = await pv([s2.id]);
  const r2 = await make([s2.id], p2.key);
  assert.equal(r2.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r2.batchId }));
  assert.equal(fgo.calls.length, 2);
  assert.deepEqual(names(fgo.calls[1]), [`Comanda ${s2.orderNo} — Sticlă securizată 10 mm`, `Comanda ${s2.orderNo} — Prelucrare CNC`]);
  assert.deepEqual((await batchOf(r2.batchId)).loadingDays.map((x) => x.toISOString().slice(0, 10)), [dayKey(d1)]);
  assert.equal(await db.billingBatchOrder.count({ where: { orderId: { in: [s1.id, s2.id, s3.id] }, activeKey: { not: null } } }), 3, 'her sipariş tek bir etkin partide');
}));

dbTest('sipariş seçimi — fatura: onaylı yüklemenin uygun siparişlerinden seçilenlerle fatura (yalnızca geçerli yüklenen adet); kalan sipariş aynı onaydan ayrı faturaya girer; grup dışı / faturalanmış seçim reddedilir', offline(async () => {
  const c = await customer('Pick SRL', 'PCK');
  const [o1, o2, o3] = [await order(c), await order(c, { cnc: true }), await order(c, { pieces: 10 })];
  const ron = await order(c, { currency: 'RON' }); // başka para birimi: ayrı fatura grubu
  const day = pastDay();
  const conf = await confirm(day, [{ order: o1 }, { order: o2 }, { order: o3, loaded: 8 }, { order: ron }]);
  const itemsBefore = JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { confirmationId: conf.id }, orderBy: { id: 'asc' } }));
  const eur = (r) => groupsOf(r, c).find((x) => x.currency === 'EUR');
  const ge = eur(await billing(day));
  assert.deepEqual([ge.orders.map(no), ge.unselected, ge.uniqueKey === ge.key], [[o1, o2, o3].map(no), [], true], 'seçim yok = grubun tamamı (eski davranış)');
  const sel = (ids) => billing(day, { select: { key: ge.key, orderIds: ids } }).then(eur);

  // Seçim: o1 + o3 — tutarlar yalnızca seçilenlerden; o3'te yalnızca yüklenen 8 adet
  const g13 = await sel([o3.id, o1.id]);
  assert.deepEqual([g13.orders.map(no), g13.unselected.map(no), g13.problems, g13.sourceTotal, g13.ronNet, g13.ronGross, g13.payable], [[o1, o3].map(no), [o2.orderNo], [], 500, 2500, 3025, 3025]);
  assert.deepEqual(g13.orders[1].lines.map((l) => [l.pieces, l.m2, l.amount]), [[8, 8, 400]]);
  assert.ok(g13.uniqueKey !== ge.key && g13.previewKey !== ge.previewKey && g13.key === ge.key);

  // Sunucu yetkili: grupta olmayan sipariş (başka para birimi / olmayan), boş seçim
  for (const [ids, code] of [[[o1.id, ron.id], 'NOT_ELIGIBLE'], [[o1.id, 'yok'], 'NOT_ELIGIBLE'], [[], 'NOTHING_SELECTED']]) {
    const bad = await sel(ids);
    assert.ok(bad.problems.includes(code), code);
    assert.deepEqual(await createInvoice(day, bad, { orderIds: ids }), { ok: false, code }, code);
  }
  // Önizlenen seçim ≠ gönderilen seçim: fatura oluşturulmaz
  assert.deepEqual(await createInvoice(day, g13, { orderIds: [o1.id, o2.id, o3.id] }), { ok: false, code: 'STALE_PREVIEW' });
  assert.deepEqual(await createInvoice(day, g13), { ok: false, code: 'STALE_PREVIEW' });
  for (const role of ['SATIS', 'MUSTERI', 'DENETIMCI']) assert.deepEqual(await createInvoice(day, g13, { orderIds: [o1.id, o3.id], actor: actor(role) }), { ok: false, code: 'FORBIDDEN' });
  assert.equal(await db.billingBatch.count({ where: { confirmationId: conf.id } }), 0);

  // Fatura yalnızca seçilenlerden
  const r1 = await createInvoice(day, g13, { orderIds: [o1.id, o3.id] });
  assert.equal(r1.ok, true);
  const fgo = fakeFgo(1200);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r1.batchId }));
  assert.deepEqual(names(fgo.calls[0]), [`Comanda ${o1.orderNo} — Sticla 10 mm`, `Comanda ${o3.orderNo} — Sticla 10 mm`]);
  assert.deepEqual([fgo.calls[0]['Continut[1][NrProduse]'], fgo.calls[0]['Continut[1][PretTotal]'], fgo.calls[0].IdExtern], ['8', '2420.00', `LOT-${r1.batchId}`]);
  assert.ok(![o2, ron].some((o) => JSON.stringify(fgo.calls[0]).includes(o.orderNo)));
  const b1 = await batchOf(r1.batchId);
  assert.deepEqual([b1.orders.map(no), b1.orders.map((o) => o.activeKey), b1.uniqueKey, b1.confirmationId, b1.status],
    [[o1, o3].map(no), [inv.invoiceOrderKey(conf.id, o1.id), inv.invoiceOrderKey(conf.id, o3.id)], g13.uniqueKey, conf.id, 'ISSUED']);

  // Seçilmeyen o2 olduğu gibi: aynı onaydan faturalanabilir. Faturalanmış sipariş yeniden seçilemez (kapsam iki kez faturalanmaz)
  const rest = eur(await billing(day));
  assert.deepEqual([rest.orders.map(no), rest.key === ge.key, rest.sourceTotal], [[o2.orderNo], true, 120]);
  const again = await sel([o1.id, o2.id]);
  assert.deepEqual(again.problems, ['NOT_ELIGIBLE']);
  assert.deepEqual(await createInvoice(day, again, { orderIds: [o1.id, o2.id] }), { ok: false, code: 'NOT_ELIGIBLE' });
  const r2 = await createInvoice(day, rest, { orderIds: [o2.id] });
  assert.equal(r2.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r2.batchId }));
  assert.equal(fgo.calls.length, 2);
  assert.deepEqual(names(fgo.calls[1]), [`Comanda ${o2.orderNo} — Sticla 10 mm`]);
  assert.equal(await db.billingBatch.count({ where: { confirmationId: conf.id, customerId: c.id, kind: 'INVOICE', status: 'ISSUED' } }), 2);
  assert.equal(await db.billingBatchOrder.count({ where: { orderId: { in: [o1.id, o2.id, o3.id] }, activeKey: { not: null } } }), 3, 'her siparişin bu onaydaki kapsamı tek faturada');
  // Öbür grup (RON) ve yükleme onayı etkilenmedi; kesilmiş belgeler değişmedi
  assert.deepEqual(groupsOf(await billing(day), c).map((x) => [x.currency, x.orders.map(no)]), [['RON', [ron.orderNo]]]);
  assert.equal(JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { confirmationId: conf.id }, orderBy: { id: 'asc' } })), itemsBefore);
  assert.deepEqual((await batchOf(r1.batchId)).lines.map((l) => l.ronGross.toString()), ['605', '2420']);
}));

dbTest('sipariş seçimi avans ve kur kurallarını aşmaz: zincirde avansı kesilmemiş tahsilat varken seçimle de fatura kesilmez; kur proformanın kuru; avans seçilen faturanın tutarı kadar düşülür, kalanı sonraki faturaya', offline(async () => {
  const c = await customer('Pick Chain SRL', 'PCH');
  const ship = noon(33);
  const [k1, k2] = [await order(c, { shipDate: ship }), await order(c, { shipDate: ship })];
  const fgo = fakeFgo(1300);
  const P = await proformaFor(c, [ship], fgo, '5.0000');
  const day = pastDay();
  await confirm(day, [{ order: k1 }, { order: k2 }]);
  const base = groupsOf(await billing(day, { bnrImpl: never('BNR') }), c)[0];
  assert.deepEqual([base.chainId, base.orders.map(no)], [P.id, [k1, k2].map(no)]);
  const pick = (ids) => billing(day, { select: { key: base.key, orderIds: ids }, bnrImpl: never('BNR') }).then((r) => groupsOf(r, c)[0]);

  // Proformaya 800 tahsilat, avans faturası yok: seçimle de fatura kesilemez
  await setPaid(fgo, P.document, 800);
  let g1 = await pick([k1.id]);
  assert.deepEqual([g1.orders.map(no), g1.problems, g1.fx.finalRate, g1.chain.advanceRequired], [[k1.orderNo], ['ADVANCE_REQUIRED'], '5.0000', 800]);
  assert.deepEqual(await createInvoice(day, g1, { orderIds: [k1.id] }), { ok: false, code: 'ADVANCE_REQUIRED' });
  const av = await inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor() });
  assert.equal(av.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: av.batchId }));

  // Avans kesildi: seçilen k1'in faturası — avans faturanın tutarını (605) aşmadan düşülür
  g1 = await pick([k1.id]);
  assert.deepEqual([g1.problems, g1.unselected.map(no), g1.ronGross, g1.storno.map((x) => x.gross), g1.payable], [[], [k2.orderNo], 605, [605], 0]);
  const i1 = await createInvoice(day, g1, { orderIds: [k1.id], bnrImpl: never('BNR') });
  assert.equal(i1.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i1.batchId }));
  const I1 = await batchOf(i1.batchId);
  assert.deepEqual([I1.parentId, I1.fxRate.toString(), I1.orders.map(no)], [P.id, P.fxRate.toString(), [k1.orderNo]], 'zincirin kur kaydı yeniden kullanılır');
  // Kalan k2: aynı zincirde, avansın kalanı (800 − 605 = 195) düşülür
  const g2 = groupsOf(await billing(day, { bnrImpl: never('BNR') }), c)[0];
  assert.deepEqual([g2.orders.map(no), g2.chainId, g2.storno.map((x) => x.gross), g2.payable], [[k2.orderNo], P.id, [195], 410]);
  const i2 = await createInvoice(day, g2, { orderIds: [k2.id], bnrImpl: never('BNR') });
  assert.equal(i2.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i2.batchId }));
  assert.deepEqual(groupsOf(await billing(day), c), []);
}));

dbTest('fatura bekliyor: ayar (varsayılan 6, 0–60); uyarı günü = "Yükleme yapıldı" kaydının günü + gün (burada yükleme günü kaydedildi); proforma ve avans kapatmaz, kuyruktaki fatura kapatmaz, yalnızca kesilmiş kapanış faturası kapatır', offline(async () => {
  // Ayar: varsayılan 6; kaydedilir (denetim kaydıyla); bozuk kayıt varsayılana düşer
  assert.deepEqual(await un.getAccountingSettings(db), { uninvoicedDays: 6 });
  await un.saveAccountingSettings(db, { uninvoicedDays: 3 }, actor());
  assert.deepEqual(await un.getAccountingSettings(db), { uninvoicedDays: 3 });
  assert.ok(await db.auditLog.findFirst({ where: { action: 'SETTINGS_UPDATE', entityId: un.ACCOUNTING_KEY } }));
  await db.integrationSetting.update({ where: { key: un.ACCOUNTING_KEY }, data: { value: { uninvoicedDays: 999 } } });
  assert.deepEqual(await un.getAccountingSettings(db), { uninvoicedDays: 6 });
  await un.saveAccountingSettings(db, { uninvoicedDays: 6 }, actor());

  const c = await customer('Remind SRL', 'RMD');
  const ship = noon(35); // planlanan gün ileride: uyarı PLANLANAN güne değil, onaylı yükleme gününe bakar
  const o1 = await order(c, { shipDate: ship });
  const fgo = fakeFgo(1400);
  const P = await proformaFor(c, [ship], fgo, '5.0000');
  const mine = async (now, days = undefined) => (await un.uninvoicedLoadings(db, { now, days })).filter((x) => x.customerId === c.id);
  assert.deepEqual(await mine(on(dayKey(ship), 30)), [], 'yükleme onaylanmadıysa uyarı yok (planlanan gün geçse de)');
  const d1 = pastDay();
  await confirm(d1, [{ order: o1 }]);

  // Uyarı gününden önce yok; uyarı gününde ve sonrasında var. Müşteri proforması (kesilmiş) uyarıyı kapatmaz
  assert.deepEqual(await mine(on(d1, 5)), []);
  assert.deepEqual((await mine(on(d1, 6))).map((r) => [r.orderNo, r.customerName, r.day, r.dueDay, r.daysSince, r.note, r.removed]), [[o1.orderNo, 'Remind SRL', d1, plus(d1, 6), 6, null, false]]);
  assert.deepEqual((await mine(on(d1, 9))).map((r) => r.daysSince), [9]);
  // Ayardaki gün sayısı: 0 = yükleme günü; 2 = iki gün sonra
  assert.deepEqual([(await mine(on(d1, 0), 0)).length, (await mine(on(d1, 1), 2)).length, (await mine(on(d1, 2), 2)).length], [1, 0, 1]);

  // Avans faturası (kesilmiş) uyarıyı kapatmaz
  await setPaid(fgo, P.document, 300);
  const av = await inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor() });
  assert.equal(av.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: av.batchId }));
  assert.equal((await batchOf(av.batchId)).document.kind, 'ADVANCE');
  assert.deepEqual((await mine(on(d1, 6))).map((r) => r.note), [null]);

  // Kuyruktaki fatura isteği kapatmaz; kesilen kapanış faturası kapatır
  const g1 = groupsOf(await billing(d1), c)[0];
  const i1 = await createInvoice(d1, g1);
  assert.equal(i1.ok, true);
  assert.deepEqual((await mine(on(d1, 6))).map((r) => r.note), ['INVOICE_QUEUED']);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: i1.batchId }));
  assert.equal((await batchOf(i1.batchId)).document.kind, 'INVOICE');
  assert.deepEqual(await mine(on(d1, 40)), [], 'kapanış faturası kesildi: uyarı kendiliğinden kalkar');
  const callsBefore = fgo.calls.length;
  await un.remindUninvoiced(db, { now: on(d1, 40) });
  assert.equal(fgo.calls.length, callsBefore, 'uyarı / bildirim FGO\'ya istek atmaz, belge kesmez');
}));

dbTest('fatura bekliyor: kısmi yüklemede yalnızca yüklenen kapsam; hiç yüklenmeyen, faturalanamayan (bedelsiz) kapsam uyarı üretmez; sipariş başına zincirde proforma / avans kapatmaz, fatura kapatır; silinmiş siparişin yüklenmiş camı da izlenir', offline(async () => {
  const c = await customer('Remind Part SRL', 'RMP');
  const partial = await order(c, { pieces: 10 }); // 8 yüklendi, 2 yüklenmedi
  const none = await order(c); // hiç yüklenmedi
  const free = await order(c); // bedelsiz: faturalanacak kalem yok
  await db.offerLine.updateMany({ where: { offer: { orderId: free.id } }, data: { free: true } });
  const own = await order(c); // sipariş başına belge zinciri
  const gone = await order(c); // yüklendikten sonra silinen sipariş
  const d = pastDay();
  await confirm(d, [{ order: partial, loaded: 8 }, { order: none, loaded: 0 }, { order: free }, { order: own }, { order: gone }]);
  const mine = async (k = 6) => (await un.uninvoicedLoadings(db, { now: on(d, k) })).filter((x) => x.customerId === c.id).map((r) => [r.orderNo, r.note, r.removed]);
  assert.deepEqual(await mine(5), []);
  assert.deepEqual(await mine(), [[partial.orderNo, null, false], [own.orderNo, null, false], [gone.orderNo, null, false]], 'yüklenmeyen ve bedelsiz kapsam için uyarı yok');

  // Sipariş başına zincir: proforma ve avans faturası kapatmaz (fatura sipariş sayfasından kesilecek); fatura kapatır
  await db.fgoDocument.create({ data: { orderId: own.id, kind: 'PROFORMA', series: 'PRF', number: '9801', issuedAt: new Date() } });
  assert.deepEqual((await mine()).find((r) => r[0] === own.orderNo), [own.orderNo, 'ORDER_CHAIN', false]);
  await db.fgoDocument.create({ data: { orderId: own.id, kind: 'ADVANCE', series: 'GKH', number: '9802', issuedAt: new Date() } });
  assert.deepEqual((await mine()).find((r) => r[0] === own.orderNo), [own.orderNo, 'ORDER_CHAIN', false]);
  await db.fgoDocument.create({ data: { orderId: own.id, kind: 'INVOICE', series: 'GKH', number: '9803', issuedAt: new Date() } });
  assert.equal((await mine()).find((r) => r[0] === own.orderNo), undefined);

  // Silinmiş sipariş (karar 110): yüklenmiş camı faturalanana kadar izlenir
  await db.order.update({ where: { id: gone.id }, data: { removedAt: new Date(), removedStatus: 'URETIMDE', status: 'IPTAL' } });
  assert.deepEqual((await mine()).find((r) => r[0] === gone.orderNo), [gone.orderNo, null, true]);

  // Kısmi yükleme: yüklenen 8 adet faturalanınca uyarı kapanır — yüklenmeyen 2 adet için uyarı doğmaz
  const fgo = fakeFgo(1500);
  const grp = groupsOf(await billing(d, { select: null }), c)[0];
  const picked = groupsOf(await billing(d, { select: { key: grp.key, orderIds: [partial.id] } }), c)[0];
  assert.deepEqual(picked.orders[0].lines.map((l) => l.pieces), [8]);
  const r = await createInvoice(d, picked, { orderIds: [partial.id] });
  assert.equal(r.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId }));
  assert.deepEqual(await mine(30), [[gone.orderNo, null, true]], 'faturalanan kapsam kalktı; yüklenmeyen 2 adet uyarı üretmedi; seçilmeyen sipariş bekliyor');
}));
