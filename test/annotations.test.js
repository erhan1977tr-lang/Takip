// Revizyon talebindeki çizim üstü işaretler: sunucu doğrulaması.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ANNOTATIONS, cleanAnnotations } from '../server/orders/annotations.js';

test('işaretler: yalnızca bu sürümün dosyalarına; konumlar 0–1; tür ve biçim doğrulanır; metin kısaltılır', () => {
  const raw = [
    { fileId: 'f1', page: 1, type: 'pin', x: 0.25, y: 0.5, text: '  1100 mm olmalı  ' },
    { fileId: 'f1', page: 2, type: 'rect', x: 0.9, y: 0.9, w: 0.5, h: 0.5, text: '' },
    { fileId: 'f1', page: 1, type: 'free', x: 0.1, y: 0.1, points: [[0.1, 0.1], [0.2, 0.3], ['x', 1], [5, -2]], text: 'burası' },
    { fileId: 'f1', page: 1, type: 'text', x: 0.4, y: 0.4, text: 'A'.repeat(900) },
    { fileId: 'baska-siparisin-dosyasi', page: 1, type: 'pin', x: 0.1, y: 0.1, text: 'sızma' },
    { fileId: 'f1', page: 1, type: 'script', x: 0.1, y: 0.1 },
    { fileId: 'f1', page: 1, type: 'pin', x: 'NaN', y: 0.1 },
    { fileId: 'f1', page: 1, type: 'rect', x: 0.1, y: 0.1, w: 0, h: 0.2 },
    { fileId: 'f1', page: 1, type: 'free', x: 0.1, y: 0.1, points: [[0.1, 0.1]] },
    null, 'x',
  ];
  const out = cleanAnnotations(raw, ['f1']);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { fileId: 'f1', page: 1, type: 'pin', x: 0.25, y: 0.5, text: '1100 mm olmalı' });
  assert.deepEqual([out[1].w, out[1].h].map((v) => Math.round(v * 100) / 100), [0.1, 0.1], 'dikdörtgen sayfanın dışına taşmaz');
  assert.deepEqual(out[2].points, [[0.1, 0.1], [0.2, 0.3], [1, 0]], 'geçersiz nokta atılır, taşan nokta sınıra çekilir');
  assert.equal(out[3].text.length, 500);
  assert.deepEqual(cleanAnnotations(JSON.stringify(raw), ['f1']).length, 4, 'JSON metni de kabul edilir');
  assert.deepEqual(cleanAnnotations('{bozuk', ['f1']), []);
  assert.deepEqual(cleanAnnotations({ a: 1 }, ['f1']), []);
  assert.deepEqual(cleanAnnotations(raw, []), [], 'dosya yoksa işaret yok');
  const many = Array.from({ length: MAX_ANNOTATIONS + 50 }, () => ({ fileId: 'f1', page: 1, type: 'pin', x: 0.5, y: 0.5 }));
  assert.equal(cleanAnnotations(many, ['f1']).length, MAX_ANNOTATIONS);
});
