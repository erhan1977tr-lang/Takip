// Yöneticinin geri gönderme nedeni teklif tablosunun üstünde (FOL17 — server/orders/offer-return.js). Guard: yalnızca gösterim;
// not, rolüne göre süzülmüş olaydan okunur (eventsFor), yeni veri / yazma yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lastReturn } from '../server/orders/offer-return.js';
import { eventsFor } from '../server/orders/order-view.js';

const ev = (event, note = null, at = '2026-11-19T10:00:00Z') => ({ event, note, createdAt: at });

test('geri gönderilen taslak teklifte son olay geri gönderme ise neden döner', () => {
  const events = [ev('OFFER_RETURNED', 'Cam adedi yanlış: 2 olmalı', '2026-11-19T12:00:00Z'), ev('OFFER_SUBMITTED'), ev('CREATED')];
  assert.deepEqual(lastReturn(events, 'HAZIRLANIYOR'), { note: 'Cam adedi yanlış: 2 olmalı', at: '2026-11-19T12:00:00Z' });
});

test('akışta sonra başka olay varsa ya da teklif taslak değilse gösterilmez', () => {
  assert.equal(lastReturn([ev('OFFER_SUBMITTED'), ev('OFFER_RETURNED', 'x')], 'YONETIMDE'), null);
  assert.equal(lastReturn([ev('OFFER_SUBMITTED'), ev('OFFER_RETURNED', 'x')], 'HAZIRLANIYOR'), null);
  assert.equal(lastReturn([ev('OFFER_SENT'), ev('OFFER_RETURNED', 'x')], 'HAZIRLANIYOR'), null);
  assert.equal(lastReturn([ev('OFFER_RETURNED', 'x')], 'GONDERILDI'), null);
  assert.equal(lastReturn([ev('OFFER_RETURNED', null)], 'HAZIRLANIYOR'), null);
  assert.equal(lastReturn([], 'HAZIRLANIYOR'), null);
  assert.equal(lastReturn(undefined, 'HAZIRLANIYOR'), null);
});

test('akış dışı olaylar (PDF aktarımı, not, sandık) nedeni gizlemez', () => {
  const events = [ev('OFFER_PDF_IMPORTED', '99017'), ev('CRATES', '2'), ev('OFFER_RETURNED', 'neden')];
  assert.equal(lastReturn(events, 'HAZIRLANIYOR')?.note, 'neden');
});

test('görünürlük aynı kural: notu göremeyen rolde (çizim) olay notu süzülmüş gelir → uyarı yok; satışta neden görünür', () => {
  const events = [ev('OFFER_RETURNED', 'neden')];
  assert.equal(lastReturn(eventsFor('CIZIM', events), 'HAZIRLANIYOR'), null);
  assert.equal(lastReturn(eventsFor('SATIS', events), 'HAZIRLANIYOR')?.note, 'neden');
  assert.equal(lastReturn(eventsFor('MUSTERI', events), 'HAZIRLANIYOR'), null);
});

test('yapı: sayfa uyarıyı yalnızca düzenlenebilir (güncelleme değil) teklifte, sayfanın kendi olaylarından gösterir; iki dilde metin', async () => {
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /lastReturn\(order\.events, offer\.status\)/);
  assert.match(page, /editable && !updating && offer \? lastReturn/);
  const tr = (await import('../server/i18n/tr/order.js')).default;
  const ro = (await import('../server/i18n/ro/order.js')).default;
  assert.match(tr.offerReturned, /\{date\}/);
  assert.match(ro.offerReturned, /\{date\}/);
});
