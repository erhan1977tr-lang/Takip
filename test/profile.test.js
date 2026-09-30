import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickupAfterPayment, earliestPickup, isWorkingDay, nextWorkingDay, pickupProblem, dayDate, localDay } from '../server/profile/dates.js';
import {
  cleanPhone, cleanPlate, missingPrices, orderStatusFor, parsePrice, profileActions, profileOrderItems, profileTotals, readQuantities,
} from '../server/profile/rules.js';
import { parseProductSheet, planProductImport, productSheetRows, validateProduct } from '../server/profile/catalog.js';
import { parseStockSheet, shortages } from '../server/profile/stock.js';
import { profileOfferLines } from '../server/profile/create.js';
import { depotFormPdf } from '../server/pdf/depot-form.js';
import { decodePng, fitText, textWidth } from '../server/pdf/pdf.js';
import { renderWarehouseEmail } from '../server/mail/templates/warehouse.js';
import { parseRecipients, hashToken, newToken } from '../server/profile/warehouse.js';
import { orderScope } from '../server/orders/scope.js';
import zlib from 'node:zlib';

const D = (s) => dayDate(s);
const key = (d) => d.toISOString().slice(0, 10);

test('profil tarih: hafta sonu iş günü değildir; sonraki iş günü', () => {
  assert.equal(isWorkingDay(D('2026-10-03')), false); // cumartesi
  assert.equal(isWorkingDay(D('2026-10-05')), true);
  assert.equal(key(nextWorkingDay(D('2026-10-02'))), '2026-10-05'); // cuma → pazartesi
  assert.equal(key(nextWorkingDay(D('2026-10-05'))), '2026-10-06');
});

test('profil tarih: ödeme yokken en erken bugünden sonraki iş günü; ödemeden sonra ödeme + 1 iş günü', () => {
  assert.equal(key(earliestPickup({ today: D('2026-09-30') })), '2026-10-01'); // çarşamba → perşembe
  assert.equal(key(earliestPickup({ today: D('2026-10-02') })), '2026-10-05'); // cuma → pazartesi
  assert.equal(key(earliestPickup({ today: D('2026-10-03') })), '2026-10-05'); // cumartesi → pazartesi
  assert.equal(key(earliestPickup({ today: D('2026-10-05'), paidAt: D('2026-10-01') })), '2026-10-02');
  assert.equal(pickupProblem(D('2026-10-03'), { today: D('2026-09-30') }), 'PICKUP_WEEKEND');
  assert.equal(pickupProblem(D('2026-09-30'), { today: D('2026-09-30') }), 'PICKUP_TOO_EARLY');
  assert.equal(pickupProblem(D('2026-10-01'), { today: D('2026-09-30') }), null);
  assert.equal(pickupProblem(D('2027-06-01'), { today: D('2026-09-30') }), 'PICKUP_TOO_LATE');
  assert.equal(pickupProblem(new Date('x'), { today: D('2026-09-30') }), 'PICKUP_INVALID');
});

test('profil tarih: ödeme teyidinde erken alış günü ödemeden sonraki iş gününe kayar; geçmiş ödeme bugünden önceye taşımaz', () => {
  const r = pickupAfterPayment({ paidAt: D('2026-10-02'), pickupDate: D('2026-10-02'), today: D('2026-10-02') });
  assert.equal(key(r.pickupDate), '2026-10-05'); // cuma ödendi → pazartesi
  assert.equal(r.moved, true);
  const later = pickupAfterPayment({ paidAt: D('2026-10-02'), pickupDate: D('2026-10-09'), today: D('2026-10-02') });
  assert.equal(key(later.pickupDate), '2026-10-09');
  assert.equal(later.moved, false);
  // Ödeme günü geçen hafta girildi, müşterinin günü geçmişte kaldı → bugün
  const past = pickupAfterPayment({ paidAt: D('2026-09-28'), pickupDate: D('2026-09-29'), today: D('2026-10-01') });
  assert.equal(key(past.pickupDate), '2026-10-01');
  assert.equal(past.moved, true);
  // … bugün hafta sonuysa sonraki iş günü
  assert.equal(key(pickupAfterPayment({ paidAt: D('2026-09-28'), pickupDate: null, today: D('2026-10-03') }).pickupDate), '2026-10-05');
  assert.equal(localDay(new Date('2026-10-01T22:30:00Z'), 'Europe/Bucharest'), '2026-10-02');
});

