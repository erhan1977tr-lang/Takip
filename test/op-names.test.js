// CNC / delik işlem adlarının Romence gösterimi (karar 315 — server/orders/op-names.js). Yalnızca gösterim: kayıtlı açıklama,
// Türkçe ekran, cam satırları, düzenleyici ve tutarlar değişmez. Guard: bilinen adlar, yarım çeviri yok, belge / ekran
// kullanıcıları.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldTr, lineDisplayName, opNameRo } from '../server/orders/op-names.js';
import { offerExportData } from '../server/orders/offer-export.js';

test('ürün sahibinin örnekleri: "Kose Yuvarlama", "CNC KÜÇÜK DELİK" Romence', () => {
  assert.equal(opNameRo('Kose Yuvarlama'), 'Rotunjire colțuri');
  assert.equal(opNameRo('KÖŞE YUVARLAMA'), 'Rotunjire colțuri');
  assert.equal(opNameRo('CNC KÜÇÜK DELİK'), 'Gaură mică CNC');
  assert.equal(opNameRo('cnc küçük delik'), 'Gaură mică CNC');
  assert.equal(opNameRo('CNC BÜYÜK DELİK'), 'Gaură mare CNC');
  assert.equal(opNameRo('CNC İŞLEMİ'), 'Prelucrare CNC');
  assert.equal(opNameRo('Delik'), 'Gaură');
  assert.equal(opNameRo('2 delik Ø12'), '2 găuri Ø12');
  assert.equal(opNameRo('Delik – Ø 12'), 'Gaură – Ø 12');
  assert.equal(opNameRo('RODAJ'), 'Șlefuire margini');
  assert.equal(opNameRo('KÖŞE YUVARLAMA R10'), 'Rotunjire colțuri R10');
});

test('tanınmayan kelime → çeviri yok (özgün metin gösterilir); yalnızca "CNC" çevrilmez', () => {
  for (const s of ['Kenarlar rodajlı olsun', 'abc delik', 'CNC', '', null, undefined, '12', 'Müşteri notu']) assert.equal(opNameRo(s), null, String(s));
  assert.equal(foldTr('Köşe Çığ İşlemi'), 'KOSE CIG ISLEMI');
});

test('gösterim adı: Türkçe ekranda her zaman özgün; Romencede cam satırı descriptionRo, işlem satırı sözlük', () => {
  const op = { kind: 'CNC', description: 'Kose Yuvarlama', descriptionRo: null };
  assert.equal(lineDisplayName(op, 'tr'), 'Kose Yuvarlama');
  assert.equal(lineDisplayName(op, 'ro'), 'Rotunjire colțuri');
  assert.equal(lineDisplayName({ ...op, descriptionRo: 'Elle verilen' }, 'ro'), 'Elle verilen', 'kayıtlı Romence ad önce');
  assert.equal(lineDisplayName({ kind: 'DELIK', description: 'Özel bir şey' }, 'ro'), 'Özel bir şey', 'çevrilemeyen özgün kalır');
  // Cam satırı: eski davranış (sözlük uygulanmaz)
  assert.equal(lineDisplayName({ kind: 'CAM', description: 'DELİK', descriptionRo: null }, 'ro'), 'DELİK');
  assert.equal(lineDisplayName({ kind: 'CAM', description: '10 MM TEMPER', descriptionRo: 'Securizat 10 mm' }, 'ro'), 'Securizat 10 mm');
  assert.equal(lineDisplayName({ kind: 'CAM', description: '10 MM TEMPER', descriptionRo: 'Securizat 10 mm' }, 'tr'), '10 MM TEMPER');
});

test('teklif PDF / Excel / Tekliflerim / yükleme dökümü (offerExportData): Romence işlem adı; Türkçe ve tutarlar aynı', () => {
  const lines = [
    { kind: 'CAM', unit: 'm2', description: 'STICLA', descriptionRo: 'Sticlă securizată', enMm: 1265, boyMm: 1420, adet: 1, unitPrice: '89.35' },
    { kind: 'CNC', unit: 'adet', description: 'Kose Yuvarlama', descriptionRo: null, adet: 2, unitPrice: '2.5' },
    { kind: 'DELIK', unit: 'adet', description: 'CNC KÜÇÜK DELİK', descriptionRo: null, adet: 4, unitPrice: '2.5' },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', descriptionRo: null, adet: 1, unitPrice: '2.5' },
    { kind: 'CNC', unit: 'adet', description: 'Fabrika özel kod 7', descriptionRo: null, adet: 1, unitPrice: '1' },
  ];
  const kinds = { ro: { CNC: 'CNC', DELIK: 'Găuri' }, tr: { CNC: 'CNC', DELIK: 'Delik' } };
  const ro = offerExportData({ lines, price: (l) => l.unitPrice, locale: 'ro', kindLabel: (k) => kinds.ro[k] });
  const tr = offerExportData({ lines, price: (l) => l.unitPrice, locale: 'tr', kindLabel: (k) => kinds.tr[k] });
  assert.deepEqual(ro.rows.map((r) => r.desc), ['Sticlă securizată', 'CNC – Rotunjire colțuri', 'Găuri – Gaură mică CNC', 'Găuri', 'CNC – Fabrika özel kod 7']);
  assert.deepEqual(tr.rows.map((r) => r.desc), ['STICLA', 'CNC – Kose Yuvarlama', 'Delik – CNC KÜÇÜK DELİK', 'Delik', 'CNC – Fabrika özel kod 7']);
  // Tutarlar ve satır yapısı dilden bağımsız
  const rest = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'desc'));
  assert.deepEqual(ro.rows.map(rest), tr.rows.map(rest));
  assert.equal(ro.total, tr.total);
  // Kayıtlı satırlar değişmedi (yalnızca gösterim)
  assert.equal(lines[1].description, 'Kose Yuvarlama');
  assert.equal(lines[1].descriptionRo, null);
});

test('yapı: müşteri sipariş sayfasının teklif tablosu sözlüğü kullanır; teklif düzenleyicisine giden metin değişmez', () => {
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes("import { lineDisplayName } from '@/server/orders/op-names.js';"));
  assert.ok(/: lineDisplayName\(l, locale\);/.test(page), 'teklif görünümü');
  // Düzenleyicinin başlangıç değeri eskisi gibi (çeviri kayda yazılmaz)
  assert.ok(page.includes("description: locale === 'ro' && l.descriptionRo ? l.descriptionRo : l.description,"));
  const exp = fs.readFileSync(new URL('../server/orders/offer-export.js', import.meta.url), 'utf8');
  assert.ok(exp.includes('const own = lineDisplayName(l, locale);'));
  // Sözlük modülü yalnızca okur
  const src = fs.readFileSync(new URL('../server/orders/op-names.js', import.meta.url), 'utf8');
  assert.ok(!/import /.test(src), 'bağımlılık yok (tarayıcı ve sunucuda aynı)');
});
