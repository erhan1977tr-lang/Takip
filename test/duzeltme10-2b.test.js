// DÜZELTME 10 — Aşama 2B (3.97.0): M2 tedarikçi açılış bakiyesi, M5 tedarikçi ürün kodu, M6 nakliye dağıtımı ve
// gerçekleşen stok maliyeti, M9 tedarikçi başına en çok 10 e-posta. Saf kurallar; veritabanı davranışı test/db/duzeltme10-2b.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_SUPPLIER_EMAILS, activeRecipients, missingSupplierCodes, parseEmailList, parseOpening, signedCents, supplierBalances,
} from '../server/suppliers/rules.js';
import { allocateTransport, carrierBalances, parseTransport, ronToEurCents, stockCosts } from '../server/suppliers/stock-cost.js';
import { profileDefaults } from '../server/commercial/rules.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------------------------------------------------------- M9
test('M9: en çok 10 geçerli, tekil adres; geçersiz / aynı adres reddedilir; birincil etkin olmalı', () => {
  const ok = parseEmailList([{ email: ' A@x.test ', isPrimary: false }, { email: 'b@x.test', isPrimary: true }, { email: '' }, { email: 'c@x.test', isActive: false }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.map((e) => [e.email, e.emailKey, e.isActive, e.isPrimary, e.sortOrder]), [
    ['A@x.test', 'a@x.test', true, false, 0], ['b@x.test', 'b@x.test', true, true, 1], ['c@x.test', 'c@x.test', false, false, 2],
  ]);
  assert.deepEqual(parseEmailList([{ email: 'a@x.test' }, { email: 'A@X.TEST' }]), { ok: false, code: 'EMAIL_DUPLICATE', index: 1 });
  assert.deepEqual(parseEmailList([{ email: 'a@x.test, b@x.test' }]), { ok: false, code: 'EMAIL', index: 0 });
  assert.deepEqual(parseEmailList([{ email: 'Ad <a@x.test>' }]), { ok: false, code: 'EMAIL', index: 0 });
  const eleven = Array.from({ length: 11 }, (_, i) => ({ email: `u${i}@x.test` }));
  assert.deepEqual(parseEmailList(eleven), { ok: false, code: 'EMAIL_LIMIT' });
  assert.equal(parseEmailList(eleven.slice(0, MAX_SUPPLIER_EMAILS)).ok, true);
  // Pasif birincil → ilk etkin adres birincil; etkin yoksa birincil yok
  const p = parseEmailList([{ email: 'a@x.test', isActive: false, isPrimary: true }, { email: 'b@x.test' }]);
  assert.deepEqual(p.value.map((e) => e.isPrimary), [false, true]);
  assert.deepEqual(parseEmailList([{ email: 'a@x.test', isActive: false }]).value.map((e) => e.isPrimary), [false]);
});

test('M9: alıcılar = etkin adresler, birincil önce, tekil, en çok 10', () => {
  const rows = [
    { email: 'c@x.test', isActive: true, isPrimary: false, sortOrder: 2 }, { email: 'a@x.test', isActive: false, isPrimary: false, sortOrder: 0 },
    { email: 'b@x.test', isActive: true, isPrimary: true, sortOrder: 1 }, { email: 'B@x.test', isActive: true, isPrimary: false, sortOrder: 3 },
    { email: 'bozuk', isActive: true, isPrimary: false, sortOrder: 4 },
  ];
  assert.deepEqual(activeRecipients(rows), ['b@x.test', 'c@x.test']);
  assert.deepEqual(activeRecipients([]), []);
  assert.equal(activeRecipients(Array.from({ length: 15 }, (_, i) => ({ email: `u${i}@x.test`, isActive: true, sortOrder: i }))).length, 10);
});

test('M9: işçi her alıcıya AYRI ileti gönderir (alıcılar birbirini görmez); alıcı başına "gönderiliyor" işareti', () => {
  const d = read('server/suppliers/dispatch.js');
  assert.match(d, /for \(const to of todo\)/);
  assert.match(d, /sendBrandedMail\(transport, \{ from, to, subject/);
  assert.doesNotMatch(d, /\bbcc\b|\bcc:/i);
  assert.ok(d.indexOf('sending: to } } })') < d.indexOf('sendBrandedMail(transport'));
});

// ---------------------------------------------------------------- M5
test('M5: tedarikçi kodu eksik satırlar bulunur; e-postada yalnızca tedarikçi kodu, INTRARE MARFĂ belgesinde iç kod', () => {
  assert.deepEqual(missingSupplierCodes([{ code: 'GK15', supplierCode: 'S-1' }, { code: 'MC12', supplierCode: '  ' }, { code: 'AD45', supplierCode: null }]), ['MC12', 'AD45']);
  assert.deepEqual(missingSupplierCodes([]), []);
  const d = read('server/suppliers/dispatch.js');
  assert.match(d, /code: \/\*\* @type \{string\} \*\/ \(l\.supplierCode\)/);
  assert.match(d, /missingSupplierCodes\(r\.lines\)\.length\) \{ await fail\('NO_SUPPLIER_CODE'\)/);
  assert.doesNotMatch(read('server/pdf/goods-receipt.js'), /supplierCode/);
  assert.doesNotMatch(read('server/suppliers/receipt-mail.js'), /supplierCode/);
  // Onayda üründen kopyalanır; eksikse onay yok
  const svc = read('server/suppliers/service.js');
  assert.match(svc, /if \(missing\.length\) return \{ ok: false, code: 'NO_SUPPLIER_CODE'/);
});

// ---------------------------------------------------------------- M2
test('M2: açılış bakiyesi ayrı alanda; kalan = açılış + borç − ödeme; iptal edilen sayılmaz; para birimleri ayrı', () => {
  const b = supplierBalances(
    [{ currency: 'EUR', status: 'GONDERILDI', total: '100.00' }],
    [{ currency: 'EUR', amount: '30.00' }],
    [{ currency: 'EUR', amount: '50.25' }, { currency: 'EUR', amount: '-10.00' }, { currency: 'EUR', amount: '999', voidedAt: new Date() }, { currency: 'RON', amount: '-7.50' }],
  );
  assert.deepEqual(b, {
    EUR: { opening: '40.25', debt: '100.00', paid: '30.00', balance: '110.25', orders: 1, missingPrice: 0 },
    RON: { opening: '-7.50', debt: '0.00', paid: '0.00', balance: '-7.50', orders: 0, missingPrice: 0 },
  });
  assert.equal(signedCents('-1.05'), -105n);
  assert.deepEqual(parseOpening({ amount: '1.234,5', currency: 'eur', direction: 'DEBT' }), { ok: false, code: 'AMOUNT' });
  assert.deepEqual(parseOpening({ amount: '1234,5', currency: 'eur', direction: 'CREDIT', note: ' devir ' }), { ok: true, value: { amount: '-1234.50', currency: 'EUR', note: 'devir' } });
  assert.deepEqual(parseOpening({ amount: '0', currency: 'EUR', direction: 'DEBT' }), { ok: false, code: 'AMOUNT' });
  assert.deepEqual(parseOpening({ amount: '5', currency: 'GBP', direction: 'DEBT' }), { ok: false, code: 'CURRENCY' });
  assert.deepEqual(parseOpening({ amount: '5', currency: 'EUR', direction: 'X' }), { ok: false, code: 'DIRECTION' });
});

test('M2: bakiye tek servisten — muhasebe ekranı, rapor ve asistan supplierAccounts kullanır', () => {
  assert.match(read('server/reports/service.js'), /await supplierAccounts\(tx\)/);
  assert.match(read('server/assistant/tools.js'), /await supplierAccounts\(tx\)/);
  assert.match(read('app/(panel)/admin/muhasebe/tedarikciler/page.tsx'), /supplierAccounts\(db\)/);
  // supplierBalances yalnızca servis tarafından çağrılır (ikinci bakiye formülü yok)
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(js|ts|tsx|mjs)$/.test(e.name) && /supplierBalances\(/.test(read(p))) users.push(p);
    }
  };
  for (const d of ['app', 'lib', 'server', 'components']) walk(d);
  assert.deepEqual(users.sort(), ['server/suppliers/rules.js', 'server/suppliers/service.js']);
});

// ---------------------------------------------------------------- M6
test('M6: nakliye formu — EUR ya da RON; RON için kayıtlı kur zorunlu; EUR karşılığı bir kez yuvarlanır', () => {
  const base = { carrierName: ' Trans SRL ', invoiceNo: 'F-1', amount: '500', receiptIds: ['rcpt000001'] };
  assert.deepEqual(parseTransport({ ...base, currency: 'EUR' }).value?.amountEur, '500.00');
  assert.deepEqual(parseTransport({ ...base, currency: 'RON' }), { ok: false, code: 'FX_REQUIRED' });
  assert.deepEqual(parseTransport({ ...base, currency: 'RON', fxRate: '0.5' }), { ok: false, code: 'FX_RATE' });
  assert.deepEqual(parseTransport({ ...base, currency: 'USD' }), { ok: false, code: 'CURRENCY' });
  assert.deepEqual(parseTransport({ ...base, currency: 'EUR', receiptIds: [] }), { ok: false, code: 'RECEIPTS' });
  const r = parseTransport({ ...base, currency: 'RON', fxRate: '4,9750', amount: '1000' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.value.fxRate, r.value.amountEur, r.value.carrierName], ['4.975', '201.01', 'Trans SRL']); // 1000 / 4.975 = 201.005 → 201.01
  assert.equal(ronToEurCents(100n, 5_000_000n), 20n);
});

test('M6: dağıtım — birim başına eşit pay, toplam kuruşu kuruşuna aynı (rastgele 500 tur), miktarsız satır pay almaz', () => {
  const a = allocateTransport('100.00', [{ receiptLineId: 'a', productId: 'p1', qty: 1 }, { receiptLineId: 'b', productId: 'p2', qty: 2 }, { receiptLineId: 'c', productId: 'p3', qty: 0 }]);
  assert.deepEqual(a.rows.map((r) => [r.receiptLineId, r.amountEur]), [['a', '33.3333'], ['b', '66.6667']]);
  assert.deepEqual(allocateTransport('10', [{ receiptLineId: 'a', productId: 'p', qty: 0 }]), { ok: false, code: 'NO_QTY' });
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 500; round++) {
    const lines = Array.from({ length: 1 + rnd(12) }, (_, i) => ({ receiptLineId: `l${i}`, productId: `p${rnd(4)}`, qty: 1 + rnd(400) }));
    const amount = `${rnd(100000)}.${String(rnd(100)).padStart(2, '0')}`;
    const res = allocateTransport(amount, lines);
    const sum = res.rows.reduce((n, r) => n + BigInt(r.amountEur.replace('.', '')), 0n);
    assert.equal(sum, BigInt(amount.replace('.', '')) * 100n, `tur ${round}`);
    // Birim başına pay farkı en çok 10⁻⁴ (eşit pay)
    const per = res.rows.map((r) => Number(r.amountEur) / r.qty);
    assert.ok(Math.max(...per) - Math.min(...per) < 0.0002 + 1e-9, `tur ${round}`);
  }
});

test('M6: stok maliyeti — ağırlıklı ortalama (farklı alış fiyatları, kısmi kabul, nakliye dahil); fiyatsız / EUR dışı satır uydurulmaz', () => {
  const lines = [
    { productId: 'p1', netQty: 10, unitPrice: '2.0000', currency: 'EUR' },
    { productId: 'p1', netQty: 30, unitPrice: '3.0000', currency: 'EUR' }, // kısmi kabulün net miktarı
    { productId: 'p1', netQty: 5, unitPrice: null, currency: 'EUR' },
    { productId: 'p2', netQty: 4, unitPrice: '10', currency: 'RON' },
  ];
  const allocs = [{ productId: 'p1', amountEur: '8.0000', counted: true }, { productId: 'p1', amountEur: '5.0000', counted: false }, { productId: 'p2', amountEur: '1', counted: false }];
  const c = stockCosts(lines, allocs);
  // (10×2 + 30×3 + 8) / 40 = 118 / 40 = 2.95
  assert.deepEqual(c.get('p1'), { avgEur: '2.95', qty: 40, valueEur: '118.00', transportEur: '8.00', missingQty: 5 });
  assert.deepEqual(c.get('p2'), { avgEur: null, qty: 0, valueEur: '0.00', transportEur: '0.00', missingQty: 4 });
  // Nakliye iki kez sayılmaz: aynı dağıtım bir kez girilir
  assert.equal(stockCosts(lines, [allocs[0]]).get('p1').avgEur, '2.95');
});

test('M6: ticari teklif maliyeti — önce gerçekleşen stok maliyeti, yoksa katalog alış; ikisi ayrı döner', () => {
  const prod = { listPrice: '10', purchasePrice: '4', purchaseCurrency: 'EUR', unitCode: 'BUCATI' };
  assert.deepEqual(profileDefaults(prod), { price: '10.00', cost: '4.00', costSource: 'CATALOG', stockCost: null, catalogCost: '4.00' });
  assert.deepEqual(profileDefaults({ ...prod, stockCostEur: '4.4567' }), { price: '10.00', cost: '4.4567', costSource: 'STOCK', stockCost: '4.4567', catalogCost: '4.00' });
  // Metreyle fiyatlanan: €/ML
  assert.equal(profileDefaults({ ...prod, unitCode: 'BARA', packMeasure: 'M', packContent: '6', stockCostEur: '30' }).stockCost, '5.00');
});

test('M6: taşıyıcı bakiyesi ürün tedarikçisinden ayrı; iptal sayılmaz; para birimleri ayrı', () => {
  assert.deepEqual(carrierBalances([
    { carrierName: 'A', currency: 'EUR', amount: '100', paidOn: null }, { carrierName: 'A', currency: 'EUR', amount: '50', paidOn: new Date() },
    { carrierName: 'A', currency: 'RON', amount: '20' }, { carrierName: 'B', currency: 'EUR', amount: '9', voidedAt: new Date() },
  ]), [
    { carrier: 'A', currency: 'EUR', total: '150.00', paid: '50.00', open: '100.00', count: 2 },
    { carrier: 'A', currency: 'RON', total: '20.00', paid: '0.00', open: '20.00', count: 1 },
  ]);
  // Nakliye stok hareketi yazmaz, tedarikçi borcuna girmez
  const src = read('server/suppliers/costs.js');
  assert.doesNotMatch(src, /stockMovement|supplierPayment|supplierOrder\.update/);
});

test('M9: sunucu reddi (4xx / 5xx) belirsiz değil, bağlantı hatası değil; etkin geçersiz adres onayı durdurur', async () => {
  const { refusedMail, recipientProblem, definitelyNotSent } = await import('../server/suppliers/rules.js');
  assert.equal(refusedMail({ responseCode: 550, command: 'RCPT TO' }), true);
  assert.equal(refusedMail({ responseCode: 451, command: 'DATA' }), true);
  assert.equal(refusedMail({ responseCode: 550, command: 'CONN' }), false, 'bağlantı aşaması: yeniden denenir');
  assert.equal(refusedMail({ code: 'ETIMEDOUT' }), false, 'yanıt kodu yok: belirsiz');
  assert.equal(refusedMail({ responseCode: 250 }), false);
  assert.equal(definitelyNotSent({ responseCode: 550, command: 'RCPT TO' }), false);
  assert.equal(recipientProblem([]), 'NO_EMAIL');
  assert.equal(recipientProblem([{ email: 'a@b.test', isActive: false }]), 'NO_EMAIL');
  assert.equal(recipientProblem([{ email: 'a@b.test', isActive: true }, { email: 'bozuk adres', isActive: true }]), 'BAD_EMAIL');
  assert.equal(recipientProblem([{ email: 'a@b.test', isActive: true }, { email: 'bozuk adres', isActive: false }]), null);
});
