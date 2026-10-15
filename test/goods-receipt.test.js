// 3.87.0 (karar 282) — tedarikçi mal kabulü: saf kurallar, INTRAREA MARFĂ belgesi (fiyat / maliyet yok), depo e-postası
// şablonu, yetki ve yapı. Veritabanı ve işçi senaryoları test/db/goods-receipt.test.js'te.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { can } from '../server/auth/permissions.js';
import {
  RECEIVABLE_STATUSES, fullyReceived, parseReceipt, profileLength, receiptBalance, receiptMailNotSent, receiptSummary, unitCompatible,
} from '../server/suppliers/receipt-rules.js';
import { receiveGoods } from '../server/suppliers/receipt.js';
import { goodsReceiptPdf } from '../server/pdf/goods-receipt.js';
import { renderGoodsReceiptEmail } from '../server/mail/templates/goods-receipt.js';
import { FONTS } from '../server/pdf/fonts.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const KEY = 'k'.repeat(24);
const TODAY = '2026-10-15';

test('form: anahtar, tarih (gelecek / bir yıldan eski olamaz), referans, not, miktar; boş kabul yok', () => {
  const base = { requestKey: KEY, receivedOn: TODAY, quantities: { a: '5' } };
  const ok = parseReceipt({ ...base, reference: '  AVZ   12 ', note: 'not' }, { today: TODAY });
  assert.equal(ok.ok, true);
  assert.equal(ok.reference, 'AVZ 12');
  assert.deepEqual([...ok.quantities], [['a', 5]]);
  assert.deepEqual(parseReceipt({ ...base, requestKey: 'kisa' }, { today: TODAY }), { ok: false, code: 'KEY' });
  assert.deepEqual(parseReceipt({ ...base, receivedOn: '2026-02-30' }, { today: TODAY }), { ok: false, code: 'DATE' });
  assert.deepEqual(parseReceipt({ ...base, receivedOn: '2026-10-16' }, { today: TODAY }), { ok: false, code: 'DATE_FUTURE' });
  assert.deepEqual(parseReceipt({ ...base, receivedOn: '2025-10-13' }, { today: TODAY }), { ok: false, code: 'DATE_OLD' });
  assert.deepEqual(parseReceipt({ ...base, reference: 'x'.repeat(101) }, { today: TODAY }), { ok: false, code: 'REFERENCE' });
  assert.deepEqual(parseReceipt({ ...base, note: 'x'.repeat(501) }, { today: TODAY }), { ok: false, code: 'NOTE' });
  for (const bad of ['-1', '1.5', '1e3', 'abc', '99999999']) assert.deepEqual(parseReceipt({ ...base, quantities: { a: bad } }, { today: TODAY }), { ok: false, code: 'QTY', line: 'a' }, bad);
  assert.deepEqual(parseReceipt({ ...base, quantities: { a: '0', b: '' } }, { today: TODAY }), { ok: false, code: 'EMPTY' });
  assert.deepEqual(parseReceipt({ ...base, quantities: {} }, { today: TODAY }), { ok: false, code: 'EMPTY' });
});

test('bakiye: sipariş edilen − teslim alınan = kalan (eksiye düşmez); tamamı teslim alındı mı', () => {
  const lines = [{ id: 'a', qty: 100 }, { id: 'b', qty: 10 }];
  const b = receiptBalance(lines, new Map([['a', 40]]));
  assert.deepEqual(b.get('a'), { ordered: 100, received: 40, remaining: 60 });
  assert.deepEqual(b.get('b'), { ordered: 10, received: 0, remaining: 10 });
  assert.equal(fullyReceived(b), false);
  assert.equal(fullyReceived(receiptBalance(lines, new Map([['a', 100], ['b', 10]]))), true);
  assert.deepEqual(receiptBalance([{ id: 'a', qty: 5 }], new Map([['a', 9]])).get('a'), { ordered: 5, received: 9, remaining: 0 });
  assert.equal(fullyReceived(new Map()), false);
});

test('birim: yalnızca stok birimiyle aynı birim (dönüşüm tahmin edilmez); uzunluk yalnızca BAR + metre paket içeriği', () => {
  assert.equal(unitCompatible({ unitCode: 'BARA' }, { unitCode: 'BARA' }), true);
  assert.equal(unitCompatible({ unitCode: 'CUTII' }, { unitCode: 'BUCATI' }), false);
  assert.equal(profileLength({ unitCode: 'BARA', packMeasure: 'M', packContent: '6.000' }), '6.000');
  assert.equal(profileLength({ unitCode: 'BARA', packMeasure: 'M', packContent: null }), null);
  assert.equal(profileLength({ unitCode: 'CUTII', packMeasure: 'M', packContent: '137' }), null, 'kutudaki conta metresi uzunluk değildir');
  assert.equal(profileLength({ unitCode: 'BARA', packMeasure: 'BUC', packContent: '6' }), null);
  assert.deepEqual(receiptSummary([{ qty: 2, unitCode: 'BARA' }, { qty: 3, unitCode: 'CUTII' }, { qty: 4, unitCode: 'BARA' }]), { lines: 3, byUnit: [{ unitCode: 'BARA', qty: 6 }, { unitCode: 'CUTII', qty: 3 }] });
  assert.deepEqual(RECEIVABLE_STATUSES, ['GONDERIM_BEKLIYOR', 'GONDERILDI', 'GONDERIM_HATASI']);
});

