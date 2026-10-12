// 3.77.0 — son beş düzeltme (karar 259–263), saf kurallar ve yapı denetimleri. Veritabanı tarafı: test/db/son-5-duzeltme.test.js
// ve test/db/pdf-import.test.js; tarayıcı: e2e/57-son-5-duzeltme.spec.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareOrderNo, isPlainNo, parseCustomerOrderNo, sortByOrderNo } from '../server/orders/order-number.js';
import { assignPieceBases, offerLineTotals, offerTotals, pieceAreaFromDims, pieceStartArea } from '../server/orders/rules.js';
import { proformaLines, invoiceLines, proformaAmount } from '../server/glass/billing.js';
import { snapshotLine, itemAsLine, snapshotOfItem } from '../server/loading/confirmation.js';
import { offerExportData } from '../server/orders/offer-export.js';
import { compensationLines } from '../server/orders/compensation.js';
import { parseFactoryOrder } from '../server/orders/pdf-import/parse.js';
import { buildLines } from '../server/orders/pdf-import/lines.js';
import { buildImportPlan, projectCheck, shapeOf } from '../server/orders/pdf-import/plan.js';
import { DESC_NORMAL, DESC_SHAPED, itemsOf, shapedForm } from './fixtures/factory-pdf.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ---------- 3) Tireli müşteri sipariş numarası (karar 259) ----------
test('müşteri numarası: 40, 40-1, 40-2, ALE40-1, 001-1 kabul; tire ve baştaki sıfırlar korunur; kendi firma kodu atılır', () => {
  assert.deepEqual(['40', '40-1', '40-2', '001-1'].map((v) => parseCustomerOrderNo(v, 'ALE')), ['40', '40-1', '40-2', '001-1']);
  assert.equal(parseCustomerOrderNo('ALE40-1', 'ALE'), '40-1');
  assert.equal(parseCustomerOrderNo(' ale40-1 ', 'ALE'), '40-1', 'boşluk ve küçük harf');
  assert.equal(parseCustomerOrderNo('ALE001-1', 'ALE'), '001-1');
  assert.equal(parseCustomerOrderNo('40', null), '40');
  assert.equal(parseCustomerOrderNo(68, 'GLA'), '68', 'eski çağıran (sayı) da çalışır');
  for (const bad of ['', '0', '00-0', '-40', '40-', '40--1', '40 1', '4.0', 'ABC40-1', 'XYZ40', 'ALE', 'ALE-40', '40-1-2-3-4', '12345678901', 'P12', '40-T', 'ALEP12']) {
    assert.equal(parseCustomerOrderNo(bad, 'ALE'), null, bad);
  }
  assert.equal(parseCustomerOrderNo('1'.repeat(10) + '-' + '2'.repeat(10) + '-333', 'ALE'), null, 'en çok 24 karakter');
  for (const bad of [0, -3, 1.5, NaN, null, undefined, {}]) assert.equal(parseCustomerOrderNo(bad, 'ALE'), null, String(bad));
});

test('müşteri numarası: yalnızca rakamlı numaralar öneri sırasına girer; doğal sıralama "9" < "10" < "10-1" < "10-2"', () => {
  assert.deepEqual(['40', '001', '40-1', 'x'].map(isPlainNo), [true, true, false, false]);
  assert.deepEqual(['10-2', '9', '10', '10-1', '001-1', '2'].sort(compareOrderNo), ['001-1', '2', '9', '10', '10-1', '10-2']);
  const rows = [{ c: 'b', n: 'ABC10' }, { c: 'a', n: 'ABC9' }, { c: 'b', n: 'ABC9' }, { c: 'a', n: 'ABC10-1' }, { c: 'a', n: 'ABC10' }];
  assert.deepEqual(sortByOrderNo(rows, (r) => r.n, (r) => r.c).map((r) => `${r.c}${r.n}`), ['aABC9', 'aABC10', 'aABC10-1', 'bABC9', 'bABC10']);
});

