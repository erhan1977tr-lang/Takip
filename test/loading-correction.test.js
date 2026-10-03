// Yükleme düzeltmesi ve kısmi aktarım (Aşama 7F-1, karar 105–106) — saf kurallar: geçerli kalemler (effectiveItems),
// kısmi aktarımın plana girişi, kârlılıkta tek sayım.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotLoaded, effectiveItems, itemKey, planItems, scopeOf, snapshotOfItem } from '../server/loading/confirmation.js';
import { confirmedLine, mergeConfirmed } from '../server/accounting/supplier.js';

const item = (extra) => ({ confirmationId: 'c1', orderId: 'o1', customerId: 'cA', offerLineId: 'L1', replanId: null, revision: 0, status: 'LOADED', quantity: 10, sortOrder: 0, kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, currency: 'EUR', unitCost: 30, unitSale: 50, m2: 10, free: false, ...extra });
const view = (rows) => rows.map((i) => [itemKey(i), i.revision, i.status, i.quantity]);

test('effectiveItems: kapsam başına en yüksek sıradaki kalemler; düzeltilmeyen kapsam onay anındaki kalemiyle; eski satırlar hesaba girmez', () => {
  const rows = [
    item({}), // L1: onay — 10 yüklendi
    item({ offerLineId: 'L2', quantity: 4 }), // L2: hiç düzeltilmedi
    item({ revision: 1, quantity: 8 }), item({ revision: 1, status: 'NOT_LOADED', quantity: 2 }), // 1. düzeltme: 8 + 2
    item({ revision: 3, quantity: 10 }), // 3. düzeltme: yeniden 10 (2. düzeltme başka kapsamdaydı)
    item({ offerLineId: 'L3', quantity: 5 }), item({ offerLineId: 'L3', revision: 2, status: 'NOT_LOADED', quantity: 5 }), // L3: 2. düzeltme — tamamı yüklenmedi
  ];
  assert.deepEqual(view(effectiveItems(rows)), [['l:L2', 0, 'LOADED', 4], ['l:L1', 3, 'LOADED', 10], ['l:L3', 2, 'NOT_LOADED', 5]]);
  // Belirli bir sıraya kadar (faturanın kesildiği andaki durum, tarihçe)
  assert.deepEqual(view(effectiveItems(rows, 0)), [['l:L1', 0, 'LOADED', 10], ['l:L2', 0, 'LOADED', 4], ['l:L3', 0, 'LOADED', 5]]);
  assert.deepEqual(view(effectiveItems(rows, 1)), [['l:L2', 0, 'LOADED', 4], ['l:L1', 1, 'LOADED', 8], ['l:L1', 1, 'NOT_LOADED', 2], ['l:L3', 0, 'LOADED', 5]]);
  assert.deepEqual(view(effectiveItems(rows, 2)).filter((x) => x[0] === 'l:L3'), [['l:L3', 2, 'NOT_LOADED', 5]]);
  // Değişmez kural: geçerli yüklenen + yüklenmeyen = kapsamın onaylanan adedi
  for (const upTo of [0, 1, 2, 3]) {
    const sum = (key) => effectiveItems(rows, upTo).filter((i) => itemKey(i) === key).reduce((n, i) => n + i.quantity, 0);
    assert.deepEqual([sum('l:L1'), sum('l:L2'), sum('l:L3')], [10, 4, 5]);
  }
  assert.deepEqual(effectiveItems([]), []);
});

test('effectiveItems: kapsam onaya ve aktarıma göre ayrıdır (aynı teklif satırı başka onayda / aktarımla ayrı kapsam)', () => {
  const rows = [
    item({ status: 'LOADED', quantity: 8 }), item({ status: 'NOT_LOADED', quantity: 2 }), // c1: 8 + 2
    item({ confirmationId: 'c2', replanId: 'r1', quantity: 1 }), // c2: aktarılan 1 adet (aynı teklif satırı)
    item({ confirmationId: 'c2', replanId: 'r2', quantity: 1 }), // c2: aynı satırın başka aktarımı — ayrı kapsam
    item({ confirmationId: 'c2', replanId: 'r1', revision: 1, status: 'NOT_LOADED', quantity: 1 }), // c2'de düzeltme: r1 yüklenmedi
  ];
  assert.equal(new Set(rows.map(scopeOf)).size, 3);
  assert.deepEqual(effectiveItems(rows).map((i) => [i.confirmationId, itemKey(i), i.revision, i.status, i.quantity]), [
    ['c1', 'l:L1', 0, 'LOADED', 8], ['c1', 'l:L1', 0, 'NOT_LOADED', 2], ['c2', 'r:r2', 0, 'LOADED', 1], ['c2', 'r:r1', 1, 'NOT_LOADED', 1],
  ]);
  // revision alanı olmayan (eski) kalem 0 sayılır
  assert.equal(effectiveItems([{ confirmationId: 'c', offerLineId: 'x' }]).length, 1);
});

