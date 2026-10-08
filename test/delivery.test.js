// Profil teslimatının belgeleri (Paket 8, karar 195–196) — saf kurallar, rapor PDF'i ve yapı. Veritabanı tarafı (tekil kayıt,
// eşzamanlılık, yetki, erişim): test/db/delivery.test.js; uçtan uca: e2e/42-depo-teslimat.spec.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  DELIVERY_DOC_STAGES, PHOTO_MAX_BYTES, REPORT_EMBED, canManageDelivery, photoProblem, photosToEmbed, reportContentKey, reportNote,
  reportSnapshot, takesDeliveryDocs,
} from '../server/delivery/rules.js';
import { deliveryReportPdf } from '../server/pdf/delivery-report.js';
import { jpegOrientation, orientationMatrix } from '../server/pdf/pdf.js';
import { FONTS } from '../server/pdf/fonts.js';
import { BRAND } from '../server/branding/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- yardımcılar ----------
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
/** PDF içerik akışları (çözülmüş) */
function contentStreams(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    try { out.push(zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1')); } catch { /* yazı tipi akışı */ }
  }
  return out;
}
const pageTexts = (pdf) => contentStreams(pdf).map((ops) => [...ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)]
  .map((t) => (t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'].get(parseInt(h, 16)) ?? 63)).join('')))
  .filter((l) => l.length);

/** EXIF yönü taşıyan en küçük JPEG (SOF0 boyutu + APP1 Exif); le: Intel (II) / Motorola (MM) bayt sırası */
function jpeg({ orientation = 1, w = 40, h = 20, le = true, exif = true } = {}) {
  const u16 = (v) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(v); else b.writeUInt32BE(v); return b; };
  const tiff = Buffer.concat([Buffer.from(le ? 'II' : 'MM', 'latin1'), u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u32(0)]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  const app1 = exif ? Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]) : Buffer.alloc(0);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

const TEXT = (locale = 'tr') => ({
  title: locale === 'tr' ? 'Teslimat raporu #2' : 'Raport de livrare #2',
  firm: locale === 'tr' ? 'Ünsal Cam Şirketi' : 'Sticlă și Uși SRL',
  subtitle: 'Sipariş UNSP1 · Oluşturma: 08.10.2026 14:30',
  info: [['Sipariş no', 'UNSP1'], ['Teslimat durumu', locale === 'tr' ? 'Teslim edildi' : 'Livrată'], ['Oluşturan', 'Depo bağlantısı · 08.10.2026 14:30']],
  note: { label: 'Açıklama', text: locale === 'tr' ? 'İki koli eksik değildi.\nŞoför imzaladı.' : 'Șoferul a semnat; țeava întreagă.' },
  itemsTitle: 'Teslim edilen ürünler ve miktarlar', photosTitle: 'Fotoğraflar', noPhotos: 'Bu raporda fotoğraf yok.',
  notEmbedded: 'belgeye gömülmedi, bağlantıdan açın', linkHint: 'Bağlantılar giriş gerektirir.',
  cols: { code: 'Kod', product: 'Ürün', unit: 'Birim', qty: 'Miktar' },
});

// ---------- kurallar ----------

test('fotoğraf: yalnızca JPG / JPEG / PNG, boş değil, en çok 20 MB; miras alınan ad uzantı sayılmaz', () => {
  assert.equal(PHOTO_MAX_BYTES, 20 * 1024 * 1024);
  for (const name of ['a.jpg', 'b.JPEG', 'c.Png']) assert.equal(photoProblem({ name, size: 10 }), null, name);
  for (const name of ['a.pdf', 'b.gif', 'c.heic', 'd.constructor', 'e.__proto__', 'jpg']) assert.equal(photoProblem({ name, size: 10 }), 'type', name);
  assert.equal(photoProblem({ name: 'a.jpg', size: 0 }), 'empty');
  assert.equal(photoProblem({ name: 'a.jpg', size: PHOTO_MAX_BYTES + 1 }), 'size');
  assert.equal(photoProblem({ name: 'a.jpg', size: PHOTO_MAX_BYTES }), null);
  assert.equal(photoProblem(null), 'empty');
});

test('teslimat belgesi: yalnızca depoya iletilmiş sipariş; yalnızca depo bağlantısı ve yönetici (yeni rol yok)', () => {
  assert.deepEqual([...DELIVERY_DOC_STAGES], ['DEPODA', 'TESLIM_EDILDI', 'FATURALANDI']);
  for (const stage of DELIVERY_DOC_STAGES) assert.ok(takesDeliveryDocs({ stage, status: 'HAZIRLANIYOR' }), stage);
  for (const stage of ['FIYAT_BEKLIYOR', 'TEKLIF_GONDERILDI', 'ONAYLANDI', 'PROFORMA']) assert.ok(!takesDeliveryDocs({ stage, status: 'HAZIRLANIYOR' }), stage);
  assert.ok(!takesDeliveryDocs({ stage: 'DEPODA', status: 'IPTAL' }), 'iptal');
  assert.ok(!takesDeliveryDocs({ stage: 'DEPODA', status: 'HAZIRLANIYOR', removedAt: new Date() }), 'silinmiş');
  assert.equal(canManageDelivery({ role: 'ADMIN' }), true);
  assert.equal(canManageDelivery({ id: null, role: 'DEPOT', depot: true }), true);
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI', 'SYSTEM']) assert.equal(canManageDelivery({ role }), false, role);
  assert.equal(canManageDelivery({ role: 'DENETIMCI', depot: 'true' }), false, 'yalnızca gerçek depo bayrağı');
  assert.equal(canManageDelivery(null), false);
});

test('rapor açıklaması: sadeleşir, satır sonları kalır, en çok 1000 karakter; boşsa yok', () => {
  assert.equal(reportNote('  bir   iki \r\n\r\n\r\n üç  '), 'bir iki\n\nüç');
  assert.equal(reportNote(''), null);
  assert.equal(reportNote(null), null);
  assert.equal(reportNote('x'.repeat(1500)).length, 1000);
});

test('rapor kopyası: virüslü fotoğraf girmez; iç ekip adı yalnızca yöneticinin yüklediğinde; içerik anahtarı değişikliği yakalar', () => {
  const base = {
    order: { orderNo: 'UNSP1', title: 'Villa', status: 'HAZIRLANIYOR', customer: { name: 'Ünsal Cam' } },
    profile: { stage: 'TESLIM_EDILDI', pickupDate: new Date('2026-10-14T12:00:00Z'), deliveredAt: new Date('2026-10-14T09:30:00Z'), deliveredVia: 'DEPOT_LINK' },
    items: [{ code: 'GK15', nameTr: 'Conta', nameRo: 'Garnitură', unitCode: 'CUTII', qty: 4 }],
    photos: [
      { id: 'p1', via: 'DEPOT_LINK', createdAt: new Date('2026-10-14T09:00:00Z'), file: { name: 'a.jpg', size: 10, scanStatus: 'CLEAN', uploadedBy: null } },
      { id: 'p2', via: 'ADMIN', createdAt: new Date('2026-10-14T09:10:00Z'), file: { name: 'b.jpg', size: 10, scanStatus: 'INFECTED', uploadedBy: { name: 'Yönetici' } } },
      { id: 'p3', via: 'ADMIN', createdAt: new Date('2026-10-14T09:20:00Z'), file: { name: 'c.png', size: 10, scanStatus: 'PENDING', uploadedBy: { name: 'Ayşe' } } },
    ],
    note: 'Teslim edildi', via: 'DEPOT_LINK', createdBy: null, now: new Date('2026-10-14T10:00:00Z'),
  };
  const s = reportSnapshot(base);
  assert.deepEqual(s.photos.map((p) => [p.id, p.by]), [['p1', null], ['p3', 'Ayşe']]);
  assert.deepEqual([s.orderNo, s.firm, s.stage, s.pickupDay, s.deliveredAt, s.items[0].qty], ['UNSP1', 'Ünsal Cam', 'TESLIM_EDILDI', '2026-10-14', '2026-10-14T09:30:00.000Z', 4]);
  const k = reportContentKey(s);
  assert.equal(reportContentKey(reportSnapshot({ ...base, now: new Date('2026-10-15T10:00:00Z') })), k, 'oluşturma anı içerik değildir');
  assert.notEqual(reportContentKey(reportSnapshot({ ...base, note: 'farklı' })), k);
  assert.notEqual(reportContentKey(reportSnapshot({ ...base, photos: base.photos.slice(0, 1) })), k);
});

test('rapora gömme: yalnızca temiz / taranmamış JPEG-PNG, boyut ve toplam sınırı; aşan fotoğraf yalnızca bağlantıyla', () => {
  const p = (id, name, size, scanStatus = 'CLEAN') => ({ id, name, size, scanStatus });
  const e = photosToEmbed([p('a', 'a.jpg', 1000), p('b', 'b.jpg', 1000, 'PENDING'), p('c', 'c.jpg', 1000, 'INFECTED'), p('d', 'd.png', REPORT_EMBED.pngBytes + 1), p('e', 'e.jpg', REPORT_EMBED.jpegBytes + 1), p('f', 'f.png', 500, 'SKIPPED')]);
  assert.deepEqual([...e], ['a', 'f']);
  const many = Array.from({ length: 40 }, (_, i) => p(`m${i}`, `m${i}.jpg`, 3 * 1024 * 1024));
  const big = photosToEmbed(many);
  assert.ok(big.size <= REPORT_EMBED.photos && big.size * 3 * 1024 * 1024 <= REPORT_EMBED.totalBytes, `${big.size}`);
});

// ---------- PDF ----------

test('JPEG EXIF yönü okunur (II / MM); bozuk ya da eksik EXIF düz kabul edilir', () => {
  for (const o of [1, 3, 6, 8]) assert.equal(jpegOrientation(jpeg({ orientation: o })), o);
  assert.equal(jpegOrientation(jpeg({ orientation: 6, le: false })), 6);
  assert.equal(jpegOrientation(jpeg({ exif: false })), 1);
  assert.equal(jpegOrientation(jpeg({ orientation: 9 })), 1);
  const broken = jpeg({ orientation: 6 }).subarray(0, 20);
  assert.equal(jpegOrientation(broken), 1);
  assert.equal(jpegOrientation(Buffer.from('not a jpeg')), 1);
});

test('EXIF yön dönüşümü: görselin sol üst pikseli EXIF tanımındaki köşeye, birim kare kutunun tamamına gider', () => {
  const [x0, y0, dw, dh] = [10, 20, 100, 50];
  const corner = { 1: 'tl', 2: 'tr', 3: 'br', 4: 'bl', 5: 'tl', 6: 'tr', 7: 'br', 8: 'bl' };
  const at = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  for (let o = 1; o <= 8; o++) {
    const m = orientationMatrix(o, x0, y0, dw, dh);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => at(m, u, v));
    assert.deepEqual([Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))], [x0, x0 + dw, y0, y0 + dh], `yön ${o}`);
    const [x, y] = at(m, 0, 1); // görüntünün 0. satırı, 0. sütunu
    const want = { tl: [x0, y0 + dh], tr: [x0 + dw, y0 + dh], br: [x0 + dw, y0], bl: [x0, y0] }[corner[o]];
    assert.deepEqual([x, y], want, `yön ${o}`);
  }
});

