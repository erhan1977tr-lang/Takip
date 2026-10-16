// 3.91.0 (karar 286) — hatalı mal kabulünün düzeltmesi: saf kurallar (form, düzeltilebilir miktar, net teslim alınan,
// yeniden açılma), düzeltme belgesi ve e-postası (açıkça düzeltme, orijinal kabule referans, fiyat yok), yetki ve yapı.
// Veritabanı, yarış ve işçi senaryoları test/db/receipt-correction.test.js'te.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { can } from '../server/auth/permissions.js';
import { correctionBalance, netReceived, parseCorrection, receiptBalance, reopenStatus } from '../server/suppliers/receipt-rules.js';
import { correctReceipt } from '../server/suppliers/receipt.js';
import { goodsReceiptPdf } from '../server/pdf/goods-receipt.js';
import { renderGoodsReceiptEmail } from '../server/mail/templates/goods-receipt.js';
import { FONTS } from '../server/pdf/fonts.js';
import tr from '../server/i18n/tr/supplier.js';
import ro from '../server/i18n/ro/supplier.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const KEY = 'c'.repeat(24);

test('form: anahtar, gerekçe zorunlu (≤ 1000), ekran sürümü, miktar; boş düzeltme yok', () => {
  const base = { requestKey: KEY, reason: '  Gerçekte 80   geldi ', expectedVersion: '7', quantities: { a: '20', b: '' } };
  const ok = parseCorrection(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, 'Gerçekte 80 geldi');
  assert.equal(ok.expectedVersion, 7);
  assert.deepEqual([...ok.quantities], [['a', 20]]);
  assert.deepEqual(parseCorrection({ ...base, requestKey: 'kisa' }), { ok: false, code: 'KEY' });
  assert.deepEqual(parseCorrection({ ...base, reason: '   ' }), { ok: false, code: 'REASON' });
  assert.deepEqual(parseCorrection({ ...base, reason: undefined }), { ok: false, code: 'REASON' });
  assert.deepEqual(parseCorrection({ ...base, reason: 'x'.repeat(1001) }), { ok: false, code: 'REASON_LONG' });
  assert.equal(parseCorrection({ ...base, reason: 'x'.repeat(1000) }).ok, true);
  for (const v of ['', 'abc', '-1', '1.5', undefined]) assert.deepEqual(parseCorrection({ ...base, expectedVersion: v }), { ok: false, code: 'VERSION' }, String(v));
  for (const bad of ['-1', '1.5', '1e3', 'abc', '99999999']) assert.deepEqual(parseCorrection({ ...base, quantities: { a: bad } }), { ok: false, code: 'QTY', line: 'a' }, bad);
  assert.deepEqual(parseCorrection({ ...base, quantities: { a: '0', b: '' } }), { ok: false, code: 'EMPTY' });
  assert.deepEqual(parseCorrection({ ...base, quantities: {} }), { ok: false, code: 'EMPTY' });
});

test('düzeltilebilir miktar: kabul edilen − önceki düzeltmeler (eksiye düşmez); toplam asla kabulü aşmaz', () => {
  const lines = [{ id: 'r1', qty: 100 }, { id: 'r2', qty: 10 }];
  const b = correctionBalance(lines, new Map([['r1', 20]]));
  assert.deepEqual(b.get('r1'), { accepted: 100, corrected: 20, correctable: 80 });
  assert.deepEqual(b.get('r2'), { accepted: 10, corrected: 0, correctable: 10 });
  assert.deepEqual(correctionBalance([{ id: 'r', qty: 5 }], new Map([['r', 9]])).get('r'), { accepted: 5, corrected: 9, correctable: 0 });
  // Rastgele birden çok kısmi düzeltme: her adımda en çok "düzeltilebilir" kadar → toplam kabulü aşamaz
  for (let round = 0; round < 200; round++) {
    const accepted = 1 + Math.floor(Math.random() * 500);
    let done = 0;
    for (let i = 0; i < 6; i++) {
      const c = correctionBalance([{ id: 'x', qty: accepted }], new Map([['x', done]])).get('x').correctable;
      const ask = Math.floor(Math.random() * (accepted + 3));
      if (ask <= c) done += ask;
    }
    assert.ok(done <= accepted);
  }
});