test('profil akışı: kim hangi adımda ne yapar; satış ve çizim hiçbir şey yapamaz', () => {
  const a = (role, stage, extra = {}) => profileActions({ role, stage, status: orderStatusFor(stage), ...extra });
  assert.deepEqual(a('ADMIN', 'FIYAT_BEKLIYOR').filter((x) => !['cancel', 'add_file'].includes(x)), ['save_profile_prices', 'send_profile_offer']);
  assert.ok(a('ADMIN', 'TEKLIF_GONDERILDI').includes('update_profile_offer'));
  assert.ok(!a('ADMIN', 'TEKLIF_GONDERILDI').includes('approve_profile_offer'), 'yönetici müşteri adına onaylayamaz');
  assert.ok(a('MUSTERI', 'TEKLIF_GONDERILDI', { canApprove: true }).includes('approve_profile_offer'));
  assert.ok(!a('MUSTERI', 'TEKLIF_GONDERILDI', { canApprove: false }).includes('approve_profile_offer'));
  assert.ok(a('MUSTERI', 'PROFORMA').includes('update_pickup'));
  // Ödeme alındı (hemen depoya) ya da ödemesiz "Siparişi depoya gönder"; depodaki ödenmemiş siparişe ödeme sonradan girilir
  assert.ok(a('ADMIN', 'ONAYLANDI').includes('mark_paid') && a('ADMIN', 'ONAYLANDI').includes('send_to_warehouse'));
  assert.ok(a('ADMIN', 'PROFORMA').includes('send_to_warehouse'));
  assert.ok(a('ADMIN', 'DEPODA').includes('mark_paid'));
  assert.ok(!a('ADMIN', 'DEPODA', { paid: true }).includes('mark_paid'));
  assert.ok(!a('ADMIN', 'DEPODA').includes('send_to_warehouse'));
  assert.ok(!a('MUSTERI', 'PROFORMA').includes('mark_paid'));
  assert.ok(!a('MUSTERI', 'DEPODA').includes('update_pickup'), 'depoya gittikten sonra teslim bilgisi değişmez');
  assert.ok(!a('MUSTERI', 'ONAYLANDI').includes('cancel'));
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI']) {
    for (const stage of ['FIYAT_BEKLIYOR', 'TEKLIF_GONDERILDI', 'PROFORMA', 'DEPODA']) {
      assert.deepEqual(a(role, stage).filter((x) => x !== 'add_file'), [], `${role} ${stage}`);
    }
  }
  assert.deepEqual(profileActions({ role: 'ADMIN', stage: 'DEPODA', status: 'IPTAL' }), []);
  assert.equal(orderStatusFor('FIYAT_BEKLIYOR'), 'YENI');
  assert.equal(orderStatusFor('DEPODA'), 'HAZIRLANIYOR');
  assert.equal(orderStatusFor('FATURALANDI'), 'ARSIVLENDI');
});

test('profil siparişi: yalnızca adedi > 0 olan satırlar; geçersiz adet reddedilir', () => {
  const r = readQuantities([{ id: 'a', qty: '3' }, { id: 'b', qty: '' }, { id: 'c', qty: '0' }, { id: 'd', qty: '12' }]);
  assert.deepEqual(r, { ok: true, lines: [{ productId: 'a', qty: 3 }, { productId: 'd', qty: 12 }] });
  assert.equal(readQuantities([{ id: 'a', qty: '-1' }]).ok, false);
  assert.equal(readQuantities([{ id: 'a', qty: '1.5' }]).ok, false);
  assert.equal(readQuantities([{ id: 'a', qty: '999999' }]).ok, false);
  const cat = { code: 'GARNITURI', sortOrder: 1 };
  const products = [
    { id: 'a', code: 'GK15', nameRo: 'G RO', nameTr: 'G TR', unitCode: 'CUTII', imageId: 'img1', isActive: true, sortOrder: 20, category: cat },
    { id: 'd', code: 'AD45', nameRo: 'A RO', nameTr: 'A TR', unitCode: 'CUTII', imageId: null, isActive: true, sortOrder: 10, category: cat },
  ];
  const items = profileOrderItems(r.lines, products);
  assert.ok(items.ok);
  assert.deepEqual(items.items.map((i) => [i.code, i.qty, i.sortOrder]), [['AD45', 12, 0], ['GK15', 3, 1]], 'katalog sırası');
  assert.equal(items.items[1].imageId, 'img1');
  assert.deepEqual(profileOrderItems([], products), { ok: false, code: 'NO_ITEMS' });
  assert.deepEqual(profileOrderItems([{ productId: 'a', qty: 1 }], [{ ...products[0], isActive: false }]), { ok: false, code: 'PRODUCT_GONE' });
});

