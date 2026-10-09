// Yönetici Paneli Düzeltme Paketi 1 (kararlar 215–218): yükleme firma satırının belge işlemleri (role göre), firma PDF /
// Excel / Özet ayrıntısı (aynı veri; sandık parası ayrı, numaralı kalem; para birimleri toplanmaz), "Profil Siparişleri"
// bölümü ve sayacı, yöneticinin "Sıra bende"si, satışın fabrika fiyatı değişikliğinin parmak izi. Saf kurallar + yapı
// denetimi (veritabanıyla: test/db/admin-fixes.test.js; tarayıcıda: e2e/47-yonetici-paneli.spec.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { can, ROLE_PERMISSIONS } from '../server/auth/permissions.js';
import { dayFirms } from '../server/loading/day-firms.js';
import { detailTotals, firmDocsAllowed, firmExportData, firmExportSheets, firmSummaryData, orderDetail } from '../server/loading/firm-export.js';
import { loadedOffer } from '../server/orders/loading.js';
import { firmLoadingPdf } from '../server/pdf/firm-loading.js';
import { writeReportXlsx } from '../server/files/xlsx-report.js';
import { readXlsx } from '../server/files/xlsx.js';
import { FONTS } from '../server/pdf/fonts.js';
import { CRATE_LINE, atOfferPrice, offerTotals } from '../server/orders/rules.js';
import { ADMIN_QUEUES, SALES_QUEUES, isNewProfileOrder, newProfileCount, newProfileWhere, profileQueues } from '../server/orders/queues.js';
import { overrideKey, recordPriceOverrides } from '../server/pricing/alerts.js';
import { DICTS } from '../server/i18n/index.js';

const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ROLES = Object.keys(ROLE_PERMISSIONS);

