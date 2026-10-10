// P5 — müşterinin sipariş listesi (karar 243): arşivde yalnızca kapanmış ve onaylı yüklemeyle EKSİKSİZ yüklenmiş siparişler;
// yüklenmemiş, gecikmiş ve kalanı olan sipariş Active'de; Active tahmini yükleme gününe göre artan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { customerBucket, customerOrderCompare, customerStatusWhere, fullyLoaded } from '../server/orders/customer-list.js';

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
  assert.deepEqual(customerStatusWhere('active'), { status: { notIn: ['ARSIVLENDI', 'IPTAL'] } });
  const a = customerStatusWhere('archive');
  assert.deepEqual(a.OR[1], { orderTypeCode: 'GLASS_ORDER', status: { in: ['URETIMDE', 'YUKLENDI'] }, loadedItems: { some: {} } });
  // Yapı: müşteri listesi kendi firmasının kapsamıyla (orderScope) AND'lenir; son ayrım partitionCustomerOrders'ta
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/page.tsx', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('async function CustomerOrders'));
  assert.ok(fn.includes('where: { AND: [orderScope(user), searchWhere(sp.q), customerStatusWhere(bucket)'), 'firma kapsamı korunur');
  assert.ok(fn.includes('await partitionCustomerOrders(db, found, bucket)'), 'tek ayrım kuralı');
  assert.ok(!/status: archive \? \{ in: CLOSED/.test(fn), 'eski durum tabanlı ayrım yok');
});
