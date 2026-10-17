// Sipariş oluşturma hız sınırı (karar 289; NEW-GL-03): saf kural + yapı (firma kilidi altında, yinelemeden sonra).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORDER_RATE, assertOrderRate, orderRateProblem } from '../server/orders/create-rate.js';

test('sınır kuralı: kullanıcı / firma saatlik ve firma günlük', () => {
  assert.equal(orderRateProblem({ userHour: 0, firmHour: 0, firmDay: 0 }), null);
  assert.equal(orderRateProblem({ userHour: ORDER_RATE.userHour - 1, firmHour: ORDER_RATE.firmHour - 1, firmDay: ORDER_RATE.firmDay - 1 }), null);
  assert.equal(orderRateProblem({ userHour: ORDER_RATE.userHour, firmHour: 0, firmDay: 0 }), 'USER_HOUR');
  assert.equal(orderRateProblem({ userHour: 0, firmHour: ORDER_RATE.firmHour, firmDay: 0 }), 'FIRM_HOUR');
  assert.equal(orderRateProblem({ userHour: 0, firmHour: 0, firmDay: ORDER_RATE.firmDay }), 'FIRM_DAY');
  assert.ok(ORDER_RATE.userHour >= 30, 'olağan iş akışı engellenmez');
});

test('sayım veritabanından, doğru pencere ve kapsamla; aşılınca ORDER_RATE_LIMIT', async () => {
  const seen = [];
  const tx = (n) => ({ order: { count: async (q) => { seen.push(q.where); return n; } } });
  const now = new Date('2026-10-17T10:00:00Z');
  await assertOrderRate(tx(0), { firmId: 'f', userId: 'u', now });
  assert.deepEqual(seen[0], { customerId: 'f', createdById: 'u', createdAt: { gte: new Date('2026-10-17T09:00:00Z') } });
  assert.deepEqual(seen[2], { customerId: 'f', createdAt: { gte: new Date('2026-10-16T10:00:00Z') } });
  await assert.rejects(assertOrderRate(tx(ORDER_RATE.firmDay), { firmId: 'f', userId: 'u', now }), { code: 'ORDER_RATE_LIMIT' });
});

test('cam ve profil oluşturma sınırı firma kilidinden SONRA ve tek kullanımlık anahtar yinelemesinden SONRA uygular', () => {
  for (const p of ['server/orders/create.js', 'server/profile/create.js']) {
    const s = fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const lock = s.indexOf('order-no:${firm.id}');
    const dup = s.indexOf('duplicate: true');
    const rate = s.indexOf('await assertOrderRate(tx');
    assert.ok(lock > 0 && dup > lock && rate > dup, p);
    assert.ok(rate < s.indexOf('= await pickNumber(tx'), `${p}: numara almadan önce`);
  }
});
