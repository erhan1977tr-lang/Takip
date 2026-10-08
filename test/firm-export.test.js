// Firma + yükleme günü çıktısı (Yüklemeler → firma satırı → "PDF" / "Excel"; Paket 7, karar 187): yalnızca o firmanın o günkü
// siparişleri ve sandıkları; finansal olarak YALNIZCA müşteri teklif tutarı (görebilen rolde) — fabrika satış tutarı hiçbir
// alana, hücreye ya da PDF metnine girmez; satışın çıktısında tutar yok; misafir yükte ev sahibi firmanın adı yazılmaz, ev
// sahibinin sandığındaki başka firma siparişi listelenmez; PDF Türkçe / Romence harfleri gömülü yazı tipiyle basar, uzun
// listede tablo başlığı her sayfada yinelenir ve her sayfada "sayfa / toplam" altbilgisi vardır.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { dayFirms } from '../server/loading/day-firms.js';
import { firmExportData, firmExportSheet } from '../server/loading/firm-export.js';
import { firmLoadingPdf } from '../server/pdf/firm-loading.js';
import { writeReportXlsx } from '../server/files/xlsx-report.js';
import { readXlsx } from '../server/files/xlsx.js';
import { FONTS } from '../server/pdf/fonts.js';

const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
/** PDF içerik akışlarındaki metinler, sayfa sayfa */
function pdfPages(pdf) {
  const pages = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    const lines = [];
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'];
      lines.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
    if (lines.length) pages.push(lines);
  }
  return pages;
}

const load = (o = {}) => ({ metraj: 2, camAdet: 2, cnc: 0, delik: 0, netKg: 40, ...o });
const entry = (orderId, customerId, o = {}) => ({
  orderId, orderNo: orderId.toUpperCase(), customerId, customerName: `Firma ${customerId}`, guestHostId: null, replan: false,
  o: { title: o.title ?? `Proje ${orderId}` }, load: load(o.load), money: { currency: 'EUR', sales: 111.11, offer: 222.22, ...o.money }, ...o.extra,
});
const crate = (id, customerId, crateNo, o = {}) => ({ id, crateNo, customerId, customerName: `Firma ${customerId}`, lengthMm: 2400, widthMm: 800, heightMm: 1900, netAgirlik: null, brutAgirlik: null, daraKg: 50, orderIds: [], ...o });
const firmOf = (r, id) => r.firms.find((f) => f.id === id);

const TEXT = (locale = 'tr') => (locale === 'tr' ? {
  title: 'YÜKLEME LİSTESİ', firm: 'Ünsal Cam Şirketi', day: 'Yükleme günü: 08.10.2026', generated: 'Oluşturma: 08.10.2026',
  ordersTitle: 'SİPARİŞLER', cratesTitle: 'SANDIKLAR', total: 'TOPLAM', noOrders: 'Sipariş yok.', noCrates: 'Sandık girilmemiş.',
  stats: [['Sipariş', '2'], ['Cam', '5']], notes: ['Fiyatlar KDV hariçtir.'],
  cols: { order: 'Sipariş No', project: 'Proje', glass: 'Cam', cnc: 'CNC', holes: 'Delik', m2: 'Toplam m²', offer: 'Teklif tutarı', crate: 'Sandık', dims: 'Ölçü (mm)', net: 'Net kg', gross: 'Brüt kg', orders: 'Siparişler', note: 'Not' },
} : {
  title: 'LISTĂ DE ÎNCĂRCARE', firm: 'Sticlă și Uși SRL', day: 'Ziua încărcării: 08.10.2026', generated: 'Generat: 08.10.2026',
  ordersTitle: 'COMENZI', cratesTitle: 'LĂZI', total: 'TOTAL', noOrders: 'Nicio comandă.', noCrates: 'Nicio ladă introdusă.',
  stats: [['Comenzi', '2'], ['Sticlă', '5']], notes: ['Prețurile nu includ TVA.'],
  cols: { order: 'Nr. comandă', project: 'Proiect', glass: 'Sticlă', cnc: 'CNC', holes: 'Găuri', m2: 'Total m²', offer: 'Valoare ofertă', crate: 'Ladă', dims: 'Dimensiuni (mm)', net: 'Net kg', gross: 'Brut kg', orders: 'Comenzi', note: 'Notă' },
});
const SHEET_TEXT = {
  title: 'YÜKLEME LİSTESİ · Firma A · 08.10.2026', subtitle: 'GKH Trading Invest SRL · Oluşturma: 08.10.2026', sheet: 'Yükleme',
  ordersTitle: 'SİPARİŞLER', cratesTitle: 'SANDIKLAR', total: 'TOPLAM', noOrders: 'Sipariş yok.', noCrates: 'Sandık girilmemiş.',
  info: [['Firma', 'Firma A']], notes: ['Fiyatlar KDV hariçtir.'], cols: TEXT('tr').cols,
};
const cells = (buf) => readXlsx(buf).rows.flat().filter((c) => c != null && c !== '');