test('net teslim alınan = kabuller − düzeltmeler; kalan yeniden hesaplanır (100 kabul, 20 düzeltme → net 80, kalan 20)', () => {
  const net = netReceived([{ orderLineId: 'L', _sum: { qty: 100 } }, { orderLineId: 'M', _sum: { qty: 5 } }], [{ orderLineId: 'L', _sum: { qty: 20 } }]);
  assert.deepEqual([...net], [['L', 80], ['M', 5]]);
  const bal = receiptBalance([{ id: 'L', qty: 100 }, { id: 'M', qty: 5 }], net);
  assert.deepEqual(bal.get('L'), { ordered: 100, received: 80, remaining: 20 });
  assert.deepEqual(bal.get('M'), { ordered: 5, received: 5, remaining: 0 });
  assert.deepEqual([...netReceived([], [{ orderLineId: 'X', _sum: { qty: 3 } }])], [['X', 0]], 'eksiye düşmez');
});

test('yeniden açılma: yalnızca mal kabulüyle OTOMATİK kapanmış ve artık eksik sipariş; elle kapatılmış / iptal açılmaz', () => {
  const at = new Date('2026-10-14T10:00:00Z');
  const auto = { status: 'TESLIM_ALINDI', receivedAt: at, sentAt: new Date('2026-10-01T00:00:00Z'), sendError: null };
  const receipts = [{ complete: false, createdAt: new Date('2026-10-10T00:00:00Z') }, { complete: true, createdAt: at }];
  // E-posta gönderim durumu değişmez (ürün sahibi): gerçek hata → hata; gönderildi → gönderildi; hiç gönderilmedi → hata DEĞİL
  assert.equal(reopenStatus(auto, receipts, false), 'GONDERILDI');
  assert.equal(reopenStatus({ ...auto, sentAt: null, sendError: 'SMTP' }, receipts, false), 'GONDERIM_HATASI');
  assert.equal(reopenStatus({ ...auto, sentAt: null, sendError: 'NO_EMAIL' }, receipts, false), 'GONDERIM_HATASI');
  assert.equal(reopenStatus({ ...auto, sentAt: null, sendError: null }, receipts, false), 'GONDERIM_BEKLIYOR', 'gönderilmemiş olmak gönderim hatası değildir');
  assert.equal(reopenStatus({ ...auto, sentAt: null }, receipts, false), 'GONDERIM_BEKLIYOR');
  assert.equal(reopenStatus(auto, receipts, true), null, 'hâlâ tamam');
  // Elle kapatıldı ("Kalanı beklemeden kapat"): kapanış zamanı bir kabulün zamanı değil
  assert.equal(reopenStatus({ ...auto, receivedAt: new Date('2026-10-15T00:00:00Z') }, receipts, false), null);
  assert.equal(reopenStatus(auto, [{ complete: false, createdAt: at }], false), null);
  for (const status of ['GONDERILDI', 'GONDERIM_BEKLIYOR', 'GONDERIM_HATASI', 'IPTAL', 'TASLAK']) assert.equal(reopenStatus({ ...auto, status }, receipts, false), null, status);
  assert.equal(reopenStatus({ ...auto, receivedAt: null }, receipts, false), null);
});

