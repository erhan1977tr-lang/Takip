// P5 — müşterinin sipariş listesi (karar 243): arşivde yalnızca kapanmış ve onaylı yüklemeyle EKSİKSİZ yüklenmiş siparişler;
// yüklenmemiş, gecikmiş ve kalanı olan sipariş Active'de; Active tahmini yükleme gününe göre artan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { customerBucket, customerOrderCompare, customerStatusWhere, fullyLoaded } from '../server/orders/customer-list.js';
import { notShipWindowWhere, shipWindowWhere } from '../server/orders/ship-window.js';

const g = { description: 'Temper', enMm: 1000, boyMm: 1000, kind: 'CAM', unit: 'm2' };
const item = (status, quantity, extra = {}) => ({ ...g, confirmationId: 'c1', offerLineId: 'l1', replanId: null, revision: 0, status, quantity, confirmation: { shipDay: new Date('2026-10-01T00:00:00Z') }, ...extra });
const ev = (items, { replans = [], sent = 3, compensated = new Map() } = {}) => ({ items, replans, compensated, sent: [{ ...g, adet: sent }], lastShip: null });
const glass = (status = 'URETIMDE', extra = {}) => ({ orderTypeCode: 'GLASS_ORDER', status, onHold: false, removedAt: null, ...extra });

test('arşiv: kapanmış durum (arşivlendi / iptal) ve onaylı yüklemeyle eksiksiz yüklenmiş cam siparişi', () => {
  assert.equal(customerBucket(glass('ARSIVLENDI'), undefined), 'archive');
  assert.equal(customerBucket(glass('IPTAL'), undefined), 'archive');
  assert.equal(customerBucket({ orderTypeCode: 'PROFILE_ORDER', status: 'ARSIVLENDI', onHold: false }, undefined), 'archive', 'profilde faturalandı');
  assert.equal(customerBucket(glass('URETIMDE'), ev([item('LOADED', 3)])), 'archive', 'durum üretimde de olsa onaylı tam yükleme arşive');
  assert.equal(customerBucket(glass('YUKLENDI'), ev([item('LOADED', 3)])), 'archive');
});

test('Active: yüklenmemiş (gecikmiş dahil), yalnızca "Yüklendi" düğmesi (onay yok), kısmi yükleme ve kalanı olan sipariş', () => {
  // Tarihi geçmiş ama yüklenmemiş: kayıt yok → Active (planlanan tarih kanıt değil)
  assert.equal(customerBucket(glass('URETIMDE', { estimatedShipDate: new Date('2020-01-01') }), undefined), 'active');
  assert.equal(customerBucket(glass('HAZIRLANIYOR'), undefined), 'active');
  // "Yüklendi" kişinin düğmesi ama onaylı yükleme yok
  assert.equal(customerBucket(glass('YUKLENDI'), undefined), 'active');
  assert.equal(customerBucket(glass('YUKLENDI'), ev([])), 'active');
  // Kısmi: 3'ün 2'si yüklendi, 1 yüklenmedi (açık kalan)
  assert.equal(customerBucket(glass(), ev([item('LOADED', 2), item('NOT_LOADED', 1)])), 'active');
  // Kalan ileri bir güne aktarıldı ama henüz yüklenmedi
  const replan = { status: 'ACTIVE', quantity: 1, sourceItem: { confirmationId: 'c1', offerLineId: 'l1', replanId: null } };
  assert.equal(customerBucket(glass(), ev([item('LOADED', 2), item('NOT_LOADED', 1)], { replans: [replan] })), 'active');
  // Kalan aktarımla sonra yüklendi → eksiksiz
  const done = { ...replan, status: 'CONFIRMED' };
  const later = item('LOADED', 1, { confirmationId: 'c2', offerLineId: 'l1', replanId: 'r1', confirmation: { shipDay: new Date('2026-10-08T00:00:00Z') } });
  assert.equal(customerBucket(glass(), ev([item('LOADED', 2), item('NOT_LOADED', 1), later], { replans: [done] })), 'archive');
  // Teklifte onaylardakinden fazla cam (onaydan sonra eklenmiş): yüklenmemiş sayılır
  assert.equal(customerBucket(glass(), ev([item('LOADED', 3)], { sent: 5 })), 'active');
  // Beklemedeki sipariş Active'de kalır
  assert.equal(customerBucket(glass('URETIMDE', { onHold: true }), ev([item('LOADED', 3)])), 'active');
  // Profil siparişi yükleme onayına bakılmadan durumuyla
  assert.equal(fullyLoaded({ orderTypeCode: 'PROFILE_ORDER', status: 'URETIMDE', onHold: false }, ev([item('LOADED', 3)])), false);
});