test('PDF projesi tireli numarayı aynen karşılaştırır (karar 259)', () => {
  assert.equal(projectCheck('MUSTERIX ALE 40-1', { prefix: 'ALE', customerOrderNo: '40-1' }).ok, true);
  assert.equal(projectCheck('MUSTERIX ALE 40-1', { prefix: 'ALE', customerOrderNo: '40' }).code, 'WRONG_PROJECT');
  assert.equal(projectCheck('MUSTERIX ALE 001-1', { prefix: 'ALE', customerOrderNo: '001-1' }).ok, true);
});

// ---------- 4) Metraj 3 ondalık (karar 261) ----------
const L = (o = {}) => ({ kind: 'CAM', unit: 'm2', description: 'Cam', enMm: 1183, boyMm: 2017, adet: 2, unitPrice: '100', ...o });

test('metraj: kayıtlı parça m²si varsa 3 ondalık (erken 2 ondalığa yuvarlama yok); yoksa eski kural aynen (eski teklif değişmez)', () => {
  assert.equal(pieceAreaFromDims(1183, 2017), 2.386, 'fabrikanın kuralı: en × boy, 3 ondalık');
  assert.deepEqual(offerLineTotals(L()), { metraj: 4.77, amount: 477 }, 'eski satır: değişmez');
  assert.deepEqual(offerLineTotals(L({ pieceM2: '2.386' })), { metraj: 4.772, amount: 477.2 });
  // Elle girilen satır metrajı (4,773 / 2 adet): parça m²si 2,3865 → satır 4,773
  assert.deepEqual(offerLineTotals(L({ pieceM2: '2.3865' })), { metraj: 4.773, amount: 477.3 });
  // Adet değişince parça m²si aynı kalır, metraj orantılı
  assert.equal(offerLineTotals(L({ pieceM2: '2.386', adet: 5 })).metraj, 11.93);
  // Fiyat hassasiyeti değişmez: tutar 2 ondalık (yarım yukarı), fiyat çarpımı aynı kural
  assert.equal(offerLineTotals(L({ pieceM2: '1.235', adet: 1, unitPrice: '33.33' })).amount, 41.16);
  // CNC / delik / adetli satır metraja girmez
  assert.equal(offerLineTotals({ kind: 'CNC', unit: 'adet', adet: 2, unitPrice: '5', pieceM2: '9' }).metraj, 0);
  // Toplam 3 ondalık; eski 2 ondalıklı satırlarla karışık toplam da kayıpsız
  assert.equal(offerTotals([L({ pieceM2: '2.386' }), L({ pieceM2: '1.001', adet: 1 }), L({ enMm: 1000, boyMm: 1000, adet: 1 })]).metraj, 6.773);
});

test('metraj: ayrılmış cam grubu (karar 114) aynı parça m²siyle kalemin toplamına eşit; farklı parça m²si grup değildir', () => {
  const split = assignPieceBases([L({ adet: 4, pieceM2: '2.386', splitGroup: 'g1' }), L({ adet: 1, pieceM2: '2.386', splitGroup: 'g1' })]);
  assert.deepEqual(split.map((l) => l.pieceBase), [0, 4]);
  assert.deepEqual(split.map(offerLineTotals), [{ metraj: 9.544, amount: 954.4 }, { metraj: 2.386, amount: 238.6 }]);
  assert.deepEqual(offerTotals(split).metraj, offerLineTotals(L({ adet: 5, pieceM2: '2.386' })).metraj);
  assert.equal(pieceStartArea(split[1]), 9.544);
  const apart = assignPieceBases([L({ adet: 1, pieceM2: '2.386', splitGroup: 'g2' }), L({ adet: 1, pieceM2: '2.4', splitGroup: 'g2' })]);
  assert.deepEqual(apart.map((l) => l.splitGroup), [null, null]);
});

