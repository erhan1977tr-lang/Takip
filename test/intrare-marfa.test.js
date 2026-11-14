// 4.2.20 (karar 320) — INTRAREA MARFĂ formu: ürün sahibinin Excel şablonu (Intrare_Depozit.xlsx) mal kabulündeki adetlerle
// doldurulur; ağırlık = şablonun katsayısı × adet (kapaklarda ağırlık yok), PALETI / CUTII kabulde girilen sayılar; düzeltme
// aynı formun "REV.n — CORECȚIE" hâli. Saf kurallar, PDF metni, gömülü görseller, dosya adları ve form alanları.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { IM_ROWS, IM_SECTIONS, fmtKg, gramsOf, imChanges, imDocNo, intrareMarfaData, parseCount } from '../server/suppliers/intrare-marfa.js';
import { intrareMarfaPdf } from '../server/pdf/intrare-marfa.js';
import { IM_IMAGE_KEYS, imImage } from '../server/pdf/intrare-marfa-images.js';
import { imagesModule } from '../scripts/intrare-marfa-images.mjs';
import { correctionFileName, receiptFileName } from '../server/suppliers/receipt-mail.js';
import { parseReceipt } from '../server/suppliers/receipt-rules.js';
import { FONTS } from '../server/pdf/fonts.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
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

test('şablon: Excel sırası, dört bölüm, katsayılar; kapaklarda (CAPACE) ağırlık yok; kodlar tekil; görseller gömülü', () => {
  assert.deepEqual(IM_SECTIONS.map((s) => s.key), ['GARNITURI', 'PLASTICE', 'PROFILE ALUMINIU', 'ACCESORII']);
  assert.equal(new Set(IM_ROWS.map((r) => r.code)).size, IM_ROWS.length);
  assert.deepEqual(IM_ROWS.filter((r) => r.kg == null).map((r) => r.code), ['CAPACE-PROFILE-7016', 'CAPACE-PROFILE-ELX']);
  const kg = Object.fromEntries(IM_ROWS.map((r) => [r.code, r.kg]));
  assert.deepEqual([kg.GK15, kg['PANA-115-12'], kg['MR23-7016'], kg['FBL115-7016'], kg['FBL90-ELX'], kg.SPIGOTI, kg['COLT-90-16']], ['10', '0.73', '2.1', '25', '22', '0.68', '0.026']);
  for (const r of IM_ROWS) if (r.image) assert.ok(IM_IMAGE_KEYS.includes(r.image) && imImage(r.image)?.subarray(1, 4).toString() === 'PNG', r.image);
  assert.equal(imImage('constructor'), null);
  // Gömülü modül dosyalarla aynı (elle düzenlenmedi): node scripts/intrare-marfa-images.mjs
  assert.equal(read('server/pdf/intrare-marfa-images.js'), imagesModule());
});

test('gram hesabı tam sayıyla: kg metni → gram; biçim Excel gibi (ondalık virgül, sondaki sıfır yok)', () => {
  assert.deepEqual(['10', '0.73', '2.1', '0.026', '25', 'x', '1.2345', ''].map(gramsOf), [10000, 730, 2100, 26, 25000, null, null, null]);
  assert.deepEqual([4825000, 3650, 185, 0, 1000, 26].map(fmtKg), ['4825', '3,65', '0,185', '0', '1', '0,026']);
});

