// Paket B — saf kurallar ve yapı denetimleri (kararlar 226–229). Veritabanı / ağ yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PICKUP_REQUIRED, customerPickupOpen, missingPickup, optionalField, pickupEditDeadline, cleanPhone, cleanPlate } from '../server/profile/rules.js';
import { ALERT_SECTIONS, SECTION_KEYS, sectionOf } from '../server/notifications/order-alerts.js';
import { INAPP_TYPES } from '../server/notifications/inapp.js';
import { profileRequestKey } from '../server/profile/create.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('teslim bilgisi (karar 229): eksik alanlar sabit sırayla; boş metin eksiktir', () => {
  assert.deepEqual(PICKUP_REQUIRED, ['pickupDate', 'contactPhone', 'vehiclePlate']);
  assert.deepEqual(missingPickup(null), PICKUP_REQUIRED);
  assert.deepEqual(missingPickup({ pickupDate: new Date(), contactPhone: '  ', vehiclePlate: 'B 1 ABC' }), ['contactPhone']);
  assert.deepEqual(missingPickup({ pickupDate: new Date(), contactPhone: '0723', vehiclePlate: 'B 1' }), []);
});

test('son gün kuralı: müşteri alış gününden bir gün öncesine kadar (dahil) değiştirir', () => {
  assert.equal(customerPickupOpen({ pickupDay: '2026-10-15', today: '2026-10-14' }), true);
  assert.equal(customerPickupOpen({ pickupDay: '2026-10-15', today: '2026-10-15' }), false);
  assert.equal(customerPickupOpen({ pickupDay: '2026-10-15', today: '2026-10-16' }), false);
  assert.equal(customerPickupOpen({ pickupDay: null, today: '2026-10-16' }), true);
  assert.equal(pickupEditDeadline('2026-10-15'), '2026-10-14');
  assert.equal(pickupEditDeadline('2026-03-01'), '2026-02-28');
});

test('isteğe bağlı telefon / plaka: boş → null; geçersiz → hata (undefined)', () => {
  assert.equal(optionalField('', cleanPhone), null);
  assert.equal(optionalField('   ', cleanPlate), null);
  assert.equal(optionalField('abc', cleanPhone), undefined);
  assert.equal(optionalField('0723 000 000', cleanPhone), '0723 000 000');
  assert.equal(optionalField('b 12 abc', cleanPlate), 'B 12 ABC');
});

test('form anahtarı: yalnızca güvenli 16–64 karakter', () => {
  assert.equal(profileRequestKey('a'.repeat(15)), null);
  assert.equal(profileRequestKey('a'.repeat(16)), 'a'.repeat(16));
  assert.equal(profileRequestKey('x'.repeat(65)), null);
  assert.equal(profileRequestKey("abc'; DROP--0123456789"), null);
  assert.equal(profileRequestKey(undefined), null);
});

test('okundu bölümleri (karar 228): her ORDER_ uyarı türü tek bölümde; bilinmeyen tür sayfa başlığında', () => {
  const all = Object.values(ALERT_SECTIONS).flat();
  assert.equal(new Set(all).size, all.length, 'bir tür iki bölümde değil');
  for (const t of all) assert.ok(INAPP_TYPES.includes(t), `kayıtlı tür: ${t}`);
  assert.deepEqual(SECTION_KEYS, ['cizim', 'teklif', 'kararlar', 'teslim', 'notlar', 'durum']);
  assert.equal(sectionOf('ORDER_DRAWING_UPLOADED'), 'cizim');
  assert.equal(sectionOf('ORDER_OFFER_SENT'), 'teklif');
  assert.equal(sectionOf('ORDER_NOTE_ADDED'), 'notlar');
  assert.equal(sectionOf('ORDER_SHIPPED'), 'durum');
  // İstemci bileşeni aynı bölüm adlarını izler; sayfa yeniden çizdirilmez; bölüm görünmeden okumaz
  const seen = read('components/OrderSeen.tsx');
  for (const k of ['durum', 'cizim', 'teklif', 'kararlar', 'teslim']) assert.ok(seen.includes(`  ${k}: '`), k);
  assert.ok(seen.includes("'[data-note][data-at]'"));
  assert.ok(!/router\.refresh\(/.test(seen));
  // Sunucu işlemi bölüm adlarını süzer (beyaz liste markSectionsSeen'de)
  const action = read('app/(panel)/siparisler/[id]/actions.ts');
  assert.match(action, /markSectionsSeen\(db, \{ user, orderId: String\(orderId \?\? ''\), upTo: typeof upTo === 'string' \? upTo : null, sections: list \}\)/);
});

test('doğrudan profil siparişi (karar 229): karar sunucuda — form yalnızca alış günü / telefon / plaka ve tek seferlik anahtar gönderir; fiyatlar firmanın kendi listesinden', () => {
  const page = read('app/(panel)/siparisler/yeni/page.tsx');
  assert.ok(page.includes('const pricing = await profilePricesFor(db, firm.id);'), 'yalnızca bu firmanın fiyatları');
  assert.ok(!/purchasePrice|unitPrice: true/.test(page), 'alış / fabrika fiyatı forma gelmez');
  const action = read('app/(panel)/siparisler/yeni/actions.ts');
  assert.ok(action.includes('pickup, requestKey,'));
  assert.ok(!/offerPrice|price:/.test(action.slice(action.indexOf('createProfileOrderAction'))), 'tarayıcıdan fiyat alınmaz');
  const create = read('server/profile/create.js');
  assert.ok(create.includes("const direct = pricing.direct && missingPrices(lines).length === 0;"));
  assert.ok(create.includes("if (key && e?.code === 'P2002')"), 'eşzamanlı aynı anahtar: ilk sipariş döner');
  // Depo formu öncesi son denetim tek yerde: toWarehouse
  const tr = read('server/profile/transitions.js');
  assert.ok(tr.includes('requirePickupInfo({ ...p, ...extra });'));
  assert.ok(tr.includes("update_pickup: stockLocks"), 'bilgi tamamlanınca depoya iletim stok kilitleriyle');
});
