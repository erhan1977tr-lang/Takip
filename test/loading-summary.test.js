// Yükleme Özeti Excel (P3 — karar 241): "Firmalar" + düz "Döküm" (+ yöneticide "Döküm (Fabrika)"). Sayfa düzeni, sütun
// sırası, çok sipariş / çok kalem, toplamlar, kısmi yükleme, formül enjeksiyonu ve paket içinde veri sızıntısı.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadingSummary, detailRows, loadingSummarySheets } from '../server/loading/summary.js';
import { writeReportXlsx } from '../server/files/xlsx-report.js';
import { openZip } from '../server/files/zip.js';

const TEXT = {
  title: 'YÜKLEME ÖZETİ · 02.10.2026 · PLANLANAN', sheetFirms: 'Firmalar', linesNone: '-', firmsTitle: 'F', guestTitle: 'G', guestNone: '-',
  total: 'TOPLAM', free: 'bedelsiz (telafi)', unit: 'm²',
  cols: { order: 'SİPARİŞ NO', customer: 'MÜŞTERİ', project: 'PROJE', desc: 'AÇIKLAMA', qty: 'ADET', unit: 'BİRİM', m2: 'METRAJ', price: 'BİRİM FİYAT', amount: 'TUTAR', currency: 'Para birimi' },
  firmCols: { firm: 'Firma', orders: 'Sipariş', glass: 'Cam', cnc: 'CNC', holes: 'Delik', m2: 'm²', net: 'Net', crates: 'Sandık', gross: 'Brüt', factory: 'Fabrika satış', offer: 'Teklif tutarı' },
  guestCols: { order: 'SİPARİŞ NO', owner: 'TİCARİ SAHİP', host: 'FİZİKSEL SANDIK SAHİBİ', crate: 'SANDIK' },
};
const glass = (description, en, boy, adet, unitPrice, offerPrice, extra = {}) => ({ kind: 'CAM', unit: 'm2', description, enMm: en, boyMm: boy, adet, unitPrice, offerPrice, ...extra });
const money = (sales, offer) => ({ EUR: { sales, offer, hasSales: sales != null, hasOffer: offer != null } });
const firm = (name, m) => ({ name, orders: 1, camAdet: 1, cnc: 0, delik: 0, metraj: 1, netKg: 21, crates: 1, grossKg: 71, money: m });

const ORDERS = [
  { orderNo: 'ALE46', title: 'Adrian', currency: 'EUR', customer: { id: 'a', name: 'ALEGRAD' }, lines: [
    glass('88.3 TEMPER', 1000, 2000, 2, '30', '50'),
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 2, unitPrice: '5', offerPrice: '10' },
    glass('10 MM TEMPER', 1234, 1000, 1, '20', '24'),
  ] },
  { orderNo: 'ALE47', title: 'Sura', currency: 'EUR', customer: { id: 'a', name: 'ALEGRAD' }, lines: [glass('88.3 TEMPER', 1000, 1000, 3, '30', '50')] },
  { orderNo: 'BET1', title: null, currency: 'RON', customer: { id: 'b', name: 'BETA CAM' }, lines: [glass('Temper', 1000, 500, 4, '160', '200')] },
];
const sheetsFor = ({ admin }) => {
  const offer = buildLoadingSummary(ORDERS, { priceOf: (l) => (admin ? l.offerPrice : l.unitPrice) });
  const details = [{ sheetName: 'Döküm', title: 'KALEM DÖKÜMÜ', lines: offer }];
  if (admin) details.push({ sheetName: 'Döküm (Fabrika)', title: 'KALEM DÖKÜMÜ — FABRİKA', lines: buildLoadingSummary(ORDERS, { priceOf: (l) => l.unitPrice }) });
  return loadingSummarySheets({
    subtitle: 'GKH', stats: [['Sipariş', 3]], firms: [firm('ALEGRAD', money(admin ? 1 : 1, admin ? 2 : null))], total: firm('TOPLAM', money(1, admin ? 2 : null)),
    guests: [], details, money: { sales: true, offer: admin }, text: TEXT,
  });
};
const parts = (buf) => {
  const z = openZip(buf);
  return Object.fromEntries(z.names().filter((n) => !/\.png$/.test(n)).map((n) => [n, z.read(n).toString('utf8')]));
};

test('iki sayfa: "Firmalar" ve "Döküm"; yöneticide ek "Döküm (Fabrika)"; Firmalar\'da sipariş bloğu yok', () => {
  const s = sheetsFor({ admin: false });
  assert.deepEqual(s.map((x) => x.name), ['Firmalar', 'Döküm']);
  assert.deepEqual(s[0].blocks.map((b) => b.title), ['F', 'G']);
  assert.deepEqual(sheetsFor({ admin: true }).map((x) => x.name), ['Firmalar', 'Döküm', 'Döküm (Fabrika)']);
  const wb = parts(writeReportXlsx({ sheets: s }))['xl/workbook.xml'];
  assert.deepEqual([...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => m[1]), ['Firmalar', 'Döküm']);
});

