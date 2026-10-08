// Ortak Excel rapor yazıcısı (Paket 7, karar 190) ve dil bazlı dosya adları (karar 191): logo (saydam PNG, oran korunur),
// başlık + tarih, biçimli başlık, sütun genişliği, AutoFilter, dondurulmuş başlık, birim / para biçimleri, baskı alanı ve
// yinelenen başlık, altbilgi; yeniden yüklenen Excel'ler içe aktarıcılarla okunmaya devam eder; bütün Excel çıktıları bu
// yazıcıyı, bütün indirmeler ortak dosya adı kuralını kullanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeReportXlsx, sheetFromRows, colName } from '../server/files/xlsx-report.js';
import { readXlsx } from '../server/files/xlsx.js';
import { openZip } from '../server/files/zip.js';
import { brandLogoBytes, brandLogoSize, BRAND } from '../server/branding/index.js';
import { exportFileName, safeFilePart, contentDisposition } from '../server/files/export-name.js';
import { priceSheetRows, parsePriceSheet } from '../server/pricing/tables.js';
import { catalogSheetRows, parseCatalogSheet } from '../server/catalog/glass.js';
import { productSheetRows, parseProductSheet } from '../server/profile/catalog.js';
import { STOCK_HEADERS, parseStockSheet } from '../server/profile/stock.js';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const part = (buf, name) => openZip(buf).read(name)?.toString('utf8') ?? null;

const SHEET = {
  name: 'Firmalar', title: 'YÜKLEME ÖZETİ · 08.10.2026', subtitle: 'GKH Trading Invest SRL · Oluşturma: 08.10.2026 14:30', landscape: true,
  info: [['Sipariş', 3], ['Cam ağırlığı', '260 kg']],
  blocks: [
    {
      title: 'FİRMA BAZLI ÖZET',
      columns: [
        { header: 'Firma', width: 30, type: 'wrap' }, { header: 'Sipariş adedi', width: 10, type: 'int' }, { header: 'Toplam m²', width: 12, type: 'm2' },
        { header: 'Brüt ağırlık (kg)', width: 12, type: 'kg' }, { header: 'Teklif tutarı (EUR)', width: 16, type: 'money', unit: 'EUR' },
      ],
      rows: [['Ünsal Cam Şirketi — çok uzun bir firma adı satır kaydırmayla okunur', 2, 13.5, 310, 1045.5], ['Beta Cam', 1, 3, 0, null]],
      totals: [['TOPLAM', 3, 16.5, 310, 1045.5]],
    },
    { title: 'MİSAFİR YÜK', columns: [{ header: 'Sipariş', width: 14 }, { header: 'Sandık', width: 10 }], rows: [], empty: 'Misafir yük yok.' },
  ],
  notes: ['Fiyatlar KDV hariçtir.'],
};

test('rapor: hücre değerleri aynen okunur (başlık, bilgi satırları, tablo, toplam, not); boş tabloda cümle', () => {
  const buf = writeReportXlsx({ sheets: [SHEET] });
  const { sheetName, rows } = readXlsx(buf);
  assert.equal(sheetName, 'Firmalar');
  assert.equal(rows[0][0], 'YÜKLEME ÖZETİ · 08.10.2026');
  assert.equal(rows[1][0], 'GKH Trading Invest SRL · Oluşturma: 08.10.2026 14:30');
  assert.deepEqual(rows[2], ['Sipariş', 3]);
  const head = rows.findIndex((r) => r[0] === 'Firma');
  assert.deepEqual(rows[head], ['Firma', 'Sipariş adedi', 'Toplam m²', 'Brüt ağırlık (kg)', 'Teklif tutarı (EUR)']);
  assert.deepEqual(rows[head + 1], ['Ünsal Cam Şirketi — çok uzun bir firma adı satır kaydırmayla okunur', 2, 13.5, 310, 1045.5]);
  assert.deepEqual(rows[head + 2].slice(0, 4), ['Beta Cam', 1, 3, 0]);
  assert.deepEqual(rows[head + 3], ['TOPLAM', 3, 16.5, 310, 1045.5]);
  assert.ok(rows.some((r) => r[0] === 'Misafir yük yok.'));
  assert.equal(rows[rows.length - 1][0], 'Fiyatlar KDV hariçtir.');
  // Gereksiz boş satır yok: yalnızca bilgi / tablo / not arasında birer ayraç
  const blanks = rows.map((r, i) => (r.every((c) => c == null || c === '') ? i : -1)).filter((i) => i >= 0);
  assert.ok(blanks.length <= 4, `boş satırlar: ${blanks}`);
});

