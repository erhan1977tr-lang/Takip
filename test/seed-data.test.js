import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, PERMISSIONS } from '../prisma/seed/data/roles.js';
import { ORDER_TYPES } from '../prisma/seed/data/order-types.js';
import { UNITS } from '../prisma/seed/data/units.js';
import { PROFILE_CATEGORIES, PROFILE_PRODUCTS } from '../prisma/seed/data/profile-catalog.js';

const uniq = (a) => new Set(a).size === a.length;

test('seed: beş rol, yetkiler bilinen anahtarlar', () => {
  assert.deepEqual(ROLES.map((r) => r.code).sort(), ['ADMIN', 'CIZIM', 'DENETIMCI', 'MUSTERI', 'SATIS']);
  for (const r of ROLES) for (const p of r.permissions) assert.ok(PERMISSIONS.includes(p), `${r.code}: ${p}`);
});

test('seed: sipariş tipleri cam ve profil; profil satış/çizimden geçmez', () => {
  assert.deepEqual(ORDER_TYPES.map((t) => t.code), ['GLASS_ORDER', 'PROFILE_ORDER']);
  const profile = ORDER_TYPES.find((t) => t.code === 'PROFILE_ORDER');
  assert.equal(profile.usesSales, false);
  assert.equal(profile.usesDrawing, false);
  for (const t of ORDER_TYPES) assert.ok(t.name.ro && t.name.tr);
});

test('seed: profil kataloğu tanımdaki 4 kategori ve 27 ürün', () => {
  assert.deepEqual(PROFILE_CATEGORIES.map((c) => c.code), ['GARNITURI', 'PLASTICE', 'PROFILE_ALUMINIU', 'ACCESORII']);
  assert.equal(PROFILE_PRODUCTS.length, 27);
  assert.ok(uniq(PROFILE_PRODUCTS.map((p) => p.code)), 'ürün kodları benzersiz');
  const units = UNITS.map((u) => u.code);
  const cats = PROFILE_CATEGORIES.map((c) => c.code);
  for (const p of PROFILE_PRODUCTS) {
    assert.ok(units.includes(p.unit), p.code);
    assert.ok(cats.includes(p.category), p.code);
    assert.match(p.code, /^[A-Z0-9-]+$/);
  }
  const count = (c) => PROFILE_PRODUCTS.filter((p) => p.category === c).length;
  assert.deepEqual([count('GARNITURI'), count('PLASTICE'), count('PROFILE_ALUMINIU'), count('ACCESORII')], [4, 6, 10, 7]);
});
