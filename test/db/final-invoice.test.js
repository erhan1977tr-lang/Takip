// Nihai fatura güvenliği (P1, karar 239) — veritabanıyla. Kendi proforması olan siparişin nihai faturası YALNIZCA onaylı
// yüklemeden (LoadingConfirmation, etkin LOADED kalemler) ve yalnızca o yüklemenin henüz faturalanmamış kapsamından kesilir;
// tarih + 2 gün kuralı ve ödeme durumu belirleyici değildir. Avans düşümü iki kez yapılmaz; tekrar / eşzamanlı istek tek
// belge üretir; proformanın ödeme kaydı değişmez; bedelsiz kalem faturalanmaz; proforma sonrası (fatura kesildikten sonra)
// gelen tahsilat yalnızca o siparişi durdurur (karar: otomatik avans / mahsup YOK, yönetici incelemesi).
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e, BNR de sahtedir; ağ koruması (offline) açıktır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { listDocuments, receivables } = await import('../../server/accounting/receivables.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const g = await import('../../server/glass/billing.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');
const un = await import('../../server/accounting/uninvoiced.js');
const { removeDeletedDocument } = await import('../../server/integrations/fgo-deleted.js');

const SECRET = 'p'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, seq = 700;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const evening = (key) => new Date(`${key}T16:00:00Z`);

/** Sahte FGO: emitere çağrıları sayılır; belge toplamı gönderilen satırlardan. Gerçek FGO adresine hiçbir şey gitmez. */
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const state = new Map();
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) {
      const doc = state.get(`${form.Serie}${form.Numar}`);
      return new Response(JSON.stringify({ Success: true, Factura: { Valoare: (doc ?? 0).toFixed(2), ValoareAchitata: '0.00' } }));
    }
    calls.push(form);
    n += 1;
    // Belge toplamı gönderilen satırlardan (TVA dahil): PretTotal varsa o, yoksa adet × birim fiyat × 1,21
    let total = 0;
    for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) {
      total += form[`Continut[${i}][PretTotal]`] != null
        ? Number(form[`Continut[${i}][PretTotal]`])
        : Math.round(Number(form[`Continut[${i}][NrProduse]`]) * Number(form[`Continut[${i}][PretUnitar]`]) * 121) / 100;
    }
    state.set(`${form.Serie}${n}`, Math.round(total * 100) / 100);
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const never = (name) => async () => { throw new Error(`${name} çağrılmamalıydı`); };
const bnr = (rate) => async () => ({ ok: true, rate, date: dayOf(0), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, bnrImpl: bnr('5.0000'), ...extra });
const lines = (form) => {
  const out = [];
  for (let i = 0; form[`Continut[${i}][Denumire]`] != null; i++) out.push([form[`Continut[${i}][Denumire]`], form[`Continut[${i}][PretTotal]`] ?? null, form[`Continut[${i}][NrProduse]`]]);
  return out;
};

