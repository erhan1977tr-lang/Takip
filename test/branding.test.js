// GKH kurumsal kimliği (karar 129): TAKİP'in ürettiği şirket PDF'leri ve BÜTÜN HTML e-postalar resmî GKH Trading Invest
// logosunu ortak altyapıdan (server/branding → server/pdf/brand.js, server/mail/layout.js) alır.
// Bu dosyada e-posta GÖNDERİLMEZ: taşıyıcı sahtedir (iletiyi yalnızca kaydeder) ve global fetch kapalıdır.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BRAND, brandLogoBytes, brandLogoSize } from '../server/branding/index.js';
import { LOGO } from '../server/branding/logo.js';
import { LOGO_NAME, imageSize, logoFile, logoModule } from '../scripts/brand-logo.mjs';
import { brandImage, drawBrandLogo } from '../server/pdf/brand.js';
import { PdfDoc, decodePng } from '../server/pdf/pdf.js';
import { offerPdf } from '../server/pdf/offer.js';
import { depotFormPdf } from '../server/pdf/depot-form.js';
import { transportListPdf } from '../server/pdf/transport-list.js';
import { offerExportData } from '../server/orders/offer-export.js';
import { MAIL_LOGO_CID, MAIL_LOGO_WIDTH, brandMessage, brandedHtml, isBranded, mailSender, sendBrandedMail } from '../server/mail/send.js';
import { readMailConfig } from '../server/mail/config.js';
import { renderInviteEmail } from '../server/mail/templates/invite.js';
import { renderWarehouseEmail } from '../server/mail/templates/warehouse.js';
import { sendInviteEmail } from '../server/mail/sendInvite.js';
import { renderNotification } from '../server/notifications/email.js';
import { renderDocEmail } from '../server/documents/delivery.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ASSET = path.join(ROOT, 'assets', 'brand', LOGO.file);
const realFetch = globalThis.fetch;
let leaked = 0;
before(() => {
  globalThis.fetch = async () => {
    leaked += 1;
    throw new Error('test: gerçek ağ isteği yapılmamalı');
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(leaked, 0, 'hiçbir test ağa çıkmadı');
});

/** Sahte taşıyıcı: gönderilen iletiyi yalnızca kaydeder (gerçek e-posta yok) */
function box() {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); return { messageId: `test-${sent.length}` }; } };
}
/** PDF'in sayfa içerikleri (açılmış çizim komutları) */
function pageOps(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    try {
      out.push(zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'));
    } catch {
      // sayfa içeriği olmayan akış
    }
  }
  return out;
}
/** Sayfadaki logo çizimleri: [genişlik, yükseklik, x, y] (pt) */
const logoDraws = (ops) => [...ops.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im1 Do Q/g)].map((m) => m.slice(1).map(Number));
const count = (buf, needle) => {
  let n = 0;
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) n += 1;
  return n;
};
/**
 * Belgeye gömülü resmî logo sayısı. JPEG olduğu gibi gömülür (baytları belgede aranır); PNG çözülerek gömülür: logonun
 * ölçüsünde RGB görsel — saydam PNG'de saydamlık maskesiyle (/SMask), yani saydamlık belgede korunur.
 */
function embedded(pdf) {
  if (!IS_PNG) return count(pdf, brandLogoBytes());
  const text = pdf.toString('latin1');
  const re = new RegExp(`/Subtype /Image /Width ${LOGO.width} /Height ${LOGO.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${decodePng(brandLogoBytes()).alpha ? ' /SMask \\d+ 0 R' : ''} /Length`, 'g');
  return (text.match(re) ?? []).length;
}
const RATIO = LOGO.width / LOGO.height;
const IS_PNG = LOGO.mime === 'image/png';

