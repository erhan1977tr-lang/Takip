// Müşteri "Fiyat listem" (karar 333), gerçek PostgreSQL: her firma yalnızca KENDİ müşteri fiyat tablosunu görür;
// fabrika / satış tablosu (kind SALES) firmaya bağlı olsa bile görünmez; fiyatsız / 0 / pasif cam listelenmez. Ağ yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { customerPriceList } = await import('../../server/pricing/customer-price-list.js');

let db, a, b, c, d, glasses;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  glasses = [];
  for (const [i, [tr, ro, active]] of [['8MM TEMPER', 'Securizat 8 mm', true], ['10MM TEMPER', 'Securizat 10 mm', true], ['4MM FLOAT', 'Float 4 mm', true], ['ESKİ CAM', 'Sticlă veche', false]].entries()) {
    glasses.push(await db.glassProduct.create({ data: { nameTr: tr, nameRo: ro, colorTr: i === 0 ? 'FÜME' : '', colorRo: i === 0 ? 'Fumuriu' : '', sortOrder: i, isActive: active } }));
  }
  const items = (prices) => ({ create: prices.map((p, i) => (p == null ? null : { glassProductId: glasses[i].id, unitPrice: String(p) })).filter(Boolean) });
  const factory = await db.priceTable.create({ data: { kind: 'SALES', name: 'Fabrika 2026', currency: 'EUR', isDefault: true, items: items([11, 12, 13, 14]) } });
  const ta = await db.priceTable.create({ data: { kind: 'CUSTOMER', name: 'A özel', currency: 'EUR', holePrice: '2', cncPrice: '9', items: items([45.5, 39, 0, 50]) } });
  const tb = await db.priceTable.create({ data: { kind: 'CUSTOMER', name: 'B özel', currency: 'RON', items: items([null, null, 210]) } });
  const td = await db.priceTable.create({ data: { kind: 'CUSTOMER', name: 'D pasif', currency: 'EUR', isActive: false, items: items([99]) } });
  a = await db.customer.create({ data: { name: 'Firma A', prefix: 'FAA', priceTableId: ta.id } });
  b = await db.customer.create({ data: { name: 'Firma B', prefix: 'FBB', priceTableId: tb.id } });
  // Yanlış bağlantı: firmaya fabrika tablosu bağlanmış — liste boş olmalı
  c = await db.customer.create({ data: { name: 'Firma C', prefix: 'FCC', priceTableId: factory.id } });
  d = await db.customer.create({ data: { name: 'Firma D', prefix: 'FDD', priceTableId: td.id } });
});
after(async () => { await closeDb(); });

dbTest('firma A yalnızca kendi müşteri fiyatlarını görür (fiyatsız / 0 / pasif cam yok), dil seçimine göre', offline(async () => {
  const tr = await customerPriceList(db, a.id, 'tr');
  assert.equal(tr.currency, 'EUR');
  assert.deepEqual(tr.rows.map((r) => [r.label, r.price]), [['8MM TEMPER — FÜME', 45.5], ['10MM TEMPER', 39]]);
  const ro = await customerPriceList(db, a.id, 'ro');
  assert.deepEqual(ro.rows.map((r) => r.label), ['Securizat 8 mm — Fumuriu', 'Securizat 10 mm']);
}));

dbTest('her firmanın listesi ayrı: B kendi RON listesini görür', offline(async () => {
  const list = await customerPriceList(db, b.id, 'tr');
  assert.equal(list.currency, 'RON');
  assert.deepEqual(list.rows.map((r) => [r.label, r.price]), [['4MM FLOAT', 210]]);
}));

dbTest('fabrika (SALES) tablosu bağlı firma, pasif tablo, tablosuz firma → boş; fabrika fiyatı hiçbir firmada görünmez', offline(async () => {
  const none = await db.customer.create({ data: { name: 'Firma E', prefix: 'FEE' } });
  for (const id of [c.id, d.id, none.id, 'yok-boyle-firma']) assert.deepEqual(await customerPriceList(db, id, 'tr'), { currency: null, rows: [] });
  for (const id of [a.id, b.id]) {
    const prices = (await customerPriceList(db, id, 'tr')).rows.map((r) => r.price);
    for (const p of [11, 12, 13, 14]) assert.ok(!prices.includes(p), 'fabrika fiyatı sızdı');
  }
}));
