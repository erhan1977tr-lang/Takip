import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADMIN_ONLY, can, PERMISSIONS, READ_ONLY, ROLE_PERMISSIONS, ROLES } from '../server/auth/permissions.js';

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
  // Yönetici Yardımcısı (Paket A, karar 219): yöneticinin operasyonel yetkilerinin tamamı — teklif onayı / gönderimi, iptal /
  // silme, fabrika ve müşteri fiyatları, mevcut FGO işlemleri (ACCOUNTING_MANAGE), yükleme, sandık, tedarik
  const OPS = ['ADMIN', 'YONETICI_YARDIMCISI'];
  assert.deepEqual(who('OFFER_SEND'), OPS, 'teklifi yalnızca yönetici (ve yardımcısı) müşteriye gönderir');
  assert.deepEqual(who('ORDER_CANCEL'), OPS, 'satış iptal edemez (karar 3)');
  assert.deepEqual(who('CUSTOMER_NAME_VIEW'), ['ADMIN', 'DENETIMCI', 'MUSTERI', 'YONETICI_YARDIMCISI'], 'satış ve çizim tam adı görmez');
  assert.deepEqual(who('PRICE_FINAL_VIEW'), ['ADMIN', 'DENETIMCI', 'MUSTERI', 'YONETICI_YARDIMCISI'], 'yönetici fiyatını satış/çizim görmez (karar 4)');
  assert.deepEqual(who('OFFER_DRAFT_VIEW'), ['ADMIN', 'SATIS', 'YONETICI_YARDIMCISI'], 'denetimci ve müşteri yalnızca gönderilmiş teklifi görür');
  assert.deepEqual(who('OFFER_VIEW'), ['ADMIN', 'DENETIMCI', 'MUSTERI', 'SATIS', 'YONETICI_YARDIMCISI'], 'çizim ekibi teklif görmez');
  assert.deepEqual(who('NOTE_INTERNAL_VIEW'), ['ADMIN', 'CIZIM', 'DENETIMCI', 'SATIS', 'YONETICI_YARDIMCISI'], 'müşteri iç notu görmez');
  assert.deepEqual(who('FILE_INTERNAL_VIEW'), ['ADMIN', 'CIZIM', 'DENETIMCI', 'SATIS', 'YONETICI_YARDIMCISI']);
  assert.deepEqual(who('ORDER_CREATE'), ['MUSTERI'], 'müşteri adına işlem Aşama 9');
  assert.deepEqual(who('DRAWING_APPROVE'), ['MUSTERI']);
  assert.deepEqual(who('OFFER_APPROVE'), ['MUSTERI'], 'profil teklifini yalnızca müşteri onaylar');
  // Stok miktarlarını yalnızca yönetici (ve yardımcısı) ve denetimci görür; denetimci yalnızca görüntüler (karar 177)
  assert.deepEqual(who('STOCK_VIEW'), ['ADMIN', 'DENETIMCI', 'YONETICI_YARDIMCISI']);
  assert.deepEqual(who('STOCK_MANAGE'), OPS);
  // Tedarik ve satın alma (karar 179–184): denetimci (stoğu görse de) dahil hiçbir başka rol bu finansal verilere erişmez
  assert.deepEqual(who('SUPPLIER_MANAGE'), OPS);
  assert.ok(READ_ONLY.has('STOCK_VIEW') && !READ_ONLY.has('STOCK_MANAGE'));
  // Denetimcinin fiyat kuralı (karar 11, Paket A madde 10): yardımcının mali yetkileri denetimciye verilmez
  for (const p of ['OFFER_DRAFT_VIEW', 'OFFER_PREPARE', 'OFFER_SEND', 'ACCOUNTING_MANAGE', 'SUPPLIER_MANAGE', 'STOCK_MANAGE']) assert.equal(can('DENETIMCI', p), false, p);
});

test('yetki: denetimci yalnızca okur (karar 8)', () => {
  const writes = ROLE_PERMISSIONS.DENETIMCI.filter((p) => !READ_ONLY.has(p));
  assert.deepEqual(writes, []);
});