test('metraj: proforma / fatura / yükleme onayı / dışa aktarma 3. ondalığı kaybetmez; fiyat ve TVA yuvarlaması aynı', () => {
  const offer = { lines: [L({ id: 'a', descriptionRo: 'Sticlă X', offerPrice: '100', pieceM2: '2.386' }), L({ id: 'b', descriptionRo: 'Sticlă X', offerPrice: '100', pieceM2: '1.001', adet: 1 })] };
  const pf = proformaLines(offer);
  assert.deepEqual(pf.map((r) => [r.qty, r.parts.map((p) => p.qty)]), [[5.773, [4.772, 1.001]]]);
  assert.equal(proformaAmount(pf[0]), 577.3);
  assert.equal(invoiceLines(offer, 5, 21)[0].qty, 5.773);
  // Onay kalemi parça m²sini taşır; m² ve tutar teklifteki kuralla
  const item = snapshotLine({ id: 'o', customerId: 'c' }, { currency: 'EUR' }, { ...offer.lines[0], id: 'a', unitPrice: '50' });
  assert.deepEqual([item.pieceM2, item.m2, item.costAmount, item.saleAmount], ['2.386', 4.772, 238.6, 477.2]);
  assert.equal(offerLineTotals({ ...itemAsLine({ ...item, unitCost: 50, unitSale: 100 }), unitPrice: '100' }).metraj, 4.772);
  assert.equal(snapshotOfItem({ ...item, unitCost: 50, unitSale: 100 }, { quantity: 1 }).m2, 2.386);
  // Eski satır (parça m²si yok): onay kaleminin m²si eskisi gibi 2 ondalık
  assert.equal(snapshotLine({ id: 'o', customerId: 'c' }, { currency: 'EUR' }, L({ id: 'z' })).m2, 4.77);
  const ex = offerExportData({ lines: offer.lines, price: (l) => l.offerPrice, locale: 'tr', kindLabel: (k) => k });
  assert.deepEqual([ex.rows.map((r) => r.m2), ex.metraj, ex.total], [[4.772, 1.001], 5.773, 577.3]);
});