const OFFER_TEXT = {
  title: 'OFERTĂ', orderNo: 'GLA68', firm: 'Glass and More', date: '01.10.2026', currency: 'EUR', notes: ['Prețuri fără TVA.'],
  cols: { n: '#', desc: 'Descriere', poz: 'Poz', en: 'Lățime', boy: 'Înălțime', adet: 'Buc', m2: 'm²', unitPrice: 'Preț', amount: 'Valoare' },
  free: 'gratuit', total: 'Total', piece: 'buc',
};
const offerData = (n = 1) => offerExportData({
  lines: Array.from({ length: n }, (_, i) => ({ kind: 'CAM', description: `Temper ${i}`, descriptionRo: `Securizat ${i}`, poz: `K${i}`, enMm: 1000, boyMm: 2000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50' })),
  price: (l) => l.offerPrice, locale: 'ro', kindLabel: (k) => k,
});
const TRANSPORT_TEXT = {
  title: 'NAKLİYE LİSTESİ', day: 'Yükleme günü', colNo: 'Sandık no', colDims: 'U × G × Y (mm)', colKg: 'Ağırlık (kg)', colNote: 'Not',
  subtotal: '{n} sandık · ara toplam', crateCount: 'Sandık adedi', totalKg: 'TOPLAM AĞIRLIK', missing: 'Sandık ölçüsü girilmemiş siparişler',
  noPrice: 'Bu belge fiyat bilgisi içermez.', empty: 'Sandık yok.', guest: 'MİSAFİR YÜK', waiting: 'bekliyor',
};
const transportList = (n) => ({
  groups: [{ code: 'SB', totalKg: 100 * n, crates: Array.from({ length: n }, (_, i) => ({ crateNo: i + 1, dims: '2716 × 507 × 1520', weight: 100, note: '', guests: [] })) }],
  crateCount: n, totalKg: 100 * n, missing: [], waiting: [],
});
const depotInput = () => ({
  orderNo: 'GLAP12', firmName: 'Șantier Țară', phone: '+40 7', plate: 'B 1 ABC', pickupDate: new Date('2026-10-05T00:00:00Z'), date: new Date('2026-10-02T00:00:00Z'),
  categories: [{ code: 'GARNITURI', name: 'Garnituri', unit: 'CUTII' }],
  products: [{ id: '1', code: 'GK15', categoryCode: 'GARNITURI', name: 'GARNITURA EPDM - GK15', image: null }], qty: new Map([['GK15', 4]]), note: null,
});

test('resmî logo: kalıcı kaynak dosya (assets/brand) ile gömülü modül birebir aynı; geçici yol / dış adres yok', () => {
  const file = fs.readFileSync(ASSET);
  assert.equal(crypto.createHash('sha256').update(file).digest('hex'), LOGO.sha256);
  assert.equal(Buffer.compare(file, brandLogoBytes()), 0, 'PDF ve e-postaya giren baytlar = kaynak dosya');
  assert.deepEqual(imageSize(file), { mime: LOGO.mime, width: LOGO.width, height: LOGO.height });
  assert.deepEqual(BRAND, { company: 'GKH Trading Invest SRL', logo: { file: LOGO.file, mime: LOGO.mime, width: LOGO.width, height: LOGO.height, sha256: LOGO.sha256 } });
  // Tek kalıcı kaynak: assets/brand içinde resmî logo adıyla TAM BİR dosya (PNG ya da JPEG); uzantı = içerik
  assert.equal(logoFile(), LOGO.file);
  assert.deepEqual(fs.readdirSync(path.dirname(ASSET)).filter((f) => LOGO_NAME.test(f)), [LOGO.file], 'iki logo sürümü yan yana durmaz');
  assert.equal(LOGO.mime, /\.png$/.test(LOGO.file) ? 'image/png' : 'image/jpeg');
  assert.ok(LOGO.width >= 100 && LOGO.height >= 100, 'logo okunabilir çözünürlükte');
  // Gömülü modül, betiğin kaynak dosyadan üreteceği çıktıyla aynı (dosya değişip betik çalıştırılmadıysa test düşer)
  assert.equal(fs.readFileSync(path.join(ROOT, 'server', 'branding', 'logo.js'), 'utf8'), logoModule(file, LOGO.file));
  // Marka altyapısı hiçbir geçici / yerel / dış adrese başvurmaz
  for (const f of ['server/branding/index.js', 'server/pdf/brand.js', 'server/mail/layout.js', 'server/mail/send.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/https?:\/\/|\/root\/|\/tmp\/|uploads|\/home\//.test(text), f);
  }
  // Oran: verilen yükseklik / genişlikten öbür kenar logonun kendi oranıyla hesaplanır
  assert.ok(Math.abs(brandLogoSize({ height: LOGO.height }).width - LOGO.width) < 1e-9);
  assert.ok(Math.abs(brandLogoSize({ width: LOGO.width / 2 }).height - LOGO.height / 2) < 1e-9);
  assert.deepEqual(brandLogoSize({}), { width: LOGO.width, height: LOGO.height });
});

test('resmî logo saydam zeminli PNG: ürün sahibinin gönderdiği dosyadan (logo-seffaf.png) türetildi — ölçü, saydamlık ve bina birebir; yalnızca beyaz yazı koyu', () => {
  assert.deepEqual([LOGO.file, LOGO.mime], ['gkh-trading-invest-logo.png', 'image/png']);
  const source = decodePng(fs.readFileSync(path.join(ROOT, 'assets', 'brand', 'source', 'logo-seffaf.png')));
  const logo = decodePng(brandLogoBytes());
  assert.deepEqual([logo.w, logo.h], [source.w, source.h], 'kırpılmadı, yeniden boyutlandırılmadı');
  assert.deepEqual([logo.w, logo.h], [LOGO.width, LOGO.height]);
  assert.ok(logo.alpha && Buffer.compare(logo.alpha, source.alpha) === 0, 'saydamlık (her pikselde) gönderilen dosyayla aynı');
  let transparent = 0, building = 0, lettering = 0;
  for (let i = 0; i < logo.w * logo.h; i++) {
    if (!logo.alpha[i]) { transparent += 1; continue; }
    const [r, g, b] = [source.color[i * 3], source.color[i * 3 + 1], source.color[i * 3 + 2]];
    const mine = [logo.color[i * 3], logo.color[i * 3 + 1], logo.color[i * 3 + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) {
      // Gönderilen dosyada beyaz olan yazı: beyaz kâğıtta / e-postada okunabilsin diye koyu (ürün sahibinin seçimi, karar 131)
      assert.ok(r > 200, 'kaynakta renksiz pikseller yalnızca beyaz yazıdır');
      assert.deepEqual(mine, [17, 24, 39]);
      lettering += 1;
    } else {
      if (mine[0] !== r || mine[1] !== g || mine[2] !== b) assert.fail(`bina pikseli değişmiş (${i})`);
      building += 1;
    }
  }
  assert.ok(transparent > logo.w * logo.h * 0.5 && building > 50_000 && lettering > 10_000, 'zemin saydam; bina ve yazı yerinde');
  // Giriş ekranındaki / kenar çubuğundaki "GKH Digital" logosu ayrı bir işarettir: dosyaları yerinde ve marka altyapısına girmez
  for (const f of ['gkh-digital-logo.png', 'gkh-mark.png']) assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'brand', f)) && !LOGO_NAME.test(f), f);
  assert.ok(!fs.existsSync(path.join(ROOT, 'assets', 'brand', 'gkh-trading-invest-logo.jpg')), 'eski JPEG logo kaldırıldı');
});

test('PDF yazıcı: saydam PNG saydamlığıyla gömülür (/SMask) — beyaz kutuya basılmaz; saydam olmayan PNG ve JPEG eskisi gibi', () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const png = (w, h, rgba) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4))])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  // 2 × 1: kırmızı (opak) + mavi (yarı saydam)
  const clear = decodePng(png(2, 1, [255, 0, 0, 255, 0, 0, 255, 128]));
  assert.deepEqual([...clear.color], [255, 0, 0, 0, 0, 255], 'renk zemine basılmadan');
  assert.deepEqual([...clear.alpha], [255, 128]);
  assert.deepEqual([...clear.rgb], [255, 0, 0, 127, 127, 255], 'rgb: beyaz zemine basılmış (eski alan, değişmedi)');
  const opaque = decodePng(png(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]));
  assert.deepEqual([Object.keys(opaque).sort(), [...opaque.rgb]], [['h', 'rgb', 'w'], [255, 0, 0, 0, 0, 255]], 'saydam pikseli olmayan PNG: maske yok');

  const objects = (pdf) => pdf.toString('latin1').split('endobj').filter((o) => o.includes('/Subtype /Image'));
  const streamOf = (pdf, obj) => {
    const len = Number(/\/Length (\d+) >>/.exec(obj)[1]);
    const at = pdf.indexOf(Buffer.from(obj.slice(obj.indexOf('<< /Type /XObject'), obj.indexOf('stream\n') + 7), 'latin1'));
    const start = at + obj.slice(obj.indexOf('<< /Type /XObject')).indexOf('stream\n') + 7;
    return zlib.inflateSync(pdf.subarray(start, start + len));
  };
  const withAlpha = new PdfDoc({ title: 't' });
  withAlpha.addPage().image(withAlpha.image(png(2, 1, [255, 0, 0, 255, 0, 0, 255, 128])), 10, 10, 20, 10);
  const pdf = withAlpha.toBuffer();
  const [mask, image] = objects(pdf);
  assert.match(mask, /\/Width 2 \/Height 1 \/ColorSpace \/DeviceGray \/BitsPerComponent 8 \/Filter \/FlateDecode/);
  const maskId = Number(/(\d+) 0 obj\n<< \/Type \/XObject \/Subtype \/Image [^>]*DeviceGray/.exec(pdf.toString('latin1'))[1]);
  assert.match(image, new RegExp(`/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask ${maskId} 0 R /Length`));
  assert.deepEqual([...streamOf(pdf, mask)], [255, 128], 'maske = PNG saydamlığı');
  assert.deepEqual([...streamOf(pdf, image)], [255, 0, 0, 0, 0, 255], 'renk = PNG rengi (beyaza basılmadı)');
  const noAlpha = new PdfDoc({ title: 't' });
  noAlpha.addPage().image(noAlpha.image(png(2, 1, [255, 0, 0, 255, 0, 0, 255, 255])), 10, 10, 20, 10);
  assert.ok(!noAlpha.toBuffer().toString('latin1').includes('/SMask'));
  // Aynı görsel ikinci belgede yeniden çözülmez (aynı hazır veri); belge içinde yine tek kez gömülür
  const a = new PdfDoc({ title: 'a' });
  const b = new PdfDoc({ title: 'b' });
  const [ia, ib] = [brandImage(a), brandImage(b)];
  assert.equal(ia.data, ib.data);
  assert.equal(ia.mask, ib.mask);
  assert.ok(ia.mask?.length > 0, 'resmî logo saydamlığıyla gömülür');
  assert.equal(brandImage(a), ia);
});