test('profil teklifi: satırlar liste / müşteri fiyatıyla dolar; toplam ve eksik fiyat', () => {
  const items = [
    { productId: 'a', code: 'GK15', nameRo: 'G RO', nameTr: 'G TR', unitCode: 'CUTII', qty: 3 },
    { productId: 'b', code: 'AD45', nameRo: 'A RO', nameTr: 'A TR', unitCode: 'CUTII', qty: 2 },
  ];
  const products = new Map([['a', { id: 'a', listPrice: '12.50' }], ['b', { id: 'b', listPrice: null }]]);
  const lines = profileOfferLines(items, (p) => (p.listPrice == null ? null : Number(p.listPrice)), products);
  assert.equal(lines[0].offerPrice, '12.50');
  assert.equal(lines[0].kind, 'PROFIL');
  assert.equal(lines[1].offerPrice, null);
  assert.deepEqual(missingPrices(lines), [2]);
  assert.equal(profileTotals(lines).amount, 37.5);
  assert.equal(parsePrice('12,5'), 12.5);
  assert.ok(Number.isNaN(parsePrice('abc')));
  assert.ok(Number.isNaN(parsePrice('-1')));
  assert.equal(parsePrice(''), null);
});

test('profil: telefon ve plaka', () => {
  assert.equal(cleanPhone(' +40 723 456 789 '), '+40 723 456 789');
  assert.equal(cleanPhone('abc'), null);
  assert.equal(cleanPhone('123'), null);
  assert.equal(cleanPlate('b 123 abc'), 'B 123 ABC');
  assert.equal(cleanPlate('IF-45-XYZ, B 01 GKH'), 'IF-45-XYZ, B 01 GKH');
  assert.equal(cleanPlate('<script>'), null);
});

test('profil kataloğu: doğrulama ve Excel (dışa aktarılan dosya aynen geri yüklenir)', () => {
  assert.deepEqual(validateProduct({ code: '', categoryCode: '', nameRo: '', unitCode: 'X', listPrice: 'a', isActive: 'belki' }).errors, ['CODE', 'CATEGORY', 'NAME_RO', 'UNIT', 'PRICE', 'ACTIVE']);
  const ok = validateProduct({ code: 'gk 15', categoryCode: 'GARNITURI', nameRo: 'Garnitura', unitCode: 'cutii', listPrice: '12,5', isActive: '' });
  assert.ok(ok.ok);
  assert.equal(ok.value.code, 'GK-15');
  assert.equal(ok.value.unitCode, 'CUTII');
  assert.equal(ok.value.nameTr, 'Garnitura');
  const products = [{ id: '1', code: 'GK15', category: { code: 'GARNITURI' }, nameRo: 'G', nameTr: 'G', unitCode: 'CUTII', listPrice: '10.00', isActive: true }];
  const rows = productSheetRows(products);
  const parsed = parseProductSheet(rows);
  assert.ok(parsed.ok);
  assert.equal(parsed.items[0].value.listPrice, 10);
  const plan = planProductImport(products, ['GARNITURI'], [{ ...parsed.items[0].value, listPrice: 11 }, { ...parsed.items[0].value, code: 'NEW', categoryCode: 'YOK' }]);
  assert.equal(plan.update.length, 1);
  assert.deepEqual(plan.update[0].changes, ['listPrice']);
  assert.equal(plan.badCategory.length, 1);
  assert.deepEqual(parseProductSheet([['x']]), { ok: false, error: 'HEADERS' });
});

