// Otomatik "Yüklendi" (karar 156) — veritabanı gerektirmeyen kurallar: 45 gün sınırı, hangi siparişin kapandığı ve
// işlemin yalnızca işçiye açık olması. Veritabanıyla: test/db/auto-ship.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';
import { AUTO_SHIP_DAYS, AUTO_SHIP_EVERY_MS, autoShipDue, cutoffDay } from '../server/orders/auto-ship.js';
import { ORDER_ACTIONS, REQUIRES, glassWorkflow } from '../server/orders/transitions.js';
import { CLOSED, EVENTS, availableActions } from '../server/orders/rules.js';
import { STAFF_EVENT_POLICY } from '../server/orders/order-view.js';
import { INAPP_RULES } from '../server/notifications/inapp.js';
import { NOTIFY_RULES } from '../server/notifications/email.js';

const at = (day) => new Date(`${day}T12:00:00Z`);
const order = (extra = {}) => ({ orderTypeCode: 'GLASS_ORDER', status: 'URETIMDE', onHold: false, removedAt: null, actualShipDate: null, estimatedShipDate: at('2026-08-01'), ...extra });

test('45 gün: yükleme gününden 45 takvim günü sonra (dahil) sipariş kapanır; bir gün önce kapanmaz', () => {
  assert.equal(AUTO_SHIP_DAYS, 45);
  assert.equal(AUTO_SHIP_EVERY_MS, 3_600_000, 'işçi saatte bir denetler');
  assert.equal(cutoffDay('2026-09-15'), '2026-08-01');
  assert.equal(cutoffDay('2026-03-17'), '2026-01-31', 'ay / yıl sınırı');
  assert.equal(cutoffDay('2026-01-10'), '2025-11-26');
  // Yükleme günü 1 Ağustos: 44. gün (14 Eylül) açık, 45. gün (15 Eylül) ve sonrası kapanır
  assert.equal(autoShipDue(order(), '2026-09-14'), false);
  assert.equal(autoShipDue(order(), '2026-09-15'), true);
  assert.equal(autoShipDue(order(), '2026-12-01'), true);
  // Fiili yükleme günü varsa o geçerlidir (planlanan gün değil)
  assert.equal(autoShipDue(order({ actualShipDate: at('2026-09-01') }), '2026-09-15'), false);
  assert.equal(autoShipDue(order({ actualShipDate: at('2026-07-01'), estimatedShipDate: at('2026-12-01') }), '2026-09-15'), true);
  assert.equal(autoShipDue(order({ estimatedShipDate: null }), '2026-09-15'), false, 'yükleme günü olmayan sipariş kapanmaz');
});