test('Döküm düz tablo: sütun sırası; her kalem bir satır; aynı siparişin kalemleri bitişik; çok sipariş / çok para birimi toplamları', () => {
  const [d] = sheetsFor({ admin: true })[1].blocks;
  assert.deepEqual(d.columns.map((c) => c.header), ['SİPARİŞ NO', 'MÜŞTERİ', 'PROJE', 'AÇIKLAMA', 'ADET', 'BİRİM', 'METRAJ', 'BİRİM FİYAT', 'TUTAR', 'Para birimi']);
  assert.deepEqual(d.columns.map((c) => c.type), ['text', 'wrap', 'wrap', 'wrap', 'int', 'text', 'm2', 'dec2', 'dec2', 'text']);
  assert.deepEqual(d.rows, [
    // 2 m² × 50 × 2 + CNC 2 × 10 = 220; 1,234 m² hesapta 1,23 (2 ondalık) × 24 = 29,52
    ['ALE46', 'ALEGRAD', 'Adrian', '88.3 TEMPER', 2, 'm²', 4, 50, 220, 'EUR'],
    ['ALE46', 'ALEGRAD', 'Adrian', '10 MM TEMPER', 1, 'm²', 1.23, 24, 29.52, 'EUR'],
    ['ALE47', 'ALEGRAD', 'Sura', '88.3 TEMPER', 3, 'm²', 3, 50, 150, 'EUR'],
    ['BET1', 'BETA CAM', '', 'Temper', 4, 'm²', 2, 200, 400, 'RON'],
  ]);
  assert.deepEqual(d.totals, [['', '', '', 'TOPLAM', 6, '', 8.23, '', 399.52, 'EUR'], ['', '', '', 'TOPLAM', 4, '', 2, '', 400, 'RON']]);
  // Toplam satırları para birimi adına göre (müşteri sırasından bağımsız)
  const swapped = loadingSummarySheets({ subtitle: '', stats: [], firms: [], total: firm('T', {}), guests: [], money: { sales: false, offer: false }, text: TEXT,
    details: [{ sheetName: 'Döküm', title: 'D', lines: buildLoadingSummary([{ ...ORDERS[2], customer: { id: 'z', name: 'AAA' } }, ORDERS[1]], { priceOf: (l) => l.offerPrice }) }] });
  assert.deepEqual(swapped[1].blocks[0].totals.map((r) => r[9]), ['EUR', 'RON']);
  const [f] = sheetsFor({ admin: true })[2].blocks;
  assert.deepEqual(f.rows.map((r) => [r[0], r[7], r[8]]), [['ALE46', 30, 130], ['ALE46', 20, 24.6], ['ALE47', 30, 90], ['BET1', 160, 320]]);
  // Excel: METRAJ 3 ondalık gösterim (değer 2 ondalık hesap); süzgeç yalnızca başlık + kalem satırları
  const sheet = parts(writeReportXlsx({ sheets: sheetsFor({ admin: false }) }))['xl/worksheets/sheet2.xml'];
  const filter = /<autoFilter ref="A(\d+):J(\d+)"\/>/.exec(sheet);
  assert.ok(filter, 'süzgeç / sıralama açık');
  assert.equal(Number(filter[2]) - Number(filter[1]), 4, 'başlık + 4 kalem; toplam satırı süzgeç dışında');
});

test('kısmi yükleme: onay kopyası satırı (yüklenen 8 / 10) ve bölünmüş parça satırları — Döküm yüklenen miktar, toplam bölünmemişle aynı', () => {
  // Onay kopyası (confirmedDayRows): adet = yüklenen; bölünmüş satır pieceBase ile aynı ticari kalem
  const loaded = [{ orderNo: 'UNS1', title: 'P', currency: 'EUR', customer: { id: 'u', name: 'ÜNSAL' }, lines: [
    glass('Temper', 1000, 1000, 7, '37', '50'),
    glass('Temper', 1000, 1000, 1, '37', '50', { pieceBase: 7 }),
  ] }];
  const rows = detailRows(buildLoadingSummary(loaded, { priceOf: (l) => l.offerPrice }), TEXT);
  assert.deepEqual(rows, [['UNS1', 'ÜNSAL', 'P', 'Temper', 8, 'm²', 8, 50, 400, 'EUR']]);
  // Bedelsiz telafi: fiziksel satır, tutar 0, açıklamada etiket
  const free = detailRows(buildLoadingSummary([{ ...loaded[0], lines: [glass('Temper', 1000, 1000, 1, '37', '0', { free: true })] }], { priceOf: (l) => l.offerPrice }), TEXT);
  assert.deepEqual(free, [['UNS1', 'ÜNSAL', 'P', 'Temper — bedelsiz (telafi)', 1, 'm²', 1, 0, 0, 'EUR']]);
});

