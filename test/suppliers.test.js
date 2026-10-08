// Paket 6 (kararlar 179–184) — tedarik ve satın alma: saf kurallar, para hesabı, merkezi Türkçe tedarikçi e-postası,
// yetki (veritabanına dokunmadan FORBIDDEN) ve yapı denetimleri. Veritabanı davranışı: test/db/suppliers.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEBT_STATUSES, FILE_LIMITS, OPEN_STATUSES, addDays, catalogPrice, cleanOrderNo, definitelyNotSent, etaReminderDue, etaReminderKey,
  expectedSupply, lineTotal, nameKey, orderTotals, orderUnitOf, parseLines, parsePrice, parsePurchase, parseSupplier, showPrices,
  suggestOrderNo, supplierBalances, supplierEmail, supplierOrderActions,
} from '../server/suppliers/rules.js';
import * as money from '../server/suppliers/money.js';
import { SUPPLIER_EMAIL_TEXT, renderSupplierOrderEmail } from '../server/mail/templates/supplier-order.js';
import { MAIL_LOGO_CID, sendBrandedMail } from '../server/mail/send.js';
import * as service from '../server/suppliers/service.js';
import { can } from '../server/auth/permissions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------------------------------------------------------------
// Tedarikçi (Ayarlar → Tedarikçiler — karar 179)
// ---------------------------------------------------------------------------------------------------------------------

