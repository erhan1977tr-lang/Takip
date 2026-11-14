// "Tüm aktif siparişler"in kısaltılması (karar 316 — server/orders/ship-window.js): tahmini yükleme gününden 4 gün sonra
// üretimdeki / yüklenmiş cam siparişi liste görünümünde arşiv bölümüne geçer. Yalnızca liste: durum, kuyruklar, yükleme,
// fatura değişmez. Guard: kapsam (roller, durumlar), sınır günü, saat dilimi ve sayfanın yalnızca "all" / "archive"
// görünümünü değiştirdiği.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LIST_ARCHIVE_DAYS, LIST_ARCHIVE_STATUSES, listArchiveCutoff, localMidnight, notShipWindowWhere, shipWindowPassed, shipWindowWhere } from '../server/orders/ship-window.js';

const day = (d) => new Date(`${d}T12:00:00Z`);
const glass = (status, est, extra = {}) => ({ orderTypeCode: 'GLASS_ORDER', status, onHold: false, removedAt: null, estimatedShipDate: est, ...extra });

test('kural: 4 gün, yalnızca üretimdeki / yüklenmiş cam siparişi', () => {
  assert.equal(LIST_ARCHIVE_DAYS, 4);
  assert.deepEqual([...LIST_ARCHIVE_STATUSES], ['URETIMDE', 'YUKLENDI']);
  const now = new Date('2026-11-14T10:00:00Z');
  assert.equal(listArchiveCutoff(now), '2026-11-10');
  assert.equal(shipWindowPassed(glass('URETIMDE', day('2026-11-10')), now), true, 'tahmini gün + 4 → arşiv');
  assert.equal(shipWindowPassed(glass('URETIMDE', day('2026-11-11')), now), false, 'tahmini gün + 3 → aktif');
  assert.equal(shipWindowPassed(glass('YUKLENDI', day('2025-01-01')), now), true, 'geçmiş sipariş');
  for (const st of ['YENI', 'HAZIRLANIYOR', 'ARSIVLENDI', 'IPTAL']) assert.equal(shipWindowPassed(glass(st, day('2026-01-01')), now), false, st);
  assert.equal(shipWindowPassed(glass('URETIMDE', day('2026-01-01'), { onHold: true }), now), false, 'beklemede');
  assert.equal(shipWindowPassed(glass('URETIMDE', day('2026-01-01'), { removedAt: new Date() }), now), false, 'silinmiş');
  assert.equal(shipWindowPassed(glass('URETIMDE', null), now), false, 'tarihsiz');
  assert.equal(shipWindowPassed({ ...glass('URETIMDE', day('2026-01-01')), orderTypeCode: 'PROFILE_ORDER' }, now), false, 'profil');
});

test('gün işletmenin saat diliminde (Europe/Bucharest): gece yarısından sonra yeni gün; yaz / kış saati', () => {
  // 14.11 00:30 Bükreş = 13.11 22:30 UTC → bugün 14.11
  assert.equal(listArchiveCutoff(new Date('2026-11-13T22:30:00Z')), '2026-11-10');
  assert.equal(listArchiveCutoff(new Date('2026-11-13T21:30:00Z')), '2026-11-09');
  // Gece yarısı: kış +2, yaz +3
  assert.equal(localMidnight('2026-11-11').toISOString(), '2026-11-10T22:00:00.000Z');
  assert.equal(localMidnight('2026-07-11').toISOString(), '2026-07-10T21:00:00.000Z');
  assert.equal(localMidnight('2026-03-29').toISOString(), '2026-03-28T22:00:00.000Z', 'yaz saatine geçiş günü');
  assert.equal(localMidnight('2026-10-25').toISOString(), '2026-10-24T21:00:00.000Z', 'kış saatine geçiş günü');
});