test('yönetici / denetimci: yalnızca teklif tutarı — fabrika satış tutarı veride, Excel hücrelerinde ve PDF metninde yok', () => {
  const r = dayFirms({
    entries: [
      entry('a1', 'A', { load: { camAdet: 3, metraj: 3.5, cnc: 1, delik: 2 } }),
      entry('a2', 'A', { load: { camAdet: 2, metraj: 1.25 }, money: { sales: 333.33, offer: 444.44 } }),
      entry('b1', 'B'),
    ],
  });
  const d = firmExportData(firmOf(r, 'A'), { offer: true });
  assert.deepEqual(d.orders.map((o) => [o.orderNo, o.camAdet, o.cnc, o.delik, o.metraj, o.offer, o.currency]), [['A1', 3, 1, 2, 3.5, 222.22, 'EUR'], ['A2', 2, 0, 0, 1.25, 444.44, 'EUR']]);
  assert.deepEqual(d.currencies, ['EUR']);
  assert.deepEqual(d.totals, { orders: 2, camAdet: 5, cnc: 1, delik: 2, metraj: 4.75, offer: { EUR: 666.66 } });
  assert.ok(!JSON.stringify(d).includes('111.11') && !JSON.stringify(d).includes('333.33'), 'fabrika satış tutarı veride yok');
  assert.ok(!JSON.stringify(d).includes('Firma B') && !d.orders.some((o) => o.orderNo === 'B1'), 'yalnızca seçilen firma');

  const xlsx = writeReportXlsx({ sheets: [firmExportSheet(d, SHEET_TEXT)], logo: null });
  const all = cells(xlsx);
  assert.ok(all.includes(222.22) && all.includes(444.44) && all.includes(666.66), 'teklif tutarları ve toplamı');
  assert.ok(!all.includes(111.11) && !all.includes(333.33), 'satış tutarı hücrede yok');
  assert.ok(all.includes('Teklif tutarı (EUR)'));
  assert.ok(!all.some((c) => typeof c === 'string' && /fabrika|satış tutarı/i.test(c)), 'fabrika sütunu yok');

  const text = pdfPages(firmLoadingPdf(d, TEXT('tr'))).flat();
  assert.ok(text.includes('222,22 EUR') && text.includes('444,44 EUR') && text.includes('666,66 EUR'), text.join(' | '));
  assert.ok(!text.some((l) => /111,11|333,33/.test(l)), 'PDF\'te satış tutarı yok');
  assert.ok(text.includes('Teklif tutarı'));
});