test('PDF ortak başlığı: logo belgeye gömülür (bir kez), oranı korunarak çizilir', () => {
  const doc = new PdfDoc({ title: 't', author: BRAND.company });
  const img = brandImage(doc);
  assert.deepEqual([img.w, img.h], [LOGO.width, LOGO.height]);
  assert.equal(brandImage(doc), img, 'aynı belgeye ikinci kez eklenmez');
  const calls = [];
  const page = { image: (...a) => calls.push(a) };
  assert.ok(Math.abs(drawBrandLogo(page, img, { x: 40, y: 20, height: 100 }) - 100 * RATIO) < 1e-9);
  drawBrandLogo(page, img, { x: 555, y: 22, height: 48, align: 'right' });
  const [[, x1, y1, w1, h1], [, x2, y2, w2, h2]] = calls;
  assert.deepEqual([x1, y1, h1, y2, h2], [40, 20, 100, 22, 48]);
  for (const [w, h] of [[w1, h1], [w2, h2]]) assert.ok(Math.abs(w / h - RATIO) < 1e-9, 'en-boy oranı');
  assert.ok(Math.abs(x2 + w2 - 555) < 1e-9, 'sağa yaslı: sağ kenar verilen x');
});

test('TAKİP\'in ürettiği üç PDF de resmî logoyu taşır: teklif, Comanda Depozit, nakliye listesi', () => {
  const docs = {
    'teklif (müşteriye)': offerPdf(offerData(), OFFER_TEXT),
    'Comanda Depozit (depoya)': depotFormPdf(depotInput()),
    'nakliye listesi': transportListPdf({ day: '2026-10-02', text: TRANSPORT_TEXT, list: transportList(3) }),
  };
  for (const [name, pdf] of Object.entries(docs)) {
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', name);
    // Logo belgenin İÇİNDE (gömülü): dış adrese / dosya yoluna bağlı değil
    assert.equal(embedded(pdf), 1, `${name}: logo gömülü (bir kez)`);
    assert.ok(!/\/URI|https?:\/\//.test(pdf.toString('latin1')), `${name}: belgede dış adres yok`);
    // İlk sayfanın başlığında, sayfanın üst bölümünde ve oranı bozulmadan çizilir
    const first = logoDraws(pageOps(pdf).find((ops) => ops.includes('/Im1 Do')));
    assert.equal(first.length, 1, `${name}: ilk sayfada bir logo`);
    const [w, h, x, y] = first[0];
    assert.ok(Math.abs(w / h - RATIO) < 0.002, `${name}: en-boy oranı korunur (${w} × ${h})`);
    assert.ok(h >= 40 && h <= 110 && x >= 30 && x + w <= 565 && y + h <= 842 - 20 && y >= 842 - 140, `${name}: üst başlıkta, kenar boşluklarının içinde (${[w, h, x, y]})`);
  }
  // Nakliye listesinde logonun yanındaki firma adı resmî addır: "GKH Trading Invest SRL" (ad verilmezse de; sayfa bunu kullanır)
  const author = (pdf) => /\/Author <FEFF([0-9A-F]+)>/.exec(pdf.toString('latin1'))[1];
  const utf16 = (t) => Buffer.from(t, 'utf16le').swap16().toString('hex').toUpperCase();
  const named = transportListPdf({ day: '2026-10-02', company: 'GKH Trading Invest SRL', text: TRANSPORT_TEXT, list: transportList(3) });
  assert.equal(BRAND.company, 'GKH Trading Invest SRL');
  assert.equal(Buffer.compare(docs['nakliye listesi'], named), 0, 'varsayılan firma adı = resmî ad');
  assert.equal(author(named), utf16('GKH Trading Invest SRL'));
  const old = transportListPdf({ day: '2026-10-02', company: 'GKH Trading', text: TRANSPORT_TEXT, list: transportList(3) });
  assert.notDeepEqual(pageOps(old), pageOps(named), 'firma adı sayfaya yazılır');
  const route = fs.readFileSync(path.join(ROOT, 'app', '(panel)', 'yuklemeler', 'nakliye', 'route.ts'), 'utf8');
  assert.ok(!/company\s*:/.test(route) && !route.includes("'GKH Trading'"), 'sayfa firma adını elle yazmaz (resmî ad ortak markadan gelir)');
  // Çok sayfalı belgede logo yine tek kez gömülür (boyut büyümez); nakliye listesinde her sayfanın başlığında çizilir
  const long = transportListPdf({ day: '2026-10-02', text: TRANSPORT_TEXT, list: transportList(70) });
  const pages = pageOps(long).filter((ops) => ops.includes('/Im1 Do'));
  assert.ok(pages.length >= 2);
  assert.ok(pages.every((ops) => logoDraws(ops).length === 1));
  assert.equal(embedded(long), 1);
  const longOffer = offerPdf(offerData(80), OFFER_TEXT);
  assert.equal(embedded(longOffer), 1);
  assert.equal(pageOps(longOffer).filter((ops) => ops.includes('/Im1 Do')).length, 1, 'teklifte logo ilk sayfanın başlığında');
});

test('her PDF üretici ortak başlığı kullanır (yeni üretici de kullanmak zorunda); logo başka yerde kopyalanmaz', () => {
  const dir = path.join(ROOT, 'server', 'pdf');
  const generators = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).filter((f) => /new PdfDoc\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  // Paket 7: firma yükleme listesi (firm-loading.js) de ortak başlığı ve ortak altbilgiyi kullanır
  assert.deepEqual(generators.sort(), ['depot-form.js', 'firm-loading.js', 'offer-summary.js', 'offer.js', 'transport-list.js']);
  for (const f of generators) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /from '\.\/brand\.js'/, f);
    assert.match(text, /brandImage\(doc\)/, f);
    assert.match(text, /drawBrandLogo\(page, logo, /, f);
    assert.match(text, /finishPages\(doc\b/, `${f}: ortak altbilgi (firma adı + sayfa / toplam)`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'logo.js')), 'eski gömülü logo dosyası kaldırıldı');
});