const fgoOn = () => saveFgoSettings(db, {
  enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21,
}, { key: 'K', secret: SECRET }, actor());
const firm = (name, prefix) => db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@final.test`, taxId: '556677', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 3', fxPolicy: 'BNR' } });
/** 1 m²'lik cam: maliyet 30, müşteri fiyatı 50 EUR → kur 5 ile 250 RON net, 302,50 RON brüt / adet */
const glassLine = (adet, extra = {}) => ({ description: 'Temper', descriptionRo: 'Sticlă securizată', enMm: 1000, boyMm: 1000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '50', ...extra });
async function glassOrder(f, day, ls) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${f.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: at(day),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: ls.map((l, i) => ({ sortOrder: i, ...l })) } } },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
}
const lineKey = (o, i = 0) => `l:${o.offers[0].lines[i].id}`;
/** Gerçek yükleme onayı (confirmLoading): notLoaded = [{ order, quantity }] */
const confirm = async (day, notLoaded = []) => c.confirmLoading(db, {
  day, key: (await c.previewLoading(db, day)).key, notLoaded: notLoaded.map((x) => ({ key: lineKey(x.order), quantity: x.quantity, reason: 'NOT_READY' })), actor: actor(), now: evening(day),
});
/** Yüklenmeyen kalanın tamamı ileri güne */
async function replanAll(from, to) {
  for (const row of await rp.notLoadedOfDay(db, from)) assert.equal((await rp.replanNotLoaded(db, { itemId: row.itemId, day: to, actor: actor() })).ok, true);
}
const billing = (day) => inv.loadingBilling(db, { day, bnrImpl: bnr('5.0000') });
const groupOf = async (day, o) => {
  const r = await billing(day);
  if (!r.ok) return null;
  return r.customers.flatMap((x) => x.groups).find((x) => x.orders.some((y) => y.orderId === o.id)) ?? null;
};
const create = (day, grp, role = 'ADMIN') => inv.createInvoiceBatch(db, { day, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(role), bnrImpl: bnr('5.0000') });
async function issue(day, o, fgo) {
  const grp = await groupOf(day, o);
  assert.ok(grp, 'fatura grubu');
  assert.deepEqual(grp.problems, []);
  const r = await create(day, grp);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: r.batchId })), { done: 1, failed: 0 });
  return { grp, batch: await db.billingBatch.findUnique({ where: { id: r.batchId }, include: { document: true, lines: { orderBy: { sortOrder: 'asc' } } } }), form: fgo.calls.at(-1) };
}
/** Siparişin kendi proforması (gerçek istek + işçi, kur 5) */
async function ownProforma(o, fgo) {
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  return db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'PROFORMA' } });
}
/** Ödeme FGO'da görünür → avans faturası (gerçek istek + işçi) */
async function payAndAdvance(o, pf, paid, fgo) {
  await db.fgoDocument.update({ where: { id: pf.id }, data: { paid } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  return db.fgoDocument.findFirst({ where: { orderId: o.id, kind: 'ADVANCE' }, orderBy: { seq: 'desc' } });
}
const ref = (d) => `${d.series}${d.number}`;
const chainDocs = async (o) => (await listDocuments(db, 'GLASS_ORDER')).filter((d) => d.orderId === o.id || d.batch?.chainOrderId === o.id);
const glassJobs = (o) => db.notificationOutbox.count({ where: { orderId: o.id, type: g.GLASS_FGO } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@final.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await fgoOn();
});
after(closeDb);

dbTest('onay yoksa fatura yok (tarih + 2 gün kuralı yok); onaylı yükleme + sıfır tahsilat → fatura; tekrar ve eşzamanlı istek tek belge; bedelsiz kalem faturalanmaz; proforma ödeme kaydı değişmez', offline(async () => {
  const F = await firm('Final Zero SRL', 'FZR');
  const D = dayOf(60);
  // 2 adet ücretli + 1 adet bedelsiz telafi camı
  const o = await glassOrder(F, D, [glassLine(2), glassLine(1, { free: true, offerPrice: '0' })]);
  const fgo = fakeFgo(1000);
  const pf = await ownProforma(o, fgo);
  // Planlanan tarih geçmiş olsa bile onaysız fatura yok: sipariş düzeyinde istek kapalı, kuyruğa iş yazılmaz
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(Date.now() - 10 * 86_400_000) } });
  const jobs0 = await glassJobs(o);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(await glassJobs(o), jobs0);
  assert.equal((await billing(D)).code, 'NOT_CONFIRMED', 'onaysız günün faturalama kartı yok');
  assert.equal(g.billingState({ status: 'URETIMDE', loaded: false, docs: [pf], hasOffer: true }).actions.includes('invoice'), false);
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: at(D) } });

  // Onaylı yükleme, tahsilat sıfır → fatura kesilebilir (ödeme şart değil)
  assert.equal((await confirm(D)).ok, true);
  const grp = await groupOf(D, o);
  assert.deepEqual([grp.orderChainId, grp.chain.kind, grp.chain.ref, grp.chain.paid, grp.storno], [o.id, 'ORDER', ref(pf), 0, []]);
  assert.deepEqual(grp.orders[0].lines.map((l) => [l.pieces, l.gross]), [[2, 605]], 'bedelsiz kalem faturaya girmez');
  // Yetkisiz rol kesemez
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) assert.deepEqual(await create(D, grp, role), { ok: false, code: 'FORBIDDEN' }, role);
  for (const role of ['SATIS', 'MUSTERI', 'DENETIMCI']) assert.equal((await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor(role) })).ok, false, role);
  assert.equal(await db.billingBatch.count({ where: { chainOrderId: o.id } }), 0);

  // Eşzamanlı iki istek → tek parti
  const both = await Promise.all([create(D, grp), create(D, grp)]);
  assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both));
  assert.ok(['NOTHING_TO_INVOICE', 'ALREADY_INVOICED', 'STALE_PREVIEW'].includes(both.find((r) => !r.ok).code));
  assert.equal(await db.billingBatch.count({ where: { chainOrderId: o.id, kind: 'INVOICE' } }), 1);
  const id = both.find((r) => r.ok).batchId;
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: id })), { done: 1, failed: 0 });
  // Tekrar istek: kapsam faturalandı
  assert.equal((await create(D, grp)).ok, false);
  assert.equal(await groupOf(D, o), null, 'kapsam faturada: grup yok');
  const form = fgo.calls.at(-1);
  assert.equal(form.IdExtern, `LOT-${id}`);
  assert.equal(form.Serie, 'GKH');
  assert.equal(lines(form).length, 1);
  assert.match(lines(form)[0][0], new RegExp(`^Comanda ${o.orderNo} — `));
  assert.equal(lines(form)[0][1], '605.00');
  // Proformanın ödeme kaydı faturayla değişmez
  const pf2 = await db.fgoDocument.findUnique({ where: { id: pf.id } });
  assert.deepEqual([String(pf2.paid ?? 0), String(pf2.total)], [String(pf.paid ?? 0), String(pf.total)]);
  // Kesilen fatura sonrası sipariş düzeyi proforma da yok (onaylı yükleme var)
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' });
}));

dbTest('kısmi yükleme: yalnızca onaylanan adet; ikinci yükleme yalnızca kalan; avans iki faturaya bölünür ve iki kez düşülmez; borç tek zincir (1210)', offline(async () => {
  const F = await firm('Final Part SRL', 'FPT');
  const D1 = dayOf(70), D2 = dayOf(77);
  const o = await glassOrder(F, D1, [glassLine(4)]); // 4 × 302,50 = 1210 RON brüt
  const fgo = fakeFgo(2000);
  const pf = await ownProforma(o, fgo);
  assert.equal(String(pf.total), '1210');
  const adv = await payAndAdvance(o, pf, '1210.00', fgo);
  assert.equal(String(adv.total), '1210');

  // 1. yükleme: 3 / 4
  assert.equal((await confirm(D1, [{ order: o, quantity: 1 }])).ok, true);
  const first = await issue(D1, o, fgo);
  assert.deepEqual(first.grp.orders[0].lines.map((l) => [l.pieces, l.gross]), [[3, 907.5]]);
  assert.deepEqual(first.grp.storno.map((s) => [s.advanceDocId, s.ref, s.gross]), [[adv.id, ref(adv), 907.5]], 'avans faturanın değeriyle sınırlı');
  assert.equal(first.grp.payable, 0);
  assert.deepEqual(lines(first.form).map((l) => l[0].startsWith(`Comanda ${o.orderNo} — `) || l[0] === `Stornare avans conform factură ${ref(adv)}`), [true, true]);
  assert.equal(first.batch.chainOrderId, o.id);
  assert.equal(first.batch.lines.find((l) => l.refDocId)?.refDocId, adv.id);

  // 2. yükleme: kalan 1 adet; avansın kalanı (302,50) düşülür, fazlası değil
  await replanAll(D1, D2);
  assert.equal((await confirm(D2)).ok, true);
  const second = await issue(D2, o, fgo);
  assert.deepEqual(second.grp.orders[0].lines.map((l) => [l.pieces, l.gross]), [[1, 302.5]]);
  assert.deepEqual(second.grp.storno.map((s) => [s.advanceDocId, s.gross]), [[adv.id, 302.5]]);
  // Üçüncü bir istek yok: iki onayın kapsamı da faturalandı
  assert.equal(await groupOf(D1, o), null);
  assert.equal(await groupOf(D2, o), null);
  const used = await db.billingBatchLine.findMany({ where: { refDocId: adv.id, batch: { kind: 'INVOICE', status: { not: 'VOID' } } } });
  assert.equal(used.reduce((s, l) => s + Number(l.ronGross), 0), 1210, 'avans toplamda bir kez düşüldü');

  // Muhasebe: zincir tek borç (proforma + avans + iki fatura) — 1210, iki kez sayılan yok
  const rec = receivables(await chainDocs(o));
  assert.equal(rec.sums.RON.total, 1210);
  assert.equal(String((await db.fgoDocument.findUnique({ where: { id: pf.id } })).paid), '1210', 'proformanın tahsilat kaydı değişmez');
}));

dbTest('kısmi avans: ilk fatura avansın tamamını kullanmaz; kalan sonraki faturada; avansı kesilmemiş tahsilat varken fatura kesilmez (ADVANCE_REQUIRED)', offline(async () => {
  const F = await firm('Final Adv SRL', 'FAD');
  const D1 = dayOf(80), D2 = dayOf(87);
  const o = await glassOrder(F, D1, [glassLine(4)]);
  const fgo = fakeFgo(3000);
  const pf = await ownProforma(o, fgo);
  const adv = await payAndAdvance(o, pf, '605.00', fgo);
  // Avansı kesilmemiş yeni tahsilat → fatura beklemeli (önce avans)
  await db.fgoDocument.update({ where: { id: pf.id }, data: { paid: '700.00' } });
  assert.equal((await confirm(D1, [{ order: o, quantity: 1 }])).ok, true);
  let grp = await groupOf(D1, o);
  assert.deepEqual(grp.problems, ['ADVANCE_REQUIRED']);
  assert.deepEqual(await create(D1, grp), { ok: false, code: 'ADVANCE_REQUIRED' });
  await db.fgoDocument.update({ where: { id: pf.id }, data: { paid: '605.00' } });
  const first = await issue(D1, o, fgo);
  assert.deepEqual(first.grp.storno.map((s) => s.gross), [605], 'avans 605 < fatura 907,50');
  assert.equal(first.grp.payable, 302.5);
  await replanAll(D1, D2);
  assert.equal((await confirm(D2)).ok, true);
  grp = await groupOf(D2, o);
  assert.deepEqual([grp.storno, grp.payable], [[], 302.5], 'avans tükendi: ikinci kez düşülmez');
  assert.equal((await db.billingBatchLine.findMany({ where: { refDocId: adv.id } })).reduce((x, l) => x + Number(l.ronGross), 0), 605);
}));

dbTest('kur kaydı yoksa fatura kesilmez (CHAIN_RATE_MISSING); başka kura düşülmez, BNR istenmez', offline(async () => {
  const F = await firm('Final Rate SRL', 'FRT');
  const D = dayOf(90);
  const o = await glassOrder(F, D, [glassLine(2)]);
  await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: '9900', issuedAt: new Date(), total: '605.00', paid: '0' } });
  assert.equal((await confirm(D)).ok, true);
  const r = await inv.loadingBilling(db, { day: D, bnrImpl: never('BNR') });
  const grp = r.customers.flatMap((x) => x.groups).find((x) => x.orderChainId === o.id);
  assert.deepEqual(grp.problems, ['CHAIN_RATE_MISSING']);
  assert.deepEqual(await inv.createInvoiceBatch(db, { day: D, groupKey: grp.key, previewKey: grp.previewKey, actor: actor(), bnrImpl: never('BNR') }), { ok: false, code: 'CHAIN_RATE_MISSING' });
  assert.equal(await db.billingBatch.count({ where: { chainOrderId: o.id } }), 0);
}));

dbTest('birden çok sipariş proforması + kısmi yükleme; fatura sonrası gelen tahsilat yalnızca o siparişi durdurur (otomatik avans / mahsup yok), diğer siparişler faturalanır', offline(async () => {
  const F = await firm('Final Multi SRL', 'FML');
  const D1 = dayOf(100), D2 = dayOf(107);
  const a = await glassOrder(F, D1, [glassLine(4)]);
  const fgo = fakeFgo(4000);
  const pa = await ownProforma(a, fgo);
  // A: 3 / 4 yüklendi, tahsilat yok → fatura
  assert.equal((await confirm(D1, [{ order: a, quantity: 1 }])).ok, true);
  await issue(D1, a, fgo);
  // Fatura kesildikten SONRA A'nın proformasına tahsilat geldi
  await db.fgoDocument.update({ where: { id: pa.id }, data: { paid: '605.00' } });
  const jobs = await glassJobs(a);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: a.id, kind: 'ADVANCE', actor: actor() }), { ok: false, code: 'NOT_ALLOWED' }, 'otomatik avans yok');
  assert.equal(await glassJobs(a), jobs);
  const docsA = await db.fgoDocument.findMany({ where: { orderId: a.id } });
  assert.equal(g.billingState({ status: 'URETIMDE', loaded: true, docs: docsA, hasOffer: true, invoiced: true }).wait, 'payment_after_invoice');
  // Eski / dışarıdan yazılmış bir avans işi de FGO'ya gitmez
  await db.notificationOutbox.create({ data: { type: g.GLASS_FGO, orderId: a.id, payload: { kind: 'ADVANCE', orderNo: a.orderNo, seq: 1, amount: '605.00' } } });
  const before = fgo.calls.length;
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: a.id })), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, before, 'FGO\'ya istek yok');
  assert.equal(await db.fgoDocument.count({ where: { orderId: a.id, kind: 'ADVANCE' } }), 0);

  // D2: A'nın kalanı + B (kendi proforması, ödenmemiş) + C (proformasız, doğrudan)
  const bo = await glassOrder(F, D2, [glassLine(2)]);
  const pb = await ownProforma(bo, fgo);
  const co = await glassOrder(F, D2, [glassLine(1)]);
  await replanAll(D1, D2);
  assert.equal((await confirm(D2)).ok, true);
  const r = await billing(D2);
  const groups = r.customers.find((x) => x.customerId === F.id).groups;
  assert.equal(new Set(groups.map((x) => x.key)).size, 3, 'her sipariş zinciri ayrı grup');
  const ga = groups.find((x) => x.orderChainId === a.id);
  const gb = groups.find((x) => x.orderChainId === bo.id);
  const gc = groups.find((x) => x.orderChainId == null);
  assert.deepEqual(ga.problems, ['PAYMENT_AFTER_INVOICE']);
  assert.deepEqual([ga.orders[0].lines.map((l) => l.pieces), ga.storno], [[1], []], 'tahsilat önceki faturaya kendiliğinden mahsup edilmez');
  assert.deepEqual(await create(D2, ga), { ok: false, code: 'PAYMENT_AFTER_INVOICE' });
  assert.deepEqual([gb.problems, gb.chain.ref, gc.problems, gc.orders.map((x) => x.orderId)], [[], ref(pb), [], [co.id]]);
  assert.equal((await create(D2, gb)).ok, true, 'diğer siparişin faturası engellenmez');
  assert.equal((await create(D2, gc)).ok, true);
  assert.deepEqual(await b.dispatchBatchJobs(db, ctx(fgo)), { done: 2, failed: 0 });
  // Önceki kayıtlar değişmez
  assert.equal(String((await db.fgoDocument.findUnique({ where: { id: pa.id } })).paid), '605');
  assert.equal(await db.billingBatch.count({ where: { chainOrderId: a.id, kind: 'INVOICE' } }), 1);
}));

// ---- P7 (karar 248): sessizce yanlış / eksik faturalanabilecek üç durum görünür olur ----
const reminders = async (o, day) => (await un.uninvoicedLoadings(db, { now: at(dayOf(400)), days: 0 })).filter((x) => x.orderId === o.id && x.day === day).map((x) => x.note);
const excludedOf = async (day, o) => {
  const r = await billing(day);
  return r.customers.flatMap((x) => x.excluded).filter((x) => x.orderId === o.id).map((x) => x.reason);
};

dbTest('P7: avans kesilmiş siparişin proforması FGO\'da silinirse fatura zincirsiz (avanssız) kesilmez — CHAIN_ROOT_MISSING görünür ve hatırlatılır; BNR istenmez', offline(async () => {
  const F = await firm('Final Root SRL', 'FRO');
  const D = dayOf(120);
  const o = await glassOrder(F, D, [glassLine(2)]);
  const fgo = fakeFgo(5000);
  const pf = await ownProforma(o, fgo);
  const adv = await payAndAdvance(o, pf, '605.00', fgo);
  await removeDeletedDocument(db, pf, 'Factura nu exista');
  assert.equal(await db.fgoDocument.count({ where: { orderId: o.id, kind: 'PROFORMA' } }), 0);
  assert.equal(await db.fgoDocument.count({ where: { id: adv.id } }), 1, 'avans duruyor');
  assert.equal((await confirm(D)).ok, true);
  const r = await inv.loadingBilling(db, { day: D, bnrImpl: never('BNR') });
  assert.equal(r.customers.flatMap((x) => x.groups).some((x) => x.orders.some((y) => y.orderId === o.id)), false, 'zincirsiz grup yok');
  assert.deepEqual(await excludedOf(D, o), ['CHAIN_ROOT_MISSING']);
  assert.deepEqual(await reminders(o, D), ['CHAIN_ROOT_MISSING']);
  assert.equal(await db.billingBatch.count({ where: { kind: 'INVOICE', orders: { some: { orderId: o.id } } } }), 0);
}));

dbTest('P7: onayda cam yüklenmeyip yalnızca fiyatlı işlem / sandık kalemi yüklendiyse sessiz "kalem yok" değil — OPS_WITHOUT_GLASS görünür ve hatırlatılır', offline(async () => {
  const F = await firm('Final Ops SRL', 'FOP');
  const D = dayOf(130);
  const o = await glassOrder(F, D, [glassLine(2), { description: 'CNC', adet: 1, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' }]);
  const fgo = fakeFgo(6000);
  await ownProforma(o, fgo);
  assert.equal((await confirm(D, [{ order: o, quantity: 2 }])).ok, true, 'camın tamamı yüklenmedi; CNC yüklendi');
  assert.deepEqual(await excludedOf(D, o), ['OPS_WITHOUT_GLASS']);
  assert.deepEqual(await reminders(o, D), ['OPS_WITHOUT_GLASS']);
  // Fiyatsız / bedelsiz kalem için davranış aynen: NO_LINES, hatırlatma yok
  const F2 = await firm('Final Ops2 SRL', 'FOQ');
  const D2 = dayOf(131);
  const o2 = await glassOrder(F2, D2, [glassLine(2), { description: 'CNC', adet: 1, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '0', free: true }]);
  assert.equal((await confirm(D2, [{ order: o2, quantity: 2 }])).ok, true);
  assert.deepEqual(await excludedOf(D2, o2), ['NO_LINES']);
  assert.deepEqual(await reminders(o2, D2), []);
}));

dbTest('P7: zincirden fatura kesildikten sonra gelen tahsilat — kalan kapsamın hatırlatması "kesilebilir" değil PAYMENT_AFTER_INVOICE notuyla', offline(async () => {
  const F = await firm('Final Pai SRL', 'FPA');
  const D1 = dayOf(140), D2 = dayOf(147);
  const o = await glassOrder(F, D1, [glassLine(4)]);
  const fgo = fakeFgo(7000);
  const pf = await ownProforma(o, fgo);
  assert.equal((await confirm(D1, [{ order: o, quantity: 1 }])).ok, true);
  await issue(D1, o, fgo);
  await replanAll(D1, D2);
  assert.equal((await confirm(D2)).ok, true);
  assert.deepEqual(await reminders(o, D2), [null], 'tahsilat yokken kesilebilir');
  await db.fgoDocument.update({ where: { id: pf.id }, data: { paid: '605.00' } });
  assert.deepEqual(await reminders(o, D2), ['PAYMENT_AFTER_INVOICE']);
  assert.deepEqual(await reminders(o, D1), [], 'ilk onay faturalandı');
}));

dbTest('P7: deploy anında kuyrukta kalmış eski sipariş düzeyi kapanış faturası işi (daha önce denenmiş olsa da) FGO\'ya gitmeden kapanır; o sürede kapsam ORDER_PENDING', offline(async () => {
  const F = await firm('Final Legacy SRL', 'FLG');
  const D = dayOf(150);
  const o = await glassOrder(F, D, [glassLine(1)]);
  const fgo = fakeFgo(8000);
  await ownProforma(o, fgo);
  assert.equal((await confirm(D)).ok, true);
  const job = await db.notificationOutbox.create({ data: { type: g.GLASS_FGO, orderId: o.id, attempts: 1, availableAt: new Date(Date.now() - 60_000), payload: { kind: 'INVOICE', orderNo: o.orderNo } } });
  assert.deepEqual(await excludedOf(D, o), ['ORDER_PENDING']);
  const before = fgo.calls.length;
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, before, "FGO'ya istek yok");
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: job.id } })).status, 'FAILED');
  assert.equal(await db.fgoDocument.count({ where: { orderId: o.id, kind: 'INVOICE' } }), 0);
}));
