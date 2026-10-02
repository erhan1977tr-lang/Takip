// Çizim gönderimi için "Kontrol Et" kanıtı (server/orders/review.js) ve müşterinin açabileceği dosya kuralı (karar 84).
import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_TTL_MS, reviewToken, verifyReviewToken } from '../server/orders/review.js';
import { isViewable } from '../server/orders/rules.js';

const secret = 's'.repeat(40);
const files = [{ id: 'f1' }, { id: 'f2' }];
const base = { secret, drawingId: 'd1', userId: 'u1', files };
const NOW = Date.UTC(2026, 9, 2, 10, 0, 0);

test('kontrol kanıtı: aynı taslak + aynı kullanıcı + aynı dosyalar için geçerli', () => {
  const token = reviewToken({ ...base, now: NOW });
  assert.ok(verifyReviewToken(token, { ...base, now: NOW + 60_000 }));
  assert.ok(verifyReviewToken(token, { ...base, files: [{ id: 'f2' }, { id: 'f1' }], now: NOW }), 'dosya sırası önemli değil');
});

test('kontrol kanıtı: başka kullanıcı, başka taslak, değişen dosyalar, başka gizli anahtar → geçersiz', () => {
  const token = reviewToken({ ...base, now: NOW });
  assert.ok(!verifyReviewToken(token, { ...base, userId: 'u2', now: NOW }), 'kontrol eden kişi göndermeli');
  assert.ok(!verifyReviewToken(token, { ...base, drawingId: 'd2', now: NOW }));
  assert.ok(!verifyReviewToken(token, { ...base, files: [...files, { id: 'f3' }], now: NOW }), 'kontrolden sonra dosya eklendi');
  assert.ok(!verifyReviewToken(token, { ...base, files: [{ id: 'f1' }], now: NOW }), 'kontrolden sonra dosya çıkarıldı');
  assert.ok(!verifyReviewToken(token, { ...base, secret: 'x'.repeat(40), now: NOW }));
});

test('kontrol kanıtı: süresi dolan, gelecekten gelen, bozuk ya da boş kanıt → geçersiz', () => {
  const token = reviewToken({ ...base, now: NOW });
  assert.ok(verifyReviewToken(token, { ...base, now: NOW + REVIEW_TTL_MS - 1000 }));
  assert.ok(!verifyReviewToken(token, { ...base, now: NOW + REVIEW_TTL_MS + 1000 }), '2 saatten eski kontrol');
  assert.ok(!verifyReviewToken(token, { ...base, now: NOW - 5 * 60_000 }), 'gelecek tarihli');
  const [ts, mac] = token.split('.');
  assert.ok(!verifyReviewToken(`${Number(ts) + 1}.${mac}`, { ...base, now: NOW }), 'zaman değiştirilemez');
  assert.ok(!verifyReviewToken(`${ts}.${mac.slice(0, -2)}xx`, { ...base, now: NOW }));
  for (const bad of [undefined, null, '', 'x', `${ts}`, `${ts}.${mac}.fazla`, 12345, {}]) {
    assert.ok(!verifyReviewToken(bad, { ...base, now: NOW }), String(bad));
  }
  assert.ok(!verifyReviewToken(token, { ...base, secret: '', now: NOW }), 'gizli anahtar yoksa hiçbir kanıt geçmez');
});

test('müşterinin ekranda açabileceği dosya: PDF, JPG, PNG; teknik dosyalar (DWG, DXF, STEP…) değil', () => {
  for (const ok of ['plan.pdf', 'PLAN.PDF', 'a.b.jpg', 'foto.jpeg', 'detay.PNG']) assert.ok(isViewable(ok), ok);
  for (const no of ['plan.dwg', 'plan.dxf', 'parca.step', 'parca.stp', 'liste.xlsx', 'arsiv.zip', 'pdf', 'plan.pdf.dwg', '', null, undefined]) assert.ok(!isViewable(no), String(no));
});