test('teslimat raporu PDF: Türkçe / Romence harfler, açıklama, ürünler; fotoğraf gömülür (EXIF 6 → dik), bağlantı yazılır; sayfalama', () => {
  for (const locale of ['tr', 'ro']) {
    const items = Array.from({ length: 60 }, (_, i) => ({ code: `GK${i}`, name: locale === 'tr' ? `Çıta ğüşöı ${i}` : `Țeavă șurub ${i}`, unit: 'buc', qty: i + 1 }));
    const pdf = deliveryReportPdf({
      items,
      photos: [
        { label: 'dik.jpg · 14.10.2026 12:00 · depo', url: 'https://takip.test/dosya/teslimat/p1?ac=1', buf: jpeg({ orientation: 6 }) },
        { label: 'yatay.jpg · 14.10.2026 12:01 · depo', url: 'https://takip.test/dosya/teslimat/p2?ac=1', buf: jpeg({ orientation: 1 }) },
        { label: 'buyuk.png · 14.10.2026 12:02 · GKH', url: 'https://takip.test/dosya/teslimat/p3?ac=1', buf: null },
      ],
    }, TEXT(locale));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const pages = pageTexts(pdf);
    const all = pages.flat().join('\n');
    assert.ok(pages.length >= 3, `${locale} sayfa sayısı ${pages.length}`);
    for (const s of [TEXT(locale).title, TEXT(locale).firm, items[59].name, 'https://takip.test/dosya/teslimat/p3?ac=1', 'belgeye gömülmedi, bağlantıdan açın']) assert.ok(all.includes(s), `${locale}: ${s}`);
    for (const l of TEXT(locale).note.text.split('\n')) assert.ok(all.includes(l), l);
    pages.forEach((p, i) => assert.ok(p.includes(`${i + 1} / ${pages.length}`), `altbilgi ${i + 1}`));
    assert.ok(pages.slice(1).every((p) => p.some((l) => l.startsWith(TEXT(locale).title))), 'sonraki sayfa başlığı');
    // Logo + iki fotoğraf gömülü; üçüncüsü yalnızca bağlantı
    const images = [...pdf.toString('latin1').matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map((m) => `${m[1]}x${m[2]}`);
    assert.deepEqual(images.filter((x) => x !== `${BRAND.logo.width}x${BRAND.logo.height}`).sort(), ['40x20', '40x20'].sort());
    // EXIF 6: görünen boyut 20 × 40 (dik) → kutuya yükseklikten sığar (292): dönüşüm 0 -292 146 0
    const ops = contentStreams(pdf).join('\n');
    assert.match(ops, /q 0 -292 146 0 [\d.]+ [\d.]+ cm \/Im\d+ Do Q/);
    assert.match(ops, /q 507 0 0 253\.5 [\d.]+ [\d.]+ cm \/Im\d+ Do Q/);
  }
});

test('rapor PDF: fotoğrafsız rapor; çözülemeyen görsel "gömülmedi" diye işaretlenir', () => {
  const t = TEXT('tr');
  const none = pageTexts(deliveryReportPdf({ items: [{ code: 'A', name: 'Ürün', unit: 'buc', qty: 1 }], photos: [] }, { ...t, note: null })).flat().join('\n');
  assert.ok(none.includes(t.noPhotos) && none.includes('Fotoğraflar (0)'));
  const bad = pageTexts(deliveryReportPdf({ items: [], photos: [{ label: 'bozuk.jpg', url: 'u', buf: Buffer.from('not an image') }] }, t)).flat().join('\n');
  assert.ok(bad.includes(`1. bozuk.jpg — ${t.notEmbedded}`));
});

// ---------- yapı ----------

test('yapı: fotoğraf ve rapor yalnızca servisten yazılır; servis yetkiyi ilk satırda denetler; tetikleyici değişmezliği korur', () => {
  const service = read('server/delivery/service.js');
  for (const fn of ['recordDeliveryPhoto', 'createDeliveryReport']) {
    const body = service.slice(service.indexOf(`export async function ${fn}`));
    assert.match(body.split('\n').slice(1, 3).join('\n'), /if \(!canManageDelivery\(actor\)\) return FORBIDDEN;/, fn);
  }
  const writers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p); continue; }
      if (/\.(js|ts|tsx|mjs)$/.test(e.name) && /delivery(Photo|Report)\.(create|update|upsert|delete)/.test(read(p))) writers.push(p);
    }
  };
  for (const d of ['app', 'lib', 'server', 'scripts', 'components']) walk(d);
  assert.deepEqual(writers, ['server/delivery/service.js']);
  const sql = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => d.endsWith('_delivery_calendars')).map((d) => read(`prisma/migrations/${d}/migration.sql`)).join('\n');
  assert.match(sql, /CREATE TRIGGER "DeliveryPhoto_guard"\s+BEFORE UPDATE OR DELETE ON "DeliveryPhoto"/);
  assert.match(sql, /CREATE TRIGGER "DeliveryReport_guard"\s+BEFORE UPDATE OR DELETE ON "DeliveryReport"/);
  assert.match(sql, /CREATE UNIQUE INDEX "DeliveryPhoto_orderId_checksum_key"/);
});