test('formül enjeksiyonu yok: =, +, -, @ ile başlayan metin satır içi metin olarak yazılır; pakette formül, belge özelliği, gizli sayfa yok', () => {
  const evil = [{ orderNo: '=1+1', title: '@SUM(A1)', currency: 'EUR', customer: { id: 'x', name: '+cmd|\' /C calc\'!A0' }, lines: [glass('=HYPERLINK("http://x.test","y")', 1000, 1000, 1, '1', '2')] }];
  const sheets = loadingSummarySheets({
    subtitle: '-1+1', stats: [['=A1', '=B1']], firms: [firm('=EVIL()', money(1, 2))], total: firm('TOPLAM', money(1, 2)),
    guests: [{ orderNo: '=G1', owner: '+O', host: '-H', crate: '@C' }],
    details: [{ sheetName: 'Döküm', title: 'D', lines: buildLoadingSummary(evil, { priceOf: (l) => l.offerPrice }) }], money: { sales: true, offer: true }, text: TEXT,
  });
  const p = parts(writeReportXlsx({ sheets }));
  const all = Object.values(p).join('\n');
  assert.doesNotMatch(all, /<f[ >]/, 'formül yok');
  assert.deepEqual(Object.keys(p).filter((n) => n.startsWith('docProps/')), [], 'belge özelliği (yazar, şirket vb.) yok');
  assert.doesNotMatch(p['xl/workbook.xml'], /state="(hidden|veryHidden)"/, 'gizli sayfa yok');
  for (const v of ['=1+1', '@SUM(A1)', '=HYPERLINK(&quot;http://x.test&quot;,&quot;y&quot;)', '=EVIL()', '=G1', '-H']) {
    assert.ok(all.includes(`<t xml:space="preserve">${v}</t>`), `metin hücresi: ${v}`);
  }
  // Tanımlı adlar yalnızca süzgeç / yazdırma aralıkları
  const defined = [...p['xl/workbook.xml'].matchAll(/<definedName name="([^"]+)"[^>]*>([^<]*)</g)];
  assert.ok(defined.length > 0);
  for (const [, name, ref] of defined) {
    assert.ok(['_xlnm._FilterDatabase', '_xlnm.Print_Area', '_xlnm.Print_Titles'].includes(name), name);
    assert.match(ref.replace(/&apos;/g, "'"), /^'[^']+'!(\$[A-Z]+\$\d+:\$[A-Z]+\$\d+|\$\d+:\$\d+)$/);
  }
});

test('rol: verilen fiyat türü dışındaki fiyat pakete hiç girmez (satış: müşteri fiyatı yok; denetimci verisi: fabrika fiyatı yok)', () => {
  // Satış görünümü (lib/orders.ts → sanitizeRows: offerPrice boş, unitPrice = fabrika); müşteri adı maskeli
  const salesOrders = ORDERS.map((o) => ({ ...o, customer: { ...o.customer, name: `${o.customer.name.slice(0, 3)}**********` }, lines: o.lines.map((l) => ({ ...l, offerPrice: null })) }));
  const sales = loadingSummarySheets({
    subtitle: '', stats: [], firms: [firm('ALE**********', money(1, null))], total: firm('TOPLAM', money(1, null)), guests: [],
    details: [{ sheetName: 'Döküm', title: 'D', lines: buildLoadingSummary(salesOrders, { priceOf: (l) => l.unitPrice }) }], money: { sales: true, offer: false }, text: TEXT,
  });
  const sp = Object.values(parts(writeReportXlsx({ sheets: sales }))).join('\n');
  for (const n of ['ALEGRAD', 'BETA CAM']) assert.ok(!sp.includes(n), `tam ad: ${n}`);
  for (const v of ['<v>50</v>', '<v>220</v>', '<v>24</v>', '<v>400</v>', 'Teklif tutarı']) assert.ok(!sp.includes(v), `müşteri fiyatı: ${v}`);
  // Denetimci görünümü (sanitizeRows: unitPrice = müşteri fiyatı, offerPrice boş)
  const inspOrders = ORDERS.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, unitPrice: l.offerPrice, offerPrice: null })) }));
  const insp = loadingSummarySheets({
    subtitle: '', stats: [], firms: [firm('ALEGRAD', money(null, 2))], total: firm('TOPLAM', money(null, 2)), guests: [],
    details: [{ sheetName: 'Döküm', title: 'D', lines: buildLoadingSummary(inspOrders, { priceOf: (l) => l.unitPrice }) }], money: { sales: false, offer: true }, text: TEXT,
  });
  const ip = Object.values(parts(writeReportXlsx({ sheets: insp }))).join('\n');
  for (const v of ['<v>30</v>', '<v>130</v>', '<v>20</v>', '<v>160</v>', '<v>320</v>', '<v>90</v>', 'Fabrika satış', 'Fabrika)']) assert.ok(!ip.includes(v), `fabrika fiyatı: ${v}`);
});