test('satış: tutar sütunu ve toplamı hiç yok (Excel ve PDF); farklı para birimleri ayrı sütun / satır, toplanmaz', () => {
  const r = dayFirms({ entries: [entry('a1', 'A', { money: { offer: null } }), entry('a2', 'A', { money: { currency: 'RON', sales: 50, offer: null } })] });
  const d = firmExportData(firmOf(r, 'A'), { offer: false });
  assert.deepEqual(d.currencies, []);
  assert.ok(d.orders.every((o) => o.offer === null));
  assert.deepEqual(d.totals.offer, {});
  const sheet = firmExportSheet(d, SHEET_TEXT);
  assert.equal(sheet.blocks[0].columns.length, 6, 'sipariş, proje, cam, CNC, delik, m²');
  assert.ok(!cells(writeReportXlsx({ sheets: [sheet], logo: null })).some((c) => typeof c === 'string' && c.startsWith('Teklif tutarı')));
  const text = pdfPages(firmLoadingPdf(d, TEXT('tr'))).flat();
  assert.ok(!text.includes('Teklif tutarı') && !text.some((l) => /EUR|RON/.test(l)), text.join(' | '));

  // Yönetici: EUR ve RON ayrı sütun; her sipariş yalnızca kendi para biriminin sütununda; toplamlar ayrı
  const mixed = dayFirms({ entries: [entry('a1', 'A', { money: { offer: 100 } }), entry('a2', 'A', { money: { currency: 'RON', offer: 500 } }), entry('a3', 'A', { money: { offer: 50.5 } })] });
  const dm = firmExportData(firmOf(mixed, 'A'), { offer: true });
  assert.deepEqual(dm.currencies, ['EUR', 'RON']);
  assert.deepEqual(dm.totals.offer, { EUR: 150.5, RON: 500 });
  const ms = firmExportSheet(dm, SHEET_TEXT);
  assert.deepEqual(ms.blocks[0].columns.slice(6).map((c) => [c.header, c.type, c.unit]), [['Teklif tutarı (EUR)', 'money', 'EUR'], ['Teklif tutarı (RON)', 'money', 'RON']]);
  assert.deepEqual(ms.blocks[0].rows.map((row) => row.slice(6)), [[100, null], [null, 500], [50.5, null]]);
  assert.deepEqual(ms.blocks[0].totals, [['TOPLAM', null, 6, 0, 0, 6, 150.5, 500]]);
  const mt = pdfPages(firmLoadingPdf(dm, TEXT('tr'))).flat();
  assert.ok(mt.includes('150,50 EUR') && mt.includes('500,00 RON'), 'para birimi başına ayrı toplam satırı');
});

test('misafir yük: sahibinin çıktısında yalnızca sandık NUMARASI (ev sahibi adı yok); ev sahibinin çıktısında başka firmanın siparişi yok', () => {
  const entries = [
    entry('u1', 'A', { load: { netKg: 200 }, extra: { guestHostId: 'B' } }),
    entry('u2', 'A', { load: { netKg: 80 } }),
    entry('b1', 'B', { load: { netKg: 60 } }),
  ];
  const crates = [crate('c15', 'B', 15, { orderIds: ['b1', 'u1'], note: 'kırılacak' }), crate('c3', 'A', 3, { orderIds: ['u2'] })];
  const links = [{ orderId: 'u1', crateId: 'c15', crateNo: 15, hostId: 'B', hostName: 'Firma B', byHost: true }];
  const r = dayFirms({ entries, crates, links });

  const a = firmExportData(firmOf(r, 'A'), { offer: true });
  assert.deepEqual(a.orders.map((o) => [o.orderNo, o.guest, o.guestCrate, o.waiting]), [['U1', true, 15, false], ['U2', false, null, false]]);
  assert.ok(!JSON.stringify(a).includes('Firma B'), 'ev sahibi firmanın adı A\'nın çıktısında yok');
  assert.deepEqual(a.crates.map((c) => [c.no, c.orders]), [[3, ['U2']]], 'A: yalnızca kendi sandığı; misafir sipariş B\'nin sandığında');
  assert.deepEqual(a.physical, { crates: 1, netKg: 80, grossKg: firmOf(r, 'A').grossKg, realCrates: true }, 'misafir camın ağırlığı A\'da sayılmaz');

  const b = firmExportData(firmOf(r, 'B'), { offer: true });
  assert.deepEqual(b.orders.map((o) => o.orderNo), ['B1'], 'B: yalnızca kendi siparişi (ticari)');
  assert.deepEqual(b.crates, [{ no: 15, dims: '2400 × 800 × 1900', net: null, gross: null, note: 'kırılacak', orders: ['B1'] }], 'misafir U1 B\'nin listesine yazılmaz');
  assert.ok(!JSON.stringify(b).includes('U1') && !JSON.stringify(b).includes('Firma A'));
  assert.equal(b.physical.netKg, 260, 'fiziksel ağırlık ev sahibinde: kendi camı + misafir cam (bir kez)');

  // Sandık bekliyor: numara yok, "bekliyor"
  const waiting = firmExportData(firmOf(dayFirms({ entries }), 'A'), { offer: false });
  assert.deepEqual(waiting.orders.map((o) => [o.orderNo, o.guestCrate, o.waiting]), [['U1', null, true], ['U2', null, false]]);
});

