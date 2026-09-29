import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFirmCode, isFirmCode, suggestFirmCode } from '../server/firms/code.js';

test('firma kodu: yalnızca 3 büyük harf', () => {
  assert.equal(cleanFirmCode('glassandmore'), 'GLA');
  assert.equal(cleanFirmCode('Şişecam'), 'SIS');
  assert.equal(cleanFirmCode('Ștefan'), 'STE');
  assert.equal(cleanFirmCode('F1 Expert'), 'FEX');
  assert.equal(cleanFirmCode('MIR12'), 'MIR');
  assert.ok(isFirmCode('GLA'));
  for (const bad of ['GL', 'GLAS', 'GL1', 'gla', '', null]) assert.ok(!isFirmCode(bad), String(bad));
});

test('firma kodu: öneri çakışmada üçüncü, sonra ikinci harfi değiştirir', () => {
  assert.equal(suggestFirmCode('GLASSANDMORE'), 'GLA');
  assert.equal(suggestFirmCode('Al'), 'ALX');
  assert.equal(suggestFirmCode('GLASSANDMORE', ['GLA']), 'GLB');
  assert.equal(suggestFirmCode('GLASSANDMORE', ['GLA', 'GLB']), 'GLC');
  const allGL = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `GL${c}`);
  assert.equal(suggestFirmCode('GLASSANDMORE', allGL), 'GAA');
});
