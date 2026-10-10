// Otomatik arşiv (karar 158) — veritabanı gerektirmeyen kurallar: fiziksel yükleme kanıtı, 45 gün sınırı, işlemlerin
// yalnızca işçiye açık olması, olayların görünürlüğü. Veritabanıyla: test/db/auto-archive.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';
import { ARCHIVE_ACTOR, AUTO_ARCHIVE_DAYS, AUTO_ARCHIVE_EVERY_MS, autoArchiveDue, cutoffDay, loadingProof } from '../server/orders/auto-archive.js';
import { ORDER_ACTIONS, REQUIRES, glassWorkflow } from '../server/orders/transitions.js';
import { CLOSED, EVENTS, availableActions } from '../server/orders/rules.js';
import { STAFF_EVENT_POLICY, eventsFor } from '../server/orders/order-view.js';
import { INAPP_RULES } from '../server/notifications/inapp.js';
import { NOTIFY_RULES } from '../server/notifications/email.js';

const at = (day) => new Date(`${day}T12:00:00Z`);
const shipDay = (day) => ({ shipDay: new Date(`${day}T00:00:00.000Z`) });
const GLASS = { description: 'Temper Lamine 44.2', enMm: 1000, boyMm: 2000, kind: 'CAM', unit: 'm2' };
const order = (extra = {}) => ({ orderTypeCode: 'GLASS_ORDER', status: 'URETIMDE', onHold: false, removedAt: null, actualShipDate: null, estimatedShipDate: at('2026-06-01'), ...extra });
/** Onay kalemi: c = onay, line = teklif satırı (ya da replan = aktarım), revision = düzeltme sırası */
const item = (c, day, status, quantity, extra = {}) => ({ ...GLASS, confirmationId: c, offerLineId: 'L1', replanId: null, revision: 0, status, quantity, confirmation: shipDay(day), ...extra });
const ev = (extra = {}) => ({ items: [], replans: [], compensated: new Map(), sent: [{ ...GLASS, adet: 10 }], lastShip: null, ...extra });
const replan = (c, status, quantity, extra = {}) => ({ status, quantity, sourceItem: { confirmationId: c, offerLineId: 'L1', replanId: null }, ...extra });

test('45 gün: son yükleme gününden 45 takvim günü sonra (dahil); bir gün önce değil', () => {
  assert.equal(AUTO_ARCHIVE_DAYS, 45);
  assert.equal(AUTO_ARCHIVE_EVERY_MS, 3_600_000, 'işçi saatte bir denetler');
  assert.equal(cutoffDay('2026-09-15'), '2026-08-01');
  assert.equal(cutoffDay('2026-03-17'), '2026-01-31', 'ay / yıl sınırı');
  assert.equal(cutoffDay('2026-01-10'), '2025-11-26');
  const proof = loadingProof(order(), ev({ items: [item('c1', '2026-08-01', 'LOADED', 10)] }));
  assert.deepEqual(proof, { ok: true, via: 'CONFIRMED', day: '2026-08-01' });
  assert.equal(autoArchiveDue(proof, '2026-09-14'), false, '44. gün');
  assert.equal(autoArchiveDue(proof, '2026-09-15'), true, '45. gün');
  assert.equal(autoArchiveDue(proof, '2026-12-01'), true);
  assert.equal(autoArchiveDue({ ok: false, reason: 'NOT_CONFIRMED' }, '2030-01-01'), false, 'kanıtsız sipariş hiçbir zaman');
});