test('yetki: düzeltme SUPPLIER_MANAGE + STOCK_MANAGE (yönetici, yönetici yardımcısı); diğer roller reddedilir, veritabanına dokunulmaz', async () => {
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI']) assert.ok(can(role, 'SUPPLIER_MANAGE') && can(role, 'STOCK_MANAGE'), role);
  const touched = [];
  const db = new Proxy({}, { get: (_, k) => { touched.push(String(k)); return () => { throw new Error('dokunulmamalı'); }; } });
  const v = { orderId: 'o', receiptId: 'r', requestKey: KEY, reason: 'x', expectedVersion: '1', quantities: { a: '1' } };
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', undefined]) {
    assert.deepEqual(await correctReceipt(db, v, role ? { id: 'u', role } : null), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  // Form hatası da veritabanından önce
  assert.deepEqual(await correctReceipt(db, { ...v, reason: '' }, { id: 'a', role: 'ADMIN' }), { ok: false, code: 'REASON' });
  assert.deepEqual(touched, []);
});

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
  orderNo: 'TS-2026-007', supplierName: 'Alüminyum Tedarik', seq: 2, receivedOn: new Date('2026-10-14T00:00:00Z'), reference: 'AVIZ 4411', note: null, complete: false,
  categories: [{ code: 'PROFILE', name: 'Profile aluminiu' }],
  lines: [{ code: 'RM12-7016', name: 'Profil RM12 7016', color: 'RAL 7016', length: '6.000', qty: 20, unit: 'bare', categoryCode: 'PROFILE', image: null }],
  totals: [{ qty: 20, unit: 'bare' }],
};
const FIX = { seq: 1, createdAt: new Date('2026-10-16T09:00:00Z'), reason: 'Avizde 100, gerçekte 80' };

test('düzeltme belgesi: açıkça CORECȚIE, orijinal recepția nr. ve tarihi, gerekçe, eksi miktar; fiyat yok; orijinal belge aynı kalır', () => {
  const text = pdfText(goodsReceiptPdf({ ...DOC, correction: FIX })).join('\n');
  for (const s of ['CORECȚIE RECEPȚIE — INTRAREA MARFĂ', 'CORECȚIA NR. :', 'LA RECEPȚIA NR. :', 'RECEPȚIA ORIGINALĂ :', 'nr. 2 din 14.10.2026 · AVIZ 4411', 'MOTIV: Avizde 100, gerçekte 80', '16.10.2026', '-20 bare', 'CANTITATE SCĂZUTĂ', 'TOTAL CORECTAT (SCĂZUT DIN STOC): 1 poziții', 'Documentul original al recepției rămâne neschimbat.']) {
    assert.ok(text.includes(s), s);
  }
  for (const s of ['EUR', 'RON', 'Preț', 'Cost']) assert.ok(!text.includes(s), s);
  // Orijinal kabul belgesi: düzeltme verilmediğinde eskisi gibi (düzeltme izi yok)
  const original = pdfText(goodsReceiptPdf(DOC)).join('\n');
  assert.ok(original.includes('INTRAREA MARFĂ') && original.includes('TOTAL RECEPȚIONAT') && !original.includes('CORECȚIE') && original.includes('20 bare'));
});

test('düzeltme e-postası: konu ve metin açıkça CORECȚIE, orijinal kabule referans, eksi miktar, ek adı; fiyat yok; ortak GKH düzeni', () => {
  const m = renderGoodsReceiptEmail({ ...DOC, correction: FIX, fileName: 'Corectie-Receptie-TS-2026-007-2-1.pdf' });
  assert.equal(m.subject, 'GKH Trading Invest – CORECȚIE recepție – TS-2026-007 – recepția nr. 2 – corecția nr. 1 – Alüminyum Tedarik');
  for (const s of ['a fost CORECTATĂ (corecția nr. 1)', 'Recepția originală și documentul ei rămân neschimbate', '-20 bare — Profil RM12 7016 (RM12-7016)', 'Motiv: Avizde 100, gerçekte 80', 'Corectie-Receptie-TS-2026-007-2-1.pdf']) assert.ok(m.text.includes(s), s);
  for (const s of ['EUR', 'RON', 'preț', 'Preț']) assert.ok(!m.text.includes(s) && !m.html.includes(s), s);
  assert.ok(m.html.includes('<html') && m.html.includes('cid:'));
  assert.ok(m.html.includes('CORECȚIE') && m.html.includes('<b>-20</b>'));
  // Gerekçe HTML'de kaçışlanır
  assert.ok(!renderGoodsReceiptEmail({ ...DOC, correction: { ...FIX, reason: '<script>x</script>' }, fileName: 'a.pdf' }).html.includes('<script>x'));
  // Düzeltme verilmeyen e-posta eskisiyle aynı (kabul e-postası değişmedi)
  assert.match(renderGoodsReceiptEmail({ ...DOC, fileName: 'a.pdf' }).subject, /^GKH Trading Invest – Intrare marfă – TS-2026-007 – recepția nr\. 2 – /);
});

