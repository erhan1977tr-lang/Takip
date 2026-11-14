// 4.2.19 — tedarikçi siparişi: siparişten fazla mal kabulü (karar 318) ve ürün başına nakliye (karar 319). Saf kurallar +
// yapı. Guard: eski (mal kabulüne göre) nakliye kaydı ve iptal edilmiş siparişin borcu değişmez.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { overValue, supplierBalances } from '../server/suppliers/rules.js';
import { allocateLine, parseTransport, parseTransportLines, splitByWeight, transportProducts } from '../server/suppliers/stock-cost.js';
import { fromScaled } from '../server/suppliers/money.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ID = (n) => `line${String(n).padStart(8, '0')}`;

test('overValue: yalnızca sipariş edilenin üstündeki adet, satır tutarı kuralıyla (yarım-yukarı, bir kez)', () => {
  const lines = [{ id: 'a', qty: 100, unitPrice: '10' }, { id: 'b', qty: 10, unitPrice: '0.333' }, { id: 'c', qty: 5, unitPrice: null }, { id: 'd', qty: 20, unitPrice: '2' }];
  const got = new Map([['a', 105], ['b', 13], ['c', 9], ['d', 12]]);
  // a: 1050 − 1000 = 50; b: 13 × 0,333 = 4,329 → 4,33 − 3,33 = 1,00; c: fiyatsız (tutar eklenmez, adet sayılır); d: eksik teslim → 0
  assert.deepEqual(overValue(lines, got), { total: '51.00', qty: 5 + 3 + 4 });
  assert.deepEqual(overValue(lines, new Map()), { total: '0.00', qty: 0 });
  assert.deepEqual(overValue(lines, new Map([['a', 100]])), { total: '0.00', qty: 0 }, 'tam teslimde borç sipariş toplamı kalır');
});

test('supplierBalances: fazla teslimatlı satırın toplamı borca girer; iptal siparişin kuralı değişmez', () => {
  const b = supplierBalances(
    [{ currency: 'EUR', status: 'TESLIM_ALINDI', total: '1100.00' }, { currency: 'EUR', status: 'IPTAL', total: '30', received: true }, { currency: 'EUR', status: 'IPTAL', total: '99' }],
    [{ currency: 'EUR', amount: '100' }],
  );
  assert.deepEqual(b.EUR, { opening: '0.00', debt: '1130.00', paid: '100.00', balance: '1030.00', orders: 2, missingPrice: 0 });
});

