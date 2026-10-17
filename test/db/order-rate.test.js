// Sipariş oluşturma hız sınırı (karar 289; NEW-GL-03) — gerçek PostgreSQL: sayaç veritabanında, firma kilidi altında;
// eşzamanlı isteklerde (birden çok uygulama örneği gibi ayrı bağlantılar) sınır aşılamaz.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { runBaseSeed } from '../../prisma/seed/base.mjs';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { ORDER_RATE } from '../../server/orders/create-rate.js';

let db, firm, other, cust, cust2, otherUser;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: true, customerId: u.customerId, ip: '127.0.0.1' });
const fileMeta = (n) => ({ storageKey: `2026/10/rate${n}.pdf`, name: `r-${n}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const create = async (u, f, i, requestKey = null) => {
  const next = await suggestNextNo(db, f.id);
  return createGlassOrder(db, { actor: actor(u), firm: f, title: `Hız ${i}`, requestedNo: next, suggestedNo: next, items: [{ glassName: 'Cam', camAdedi: 1 }], files: [fileMeta(`${f.prefix}${i}`)], requestKey });
};
/** Sınıra yakın geçmiş: doğrudan sipariş satırları (bildirim yok) */
let seq = 0;
async function seedOrders(u, f, n, at = new Date()) {
  for (let i = 0; i < n; i++) {
    const no = String(800000 + seq++);
    await db.order.create({ data: { orderNo: `${f.prefix}${no}`, customerOrderNo: no, orderTypeCode: 'GLASS_ORDER', customerId: f.id, createdById: u.id, title: 'eski', createdAt: at } });
  }
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  await runBaseSeed(db, { log: () => {} });
  firm = await db.customer.create({ data: { name: 'Hız Firma', prefix: 'HIZ' } });
  other = await db.customer.create({ data: { name: 'Diğer Firma', prefix: 'DGR' } });
  const mk = (key, customerId) => db.user.create({ data: { email: `${key}@test.test`, name: key, type: 'CUSTOMER', appRole: 'MUSTERI', customerId, canApprove: true } });
  cust = await mk('rate1', firm.id);
  cust2 = await mk('rate2', firm.id);
  otherUser = await mk('rate3', other.id);
});
after(closeDb);

dbTest('kullanıcı saatlik sınırı: eşzamanlı 6 istekte yalnızca kalan hak kadar sipariş açılır; başka firma etkilenmez', async () => {
  await seedOrders(cust, firm, ORDER_RATE.userHour - 2);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => codeOf(create(cust, firm, `a${i}`))));
  assert.equal(results.filter((r) => r === 'OK').length, 2, JSON.stringify(results));
  assert.equal(results.filter((r) => r === 'ORDER_RATE_LIMIT').length, 4);
  assert.equal(await db.order.count({ where: { createdById: cust.id } }), ORDER_RATE.userHour);
  // Aynı firmanın başka kullanıcısı ve başka firma devam eder
  assert.equal(await codeOf(create(cust2, firm, 'b1')), 'OK');
  assert.equal(await codeOf(create(otherUser, other, 'c1')), 'OK');
});

dbTest('reddedilen istek iz bırakmaz; aynı form anahtarı ilk siparişi döndürür (sınır yinelemeyi engellemez)', async () => {
  const key = 'k'.repeat(16);
  // cust2 için ilk sipariş (anahtarlı), sonra sınıra kadar doldur
  const first = await create(cust2, firm, 'd1', key);
  await seedOrders(cust2, firm, ORDER_RATE.userHour, new Date());
  const before = [await db.order.count(), await db.auditLog.count({ where: { action: 'ORDER_CREATE' } }), await db.notificationOutbox.count()];
  assert.equal(await codeOf(create(cust2, firm, 'd2')), 'ORDER_RATE_LIMIT');
  assert.deepEqual([await db.order.count(), await db.auditLog.count({ where: { action: 'ORDER_CREATE' } }), await db.notificationOutbox.count()], before);
  const again = await create(cust2, firm, 'd3', key);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
});

dbTest('pencere: bir saatten eski siparişler saatlik sınıra sayılmaz', async () => {
  const f = await db.customer.create({ data: { name: 'Eski Firma', prefix: 'ESK' } });
  const u = await db.user.create({ data: { email: 'rate4@test.test', name: 'rate4', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: f.id, canApprove: true } });
  await seedOrders(u, f, ORDER_RATE.userHour, new Date(Date.now() - 2 * 3_600_000));
  assert.equal(await codeOf(create(u, f, 'e1')), 'OK');
});
