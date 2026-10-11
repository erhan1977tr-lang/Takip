// Müşteri belge zinciri (Aşama 7D-3, karar 101): Cam Tahsilat'ta tek ticari borç, parti satırlarının FGO'ya gidişi ve
// belge açıklaması. Saf kurallar — veritabanı ve FGO yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import { receivables, unitOf } from '../server/accounting/receivables.js';
import { batchDocText, batchFgoLines, batchText, invoiceLineName } from '../server/glass/batch.js';
import { emitereForm } from '../server/integrations/fgo.js';
import { invoiceKeyOf, invoiceOrderKey } from '../server/glass/invoice-batch.js';

let n = 0;
const doc = (kind, total, paid, batch) => ({ id: `d${(n += 1)}`, orderId: null, batchId: batch.id, kind, currency: 'RON', total, paid, batch });
const proforma = (total, paid) => doc('PROFORMA', total, paid, { id: 'P', parentId: null, lines: [] });
const advance = (total, paid, id = 'A') => doc('ADVANCE', total, paid, { id, parentId: 'P', lines: [{ ronGross: total, refBatchId: null }] });
/** Fatura: mal bedeli (TVA dahil) ve düştüğü avans */
const invoice = (goods, offset, paid, id = 'I') => doc('INVOICE', goods - offset, paid, {
  id, parentId: 'P', lines: [{ ronGross: goods, refBatchId: null }, ...(offset ? [{ ronGross: offset, refBatchId: 'A' }] : [])],
});
const direct = (total, paid) => doc('INVOICE', total, paid, { id: 'D', parentId: null, lines: [{ ronGross: total, refBatchId: null }] });

test('zincir tek borç birimidir: proforma, avansı ve faturaları aynı birimde; doğrudan fatura kendi birimi', () => {
  const p = proforma(1000, 0);
  assert.equal(unitOf(p), 'batch:P');
  assert.equal(unitOf(advance(300, 300)), 'batch:P');
  assert.equal(unitOf(invoice(1000, 0, 0)), 'batch:P');
  assert.equal(unitOf(direct(500, 0)), 'batch:D');
  assert.equal(unitOf({ orderId: 'o1', batchId: null }), 'o1');
});

test('A — yalnızca proforma: borç proformanın kendisi', () => {
  assert.deepEqual(receivables([proforma(1000, 0)]).sums, { RON: { total: 1000, paid: 0, rest: 1000 } });
  // Kısmi tahsilat (avans faturası henüz kesilmemiş): ne ödenmemiş ne tam ödenmiş
  assert.deepEqual(receivables([proforma(1000, 400)]).sums, { RON: { total: 1000, paid: 400, rest: 600 } });
});

test('B — proforma + avans faturası: avansın tutarı iki kez sayılmaz', () => {
  const p = proforma(1000, 300);
  const a = advance(300, 300);
  const r = receivables([p, a]);
  assert.deepEqual(r.sums, { RON: { total: 1000, paid: 300, rest: 700 } });
  assert.deepEqual(r.shares.get(p.id), { debt: 700, rest: 700, replaced: false });
  assert.deepEqual(r.shares.get(a.id), { debt: 300, rest: 0, replaced: false });
});

test('C — proforma + avans + fatura (avans düşülmüş): yine tek borç; fatura belirleyicidir, proforma yerine geçilmiştir', () => {
  const p = proforma(1000, 300);
  const a = advance(300, 300);
  const i = invoice(1000, 300, 0);
  const r = receivables([p, a, i]);
  assert.deepEqual(r.sums, { RON: { total: 1000, paid: 300, rest: 700 } });
  assert.deepEqual(r.shares.get(p.id), { debt: 0, rest: 0, replaced: true });
  assert.deepEqual(r.shares.get(i.id), { debt: 700, rest: 700, replaced: false });
});

test('D — proformasız doğrudan fatura: borç faturadır', () => {
  assert.deepEqual(receivables([direct(500, 200)]).sums, { RON: { total: 500, paid: 200, rest: 300 } });
});

test('birden çok yüklemeyi kapsayan proforma: faturalanan kısım faturada, kalan kapsam proformada — toplam değişmez', () => {
  // Proforma 1000 (iki yükleme: 400 + 600), tahsilat 300 → avans 300; ilk yükleme (400) faturalandı, avans 300 düşüldü
  const p = proforma(1000, 300);
  const a = advance(300, 300);
  const i = invoice(400, 300, 0);
  const r = receivables([p, a, i]);
  assert.deepEqual(r.shares.get(p.id), { debt: 600, rest: 600, replaced: false }, 'proforma yalnızca henüz faturalanmamış kapsam');
  assert.deepEqual(r.sums, { RON: { total: 1000, paid: 300, rest: 700 } });
  // Avans ilk faturadan büyükse kalanı sonraki faturaya kalır: proformanın payı o kadar azalır
  const p2 = proforma(1000, 500);
  const a2 = advance(500, 500);
  const i2 = invoice(400, 400, 0);
  const r2 = receivables([p2, a2, i2]);
  assert.deepEqual(r2.shares.get(p2.id), { debt: 500, rest: 500, replaced: false }, '600 kalan kapsam − 100 henüz düşülmemiş avans');
  assert.deepEqual(r2.sums, { RON: { total: 1000, paid: 500, rest: 500 } });
  // Avansı kesilmemiş yeni tahsilat (proformada 700 görünüyor, avans 500): kalan o kadar azalır, borç değişmez
  const r3 = receivables([proforma(1000, 700), advance(500, 500), invoice(400, 400, 0)]);
  assert.deepEqual(r3.sums, { RON: { total: 1000, paid: 700, rest: 300 } });
});

