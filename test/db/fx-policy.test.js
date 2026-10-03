// Müşteri kur politikası (Aşama 7D-1) — veritabanıyla: politika kaydı, cam proformasında tek çözücü, kur kaydı (snapshot),
// elle kur, BT XML'in kullanılmaması, varsayılan politika.
// FGO'ya GERÇEK istek yapılmaz: bütün FGO çağrıları sahte fetchImpl'e gider; BNR ve BT de sahtedir (ağa çıkılmaz).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { saveDailyRate } = await import('../../server/fx/bt.js');
const { parseFxPolicy } = await import('../../server/fx/resolve.js');
const { writeAudit } = await import('../../server/orders/journal.js');
const { localDay } = await import('../../server/profile/dates.js');
const g = await import('../../server/glass/billing.js');

const SECRET = 'x'.repeat(40);
const TZ = 'Europe/Bucharest';
let db, admin, firm, seq = 100;
const actor = () => ({ id: admin.id, role: 'ADMIN', ip: '127.0.0.1' });
const today = () => localDay(new Date(), TZ);
const fgoOn = () => saveFgoSettings(db, {
  enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21,
}, { key: 'K', secret: SECRET }, actor());

/** Sahte FGO: yalnızca bu nesneye gelen istekler sayılır; gerçek FGO adresine hiçbir şey gitmez */
function fakeFgo(start) {
  let n = start;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '1210.00', ValoareAchitata: '0' } }));
    calls.push(form);
    n += 1;
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const never = (name) => async () => { throw new Error(`${name} çağrılmamalıydı`); };
const bnr = (rate, date = today()) => async ({ currency }) => (currency === 'EUR' ? { ok: true, rate, date, url: 'https://curs.bnr.ro/nbrfxrates.xml' } : { ok: false, error: 'yok' });
const ctx = (fgo, extra = {}) => ({ secret: SECRET, appUrl: 'https://t', timeZone: TZ, fetchImpl: fgo.fetchImpl, bnrImpl: never('BNR'), ...extra });