test('gerçekten yüklenmemiş sipariş: planlanan tarih kanıt değildir; açık kalan / etkin aktarım / bekleme / silinmiş → kanıt yok', () => {
  // Yükleme onayı yok: planlanan gün 100 gün önce de olsa üretimde kalır
  assert.deepEqual(loadingProof(order({ estimatedShipDate: at('2026-01-01') }), ev()), { ok: false, reason: 'NOT_CONFIRMED' });
  assert.deepEqual(loadingProof(order({ actualShipDate: at('2026-01-01') }), ev()), { ok: false, reason: 'NOT_CONFIRMED' }, 'fiili tarih alanı da kanıt değil');
  // Onayda 2 cam yüklenmedi, aktarılmadı → açık kalan
  const split = [item('c1', '2026-06-01', 'LOADED', 8), item('c1', '2026-06-01', 'NOT_LOADED', 2)];
  assert.deepEqual(loadingProof(order(), ev({ items: split })), { ok: false, reason: 'NOT_LOADED_OPEN' });
  // Kısmen aktarıldı (1 / 2) → hâlâ açık; aktarımdan vazgeçildi → açık
  assert.deepEqual(loadingProof(order(), ev({ items: split, replans: [replan('c1', 'CONFIRMED', 1)] })), { ok: false, reason: 'NOT_LOADED_OPEN' });
  assert.deepEqual(loadingProof(order(), ev({ items: split, replans: [replan('c1', 'CANCELLED', 2)] })), { ok: false, reason: 'NOT_LOADED_OPEN' });
  // Kalan ileri güne aktarıldı ama henüz yüklenmedi (etkin aktarım)
  assert.deepEqual(loadingProof(order(), ev({ items: split, replans: [replan('c1', 'ACTIVE', 2)] })), { ok: false, reason: 'REPLAN_ACTIVE' });
  // Aktarılan kalan o gün de yüklenmedi (aktarımın kendi kalemi NOT_LOADED) ve yeniden aktarılmadı → açık
  const again = [...split, item('c2', '2026-06-10', 'NOT_LOADED', 2, { offerLineId: null, replanId: 'R1' })];
  assert.deepEqual(loadingProof(order(), ev({ items: again, replans: [replan('c1', 'CONFIRMED', 2)] })), { ok: false, reason: 'NOT_LOADED_OPEN' });
  // Düzeltmeyle (sıra 1) yüklenmedi'ye çevrilen cam: geçerli durum açık kalan
  const corrected = [item('c1', '2026-06-01', 'LOADED', 10), item('c1', '2026-06-01', 'LOADED', 7, { revision: 1 }), item('c1', '2026-06-01', 'NOT_LOADED', 3, { revision: 1 })];
  assert.deepEqual(loadingProof(order(), ev({ items: corrected })), { ok: false, reason: 'NOT_LOADED_OPEN' });
  // Bekleme, silinmiş, profil, başka durumlar
  const full = ev({ items: [item('c1', '2026-06-01', 'LOADED', 10)] });
  assert.deepEqual(loadingProof(order({ onHold: true }), full), { ok: false, reason: 'ON_HOLD' });
  assert.deepEqual(loadingProof(order({ removedAt: new Date() }), full), { ok: false, reason: 'REMOVED' });
  assert.deepEqual(loadingProof(order({ orderTypeCode: 'PROFILE_ORDER' }), full), { ok: false, reason: 'NOT_GLASS' });
  for (const status of ['YENI', 'HAZIRLANIYOR', 'ARSIVLENDI', 'IPTAL']) assert.deepEqual(loadingProof(order({ status }), full), { ok: false, reason: 'STATUS' }, status);
});

test('gerçekten yüklenmiş sipariş: eksiksiz onay, aktarımla tamamlanan kalan, telafiyle kapanan kalan → son yükleme günü', () => {
  // Kalan ileri güne aktarıldı ve o gün yüklendi: yükleme günü SON yüklendiği gün
  const split = [item('c1', '2026-06-01', 'LOADED', 8), item('c1', '2026-06-01', 'NOT_LOADED', 2)];
  const reloaded = [...split, item('c2', '2026-06-20', 'LOADED', 2, { offerLineId: null, replanId: 'R1' })];
  assert.deepEqual(loadingProof(order(), ev({ items: reloaded, replans: [replan('c1', 'CONFIRMED', 2)] })), { ok: true, via: 'CONFIRMED', day: '2026-06-20' });
  // Kalanın yerine UYGULANMIŞ telafi açıldı (kapsam anahtarı "<onay>|l:<satır>")
  assert.deepEqual(loadingProof(order(), ev({ items: split, compensated: new Map([['c1|l:L1', 2]]) })), { ok: true, via: 'CONFIRMED', day: '2026-06-01' });
  // Düzeltmeyle yüklendi'ye çevrilen kalan
  const fixed = [...split, item('c1', '2026-06-01', 'LOADED', 10, { revision: 1 })];
  assert.deepEqual(loadingProof(order(), ev({ items: fixed })), { ok: true, via: 'CONFIRMED', day: '2026-06-01' });
  // Ayrılmış satırlar (aynı cam iki satır) toplanır; teklifte sonradan azalan adet sorun değildir
  const twoRows = [item('c1', '2026-06-01', 'LOADED', 6), item('c1', '2026-06-01', 'LOADED', 4, { offerLineId: 'L2' })];
  assert.equal(loadingProof(order(), ev({ items: twoRows })).ok, true);
  assert.equal(loadingProof(order(), ev({ items: twoRows, sent: [{ ...GLASS, adet: 9 }] })).ok, true);
});