test('yapı: m² toplamları 3 ondalık; m² sütunları DECIMAL(12,3); parça m²si DECIMAL(18,9)', () => {
  const schema = read('prisma/schema.prisma');
  assert.match(schema, /pieceM2          Decimal\? @db\.Decimal\(18, 9\)/);
  assert.match(schema, /m2             Decimal  @db\.Decimal\(12, 3\)/);
  assert.match(schema, /m2           Decimal  @db\.Decimal\(12, 3\)/);
  for (const f of ['server/orders/loading.js', 'server/orders/offer-export.js', 'server/loading/firm-export.js', 'server/accounting/supplier.js', 'server/glass/billing.js']) {
    assert.ok(!/(metraj|\.m2|\.qty) = round2\((metraj|[a-z]+\.m2|[a-z]+\.qty) \+/.test(read(f)), f);
  }
  assert.ok(!/m2: i\.m2\.toFixed\(2\)/.test(read('server/loading/confirmation.js') + read('server/loading/correction.js')));
  assert.ok(!/m2: m2\.toFixed\(2\)/.test(read('server/loading/replan.js')));
});

// ---------- 5) Normal / Şekilli cam (karar 262) ----------
test('Test A: "66.3 TEMPER LAMİNE CAM REFLEKTE FÜME + ŞEFFAF" → normal cam', () => {
  assert.deepEqual(shapeOf(DESC_NORMAL), { shaped: false, uncertain: false });
});

test('Test B: "66.3 TEMPER LAMİNE CAM - ŞEKİLLİ REFLEKTE FÜME + ŞEFFAF" → şekilli cam (Türkçe harf, büyük/küçük, boşluk, satır sonu)', () => {
  assert.deepEqual(shapeOf(DESC_SHAPED), { shaped: true, uncertain: false });
  for (const d of ['66.3 temper lamine cam - şekilli reflekte füme + şeffaf', '66.3 TEMPER LAMİNE CAM -ŞEKİLLİ', '6 mm Düz DR ŞEKİLLİ+CNC', 'SEKILLI', '66.3  TEMPER\nLAMİNE CAM -\nŞekilli']) {
    assert.equal(shapeOf(d).shaped, true, d);
  }
  // Benzer ama tam olmayan yazım: belirsiz → normal kabul edilir, uyarılır (elle düzeltilir)
  assert.deepEqual(shapeOf('66.3 CAM ŞEKİL'), { shaped: false, uncertain: true });
  assert.deepEqual(shapeOf('DELİKLİ'), { shaped: false, uncertain: false });
});

test('PDF: iki satıra bölünmüş cam adı birleşir; normal ve şekilli satır ayrı tanınır, teknik özellikleri ve m²si aynen korunur', () => {
  const parsed = parseFactoryOrder(buildLines(itemsOf(shapedForm())));
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.rows.map((r) => [r.sno, r.description, r.m2, r.totalM2, r.amount, r.poz]), [
    [1, DESC_NORMAL, 2386, 4772, 47720, 'ABC 40'],
    [2, DESC_SHAPED, 1000, 1000, 10000, 'ABC 40'],
  ]);
  // Sayılar ilk satırda, cam adının devamı altta
  const below = parseFactoryOrder(buildLines(itemsOf(shapedForm().map((l) => l))));
  assert.equal(below.rows.length, 2);
  const catalog = [{ id: 'g1', nameTr: '6.3.6 Temperli Lamine', colorTr: 'Füme Reflekte-Şeffaf', label: '6.3.6 Temperli Lamine — Füme Reflekte-Şeffaf' }];
  const order = { prefix: 'ABC', customerOrderNo: '40', glass: null };
  const first = buildImportPlan({ parsed, importKey: 'imp1', order, catalog });
  const choices = { glass: Object.fromEntries(first.glassChoices.map((g) => [g.key, 'g1'])) };
  const plan = buildImportPlan({ parsed, importKey: 'imp1', order, catalog, choices });
  assert.deepEqual(plan.blocking, []);
  assert.deepEqual(plan.lines.map((l) => [l.shaped, l.glassProductId, l.pieceM2, l.enMm, l.boyMm, l.adet, l.unitPrice, l.poz]), [
    [false, 'g1', '2.386', 1183, 2017, 2, '100.00', 'ABC 40'],
    [true, 'g1', '1.000', 1000, 1000, 1, '100.00', 'ABC 40'],
  ]);
  assert.deepEqual(plan.rows.map((r) => [r.shaped, r.description]), [[false, DESC_NORMAL], [true, DESC_SHAPED]]);
  // 3 ondalıklı m² aynen: TAKİP toplamı Ara Toplam ile kuruşu kuruşuna (yapay eşitleme yok — PDF'in kendi m²si)
  assert.deepEqual(plan.checks.b, { takipTotal: 57720, pdfSum: 57720, subtotal: 57720, diff: 0, explained: true });
});

test('Test E (kural): cam türü değişince fiyat, POZ, ölçü, adet, metraj ve işlem satırları değişmez', () => {
  const base = [L({ id: 'a', poz: 'P1', pieceM2: '2.386', offerPrice: '120', shaped: false }), { kind: 'CNC', unit: 'adet', adet: 1, unitPrice: '5', description: 'CNC' }];
  const turned = base.map((l, i) => (i === 0 ? { ...l, shaped: true } : l));
  const pick = (ls) => ls.map((l) => [l.unitPrice, l.offerPrice ?? null, l.poz ?? null, l.enMm ?? null, l.boyMm ?? null, l.adet, offerLineTotals(l)]);
  assert.deepEqual(pick(turned), pick(base));
  assert.deepEqual(offerTotals(turned), offerTotals(base));
  // Telafi camı kaynağın türünü ve parça m²sini aynen taşır
  const comp = compensationLines({ line: { ...base[0], shaped: true }, subs: [], quantity: 1, decision: { unitCost: 100, offerPrice: 120, free: false } });
  assert.deepEqual([comp[0].shaped, comp[0].pieceM2], [true, '2.386']);
});