test('yetki: yönetim yetkileri yalnızca yönetici; operasyonel yönetim yetkileri yönetici + Yönetici Yardımcısı (karar 219)', () => {
  // Kullanıcı / rol yönetimi (e-posta değiştirme, kullanıcı silme dahil), kritik / güvenlik ayarları, denetim ve giriş logları
  for (const p of ['USER_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_VIEW']) assert.deepEqual(who(p), ['ADMIN'], p);
  assert.deepEqual([...ADMIN_ONLY].sort(), ['AUDIT_VIEW', 'SETTINGS_MANAGE', 'USER_MANAGE']);
  for (const p of ['CUSTOMER_MANAGE', 'CUSTOMER_DELETE', 'CATALOG_MANAGE', 'PRICE_TABLE_MANAGE', 'ALERT_VIEW', 'STOCK_MANAGE', 'OPS_SETTINGS_MANAGE', 'ACCOUNTING_MANAGE', 'LOADING_CONFIRM', 'SUPPLIER_MANAGE']) {
    assert.deepEqual(who(p), ['ADMIN', 'YONETICI_YARDIMCISI'], p);
  }
  // Yardımcı = yönetici − ADMIN_ONLY (ne eksik ne fazla); yeni FGO yetkisi yok
  assert.deepEqual(ROLE_PERMISSIONS.YONETICI_YARDIMCISI, ROLE_PERMISSIONS.ADMIN.filter((p) => !ADMIN_ONLY.includes(p)));
  assert.equal(Object.keys(PERMISSIONS).some((p) => /FGO/.test(p)), false);
});

// Matrisin tamamı: bir değişiklik bilinçli yapılmalı (bu tabloyu da güncellemek gerekir).
test('yetki: tam matris', () => {
  const snapshot = Object.fromEntries(ROLES.map((r) => [r, Object.keys(PERMISSIONS).filter((p) => can(r, p)).join(' ')]));
  assert.deepEqual(snapshot, {
    ADMIN: Object.keys(PERMISSIONS).filter((p) => !['ORDER_CREATE', 'DRAWING_APPROVE', 'OFFER_APPROVE', 'ACCOUNT_SETTINGS'].includes(p)).join(' '),
    YONETICI_YARDIMCISI: 'ORDER_VIEW ORDER_REVIEW ORDER_CANCEL DRAWING_WORK OFFER_VIEW OFFER_DRAFT_VIEW OFFER_PREPARE OFFER_SEND PRICE_FINAL_VIEW SHIPMENT_VIEW CRATE_EDIT TRANSPORT_LIST_VIEW OFFER_EXPORT STOCK_MANAGE STOCK_VIEW FILE_UPLOAD FILE_INTERNAL_VIEW NOTE_ADD NOTE_INTERNAL_VIEW CUSTOMER_NAME_VIEW CUSTOMER_MANAGE CUSTOMER_DELETE CATALOG_MANAGE PRICE_TABLE_MANAGE ALERT_VIEW OPS_SETTINGS_MANAGE ACCOUNTING_MANAGE LOADING_CONFIRM SUPPLIER_MANAGE',
    SATIS: 'ORDER_VIEW ORDER_REVIEW OFFER_VIEW OFFER_DRAFT_VIEW OFFER_PREPARE SHIPMENT_VIEW CRATE_EDIT TRANSPORT_LIST_VIEW FILE_UPLOAD FILE_INTERNAL_VIEW NOTE_ADD NOTE_INTERNAL_VIEW',
    CIZIM: 'ORDER_VIEW DRAWING_WORK FILE_UPLOAD FILE_INTERNAL_VIEW NOTE_ADD NOTE_INTERNAL_VIEW',
    MUSTERI: 'ORDER_VIEW ORDER_CREATE DRAWING_APPROVE OFFER_VIEW PRICE_FINAL_VIEW SHIPMENT_VIEW OFFER_EXPORT ACCOUNT_SETTINGS OFFER_APPROVE FILE_UPLOAD NOTE_ADD CUSTOMER_NAME_VIEW',
    DENETIMCI: 'ORDER_VIEW OFFER_VIEW PRICE_FINAL_VIEW SHIPMENT_VIEW TRANSPORT_LIST_VIEW STOCK_VIEW FILE_INTERNAL_VIEW NOTE_INTERNAL_VIEW CUSTOMER_NAME_VIEW',
  });
});

// Rol yetkileri veritabanında PermissionKey enum'uyla saklanır (seed bu tabloyu eşitler): yeni yetki ŞEMAYA da eklenmeli
test('yetki: matristeki her yetki şemanın PermissionKey enum\'unda (ve tersi)', () => {
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const body = /enum PermissionKey \{([^}]*)\}/.exec(schema)?.[1] ?? '';
  const keys = body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  assert.deepEqual([...keys].sort(), Object.keys(PERMISSIONS).sort());
});