test('e-posta hatası: bağlanılamadı / sunucu açık kodla reddetti → kesin gitmedi (yeniden denenir); kodsuz kopma belirsiz (yeniden gönderilmez)', () => {
  assert.equal(receiptMailNotSent({ command: 'CONN' }), true);
  assert.equal(receiptMailNotSent({ responseCode: 550, command: 'RCPT TO' }), true);
  assert.equal(receiptMailNotSent({ code: 'ECONNRESET', command: 'DATA' }), false);
  assert.equal(receiptMailNotSent(null), false);
});

test('yetki: mal kabulü SUPPLIER_MANAGE + STOCK_MANAGE (yönetici, yönetici yardımcısı); diğer roller reddedilir, veritabanına dokunulmaz', async () => {
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI']) assert.ok(can(role, 'SUPPLIER_MANAGE') && can(role, 'STOCK_MANAGE'), role);
  const touched = [];
  const db = new Proxy({}, { get: (_, k) => { touched.push(String(k)); return () => { throw new Error('dokunulmamalı'); }; } });
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', undefined]) {
    assert.deepEqual(await receiveGoods(db, { orderId: 'x', requestKey: KEY, receivedOn: TODAY, quantities: { a: '1' } }, role ? { id: 'u', role } : null), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  assert.deepEqual(touched, []);
});

/** PDF içerik akışlarındaki metinler (test/commercial.test.js ile aynı okuyucu) */
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

const DOC = {
  orderNo: 'TS-2026-007', supplierName: 'Alüminyum Tedarik', seq: 2, receivedOn: new Date('2026-10-14T00:00:00Z'), reference: 'AVIZ 4411', note: 'Paleti: 2', complete: false,
  categories: [{ code: 'GARNITURI', name: 'Garnituri' }, { code: 'PROFILE', name: 'Profile aluminiu' }],
  lines: [
    { code: 'RM12-7016', name: 'Profil RM12 7016', color: 'RAL 7016', length: '6.000', qty: 161, unit: 'bare', categoryCode: 'PROFILE', image: null },
    { code: 'GK15', name: 'Garnitura EPDM GK15', color: null, length: null, qty: 13, unit: 'cutii', categoryCode: 'GARNITURI', image: null },
  ],
  totals: [{ qty: 161, unit: 'bare' }, { qty: 13, unit: 'cutii' }],
};

test('INTRAREA MARFĂ belgesi: Romence başlık, tedarikçi, sipariş no, kabul no / tarihi, referans, kod, renk, uzunluk, miktar + birim, özet; fiyat / maliyet yok', () => {
  const pdf = goodsReceiptPdf(DOC);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(pdf).join('\n');
  for (const s of ['INTRAREA MARFĂ', 'Alüminyum Tedarik', 'TS-2026-007', '14.10.2026', 'AVIZ 4411', 'RM12-7016 — Profil RM12 7016', 'Culoare: RAL 7016', 'Lungime: 6 m', '161 bare', '13 cutii', 'TOTAL RECEPȚIONAT: 2 poziții', '161 bare + 13 cutii', 'GARNITURI', 'PROFILE ALUMINIU', 'Recepție parțială']) {
    assert.ok(text.includes(s), s);
  }
  // Fiyat, tutar, maliyet, kâr, para birimi yazılmaz (veri de verilmez — ama belge metninde de iz yok)
  for (const s of ['EUR', 'RON', 'Preț', 'Pret', 'Valoare', 'Total valoare', 'Cost', 'Profit', 'fiyat', 'maliyet']) assert.ok(!text.includes(s), s);
  // Uzunluk: yalnızca ondalık sıfırlar atılır (60 m "6 m" olmaz)
  const long = pdfText(goodsReceiptPdf({ ...DOC, lines: [{ ...DOC.lines[0], length: '60' }, { ...DOC.lines[0], code: 'X2', length: '6.500' }] })).join('\n');
  assert.ok(long.includes('Lungime: 60 m') && long.includes('Lungime: 6,5 m'));
  // Kategorisi bilinmeyen satır "ALTE PRODUSE" altında; boş kategori başlığı yazılmaz
  const other = pdfText(goodsReceiptPdf({ ...DOC, categories: [], lines: [DOC.lines[1]], totals: [{ qty: 13, unit: 'cutii' }] })).join('\n');
  assert.ok(other.includes('ALTE PRODUSE') && !other.includes('PROFILE ALUMINIU'));
});

test('belge üreticisi kopyadan çalışır: fiyat alanı kabul satırına hiç girmez (şema + üretici + e-posta)', () => {
  const schema = read('prisma/schema.prisma');
  const model = schema.slice(schema.indexOf('model SupplierReceiptLine {'), schema.indexOf('}', schema.indexOf('model SupplierReceiptLine {')));
  assert.ok(!/price|Price|amount|total|cost/i.test(model.replace(/\/\/.*$/gm, '')), 'kabul satırında fiyat / tutar alanı yok');
  for (const f of ['server/suppliers/receipt-mail.js', 'server/pdf/goods-receipt.js', 'server/mail/templates/goods-receipt.js']) {
    assert.ok(!/unitPrice|lineTotal|purchasePrice|listPrice|\.total\b/.test(strip(read(f))), `${f}: fiyat okunmaz`);
  }
});

test('depo e-postası şablonu: Romence, GKH düzeni, ek adı, kabul edilen miktarlar; fiyat yok', () => {
  const m = renderGoodsReceiptEmail({ ...DOC, lines: DOC.lines.map((l) => ({ ...l })), fileName: 'Intrare-Marfa-TS-2026-007-2.pdf', complete: true });
  assert.match(m.subject, /^GKH Trading Invest – Intrare marfă – TS-2026-007 – recepția nr\. 2 – Alüminyum Tedarik$/);
  for (const s of ['Bună ziua', 'INTRAREA MARFĂ', '161 bare — Profil RM12 7016 (RM12-7016) — culoare RAL 7016, lungime 6 m', 'Total: 2 poziții · 161 bare + 13 cutii', 'recepționată integral']) assert.ok(m.text.includes(s), s);
  for (const s of ['EUR', 'RON', 'preț', 'Preț']) assert.ok(!m.text.includes(s) && !m.html.includes(s), s);
  assert.ok(m.html.includes('<html') && m.html.includes('cid:'), 'ortak GKH düzeni');
});

test('yapı: kabul, stok, sipariş durumu ve e-posta işi tek işlemde; kilit → tekrar anahtarı → bakiye sırası; e-postayı yalnızca işçi gönderir', () => {
  const src = strip(read('server/suppliers/receipt.js'));
  const body = src.slice(src.indexOf('export async function receiveGoods('), src.indexOf('\n// ---------- okuma'));
  const order = ['if (!allowed(actor)) return FORBIDDEN;', 'db.$transaction(', 'supplier-order:', 'requestKey: p.requestKey', 'receiptBalance(', 'supplierReceipt.create(', 'receiveSupplierStock(', 'supplierOrder.update(', 'notificationOutbox.create(', "action: 'SUPPLIER_GOODS_RECEIVED'"];
  let at = -1;
  for (const s of order) {
    const i = body.indexOf(s, at + 1);
    assert.ok(i > at, `sıra: ${s}`);
    at = i;
  }
  // Tek yazma noktası: e-posta işi yalnızca receiveGoods'ta; gönderim yalnızca işçide (sayfa / işlem göndermez)
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(js|mjs|ts|tsx)$/.test(e.name) ? [p.split(path.sep).join('/')] : [];
  });
  const code = ['app', 'lib', 'server', 'components', 'scripts'].flatMap(walk);
  assert.deepEqual(code.filter((f) => /renderGoodsReceiptEmail\(/.test(strip(read(f)))).sort(), ['server/mail/templates/goods-receipt.js', 'server/suppliers/receipt-mail.js']);
  assert.deepEqual(code.filter((f) => /dispatchReceiptEmails\(/.test(strip(read(f)))).sort(), ['scripts/worker.mjs', 'server/suppliers/receipt-mail.js']);
  // Alıcı başına "gönderiliyor" işareti gönderimden ÖNCE yazılır
  const d = strip(read('server/suppliers/receipt-mail.js'));
  assert.ok(d.indexOf('sending: to') > 0 && d.indexOf('sending: to') < d.indexOf('sendBrandedMail(transport'));
  // İşlem dosyası ikinci yetkiyi de ister; sayfa mal kabulünü STOCK_MANAGE olmadan göstermez
  assert.match(read('app/(panel)/siparisler/tedarik/actions.ts'), /export async function receiveGoodsAction[\s\S]*?requirePermission\('SUPPLIER_MANAGE'\)[\s\S]*?userCan\(admin, 'STOCK_MANAGE'\)/);
  assert.match(read('app/(panel)/siparisler/tedarik/[id]/page.tsx'), /userCan\(admin, 'STOCK_MANAGE'\)/);
  // Belge yolu yalnızca SUPPLIER_MANAGE ile ve kabul siparişe aitse
  const route = read('app/(panel)/siparisler/tedarik/[id]/kabul/[receiptId]/route.ts');
  assert.match(route, /userCan\(user, 'SUPPLIER_MANAGE'\)/);
  assert.match(route, /pdf\.receipt\.orderId !== id/);
});