test('yapı: şekilli işareti ve parça m²si teklif satırıyla yeni sürüme taşınır; form alanı yoksa kayıtlı değer korunur', () => {
  const tr = read('server/orders/transitions.js');
  assert.match(tr, /const LINE_FIELDS = \[[^\]]*'pieceM2'\]/);
  assert.match(tr, /shaped: \(l\.kind \?\? 'CAM'\) === 'CAM' && !!l\.shaped/);
  assert.match(tr, /shaped: l\.shaped !== undefined \? !!l\.shaped : !!old\?\.shaped/);
  assert.match(tr, /pieceM2: l\.pieceM2 !== undefined \?/);
  const editor = read('app/(panel)/siparisler/[id]/OfferEditor.tsx');
  assert.match(editor, /name="l_shaped"/);
  assert.match(editor, /name="l_pm2"/);
  assert.match(editor, /data-m2-input/);
});

// ---------- 1) Silinen siparişin numarası (karar 260) ----------
test('yapı: numara tekilliği yalnızca etkin siparişlerde; silme numarayı serbest bırakır, geri yükleme dolu numarayı reddeder', () => {
  const schema = read('prisma/schema.prisma');
  assert.match(schema, /@@unique\(\[customerId, orderTypeCode, customerOrderNo, compSeq, numberActive\], map: "Order_customer_number_active_key"\)/);
  assert.match(schema, /@@unique\(\[orderNo, numberActive\], map: "Order_orderNo_active_key"\)/);
  assert.ok(!/orderNo           String      @unique/.test(schema));
  const create = read('server/orders/create.js');
  assert.match(create, /customerOrderNo: no, numberActive: true \}/);
  assert.match(create, /"numberActive" IS TRUE/);
  const removal = read('server/orders/removal.js');
  assert.match(removal, /numberActive: null, version: \{ increment: 1 \}/);
  assert.match(removal, /fail\('NUMBER_TAKEN'/);
  // Silinmiş sipariş hiçbir rolün kapsamında değildir (geçmişi yeni siparişle karışmaz)
  assert.match(read('server/orders/scope.js'), /removedAt: null/);
  const sql = fs.readdirSync(new URL('../prisma/migrations/', import.meta.url)).filter((d) => d.endsWith('_order_number_text_area3_shaped'));
  assert.equal(sql.length, 1);
  const m = read(`prisma/migrations/${sql[0]}/migration.sql`);
  assert.match(m, /UPDATE "Order" SET "numberActive" = NULL WHERE "removedAt" IS NOT NULL;/);
  assert.match(m, /USING "customerOrderNo"::text/);
  assert.ok(!/DELETE|TRUNCATE|DROP TABLE|DROP COLUMN/i.test(m), 'veri silinmez');
});

// ---------- 2) Aynı PDF'in yeniden aktarımı (karar 263) ----------
test('yapı: aynı PDF — dosya özeti tek başına engel değil; satırlar durdukça engel; temiz tarama zorunlu; kilitli kayıt seçimi', () => {
  const svc = read('server/orders/pdf-import/service.js');
  assert.match(svc, /status === 'APPLIED' && liveImportIds\.has\(r\.id\)/);
  assert.match(svc, /else if \(imp\.scanStatus !== 'CLEAN'\) blocking\.push\(\{ code: 'NOT_SCANNED' \}\)/);
  assert.match(svc, /pdf-import-file:\$\{orderId\}:\$\{checksum\}/);
  assert.ok(!/orderId_checksum/.test(svc));
  assert.ok(!/@@unique\(\[orderId, checksum\]\)/.test(read('prisma/schema.prisma').split('model OfferImport')[1].split('\n}\n')[0]));
});