async function customer(name, prefix, data = {}) {
  return db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@fx.test`, taxId: '998877', county: 'Ilfov', city: 'Voluntari', address: 'Str. 1', ...data } });
}
/** 2 m² × 50 EUR = 100 EUR (müşteri fiyatı) */
async function glassOrder(c, shipDate = new Date(Date.now() + 10 * 86_400_000)) {
  seq += 1;
  return db.order.create({
    data: {
      orderNo: `${c.prefix}${seq}`, customerOrderNo: seq, title: 'Ușă', orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: shipDate,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
}
const billing = (o) => db.glassBilling.findUnique({ where: { orderId: o.id } });
const lastJob = (o) => db.notificationOutbox.findFirst({ where: { orderId: o.id, type: g.GLASS_FGO }, orderBy: { createdAt: 'desc' } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  admin = await db.user.create({ data: { email: 'admin@fx.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  firm = await customer('Glass and More', 'GLA');
});
after(closeDb);

dbTest('kur politikası kaydı: zorunlu, varsayılan BT; kaydet / değiştir; geçersiz yüzde ve politika veritabanına ulaşmaz', async () => {
  assert.equal(firm.fxPolicy, 'BT_UNIT_SELL', 'yeni müşteri: varsayılan politika BT (în unitățile BT)');
  assert.equal(firm.fxMarkupPercent, null);
  const save = async (raw) => {
    const r = parseFxPolicy(raw);
    return r.ok ? db.customer.update({ where: { id: firm.id }, data: r.data }) : r.code;
  };
  let c = await save({ policy: 'BNR_PLUS_PERCENT', percent: '2,5' });
  assert.deepEqual([c.fxPolicy, c.fxMarkupPercent.toString()], ['BNR_PLUS_PERCENT', '2.5']);
  c = await save({ policy: 'BNR', percent: '2,5' });
  assert.deepEqual([c.fxPolicy, c.fxMarkupPercent], ['BNR', null], 'yüzde yalnızca BNR + % ile saklanır');
  assert.equal(await save({ policy: 'BNR_PLUS_PERCENT', percent: '-1' }), 'BAD_PERCENT');
  assert.equal(await save({ policy: 'BNR_PLUS_PERCENT', percent: '99' }), 'BAD_PERCENT');
  assert.equal(await save({ policy: 'XML', percent: '' }), 'BAD_POLICY');
  await assert.rejects(db.customer.update({ where: { id: firm.id }, data: { fxPolicy: 'XML' } }), 'veritabanı da bilinmeyen politikayı kabul etmez (enum)');
  assert.equal(await save({ policy: '', percent: '' }), 'BAD_POLICY', 'politikasız müşteri olmaz');
  await assert.rejects(db.customer.update({ where: { id: firm.id }, data: { fxPolicy: null } }), 'veritabanı da boş politikayı kabul etmez');
  c = await save({ policy: 'BT_UNIT_SELL', percent: '' });
  assert.deepEqual([c.fxPolicy, c.fxMarkupPercent], ['BT_UNIT_SELL', null]);
});

dbTest('BNR + %2: proforma BNR × 1,02 ile kesilir; kur kaydı saklanır ve sonradan BNR / politika değişse de DEĞİŞMEZ', async () => {
  await fgoOn();
  const c = await customer('Bnr Plus SRL', 'BNP', { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' });
  const o = await glassOrder(c);
  const fgo = fakeFgo(700);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, bnrImpl: bnr('5.1000', '2026-10-02') })), { done: 1, failed: 0 });
  assert.equal(fgo.calls.length, 1);
  assert.equal(fgo.calls[0]['Continut[0][PretUnitar]'], '260.10', '50 EUR × 5,2020');
  const b = await billing(o);
  assert.deepEqual(
    [b.fxRate.toString(), b.fxSource, b.fxPolicy, b.fxCurrency, b.fxBaseRate.toString(), b.fxMarkupPercent.toString(), b.fxManual, b.fxSourceDate.toISOString().slice(0, 10)],
    ['5.202', 'BNR', 'BNR_PLUS_PERCENT', 'EUR', '5.1', '2', false, '2026-10-02'],
  );
  assert.ok(b.fxResolvedAt instanceof Date);
  assert.equal(b.fxDate.toISOString().slice(0, 10), today(), 'belge günü ayrı saklanır');
  const audit = await db.auditLog.findFirst({ where: { entityId: o.id, action: 'FGO_DOC_ISSUED' } });
  assert.deepEqual([audit.details.fxPolicy, audit.details.fxBaseRate, audit.details.fxMarkupPercent, audit.details.fxManual], ['BNR_PLUS_PERCENT', '5.1000', '2.000', false]);

  // Sonradan: BNR değişti, müşterinin politikası değişti, günün BT kuru girildi → avans ve fatura proformanın kuruyla
  await db.customer.update({ where: { id: c.id }, data: { fxPolicy: 'BT_UNIT_SELL', fxMarkupPercent: null } });
  await saveDailyRate(db, { day: today(), rate: 5.9 }, actor(), writeAudit);
  // Ödeme yalnızca FGO'dan okunur (karar 104): proformada tahsilat görünür
  await db.fgoDocument.updateMany({ where: { orderId: o.id, kind: 'PROFORMA' }, data: { paid: '314.72' } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'ADVANCE', actor: actor(), manualRate: '5,5000' }), { ok: true }, 'avans kuru belirlemez: elle kur yok sayılır');
  await g.dispatchGlassJobs(db, ctx(fgo, { bnrImpl: bnr('6.0000') }));
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(Date.now() - 3 * 86_400_000) } });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor(), manualRate: '5,5000' }), { ok: false, code: 'RATE_LOCKED' }, 'kur proformayla belirlendi: elle kurla değiştirilemez');
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o.id, kind: 'INVOICE', actor: actor() }), { ok: true });
  await g.dispatchGlassJobs(db, ctx(fgo, { bnrImpl: never('BNR (fatura kuru yeniden çözmez)') }));
  assert.equal(fgo.calls.length, 3);
  // Fatura: 2 m² × 50 EUR × 5,2020 = 520,20 + TVA %21 = 629,44
  assert.equal(fgo.calls[2]['Continut[0][PretTotal]'], '629.44', 'fatura proformanın kuruyla (5,2020), yeni BNR / BT ile değil');
  const b2 = await billing(o);
  for (const k of ['fxRate', 'fxSource', 'fxPolicy', 'fxCurrency', 'fxBaseRate', 'fxMarkupPercent', 'fxManual', 'fxSourceDate', 'fxResolvedAt', 'fxDate']) {
    assert.equal(String(b2[k]), String(b[k]), `kur kaydı değişmedi: ${k}`);
  }
});

dbTest('BNR: resmî kur olduğu gibi; BNR alınamazsa belge bekler ve günün BT kuruna sessizce düşülmez; yönetici elle kur girer (MANUAL)', async () => {
  await fgoOn();
  await saveDailyRate(db, { day: today(), rate: 5.9 }, actor(), writeAudit);
  const c = await customer('Bnr SRL', 'BNR', { fxPolicy: 'BNR' });
  const o = await glassOrder(c);
  const fgo = fakeFgo(800);
  await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() });
  const down = async () => ({ ok: false, error: 'HTTP 503' });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, bnrImpl: down })), { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, 0, 'kur yokken FGO\'ya hiçbir şey gönderilmez');
  const job = await lastJob(o);
  assert.equal(job.status, 'PENDING');
  assert.match(job.lastError, /BNR kuru alınamadı \(HTTP 503\)/);
  assert.equal(await billing(o), null);
  // BNR gelince aynı iş kesilir
  await db.notificationOutbox.update({ where: { id: job.id }, data: { availableAt: new Date(0) } });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, bnrImpl: bnr('5.0934') })), { done: 1, failed: 0 });
  assert.equal(fgo.calls[0]['Continut[0][PretUnitar]'], '254.67', '50 × 5,0934');
  const b = await billing(o);
  assert.deepEqual([b.fxRate.toString(), b.fxSource, b.fxPolicy, b.fxMarkupPercent, b.fxManual], ['5.0934', 'BNR', 'BNR', null, false]);

  // Elle kur: BNR hiç istenmez; kayıtta MANUAL ve fxManual
  const o2 = await glassOrder(c);
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o2.id, kind: 'PROFORMA', actor: actor(), manualRate: 'abc' }), { ok: false, code: 'BAD_RATE' });
  assert.deepEqual(await g.requestGlassDocument(db, { orderId: o2.id, kind: 'PROFORMA', actor: actor(), manualRate: '5,3000' }), { ok: true });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o2.id })), { done: 1, failed: 0 });
  assert.equal(fgo.calls[1]['Continut[0][PretUnitar]'], '265.00', '50 × 5,3000');
  const m = await billing(o2);
  assert.deepEqual([m.fxRate.toString(), m.fxSource, m.fxPolicy, m.fxBaseRate.toString(), m.fxMarkupPercent, m.fxManual], ['5.3', 'MANUAL', 'BNR', '5.3', null, true]);
  const req = await db.auditLog.findFirst({ where: { entityId: o2.id, action: 'FGO_DOC_REQUEST' } });
  assert.equal(req.details.manualRate, 5.3, 'elle kur isteği denetim kaydında');
});

dbTest('BT_UNIT_SELL: BT XML kuru kullanılmaz; günün BT kuru girilmeden belge bekler, girilince ELLE diye kesilir', async () => {
  await fgoOn();
  // Eskiden kalmış "otomatik BT adresi" ayarı kayıtta dursa bile hiçbir etkisi yok
  const row = await db.integrationSetting.findUnique({ where: { key: 'fgo' } });
  await db.integrationSetting.update({ where: { key: 'fgo' }, data: { value: { ...row.value, fxMode: 'auto', fxUrl: 'https://bt.example/exchange.xml' } } });
  await db.integrationSetting.deleteMany({ where: { key: 'fx.daily' } });
  const c = await customer('Bt Units SRL', 'BTU', { fxPolicy: 'BT_UNIT_SELL' });
  const o = await glassOrder(c);
  const fgo = fakeFgo(900);
  let xml = 0;
  const xmlRate = async () => { xml += 1; return { ok: true, rate: 5.325, source: 'https://bt.example/exchange.xml' }; };
  await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, rateImpl: xmlRate })), { done: 0, failed: 1 });
  assert.equal(xml, 0, 'BT XML hiç okunmadı');
  assert.equal(fgo.calls.length, 0);
  const job = await lastJob(o);
  assert.equal(job.status, 'PENDING');
  assert.match(job.lastError, /otomatik alınamıyor/);
  await saveDailyRate(db, { day: today(), rate: 5.4412 }, actor(), writeAudit);
  await db.notificationOutbox.update({ where: { id: job.id }, data: { availableAt: new Date(0) } });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id, rateImpl: xmlRate })), { done: 1, failed: 0 });
  assert.equal(xml, 0);
  assert.equal(fgo.calls[0]['Continut[0][PretUnitar]'], '272.06', '50 × 5,4412');
  const b = await billing(o);
  assert.deepEqual([b.fxRate.toString(), b.fxSource, b.fxPolicy, b.fxManual], ['5.4412', 'MANUAL_DAY', 'BT_UNIT_SELL', true]);
});

dbTest('varsayılan politika (BT): yeni müşterinin cam proforması günün BT kuruyla; BNR hiç istenmez', async () => {
  await fgoOn();
  const c = await customer('Default SRL', 'DEF');
  assert.equal(c.fxPolicy, 'BT_UNIT_SELL');
  const fgo = fakeFgo(950);
  await saveDailyRate(db, { day: today(), rate: 5 }, actor(), writeAudit);
  const o = await glassOrder(c);
  await g.requestGlassDocument(db, { orderId: o.id, kind: 'PROFORMA', actor: actor() });
  assert.deepEqual(await g.dispatchGlassJobs(db, ctx(fgo, { onlyOrderId: o.id })), { done: 1, failed: 0 });
  assert.equal(fgo.calls[0]['Continut[0][PretUnitar]'], '250.00');
  const b = await billing(o);
  assert.deepEqual([Number(b.fxRate), b.fxSource, b.fxPolicy, b.fxManual], [5, 'MANUAL_DAY', 'BT_UNIT_SELL', true]);
});

dbTest('günün BT kuru girilince kur bekleyen cam ve profil belgeleri hemen yeniden denenir', async () => {
  const later = new Date(Date.now() + 3_600_000);
  // Kur bekleyen iş: önceki denemesi hatayla bitmiş (lastError dolu) ve yeniden deneme zamanı ileride
  const a = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', status: 'PENDING', attempts: 1, lastError: 'Günün BT kuru girilmedi', availableAt: later, payload: { kind: 'PROFORMA' } } });
  const p = await db.notificationOutbox.create({ data: { type: 'FGO_PROFORMA', status: 'PENDING', attempts: 1, lastError: 'Günün BT kuru girilmedi', availableAt: later, payload: {} } });
  // O anda kesilmekte olan iş (işlem kirası: hata yazılmamış, availableAt ileride) öne alınmaz — 3.41.1
  const leased = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', status: 'PENDING', attempts: 1, availableAt: later, payload: { kind: 'PROFORMA' } } });
  await saveDailyRate(db, { day: today(), rate: 5.1 }, actor(), writeAudit);
  for (const id of [a.id, p.id]) assert.ok((await db.notificationOutbox.findUnique({ where: { id } })).availableAt <= new Date());
  assert.equal((await db.notificationOutbox.findUnique({ where: { id: leased.id } })).availableAt.getTime(), later.getTime());
  await db.notificationOutbox.deleteMany({ where: { id: { in: [a.id, p.id, leased.id] } } });
});