const NOTIFY = (type, recipient, extra = {}) => renderNotification({
  type, order: { id: 'o1', orderNo: 'GLA68', customer: { name: 'Glass and More' }, estimatedShipDate: new Date('2026-10-20T09:00:00Z') },
  createdAt: new Date('2026-10-04T10:00:00Z'), recipient, appUrl: 'https://takip.example', timeZone: 'Europe/Bucharest', ...extra,
});
/** TAKİP'in bütün e-posta şablonları (dört yol) — her biri birkaç örnekle */
const MAILS = () => ({
  'bildirim: yeni sipariş (satış)': NOTIFY('ORDER_CREATED', { locale: 'tr', role: 'SATIS' }),
  'bildirim: çizim gönderildi (müşteri)': NOTIFY('ORDER_DRAWING_SENT', { locale: 'ro', role: null }),
  'bildirim: revizyon istendi (çizim)': NOTIFY('ORDER_REVISION_REQUESTED', { locale: 'tr', role: 'CIZIM' }, { revision: { note: 'Kenar 5 mm', version: 2 } }),
  'bildirim: yükleme tarihi (müşteri)': NOTIFY('ORDER_SHIP_DATE', { locale: 'ro', role: null }),
  'bildirim: teklif gönderildi (müşteri)': NOTIFY('ORDER_OFFER_SENT', { locale: 'ro', role: null }),
  'mali belge: proforma': renderDocEmail({ kind: 'PROFORMA', series: 'PRF', number: '101', orderNos: ['GLA68'], total: 605, currency: 'RON', firmName: 'Glass and More', attached: true, portalUrl: 'https://takip.example/belgeler' }),
  'mali belge: fatura': renderDocEmail({ kind: 'INVOICE', series: 'GKH', number: '812', orderNos: ['GLA68', 'GLA69'], total: 1210, currency: 'RON', firmName: 'Glass and More', attached: false, link: 'https://www.fgo.ro/facturi/GKH812.pdf' }),
  'depo (Comanda Depozit)': renderWarehouseEmail({ orderNo: 'GLAP12', firmName: 'Glass and More', pickupDate: new Date('2026-10-06T00:00:00Z'), phone: '+40 7', plate: 'B 1', items: [{ code: 'GK15', name: 'GARNITURA', unit: 'cutii', qty: 4 }], link: 'https://takip.example/depo/x', validDays: 14 }),
  'davet / doğrulama kodu (tr)': renderInviteEmail({ code: '482913', name: 'Ali', firmName: 'Ünsal Cam', language: 'tr', appUrl: 'https://takip.example', email: 'a@b.ro' }),
  'davet / doğrulama kodu (ro)': renderInviteEmail({ code: '482913', language: 'ro' }),
});