test('kapsam: yalnızca üretimdeki, beklemede olmayan, silinmemiş cam siparişi', () => {
  const today = '2026-12-01';
  for (const status of ['YENI', 'HAZIRLANIYOR', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.equal(autoShipDue(order({ status }), today), false, status);
  assert.equal(autoShipDue(order({ onHold: true }), today), false, 'beklemedeki sipariş');
  assert.equal(autoShipDue(order({ removedAt: new Date() }), today), false, 'silinmiş sipariş');
  assert.equal(autoShipDue(order({ orderTypeCode: 'PROFILE_ORDER' }), today), false, 'profil siparişi (ayrı akış)');
  assert.equal(autoShipDue(order(), today), true);
});

test('işlem yalnızca işçiye açık: hiçbir rol tetikleyemez; yeni durum yok — "Yüklendi" mevcut durumdur', () => {
  const ctx = (extra = {}) => ({ order: { status: 'URETIMDE', onHold: false, drawingTrack: 'YOK', offers: [], drawings: [], ...extra }, payload: {} });
  const check = (actor, c = ctx()) => glassWorkflow.check({ orderType: 'GLASS_ORDER', action: 'auto_shipped', actor, ctx: c });
  const worker = { id: null, role: 'SYSTEM', system: true, autoShip: true };
  assert.deepEqual(check(worker), { ok: true, to: null });
  // Kullanıcı rolleri (yönetici dahil) ve eksik işaretli işçi: reddedilir
  for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) assert.deepEqual(check({ id: 'u', role }), { ok: false, code: 'NOT_ALLOWED' }, role);
  assert.deepEqual(check({ id: 'u', role: 'ADMIN', autoShip: true }), { ok: false, code: 'NOT_ALLOWED' }, 'kullanıcı "autoShip" yazsa da işçi değildir');
  assert.deepEqual(check({ id: null, role: 'SYSTEM', system: true }), { ok: false, code: 'NOT_ALLOWED' }, 'başka bir işçi işi (ör. FGO) bu işlemi çalıştıramaz');
  assert.deepEqual(check({ id: null, role: 'SYSTEM', system: 'true', autoShip: 'true' }), { ok: false, code: 'NOT_ALLOWED' }, 'metin değer işaret sayılmaz');
  // Yalnızca üretimdeki, beklemede olmayan sipariş
  for (const status of ['YENI', 'HAZIRLANIYOR', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.deepEqual(check(worker, ctx({ status })), { ok: false, code: 'NOT_ALLOWED' }, status);
  assert.deepEqual(check(worker, ctx({ onHold: true })), { ok: false, code: 'NOT_ALLOWED' });
  assert.deepEqual(glassWorkflow.check({ orderType: 'PROFILE_ORDER', action: 'auto_shipped', actor: worker, ctx: ctx() }), { ok: false, code: 'WRONG_ORDER_TYPE' });
  // Hiçbir rolün eylem listesinde yoktur (düğmesi / form işlemi olamaz); iş akışı işlemleri arasında tanımlıdır
  assert.ok(ORDER_ACTIONS.includes('auto_shipped'));
  assert.equal(REQUIRES.auto_shipped, undefined);
  for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) {
    for (const status of ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI']) assert.ok(!availableActions({ role, status }).includes('auto_shipped'), `${role} ${status}`);
  }
  // Kullanıcı isteklerinin işlemi yapan bilgisi (lib/actor.ts) "system" / "autoShip" taşımaz
  const actor = fs.readFileSync(new URL('../lib/actor.ts', import.meta.url), 'utf8');
  assert.ok(!/system|autoShip/.test(actor));
  // İşlem mevcut durumu kullanır (ikinci bir durum / işaret yok): "Yüklenen ve arşiv" sekmesinin gösterdiği durumlardan biri
  const src = fs.readFileSync(new URL('../server/orders/transitions.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async auto_shipped(h)'), src.indexOf('async archive(h)'));
  assert.match(body, /h\.set\(\{ status: 'YUKLENDI' \}\)/);
  assert.ok(!/actualShipDate|followCrates/.test(body), 'yükleme günü ve sandıklar değişmez');
  assert.ok(CLOSED.includes('YUKLENDI'));
});

test('olay: geçmişte görünür (müşteriye "Yüklendi"), her iki dilde metni var; müşteriye ayrı bildirim / e-posta gitmez', () => {
  assert.deepEqual(EVENTS.AUTO_SHIPPED, { customer: true });
  assert.ok(Object.hasOwn(STAFF_EVENT_POLICY, 'AUTO_SHIPPED'), 'olay kodu rol tablosunda (karar 139)');
  assert.deepEqual([tr.events.AUTO_SHIPPED.customer, ro.events.AUTO_SHIPPED.customer], ['Yüklendi', 'Încărcată']);
  assert.match(tr.events.AUTO_SHIPPED.label, /otomatik/);
  assert.match(tr.events.AUTO_SHIPPED.label, /45/);
  assert.match(ro.events.AUTO_SHIPPED.label, /automat/);
  // Kuyruğa yazılan olay türü (ORDER_AUTO_SHIPPED) hiçbir bildirim kuralında yok: uygulama içi bildirim ve e-posta üretmez
  assert.equal(INAPP_RULES.ORDER_AUTO_SHIPPED, undefined);
  assert.equal(NOTIFY_RULES.ORDER_AUTO_SHIPPED, undefined);
});

test('işçi: kural saatte bir çalışır; tek seferlik turda (--once) çalışmaz; dış istek yapmaz', () => {
  const worker = fs.readFileSync(new URL('../scripts/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /import \{ AUTO_SHIP_EVERY_MS, autoShipOrders \} from '\.\.\/server\/orders\/auto-ship\.js'/);
  assert.match(worker, /async function autoShipTick\(\) \{\s+if \(once\) return;/);
  assert.match(worker, /await autoShipTick\(\);/);
  const rule = fs.readFileSync(new URL('../server/orders/auto-ship.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|https?:\/\//.test(rule), 'kural yalnızca veritabanıyla çalışır');
  // Etkin aktarımı (ileri güne aktarılmış ama henüz yüklenmemiş camı) olan sipariş sorguda dışarıda kalır
  assert.match(rule, /replans: \{ none: \{ status: 'ACTIVE' \} \}/);
  // Durum yalnızca iş akışı servisinden değişir (doğrudan order.update yok)
  assert.match(rule, /runOrderAction\(db, \{ orderId: o\.id, action: 'auto_shipped'/);
  assert.ok(!/order\.update/.test(rule));
});