test('formun verisi: adetler şablon satırına, ağırlık = katsayı × adet; aynı kod toplanır; şablonda olmayan ürün ağırlıksız "ALTE PRODUSE"', () => {
  const d = intrareMarfaData([
    { code: 'GK15', name: 'Garnitura', qty: 13, unit: 'cutii' },
    { code: 'FBL115-7016', name: 'FBL115', qty: 100, unit: 'bare' },
    { code: 'FBL115-7016', name: 'FBL115', qty: 61, unit: 'bare' },
    { code: 'COLT-90-16', name: 'Colt', qty: 50, unit: 'bucăți' },
    { code: 'CAPACE-PROFILE-7016', name: 'Capace', qty: 40, unit: 'bucăți' },
    { code: 'XYZ-1', name: 'Produs nou', qty: 7, unit: 'bucăți' },
    { code: 'PANA-90-12', name: 'Pana', qty: 0, unit: 'pungi' },
  ]);
  const rows = Object.fromEntries(d.sections.flatMap((s) => s.rows).map((r) => [r.code, r]));
  assert.equal(rows.GK15.qty, 13);
  assert.equal(rows.GK15.grams, 130000);
  assert.equal(rows['FBL115-7016'].qty, 161);
  assert.equal(rows['FBL115-7016'].grams, 161 * 25000);
  assert.equal(rows['COLT-90-16'].grams, 1300);
  assert.equal(rows['CAPACE-PROFILE-7016'].qty, 40, 'kapak adedi yazılır');
  assert.equal(rows['CAPACE-PROFILE-7016'].hasWeight, false, 'kapakta ağırlık yok');
  assert.equal(rows['CAPACE-PROFILE-7016'].grams, null);
  assert.equal(rows['PANA-90-12'].qty, null, 'adet 0 → boş');
  assert.equal(rows.AD45.qty, null);
  assert.equal(d.totalGrams, 130000 + 161 * 25000 + 1300);
  assert.equal(fmtKg(d.totalGrams), '4156,3');
  assert.deepEqual(d.others, [{ code: 'XYZ-1', name: 'Produs nou', qty: 7, unit: 'bucăți' }]);
  assert.equal(intrareMarfaData([]).totalGrams, 0);
});

test('palet / kutu alanı: boş → girilmedi; 0 … 99 999 tam sayı; geçersiz reddedilir (kabul formu PALLETS / BOXES)', () => {
  assert.deepEqual(['', '  ', null, undefined, '0', '12', ' 7 ', '99999'].map(parseCount), [null, null, null, null, 0, 12, 7, 99999]);
  for (const bad of ['-1', '1.5', '1e3', 'abc', '100000', '2 3']) assert.equal(parseCount(bad), undefined, bad);
  const base = { requestKey: 'k'.repeat(24), receivedOn: '2026-11-14', quantities: { a: '5' } };
  const ok = parseReceipt({ ...base, pallets: '3', boxes: '' }, { today: '2026-11-14' });
  assert.equal(ok.ok, true);
  assert.equal(/** @type {any} */ (ok).pallets, 3);
  assert.equal(/** @type {any} */ (ok).boxes, null);
  assert.deepEqual(parseReceipt({ ...base, pallets: '-1' }, { today: '2026-11-14' }), { ok: false, code: 'PALLETS' });
  assert.deepEqual(parseReceipt({ ...base, boxes: '1,5' }, { today: '2026-11-14' }), { ok: false, code: 'BOXES' });
});

test('düzeltme (REV.n): değişen ürünler önceki → yeni adet; belge no ve dosya adı Romence', () => {
  assert.deepEqual(imChanges(
    [{ code: 'GK15', qty: 13 }, { code: 'FBL115-7016', qty: 161 }, { code: 'AD45', qty: 4 }],
    [{ code: 'GK15', qty: 13 }, { code: 'FBL115-7016', qty: 150 }, { code: 'AD45', qty: 0 }],
  ), [{ code: 'FBL115-7016', from: 161, to: 150 }, { code: 'AD45', from: 4, to: 0 }]);
  assert.equal(imDocNo('TS-2026-001', 1), 'TS-2026-001-1');
  assert.equal(imDocNo('TS-2026-001', 1, 1), 'TS-2026-001-1 REV.1');
  assert.equal(receiptFileName('TS-2026-001', 1), 'Intrare-Marfa-TS-2026-001-1.pdf');
  assert.equal(correctionFileName('TS-2026-001', 1, 1), 'Intrare-Marfa-TS-2026-001-1-REV.1.pdf');
  assert.equal(correctionFileName('TS-2026-001', 2, 3), 'Intrare-Marfa-TS-2026-001-2-REV.3.pdf');
});

const DOC = {
  docNo: 'TS-2026-001-1', orderNo: 'TS-2026-001', supplierName: 'Alüminyum Tedarik', receivedOn: new Date('2026-11-14T00:00:00Z'), reference: 'AVIZ 4411',
  pallets: 2, boxes: 15,
  lines: [
    { code: 'GK15', name: 'Garnitura EPDM GK15', qty: 13, unit: 'cutii' },
    { code: 'FBL115-7016', name: 'Profil FBL115 7016', qty: 161, unit: 'bare' },
    { code: 'CAPACE-PROFILE-ELX', name: 'Capace profile ELX', qty: 40, unit: 'bucăți' },
    { code: 'XYZ-1', name: 'Produs nou', qty: 7, unit: 'bucăți' },
  ],
};

