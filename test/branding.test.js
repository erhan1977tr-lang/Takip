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
import { imageSize, logoModule } from '../scripts/brand-logo.mjs';
import { brandImage, drawBrandLogo } from '../server/pdf/brand.js';
import { PdfDoc } from '../server/pdf/pdf.js';
import { offerPdf } from '../server/pdf/offer.js';
import { depotFormPdf } from '../server/pdf/depot-form.js';
import { transportListPdf } from '../server/pdf/transport-list.js';
import { offerExportData } from '../server/orders/offer-export.js';
import { MAIL_LOGO_CID, MAIL_LOGO_WIDTH, brandMessage, brandedHtml, isBranded, sendBrandedMail } from '../server/mail/send.js';
import { renderInviteEmail } from '../server/mail/templates/invite.js';
import { renderWarehouseEmail } from '../server/mail/templates/warehouse.js';
import { sendInviteEmail } from '../server/mail/sendInvite.js';
import { renderNotification } from '../server/notifications/email.js';
import { renderDocEmail } from '../server/documents/delivery.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ASSET = path.join(ROOT, 'assets', 'brand', 'gkh-trading-invest-logo.jpg');
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
const RATIO = 220 / 254;

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
  assert.deepEqual(imageSize(file), { mime: 'image/jpeg', width: LOGO.width, height: LOGO.height });
  assert.deepEqual(BRAND, { company: 'GKH Trading Invest SRL', logo: { file: 'gkh-trading-invest-logo.jpg', mime: 'image/jpeg', width: 220, height: 254, sha256: LOGO.sha256 } });
  // Gömülü modül, betiğin kaynak dosyadan üreteceği çıktıyla aynı (dosya değişip betik çalıştırılmadıysa test düşer)
  assert.equal(fs.readFileSync(path.join(ROOT, 'server', 'branding', 'logo.js'), 'utf8'), logoModule(file));
  // Marka altyapısı hiçbir geçici / yerel / dış adrese başvurmaz
  for (const f of ['server/branding/index.js', 'server/pdf/brand.js', 'server/mail/layout.js', 'server/mail/send.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/https?:\/\/|\/root\/|\/tmp\/|uploads|\/home\//.test(text), f);
  }
  // Oran: verilen yükseklik / genişlikten öbür kenar logonun kendi oranıyla hesaplanır
  assert.ok(Math.abs(brandLogoSize({ height: 254 }).width - 220) < 1e-9);
  assert.ok(Math.abs(brandLogoSize({ width: 110 }).height - 127) < 1e-9);
  assert.deepEqual(brandLogoSize({}), { width: 220, height: 254 });
});

