// Müşteri "Fiyat listem" (karar 333): yalnızca firmanın KENDİ müşteri fiyat tablosu; fabrika / satış fiyat tabloları
// (kind SALES) asla; her firma yalnızca kendi tablosu; yalnızca fiyatı dolu ve aktif cam. Sahte DB, ağ yok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerPriceList, ownCustomerTableWhere } from '../server/pricing/customer-price-list.js';
import { ROLES, can } from '../server/auth/permissions.js';

const glass = (nameTr, colorTr, nameRo, colorRo, sortOrder = 0, isActive = true) => ({ nameTr, colorTr, nameRo, colorRo, sortOrder, isActive });
const G1 = glass('10 MM TEMPER CAM', 'ŞEFFAF', 'Sticlă securizată 10 mm', 'Clar', 1);
const G2 = glass('8 MM TEMPER CAM', 'FÜME', 'Sticlă securizată 8 mm', 'Fumuriu', 0);
const G3 = glass('6 MM CAM', 'BRONZ', 'Sticlă 6 mm', 'Bronz', 2);
const GX = glass('PASİF CAM', '', 'Sticlă inactivă', '', 3, false);

/** Prisma'nın findFirst davranışını taklit eden küçük sahte DB (where: kind, isActive, customers.some.id; items where) */
function fakeDb(tables) {
  const calls = [];
  return {
    calls,
    priceTable: {
      async findFirst({ where, select }) {
        calls.push({ where, select });
        const t = tables.find((x) => (where.kind == null || x.kind === where.kind) && (where.isActive == null || x.isActive === where.isActive)
          && (!where.customers || x.customers.includes(where.customers.some.id)));
        if (!t) return null;
        // items koşulunu UYGULAMADAN döndürür: servisin ikinci (JS) süzgeci de sınanır
        return { kind: t.kind, currency: t.currency, items: t.items.map(([g, p]) => ({ unitPrice: p, glassProduct: g })) };
      },
    },
  };
}

const TABLES = [
  // Fabrika / satış fiyatları (kind SALES) — firma A'ya da "bağlı" gibi davranır: asla görünmemeli
  { kind: 'SALES', isActive: true, currency: 'EUR', customers: ['A', 'C'], items: [[G1, '11.00'], [G2, '12.00'], [G3, '13.00']] },
  { kind: 'CUSTOMER', isActive: true, currency: 'EUR', customers: ['A'], items: [[G1, '45.50'], [G2, '39.00'], [G3, '0'], [GX, '50.00']] },
  { kind: 'CUSTOMER', isActive: true, currency: 'RON', customers: ['B'], items: [[G3, '210.00']] },
  { kind: 'CUSTOMER', isActive: false, currency: 'EUR', customers: ['D'], items: [[G1, '99.00']] },
];

test('sorgu koşulu: yalnızca bu firmaya bağlı, aktif MÜŞTERİ tablosu', () => {
  assert.deepEqual(ownCustomerTableWhere('A'), { kind: 'CUSTOMER', isActive: true, customers: { some: { id: 'A' } } });
});

test('firma A: yalnızca kendi müşteri fiyatları — fabrika fiyatı yok, fiyatsız ve pasif cam yok, sıralı', async () => {
  const db = fakeDb(TABLES);
  const list = await customerPriceList(db, 'A', 'tr');
  assert.equal(list.currency, 'EUR');
  assert.deepEqual(list.rows, [
    { name: '8 MM TEMPER CAM', color: 'FÜME', label: '8 MM TEMPER CAM — FÜME', price: 39 },
    { name: '10 MM TEMPER CAM', color: 'ŞEFFAF', label: '10 MM TEMPER CAM — ŞEFFAF', price: 45.5 },
  ]);
  for (const r of list.rows) assert.ok(![11, 12, 13].includes(r.price), 'fabrika fiyatı sızdı');
  // Sorguda kind CUSTOMER koşulu var; fiyat > 0 ve aktif cam koşulu sorguda
  const call = db.calls[0];
  assert.equal(call.where.kind, 'CUSTOMER');
  assert.deepEqual(call.select.items.where, { unitPrice: { gt: 0 }, glassProduct: { isActive: true } });
});

