// Müşteri proforması (Aşama 7D-2): veritabanı gerektirmeyen kurallar — çift faturalama denetimi, sipariş planı, belge metni.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeKeyOf, batchFgoLines, batchText, cleanDays, coverageOf, planOrder } from '../server/glass/batch.js';
import { billingState, proformaLines } from '../server/glass/billing.js';

const offer = (over = {}) => ({
  id: 'of1', status: 'GONDERILDI', currency: 'EUR',
  lines: [
    { id: 'l1', kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1500, adet: 2, offerPrice: '50', unitPrice: '30' },
    { id: 'l2', kind: 'CNC', unit: 'adet', description: 'CNC', adet: 3, offerPrice: '10', unitPrice: '5' },
    { id: 'l3', kind: 'CAM', unit: 'adet', description: 'Sandık', descriptionRo: 'Taxă ladă', adet: 1, offerPrice: '25', unitPrice: '20' },
    { id: 'l4', kind: 'CAM', unit: 'm2', description: 'Bedelsiz', descriptionRo: 'Gratuit', enMm: 500, boyMm: 500, adet: 1, offerPrice: '0', unitPrice: '10', free: true },
  ],
  ...over,
});
const order = (over = {}) => ({ id: 'o1', orderNo: 'ABC001', title: 'Ușă', status: 'URETIMDE', onHold: false, offers: [offer()], fgoDocuments: [], billingBatchOrders: [], ...over });

test('sipariş planı: satırlar sipariş proformasıyla aynı kuraldan; açıklama kaynak sipariş numarasıyla başlar; fabrika maliyeti yok', () => {
  const p = planOrder(order(), { day: '2026-10-16' });
  assert.equal(p.reason, null);
  assert.deepEqual(p.lines.map(({ name, unit, qty, price, amount }) => ({ name, unit, qty, price, amount })), [
    { name: 'Comanda ABC001 — Sticlă securizată 10 mm', unit: 'mp', qty: 3, price: 50, amount: 150 },
    { name: 'Comanda ABC001 — Prelucrare CNC', unit: 'buc', qty: 3, price: 10, amount: 30 },
    { name: 'Comanda ABC001 — Taxă ladă', unit: 'buc', qty: 1, price: 25, amount: 25 },
  ]);
  assert.equal(p.subtotal, 205);
  assert.deepEqual([p.day, p.offerId, p.currency], ['2026-10-16', 'of1', 'EUR']);
  // Aynı hesap: sipariş proformasının satırları (ad dışında) birebir
  assert.deepEqual(p.lines.map((l) => [l.unit, l.qty, l.price]), proformaLines(offer()).map((l) => [l.unit, l.qty, l.eur]));
  assert.ok(!JSON.stringify(p).includes('"30"') && !JSON.stringify(p).includes('unitPrice'), 'satış (fabrika) fiyatı kopyaya girmez');
});

test('sipariş planı: uygun olmayan sipariş nedeniyle dışarıda', () => {
  const r = (o, ctx = {}) => planOrder(o, { day: '2026-10-16', ...ctx }).reason;
  assert.equal(r(order({ status: 'IPTAL' })), 'CANCELLED');
  assert.equal(r(order({ onHold: true })), 'ON_HOLD');
  assert.equal(r(order(), { loaded: true }), 'ALREADY_LOADED');
  assert.equal(r(order({ offers: [offer({ status: 'YONETIMDE' })] })), 'NO_SENT_OFFER');
  assert.equal(r(order({ offers: [offer({ currency: 'USD' })] })), 'CURRENCY');
  assert.equal(r(order({ offers: [offer({ lines: [{ id: 'x', kind: 'CAM', unit: 'm2', description: 'A', enMm: 1000, boyMm: 1000, adet: 1, offerPrice: null }] })] })), 'NO_PRICES');
  assert.equal(r(order({ offers: [offer({ lines: [] })] })), 'NO_PRICES');
  // Müşteriye gönderilmiş teklif: en yeni GONDERILDI sürümü (sipariş proformasıyla aynı kural); üstündeki taslak sayılmaz
  const p = planOrder(order({ offers: [offer({ id: 'draft', status: 'YONETIMDE' }), offer({ id: 'sent' })] }), { day: '2026-10-16' });
  assert.deepEqual([p.reason, p.offerId], [null, 'sent']);
});

