// Müşteri proformasına FGO tahsilatından OTOMATİK avans faturası (karar 326) — veritabanıyla.
// FGO'ya GERÇEK istek yapılmaz (sahte fetchImpl); BNR de sahtedir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { dayKey } = await import('../../server/orders/loading.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');
const auto = await import('../../server/glass/auto-advance.js');
const f = await import('../../server/finance/service.js');

const SECRET = 'a'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, seq = 0;
const actor = (role = 'ADMIN') => ({ id: admin.id, role, ip: '127.0.0.1' });
const noon = (offset) => new Date(`${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
const today = () => new Date().toISOString().slice(0, 10);

function fakeFgo(start) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '0', ValoareAchitata: '0' } }));
    calls.push(form);
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const bnr = (rate) => async () => ({ ok: true, rate, date: dayKey(new Date()), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, sleep: async () => {}, ...extra });
const fgoSettings = (enabled) => saveFgoSettings(db, { enabled, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor());

async function customer(name, prefix) {
  return db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@auto.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', fxPolicy: 'BNR' } });
}
async function order(c, shipDate) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: String(seq), title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}
/** Kesilmiş müşteri proforması (kur 5,0000; 2 m² × 50 EUR → 605 RON TVA dahil) */
async function proforma(c, fgo) {
  const ship = noon(9 + seq);
  const o = await order(c, ship);
  const days = [dayKey(ship)];
  const pv = await b.previewBatch(db, { customerId: c.id, days, bnrImpl: bnr('5.0000') });
  const pr = await b.createBatch(db, { customerId: c.id, days, key: pv.key, actor: actor(), bnrImpl: bnr('5.0000') });
  assert.equal(pr.ok, true);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: pr.batchId }));
  const P = await db.billingBatch.findUnique({ where: { id: pr.batchId }, include: { document: true } });
  return { P, o };
}
const setPaid = (doc, paid) => db.fgoDocument.update({ where: { id: doc.id }, data: { paid: paid.toFixed(2) } });
const advancesOf = (P) => db.billingBatch.findMany({ where: { parentId: P.id, kind: 'ADVANCE' }, include: { lines: true, document: true }, orderBy: { createdAt: 'asc' } });
const holds = () => db.notification.findMany({ where: { type: 'ADVANCE_AUTO_HELD' } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@auto.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  await fgoSettings(true);
});
after(closeDb);

dbTest('FGO tahsilatı → otomatik avans partisi (tutar = tahsilat), FGO\'da kesilir; ikinci tur ikinci avans açmaz; kullanıcı yok, rol SYSTEM', offline(async () => {
  const fgo = fakeFgo(100);
  const c = await customer('Auto SRL', 'AUT');
  const { P, o } = await proforma(c, fgo);
  // Tahsilat yok → aday değil
  assert.deepEqual(await advancesOf(P), []);
  await setPaid(P.document, 300);
  const r = await auto.autoAdvanceTick(db);
  assert.equal(r.issued, 1);
  const [A] = await advancesOf(P);
  assert.deepEqual([A.status, A.basis, A.createdById, A.lines[0].ronGross.toString(), A.lines[0].name], ['PENDING', 'FGO', P.createdById, '300', `Avans marfă conform proformă ${P.document.series}${P.document.number}`]);
  const audit = await db.auditLog.findFirst({ where: { action: 'BILLING_BATCH_CREATED', entityId: A.id } });
  assert.deepEqual([audit.userId, audit.actorRole, audit.details.auto, audit.details.amountRon], [null, 'SYSTEM', true, 300]);
  const ev = await db.orderEvent.findFirst({ where: { orderId: o.id, event: 'FGO_DOC_REQUESTED', note: { startsWith: 'ADVANCE' } } });
  assert.equal(ev.userId, null);
  // Belge mevcut parti işçisiyle FGO'da kesilir (TVA dahil toplam, karar 288)
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: A.id }));
  const sent = fgo.calls.at(-1);
  assert.deepEqual([sent.Serie, sent['Continut[0][PretTotal]'], sent.IdExtern], ['GKH', '300.00', `LOT-${A.id}`]);
  assert.equal((await db.billingBatch.findUnique({ where: { id: A.id } })).status, 'ISSUED');
  // Tekrar: avanslanacak tutar yok
  const r2 = await auto.autoAdvanceTick(db);
  assert.equal(r2.issued, 0);
  assert.equal((await advancesOf(P)).length, 1);
  // Ek tahsilat (farklı tutar) → ikinci avans yalnızca farkı kadar
  await setPaid(P.document, 500);
  assert.equal((await auto.autoAdvanceTick(db)).issued, 1);
  assert.deepEqual((await advancesOf(P)).map((a) => a.lines[0].ronGross.toString()), ['300', '200']);
}));

dbTest('kuyruktaki avans varken tur beklemede kalır; düğmeyle eşzamanlı istek tek avans açar', offline(async () => {
  const fgo = fakeFgo(200);
  const c = await customer('Race SRL', 'RAC');
  const { P } = await proforma(c, fgo);
  await setPaid(P.document, 250);
  const [x, y] = await Promise.all([auto.autoAdvanceTick(db), inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor() })]);
  assert.equal(x.issued + (y.ok ? 1 : 0), 1, 'tek avans partisi');
  assert.equal((await advancesOf(P)).length, 1);
  // Avans henüz kesilmedi (PENDING): yeni tahsilat gelse de tur yeni avans açmaz
  await setPaid(P.document, 400);
  assert.equal((await auto.autoAdvanceTick(db)).issued, 0);
  assert.equal((await advancesOf(P)).length, 1);
}));

dbTest('elle kayda dayanan tahsilat otomatik avans doğurmaz (yöneticinin düğmesi); FGO kapalıyken tur hiçbir şey yapmaz', offline(async () => {
  const fgo = fakeFgo(300);
  const c = await customer('Manual SRL', 'MAN');
  const { P, o } = await proforma(c, fgo);
  const m = await f.recordManualPayment(db, { orderId: o.id, input: { paidOn: today(), amount: '150', currency: 'RON', method: 'BANK_TRANSFER' }, requestKey: 'k'.repeat(20) + 'manual01', actor: actor() });
  assert.equal(m.ok, true);
  // Belgede FGO tahsilatı 0 → aday bile değil
  assert.equal((await auto.autoAdvanceTick(db)).issued, 0);
  // FGO 100 gösteriyor, elle 150 → dayanak elle kayıt (MANUAL) → kesilmez
  await setPaid(P.document, 100);
  assert.deepEqual(await inv.autoAdvanceBatch(db, { proformaBatchId: P.id }), { ok: false, code: 'MANUAL_BASIS' });
  assert.deepEqual(await advancesOf(P), []);
  // Yöneticinin düğmesi aynı zinciri kesebilir (değişmedi)
  // FGO kapalı → tur durur
  await fgoSettings(false);
  try {
    await setPaid(P.document, 150);
    const r = await auto.autoAdvanceTick(db);
    assert.deepEqual([r.issued, r.stopped], [0, 'FGO_DISABLED']);
    assert.deepEqual(await advancesOf(P), []);
  } finally {
    await fgoSettings(true);
  }
  // FGO açık, FGO 150 = elle 150 → FGO_MANUAL → otomatik kesilir
  assert.equal((await auto.autoAdvanceTick(db)).issued, 1);
  const [A] = await advancesOf(P);
  assert.deepEqual([A.basis, A.lines[0].ronGross.toString()], ['FGO_MANUAL', '150']);
}));

dbTest('aynı müşteride aynı tutar → KESİLMEZ, muhasebeye bir bildirim; yönetici onaylayınca düğmeyle kesilir', offline(async () => {
  const fgo = fakeFgo(400);
  const c = await customer('Dup SRL', 'DUP');
  const { P } = await proforma(c, fgo);
  await setPaid(P.document, 200);
  assert.equal((await auto.autoAdvanceTick(db)).issued, 1);
  const [A] = await advancesOf(P);
  await b.dispatchBatchJobs(db, ctx(fgo, { onlyBatchId: A.id }));
  // İkinci tahsilat da 200 → aynı müşteride aynı tutarlı avans var: otomatik kesim durur
  await setPaid(P.document, 400);
  const r = await auto.autoAdvanceTick(db);
  assert.deepEqual([r.issued, r.held], [0, 1]);
  assert.equal((await advancesOf(P)).length, 1);
  const n1 = await holds();
  assert.equal(n1.length, 1, 'muhasebe (yönetici) kullanıcısına bir bildirim');
  assert.equal(n1[0].userId, admin.id);
  assert.match(n1[0].link, /\/admin\/muhasebe\/cam\/proforma\?musteri=/);
  // Sonraki tur aynı bildirimi yinelemez
  await auto.autoAdvanceTick(db);
  assert.equal((await holds()).length, 1);
  // Yönetici gördüğü eşleşmeleri onaylar → mevcut düğme keser
  const ask = await inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor() });
  assert.equal(ask.code, 'DUPLICATE_RISK');
  const ok = await inv.createAdvanceBatch(db, { proformaBatchId: P.id, actor: actor(), ack: ask.ackKey });
  assert.deepEqual([ok.ok, ok.amount], [true, 200]);
  assert.equal((await advancesOf(P)).length, 2);
}));

dbTest('sipariş başına proformalar adaya girmez (yalnızca müşteri proforması partileri)', offline(async () => {
  const list = await auto.autoAdvanceCandidates(db);
  const kinds = await db.billingBatch.findMany({ where: { id: { in: list.map((x) => x.id) } }, select: { kind: true, status: true } });
  assert.ok(kinds.every((k) => k.kind === 'PROFORMA' && k.status === 'ISSUED'));
}));
