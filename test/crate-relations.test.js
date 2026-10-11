// Müşteri paneli "Sandık bilgileri" — misafir yük ilişkisi (karar 254): saf kural ve veritabanı okumasının yapısı.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { crateRelations } from '../server/loading/crate-relations.js';

const day = new Date('2026-10-02T00:00:00Z');
// SB'nin (firma s) 1 numaralı sandığı: kendi siparişi SBL10 + ADER'in (firma ade) ADE6'sı misafir yük
const crate1 = {
  id: 'c1', crateNo: 1, shipDay: day, customerId: 's', lengthMm: 2770, widthMm: 490, heightMm: 1470, netAgirlik: '900', brutAgirlik: '984', daraKg: null,
  customer: { sandikEtiket: 'SB' },
  orders: [{ order: { customerId: 's', sandikEtiket: null } }, { order: { customerId: 'ade', sandikEtiket: 'ADER-ETIKET' } }],
};
const crate2 = { ...crate1, id: 'c2', crateNo: 2, netAgirlik: null, brutAgirlik: null, orders: [{ order: { customerId: 's', sandikEtiket: null } }] };
const links = [
  { order: { id: 'o-sbl', orderNo: 'SBL10', customerId: 's', customer: { name: 'Sistem Balustrada SRL' } }, crate: crate1 },
  { order: { id: 'o-ade', orderNo: 'ADE6', customerId: 'ade', customer: { name: 'ADER GLASS' } }, crate: crate1 },
  { order: { id: 'o-sbl2', orderNo: 'SBL11', customerId: 's', customer: { name: 'Sistem Balustrada SRL' } }, crate: crate2 },
];

test('misafir yük sahibi: kendi siparişinin bulunduğu ev sahibi sandığı (etiket, no, ölçü, ağırlık, gün) — ev sahibinin adı yok', () => {
  const r = crateRelations(links, 'ade');
  assert.deepEqual(r.hosted, []);
  assert.deepEqual(r.away, [{ day: '2026-10-02', orderId: 'o-ade', orderNo: 'ADE6', crateNo: 1, label: 'SB', lengthMm: 2770, widthMm: 490, heightMm: 1470, netKg: 900, weightKg: 984 }]);
  assert.ok(!JSON.stringify(r).includes('Sistem Balustrada'), 'ev sahibi firmanın adı misafire gitmez');
  assert.ok(!JSON.stringify(r).includes('SBL10'), 'sandıktaki başka sipariş misafire gitmez');
});

test('sandık sahibi: kendi sandığındaki misafir yük (firma + sipariş no); kendi siparişleri ilişki sayılmaz', () => {
  const r = crateRelations(links, 's');
  assert.deepEqual(r.away, []);
  assert.deepEqual(r.hosted, [{ day: '2026-10-02', crateId: 'c1', crateNo: 1, label: 'SB', orderNo: 'ADE6', firm: 'ADER GLASS' }]);
});

test('ilişkinin tarafı olmayan üçüncü müşteri hiçbir şey görmez; firması olmayan kullanıcı da', () => {
  assert.deepEqual(crateRelations(links, 'third'), { away: [], hosted: [] });
  assert.deepEqual(crateRelations(links, null), { away: [], hosted: [] });
});

test('etiket yalnızca girilmiş fiziksel etiket (firma kodu / adı yazılmaz); misafirin etiketi ev sahibi sandığını değiştirmez; ağırlık uydurulmaz', () => {
  const bare = { ...crate1, customer: { sandikEtiket: null }, orders: [{ order: { customerId: 'ade', sandikEtiket: 'ADER-ETIKET' } }], brutAgirlik: null, netAgirlik: null };
  const r = crateRelations([{ order: { id: 'o-ade', orderNo: 'ADE6', customerId: 'ade', customer: { name: 'ADER GLASS' } }, crate: bare }], 'ade');
  assert.deepEqual([r.away[0].label, r.away[0].weightKg, r.away[0].netKg], ['', null, null]);
});

test('veritabanı okuması: yalnızca müşterinin taraf olduğu bağlar; iptal / silinmiş sipariş yok; iç ekip için boş', () => {
  const src = fs.readFileSync(new URL('../lib/loading.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function customerCrateRelations'), src.indexOf('export async function guestHostNames'));
  assert.match(fn, /user\.appRole === 'MUSTERI' && user\.type === 'CUSTOMER'/);
  assert.match(fn, /OR: \[\{ order: \{ customerId: firm \} \}, \{ crate: \{ customerId: firm \} \}\]/);
  assert.match(fn, /status: \{ not: 'IPTAL'/);
  assert.match(fn, /removedAt: null/);
  // Fiyat, belge, dosya alanı seçilmez
  assert.ok(!/offers|price|files|fgo|amount/i.test(fn.replace(/\/\/.*$/gm, '')), 'fiyat / belge / dosya okunmaz');
});