test('rapor: logo saydam PNG olarak gömülü (JPEG değil), oranı korunur, sağ üstte; altbilgi resmî firma adı + sayfa no', () => {
  const buf = writeReportXlsx({ sheets: [SHEET] });
  const png = openZip(buf).read('xl/media/image1.png');
  assert.equal(Buffer.compare(png, brandLogoBytes()), 0, 'resmî logo baytları aynen');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(openZip(buf).names().filter((n) => n.startsWith('xl/media/')), ['xl/media/image1.png'], 'tek görsel, PNG (JPEG yok)');
  assert.match(part(buf, '[Content_Types].xml'), /<Default Extension="png" ContentType="image\/png"\/>/);
  const drawing = part(buf, 'xl/drawings/drawing1.xml');
  const [cx, cy] = /<xdr:ext cx="(\d+)" cy="(\d+)"\/>/.exec(drawing).slice(1).map(Number);
  const ratio = BRAND.logo.width / BRAND.logo.height;
  assert.ok(Math.abs(cx / cy - ratio) < 0.02, `oran ${cx / cy} ≈ ${ratio}`);
  assert.equal(Math.round(cx / 9525), Math.round(brandLogoSize({ height: cy / 9525 }).width));
  assert.match(drawing, /<a:picLocks noChangeAspect="1"\/>/);
  assert.match(drawing, /<xdr:row>0<\/xdr:row>/, 'başlık satırında (veri hücresinin üstünde değil)');
  assert.match(part(buf, 'xl/worksheets/_rels/sheet1.xml.rels'), /drawings\/drawing1\.xml/);
  const sheet = part(buf, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<drawing r:id="rId1"\/><\/worksheet>$/);
  assert.match(sheet, /<oddFooter>&amp;L&amp;8GKH Trading Invest SRL&amp;R&amp;8&amp;P \/ &amp;N<\/oddFooter>/);
  // Logosuz da yazılabilir (ör. testler); o zaman çizim parçası yok
  assert.equal(openZip(writeReportXlsx({ sheets: [SHEET], logo: null })).read('xl/media/image1.png'), null);
});