test('onaydan sonra siparişe eklenen cam yüklenmiş sayılmaz (müşterideki teklif onaylardakinden fazla)', () => {
  const full = [item('c1', '2026-06-01', 'LOADED', 10)];
  assert.deepEqual(loadingProof(order(), ev({ items: full, sent: [{ ...GLASS, adet: 12 }] })), { ok: false, reason: 'NOT_IN_LOADING' }, 'aynı cam, fazla adet');
  assert.deepEqual(loadingProof(order(), ev({ items: full, sent: [{ ...GLASS, adet: 10 }, { ...GLASS, description: 'Float 4 mm', adet: 1 }] })), { ok: false, reason: 'NOT_IN_LOADING' }, 'başka cam');
  assert.deepEqual(loadingProof(order(), ev({ items: full, sent: [{ ...GLASS, enMm: 900, adet: 10 }] })), { ok: false, reason: 'NOT_IN_LOADING' }, 'başka ölçü');
  assert.deepEqual(loadingProof(order(), ev({ items: full, sent: null })), { ok: false, reason: 'NOT_IN_LOADING' }, 'müşteride teklif yok');
  // İşlem satırları (CNC / delik) ve adet birimli satırlar cam sayımına girmez
  assert.equal(loadingProof(order(), ev({ items: full, sent: [{ ...GLASS, adet: 10 }, { ...GLASS, kind: 'CNC', unit: 'adet', adet: 3 }] })).ok, true);
});

test('"Yüklendi" durumu (karar 245): satışın düğmesi tek başına kanıt DEĞİL — onaylı eksiksiz yükleme gerekir; 3.51.0 tarih kuralı da değil', () => {
  const y = (extra = {}) => order({ status: 'YUKLENDI', actualShipDate: at('2026-07-01'), ...extra });
  // Onaylı yükleme yok: süre dolsa da arşivlenmez (müşterinin Active listesinde kalır)
  assert.deepEqual(loadingProof(y(), ev({ lastShip: 'SHIPPED' })), { ok: false, reason: 'NOT_CONFIRMED' });
  assert.deepEqual(loadingProof(y(), ev({ lastShip: null })), { ok: false, reason: 'NOT_CONFIRMED' }, 'eski kayıt (olay yok)');
  assert.equal(autoArchiveDue(loadingProof(y(), ev({ lastShip: 'SHIPPED' })), '2027-01-01'), false, '45 gün çoktan geçmiş olsa da');
  assert.deepEqual(loadingProof(y(), ev({ lastShip: 'AUTO_SHIPPED' })), { ok: false, reason: 'AUTO_SHIPPED' });
  // Onaylı ve eksiksiz yüklenmiş "Yüklendi": kanıt onaydır, gün onaylı yükleme günü
  const full = [item('c1', '2026-06-01', 'LOADED', 10)];
  assert.deepEqual(loadingProof(y(), ev({ lastShip: 'SHIPPED', items: full })), { ok: true, via: 'CONFIRMED', day: '2026-06-01' });
  // Kişi "Yüklendi" dese de onayda açık kalan ya da etkin aktarım varsa fiziksel yükleme bitmemiştir
  const split = [item('c1', '2026-06-01', 'LOADED', 8), item('c1', '2026-06-01', 'NOT_LOADED', 2)];
  assert.deepEqual(loadingProof(y(), ev({ lastShip: 'SHIPPED', items: split })), { ok: false, reason: 'NOT_LOADED_OPEN' });
  assert.deepEqual(loadingProof(y(), ev({ lastShip: 'SHIPPED', items: split, replans: [replan('c1', 'ACTIVE', 2)] })), { ok: false, reason: 'REPLAN_ACTIVE' });
});