test('splitByWeight: en büyük kalan; toplam her zaman tam', () => {
  assert.deepEqual(splitByWeight(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assert.deepEqual(splitByWeight(0n, [5n, 7n]), [0n, 0n]);
  for (let i = 0; i < 300; i++) {
    const w = Array.from({ length: 1 + (i % 7) }, (_, k) => BigInt(1 + ((i * 37 + k * 11) % 500)));
    const total = BigInt(i * 9973 + 1);
    const s = splitByWeight(total, w);
    assert.equal(s.reduce((n, x) => n + x, 0n), total);
    assert.ok(s.every((x) => x >= 0n));
  }
});

test('parseTransportLines: EUR — fatura tutarı = ürün tutarlarının toplamı; boş / 0 satır atlanır', () => {
  const r = parseTransportLines({ carrierName: ' Nak Lojistik ', invoiceNo: 'F-1', currency: 'EUR', lineAmounts: { [ID(1)]: '120,50', [ID(2)]: '', [ID(3)]: '0', [ID(4)]: '79.5' } });
  assert.equal(r.ok, true, /** @type {any} */ (r).code);
  const v = /** @type {any} */ (r).value;
  assert.equal(v.amount, '200.00');
  assert.equal(v.amountEur, '200.00');
  assert.equal(v.fxRate, null);
  assert.deepEqual(v.lines.map((l) => [l.orderLineId, l.amount, fromScaled(l.eur4, 4, 4)]), [[ID(1), '120.50', '120.5000'], [ID(4), '79.50', '79.5000']]);
});

test('parseTransportLines: RON — kurla çevrilen toplam ürünlere RON tutarları oranında bölünür; paylar toplamı tam', () => {
  const r = parseTransportLines({ carrierName: 'Nak', currency: 'RON', fxRate: '4,9765', lineAmounts: { [ID(1)]: '100', [ID(2)]: '200', [ID(3)]: '33.33' } });
  assert.equal(r.ok, true, /** @type {any} */ (r).code);
  const v = /** @type {any} */ (r).value;
  assert.equal(v.amount, '333.33');
  assert.equal(v.fxRate, '4.9765');
  const old = parseTransport({ carrierName: 'Nak', currency: 'RON', fxRate: '4,9765', amount: '333.33', receiptIds: [ID(9)] });
  assert.equal(v.amountEur, /** @type {any} */ (old).value.amountEur, 'aynı tutarın EUR karşılığı eski yolla aynı');
  const sum = v.lines.reduce((n, l) => n + l.eur4, 0n);
  assert.equal(sum, BigInt(v.amountEur.replace('.', '')) * 100n, 'ürün payları toplamı = EUR karşılığı (10⁻⁴)');
});

test('parseTransportLines: hatalar', () => {
  const base = { carrierName: 'Nak', currency: 'EUR' };
  assert.equal(parseTransportLines({ ...base, carrierName: '', lineAmounts: { [ID(1)]: '1' } }).code, 'CARRIER');
  assert.equal(parseTransportLines({ ...base, lineAmounts: {} }).code, 'LINES');
  assert.equal(parseTransportLines({ ...base, lineAmounts: { [ID(1)]: '', [ID(2)]: '0' } }).code, 'LINES');
  assert.equal(parseTransportLines({ ...base, lineAmounts: { 'kısa': '5' } }).code, 'LINES');
  assert.deepEqual(parseTransportLines({ ...base, lineAmounts: { [ID(1)]: '1.234' } }), { ok: false, code: 'LINE_AMOUNT', line: ID(1) });
  assert.deepEqual(parseTransportLines({ ...base, lineAmounts: { [ID(1)]: '-5' } }), { ok: false, code: 'LINE_AMOUNT', line: ID(1) });
  assert.equal(parseTransportLines({ ...base, currency: 'USD', lineAmounts: { [ID(1)]: '5' } }).code, 'CURRENCY');
  assert.equal(parseTransportLines({ ...base, currency: 'RON', lineAmounts: { [ID(1)]: '5' } }).code, 'FX_REQUIRED');
  assert.equal(parseTransportLines({ ...base, currency: 'RON', fxRate: '0,5', lineAmounts: { [ID(1)]: '5' } }).code, 'FX_RATE');
});

test('allocateLine: ürünün payı net teslim alınan adede birim başına eşit; düzeltilmiş (0) satır atlanır', () => {
  const r = allocateLine(1000000n, [{ receiptLineId: 'r1', productId: 'p', qty: 2 }, { receiptLineId: 'r2', productId: 'p', qty: 0 }, { receiptLineId: 'r3', productId: 'p', qty: 1 }]);
  assert.equal(r.ok, true);
  const rows = /** @type {any} */ (r).rows;
  assert.deepEqual(rows.map((x) => [x.receiptLineId, x.qty, x.amountEur]), [['r1', 2, '66.6667'], ['r3', 1, '33.3333']]);
  assert.deepEqual(allocateLine(5n, [{ receiptLineId: 'r', productId: 'p', qty: 0 }]), { ok: false, code: 'NO_QTY' });
});

test('transportProducts: ürün kodu başına adet ve EUR payı (gösterim)', () => {
  assert.deepEqual(transportProducts([
    { qty: 2, amountEur: '66.6667', product: { code: 'FBL115-7016' } },
    { qty: 1, amountEur: '33.3333', product: { code: 'FBL115-7016' } },
    { qty: 5, amountEur: '10.005', product: { code: 'GK15' } },
  ]), [{ code: 'FBL115-7016', qty: 3, eur: '100.00' }, { code: 'GK15', qty: 5, eur: '10.01' }]);
});

test('yapı: mal kabulünde kalanı aşma yasağı kalktı; nakliye formu ürün başına; Tedarikçi Hesapları ekranında taşıyıcı bölümü yok', () => {
  const receipt = read('server/suppliers/receipt.js');
  assert.ok(!receipt.includes("'OVER_REMAINING'"), 'fazla adet kabul edilir (karar 318)');
  assert.ok(receipt.includes("if (!RECEIVABLE_STATUSES.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED'"), 'kapanmış siparişe kabul yok (değişmedi)');
  const action = read('app/(panel)/siparisler/tedarik/actions.ts');
  assert.ok(action.includes("if (k.startsWith('t_')"), 'ürün tutarları t_<satır> alanlarından');
  assert.ok(!/addTransportAction[\s\S]*?receiptIds:/.test(action.slice(action.indexOf('export async function addTransportAction'), action.indexOf('export async function addTransportAction') + 1500)));
  const page = read('app/(panel)/siparisler/tedarik/[id]/page.tsx');
  assert.ok(page.includes('name={`t_${l.id}`}'));
  assert.ok(!page.includes('name="receiptIds"') && !page.includes('id="tr-amount"'), 'nakliye formunda mal kabulü seçimi / tek tutar yok');
  const accounts = read('app/(panel)/admin/muhasebe/tedarikciler/page.tsx');
  assert.ok(!accounts.includes('tasiyicilar') && !accounts.includes('listTransports'), 'taşıyıcı bakiyeleri bu ekranda gösterilmez');
  // Taşıyıcının borcu ürün tedarikçisinin borcuna eklenmez: hesap servisleri nakliye tablolarını okumaz
  const service = read('server/suppliers/service.js');
  assert.ok(!/transportCost/.test(service));
});