test('dönen veride yalnızca ad / renk / fiyat / para birimi: tablo kimliği, adı, ağırlık, satış fiyatı yok', async () => {
  const list = await customerPriceList(fakeDb(TABLES), 'A', 'ro');
  assert.deepEqual(Object.keys(list).sort(), ['currency', 'rows']);
  for (const r of list.rows) assert.deepEqual(Object.keys(r).sort(), ['color', 'label', 'name', 'price']);
  const db = fakeDb(TABLES);
  await customerPriceList(db, 'A', 'tr');
  const sel = db.calls[0].select;
  assert.deepEqual(Object.keys(sel).sort(), ['currency', 'items', 'kind']);
  assert.deepEqual(Object.keys(sel.items.select).sort(), ['glassProduct', 'unitPrice']);
  assert.deepEqual(Object.keys(sel.items.select.glassProduct.select).sort(), ['colorRo', 'colorTr', 'isActive', 'nameRo', 'nameTr', 'sortOrder']);
});

test('dil: Romence seçiliyse Romence ad ve renk', async () => {
  const list = await customerPriceList(fakeDb(TABLES), 'A', 'ro');
  assert.deepEqual(list.rows.map((r) => [r.name, r.color]), [['Sticlă securizată 8 mm', 'Fumuriu'], ['Sticlă securizată 10 mm', 'Clar']]);
});

test('her firma yalnızca kendi tablosu: B kendi RON listesini görür, A\'nın fiyatlarını görmez', async () => {
  const list = await customerPriceList(fakeDb(TABLES), 'B', 'tr');
  assert.equal(list.currency, 'RON');
  assert.deepEqual(list.rows.map((r) => r.price), [210]);
});

test('yalnızca SALES (fabrika) tablosuna bağlı firma, pasif tablo, tablosuz firma, firmasız kullanıcı → boş liste', async () => {
  for (const id of ['C', 'D', 'Z']) assert.deepEqual(await customerPriceList(fakeDb(TABLES), id, 'tr'), { currency: null, rows: [] });
  const db = fakeDb(TABLES);
  for (const id of [null, undefined, '', 42]) assert.deepEqual(await customerPriceList(db, /** @type {any} */ (id), 'tr'), { currency: null, rows: [] });
  assert.equal(db.calls.length, 0, 'firmasız kullanıcı için sorgu yapılmaz');
});

test('ikinci kilit: sorgu yanlışlıkla SALES tablosu döndürse bile hiçbir şey gösterilmez', async () => {
  const db = { priceTable: { findFirst: async () => ({ kind: 'SALES', currency: 'EUR', items: [{ unitPrice: '11', glassProduct: G1 }] }) } };
  assert.deepEqual(await customerPriceList(db, 'A', 'tr'), { currency: null, rows: [] });
});

test('yetki: fiyat listesi yalnızca müşteri rolünde', () => {
  for (const r of ROLES) assert.equal(can(r, 'OWN_PRICE_LIST_VIEW'), r === 'MUSTERI', r);
});

test('yapı: sayfa firmayı oturumdan alır, yalnızca bu servisi kullanır; servis fabrika tablosu okuyucularını içermez', () => {
  const page = readFileSync(new URL('../app/(panel)/fiyat-listem/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /requirePermission\('OWN_PRICE_LIST_VIEW'\)/);
  assert.match(page, /customerPriceList\(db, user\.customerId, locale\)/);
  assert.doesNotMatch(page, /pricing\/tables|priceTable\b|unitPrice|SALES/);
  const svc = readFileSync(new URL('../server/pricing/customer-price-list.js', import.meta.url), 'utf8');
  assert.doesNotMatch(svc, /kind:\s*'SALES'|pricingForUser|resolveTable|loadPricing|\.user\.|offerLine|OfferLine/);
  const nav = readFileSync(new URL('../lib/roles.ts', import.meta.url), 'utf8');
  const customerNav = nav.slice(nav.indexOf('MUSTERI: ['));
  assert.match(customerNav.slice(0, customerNav.indexOf(']')), /'\/fiyat-listem'/);
  assert.equal((nav.match(/'\/fiyat-listem'/g) ?? []).length, 1, 'fiyat listesi yalnızca müşteri menüsünde');
});