test('yapı: fotoğraflar tek tek yüklenir (istek başına bir dosya) ve aynı yükleme yolundan geçer; tekrar / ret dosyayı siler', () => {
  for (const f of ['app/depo/[token]/actions.ts', 'app/(panel)/siparisler/[id]/profile-actions.ts']) {
    const src = read(f);
    const start = src.indexOf(f.includes('depo') ? 'export async function depotPhotoAction' : 'export async function deliveryPhotoAction');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(body.includes("filesFrom(fd, 'photo')") && body.includes('files.length !== 1'), `${f}: tek dosya`);
    assert.ok(/storeFiles\(files, \{/.test(body), `${f}: storeFiles`);
    assert.ok(body.includes('recordDeliveryPhoto(db,'), `${f}: kayıt servisi`);
    assert.ok(body.includes('if (!r.ok || r.duplicate) await discardFiles(stored.stored);'), `${f}: tekrar / ret`);
    assert.ok(body.includes('await discardFiles(stored.stored);\n    throw e;'), `${f}: beklenmeyen hata`);
  }
  const client = read('components/DeliveryPhotoUpload.tsx');
  assert.ok(client.includes("fd.set('photo', f)") && /for \(let i = 0; i < files\.length; i\+\+\)/.test(client), 'istemci sırayla, birer birer');
});

test('yapı: dosya yolu — teslimat fotoğrafı ve rapor sipariş kapsamından; rapor kopyadan üretilir; istek sınırı', () => {
  const route = read('app/dosya/[kind]/[id]/route.ts');
  assert.ok(route.includes("db.deliveryPhoto.findFirst({ where: { id, order: scope }"));
  assert.ok(route.includes('renderDeliveryReport(db, {') && route.includes('orderWhere: scope'));
  assert.ok(route.includes('reportLimiter.take(userId)') && route.includes("audit('DELIVERY_REPORT_VIEW'"));
  assert.ok(route.indexOf("kind === 'rapor'") > route.indexOf("if (!userCan(user, 'ORDER_VIEW'))"), 'giriş ve sipariş görme yetkisinden sonra');
});