test('PDF ortak başlığı: logo belgeye gömülür (bir kez), oranı korunarak çizilir', () => {
  const doc = new PdfDoc({ title: 't', author: BRAND.company });
  const img = brandImage(doc);
  assert.deepEqual([img.w, img.h], [220, 254]);
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
  const logo = brandLogoBytes();
  const docs = {
    'teklif (müşteriye)': offerPdf(offerData(), OFFER_TEXT),
    'Comanda Depozit (depoya)': depotFormPdf(depotInput()),
    'nakliye listesi': transportListPdf({ day: '2026-10-02', company: 'GKH Trading', text: TRANSPORT_TEXT, list: transportList(3) }),
  };
  for (const [name, pdf] of Object.entries(docs)) {
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', name);
    // Logo belgenin İÇİNDE (JPEG olarak gömülü): dış adrese / dosya yoluna bağlı değil
    assert.equal(count(pdf, logo), 1, `${name}: logo gömülü (bir kez)`);
    assert.match(pdf.toString('latin1'), /\/Subtype \/Image \/Width 220 \/Height 254 [^>]*\/Filter \/DCTDecode/, name);
    assert.ok(!/\/URI|https?:\/\//.test(pdf.toString('latin1')), `${name}: belgede dış adres yok`);
    // İlk sayfanın başlığında, sayfanın üst bölümünde ve oranı bozulmadan çizilir
    const first = logoDraws(pageOps(pdf).find((ops) => ops.includes('/Im1 Do')));
    assert.equal(first.length, 1, `${name}: ilk sayfada bir logo`);
    const [w, h, x, y] = first[0];
    assert.ok(Math.abs(w / h - RATIO) < 0.002, `${name}: en-boy oranı korunur (${w} × ${h})`);
    assert.ok(h >= 40 && h <= 110 && x >= 30 && x + w <= 565 && y + h <= 842 - 20 && y >= 842 - 140, `${name}: üst başlıkta, kenar boşluklarının içinde (${[w, h, x, y]})`);
  }
  // Çok sayfalı belgede logo yine tek kez gömülür (boyut büyümez); nakliye listesinde her sayfanın başlığında çizilir
  const long = transportListPdf({ day: '2026-10-02', company: 'GKH Trading', text: TRANSPORT_TEXT, list: transportList(70) });
  const pages = pageOps(long).filter((ops) => ops.includes('/Im1 Do'));
  assert.ok(pages.length >= 2);
  assert.ok(pages.every((ops) => logoDraws(ops).length === 1));
  assert.equal(count(long, logo), 1);
  const longOffer = offerPdf(offerData(80), OFFER_TEXT);
  assert.equal(count(longOffer, logo), 1);
  assert.equal(pageOps(longOffer).filter((ops) => ops.includes('/Im1 Do')).length, 1, 'teklifte logo ilk sayfanın başlığında');
});

test('her PDF üretici ortak başlığı kullanır (yeni üretici de kullanmak zorunda); logo başka yerde kopyalanmaz', () => {
  const dir = path.join(ROOT, 'server', 'pdf');
  const generators = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).filter((f) => /new PdfDoc\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(generators.sort(), ['depot-form.js', 'offer.js', 'transport-list.js']);
  for (const f of generators) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /from '\.\/brand\.js'/, f);
    assert.match(text, /brandImage\(doc\)/, f);
    assert.match(text, /drawBrandLogo\(page, logo, /, f);
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
  'mali belge: fatura': renderDocEmail({ kind: 'INVOICE', series: 'GKH', number: '812', orderNos: ['GLA68', 'GLA69'], total: 1210, currency: 'RON', firmName: 'Glass and More', attached: false, link: 'https://takip.example/belgeler/x/pdf' }),
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
  assert.deepEqual([m.from, m.to, m.subject, m.text, m.html], ['TAKİP <info@gkh.test>', 'musteri@firma.test', mail.subject, mail.text, mail.html], 'alıcı, konu, metin ve HTML aynen');
  assert.ok(!('lang' in m), 'düzen bilgisi taşıyıcıya gitmez');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.cid ?? null]), [['PRF101.pdf', 'application/pdf', null], ['gkh-trading-invest-logo.jpg', 'image/jpeg', MAIL_LOGO_CID]], 'PDF önde, logo satır içi ek');
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
  // Düz metin e-posta (HTML'siz) olduğu gibi gider: ek / HTML eklenmez
  assert.deepEqual(brandMessage({ from: 'a', to: 'b', subject: 's', text: 'yalnızca metin' }), { from: 'a', to: 'b', subject: 's', text: 'yalnızca metin' });
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
  // Dört e-posta yolu da ortak göndericiyi ve ortak düzeni kullanır
  for (const f of ['server/notifications/email.js', 'server/documents/delivery.js', 'server/profile/warehouse.js', 'server/mail/sendInvite.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /sendBrandedMail\(transport, /, f);
  }
  for (const f of ['server/notifications/email.js', 'server/documents/delivery.js', 'server/mail/templates/warehouse.js', 'server/mail/templates/invite.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /brandedHtml\(\{/, f);
  }
  // Şablonlar kendi <html> / <body> iskeletini yazmaz (iskelet tek yerde: server/mail/layout.js)
  const skeletons = files.filter((f) => /<!doctype html>|<html\b/i.test(fs.readFileSync(f, 'utf8'))).map(rel).filter((f) => f.startsWith('server/'));
  assert.deepEqual(skeletons, ['server/mail/layout.js']);
});