test('tedarikçi formu: ad zorunlu, e-posta isteğe bağlı ama girildiyse TEK geçerli adres, para birimi listeden', () => {
  const ok = parseSupplier({ name: '  Profil  Tedarik A.Ş. ', email: ' siparis@profil.test ', currency: 'eur', phone: '', address: 'Cad. 1\r\nİstanbul' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.value, { name: 'Profil Tedarik A.Ş.', contactName: null, email: 'siparis@profil.test', phone: null, address: 'Cad. 1\nİstanbul', currency: 'EUR', isActive: true });
  // E-posta boş bırakılabilir (gönderim o zaman engellenir)
  assert.equal(parseSupplier({ name: 'X', email: '', currency: 'RON' }).ok, true);
  assert.deepEqual(parseSupplier({ name: '', email: 'a@b.test', currency: 'EUR' }), { ok: false, errors: ['NAME'] });
  assert.deepEqual(parseSupplier({ name: 'X', email: 'yanlış', currency: 'EUR' }), { ok: false, errors: ['EMAIL'] });
  assert.deepEqual(parseSupplier({ name: 'X', email: 'a@b.test', currency: 'GBP' }), { ok: false, errors: ['CURRENCY'] });
  assert.deepEqual(parseSupplier({ name: 'x'.repeat(121), currency: 'EUR' }), { ok: false, errors: ['TOO_LONG'] });
  assert.equal(parseSupplier({ name: 'X', currency: 'EUR', isActive: false }).ok && parseSupplier({ name: 'X', currency: 'EUR', isActive: false }).value.isActive, false);
  // Başka alıcı eklenemez: virgül, noktalı virgül, ad + açılı ayraç, boşluk, satır sonu reddedilir
  for (const bad of ['a@b.test,c@d.test', 'a@b.test;c@d.test', 'Ali <a@b.test>', 'a b@c.test', 'a@b.test\nBcc: x@y.test', 'a@b', '@b.test', 'a@b.test"']) {
    assert.equal(supplierEmail(bad), null, bad);
  }
  assert.equal(supplierEmail(`${'a'.repeat(195)}@b.test`), null, 'en çok 200 karakter');
  assert.equal(supplierEmail('  Siparis@Firma.test '), 'Siparis@Firma.test');
});

test('tedarikçi adı karşılaştırması: büyük / küçük harf ve Türkçe noktalı / noktasız I ayrımı yok', () => {
  assert.equal(nameKey('ışık profil'), nameKey('IŞIK PROFİL'));
  assert.equal(nameKey('İzmir Conta'), nameKey('izmir conta'));
  assert.equal(nameKey(' Aynı   Firma '), nameKey('aynı firma'));
  assert.notEqual(nameKey('Firma A'), nameKey('Firma B'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Para hesabı (tek uygulama — server/suppliers/money.js)
// ---------------------------------------------------------------------------------------------------------------------

test('alış fiyatı: boş = fiyat yok (uydurulmaz); 0 … 1.000.000, en çok 4 ondalık; virgül ve binlik nokta', () => {
  assert.deepEqual(parsePrice(''), { ok: true, value: null });
  assert.deepEqual(parsePrice('   '), { ok: true, value: null });
  assert.deepEqual(parsePrice('12,5'), { ok: true, value: '12.5' });
  assert.deepEqual(parsePrice('12.5000'), { ok: true, value: '12.5' });
  assert.deepEqual(parsePrice('1.234,5678'), { ok: true, value: '1234.5678' });
  assert.deepEqual(parsePrice('0'), { ok: true, value: '0' });
  assert.deepEqual(parsePrice('1000000'), { ok: true, value: '1000000' });
  for (const bad of ['-1', '1000000.0001', '1,23456', 'abc', '1e3', '12,5 EUR', 'NaN', 'Infinity']) assert.deepEqual(parsePrice(bad), { ok: false }, bad);
  // 4 ondalığı aşan kısım yalnızca sıfırsa kabul
  assert.deepEqual(parsePrice('2.500000'), { ok: true, value: '2.5' });
});

test('satır tutarı ve sipariş toplamı: kayan noktasız, satır başına bir kez yarım-yukarı; toplam = yuvarlanmış satırların toplamı', () => {
  assert.equal(lineTotal(3, '12.345'), '37.04'); // 37.035 → 37.04
  assert.equal(lineTotal(1, '0.005'), '0.01');
  assert.equal(lineTotal(1, '0.0049'), '0.00');
  assert.equal(lineTotal(7, '0.1'), '0.70'); // 0.1 × 7 kayan noktada 0.7000000000000001
  assert.equal(lineTotal(100000, '1000000'), '100000000000.00');
  assert.equal(lineTotal(2, null), null);
  assert.equal(lineTotal(2, ''), null);
  const t = orderTotals([{ qty: 3, unitPrice: '12.345' }, { qty: 2, unitPrice: '1.005' }, { qty: 5, unitPrice: null }]);
  assert.deepEqual(t, { total: '39.05', missingPrice: true, priced: 2, count: 3 });
  assert.deepEqual(orderTotals([]), { total: '0.00', missingPrice: false, priced: 0, count: 0 });
  // Sunucu kuralı ile tarayıcıdaki düzenleyicinin kuralı aynı modüldür
  assert.equal(money.lineTotal, lineTotal);
  assert.equal(money.orderTotals, orderTotals);
  // Rastgele miktar / fiyat: tam sayı kuruş hesabıyla birebir
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const qty = 1 + rnd(100000);
    const p4 = BigInt(rnd(10_000_000_0)); // 0 … 9.999.999,9999 / 10 → 0 … 1.000.000 aralığında 4 ondalık
    const price = money.fromScaled(p4, 4);
    const want = (BigInt(qty) * p4 + 50n) / 100n;
    assert.equal(lineTotal(qty, price), money.fromScaled(want, 2, 2), `${qty} × ${price}`);
  }
});

test('e-postada fiyat sütunları yalnızca HER satırın fiyatı varsa', () => {
  assert.equal(showPrices([{ unitPrice: '1' }, { unitPrice: '0' }]), true);
  assert.equal(showPrices([{ unitPrice: '1' }, { unitPrice: null }]), false);
  assert.equal(showPrices([{ unitPrice: '1' }, { unitPrice: '' }]), false);
  assert.equal(showPrices([]), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Ürün–tedarikçi ilişkisi ve satırlar (karar 180–181)
// ---------------------------------------------------------------------------------------------------------------------

const P = (o = {}) => ({
  id: 'p1', code: 'GK15', nameTr: 'GK15 conta', nameRo: 'Garnitură GK15', unitCode: 'CUTII', isActive: true, category: { isActive: true },
  supplierId: 's1', purchasePrice: '12.5', purchaseCurrency: 'EUR', purchaseUnit: null, ...o,
});
const ORDER = { supplierId: 's1', currency: 'EUR' };

test('kayıtlı alış fiyatı siparişe yalnızca aynı tedarikçi VE aynı para biriminde gelir (kur çevrilmez, başka tedarikçinin fiyatı alınmaz)', () => {
  assert.equal(catalogPrice(P(), ORDER), '12.5');
  assert.equal(catalogPrice(P({ supplierId: 's2' }), ORDER), null);
  assert.equal(catalogPrice(P({ purchaseCurrency: 'RON' }), ORDER), null);
  assert.equal(catalogPrice(P({ purchasePrice: null }), ORDER), null);
  assert.equal(catalogPrice(P({ supplierId: null }), ORDER), null);
  assert.equal(orderUnitOf(P()), 'CUTII');
  assert.equal(orderUnitOf(P({ purchaseUnit: 'BUCATI' })), 'BUCATI');
  assert.equal(orderUnitOf(P({ purchaseUnit: 'KG' })), 'CUTII', 'bilinmeyen birim → satış birimi');
});

test('alış bilgisi formu: fiyat girildiyse para birimi zorunlu; birim listeden; boş = tanımsız', () => {
  assert.deepEqual(parsePurchase({ supplierId: 's1', price: '12,5', currency: 'eur', unit: '' }),
    { ok: true, value: { supplierId: 's1', purchasePrice: '12.5', purchaseCurrency: 'EUR', purchaseUnit: null } });
  assert.deepEqual(parsePurchase({ supplierId: '', price: '', currency: '', unit: '' }),
    { ok: true, value: { supplierId: null, purchasePrice: null, purchaseCurrency: null, purchaseUnit: null } });
  assert.deepEqual(parsePurchase({ supplierId: 's1', price: '5', currency: '', unit: '' }), { ok: false, code: 'PURCHASE_CURRENCY' });
  assert.deepEqual(parsePurchase({ supplierId: 's1', price: '-5', currency: 'EUR', unit: '' }), { ok: false, code: 'PURCHASE_PRICE' });
  assert.deepEqual(parsePurchase({ supplierId: 's1', price: '5', currency: 'GBP', unit: '' }), { ok: false, code: 'PURCHASE_CURRENCY' });
  assert.deepEqual(parsePurchase({ supplierId: 's1', price: '5', currency: 'EUR', unit: 'KG' }), { ok: false, code: 'PURCHASE_UNIT' });
});

test('satırlar: sunucu doğrular; açıklama boşsa Türkçe ad; birim boşsa sipariş birimi; fiyatın kaynağı sunucuda (CATALOG / MANUAL)', () => {
  const products = [P(), P({ id: 'p2', code: 'MC12', nameTr: 'MC12 conta', purchasePrice: null, purchaseUnit: 'BUCATI' }), P({ id: 'p3', code: 'ESKI', isActive: false })];
  const r = parseLines([
    { productId: 'p1', qty: '10', unitPrice: '12,5', color: ' RAL 7016 ' },
    { productId: 'p1', qty: '2', unitPrice: '13', description: 'Özel kesim' },
    { productId: 'p2', qty: '3', unitPrice: '' },
  ], { products, order: ORDER });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.lines, [
    { productId: 'p1', code: 'GK15', description: 'GK15 conta', color: 'RAL 7016', qty: 10, unitCode: 'CUTII', unitPrice: '12.5', priceSource: 'CATALOG', lineTotal: '125.00', sortOrder: 0 },
    { productId: 'p1', code: 'GK15', description: 'Özel kesim', color: null, qty: 2, unitCode: 'CUTII', unitPrice: '13', priceSource: 'MANUAL', lineTotal: '26.00', sortOrder: 1 },
    { productId: 'p2', code: 'MC12', description: 'MC12 conta', color: null, qty: 3, unitCode: 'BUCATI', unitPrice: null, priceSource: null, lineTotal: null, sortOrder: 2 },
  ]);
  // Tarayıcıdan gelen "priceSource" / "lineTotal" / "code" yok sayılır (sunucu hesaplar)
  const forged = parseLines([{ productId: 'p1', qty: '1', unitPrice: '99', priceSource: 'CATALOG', lineTotal: '1', code: 'X' }], { products, order: ORDER });
  assert.deepEqual(forged.ok && [forged.lines[0].priceSource, forged.lines[0].lineTotal, forged.lines[0].code], ['MANUAL', '99.00', 'GK15']);
  const bad = (rows, code, index) => assert.deepEqual(parseLines(rows, { products, order: ORDER }), { ok: false, code, index });
  bad([{ productId: 'yok', qty: '1' }], 'PRODUCT', 0);
  bad([{ productId: 'p1', qty: '1' }, { productId: 'p3', qty: '1' }], 'PRODUCT_INACTIVE', 1);
  for (const q of ['0', '-1', '1.5', '100001', '', 'abc', '1e3']) bad([{ productId: 'p1', qty: q }], 'QTY', 0);
  bad([{ productId: 'p1', qty: '1', unitPrice: '-3' }], 'PRICE', 0);
  bad([{ productId: 'p1', qty: '1', unitCode: 'KG' }], 'UNIT', 0);
  bad([{ productId: 'p1', qty: '1', color: 'x'.repeat(41) }], 'TOO_LONG', 0);
  assert.deepEqual(parseLines('[]', { products, order: ORDER }), { ok: false, code: 'LINES' });
  assert.deepEqual(parseLines(Array.from({ length: 201 }, () => ({ productId: 'p1', qty: '1' })), { products, order: ORDER }), { ok: false, code: 'LINES' });
  assert.deepEqual(parseLines([null], { products, order: ORDER }), { ok: false, code: 'LINES', index: 0 });
  // Kategorisi pasif ürün de eklenemez
  assert.deepEqual(parseLines([{ productId: 'p1', qty: '1' }], { products: [P({ category: { isActive: false } })], order: ORDER }), { ok: false, code: 'PRODUCT_INACTIVE', index: 0 });
});

test('sipariş numarası: önerilen TS-<yıl>-<sıra>; yönetici değiştirebilir (harf, rakam, - / . _)', () => {
  assert.equal(suggestOrderNo([], 2026), 'TS-2026-001');
  assert.equal(suggestOrderNo(['TS-2026-001', 'TS-2026-009', 'TS-2025-120', 'OZEL-1'], 2026), 'TS-2026-010');
  assert.equal(suggestOrderNo(['TS-2026-999'], 2026), 'TS-2026-1000');
  assert.equal(cleanOrderNo(' ts 2026 7 '), 'TS-2026-7');
  assert.equal(cleanOrderNo('GKH/2026.15_a'), 'GKH/2026.15_A');
  for (const bad of ['', '-X', 'A'.repeat(31), 'A<B', 'Ş-1']) assert.equal(cleanOrderNo(bad), null, bad);
});

// ---------------------------------------------------------------------------------------------------------------------
// Durum ve işlemler
// ---------------------------------------------------------------------------------------------------------------------

test('işlem matrisi: taslak düzenlenir / onaylanır; açık sipariş tarih, teslim, iptal, revizyon; tekrar gönderim yalnızca hata + kuyruk boş', () => {
  assert.deepEqual(supplierOrderActions({ status: 'TASLAK', hasDraft: true }), ['save_draft', 'files', 'approve_send', 'delete_draft']);
  assert.deepEqual(supplierOrderActions({ status: 'GONDERILDI', hasDraft: false }), ['set_eta', 'mark_received', 'cancel', 'start_revision']);
  assert.deepEqual(supplierOrderActions({ status: 'GONDERILDI', hasDraft: true }), ['set_eta', 'mark_received', 'cancel', 'save_draft', 'files', 'approve_send', 'discard_revision']);
  assert.ok(supplierOrderActions({ status: 'GONDERIM_HATASI', hasDraft: false }).includes('resend'));
  assert.ok(!supplierOrderActions({ status: 'GONDERIM_HATASI', hasDraft: false, pendingJob: true }).includes('resend'));
  assert.ok(!supplierOrderActions({ status: 'GONDERIM_BEKLIYOR', hasDraft: false }).includes('resend'));
  assert.deepEqual(supplierOrderActions({ status: 'TESLIM_ALINDI', hasDraft: false }), []);
  assert.deepEqual(supplierOrderActions({ status: 'IPTAL', hasDraft: false }), []);
  // Taslak borç doğurmaz; iptal borçtan düşer; beklenen tedarik yalnızca açık siparişlerde
  assert.ok(!DEBT_STATUSES.includes('TASLAK') && !DEBT_STATUSES.includes('IPTAL'));
  assert.deepEqual(OPEN_STATUSES, ['GONDERIM_BEKLIYOR', 'GONDERILDI', 'GONDERIM_HATASI']);
});

test('otomatik yeniden deneme yalnızca e-posta sunucusuna HİÇ bağlanılamadığında (ileti kesinlikle gitmedi)', () => {
  assert.equal(definitelyNotSent({ command: 'CONN', code: 'ECONNREFUSED' }), true);
  for (const e of [{ command: 'DATA', responseCode: 451 }, { command: 'AUTH PLAIN', responseCode: 535 }, { command: 'RCPT TO', responseCode: 550 }, { code: 'ETIMEDOUT' }, new Error('x'), null]) {
    assert.equal(definitelyNotSent(e), false, JSON.stringify(e));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Tahmini yükleme tarihi hatırlatması (karar 183)
// ---------------------------------------------------------------------------------------------------------------------

test('hatırlatma: tarihten 2 takvim günü önce (ve tarih geçene kadar); anahtar sipariş + tarih — tarih değişince yenisi', () => {
  assert.equal(addDays('2026-10-08', 2), '2026-10-10');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-29', -2), '2026-03-27'); // yaz saati geçişi
  const due = (today, etaDay) => etaReminderDue({ etaDay, today });
  assert.equal(due('2026-10-07', '2026-10-10'), false);
  assert.equal(due('2026-10-08', '2026-10-10'), true);
  assert.equal(due('2026-10-09', '2026-10-10'), true);
  assert.equal(due('2026-10-10', '2026-10-10'), true);
  assert.equal(due('2026-10-11', '2026-10-10'), false, 'tarih geçti');
  assert.equal(due('2026-10-08', null), false);
  assert.equal(etaReminderKey('o1', '2026-10-10'), 'supplier-eta:o1:2026-10-10');
  assert.notEqual(etaReminderKey('o1', '2026-10-10'), etaReminderKey('o1', '2026-10-12'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Hesap (karar 182) ve beklenen tedarik (karar 184)
// ---------------------------------------------------------------------------------------------------------------------

test('hesap: para birimi başına borç / ödeme / kalan; taslak ve iptal borç değil; iptal ödeme düşülmez; para birimleri toplanmaz', () => {
  const b = supplierBalances([
    { currency: 'EUR', status: 'GONDERILDI', total: '100.10' },
    { currency: 'EUR', status: 'TESLIM_ALINDI', total: '0.20', missingPrice: true },
    { currency: 'EUR', status: 'GONDERIM_HATASI', total: '1.00' },
    { currency: 'EUR', status: 'TASLAK', total: '999' },
    { currency: 'EUR', status: 'IPTAL', total: '50' },
    { currency: 'USD', status: 'GONDERIM_BEKLIYOR', total: '10' },
  ], [
    { currency: 'EUR', amount: '30.05' },
    { currency: 'EUR', amount: '500', voidedAt: new Date() },
    { currency: 'RON', amount: '7' },
  ]);
  assert.deepEqual(b, {
    EUR: { debt: '101.30', paid: '30.05', balance: '71.25', orders: 3, missingPrice: 1 },
    RON: { debt: '0.00', paid: '7.00', balance: '-7.00', orders: 0, missingPrice: 0 },
    USD: { debt: '10.00', paid: '0.00', balance: '10.00', orders: 1, missingPrice: 0 },
  });
  assert.deepEqual(supplierBalances([], []), {});
});

test('beklenen tedarik: yalnızca açık siparişler; stok birimindeki miktar toplanır, başka birim ayrı (çevrilmez)', () => {
  const units = new Map([['p1', 'CUTII'], ['p2', 'BUCATI']]);
  const m = expectedSupply([
    { status: 'GONDERILDI', lines: [{ productId: 'p1', qty: 5, unitCode: 'CUTII' }, { productId: 'p1', qty: 2, unitCode: 'BUCATI' }] },
    { status: 'GONDERIM_BEKLIYOR', lines: [{ productId: 'p1', qty: 3, unitCode: 'CUTII' }, { productId: 'p2', qty: 4, unitCode: 'BUCATI' }] },
    { status: 'TESLIM_ALINDI', lines: [{ productId: 'p1', qty: 100, unitCode: 'CUTII' }] },
    { status: 'IPTAL', lines: [{ productId: 'p2', qty: 100, unitCode: 'BUCATI' }] },
    { status: 'TASLAK', lines: [{ productId: 'p2', qty: 100, unitCode: 'BUCATI' }] },
  ], units);
  assert.deepEqual(m.get('p1'), { qty: 8, other: [{ unitCode: 'BUCATI', qty: 2 }], orders: 2 });
  assert.deepEqual(m.get('p2'), { qty: 4, other: [], orders: 1 });
});

// ---------------------------------------------------------------------------------------------------------------------
// Merkezi Türkçe tedarikçi e-postası (karar 181)
// ---------------------------------------------------------------------------------------------------------------------

const MAIL = {
  orderNo: 'TS-2026-007', supplierName: 'Işık Profil Ürünleri Ltd. Şti.', orderDate: '2026-10-08', revision: 1, currency: 'EUR',
  lines: [
    { code: 'GK15', description: 'Çift dudaklı cam contası', color: 'RAL 7016', qty: 12, unit: 'kutu', unitPrice: '12.5', lineTotal: '150.00' },
    { code: 'MC12', description: 'Küpeşte <özel> & "kesim"', color: null, qty: 3, unit: 'adet', unitPrice: '1234.5678', lineTotal: '3703.70' },
  ],
  showPrices: true, total: '3853.70', note: 'Yükleme öncesi arayınız.\nTeşekkürler.', attachments: ['teknik-çizim.pdf'],
};

test('e-posta: konu tam biçimde; Türkçe metinler eksiksiz ve doğru karakterlerle; sütun sırası; not tablonun altında; kapanış', () => {
  const m = renderSupplierOrderEmail(MAIL);
  assert.equal(m.subject, 'GKH Trading Invest – Sipariş TS-2026-007 – Işık Profil Ürünleri Ltd. Şti.');
  assert.equal(renderSupplierOrderEmail({ ...MAIL, revision: 2 }).subject, 'GKH Trading Invest – Sipariş TS-2026-007 – Işık Profil Ürünleri Ltd. Şti. – Revizyon 2');
  // Metin sırası (düz metin)
  const order = ['Merhaba,', 'Aşağıda detayları bulunan siparişimizi bilgilerinize sunarız.', 'Sipariş No: TS-2026-007', 'Sipariş Tarihi: 08.10.2026',
    'Tedarikçi: Işık Profil Ürünleri Ltd. Şti.', 'Ürün Kodu | Açıklama | Renk/RAL | Miktar | Birim | Birim Fiyat | Toplam',
    'GK15 | Çift dudaklı cam contası | RAL 7016 | 12 | kutu | 12,50 EUR | 150,00 EUR', 'MC12 | Küpeşte <özel> & "kesim" | — | 3 | adet | 1.234,5678 EUR | 3.703,70 EUR',
    'Genel Toplam: 3.853,70 EUR', 'Sipariş Notu:', 'Yükleme öncesi arayınız.', 'Ekler: teknik-çizim.pdf',
    'Siparişimizin tarafınıza ulaştığını ve tahmini yükleme tarihini teyit etmenizi rica ederiz.', 'İyi çalışmalar dileriz.', 'GKH Trading Invest SRL'];
  let at = -1;
  for (const s of order) {
    const i = m.text.indexOf(s, at + 1);
    assert.ok(i > at, `düz metinde sıra: ${s}`);
    at = i;
  }
  // HTML: aynı metinler, sütun başlıkları sırayla, kaçışlama, logo üstte
  const h = m.html;
  const cols = ['Ürün Kodu', 'Açıklama', 'Renk/RAL', 'Miktar', 'Birim', 'Birim Fiyat', 'Toplam'];
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(h)?.[1] ?? '';
  assert.deepEqual([...thead.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1]), cols);
  assert.ok(h.includes('Küpeşte &lt;özel&gt; &amp; &quot;kesim&quot;'), 'açıklama kaçışlanır');
  assert.ok(!h.includes('<özel>'));
  assert.ok(h.indexOf(`cid:${MAIL_LOGO_CID}`) > 0 && h.indexOf(`cid:${MAIL_LOGO_CID}`) < h.indexOf('Merhaba,'), 'logo gövdeden önce');
  assert.ok(h.indexOf('</table>', h.indexOf('<thead>')) < h.indexOf('Sipariş Notu'), 'not tablonun altında');
  assert.ok(h.indexOf('Sipariş Notu') < h.indexOf(SUPPLIER_EMAIL_TEXT.closing), 'kapanış en sonda');
  for (const s of [SUPPLIER_EMAIL_TEXT.greeting, SUPPLIER_EMAIL_TEXT.intro, SUPPLIER_EMAIL_TEXT.closing, SUPPLIER_EMAIL_TEXT.regards, SUPPLIER_EMAIL_TEXT.company, '3.853,70 EUR', '08.10.2026']) {
    assert.ok(h.includes(s), s);
  }
  // Türkçe karakterler bozulmaz (ne düz metinde ne HTML'de mojibake / varlık kodu)
  for (const ch of ['ş', 'ı', 'İ', 'ğ', 'ü', 'ö', 'ç', 'Ş', 'Ü']) assert.ok(m.text.includes(ch) && h.includes(ch), ch);
  assert.ok(!/Ã|Ä±|Å|&#[0-9]+;/.test(m.text + h.replace(/&#39;/g, '')), 'bozuk karakter yok');
  assert.match(h, /<html lang="tr">/);
  assert.match(h, /<meta charset="utf-8">/);
});

test('e-posta: fiyatı olmayan satır varsa fiyat sütunları ve genel toplam boş bırakılmaz, tamamen kaldırılır', () => {
  const lines = [MAIL.lines[0], { ...MAIL.lines[1], unitPrice: null, lineTotal: null }];
  const m = renderSupplierOrderEmail({ ...MAIL, lines, showPrices: showPrices(lines), total: null });
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(m.html)?.[1] ?? '';
  assert.deepEqual([...thead.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1]), ['Ürün Kodu', 'Açıklama', 'Renk/RAL', 'Miktar', 'Birim']);
  for (const s of ['Birim Fiyat', 'Genel Toplam', '12,50', '150,00', 'EUR']) {
    assert.ok(!m.html.includes(s) && !m.text.includes(s), `fiyat izi yok: ${s}`);
  }
  assert.ok(m.text.includes('Ürün Kodu | Açıklama | Renk/RAL | Miktar | Birim\n'));
  assert.ok(m.text.includes('GK15 | Çift dudaklı cam contası | RAL 7016 | 12 | kutu\n'));
  // Not ve ek yoksa o bölümler de yazılmaz
  const bare = renderSupplierOrderEmail({ ...MAIL, note: '  ', attachments: [] });
  assert.ok(!bare.text.includes('Sipariş Notu') && !bare.html.includes('Sipariş Notu') && !bare.text.includes('Ekler:'));
});

test('e-posta ortak gönderim noktasından gider: logo satır içi ek (en sonda), teknik ekler önde, gönderen resmî firma adı', async () => {
  const sent = [];
  const transport = { sendMail: async (msg) => { sent.push(msg); return { messageId: 'x' }; } };
  const m = renderSupplierOrderEmail(MAIL);
  await sendBrandedMail(transport, { from: 'siparis@gkh.test', to: 'tedarik@profil.test', subject: m.subject, text: m.text, html: m.html, lang: 'tr', attachments: [{ filename: 'teknik-çizim.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }] });
  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.equal(msg.from, 'GKH Trading Invest SRL <siparis@gkh.test>');
  assert.equal(msg.to, 'tedarik@profil.test');
  assert.equal(msg.html, m.html, 'şablon zaten ortak düzende (yeniden sarılmaz)');
  assert.deepEqual(msg.attachments.map((a) => a.filename), ['teknik-çizim.pdf', msg.attachments[1].filename]);
  assert.equal(msg.attachments[1].cid, MAIL_LOGO_CID);
  assert.equal(msg.attachments[1].contentType, 'image/png', 'saydam PNG logo (JPEG değil)');
});

// ---------------------------------------------------------------------------------------------------------------------
// Yetki: yönetici dışı her rol veritabanına HİÇ dokunmadan reddedilir
// ---------------------------------------------------------------------------------------------------------------------

test('yetki: SUPPLIER_MANAGE yalnızca yönetici; diğer roller (denetimci dahil) her işlemde FORBIDDEN, veritabanına dokunulmaz', async () => {
  assert.equal(can('ADMIN', 'SUPPLIER_MANAGE'), true);
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) assert.equal(can(role, 'SUPPLIER_MANAGE'), false, role);
  const touched = [];
  const db = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); throw new Error(`veritabanına dokunuldu: ${String(k)}`); } });
  const calls = {
    saveSupplier: (a) => service.saveSupplier(db, { name: 'X', currency: 'EUR' }, a),
    setSupplierActive: (a) => service.setSupplierActive(db, { id: 's', active: false }, a),
    createDraftOrder: (a) => service.createDraftOrder(db, { supplierId: 's' }, a),
    saveDraft: (a) => service.saveDraft(db, { orderId: 'o', version: 0, orderDate: '2026-10-08', lines: [] }, a),
    fileQuota: (a) => service.fileQuota(db, { orderId: 'o', files: [] }, a),
    attachFiles: (a) => service.attachFiles(db, { orderId: 'o', stored: [] }, a),
    removeFile: (a) => service.removeFile(db, { orderId: 'o', fileId: 'f' }, a),
    approveAndSend: (a) => service.approveAndSend(db, { orderId: 'o', version: 0 }, a),
    resendOrder: (a) => service.resendOrder(db, { orderId: 'o' }, a),
    startRevision: (a) => service.startRevision(db, { orderId: 'o', version: 0 }, a),
    discardRevision: (a) => service.discardRevision(db, { orderId: 'o' }, a),
    deleteDraftOrder: (a) => service.deleteDraftOrder(db, { orderId: 'o' }, a),
    setEta: (a) => service.setEta(db, { orderId: 'o', eta: '2026-10-20' }, a),
    markReceived: (a) => service.markReceived(db, { orderId: 'o' }, a),
    cancelOrder: (a) => service.cancelOrder(db, { orderId: 'o', reason: 'x' }, a),
    addPayment: (a) => service.addPayment(db, { supplierId: 's', paidOn: '2026-10-01', amount: '1', currency: 'EUR', requestKey: 'k'.repeat(20) }, a),
    voidPayment: (a) => service.voidPayment(db, { paymentId: 'p', reason: 'x' }, a),
  };
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', undefined]) {
    for (const [name, fn] of Object.entries(calls)) {
      assert.deepEqual(await fn(role ? { id: 'u', role } : null), { ok: false, code: 'FORBIDDEN' }, `${role} ${name}`);
    }
  }
  assert.deepEqual(touched, []);
  // Değiştiren her dışa açık servis işlevi bu listededir (yeni işlev yetki denetimiyle eklenir)
  const src = strip(read('server/suppliers/service.js'));
  const exported = [...src.matchAll(/export async function (\w+)\(db, [^)]*actor/g)].map((x) => x[1]).sort();
  assert.deepEqual(exported, Object.keys(calls).sort());
  for (const name of exported) {
    const body = src.slice(src.indexOf(`export async function ${name}(`));
    const first = body.slice(body.indexOf(') {\n') + 4).trim().split('\n')[0];
    assert.equal(first, 'if (!allowed(actor)) return FORBIDDEN;', `${name}: ilk satır yetki denetimi`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Yapı: tek gönderim yolu, merkezi şablon, stok yazılmaz, sayfalar yönetici yetkisi ister
// ---------------------------------------------------------------------------------------------------------------------

const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(js|mjs|ts|tsx)$/.test(e.name) ? [p.split(path.sep).join('/')] : [];
});
const CODE = ['app', 'lib', 'server', 'components', 'scripts'].flatMap(walk);

test('tek gönderim yolu: e-posta işi yalnızca "onayla / gönder" ve açık "Tekrar gönder"de kuyruğa yazılır; yalnızca işçi gönderir; şablon tek', () => {
  const svc = strip(read('server/suppliers/service.js'));
  assert.equal((svc.match(/notificationOutbox\.create\(/g) ?? []).length, 2, 'iki yazma noktası: approveAndSend + resendOrder');
  for (const fn of ['approveAndSend', 'resendOrder']) {
    const body = svc.slice(svc.indexOf(`export async function ${fn}(`), svc.indexOf('\n}\n', svc.indexOf(`export async function ${fn}(`)));
    assert.match(body, /notificationOutbox\.create\(\{\s*data: \{ type: SUPPLIER_EMAIL/, fn);
  }
  // Taslak kaydı, ek, tarih, teslim, iptal, revizyon: kuyruğa iş yazmaz
  for (const fn of ['saveDraft', 'attachFiles', 'removeFile', 'setEta', 'markReceived', 'startRevision', 'discardRevision', 'createDraftOrder', 'cancelOrder']) {
    const start = svc.indexOf(`export async function ${fn}(`);
    const body = svc.slice(start, svc.indexOf('\n}\n', start));
    assert.ok(!/notificationOutbox\.create|sendBrandedMail|sendMail/.test(body), `${fn} e-posta işi yazmaz`);
  }
  // Tür adını yalnızca servis (yazma, okuma) ve işçi (gönderim) kullanır; şablonu yalnızca işçi çağırır
  // (sözlükler hariç: geçmiş satırlarının adları "SUPPLIER_ORDER_EMAIL_SENT" gibi metin anahtarlarıdır)
  const users = CODE.filter((f) => !f.startsWith('server/i18n/') && /SUPPLIER_ORDER_EMAIL\b|SUPPLIER_EMAIL\b/.test(strip(read(f)))).sort();
  assert.deepEqual(users, ['server/suppliers/dispatch.js', 'server/suppliers/service.js']);
  assert.deepEqual(CODE.filter((f) => /renderSupplierOrderEmail\(/.test(strip(read(f)))).sort(), ['server/mail/templates/supplier-order.js', 'server/suppliers/dispatch.js']);
  assert.match(read('server/suppliers/dispatch.js'), /sendBrandedMail\(transport, \{ from, to, subject: mail\.subject/);
  assert.match(read('server/mail/templates/supplier-order.js'), /brandedHtml\(\{ lang: 'tr', title: subject, body \}\)/);
  // İşçi işi atomik sahiplenir (claimFgoJob) ve "gönderiliyor" işaretini göndermeden ÖNCE yazar
  const d = strip(read('server/suppliers/dispatch.js'));
  assert.ok(d.indexOf('claimFgoJob(db, row') > 0);
  assert.ok(d.indexOf('sendingAt: sendingAt.toISOString()') < d.indexOf('sendBrandedMail(transport'), 'işaret gönderimden önce');
  // Sayfa / işlem dosyalarında doğrudan gönderim yok
  for (const f of CODE.filter((x) => x.startsWith('app/'))) assert.ok(!/sendBrandedMail|dispatchSupplierOrderEmails/.test(read(f)), f);
});

test('stok: tedarik kodu stok hareketi yazmaz (sipariş, e-posta, tahmini tarih, teslim stoğu değiştirmez — karar 184)', () => {
  const files = CODE.filter((f) => f.startsWith('server/suppliers/') || f.startsWith('app/(panel)/siparisler/tedarik/') || f.startsWith('app/(panel)/admin/muhasebe/tedarikciler/') || f.startsWith('app/(panel)/admin/entegrasyonlar/tedarikciler/'));
  assert.ok(files.length >= 10, files.join(', '));
  for (const f of files) {
    const s = strip(read(f));
    assert.ok(!/stockMovement|addStockMovement|deductOrderStock|returnOrderStock|applyStockImport/.test(s), `${f}: stok yazılmaz`);
  }
});

test('sayfalar ve işlemler: her tedarik sayfası / işlemi önce SUPPLIER_MANAGE ister; düzenleyici para hesabını ortak modülden alır', () => {
  const pages = [
    'app/(panel)/siparisler/tedarik/page.tsx', 'app/(panel)/siparisler/tedarik/yeni/page.tsx', 'app/(panel)/siparisler/tedarik/[id]/page.tsx',
    'app/(panel)/admin/entegrasyonlar/tedarikciler/page.tsx', 'app/(panel)/admin/muhasebe/tedarikciler/page.tsx',
  ];
  for (const f of pages) assert.match(read(f), /await requirePermission\('SUPPLIER_MANAGE'\)/, f);
  for (const f of ['app/(panel)/siparisler/tedarik/actions.ts', 'app/(panel)/admin/entegrasyonlar/tedarikciler/actions.ts', 'app/(panel)/admin/muhasebe/tedarikciler/actions.ts']) {
    const src = read(f);
    const fns = [...src.matchAll(/export async function (\w+)\(fd: FormData\) \{\n\s*const admin = await requirePermission\('SUPPLIER_MANAGE'\);/g)].map((x) => x[1]);
    const all = [...src.matchAll(/export async function (\w+)\(/g)].map((x) => x[1]);
    assert.ok(all.length > 0 && fns.length === all.length, `${f}: her işlemin ilk satırı yetki (${all.filter((x) => !fns.includes(x)).join(', ')})`);
  }
  assert.match(read('app/(panel)/siparisler/tedarik/[id]/SupplierOrderEditor.tsx'), /from '@\/server\/suppliers\/money\.js'/);
  // Ek indirme yolu yetki ister (yetkisize 404)
  assert.match(read('app/dosya/[kind]/[id]/route.ts'), /kind === 'tedarik' && userCan\(user, 'SUPPLIER_MANAGE'\)/);
  // Profil stoğunda beklenen tedarik ve "Sipariş hazırla" yalnızca SUPPLIER_MANAGE (denetimci görmez)
  const stock = read('app/(panel)/admin/stok/page.tsx');
  assert.match(stock, /const supply = userCan\(user, 'SUPPLIER_MANAGE'\);/);
  assert.match(stock, /supply \? expectedSupplyMap\(db\) : Promise\.resolve\(null\)/);
  // Teknik ek sınırları SMTP ileti sınırının altında kalır
  assert.ok(FILE_LIMITS.totalBytes * 4 / 3 < 25 * 1024 * 1024 + 4 * 1024 * 1024);
});

test('menü: "Entegrasyonlar" artık "Ayarlar"; satın alma bölümü yalnızca yönetici menüsünde', () => {
  const roles = read('lib/roles.ts');
  assert.match(roles, /\{ href: '\/admin\/entegrasyonlar', key: 'nav\.adminSettings' \}/);
  assert.ok(!roles.includes("key: 'nav.integrations'"));
  const admin = roles.slice(roles.indexOf('ADMIN: ['), roles.indexOf('SATIS: ['));
  const rest = roles.slice(roles.indexOf('SATIS: ['));
  for (const href of ['/siparisler/tedarik', '/admin/muhasebe/tedarikciler']) {
    assert.ok(admin.includes(`'${href}'`), href);
    assert.ok(!rest.includes(`'${href}'`), `${href} başka rolün menüsünde yok`);
  }
});
