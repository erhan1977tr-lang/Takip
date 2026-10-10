// P1 (karar 239) — nihai fatura onaylı yüklemeden; siparişin kendi proforma zinciri müşteri faturasına girer. Saf kurallar:
// fatura grubu anahtarı, siparişin zincir kuru, borç hesabı (aynı ticari borç iki kez sayılmaz). Ağ yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fxOfOrderChain, invoiceKeyOf } from '../server/glass/invoice-batch.js';
import { receivables, unitOf } from '../server/accounting/receivables.js';

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async (url) => { throw new Error(`testte ağ isteği yapılmamalı: ${url}`); }; });
test.after(() => { globalThis.fetch = realFetch; });

test('fatura grubu: siparişin kendi zinciri ayrı grup (kendi kuru); müşteri proforması ve doğrudan fatura değişmedi', () => {
  const base = { confirmationId: 'c1', customerId: 'k1', currency: 'EUR' };
  assert.equal(invoiceKeyOf({ ...base, chainId: null }), 'INVOICE:c1:k1:EUR:DIRECT');
  assert.equal(invoiceKeyOf({ ...base, chainId: 'p1' }), 'INVOICE:c1:k1:EUR:p1');
  assert.equal(invoiceKeyOf({ ...base, chainId: null, orderChainId: 'o1' }), 'INVOICE:c1:k1:EUR:ORDER-o1');
  assert.notEqual(invoiceKeyOf({ ...base, chainId: null, orderChainId: 'o1' }), invoiceKeyOf({ ...base, chainId: null, orderChainId: 'o2' }));
});

test('siparişin zincir kuru: proformanın kur kaydı (yeniden çözülmez); kayıt yoksa kur yok — uydurulmaz', () => {
  assert.equal(fxOfOrderChain(null, 'EUR'), null);
  assert.equal(fxOfOrderChain({ fxRate: null }, 'EUR'), null);
  const full = fxOfOrderChain({
    fxRate: '5.0934', fxDate: new Date('2026-10-01T00:00:00Z'), fxSource: 'BNR', fxPolicy: 'BNR', fxCurrency: 'EUR', fxBaseRate: '5.0934',
    fxMarkupPercent: null, fxSourceDate: new Date('2026-09-30T00:00:00Z'), fxResolvedAt: new Date('2026-10-01T08:00:00Z'), fxManual: false,
  }, 'EUR');
  assert.deepEqual([full.rate, full.finalRate, full.source, full.policy, full.sourceDate, full.manual], [5.0934, '5.0934', 'BNR', 'BNR', '2026-09-30', false]);
  // Eski kayıt: yalnızca kur, gün ve kaynak — eksikler kayıttan tamamlanır (kur aynı kalır)
  const legacy = fxOfOrderChain({ fxRate: '4.9700', fxDate: new Date('2026-09-15T00:00:00Z'), fxSource: 'MANUAL' }, 'EUR');
  assert.deepEqual([legacy.rate, legacy.baseRate, legacy.sourceDate, legacy.currency], [4.97, '4.9700', '2026-09-15', 'EUR']);
});

test('borç: siparişin proforması + avansı + onaydan kesilen kısmi faturalar tek birim — aynı tutar iki kez sayılmaz', () => {
  const pro = { id: 'P', orderId: 'o1', kind: 'PROFORMA', currency: 'RON', total: '1210.00', paid: '500.00' };
  const adv = { id: 'A', orderId: 'o1', kind: 'ADVANCE', currency: 'RON', total: '500.00', paid: '500.00' };
  // 1. yükleme: mal 605 (yarısı), avans 500 düşülür → fatura 105
  const inv1 = { id: 'I1', orderId: null, batchId: 'b1', kind: 'INVOICE', currency: 'RON', total: '105.00', paid: '0', batch: { parentId: null, chainOrderId: 'o1', lines: [{ ronGross: '605.00', refBatchId: null, refDocId: null }, { ronGross: '500.00', refBatchId: null, refDocId: 'A' }] } };
  assert.equal(unitOf(inv1), 'o1', 'zincirdeki fatura siparişin birimine girer');
  let r = receivables([pro, adv, inv1]);
  assert.deepEqual(r.shares.get('P'), { debt: 605, rest: 605, replaced: false }, 'proforma: henüz faturalanmamış kapsam');
  assert.equal(r.sums.RON.total, 1210, 'toplam borç = proforma toplamı (avans + fatura + kalan kapsam)');
  // 2. yükleme: kalan 605 faturalanır → proforma kapanır
  const inv2 = { id: 'I2', orderId: null, batchId: 'b2', kind: 'INVOICE', currency: 'RON', total: '605.00', paid: '0', batch: { parentId: null, chainOrderId: 'o1', lines: [{ ronGross: '605.00', refBatchId: null, refDocId: null }] } };
  r = receivables([pro, adv, inv1, inv2]);
  assert.deepEqual(r.shares.get('P'), { debt: 0, rest: 0, replaced: true });
  assert.equal(r.sums.RON.total, 1210);
  // Ödenmemiş proforma, avans yok, kısmi fatura: proforma kalanı = faturalanmamış kapsam
  const unpaid = { ...pro, paid: '0' };
  const inv3 = { ...inv2, id: 'I3', batch: { ...inv2.batch, lines: [{ ronGross: '605.00', refBatchId: null, refDocId: null }] } };
  r = receivables([unpaid, inv3]);
  assert.deepEqual(r.shares.get('P'), { debt: 605, rest: 605, replaced: false });
  assert.equal(r.sums.RON.total, 1210);
  // Eski sipariş düzeyi kapanış faturası: davranış değişmedi (proforma yerine fatura)
  const old = { id: 'F', orderId: 'o1', kind: 'INVOICE', currency: 'RON', total: '710.00', paid: '0' };
  assert.deepEqual(receivables([pro, adv, old]).shares.get('P'), { debt: 0, rest: 0, replaced: true });
});