test('PDF: Türkçe ve Romence harfler gömülü yazı tipiyle; uzun listede başlık her sayfada yinelenir; her sayfada "n / toplam"', () => {
  const many = Array.from({ length: 70 }, (_, i) => entry(`r${String(i).padStart(2, '0')}`, 'R', { title: `Ușă — ștuț țâță İğne ${i}`, money: { currency: 'RON', offer: 10 + i } }));
  const r = dayFirms({ entries: many, crates: [crate('k1', 'R', 1, { orderIds: ['r00', 'r01'], netAgirlik: '612.4', brutAgirlik: '670' })] });
  const d = firmExportData(firmOf(r, 'R'), { offer: true });
  const pages = pdfPages(firmLoadingPdf(d, TEXT('ro')));
  assert.ok(pages.length >= 2, `sayfa: ${pages.length}`);
  pages.forEach((p, i) => {
    assert.ok(p.includes(`${i + 1} / ${pages.length}`), `altbilgi sayfa ${i + 1}`);
    assert.ok(p.some((l) => l.startsWith('GKH Trading Invest')), 'altbilgide resmî firma adı');
  });
  // Sipariş tablosunun başlığı ilk sayfada ve tablonun devam ettiği her sayfada
  const withOrders = pages.filter((p) => p.some((l) => /^R\d\d$/.test(l)));
  assert.ok(withOrders.length >= 2);
  for (const p of withOrders) assert.ok(p.includes('Nr. comandă') && p.includes('Valoare ofertă'), 'başlık yinelenir');
  const text = pages.flat();
  assert.ok(text.includes('LISTĂ DE ÎNCĂRCARE') && text.includes('Sticlă și Uși SRL'), 'Romence harfler (ă î ș)');
  assert.ok(text.includes('Ușă — ștuț țâță İğne 7'), 'ș ț ă â İ ğ okunur');
  assert.ok(!text.some((l) => l.includes('?')), 'eksik glif yok');
  assert.equal(text.filter((l) => /^R\d\d$/.test(l)).length, 70, 'her sipariş bir kez');
  assert.ok(text.includes('612') && text.includes('670'), 'sandık ağırlıkları (kg, tam sayı)');
  assert.ok(text.includes(`${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2 }).format(many.reduce((s, e) => s + e.money.offer, 0))} RON`), 'toplam');

  // Boş gün: siparişsiz / sandıksız firma çıktısı da üretilir (boş cümleleriyle)
  const empty = pdfPages(firmLoadingPdf(firmExportData({ id: 'X', name: 'X', rows: [], crateList: [], orders: 0, camAdet: 0, cnc: 0, delik: 0, metraj: 0, netKg: 0, grossKg: 0, crates: 0, realCrates: false }, { offer: true }), TEXT('tr'))).flat();
  assert.ok(empty.includes('Sipariş yok.') && empty.includes('Sandık girilmemiş.') && empty.includes('1 / 1'));
});