test('bütün HTML e-postalar ortak GKH başlığını kullanır: logo en üstte, gömülü (cid), oranı korunur; düz metin sürümü aynen', () => {
  for (const [name, m] of Object.entries(MAILS())) {
    assert.ok(m.subject && m.text && m.html, name);
    assert.ok(isBranded(m.html), `${name}: ortak düzen`);
    // Tek logo, tek görsel; kaynağı gömülü ek (cid) — dış adres / dosya yolu değil
    const imgs = [...m.html.matchAll(/<img\b[^>]*>/g)].map((x) => x[0]);
    assert.equal(imgs.length, 1, name);
    assert.match(imgs[0], new RegExp(`src="cid:${MAIL_LOGO_CID.replace('.', '\\.')}"`), name);
    assert.match(imgs[0], /alt="GKH Trading Invest SRL"/, name);
    // Oran: yalnızca genişlik verilir, yükseklik otomatik (hiçbir programda gerilmez); küçük ekranda taşmaz
    assert.match(imgs[0], new RegExp(`width="${MAIL_LOGO_WIDTH}"`), name);
    assert.ok(!/\sheight="/.test(imgs[0]) && /height:auto/.test(imgs[0]) && /max-width:100%/.test(imgs[0]), name);
    // Logo gövdeden ÖNCE (başlıkta)
    const firstText = m.text.split('\n').find((l) => l.trim().length > 3).trim().slice(0, 12);
    assert.ok(m.html.indexOf('<img') < m.html.indexOf('</td></tr>\n<tr><td style="padding:20px 24px 24px'), name);
    assert.ok(m.html.indexOf('<img') < m.html.lastIndexOf('</table>'), name);
    assert.ok(firstText.length > 0);
    // E-posta programlarıyla uyum: tek belge, tablo düzeni, en fazla 600 px, mobil görünüm
    assert.equal((m.html.match(/<html\b/g) ?? []).length, 1, name);
    assert.equal((m.html.match(/<body\b/g) ?? []).length, 1, name);
    assert.match(m.html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, name);
    assert.match(m.html, /max-width:600px/, name);
    assert.ok(!/<script|<style|<link\b|javascript:/i.test(m.html), `${name}: betik / dış stil yok`);
    // Düz metin sürümü: HTML / logo izi yok, içerik yerinde
    assert.ok(!/<[a-z]|cid:|gkh-trading-invest-logo/i.test(m.text), `${name}: düz metin`);
  }
  // Düz metin içeriği markadan etkilenmedi (örnekler)
  const mails = MAILS();
  assert.match(mails['bildirim: revizyon istendi (çizim)'].text, /Sipariş no: GLA68[\s\S]*Kenar 5 mm[\s\S]*https:\/\/takip\.example\/siparisler\/o1/);
  assert.match(mails['mali belge: proforma'].text, /Număr document: PRF101/);
  assert.match(mails['davet / doğrulama kodu (tr)'].text, /Doğrulama kodunuz: 482913/);
  assert.match(mails['depo (Comanda Depozit)'].text, /Comanda Depozit/);
  // Satış / çizim bildiriminde firma adı maskeli kalır (gizlilik kuralı markadan etkilenmez)
  assert.ok(!mails['bildirim: revizyon istendi (çizim)'].html.includes('Glass and More'));
});

test('tek gönderim noktası: logo eki her HTML e-postaya eklenir, öbür ekler ve alıcı / konu / metin değişmez; gerçek e-posta gönderilmez', async () => {
  const pdf = Buffer.from('%PDF-1.4 sahte');
  const t = box();
  const mail = MAILS()['mali belge: proforma'];
  await sendBrandedMail(t, { from: 'TAKİP <info@gkh.test>', to: 'musteri@firma.test', subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro', attachments: [{ filename: 'PRF101.pdf', content: pdf, contentType: 'application/pdf' }] });
  const [m] = t.sent;
  assert.deepEqual([m.to, m.subject, m.text, m.html], ['musteri@firma.test', mail.subject, mail.text, mail.html], 'alıcı, konu, metin ve HTML aynen');
  assert.equal(m.from, 'GKH Trading Invest SRL <info@gkh.test>', 'gönderen: resmî firma adı + ayarlanan adres (karar 133)');
  assert.ok(!('lang' in m), 'düzen bilgisi taşıyıcıya gitmez');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.cid ?? null]), [['PRF101.pdf', 'application/pdf', null], [LOGO.file, LOGO.mime, MAIL_LOGO_CID]], 'PDF önde, logo satır içi ek');
  assert.equal(Buffer.compare(m.attachments[0].content, pdf), 0);
  assert.equal(Buffer.compare(m.attachments[1].content, brandLogoBytes()), 0, 'gömülen logo = resmî logo');
  assert.equal(m.attachments[1].contentDisposition, 'inline');

  // Ortak düzeni kullanmayan (ileride yazılacak) bir şablon da logoyla gider: gönderimde sarılır
  await sendBrandedMail(t, { from: 'a@gkh.test', to: 'b@x.test', subject: 'Yeni bildirim', text: 'düz', html: '<!doctype html><html><body style="margin:0"><p>Yeni <b>şablon</b></p></body></html>', lang: 'tr' });
  const wrapped = t.sent[1];
  assert.ok(isBranded(wrapped.html) && wrapped.html.includes('<p>Yeni <b>şablon</b></p>') && wrapped.html.includes('lang="tr"'));
  assert.equal((wrapped.html.match(/<body\b/g) ?? []).length, 1);
  assert.equal(wrapped.html.indexOf('<img') < wrapped.html.indexOf('Yeni <b>'), true, 'logo içerikten önce');
  assert.deepEqual(wrapped.attachments.map((a) => a.cid), [MAIL_LOGO_CID]);
  assert.equal(wrapped.text, 'düz');
  // Yalnızca gövde parçası verilirse de aynı
  assert.ok(isBranded(brandMessage({ to: 'x', subject: 's', text: 't', html: '<p>parça</p>' }).html));
  // İki kez markalanmaz, logo iki kez eklenmez
  const twice = brandMessage(brandMessage({ to: 'x', subject: 's', text: 't', html: '<p>x</p>' }));
  assert.equal((twice.html.match(/<img\b/g) ?? []).length, 1);
  assert.equal(twice.attachments.length, 1);
  // Düz metin e-posta (HTML'siz) gövdesiyle olduğu gibi gider: ek / HTML eklenmez (gönderen adı yine resmî addır)
  assert.deepEqual(brandMessage({ from: 'a', to: 'b', subject: 's', text: 'yalnızca metin' }), { from: 'a', to: 'b', subject: 's', text: 'yalnızca metin' });
  assert.deepEqual(brandMessage({ from: 'a@gkh.test', to: 'b', subject: 's', text: 'yalnızca metin' }), { from: 'GKH Trading Invest SRL <a@gkh.test>', to: 'b', subject: 's', text: 'yalnızca metin' });
  // brandedHtml: başlık ve dil kaçışlanır
  assert.ok(brandedHtml({ lang: 'ro"><script>', title: '<b>x</b>', body: '<p>g</p>' }).includes('<title>&lt;b&gt;x&lt;/b&gt;</title>'));
  assert.ok(!brandedHtml({ lang: 'ro"><script>', body: '' }).includes('<script>'));

  // Davet / doğrulama kodu e-postası da aynı noktadan geçer
  const inv = box();
  const r = await sendInviteEmail(inv, { from: 'TAKİP <info@gkh.test>', appUrl: 'https://takip.example', inviteTtlHours: 24 }, { to: 'yeni@firma.test', code: '482913', name: 'Ali', firmName: 'Ünsal Cam', language: 'ro' });
  assert.equal(r.messageId, 'test-1');
  assert.deepEqual([inv.sent[0].to, isBranded(inv.sent[0].html), inv.sent[0].attachments.map((a) => a.cid)], ['yeni@firma.test', true, [MAIL_LOGO_CID]]);
  assert.match(inv.sent[0].text, /482913/);
});

