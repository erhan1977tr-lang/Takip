// Sipariş Bilgileri altındaki cam tipleri (karar 269): yalnızca adlar, tekrarsız; sayfa kuralı yapısal olarak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { orderGlassTypes } from '../server/catalog/glass.js';

test('cam tipleri: yalnızca adlar, ilk görülme sırasıyla, aynı ad bir kez (boşluk / harf farkı dahil); ad yoksa yedek metin bir kez', () => {
  const items = [
    { glassName: '6.3.6 Temperli Lamine — Füme', glassNameRo: '6.3.6 Securizat — Fumuriu', camAdedi: 4 },
    { glassName: '6.3.6  temperli lamine — füme', glassNameRo: null, camAdedi: 2 },
    { glassName: '8mm Temperli', glassNameRo: '8mm Securizat', camAdedi: 0 },
    { glassName: null, glassNameRo: null },
    { glassName: '', glassNameRo: '' },
  ];
  assert.deepEqual(orderGlassTypes(items, 'tr', 'Cam'), ['6.3.6 Temperli Lamine — Füme', '8mm Temperli', 'Cam']);
  assert.deepEqual(orderGlassTypes(items.slice(0, 1), 'ro', 'Sticlă'), ['6.3.6 Securizat — Fumuriu']);
  assert.deepEqual(orderGlassTypes([], 'tr', 'Cam'), []);
  // Adet, ölçü, m², fiyat yok
  assert.ok(!orderGlassTypes(items, 'tr', 'Cam').some((n) => /×|\d+\s*adet|m²/.test(n)));
});

test('sayfa: cam tipleri Sipariş Bilgileri kartının içinde, çizim ekibi dışındaki rollere; adet yazılmaz', () => {
  const src = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/page.tsx', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('<OrderInfo'), src.indexOf('</OrderInfo>'));
  assert.match(block, /\{!drawerView && order\.items\.length > 0 && \(/);
  assert.match(block, /orderGlassTypes\(order\.items, locale, t\('order\.info\.glassFallback'\)\)/);
  assert.ok(!/camAdedi/.test(block), 'adet gösterilmez');
});
