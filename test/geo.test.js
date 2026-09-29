import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipv4ToInt, ipv6ToBigInt } from '../server/geo/ip.js';
import { parseDelegated } from '../server/geo/ripe.js';
import { createLookup, geoData } from '../server/geo/lookup.js';

test('IPv4 / IPv6 çözümleme', () => {
  assert.equal(ipv4ToInt('1.2.3.4'), 16909060);
  assert.equal(ipv4ToInt('256.1.1.1'), null);
  assert.equal(ipv4ToInt('1.2.3'), null);
  assert.equal(ipv6ToBigInt('::'), 0n);
  assert.equal(ipv6ToBigInt('::1'), 1n);
  assert.equal(ipv6ToBigInt('2a02:ff0::1'), (0x2a02n << 112n) | (0x0ff0n << 96n) | 1n);
  assert.equal(ipv6ToBigInt('::ffff:1.2.3.4'), (0xffffn << 32n) | 16909060n);
  assert.equal(ipv6ToBigInt('1::2::3'), null);
  assert.equal(ipv6ToBigInt('12345::'), null);
  assert.equal(ipv6ToBigInt('1.2.3.4'), null);
});

const SAMPLE = [
  '2|ripencc|20260928|1|19830705|20260927|+0100',
  'ripencc|*|ipv4|*|1|summary',
  'ripencc|TR|ipv4|78.160.0.0|2097152|20070605|allocated|a',
  'ripencc|RO|ipv4|86.120.0.0|524288|20050708|allocated|b',
  'ripencc|RO|ipv4|86.128.0.0|65536|20050708|assigned|b',
  'ripencc|RO|ipv4|90.0.0.0|256|20050708|available|b',
  'ripencc|DE|ipv4|5.1.0.0|1024|20120101|allocated|c',
  'ripencc|TR|ipv6|2a02:ff0::|32|20100101|allocated|a',
  'ripencc|RO|ipv6|2a02:2f00::|24|20100101|allocated|b',
].join('\n');

test('RIPE verisi: yalnızca TR/RO/MD, bitişik aralıklar birleşir', () => {
  const d = parseDelegated(SAMPLE);
  assert.deepEqual(d.countries, ['MD', 'RO', 'TR']);
  assert.equal(d.v4.length, 2); // RO'nun iki bitişik bloğu tek aralık; "available" ve DE atlanır
  assert.equal(d.v6.length, 2);
  const f = createLookup(d);
  assert.equal(f('78.180.1.1'), 'TR');
  assert.equal(f('86.121.5.5'), 'RO');
  assert.equal(f('86.128.0.1'), 'RO');
  assert.equal(f('90.0.0.1'), null);
  assert.equal(f('5.1.0.1'), null);
  assert.equal(f('2a02:ff0:1::5'), 'TR');
  assert.equal(f('2a02:2f0a::1'), 'RO');
  assert.equal(f('::ffff:78.160.0.1'), 'TR');
  assert.equal(f('[2a02:2f00::1]:443'), 'RO');
  assert.equal(f('127.0.0.1'), null);
  assert.equal(f(''), null);
  assert.equal(f('çöp'), null);
});

test('paketlenen veri okunabiliyor', () => {
  assert.equal(typeof geoData.ranges, 'number');
});