test('çift faturalama denetimi tek yerde: sipariş belgesi, kuyruktaki istek, etkin parti', () => {
  assert.equal(coverageOf(order()), null);
  assert.deepEqual(coverageOf(order({ fgoDocuments: [{ kind: 'PROFORMA', series: 'PRF', number: '12' }] })), { reason: 'ORDER_DOCUMENT', ref: 'PRF12' });
  assert.deepEqual(coverageOf(order(), true), { reason: 'ORDER_PENDING', ref: null });
  assert.deepEqual(coverageOf(order({ billingBatchOrders: [{ activeKey: activeKeyOf('o1'), batch: { document: { series: 'PRF', number: '77' } } }] })), { reason: 'IN_BATCH', ref: 'PRF77' });
  assert.deepEqual(coverageOf(order({ billingBatchOrders: [{ activeKey: activeKeyOf('o1'), batch: { document: null } }] })), { reason: 'IN_BATCH', ref: null }, 'kuyruktaki / kesilemeyen parti de tutar');
  assert.equal(coverageOf(order({ billingBatchOrders: [{ activeKey: null, batch: null }] })), null, 'geçersiz parti tutmaz');
  for (const o of [order({ fgoDocuments: [{ kind: 'INVOICE', series: 'GKH', number: '5' }] }), order({ billingBatchOrders: [{ activeKey: 'PROFORMA:o1' }] })]) {
    assert.ok(planOrder(o, { day: '2026-10-16' }).reason);
  }
  assert.equal(activeKeyOf('o1'), 'PROFORMA:o1');
  // Etkin partideki sipariş: sipariş başına hiçbir belge istenemez (yüklenmiş olsa da)
  for (const loaded of [false, true]) {
    assert.deepEqual(billingState({ status: 'URETIMDE', loaded, docs: [], pending: [], hasOffer: true, inBatch: true }), { actions: [], wait: 'batch', paid: 0, manualRon: 0, advanced: 0, advanceRequired: 0, basis: 'FGO', match: 'NONE' });
  }
  assert.deepEqual(billingState({ status: 'URETIMDE', loaded: false, docs: [], pending: [], hasOffer: true }).actions, ['proforma'], 'parti dışındaki sipariş: eski akış');
});

test('seçilen günler ve belge metni', () => {
  assert.deepEqual(cleanDays(['2026-10-23', '2026-10-16', '2026-10-23', 'x', '', null]), ['2026-10-16', '2026-10-23']);
  assert.deepEqual(cleanDays('2026-10-16'), ['2026-10-16']);
  assert.deepEqual(cleanDays(undefined), []);
  const d = (x) => new Date(`${x}T00:00:00Z`);
  assert.equal(batchText({ orders: [{ orderNo: 'ABC001' }], loadingDays: [d('2026-10-16')] }), 'Comanda: ABC001. Încărcare planificată: 16.10.2026.');
  assert.equal(
    batchText({ orders: [{ orderNo: 'ABC001' }, { orderNo: 'ABC002' }, { orderNo: 'ABC004' }], loadingDays: [d('2026-10-16'), d('2026-10-23')] }),
    'Comenzi: ABC001, ABC002, ABC004. Încărcări planificate: 16.10.2026, 23.10.2026.',
  );
  // Kayıtlı satırlar (Decimal) → FGO satırları
  assert.deepEqual(batchFgoLines({ lines: [{ name: 'Comanda ABC001 — X', unit: 'mp', quantity: { toString: () => '2.5' }, unitPrice: { toString: () => '50' } }] }), [{ code: '', name: 'Comanda ABC001 — X', unit: 'mp', qty: 2.5, eur: 50 }]);
});