test('kısmi aktarım: aynı kaynaktan iki ayrı güne 1\'er adet — her gün yalnızca kendi adedi, m² ölçüden; kaynağın ticari kopyasıyla', () => {
  const lines = [{ id: 'L1', sortOrder: 0, kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat', enMm: 1500, boyMm: 1000, adet: 10, unitPrice: '30', offerPrice: '50' }];
  const order = { id: 'o1', orderNo: 'O1', title: null, customerId: 'cA', status: 'URETIMDE', onHold: false, customer: { id: 'cA', name: 'A SRL' }, offers: [{ id: 'of1', status: 'GONDERILDI', currency: 'EUR', offerAmount: '0', lines }] };
  const split = applyNotLoaded(planItems([order]).orders, [{ key: 'l:L1', quantity: 2, reason: 'BROKEN' }]);
  const source = { ...split.items.find((i) => i.status === 'NOT_LOADED'), id: 'it1' };
  assert.deepEqual([source.quantity, source.m2], [2, 3]);
  const replan = (id, quantity) => ({ id, quantity, fromDay: new Date('2026-10-16T00:00:00Z'), sourceItem: source, order });
  for (const r of [replan('rpA', 1), replan('rpB', 1)]) {
    const plan = planItems([], new Map(), [r]);
    assert.deepEqual(plan.items.map((i) => [itemKey(i), i.quantity, i.m2, i.unitCost, i.unitSale, i.costAmount, i.saleAmount, i.status]), [[`r:${r.id}`, 1, 1.5, 30, 50, 45, 75, 'LOADED']]);
  }
  // İki aktarım aynı güne düşerse (zincirin iki kolundan) iki ayrı kapsam olarak birlikte yer alır
  const both = planItems([], new Map(), [replan('rpA', 1), replan('rpB', 1)]);
  assert.deepEqual([both.orders.length, both.items.map((i) => itemKey(i))], [1, ['r:rpA', 'r:rpB']]);
  // Aktarılan adedin kopyası: tutarlar adede göre, birim fiyatlar aynı
  assert.deepEqual([snapshotOfItem(source, { quantity: 1 }).m2, snapshotOfItem(source, { quantity: 2 }).m2], [1.5, 3]);
});

test('kârlılık geçerli kalemlerden: düzeltilen kapsam iki kez sayılmaz; yüklenen kalemi kalmayan sipariş satır üretmez', () => {
  const rows = [item({}), item({ revision: 1, quantity: 8, m2: 8 }), item({ revision: 1, status: 'NOT_LOADED', quantity: 2, m2: 2 })];
  const line = confirmedLine({ orderId: 'o1', orderNo: 'O1', day: '2026-10-16', items: effectiveItems(rows) });
  assert.deepEqual([line.m2, line.sale, line.cost], [8, 400, 240], '10 + 8 değil: yalnızca geçerli 8 adet');
  const none = confirmedLine({ orderId: 'o1', orderNo: 'O1', day: '2026-10-16', items: effectiveItems([item({}), item({ revision: 1, status: 'NOT_LOADED' })]) });
  assert.equal(none, null);
  // Onayda kalemi olan sipariş (hepsi yüklenmedi olsa da) planlanan hesaba girmez
  const planned = [{ orderId: 'o1', orderNo: 'O1', day: '2026-10-16', currency: 'EUR', m2: 10, sale: 500, cost: 300, noCost: 0, noCostLines: [], confirmed: false }];
  const merged = mergeConfirmed(planned, [{ day: '2026-10-16', orders: [{ orderId: 'o1', orderNo: 'O1', items: effectiveItems([item({}), item({ revision: 1, status: 'NOT_LOADED' })]) }] }]);
  assert.deepEqual(merged.lines, []);
});