test('gönderen kimliği tek yerden: her e-postada görünen ad "GKH Trading Invest SRL", adres ayarlanan gönderen adresi (info@gkh.ro) — karar 133', async () => {
  const SENDER = 'GKH Trading Invest SRL <info@gkh.ro>';
  // Ayar nasıl yazılmış olursa olsun (yalnızca adres, başka adla, tırnaklı adla, nesne olarak): ad resmî ad, adres AYNEN
  for (const from of ['info@gkh.ro', ' info@gkh.ro ', 'Takip <info@gkh.ro>', 'TAKİP <info@gkh.ro>', '"Takip, Portal" <info@gkh.ro>', 'GKH Trading Invest SRL <info@gkh.ro>', { name: 'Takip', address: 'info@gkh.ro' }, { address: 'info@gkh.ro' }]) {
    assert.equal(mailSender(from), SENDER, JSON.stringify(from));
  }
  assert.equal(mailSender('Takip <noreply@localhost>'), 'GKH Trading Invest SRL <noreply@localhost>');
  assert.equal(mailSender(SENDER), SENDER, 'iki kez uygulanınca değişmez');
  // Geçerli tek bir adres yoksa girdiye dokunulmaz: ad uydurulmaz, başlığa satır / ikinci alıcı sokulamaz
  for (const from of ['', 'x', 'a <b', null, undefined, 'A <a@b.ro>, B <c@d.ro>', 'a@b.ro\r\nBcc: x@y.z', 'a@b.ro, c@d.ro', {}]) assert.deepEqual(mailSender(from), from, JSON.stringify(from));
  assert.equal(BRAND.company, 'GKH Trading Invest SRL');

  // Ayardan (MAIL_FROM) gelen adres değişmez; SMTP kimliği / sunucu ayarı okunuşu aynı
  const cfg = readMailConfig({ SMTP_HOST: 'smtp.gkh.test', SMTP_USER: 'info@gkh.ro', SMTP_PASS: 'x', MAIL_FROM: 'info@gkh.ro', APP_URL: 'https://takip.example' });
  assert.deepEqual([cfg.from, cfg.user, cfg.host, cfg.port], ['info@gkh.ro', 'info@gkh.ro', 'smtp.gkh.test', 587]);

  // Ortak gönderim noktası: yanıt adresi, alıcılar (cc / bcc dahil), konu, metin, HTML ve ekler AYNEN; yalnızca gönderen adı
  const t = box();
  const pdf = Buffer.from('%PDF-1.4 sahte');
  const mail = MAILS()['mali belge: fatura'];
  await sendBrandedMail(t, { from: cfg.from, to: 'musteri@firma.test', cc: 'c@firma.test', bcc: 'arsiv@gkh.test', replyTo: 'satis@gkh.ro', subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro', attachments: [{ filename: 'GKH812.pdf', content: pdf, contentType: 'application/pdf' }] });
  const [m] = t.sent;
  assert.equal(m.from, SENDER);
  assert.deepEqual([m.to, m.cc, m.bcc, m.replyTo, m.subject, m.text, m.html], ['musteri@firma.test', 'c@firma.test', 'arsiv@gkh.test', 'satis@gkh.ro', mail.subject, mail.text, mail.html]);
  assert.deepEqual(m.attachments.map((a) => a.filename), ['GKH812.pdf', LOGO.file], 'PDF eki ve logo yerinde');
  assert.deepEqual(Object.keys(m).sort(), ['attachments', 'bcc', 'cc', 'from', 'html', 'replyTo', 'subject', 'text', 'to'], 'iletiye başka alan eklenmedi (yanıt adresi uydurulmadı)');
  // Yanıt adresi verilmemişse eklenmez (mevcut davranış: yanıtlar gönderen adrese gider)
  await sendBrandedMail(t, { from: cfg.from, to: 'x@firma.test', subject: 's', text: 'düz metin' });
  assert.deepEqual(t.sent[1], { from: SENDER, to: 'x@firma.test', subject: 's', text: 'düz metin' }, 'düz metin e-postada da aynı gönderen; gövde aynen');

  // Bütün e-posta yolları aynı kimlikle gider (şablonlar tek tek değiştirilmedi: kimlik gönderim noktasında verilir).
  // Sipariş bildirimi: test/notify.test.js · mali belge ve depo e-postası: veritabanı testleri · hepsi: tarayıcı testi.
  const inv = box();
  await sendInviteEmail(inv, cfg, { to: 'yeni@firma.test', code: '482913', name: 'Ali', firmName: 'Ünsal Cam', language: 'tr' });
  assert.equal(inv.sent[0].from, SENDER, 'davet / doğrulama kodu / SMTP deneme e-postası');
  // Kaynak: gönderen kimliği yalnızca ortak gönderim noktasında kurulur; hiçbir şablon / yol "Ad <adres>" yazmaz
  const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(src('server/mail/layout.js'), /const msg = rest\.from == null \? rest : \{ \.\.\.rest, from: mailSender\(rest\.from\) \};/);
  for (const f of ['server/notifications/email.js', 'server/documents/delivery.js', 'server/profile/warehouse.js', 'server/mail/sendInvite.js', 'server/mail/templates/invite.js', 'server/mail/templates/warehouse.js', 'server/suppliers/dispatch.js', 'server/mail/templates/supplier-order.js']) {
    assert.ok(!/GKH Trading Invest SRL\s*</.test(src(f)) && !/mailSender\(/.test(src(f)), `${f}: gönderen adı burada kurulmaz`);
  }
});

test('e-posta yalnızca ortak gönderim noktasından gider: başka hiçbir dosya taşıyıcıyı doğrudan çağırmaz', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) files.push(full);
    }
  };
  for (const d of ['app', 'lib', 'server', 'scripts', 'components']) walk(path.join(ROOT, d));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const callers = files.filter((f) => /\.sendMail\(/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(callers, ['server/mail/layout.js'], 'transport.sendMail yalnızca sendBrandedMail içinde çağrılır');
  // Beş e-posta yolu da ortak göndericiyi ve ortak düzeni kullanır (beşincisi: tedarikçi siparişi — Paket 6)
  for (const f of ['server/notifications/email.js', 'server/documents/delivery.js', 'server/profile/warehouse.js', 'server/mail/sendInvite.js', 'server/suppliers/dispatch.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /sendBrandedMail\(transport, /, f);
  }
  for (const f of ['server/notifications/email.js', 'server/documents/delivery.js', 'server/mail/templates/warehouse.js', 'server/mail/templates/invite.js', 'server/mail/templates/supplier-order.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /brandedHtml\(\{/, f);
  }
  // Şablonlar kendi <html> / <body> iskeletini yazmaz (iskelet tek yerde: server/mail/layout.js)
  const skeletons = files.filter((f) => /<!doctype html>|<html\b/i.test(fs.readFileSync(f, 'utf8'))).map(rel).filter((f) => f.startsWith('server/'));
  assert.deepEqual(skeletons, ['server/mail/layout.js']);
});
