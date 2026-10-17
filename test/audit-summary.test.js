import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../server/security/audit-summary.js';

test('npm audit özeti: sayımlar, önem sırası, danışma başlığı', () => {
  const s = summarize({
    vulnerabilities: {
      a: { severity: 'high', via: [{ title: 'Prototip kirliliği' }] },
      b: { severity: 'critical', via: ['a'] },
      c: { severity: 'weird', via: [] },
    },
  });
  assert.deepEqual(s.counts, { info: 1, low: 0, moderate: 0, high: 1, critical: 1 });
  assert.deepEqual(s.items.map((x) => [x.name, x.severity]), [['b', 'critical'], ['a', 'high'], ['c', 'info']]);
  assert.equal(s.items[1].title, 'Prototip kirliliği');
});

test('npm audit hatası / bozuk yanıt başarılı tarama sayılmaz', () => {
  assert.ok(summarize({ error: { code: 'ENOTFOUND', summary: 'ağ yok' } }).error);
  assert.ok(summarize(null).error);
  assert.ok(summarize({}).error);
  assert.deepEqual(summarize({ vulnerabilities: {} }).counts.critical, 0);
});
