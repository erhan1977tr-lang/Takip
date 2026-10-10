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
  assert.deepEqual(out[0], { id: 'm1', no: 1, fileId: 'f1', page: 1, type: 'pin', x: 0.25, y: 0.5, text: '1100 mm olmalı' });
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

test('P5 (karar 244): kalıcı kimlik ve numara — geçerli ve tekil olan korunur; eksik / bozuk / yinelenen sırayla verilir; eski kayıtta sıra', async () => {
  const { revisionNoteWithMarks } = await import('../server/orders/revision-note.js');
  const pin = (extra) => ({ fileId: 'f1', page: 1, type: 'pin', x: 0.5, y: 0.5, text: '', ...extra });
  // Müşteri #2'yi sildi: #1 ve #3 kalır, numaralar değişmez
  const kept = cleanAnnotations([pin({ id: 'a1', no: 1, text: 'sol üst' }), pin({ id: 'a3', no: 3, text: 'sağ alt' })], ['f1']);
  assert.deepEqual(kept.map((a) => [a.id, a.no, a.text]), [['a1', 1, 'sol üst'], ['a3', 3, 'sağ alt']]);
  // Nottaki madde işaretin KALICI numarasıyla: "#3", sıradaki "#2" değil — açıklama yanlış işarete bağlanamaz
  assert.deepEqual(revisionNoteWithMarks(['ölçü 1100'], kept), { ok: true, text: '1. ölçü 1100\n2. #1: sol üst\n3. #3: sağ alt', items: ['ölçü 1100', '#1: sol üst', '#3: sağ alt'] });
  // Sıra değişse de numara işarette kalır
  const swapped = cleanAnnotations([pin({ id: 'a3', no: 3, text: 'sağ alt' }), pin({ id: 'a1', no: 1, text: 'sol üst' })], ['f1']);
  assert.equal(revisionNoteWithMarks([], swapped).text, '1. #3: sağ alt\n2. #1: sol üst');
  // Başka sürümün dosyasındaki işaret atılır; kalanların numarası değişmez
  const other = cleanAnnotations([pin({ id: 'x', no: 1, fileId: 'eski-surum', text: 'eski' }), pin({ id: 'y', no: 2, text: 'yeni' })], ['f1']);
  assert.deepEqual(other.map((a) => [a.id, a.no]), [['y', 2]]);
  assert.equal(revisionNoteWithMarks([], other).text, '1. #2: yeni');
  // Yinelenen / bozuk kimlik ve numara: ilki korunur, sonrakilere en büyük numaradan sonra sırayla
  const dup = cleanAnnotations([pin({ id: 'a', no: 5 }), pin({ id: 'a', no: 5 }), pin({ id: '<script>', no: 0 }), pin({ no: 1.5 })], ['f1']);
  assert.deepEqual(dup.map((a) => [a.id, a.no]), [['a', 5], ['m1', 6], ['m2', 7], ['m3', 8]]);
  // Eski (numarasız) kayıt: listedeki sıra — önceki davranış
  const legacy = cleanAnnotations([pin({ text: 'bir' }), pin({ text: 'iki' })], ['f1']);
  assert.deepEqual(legacy.map((a) => a.no), [1, 2]);
  assert.equal(revisionNoteWithMarks([], legacy).text, '1. #1: bir\n2. #2: iki');
  // Numara üst sınırı aşılırsa kabul edilmez, sıradan verilir
  assert.deepEqual(cleanAnnotations([pin({ no: 5000 })], ['f1']).map((a) => a.no), [1]);
});

test('P5 (karar 244): taslakta verilmiş en büyük numara taslakla saklanır — sayfa yenilense de silinen numara yeniden verilmez', async () => {
  const fs = await import('node:fs');
  const form = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/cizim/[drawingId]/RevisionForm.tsx', import.meta.url), 'utf8');
  assert.ok(form.includes('JSON.stringify({ items, annotations, used })'), 'sayaç taslakla saklanır');
  assert.ok(form.includes('numberFrom={used}'), 'görüntüleyici yeni numarayı sayaçtan sonra verir');
  const viewer = fs.readFileSync(new URL('../components/DrawingViewer.tsx', import.meta.url), 'utf8');
  assert.ok(viewer.includes('Math.max(top.current, numberFrom, ...annotations.map((x, i) => markNo(x, i))) + 1'));
});