test('aday sorgusu (karar 245): yalnızca onaylı yüklemesi olan sipariş; "Yüklendi" + tarih tek başına aday yapmaz', () => {
  const src = fs.readFileSync(new URL('../server/orders/auto-archive.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function autoArchiveOrders'));
  assert.ok(fn.includes("status: { in: ['URETIMDE', 'YUKLENDI'] },"));
  assert.ok(fn.includes("loadedItems: { some: { status: 'LOADED', confirmation: { shipDay: { lt: before } } } },"));
  assert.ok(!/actualShipDate: \{ lt: before \}/.test(fn), 'planlanan / fiili tarihle aday yok');
  assert.ok(!src.includes("via: 'SHIPPED'"), 'SHIPPED kanıt yolu yok');
});

test('işlemler yalnızca işçiye açık: hiçbir rol tetikleyemez; tarih kuralının "Yüklendi" işlemi artık yok', () => {
  const ctx = (extra = {}) => ({ order: { status: 'URETIMDE', onHold: false, removedAt: null, drawingTrack: 'YOK', offers: [], drawings: [], ...extra }, payload: {} });
  const check = (action, actor, c = ctx()) => glassWorkflow.check({ orderType: 'GLASS_ORDER', action, actor, ctx: c });
  assert.deepEqual(ARCHIVE_ACTOR, { id: null, role: 'SYSTEM', system: true, autoArchive: true, ip: null });
  assert.ok(Object.isFrozen(ARCHIVE_ACTOR));
  assert.deepEqual(check('auto_archive', ARCHIVE_ACTOR), { ok: true, to: null });
  assert.deepEqual(check('auto_archive', ARCHIVE_ACTOR, ctx({ status: 'YUKLENDI' })), { ok: true, to: null });
  assert.deepEqual(check('auto_ship_revert', ARCHIVE_ACTOR, ctx({ status: 'YUKLENDI' })), { ok: true, to: null });
  for (const action of ['auto_archive', 'auto_ship_revert']) {
    for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) {
      assert.deepEqual(check(action, { id: 'u', role }, ctx({ status: 'YUKLENDI' })), { ok: false, code: 'NOT_ALLOWED' }, `${action} ${role}`);
      assert.deepEqual(check(action, { id: 'u', role, autoArchive: true }, ctx({ status: 'YUKLENDI' })), { ok: false, code: 'NOT_ALLOWED' }, 'kullanıcı işareti yazsa da işçi değildir');
    }
    assert.deepEqual(check(action, { id: null, role: 'SYSTEM', system: true }, ctx({ status: 'YUKLENDI' })), { ok: false, code: 'NOT_ALLOWED' }, 'başka bir işçi işi (ör. FGO)');
    assert.deepEqual(check(action, { id: null, role: 'SYSTEM', system: 'true', autoArchive: 'true' }, ctx({ status: 'YUKLENDI' })), { ok: false, code: 'NOT_ALLOWED' }, 'metin değer işaret sayılmaz');
    assert.deepEqual(check(action, ARCHIVE_ACTOR, ctx({ status: 'YUKLENDI', removedAt: new Date() })), { ok: false, code: 'NOT_ALLOWED' }, 'silinmiş');
    assert.equal(REQUIRES[action], undefined);
    assert.ok(ORDER_ACTIONS.includes(action));
  }
  // Arşiv: yalnızca "Yüklendi" ya da üretimdeki, beklemede olmayan sipariş · onarım: yalnızca "Yüklendi"
  for (const status of ['YENI', 'HAZIRLANIYOR', 'ARSIVLENDI', 'IPTAL']) assert.deepEqual(check('auto_archive', ARCHIVE_ACTOR, ctx({ status })), { ok: false, code: 'NOT_ALLOWED' }, status);
  assert.deepEqual(check('auto_archive', ARCHIVE_ACTOR, ctx({ onHold: true })), { ok: false, code: 'NOT_ALLOWED' });
  for (const status of ['URETIMDE', 'ARSIVLENDI', 'IPTAL']) assert.deepEqual(check('auto_ship_revert', ARCHIVE_ACTOR, ctx({ status })), { ok: false, code: 'NOT_ALLOWED' }, status);
  assert.deepEqual(glassWorkflow.check({ orderType: 'PROFILE_ORDER', action: 'auto_archive', actor: ARCHIVE_ACTOR, ctx: ctx() }), { ok: false, code: 'WRONG_ORDER_TYPE' });
  // 3.51.0'ın tarih kuralı işlemi kaldırıldı: hiçbir yoldan çalışmaz
  assert.ok(!ORDER_ACTIONS.includes('auto_shipped'));
  assert.deepEqual(check('auto_shipped', { ...ARCHIVE_ACTOR, autoShip: true }), { ok: false, code: 'UNKNOWN_ACTION' });
  for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) {
    for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI']) {
      const acts = availableActions({ role, status });
      for (const a of ['auto_archive', 'auto_ship_revert', 'auto_shipped']) assert.ok(!acts.includes(a), `${role} ${status} ${a}`);
    }
  }
  // Kullanıcı isteklerinin işlemi yapan bilgisi (lib/actor.ts) işçi işaretlerini taşımaz
  const actor = fs.readFileSync(new URL('../lib/actor.ts', import.meta.url), 'utf8');
  assert.ok(!/system|autoShip|autoArchive/.test(actor));
});