// ---------- Teklif satırları: cam + CNC + delik (alt satır), satışın sandık parası, yöneticinin sandık bedeli, bedelsiz telafi ----------
const line = (o) => ({ description: 'Temper 8 mm', descriptionRo: 'Securizat 8 mm', poz: '', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', kind: 'CAM', free: false, crateFee: false, pieceBase: 0, ...o });
const LINES = [
  line({ poz: 'P1', adet: 2, unitPrice: '37', offerPrice: '50' }), // 2 m²: satış 74 · müşteri 100
  line({ description: 'CNC', descriptionRo: null, enMm: null, boyMm: null, adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' }), // 10 · 20
  line({ description: 'Delik', descriptionRo: null, enMm: null, boyMm: null, adet: 4, unit: 'adet', kind: 'DELIK', unitPrice: '2', offerPrice: '5' }), // 8 · 20
  line({ description: CRATE_LINE.tr, descriptionRo: CRATE_LINE.ro, enMm: null, boyMm: null, adet: 2, unit: 'adet', unitPrice: '25', offerPrice: '30' }), // satışın sandığı: 50 · 60
  line({ description: CRATE_LINE.tr, descriptionRo: CRATE_LINE.ro, enMm: null, boyMm: null, adet: 1, unit: 'adet', crateFee: true, unitPrice: '0', offerPrice: '45' }), // yöneticinin: 0 · 45
  line({ enMm: 500, boyMm: 1000, adet: 1, free: true, unitPrice: '37', offerPrice: '0' }), // bedelsiz telafi: 0,5 m² · 0 · 0
];
const sent = (lines = LINES, o = {}) => ({ status: 'GONDERILDI', currency: 'EUR', lines, ...o });
const ADMIN_PRICE = (l) => l.offerPrice;
const SALES_PRICE = (l) => l.unitPrice;
const kindLabel = (k) => ({ CNC: 'CNC', DELIK: 'Delik' })[k] ?? k;

test('belge işlemleri (karar 215): PDF / Excel / Özet yalnızca yükleme belgesi + müşteri fiyatı yetkisinde — yönetici ve denetimci; satış, çizim, müşteri değil', () => {
  const allowed = ROLES.filter((r) => firmDocsAllowed((p) => can(r, p)));
  assert.deepEqual(allowed.sort(), ['ADMIN', 'DENETIMCI']);
  // Satış yükleme belgelerini (nakliye listesi, gün özeti) indirir ama firma satırında yalnızca "Sandık"ı görür
  assert.ok(can('SATIS', 'TRANSPORT_LIST_VIEW') && can('SATIS', 'CRATE_EDIT') && !can('SATIS', 'PRICE_FINAL_VIEW'));
});

test('yükleme hesabının teklifi tek kural (loadedOffer): iç ekipte gönderilmiş son teklif, yoksa son taslak; müşteride yalnızca gönderilmiş', () => {
  const draft = { status: 'HAZIRLANIYOR', id: 'd' };
  const s = { status: 'GONDERILDI', id: 's' };
  assert.equal(loadedOffer([draft, s], false)?.id, 's', 'gönderilmiş teklif yeni taslağın önünde');
  assert.equal(loadedOffer([draft, s], true)?.id, 's');
  assert.equal(loadedOffer([draft], false)?.id, 'd');
  assert.equal(loadedOffer([draft], true), null);
  assert.equal(loadedOffer([], false), null);
  assert.equal(loadedOffer(undefined, true), null);
});

test('sipariş ayrıntısı (orderDetail): teklif tablosundaki satırlar — cam numaralı, CNC / delik numarasız, sandık parası ayrı numaralı kalem; tutar teklifle aynı', () => {
  const d = orderDetail({ offers: [sent()] }, { price: ADMIN_PRICE, salesPrice: SALES_PRICE, kindLabel });
  assert.deepEqual(d.rows.map((r) => [r.n, r.desc, r.adet, r.m2, r.unitPrice, r.amount, r.salesUnitPrice, r.salesAmount, r.free]), [
    [1, 'Temper 8 mm', 2, 2, 50, 100, 37, 74, false],
    [null, 'CNC', 2, null, 10, 20, 5, 10, false],
    [null, 'Delik', 4, null, 5, 20, 2, 8, false],
    [2, CRATE_LINE.tr, 2, null, 30, 60, 25, 50, false],
    [3, CRATE_LINE.tr, 1, null, 45, 45, 0, 0, false],
    [4, 'Temper 8 mm', 1, 0.5, 0, 0, 0, 0, true],
  ]);
  // Sipariş tutarı = satırların toplamı = kayıtlı tutar kuralı (offerTotals); her satır BİR kez (sandık parası çift sayılmaz)
  assert.deepEqual([d.total, d.salesTotal, d.metraj, d.currency, d.sent], [245, 142, 2.5, 'EUR', true]);
  assert.equal(d.total, offerTotals(atOfferPrice(LINES)).amount);
  assert.equal(d.salesTotal, offerTotals(LINES).amount);
  // Romence açıklama panel dilinde
  assert.equal(orderDetail({ offers: [sent()] }, { price: ADMIN_PRICE, locale: 'ro', kindLabel }).rows[0].desc, 'Securizat 8 mm');
  // Gönderilmemiş teklif: müşteri fiyatı ve tutarı yok (fabrika satışı yöneticinin Özet'inde durur)
  const draft = orderDetail({ offers: [{ ...sent(), status: 'YONETIMDE' }] }, { price: ADMIN_PRICE, salesPrice: SALES_PRICE, kindLabel });
  assert.deepEqual([draft.sent, draft.total, draft.salesTotal], [false, null, 142]);
  assert.ok(draft.rows.every((r) => r.unitPrice == null && r.amount == null));
  // Müşteri fiyatını görmeyen rol (price yok): tutar yok
  const blind = orderDetail({ offers: [sent()] }, { kindLabel });
  assert.ok(blind.total == null && blind.rows.every((r) => r.amount == null && r.salesAmount === undefined));
  assert.deepEqual(orderDetail({ offers: [] }, { price: ADMIN_PRICE }), { sent: false, currency: null, rows: [], metraj: 0, total: null, salesTotal: null });
});

// ---------- Firma satırı: iki EUR siparişi, bir RON siparişi; misafir yük ----------
const load = (o = {}) => ({ metraj: 2.5, camAdet: 4, cnc: 2, delik: 4, netKg: 50, ...o });
const entry = (orderId, o = {}) => ({
  orderId, orderNo: orderId.toUpperCase(), customerId: 'A', customerName: 'Firma A', guestHostId: null, replan: false,
  o: { title: `Proje ${orderId}`, offers: [sent(o.lines ?? LINES, { currency: o.currency ?? 'EUR' })], ...(o.o ?? {}) },
  load: load(o.load), money: { currency: o.currency ?? 'EUR', sales: 142, offer: 245, ...o.money }, ...o.extra,
});
const RON_LINES = [line({ adet: 4, enMm: 1000, boyMm: 500, unitPrice: '150', offerPrice: '200' })]; // 2 m²: 300 · 400
const firmA = () => dayFirms({
  entries: [
    entry('a1'),
    entry('a2', { lines: [line({ adet: 1, unitPrice: '37', offerPrice: '50' })], load: { metraj: 1, camAdet: 1, cnc: 0, delik: 0 }, money: { sales: 37, offer: 50 } }),
    entry('a3', { lines: RON_LINES, currency: 'RON', load: { metraj: 2, camAdet: 4, cnc: 0, delik: 0 }, money: { sales: 300, offer: 400 } }),
  ],
}).firms.find((f) => f.id === 'A');

test('firma PDF / Excel (karar 215): aynı veri — sipariş başına teklif satırları, müşteri tutarı; sipariş tutarı = satırların toplamı; para birimleri ayrı; fabrika satışı yok', () => {
  const d = firmExportData(firmA(), { offer: true, price: ADMIN_PRICE, kindLabel });
  assert.deepEqual(d.orders.map((o) => [o.orderNo, o.currency, o.offer, o.detail.rows.length]), [['A1', 'EUR', 245, 6], ['A2', 'EUR', 50, 1], ['A3', 'RON', 400, 1]]);
  assert.deepEqual(d.currencies, ['EUR', 'RON']);
  assert.deepEqual(d.totals.offer, { EUR: 295, RON: 400 }, 'para birimi başına — toplanmaz');
  assert.deepEqual(detailTotals(d), [{ currency: 'EUR', m2: 3.5, amount: 295 }, { currency: 'RON', m2: 2, amount: 400 }]);
  assert.ok(!JSON.stringify(d).includes('salesAmount'), 'fabrika satış tutarı firma çıktısının verisinde yok');
  const cols = {
    order: 'Sipariş No', project: 'Proje', glass: 'Cam', cnc: 'CNC', holes: 'Delik', m2: 'm²', offer: 'Teklif tutarı', crate: 'Sandık', dims: 'Ölçü', net: 'Net', gross: 'Brüt',
    orders: 'Siparişler', note: 'Not', n: '#', desc: 'Açıklama', poz: 'Poz', en: 'En', boy: 'Boy', adet: 'Adet', unitPrice: 'Birim fiyat', amount: 'Tutar',
  };
  const text = {
    title: 'YÜKLEME LİSTESİ', subtitle: 'GKH', sheet: 'Yükleme', detailSheet: 'Ayrıntı', detailTitle: 'SİPARİŞ AYRINTISI', ordersTitle: 'SİPARİŞLER', cratesTitle: 'SANDIKLAR',
    total: 'Toplam', noCrates: 'yok', noOrders: 'yok', free: 'bedelsiz', currency: 'Para birimi', replanNote: '{from} yüklemesinden aktarılan kalan', info: [], notes: [], cols,
  };
  const [first, detail] = firmExportSheets(d, text);
  // 1. sayfa: sipariş başına tek satır, tutar = ayrıntının toplamı
  assert.deepEqual(first.blocks[0].rows.map((r) => r.slice(0, 1).concat(r.slice(6))), [['A1', 245, null], ['A2', 50, null], ['A3', null, 400]]);
  assert.deepEqual(first.blocks[0].totals[0].slice(6), [295, 400]);
  // 2. sayfa: her teklif satırı (sipariş no her satırda — süzgeç), bedelsiz satırda "bedelsiz", toplam para birimi başına
  assert.equal(detail.blocks[0].rows.length, 8);
  assert.deepEqual(detail.blocks[0].rows.filter((r) => r[0] === 'A1').map((r) => [r[2], r[3], r[9], r[10], r[11]]), [
    [1, 'Temper 8 mm', 50, 100, 'EUR'], ['', 'CNC', 10, 20, 'EUR'], ['', 'Delik', 5, 20, 'EUR'], [2, CRATE_LINE.tr, 30, 60, 'EUR'], [3, CRATE_LINE.tr, 45, 45, 'EUR'], [4, 'Temper 8 mm', 'bedelsiz', 0, 'EUR'],
  ]);
  assert.deepEqual(detail.blocks[0].totals.map((r) => [r[8], r[10], r[11]]), [[3.5, 295, 'EUR'], [2, 400, 'RON']]);
  // İki sayfa da ortak rapor yazıcısıyla kurulur; ilk sayfa geri okunur
  const buf = writeReportXlsx({ sheets: [first, detail], logo: null });
  assert.ok(readXlsx(buf).rows.flat().includes(245));
});

/** PDF içerik akışlarındaki metinler (test/firm-export.test.js ile aynı okuyucu) */
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
function pdfText(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'];
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out;
}

test('firma PDF ayrıntısı: her siparişin satırları ve sipariş toplamı (Tekliflerim düzeyi); sandık parası ayrı satır; fabrika satış fiyatı yazılmaz', () => {
  const d = firmExportData(firmA(), { offer: true, price: ADMIN_PRICE, kindLabel });
  const pdf = firmLoadingPdf(d, {
    title: 'YÜKLEME LİSTESİ', firm: 'Firma A', day: 'Yükleme günü: 08.10.2026', generated: 'Oluşturma: 08.10.2026',
    ordersTitle: 'SİPARİŞLER', cratesTitle: 'SANDIKLAR', total: 'TOPLAM', noOrders: 'yok', noCrates: 'yok', stats: [['Sipariş', '3']], notes: ['Fiyatlar KDV hariçtir.'],
    cols: { order: 'Sipariş No', project: 'Proje', glass: 'Cam', cnc: 'CNC', holes: 'Delik', m2: 'm²', offer: 'Teklif tutarı', crate: 'Sandık', dims: 'Ölçü', net: 'Net', gross: 'Brüt', orders: 'Siparişler', note: 'Not', n: '#', desc: 'Açıklama', poz: 'Poz', en: 'En', boy: 'Boy', adet: 'Adet', unitPrice: 'Birim fiyat', amount: 'Tutar' },
    detailTitle: 'SİPARİŞ AYRINTISI', subtotal: 'Sipariş toplamı', free: 'bedelsiz', piece: 'adet', notSent: 'Teklif gönderilmedi', replanNote: '{from} yüklemesinden',
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(pdf);
  const joined = text.join('\n');
  for (const s of ['SİPARİŞ AYRINTISI', 'Sipariş toplamı', CRATE_LINE.tr, 'bedelsiz', '245,00', '400,00']) assert.ok(joined.includes(s), s);
  // Siparişlerin başlıkları ayrıntıda (her sipariş kendi bölümünde)
  for (const no of ['A1', 'A2', 'A3']) assert.ok(text.some((t) => t.startsWith(`${no} — `)), no);
  // Sandık parası iki ayrı numaralı satır (satışın ve yöneticinin) — toplama bir kez girer
  assert.equal(text.filter((t) => t === CRATE_LINE.tr).length, 2);
  // Fabrika satış fiyatları (37 / m², satış tutarı 74, 142) belgede yok
  for (const s of ['37,00', '74,00', '142,00']) assert.ok(!joined.includes(s), `fabrika satışı yok: ${s}`);
});

test('Özet (karar 215): yöneticide fabrika satış ve müşteri teklifi AYRI — satır, sipariş, para birimi; toplanmaz; denetimcide tutar yok', () => {
  const s = firmSummaryData(firmA(), { finance: true, salesPrice: SALES_PRICE, price: ADMIN_PRICE, kindLabel });
  assert.deepEqual(s.orders.map((o) => [o.orderNo, o.currency, o.sales, o.offer]), [['A1', 'EUR', 142, 245], ['A2', 'EUR', 37, 50], ['A3', 'RON', 300, 400]]);
  assert.deepEqual(s.currencies, ['EUR', 'RON']);
  assert.deepEqual(s.totals, { EUR: { sales: 179, offer: 295, hasSales: true, hasOffer: true }, RON: { sales: 300, offer: 400, hasSales: true, hasOffer: true } });
  // Sandık parası ayrı satır, iki fiyatıyla (satışın sandığında satış fiyatı var; yöneticininkinde 0)
  const crates = s.orders[0].detail.rows.filter((r) => r.desc === CRATE_LINE.tr).map((r) => [r.n, r.salesAmount, r.amount]);
  assert.deepEqual(crates, [[2, 50, 60], [3, 0, 45]]);
  // Gönderilmemiş teklif: fabrika satışı var, müşteri tutarı yok (para birimi toplamına girmez)
  const unsent = dayFirms({ entries: [entry('u1', { o: { offers: [{ ...sent(), status: 'YONETIMDE' }] }, money: { sales: 142, offer: null } })] }).firms[0];
  const u = firmSummaryData(unsent, { finance: true, salesPrice: SALES_PRICE, price: ADMIN_PRICE, kindLabel });
  assert.deepEqual([u.orders[0].sales, u.orders[0].offer, u.orders[0].sent, u.totals.EUR], [142, null, false, { sales: 142, offer: 0, hasSales: true, hasOffer: false }]);
  // Denetimci (finance yok): satırlar fiyatsız, tutar yok
  const i = firmSummaryData(firmA(), { finance: false, salesPrice: SALES_PRICE, price: ADMIN_PRICE, kindLabel });
  assert.deepEqual([i.currencies, i.orders.every((o) => o.sales == null && o.offer == null), i.orders[0].detail.rows.every((r) => r.amount == null && r.salesAmount === undefined)], [[], true, true]);
});

test('misafir yük: sandık ve ağırlık yalnızca taşıyan firmada; firma çıktısında yalnızca sandık NUMARASI — iki kez sayılmaz', () => {
  const r = dayFirms({
    entries: [entry('a1', { extra: { guestHostId: 'B' } }), { ...entry('b1'), customerId: 'B', customerName: 'Firma B', orderNo: 'B1' }],
    crates: [{ id: 'c1', crateNo: 15, customerId: 'B', customerName: 'Firma B', lengthMm: 2400, widthMm: 800, heightMm: 1900, netAgirlik: null, brutAgirlik: null, daraKg: 50, orderIds: ['b1', 'a1'] }],
    links: [{ crateId: 'c1', crateNo: 15, orderId: 'a1', hostId: 'B' }],
  });
  const a = r.firms.find((f) => f.id === 'A');
  const b = r.firms.find((f) => f.id === 'B');
  assert.equal(a.crates + b.crates, r.total.crates, 'sandık iki kez sayılmaz');
  assert.equal(a.grossKg + b.grossKg, r.total.grossKg, 'ağırlık iki kez sayılmaz');
  assert.equal(a.crates, 0);
  const d = firmExportData(a, { offer: true, price: ADMIN_PRICE, kindLabel });
  assert.deepEqual([d.orders[0].guest, d.orders[0].guestCrate], [true, 15]);
  assert.ok(!JSON.stringify(d).includes('Firma B'), 'başka firmanın adı yok');
});

test('profil bölümü (karar 216): yeni profil siparişi = fiyat bekleyen, kapanmamış; sayaç ve tablo aynı kural; sayaç kullanıcının kapsamında', async () => {
  const p = (stage, status = 'YENI', extra = {}) => ({ orderTypeCode: 'PROFILE_ORDER', status, profile: { stage }, ...extra });
  assert.equal(isNewProfileOrder(p('FIYAT_BEKLIYOR')), true);
  for (const o of [p('TEKLIF_GONDERILDI', 'HAZIRLANIYOR'), p('FIYAT_BEKLIYOR', 'IPTAL'), p('FATURALANDI', 'ARSIVLENDI'), { orderTypeCode: 'GLASS_ORDER', status: 'YENI', profile: null }]) {
    assert.equal(isNewProfileOrder(o), false, JSON.stringify(o));
  }
  const rows = [p('FIYAT_BEKLIYOR'), p('FIYAT_BEKLIYOR', 'IPTAL'), p('TEKLIF_GONDERILDI', 'HAZIRLANIYOR'), p('DEPODA', 'HAZIRLANIYOR')];
  assert.deepEqual(profileQueues(rows).map((q) => [q.key, q.rows.length]), [['profilePricing', 1], ['profileUnapproved', 1], ['profilePayment', 0], ['profilePickup', 1], ['profileInvoice', 0]]);
  assert.deepEqual(newProfileWhere(), { orderTypeCode: 'PROFILE_ORDER', status: { notIn: ['IPTAL', 'ARSIVLENDI'] }, profile: { is: { stage: 'FIYAT_BEKLIYOR' } } });
  const seen = [];
  const db = { order: { count: async ({ where }) => { seen.push(where); return 3; } } };
  assert.equal(await newProfileCount(db, { appRole: 'ADMIN', customerId: null }), 3);
  assert.deepEqual(seen[0], { removedAt: null, ...newProfileWhere() }, 'silinmiş sipariş sayılmaz (orderScope)');
});

test('menü (karar 216): yöneticinin "Profil Siparişleri" bölümü sayaçlı; profil tabloları ve profil tanımları bu bölümde; başka rol menüsünde yok', () => {
  const roles = src('lib/roles.ts');
  const admin = roles.slice(roles.indexOf('ADMIN: ['), roles.indexOf('SATIS: ['));
  const rest = roles.slice(roles.indexOf('SATIS: ['));
  const section = admin.slice(admin.indexOf("{ section: 'nav.profileOrders'"), admin.indexOf("{ section: 'nav.drawingTeam'"));
  assert.match(section, /\{ section: 'nav\.profileOrders', count: 'profileNew' \}/);
  for (const href of ['/siparisler?view=profil', '/admin/profil-katalogu', '/admin/profil-katalogu/hesaplama', '/admin/profil-fiyatlari', '/admin/stok']) {
    assert.ok(section.includes(`'${href}'`), `bölümde: ${href}`);
    assert.equal(admin.split(`'${href}'`).length - 1, 1, `yönetici menüsünde bir kez: ${href}`);
  }
  assert.match(section, /mobileCount: 'profileNew'/, 'telefonda sayaç bağlantıda');
  assert.ok(!rest.includes('nav.profileOrders'), 'yalnızca yönetici');
  // Sayaç sunucuda, yalnızca menüsünde sayaç olan rolde sayılır; yan menüde bölüm adının yanında, telefonda bağlantıda
  const layout = src('app/(panel)/layout.tsx');
  assert.match(layout, /profileNew: wants\('profileNew'\) \? await newProfileCount\(db, user\) : 0/);
  const nav = src('app/(panel)/NavLinks.tsx');
  assert.match(nav, /className="nav-section"[\s\S]*data-nav-count=\{it\.count\}/);
  assert.match(nav, /variant === 'mobile' \? it\.mobileCount \?\? 0 : 0/);
  for (const d of Object.values(DICTS)) assert.ok(d.nav.profileOrders && d.nav.profileNew.includes('{n}'));
});

test('"Sıra bende" (karar 217): yöneticide dört tablo bu sırayla; satışınki değişmedi; öteki tablolar başka ekranlarda', () => {
  assert.deepEqual(ADMIN_QUEUES, ['newOrders', 'offersToPrepare', 'sla', 'profilePricing']);
  assert.deepEqual(SALES_QUEUES, ['newOrders', 'sla']);
  const page = src('app/(panel)/siparisler/page.tsx');
  // Profil tabloları ayrı sorgudan (sayaçla aynı kapsam) ve "Profil siparişleri" sekmesinde
  assert.match(page, /queuesFor\(rows, \{ review: userCan\(user, 'ORDER_REVIEW'\), send: userCan\(user, 'OFFER_SEND'\)[^\n]*canProfile \? profileRows : undefined\)/);
  assert.match(page, /const canProfile = userCan\(user, 'OFFER_SEND'\) && !teamPanel;/);
  assert.match(page, /\{profileView && profileQueues\(profileRows\)\.map/);
});

test('yetki sunucuda (karar 215): firma PDF / Excel 403, Özet yükleme gününe döner; satışa belge bağlantısı hiç gitmez', () => {
  const route = src('app/(panel)/yuklemeler/firma/route.ts');
  assert.match(route, /if \(!canFirmDocs\(user\)\) return new Response\(t\('common\.fileNotFound'\), \{ status: 403 \}\);/);
  const ozet = src('app/(panel)/yuklemeler/ozet/page.tsx');
  assert.match(ozet, /if \(!canFirmDocs\(user\)\) redirect\(back\);/);
  assert.ok(ozet.indexOf('if (!canFirmDocs(user)) redirect(back);') < ozet.indexOf('await loadDay('), 'veri okunmadan önce');
  const page = src('app/(panel)/yuklemeler/page.tsx');
  assert.match(page, /to=\{docs \? firmUrls\(day, f\.id\) : null\}/);
  const rows = src('app/(panel)/yuklemeler/FirmRows.tsx');
  // Sıra: PDF | Excel | Özet | Sandık — belge işlemleri yalnızca adres verilince
  const i = ['data-action="pdf"', 'data-action="xlsx"', 'data-action="summary"', 'data-action="crates"'].map((s) => rows.indexOf(s));
  assert.ok(i.every((x, k) => x > 0 && (k === 0 || x > i[k - 1])), 'PDF | Excel | Özet | Sandık');
  assert.ok(rows.indexOf('{props.to && (') < i[0]);
});

test('satışın fabrika fiyatı değişikliği (karar 218): parmak izi satır sırasından bağımsız; aynı fark yeniden gönderilince "değişmedi"', async () => {
  const diff = (o = {}) => ({ line: 1, kind: 'CAM', description: 'Temper', listPrice: 37, unitPrice: 40, free: false, ...o });
  assert.equal(overrideKey([diff(), diff({ line: 2, description: 'Lamine', unitPrice: 55 })]), overrideKey([diff({ line: 5, description: 'Lamine', unitPrice: 55 }), diff({ line: 9 })]), 'sıra / satır no fark etmez');
  assert.notEqual(overrideKey([diff()]), overrideKey([diff({ unitPrice: 41 })]));
  assert.notEqual(overrideKey([diff()]), overrideKey([diff(), diff()]), 'aynı farktan iki satır başka');
  assert.equal(overrideKey(null), '');
  // Kayıt: son uyarı (açık ya da kapalı) okunur, sonra yenisi yazılır
  const alerts = [];
  const tx = {
    adminAlert: {
      findFirst: async () => alerts.at(-1) ?? null,
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }) => { const a = { id: `a${alerts.length + 1}`, ...data }; alerts.push(a); return a; },
    },
    auditLog: { create: async () => ({}) },
  };
  const lines = (price) => [{ kind: 'CAM', description: 'Temper', listPrice: '37', unitPrice: String(price), free: false }];
  const rec = (price) => recordPriceOverrides(tx, { orderId: 'o1', offerId: 'f1', orderNo: 'GLA1', currency: 'EUR', lines: lines(price), actor: { id: 'u1' } });
  assert.deepEqual(await rec(40), { count: 1, changed: true, alertId: 'a1' }, 'ilk değişiklik');
  assert.deepEqual(await rec(40), { count: 1, changed: false, alertId: 'a2' }, 'aynı fiyat yeniden gönderildi: bildirim yok');
  assert.deepEqual(await rec(42), { count: 1, changed: true, alertId: 'a3' }, 'fiyat gerçekten değişti');
  assert.deepEqual(await rec(37), { count: 0, changed: false, alertId: null }, 'liste fiyatına dönüş: fark yok');
  // Olay yalnızca gönderimde ve yalnızca gerçek değişiklikte; tutar taşımaz
  const tr = src('server/orders/transitions.js');
  assert.match(tr, /if \(ov\.changed\) h\.outbox\.push\(outboxEvent\('ORDER_PRICE_OVERRIDE', \{ orderId: order\.id, payload: \{ actorId: actor\.id \?\? null, alertId: ov\.alertId, qty: ov\.count \} \}\)\);/);
  // Telafi: fiyat değiştiyse (farklı fiyat / bedelsiz) — aynı fiyatta olay yok
  const comp = src('server/orders/compensation.js');
  assert.match(comp, /if \(decision\.changed\) \{\s*await enqueueOutbox\(tx, \{\s*type: 'ORDER_COMPENSATION_PRICE'/);
});

test('şifre sıfırlama (karar 218): yönetici başlatır, kod kullanıcıya kendiliğinden gider — yöneticiye e-posta olayı yazılmaz', () => {
  const actions = src('app/(panel)/admin/users/actions.ts');
  const reset = actions.slice(actions.indexOf('export async function resetPasswordAction'), actions.indexOf('export async function toggleActiveAction'));
  assert.match(reset, /issueInvite\(user\.id, \{ send: true \}\)/);
  assert.ok(!/notificationOutbox|enqueueOutbox|notifyStaff/.test(reset), 'yöneticiye bildirim / e-posta yok');
  // Kendi kendine sıfırlama isteği yok: /setup yalnızca kodu doğrular ve şifreyi yazar
  const setup = src('app/setup/actions.ts');
  assert.ok(!/notificationOutbox|enqueueOutbox|notifyStaff|issueInvite/.test(setup));
});

test('düzen (karar 215): firma tablosu, sandık formu ve Özet tabloları dar alanda etiketli ızgara — sayfa yatay kaymaz', () => {
  const css = src('app/globals.css');
  for (const s of [
    '.firm-wrap { container: firmwrap / inline-size; }', '@container firmwrap (max-width: 1069px)', '@container firmwrap (max-width: 899px)',
    '.crate-editor { container: crateeditor / inline-size; }', '@container crateeditor (max-width: 879px)',
    '.stack-wrap { container: stackwrap / inline-size; overflow-x: auto; }', '@container stackwrap (max-width: 919px)', '@container stackwrap (max-width: 699px)',
  ]) assert.ok(css.includes(s), s);
  // Sandık formunun onay kutuları genişlemez (yalnızca metin / sayı alanları hücreyi doldurur)
  assert.ok(css.includes('.crate-editor .crate-table td input:not([type=checkbox]) { width: 100%; min-width: 0; }'));
  const page = src('app/(panel)/yuklemeler/page.tsx');
  assert.match(page, /title=\{t\(`loading\.firm\.cols\.\$\{c\}` as MsgKey\)\}>\{short\(c\)\}<\/th>/, 'kısa başlık, tam adı ipucunda');
  for (const d of Object.values(DICTS)) {
    for (const k of ['orders', 'glass', 'cnc', 'holes', 'm2', 'net', 'crates', 'gross', 'factory', 'offer', 'actions']) assert.ok(d.loading.firm.short[k], k);
  }
});
