import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, PERMISSIONS, READ_ONLY, ROLE_PERMISSIONS, ROLES } from '../server/auth/permissions.js';

const who = (perm) => ROLES.filter((r) => can(r, perm)).sort();

test('yetki: matriste yalnızca bilinen yetkiler, her rol tanımlı', () => {
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), [...ROLES].sort());
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const p of perms) assert.ok(p in PERMISSIONS, `${role}: ${p}`);
    assert.equal(new Set(perms).size, perms.length, `${role}: tekrar eden yetki`);
  }
  assert.throws(() => can('ADMIN', 'YOK_BOYLE'), /bilinmeyen yetki/);
  assert.equal(can(undefined, 'ORDER_VIEW'), false);
  assert.equal(can('BILINMEYEN', 'ORDER_VIEW'), false);
});

test('yetki: kararlar (CLAUDE.md) matriste', () => {
  assert.deepEqual(who('OFFER_SEND'), ['ADMIN'], 'teklifi yalnızca yönetici müşteriye gönderir');
  assert.deepEqual(who('ORDER_CANCEL'), ['ADMIN'], 'yalnızca yönetici iptal eder (karar 3)');
  assert.deepEqual(who('CUSTOMER_NAME_VIEW'), ['ADMIN', 'DENETIMCI', 'MUSTERI'], 'satış ve çizim tam adı görmez');
  assert.deepEqual(who('PRICE_FINAL_VIEW'), ['ADMIN', 'DENETIMCI', 'MUSTERI'], 'yönetici fiyatını satış/çizim görmez (karar 4)');
  assert.deepEqual(who('OFFER_DRAFT_VIEW'), ['ADMIN', 'SATIS'], 'denetimci ve müşteri yalnızca gönderilmiş teklifi görür');
  assert.deepEqual(who('OFFER_VIEW'), ['ADMIN', 'DENETIMCI', 'MUSTERI', 'SATIS'], 'çizim ekibi teklif görmez');
  assert.deepEqual(who('NOTE_INTERNAL_VIEW'), ['ADMIN', 'CIZIM', 'DENETIMCI', 'SATIS'], 'müşteri iç notu görmez');
  assert.deepEqual(who('FILE_INTERNAL_VIEW'), ['ADMIN', 'CIZIM', 'DENETIMCI', 'SATIS']);
  assert.deepEqual(who('ORDER_CREATE'), ['MUSTERI'], 'müşteri adına işlem Aşama 9');
  assert.deepEqual(who('DRAWING_APPROVE'), ['MUSTERI']);
  assert.deepEqual(who('OFFER_APPROVE'), ['MUSTERI'], 'profil teklifini yalnızca müşteri onaylar');
});

test('yetki: denetimci yalnızca okur (karar 8)', () => {
  const writes = ROLE_PERMISSIONS.DENETIMCI.filter((p) => !READ_ONLY.has(p));
  assert.deepEqual(writes, []);
});

test('yetki: yönetim yetkileri yalnızca yönetici', () => {
  for (const p of ['USER_MANAGE', 'CUSTOMER_MANAGE', 'CATALOG_MANAGE', 'PRICE_TABLE_MANAGE', 'ALERT_VIEW', 'STOCK_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_VIEW', 'ACCOUNTING_MANAGE']) {
    assert.deepEqual(who(p), ['ADMIN'], p);
  }
});

// Matrisin tamamı: bir değişiklik bilinçli yapılmalı (bu tabloyu da güncellemek gerekir).
test('yetki: tam matris', () => {
  const snapshot = Object.fromEntries(ROLES.map((r) => [r, Object.keys(PERMISSIONS).filter((p) => can(r, p)).join(' ')]));
  assert.deepEqual(snapshot, {
    ADMIN: Object.keys(PERMISSIONS).filter((p) => !['ORDER_CREATE', 'DRAWING_APPROVE', 'OFFER_APPROVE', 'ACCOUNT_SETTINGS'].includes(p)).join(' '),
    SATIS: 'ORDER_VIEW ORDER_REVIEW OFFER_VIEW OFFER_DRAFT_VIEW OFFER_PREPARE SHIPMENT_VIEW CRATE_EDIT TRANSPORT_LIST_VIEW FILE_UPLOAD FILE_INTERNAL_VIEW NOTE_ADD NOTE_INTERNAL_VIEW',
    CIZIM: 'ORDER_VIEW DRAWING_WORK FILE_UPLOAD FILE_INTERNAL_VIEW NOTE_ADD NOTE_INTERNAL_VIEW',
    MUSTERI: 'ORDER_VIEW ORDER_CREATE DRAWING_APPROVE OFFER_VIEW PRICE_FINAL_VIEW SHIPMENT_VIEW OFFER_EXPORT ACCOUNT_SETTINGS OFFER_APPROVE FILE_UPLOAD NOTE_ADD CUSTOMER_NAME_VIEW',
    DENETIMCI: 'ORDER_VIEW OFFER_VIEW PRICE_FINAL_VIEW SHIPMENT_VIEW TRANSPORT_LIST_VIEW FILE_INTERNAL_VIEW NOTE_INTERNAL_VIEW CUSTOMER_NAME_VIEW',
  });
});