test('INTRAREA MARFĂ PDF: Romence form, logo, belge no, furnizor, palet / kutu, adetler, ağırlıklar, toplam; fiyat yok', () => {
  const pdf = intrareMarfaPdf(DOC);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(pdf).join('\n');
  for (const s of ['INTRAREA MARFĂ', 'NR. :', 'TS-2026-001-1', 'FURNIZOR :', 'Alüminyum Tedarik', 'DATA :', '14.11.2026', 'PALETI :', 'CUTII :', 'COMANDA FURNIZOR :', 'AVIZ 4411',
    'GARNITURI', 'PLASTICE', 'PROFILE ALUMINIU', 'ACCESORII', 'GARNITURA EPDM - GK15', 'FBL115 - 7016', 'CAPACE PROFILE - ELX', 'TOTAL GREUTATE :', '4155 kg', 'ALTE PRODUSE', 'XYZ-1 — Produs nou']) {
    assert.ok(text.includes(s), s);
  }
  const lines = pdfText(pdf);
  for (const v of ['2', '15', '13', '130', '161', '4025', '40']) assert.ok(lines.includes(v), `değer ${v}`);
  for (const s of ['EUR', 'RON', 'Preț', 'Pret', 'Cost', 'Profit', 'REV.', 'CORECȚIE']) assert.ok(!text.includes(s), s);
  assert.ok(pdf.includes('/Im1'), 'logo gömülü');
  // Aynı veri → aynı belge (yeniden indirme aynı içeriği verir)
  assert.equal(intrareMarfaPdf(DOC).length, pdf.length);
  // Palet / kutu girilmediyse boş kalır
  const empty = pdfText(intrareMarfaPdf({ ...DOC, pallets: null, boxes: null, reference: null }));
  assert.ok(!empty.includes('15') && empty.includes('—'));
});

test('INTRAREA MARFĂ REV.n: başlıkta REV ve CORECȚIE, önceki belge no, gerekçe, değişen satırlar; güncel adetler ve toplam', () => {
  const rev = intrareMarfaPdf({
    ...DOC, docNo: 'TS-2026-001-1 REV.1',
    lines: DOC.lines.map((l) => (l.code === 'FBL115-7016' ? { ...l, qty: 150 } : l)),
    revision: { no: 1, createdAt: new Date('2026-11-15T09:00:00Z'), reason: 'Avizde 161, gerçekte 150', baseDocNo: 'TS-2026-001-1', changes: [{ code: 'FBL115-7016', from: 161, to: 150, unit: 'bare' }] },
  });
  const text = pdfText(rev).join('\n');
  for (const s of ['INTRAREA MARFĂ — REV.1', 'CORECȚIE la TS-2026-001-1', 'TS-2026-001-1 REV.1', 'MOTIV: Avizde 161, gerçekte 150', 'MODIFICĂRI FAȚĂ DE TS-2026-001-1: FBL115-7016: 161 -> 150 bare', '15.11.2026', '3880 kg']) {
    assert.ok(text.includes(s), s);
  }
  assert.ok(pdfText(rev).includes('150'));
});

test('yapı: kabul formunda PALETI / CUTII alanları; belge ve e-posta aynı üreticiden, aynı dosya adıyla; eski üretici kaldırıldı', () => {
  const page = read('app/(panel)/siparisler/tedarik/[id]/page.tsx');
  assert.ok(page.includes('name="pallets"') && page.includes('name="boxes"'));
  const action = read('app/(panel)/siparisler/tedarik/actions.ts');
  assert.ok(action.includes("pallets: fd.get('pallets'), boxes: fd.get('boxes')"));
  const mail = read('server/suppliers/receipt-mail.js');
  assert.ok(mail.includes("from '../pdf/intrare-marfa.js'") && !mail.includes('goods-receipt.js\';\nimport { goodsReceiptPdf'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'pdf', 'goods-receipt.js')));
  for (const f of ['app/(panel)/siparisler/tedarik/[id]/kabul/[receiptId]/route.ts', 'app/(panel)/siparisler/tedarik/[id]/duzeltme/[correctionId]/route.ts']) {
    assert.ok(read(f).includes('downloadHeaders(pdf.name,'), `${f}: e-posta ekiyle aynı (Romence) dosya adı`);
  }
  // Kabul satırı değişmez: palet / kutu yalnızca kabul oluşturulurken yazılır
  assert.match(read('server/suppliers/receipt.js'), /pallets: p\.pallets, boxes: p\.boxes, requestKey: p\.requestKey/);
});