test('yapı: kilit → tekrar anahtarı → eski ekran → bakiye → stok kilidi ve yeterlilik → kayıt → ters hareket → sipariş → e-posta işi → denetim (tek işlem)', () => {
  const src = strip(read('server/suppliers/receipt.js'));
  const body = src.slice(src.indexOf('export async function correctReceipt('), src.indexOf('\n// ---------- okuma'));
  const order = [
    'if (!allowed(actor)) return FORBIDDEN;', 'parseCorrection(', 'db.$transaction(', 'supplier-order:', 'requestKey: p.requestKey', "code: 'STALE'",
    'correctionBalance(', "code: 'OVER_CORRECTABLE'", 'lockStock(', 'stockLevels(', "code: 'INSUFFICIENT_STOCK'", 'reopenStatus(',
    'supplierReceiptCorrection.create(', 'reverseSupplierStock(', 'supplierOrder.update(', 'notificationOutbox.create(', "action: 'SUPPLIER_RECEIPT_CORRECTED'",
  ];
  let at = -1;
  for (const s of order) {
    const i = body.indexOf(s, at + 1);
    assert.ok(i > at, `sıra: ${s}`);
    at = i;
  }
  // Orijinal kabul / satırları / belgesi hiç güncellenmez ya da silinmez
  assert.ok(!/supplierReceipt(Line)?\.(update|updateMany|delete|deleteMany|upsert)\(/.test(src), 'kabul değişmez');
  assert.ok(!/supplierReceiptCorrection(Line)?\.(update|updateMany|delete|deleteMany|upsert)\(/.test(src), 'düzeltme değişmez');
  // Stok writer: kilit, yeterlilik denetimi ve yazma sırası; eksi stok yok
  const stock = strip(read('server/profile/stock.js'));
  const w = stock.slice(stock.indexOf('export async function reverseSupplierStock('), stock.indexOf('\n}\n', stock.indexOf('export async function reverseSupplierStock(')));
  assert.ok(w.indexOf('lockStock(') < w.indexOf('stockLevels(') && w.indexOf("'INSUFFICIENT_STOCK'") < w.indexOf('stockMovement.createMany('));
  assert.match(w, /kind: 'KABUL_DUZELTME'/);
  assert.match(w, /qty: -l\.qty/);
  // Şema: değişmezlik tetikleyicisi her iki tabloda; düzeltme satırında fiyat yok
  const mig = read('prisma/migrations/20261016145538_supplier_receipt_correction/migration.sql');
  for (const t of ['SupplierReceiptCorrection', 'SupplierReceiptCorrectionLine']) assert.ok(mig.includes(`BEFORE UPDATE OR DELETE ON "${t}"`), t);
  assert.ok(!/DROP TABLE|DELETE FROM|UPDATE "|TRUNCATE/i.test(mig.replace(/BEFORE UPDATE OR DELETE/g, '').replace(/ON UPDATE CASCADE|ON DELETE RESTRICT/g, '')), 'göç yalnızca ekler');
  const schema = read('prisma/schema.prisma');
  const model = schema.slice(schema.indexOf('model SupplierReceiptCorrectionLine {'), schema.indexOf('}', schema.indexOf('model SupplierReceiptCorrectionLine {')));
  assert.ok(!/price|Price|amount|total|cost/i.test(model.replace(/\/\/.*$/gm, '')));
  // İşlem dosyası iki yetkiyi ister; belge yolu SUPPLIER_MANAGE + sipariş eşleşmesi
  assert.match(read('app/(panel)/siparisler/tedarik/actions.ts'), /export async function correctReceiptAction[\s\S]*?requirePermission\('SUPPLIER_MANAGE'\)[\s\S]*?userCan\(admin, 'STOCK_MANAGE'\)/);
  const route = read('app/(panel)/siparisler/tedarik/[id]/duzeltme/[correctionId]/route.ts');
  assert.match(route, /userCan\(user, 'SUPPLIER_MANAGE'\)/);
  assert.match(route, /pdf\.correction\.orderId !== id/);
  // Sayfa: düzeltme formu yalnızca STOCK_MANAGE ile; ekran sürümü ve tek kullanımlık anahtar
  const page = read('app/(panel)/siparisler/tedarik/[id]/page.tsx');
  assert.match(page, /const canCorrect = userCan\(admin, 'STOCK_MANAGE'\)/);
  assert.match(page, /<input type="hidden" name="v" value=\{rc\.version\} \/>/);
  // Tedarikçiye / müşteriye otomatik bildirim yok: düzeltme tedarikçi sipariş e-postası işi yazmaz, sipariş bildirimi
  // kuyruğuna müşteri olayı yazmaz; yalnızca depo e-postası işi (alıcılar: Ayarlar → depo alıcıları) ve kuyrukta kalmış sipariş
  // e-postasını gönderilmeden kapatma (skipQueuedOrderMail)
  assert.ok(!/notifyStaff|enqueueOutbox|sendBrandedMail|SUPPLIER_ORDER_EMAIL|SUPPLIER_EMAIL\b/.test(body), 'yalnızca depo e-postası işi');
  assert.equal((body.match(/notificationOutbox\.create\(/g) ?? []).length, 1);
  assert.match(body, /type: RECEIPT_EMAIL, payload: \{ correctionId/);
  assert.match(body, /reopen \? await skipQueuedOrderMail\(tx, order\.id\)/);
  const mailSrc = strip(read('server/suppliers/receipt-mail.js'));
  assert.match(mailSrc, /const \{ recipients \} = await getWarehouseSettings\(db\)/, 'alıcılar yalnızca depo alıcıları');
  assert.ok(!/supplier\.email|customer|Customer/.test(mailSrc), 'tedarikçi / müşteri adresi okunmaz');
  // E-postayı yalnızca işçi gönderir (aynı işlev); düzeltme işi kabul işinden ayırt edilir
  const mail = strip(read('server/suppliers/receipt-mail.js'));
  assert.ok(mail.includes('payload.correctionId') && mail.indexOf('sending: to') < mail.indexOf('sendBrandedMail(transport'));
  assert.match(strip(read('server/suppliers/receipt.js')), /payload\?\.receiptId === r\.id && !j\.payload\?\.correctionId/);
});

test('metinler: TR / RO düzeltme anahtarları ve hata kodları eşit; servis kodlarının hepsinin metni var', () => {
  const codes = ['FORBIDDEN', 'KEY', 'REASON', 'REASON_LONG', 'VERSION', 'QTY', 'EMPTY', 'NOT_FOUND', 'STALE', 'BAD_LINE', 'OVER_CORRECTABLE', 'INSUFFICIENT_STOCK', 'CONFLICT'];
  for (const d of [tr, ro]) {
    for (const c of codes) assert.ok(d.errors[`CORRECTION_${c}`], c);
    assert.ok(d.order.correction.title && d.order.correction.confirm && d.order.correction.reason && d.order.ok.corrected && d.order.ok.correctedReopened);
    assert.ok(d.order.history.action.SUPPLIER_RECEIPT_CORRECTED && d.order.history.action.SUPPLIER_RECEIPT_CORRECTION_EMAIL_SENT);
  }
});