test('sipariş başına zincir ve müşteri zinciri birbirine karışmaz; para birimleri ayrı toplanır', () => {
  const own = [{ id: 'x1', orderId: 'o1', kind: 'PROFORMA', currency: 'RON', total: 200, paid: 0 }, { id: 'x2', orderId: 'o1', kind: 'INVOICE', currency: 'RON', total: 200, paid: 50 }];
  const eur = { ...direct(90, 0), id: 'e1', batchId: 'E', currency: 'EUR', batch: { id: 'E', parentId: null, lines: [] } };
  const r = receivables([...own, proforma(1000, 0), eur]);
  assert.deepEqual(r.sums, { RON: { total: 1200, paid: 50, rest: 1150 }, EUR: { total: 90, paid: 0, rest: 90 } });
});

test('parti satırları FGO\'ya kayıttaki gibi gider: proforma kaynak fiyatla, fatura TVA dahil toplamla, avans ve düşüm RON birim fiyatla', () => {
  const lines = batchFgoLines({ lines: [
    { name: 'Comanda A1 — Sticlă', unit: 'mp', quantity: '2', unitPrice: '50.00', ronUnit: null, ronNet: null, ronGross: null },
    { name: 'Comanda A1 — Sticlă', unit: 'mp', quantity: '2', unitPrice: null, ronUnit: null, ronNet: '600.00', ronGross: '726.00' },
    { name: 'Avans marfă conform proformă PRF1', unit: 'buc', quantity: '1', unitPrice: null, ronUnit: '495.87', ronNet: '495.87', ronGross: '600.00' },
    { name: 'Stornare avans conform factură GKH2', unit: 'buc', quantity: '-1', unitPrice: null, ronUnit: '495.87', ronNet: '-495.87', ronGross: '600.00' },
  ] });
  assert.deepEqual(lines, [
    { code: '', name: 'Comanda A1 — Sticlă', unit: 'mp', qty: 2, eur: 50 },
    { code: '', name: 'Comanda A1 — Sticlă', unit: 'mp', qty: 2, net: 600, gross: 726 },
    { code: '', name: 'Avans marfă conform proformă PRF1', unit: 'buc', qty: 1, ron: 495.87 },
    { code: '', name: 'Stornare avans conform factură GKH2', unit: 'buc', qty: -1, ron: 495.87 },
  ]);
});

test('belge açıklaması: kaynak siparişler; faturada onaylı yükleme günü, proformada planlanan günler; kur cümlesi yok', () => {
  const orders = [{ orderNo: 'ABC001' }, { orderNo: 'ABC002' }];
  const day = new Date('2026-10-23T00:00:00Z');
  assert.equal(batchText({ kind: 'INVOICE', orders, confirmation: { shipDay: day }, loadingDays: [day] }), 'Comenzi: ABC001, ABC002. Încărcare confirmată: 23.10.2026.');
  assert.equal(batchText({ kind: 'INVOICE', orders: [orders[0]], confirmation: { shipDay: day }, loadingDays: [day] }), 'Comanda: ABC001. Încărcare confirmată: 23.10.2026.');
  assert.equal(batchText({ kind: 'ADVANCE', orders, loadingDays: [day] }), 'Comenzi: ABC001, ABC002.');
  assert.equal(batchText({ kind: 'PROFORMA', orders, loadingDays: [day] }), 'Comenzi: ABC001, ABC002. Încărcare planificată: 23.10.2026.');
  for (const kind of ['INVOICE', 'ADVANCE', 'PROFORMA']) assert.doesNotMatch(batchText({ kind, orders, confirmation: { shipDay: day }, loadingDays: [day] }), /curs|RON|%/i);
});