test('stok: Excel okuma ve eksik hesabı', () => {
  const r = parseStockSheet([['Kod', 'Ürün', 'Birim', 'Stok', 'Adet'], ['GK15', '', '', 5, 10], ['AD45', '', '', 0, ''], ['X', '', '', 0, '1.5'], ['GK15', '', '', 0, 2]]);
  assert.ok(r.ok);
  assert.deepEqual(r.items.map((i) => [i.code, i.qty]), [['GK15', 10]]);
  assert.deepEqual(r.errors.map((e) => e.problem), ['QTY', 'DUPLICATE']);
  const levels = new Map([['a', 5], ['b', 1]]);
  assert.deepEqual(shortages([{ productId: 'a', qty: 3 }, { productId: 'b', qty: 4 }, { productId: 'c', qty: 1 }], levels), [
    { productId: 'b', qty: 4, stock: 1, missing: 3 }, { productId: 'c', qty: 1, stock: 0, missing: 1 },
  ]);
});

test('PDF: Comanda Depozit tek sayfa, Romence/Türkçe harfler metinde, adetler yazılı', () => {
  const buf = depotFormPdf({
    orderNo: 'GLAP12', firmName: 'Șantier Țară ŞĞİ', phone: '+40 7', plate: 'B 1 ABC', pickupDate: D('2026-10-05'), date: D('2026-10-02'),
    categories: [{ code: 'GARNITURI', name: 'Garnituri', unit: 'CUTII' }],
    products: [{ id: '1', code: 'GK15', categoryCode: 'GARNITURI', name: 'GARNITURA EPDM - GK15', image: null }],
    qty: new Map([['GK15', 4]]), note: null,
  });
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 1 /);
  assert.match(s, /\/FontFile2/);
  // ToUnicode: Ș (0218) ve Ț (021A) glifleri eşlendi
  const cmaps = [...s.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]).filter((x) => x.includes('beginbfchar'));
  assert.ok(cmaps.some((c) => c.includes('<0218>') && c.includes('<021a>')), 'ToUnicode Ș Ț içermeli');
  assert.ok(textWidth('ȘȚ', 10) > 0);
  assert.equal(fitText('uzun bir metin burada', 10, 40).endsWith('…'), true);
});

test('PDF: PNG çözme (RGBA → beyaz zemine)', () => {
  // 2x1 RGBA: kırmızı opak, tamamen saydam
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 0]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const out = decodePng(png);
  assert.deepEqual([...out.rgb], [255, 0, 0, 255, 255, 255]);
  assert.equal(decodePng(Buffer.from('not a png')), null);
});

test('depo e-postası: Romence konu ve bağlantı; alıcı listesi', () => {
  const m = renderWarehouseEmail({
    orderNo: 'GLAP12', firmName: 'Firma <b>', pickupDate: D('2026-10-05'), phone: '+40', plate: 'B 1', link: 'https://x/depo/abc', validDays: 60,
    items: [{ code: 'GK15', name: 'Garnitura', unit: 'cutii', qty: 4 }],
  });
  assert.match(m.subject, /Comanda depozit GLAP12 — Firma <b> — ridicare 05\.10\.2026/);
  assert.ok(m.html.includes('Firma &lt;b&gt;'), 'HTML kaçışlı');
  assert.ok(m.text.includes('https://x/depo/abc'));
  assert.deepEqual(parseRecipients('Adrian@partnertrans.ro, enis@gkh.ro;enis@gkh.ro'), { ok: true, recipients: ['adrian@partnertrans.ro', 'enis@gkh.ro'] });
  assert.equal(parseRecipients('yanlis').ok, false);
  const t = newToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(hashToken(t), t);
});

test('kapsam: satış ve çizim profil siparişlerini hiç görmez', () => {
  assert.deepEqual(orderScope({ appRole: 'SATIS' }), { orderType: { usesSales: true } });
  assert.deepEqual(orderScope({ appRole: 'CIZIM' }), { drawingTrack: { not: 'YOK' }, orderType: { usesDrawing: true } });
  assert.deepEqual(orderScope({ appRole: 'DENETIMCI' }), {});
});