test('sıra: Active tahmini yükleme gününe göre artan (tarihsiz sonda, profilde teslim günü); arşiv azalan', () => {
  const o = (orderNo, day, extra = {}) => ({ orderNo, estimatedShipDate: day ? new Date(`${day}T12:00:00Z`) : null, createdAt: new Date('2026-09-01T00:00:00Z'), ...extra });
  const list = [
    o('A3', '2026-10-20'), o('A1', '2026-10-05'), o('X', null), o('P1', null, { profile: { pickupDate: new Date('2026-10-10T00:00:00Z') } }),
    o('A0', '2026-09-28'), // gecikmiş (geçmiş gün) en üstte
    o('A2', '2026-10-05', { createdAt: new Date('2026-09-10T00:00:00Z') }), // aynı gün: yeni olan önce
  ];
  assert.deepEqual([...list].sort(customerOrderCompare('active')).map((x) => x.orderNo), ['A0', 'A2', 'A1', 'P1', 'A3', 'X']);
  assert.deepEqual([...list].sort(customerOrderCompare('archive')).map((x) => x.orderNo), ['A3', 'P1', 'A2', 'A1', 'A0', 'X']);
});

test('sorgu koşulu: Active kapanmamış durumlar; arşiv kapanmış + onaylı yükleme kaydı olan açık cam siparişi; kapsam sayfada orderScope', () => {
  // Tarih kuralı (karar 316): Active koşulu kapanmamış durum + "tahmini günü 4 gün geçmemiş" (ship-window.js)
  const now = new Date('2026-11-14T10:00:00Z');
  const act = customerStatusWhere('active', now);
  assert.deepEqual(act.AND[0], { status: { notIn: ['ARSIVLENDI', 'IPTAL'] } });
  assert.deepEqual(act.AND[1], notShipWindowWhere(now));
  const a = customerStatusWhere('archive', now);
  assert.deepEqual(a.OR[0], { status: { in: ['ARSIVLENDI', 'IPTAL'] } });
  assert.deepEqual(a.OR[1], { orderTypeCode: 'GLASS_ORDER', status: { in: ['URETIMDE', 'YUKLENDI'] }, loadedItems: { some: {} } });
  assert.deepEqual(a.OR[2], shipWindowWhere(now));
  // Yapı: müşteri listesi kendi firmasının kapsamıyla (orderScope) AND'lenir; son ayrım partitionCustomerOrders'ta
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/page.tsx', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('async function CustomerOrders'));
  assert.ok(fn.includes('where: { AND: [orderScope(user), searchWhere(sp.q), customerStatusWhere(bucket)'), 'firma kapsamı korunur');
  assert.ok(fn.includes('await partitionCustomerOrders(db, found, bucket)'), 'tek ayrım kuralı');
  assert.ok(!/status: archive \? \{ in: CLOSED/.test(fn), 'eski durum tabanlı ayrım yok');
});

test('tarih kuralı (karar 316): tahmini günü 4 gün geçen üretimdeki / yüklenmiş cam siparişi arşiv bölümünde; diğerleri değişmez', () => {
  const now = new Date('2026-11-14T10:00:00Z'); // Bükreş 14.11 → kesim günü 10.11
  const day = (d) => new Date(`${d}T12:00:00Z`);
  // 4 gün geçti (10.11 ve öncesi) → arşiv; kayıt / onay gerekmez
  assert.equal(customerBucket(glass('URETIMDE', { estimatedShipDate: day('2026-11-10') }), undefined, now), 'archive');
  assert.equal(customerBucket(glass('YUKLENDI', { estimatedShipDate: day('2026-11-01') }), undefined, now), 'archive');
  assert.equal(customerBucket(glass('URETIMDE', { estimatedShipDate: day('2020-01-01') }), undefined, now), 'archive', 'geçmiş siparişler de');
  // Henüz 4 gün geçmedi (11.11 ve sonrası) → Active (eski kural aynen)
  assert.equal(customerBucket(glass('URETIMDE', { estimatedShipDate: day('2026-11-11') }), undefined, now), 'active');
  assert.equal(customerBucket(glass('YUKLENDI', { estimatedShipDate: day('2026-11-13') }), undefined, now), 'active');
  // İş akışı bekleyen (yeni / hazırlanıyor), beklemede, tarihsiz ve profil siparişi tarihten etkilenmez
  assert.equal(customerBucket(glass('HAZIRLANIYOR', { estimatedShipDate: day('2026-10-01') }), undefined, now), 'active');
  assert.equal(customerBucket(glass('YENI', { estimatedShipDate: day('2026-10-01') }), undefined, now), 'active');
  assert.equal(customerBucket(glass('URETIMDE', { onHold: true, estimatedShipDate: day('2026-10-01') }), undefined, now), 'active');
  assert.equal(customerBucket(glass('URETIMDE', { estimatedShipDate: null }), undefined, now), 'active');
  assert.equal(customerBucket({ orderTypeCode: 'PROFILE_ORDER', status: 'URETIMDE', onHold: false, estimatedShipDate: day('2026-10-01') }, undefined, now), 'active');
  // Kapanmış ve onaylı eksiksiz yüklenmiş sipariş eskisi gibi arşivde
  assert.equal(customerBucket(glass('ARSIVLENDI', { estimatedShipDate: day('2026-12-01') }), undefined, now), 'archive');
  assert.equal(customerBucket(glass('URETIMDE', { estimatedShipDate: day('2026-12-01') }), ev([item('LOADED', 3)]), now), 'archive');
});