test('nihai fatura (karar 252): kalemde sipariş numarası yok (ad öneki ve açıklama); alt metin yalnızca kayıtlı kurun cümlesi; proforma değişmez', () => {
  const orders = [{ orderId: 'o1', orderNo: 'ACU1' }, { orderId: 'o2', orderNo: 'ACU2' }];
  const day = new Date('2026-10-05T00:00:00Z');
  const lines = [
    { orderId: 'o1', name: 'Comanda ACU1 — Sticla 8.3.8. GRI+GRI', unit: 'mp', quantity: '295.41', unitPrice: null, ronUnit: null, ronNet: '127617.10', ronGross: '154416.69' },
    { orderId: 'o2', name: 'Comanda ACU2 — Sticla 10 mm', unit: 'mp', quantity: '2', unitPrice: null, ronUnit: null, ronNet: '600.00', ronGross: '726.00' },
    { orderId: 'o1', name: 'Stornare avans conform factură GKH699', unit: 'buc', quantity: '-1', unitPrice: null, ronUnit: '44972.47', ronNet: '-44972.47', ronGross: '54416.69' },
  ];
  const fx = { currency: 'EUR', fxRate: '6.0000', fxSource: 'MANUAL', fxPolicy: 'BT_UNIT_SELL', fxDate: day, fxSourceDate: day };
  const invoice = { kind: 'INVOICE', orders, lines, confirmation: { shipDay: day }, loadingDays: [day], ...fx };
  const inv = batchFgoLines(invoice);
  assert.deepEqual(inv.map((l) => [l.name, l.detail ?? null, l.qty]), [['Sticla 8.3.8. GRI+GRI', null, 295.41], ['Sticla 10 mm', null, 2], ['Stornare avans conform factură GKH699', null, -1]]);
  // Tutarlar, birim ve miktar aynen
  assert.deepEqual([inv[0].net, inv[0].gross, inv[1].gross, inv[2].ron], [127617.1, 154416.69, 726, 44972.47]);
  // Alt metin: yalnızca uygulanan kur — kayıtlı kurla (sabit değer değil); sipariş / yükleme açıklaması yok
  assert.equal(batchDocText(invoice), 'Curs de schimb aplicat: 6.0000 RON/EUR.');
  assert.equal(batchDocText({ ...invoice, fxRate: '5.0960' }), 'Curs de schimb aplicat: 5.0960 RON/EUR.');
  assert.equal(batchDocText({ ...invoice, currency: 'RON', fxRate: null }), '', 'RON faturada kur yok');
  // Politikanın kendi cümlesi proformadaki gibi (BT günlük kuru)
  assert.equal(batchDocText({ ...invoice, fxSource: 'MANUAL_DAY' }), 'Curs de vânzare BT: 6.0000 RON/EUR.');
  const settings = { cui: '1', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 };
  const f = emitereForm({ settings, key: 'K', kind: 'invoice', orderNo: 'ACU1, ACU2', appUrl: '', customer: { name: 'Acu' }, lines: inv, rate: 6, extern: 'LOT-b1', text: batchDocText(invoice), rateNote: false });
  assert.equal(f.Text, 'Curs de schimb aplicat: 6.0000 RON/EUR.');
  assert.ok(!Object.entries(f).some(([k, v]) => k.startsWith('Continut') && /Comanda/.test(String(v))), 'faturanın hiçbir kaleminde "Comanda" yok');
  assert.ok(!Object.keys(f).some((k) => /Descriere/.test(k)));
  // Proforma ve avans değişmez: kalem adı kayıttaki gibi, açıklamada kendi siparişi; metinde siparişler + günler + kur
  const proforma = { ...invoice, kind: 'PROFORMA', lines: lines.slice(0, 2).map((l) => ({ ...l, ronNet: null, ronGross: null, unitPrice: '50.00' })) };
  assert.deepEqual(batchFgoLines(proforma).map((l) => [l.name, l.detail]), [['Comanda ACU1 — Sticla 8.3.8. GRI+GRI', 'Comanda ACU1'], ['Comanda ACU2 — Sticla 10 mm', 'Comanda ACU2']]);
  assert.equal(batchDocText(proforma), 'Comenzi: ACU1, ACU2. Încărcare planificată: 05.10.2026. Curs de schimb aplicat: 6.0000 RON/EUR.');
  assert.equal(batchDocText({ ...invoice, kind: 'ADVANCE' }), 'Comenzi: ACU1, ACU2. Curs de schimb aplicat: 6.0000 RON/EUR.');
  // Önek yalnızca satırın KENDİ siparişininse kalkar
  assert.equal(invoiceLineName('Comanda ACU2 — Sticla', 'ACU1'), 'Comanda ACU2 — Sticla');
  assert.equal(invoiceLineName('Sticla', null), 'Sticla');
});

test('tekrar anahtarları: fatura = onay + müşteri + para birimi + zincir; sipariş kapsamı = onay + sipariş', () => {
  assert.equal(invoiceKeyOf({ confirmationId: 'c1', customerId: 'k1', currency: 'EUR', chainId: null }), 'INVOICE:c1:k1:EUR:DIRECT');
  assert.equal(invoiceKeyOf({ confirmationId: 'c1', customerId: 'k1', currency: 'EUR', chainId: 'p9' }), 'INVOICE:c1:k1:EUR:p9');
  assert.notEqual(invoiceOrderKey('c1', 'o1'), invoiceOrderKey('c2', 'o1'), 'aynı siparişin kalan adedi sonraki onayda ayrıca faturalanır');
});