test('kayıt: "Yüklendi" yalnızca kişinin düğmesiyle yazılır; arşiv mevcut durumu kullanır, kuralı kayıttan önce yeniden uygular', () => {
  const src = fs.readFileSync(new URL('../server/orders/transitions.js', import.meta.url), 'utf8');
  // YUKLENDI yazan TEK yer satışın "Yüklendi" düğmesidir (mark_shipped)
  assert.deepEqual(src.match(/status: 'YUKLENDI'/g), ["status: 'YUKLENDI'"]);
  assert.match(src, /async mark_shipped\(h\) \{\s+await h\.set\(\{ status: 'YUKLENDI', actualShipDate: h\.now \}\);/);
  const body = src.slice(src.indexOf('async auto_archive(h)'), src.indexOf('async auto_ship_revert(h)'));
  assert.match(body, /archiveCheck\(h\.tx, h\.order, \{ today: h\.payload\.today, now: h\.now \}\)/);
  assert.match(body, /if \(!r\.ok\) throw new WorkflowError\(r\.code\);/);
  assert.match(body, /h\.set\(\{ status: 'ARSIVLENDI' \}\)/);
  assert.ok(!/actualShipDate|followCrates|outbox|fgo|billing/i.test(body), 'yükleme günü, sandık, belge, bildirim değişmez');
  const revert = src.slice(src.indexOf('async auto_ship_revert(h)'), src.indexOf('async archive(h)'));
  assert.match(revert, /if \(last\?\.event !== 'AUTO_SHIPPED'\) throw new WorkflowError\('NOT_ALLOWED'\);/);
  assert.match(revert, /h\.set\(\{ status: 'URETIMDE' \}\)/);
  assert.ok(CLOSED.includes('ARSIVLENDI'));
  const rule = fs.readFileSync(new URL('../server/orders/auto-archive.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|https?:\/\//.test(rule), 'kural yalnızca veritabanıyla çalışır');
  assert.ok(!/\.update\(|\.updateMany\(|\.create\(|\.delete/.test(rule), 'durum yalnızca iş akışı servisinden değişir (doğrudan yazma yok)');
  assert.match(rule, /runOrderAction\(db, \{ orderId: o\.id, action: 'auto_archive', actor: ARCHIVE_ACTOR, payload: \{ today \} \}\)/);
  assert.match(rule, /runOrderAction\(db, \{ orderId: o\.id, action: 'auto_ship_revert', actor: ARCHIVE_ACTOR \}\)/);
  // Yalnızca uygulanmış telafi kalanı kapatır (bekleyen karar reddedilebilir)
  assert.match(rule, /db\.compensation\.findMany\(\{ where: \{ sourceOrderId: \{ in: ids \}, status: 'APPLIED', notLoadedScope: \{ not: null \} \}/);
});

test('olaylar: arşiv müşteriye "Arşivlendi"; tarih kuralının "Yüklendi"si ve geri alınması yalnızca iç ekibe; hiçbiri bildirim üretmez', () => {
  assert.deepEqual(EVENTS.AUTO_ARCHIVED, { customer: true });
  assert.deepEqual(EVENTS.AUTO_SHIPPED, { customer: false });
  assert.deepEqual(EVENTS.AUTO_SHIP_REVERTED, { customer: false });
  for (const e of ['AUTO_ARCHIVED', 'AUTO_SHIPPED', 'AUTO_SHIP_REVERTED']) {
    assert.ok(Object.hasOwn(STAFF_EVENT_POLICY, e), `rol tablosunda: ${e}`);
    assert.equal(INAPP_RULES[`ORDER_${e}`], undefined, `uygulama içi bildirim yok: ${e}`);
    assert.equal(NOTIFY_RULES[`ORDER_${e}`], undefined, `e-posta yok: ${e}`);
  }
  assert.deepEqual([tr.events.AUTO_ARCHIVED.customer, ro.events.AUTO_ARCHIVED.customer], ['Arşivlendi', 'Arhivată']);
  assert.match(tr.events.AUTO_ARCHIVED.label, /otomatik.*45/);
  assert.match(ro.events.AUTO_ARCHIVED.label, /automat.*45/);
  assert.equal(tr.events.AUTO_SHIPPED.customer, undefined);
  assert.ok(tr.events.AUTO_SHIP_REVERTED.label && ro.events.AUTO_SHIP_REVERTED.label);
  // Müşteri geçmişinde 3.51.0'ın yanlış "Yüklendi" satırı ve geri alma kaydı görünmez; arşiv görünür
  const rows = [{ event: 'PRODUCTION', note: null }, { event: 'AUTO_SHIPPED', note: null }, { event: 'AUTO_SHIP_REVERTED', note: null }, { event: 'AUTO_ARCHIVED', note: '01.08.2026' }];
  assert.deepEqual(eventsFor('MUSTERI', rows).map((e) => [e.event, e.note]), [['PRODUCTION', null], ['AUTO_ARCHIVED', null]]);
  assert.deepEqual(eventsFor('SATIS', rows).map((e) => e.event), ['PRODUCTION', 'AUTO_SHIPPED', 'AUTO_SHIP_REVERTED', 'AUTO_ARCHIVED']);
});

test('işçi: önce onarım sonra arşiv, saatte bir; tek seferlik turda (--once) çalışmaz; dış istek yapmaz', () => {
  const worker = fs.readFileSync(new URL('../scripts/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /import \{ AUTO_ARCHIVE_EVERY_MS, autoArchiveOrders, repairAutoShipped \} from '\.\.\/server\/orders\/auto-archive\.js'/);
  assert.match(worker, /async function autoArchiveTick\(\) \{\s+if \(once\) return;/);
  assert.match(worker, /await repairAutoShipped\(db, \{ log \}\);[\s\S]+await autoArchiveOrders\(db, \{ now: new Date\(\), log \}\);/);
  assert.match(worker, /await autoArchiveTick\(\);/);
  assert.ok(!/auto-ship\.js|autoShipOrders|autoShipTick/.test(worker), '3.51.0 kuralı işçide yok');
  assert.ok(!fs.existsSync(new URL('../server/orders/auto-ship.js', import.meta.url)));
});