test('veritabanı koşulu saf kuralla aynı sonucu verir (gün ortası ve yerel gece yarısı kayıtları)', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  const w = shipWindowWhere(now);
  assert.deepEqual({ ...w, estimatedShipDate: undefined }, { orderTypeCode: 'GLASS_ORDER', status: { in: ['URETIMDE', 'YUKLENDI'] }, onHold: false, estimatedShipDate: undefined });
  const lt = w.estimatedShipDate.lt;
  const dbMatch = (o) => o.orderTypeCode === 'GLASS_ORDER' && w.status.in.includes(o.status) && !o.onHold && !!o.estimatedShipDate && o.estimatedShipDate < lt;
  const samples = ['2026-11-09T12:00:00Z', '2026-11-10T12:00:00Z', '2026-11-10T21:59:00Z', '2026-11-10T22:00:00Z', '2026-11-11T12:00:00Z', '2026-11-09T22:00:00Z', '2026-11-10T22:00:00Z'];
  for (const s of samples) {
    const o = glass('URETIMDE', new Date(s));
    assert.equal(dbMatch(o), shipWindowPassed(o, now), s);
  }
  // Ters koşul: tarihsiz sipariş aktif listede kalır (NOT yerine açık OR — SQL NULL)
  const inv = notShipWindowWhere(now);
  assert.ok(inv.OR.some((c) => 'estimatedShipDate' in c && c.estimatedShipDate === null));
  assert.ok(inv.OR.some((c) => c.estimatedShipDate?.gte?.getTime() === lt.getTime()));
  assert.ok(inv.OR.some((c) => c.onHold === true));
  assert.ok(inv.OR.some((c) => c.orderTypeCode?.not === 'GLASS_ORDER'));
  assert.ok(inv.OR.some((c) => JSON.stringify(c.status?.notIn) === JSON.stringify(['URETIMDE', 'YUKLENDI'])));
});

test('yapı: iç ekip listesinde yalnızca "Tüm aktif siparişler" ve "Yüklenen ve arşiv" değişir; kuyruklar, çizim paneli, çizim ekibi aynı', () => {
  const page = fs.readFileSync(new URL('../app/(panel)/siparisler/page.tsx', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('async function InternalOrders'));
  assert.ok(fn.includes("const shipRule = !teamPanel && user.appRole !== 'CIZIM';"), 'çizim ekibi ve Çizim Paneli kural dışı');
  assert.ok(fn.includes("view === 'archive' && shipRule"), 'arşiv: kapanmış + tarih kuralı');
  assert.ok(fn.includes("view === 'all' && shipRule"), 'tüm aktif: tarih kuralı');
  assert.ok(fn.includes("{ status: view === 'archive' ? { in: CLOSED as OrderStatus[] } : { notIn: CLOSED as OrderStatus[] } }"), 'diğer görünümler (Sıra bende, DXF/DWG) eskisi gibi');
  assert.ok(fn.includes('notShipWindowWhere(listNow)') && fn.includes('shipWindowWhere(listNow)'));
  // Kuyruklar aynı satırlardan (work görünümünde tarih kuralı yok)
  assert.ok(fn.includes('queuesFor(rows,'));
  // Müşteri listesi tek ayrım kuralıyla (customerStatusWhere + partitionCustomerOrders, ikisi de kuralı uygular)
  const cust = page.slice(page.indexOf('async function CustomerOrders'), page.indexOf('async function InternalOrders'));
  assert.ok(cust.includes('customerStatusWhere(bucket)') && cust.includes('partitionCustomerOrders(db, found, bucket)'));
});

test('yapı: kural yalnızca okur — modül veritabanına yazmaz, iş akışı / durum değiştirmez', () => {
  const src = fs.readFileSync(new URL('../server/orders/ship-window.js', import.meta.url), 'utf8');
  assert.ok(!/runOrderAction|\.update\(|\.create\(|\.delete\(|status:\s*'ARSIVLENDI'/.test(src));
  assert.ok(!/from '\.\/transitions\.js'/.test(src));
});
