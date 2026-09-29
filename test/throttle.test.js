import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockState, throttleState, WINDOW_MS, LIMITS } from '../server/auth/throttle.js';

const now = 10 * WINDOW_MS;
const min = 60_000;

test('kilit: 5. hatada kilitlenir, 4 hatada serbest', () => {
  assert.equal(lockState([now - 1, now - 2, now - 3, now - 4], now, 5).locked, false);
  const s = lockState([now - 10 * min, now - 4, now - 3, now - 2, now - 1], now, 5);
  assert.equal(s.locked, true);
  assert.equal(s.minutes, 5); // en eski hata 10 dk önce → 5 dk sonra açılır
});

test('kilit: pencere dışındaki hatalar sayılmaz', () => {
  const old = Array.from({ length: 10 }, (_, i) => now - WINDOW_MS - i);
  assert.equal(lockState(old, now, 5).locked, false);
});

test('kilit: IP sınırı başka e-postaları da kapsar; uzun süre geçerli', () => {
  const ip = Array.from({ length: LIMITS.ip }, (_, i) => now - i * min / 10);
  assert.equal(throttleState({ account: [], ip }, now).locked, true);
  assert.equal(throttleState({ account: [now - 1], ip: [now - 1] }, now).locked, false);
});

test('kilit: aynı e-postaya farklı IP\'lerden 20 hata da kilitler', () => {
  const email = Array.from({ length: LIMITS.email }, (_, i) => now - i * 1000);
  assert.equal(throttleState({ account: [], email, ip: [] }, now).locked, true);
  assert.equal(throttleState({ account: [], email: email.slice(1), ip: [] }, now).locked, false);
});