test('rapor: AutoFilter ilk tabloda, başlığın altından dondurulmuş bölme, yazdırma alanı ve her sayfada yinelenen başlık', () => {
  const buf = writeReportXlsx({ sheets: [SHEET] });
  const sheet = part(buf, 'xl/worksheets/sheet1.xml');
  const rows = readXlsx(buf).rows;
  const head = rows.findIndex((r) => r[0] === 'Firma') + 1; // 1 tabanlı
  assert.match(sheet, new RegExp(`<autoFilter ref="A${head}:E${head + 2}"/>`), 'filtre: başlık + veri (toplam hariç)');
  assert.match(sheet, new RegExp(`<pane ySplit="${head}" topLeftCell="A${head + 1}" activePane="bottomLeft" state="frozen"/>`));
  assert.match(sheet, /<sheetView showGridLines="0" tabSelected="1" workbookViewId="0">/);
  assert.match(sheet, /<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"\/>/);
  assert.match(sheet, /<sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/);
  assert.match(sheet, /<cols><col min="1" max="1" width="30" customWidth="1"\/>/);
  const wb = part(buf, 'xl/workbook.xml');
  assert.match(wb, new RegExp(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Firmalar'!\\$A\\$${head}:\\$E\\$${head + 2}</definedName>`));
  assert.match(wb, /<definedName name="_xlnm.Print_Area" localSheetId="0">'Firmalar'!\$A\$1:\$E\$\d+<\/definedName>/);
  assert.match(wb, new RegExp(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Firmalar'!\\$${head}:\\$${head}</definedName>`));
  // Satır kaydırılan uzun metin: satır yüksekliği yazılır (Excel açılışta kendiliğinden uydurmaz)
  assert.match(sheet, new RegExp(`<row r="${head + 1}" ht="\\d+" customHeight="1">`));
});

test('rapor: sayı / birim / para biçimleri (değer sayı kalır), başlık ve toplam biçimi; sayfa adları güvenli ve tek', () => {
  const buf = writeReportXlsx({ sheets: [SHEET, { ...SHEET, name: 'Firmalar' }, { ...SHEET, name: 'a/b?c*[d]:e çok uzun bir sayfa adı otuz bir karakteri aşar' }] });
  const styles = part(buf, 'xl/styles.xml');
  for (const code of ['#,##0.00&quot; m²&quot;', '#,##0&quot; kg&quot;', '#,##0.00&quot; EUR&quot;']) assert.ok(styles.includes(`formatCode="${code}"`), code);
  assert.match(styles, /<fill><patternFill patternType="solid"><fgColor rgb="FFEAF1FB"\/>/, 'başlık zemini');
  assert.match(styles, /<alignment horizontal="center" vertical="center" wrapText="1"\/>/, 'başlık hücresi');
  assert.match(styles, /<alignment vertical="top" wrapText="1"\/>/, 'uzun metin kaydırılır');
  const sheet = part(buf, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<c r="E\d+" s="\d+"><v>1045.5<\/v><\/c>/, 'tutar sayı olarak yazılır (biçim yalnızca görünüm)');
  const wb = part(buf, 'xl/workbook.xml');
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 3);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3, 'tek ad');
  assert.ok(names.every((n) => n.length <= 31 && !/[\\/?*[\]:]/.test(n)), names.join(' | '));
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
});

test('yeniden yüklenen Excel\'ler ortak düzende de içe aktarıcılarla okunur (fiyat, cam kataloğu, profil kataloğu, stok)', () => {
  const sub = 'GKH Trading Invest SRL · Oluşturma: 08.10.2026 14:30';
  // Fiyat tablosu: para birimi / delik / CNC satırları ve fiyatlar
  const glasses = [{ id: 'g1', isActive: true, nameTr: '8 MM TEMPER', colorTr: 'ŞEFFAF' }, { id: 'g2', isActive: true, nameTr: '10 MM TEMPER', colorTr: null }];
  const price = writeReportXlsx({ sheets: [sheetFromRows({ name: 'Fiyatlar', rows: priceSheetRows({ name: 'Varsayılan', currency: 'EUR', holePrice: '2.5', cncPrice: '8' }, glasses, new Map([['g1', 24.5]])), headerIndex: 6, subtitle: sub, widths: [44, 24, 16], types: ['wrap', 'text', 'dec2'] })] });
  const p = parsePriceSheet(readXlsx(price).rows);
  assert.equal(p.ok, true);
  assert.deepEqual([p.currency, p.holePrice, p.cncPrice, p.items.map((i) => [i.label, i.price]), p.blank], ['EUR', 2.5, 8, [['8 MM TEMPER — ŞEFFAF', 24.5]], 1]);
  // Cam kataloğu
  const items = [{ nameTr: '8 MM TEMPER', colorTr: 'ŞEFFAF', nameRo: 'Securizat 8', colorRo: 'Transparent', nameEn: null, colorEn: null, weightKgM2: 20, isActive: true }];
  const cat = writeReportXlsx({ sheets: [sheetFromRows({ name: 'Cam kataloğu', rows: catalogSheetRows(items), headerIndex: 3, subtitle: sub, widths: [36, 20, 40, 20, 36, 20, 16, 8], types: ['wrap', 'text', 'wrap', 'text', 'wrap', 'text', 'dec2', 'text'] })] });
  const c = parseCatalogSheet(readXlsx(cat).rows);
  assert.equal(c.ok, true);
  assert.deepEqual(c.items.map((i) => [i.value.nameTr, i.value.colorTr, i.value.weightKgM2, i.value.isActive]), [['8 MM TEMPER', 'ŞEFFAF', 20, true]]);
  // Profil kataloğu
  const products = [{ code: 'GK15', nameRo: 'Garnitură 15', nameTr: 'Conta 15', unitCode: 'CUTII', listPrice: '12.5', isActive: true, sortOrder: 0, category: { code: 'GARNITURI' } }];
  const prof = writeReportXlsx({ sheets: [sheetFromRows({ name: 'Profil kataloğu', rows: productSheetRows(products), headerIndex: 3, subtitle: sub, widths: [20, 22, 48, 48, 10, 18, 8], types: ['text', 'text', 'wrap', 'wrap', 'text', 'dec2', 'text'] })] });
  const pr = parseProductSheet(readXlsx(prof).rows);
  assert.equal(pr.ok, true);
  assert.deepEqual(pr.items.map((i) => [i.value.code, i.value.categoryCode, i.value.unitCode]), [['GK15', 'GARNITURI', 'CUTII']]);
  // Stok (Adet sütunu boş gelir; doldurulup yüklenir)
  const stockRows = [['PROFİL STOĞU'], [], STOCK_HEADERS, ['GK15', 'Garnitură 15', 'CUTII', 4, 7]];
  const stock = writeReportXlsx({ sheets: [sheetFromRows({ name: 'Stok', rows: stockRows, headerIndex: 2, subtitle: sub, widths: [22, 48, 10, 10, 10], types: ['text', 'wrap', 'text', 'int', 'int'] })] });
  const st = parseStockSheet(readXlsx(stock).rows);
  assert.deepEqual(st, { ok: true, items: [{ row: 4, code: 'GK15', qty: 7 }], errors: [] });
});

test('dosya adları seçili panel dilinde ve güvenli karakterlerle (ürün sahibinin örneği)', () => {
  assert.equal(exportFileName(tr.exports.names.loadingSummary, ['2026-10-08'], 'xlsx'), 'Yukleme-Ozeti-2026-10-08.xlsx');
  assert.equal(exportFileName(ro.exports.names.loadingSummary, ['2026-10-08'], 'xlsx'), 'Rezumat-Incarcare-2026-10-08.xlsx');
  assert.equal(exportFileName(tr.exports.names.firmLoading, ['GLA', '2026-10-08'], 'pdf'), 'Yukleme-GLA-2026-10-08.pdf');
  assert.equal(exportFileName(ro.exports.names.firmLoading, ['GLA', '2026-10-08'], 'pdf'), 'Incarcare-GLA-2026-10-08.pdf');
  assert.equal(exportFileName(tr.exports.names.transportList, ['2026-10-08'], 'pdf'), 'Nakliye-Listesi-2026-10-08.pdf');
  assert.equal(exportFileName(ro.exports.names.transportList, ['2026-10-08'], 'pdf'), 'Lista-Transport-2026-10-08.pdf');
  assert.equal(exportFileName(tr.exports.names.offer, ['GLA68'], 'pdf'), 'Teklif-GLA68.pdf');
  assert.equal(exportFileName(ro.exports.names.offer, ['GLA68'], 'xlsx'), 'Oferta-GLA68.xlsx');
  assert.equal(exportFileName(tr.exports.names.glassCatalog, ['2026-10-08'], 'xlsx'), 'Cam-Katalogu-2026-10-08.xlsx');
  assert.equal(exportFileName(ro.exports.names.profileStock, ['2026-10-08'], 'xlsx'), 'Stoc-Profile-2026-10-08.xlsx');
  assert.equal(exportFileName(ro.exports.names.priceTable, ['Tabel / „Șantier” *2026*'], 'xlsx'), 'Lista-Preturi-Tabel-Santier-2026.xlsx');
  // Maskeli ad, tırnak, bölü, yıldız, satır sonu dosya adına geçmez
  assert.equal(safeFilePart('GLA**********'), 'GLA');
  assert.equal(safeFilePart('a"b\\c/d\r\ne'), 'a-b-c-d-e');
  assert.equal(safeFilePart('ĞÜŞİÖÇ ğüşıöç ĂÂÎȘȚ ăâîșț'), 'GUSIOC-gusioc-AAIST-aaist');
  assert.equal(contentDisposition('Yukleme-Ozeti-2026-10-08.xlsx'), 'attachment; filename="Yukleme-Ozeti-2026-10-08.xlsx"');
  assert.equal(contentDisposition('x"y.pdf', { inline: true }), 'inline; filename="xy.pdf"');
  for (const [k, v] of Object.entries(tr.exports.names)) assert.ok(v && ro.exports.names[k], k);
});

test('yapı: TAKİP\'in bütün Excel çıktıları ortak rapor yazıcısını, bütün indirmeler ortak dosya adı kuralını kullanır', () => {
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const code = [...walk('app'), ...walk('lib'), ...walk('server')].filter((f) => /\.(js|ts|tsx|mjs)$/.test(f) && !f.includes(`${path.sep}i18n${path.sep}`));
  // Excel üreten her yer writeReportXlsx kullanır; eski writeXlsx yalnızca kendi modülünde (testler ve e2e içe aktarma dosyası hazırlar)
  const raw = code.filter((f) => /\bwriteXlsx\(/.test(read(f)) && f !== path.join('server', 'files', 'xlsx.js'));
  assert.deepEqual(raw, [], 'Excel çıktıları ortak rapor yazıcısından');
  const reports = code.filter((f) => /\bwriteReportXlsx\(/.test(read(f)) && f !== path.join('server', 'files', 'xlsx-report.js')).sort();
  assert.deepEqual(reports, [
    'app/(panel)/admin/fiyatlar/excel/route.ts', 'app/(panel)/admin/katalog/excel/route.ts', 'app/(panel)/admin/profil-katalogu/excel/route.ts',
    'app/(panel)/admin/stok/excel/route.ts', 'app/(panel)/yuklemeler/dokum/route.ts', 'app/(panel)/yuklemeler/firma/route.ts', 'server/orders/offer-export.js',
  ].map((f) => f.split('/').join(path.sep)));
  // İndirme başlığı: elle "filename=" yazan yer yok (yalnızca yüklenen dosya — kullanıcının özgün dosya adı). FGO belgesinin PDF'i
  // de ortak kuralla: panel dilinde belge türü + belge numarası
  const manual = code.filter((f) => /filename="\$\{/.test(read(f)) && f !== path.join('server', 'files', 'export-name.js')).sort();
  assert.deepEqual(manual, ['app/dosya/[kind]/[id]/route.ts'].map((f) => f.split('/').join(path.sep)));
  const doc = read(path.join('app', '(panel)', 'belgeler', '[id]', 'pdf', 'route.ts'));
  assert.match(doc, /exportFileName\(t\(`documents\.kind\.\$\{kind\}`/);
  assert.match(doc, /contentDisposition\(name, \{ inline: true \}\)/);
});
