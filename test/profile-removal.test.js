// Profil siparişi silme ve otomatik stok iadesi (3.86.0, karar 281) — saf kurallar ve yapı. Veritabanıyla uçtan uca:
// test/db/profile-removal.test.js. Gerçek FGO çağrısı yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stockToReturn } from '../server/orders/removal.js';
import { ROLE_PERMISSIONS } from '../server/auth/permissions.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('stok iadesi: ürün başına NET düşüm kadar; önceki iade düşülür; düşülmemiş / artı ürün iade edilmez', () => {
  assert.deepEqual(stockToReturn([]), []);
  assert.deepEqual(stockToReturn([{ productId: 'a', qty: -7 }]), [{ productId: 'a', qty: 7 }]);
  // Kısmi iade (ör. önceki iptal) sonrası yalnızca kalan net düşüm
  assert.deepEqual(stockToReturn([{ productId: 'a', qty: -7 }, { productId: 'a', qty: 3 }]), [{ productId: 'a', qty: 4 }]);
  // Tam iade edilmiş ürün yeniden iade edilmez (tekrar silme / iptal sonrası silme)
  assert.deepEqual(stockToReturn([{ productId: 'a', qty: -7 }, { productId: 'a', qty: 7 }]), []);
  // Birden çok ürün, sıralı; giriş (artı) hiçbir zaman iade sayılmaz
  assert.deepEqual(stockToReturn([{ productId: 'b', qty: -2 }, { productId: 'a', qty: -5 }, { productId: 'c', qty: 9 }]), [{ productId: 'a', qty: 5 }, { productId: 'b', qty: 2 }]);
  // İade sonrası hesap sıfırlanır (aynı hareketlerle ikinci çağrı yeni iade üretmez)
  const moves = [{ productId: 'a', qty: -5 }, { productId: 'b', qty: -2 }];
  const back = stockToReturn(moves);
  assert.deepEqual(stockToReturn([...moves, ...back]), []);
});

test('yetki: profil siparişini yalnızca yönetici ve yönetici yardımcısı siler (ORDER_CANCEL)', () => {
  const holders = Object.entries(ROLE_PERMISSIONS).filter(([, ps]) => ps.includes('ORDER_CANCEL')).map(([r]) => r).sort();
  assert.deepEqual(holders, ['ADMIN', 'YONETICI_YARDIMCISI']);
});

test('yapı: silme işlemi FGO doğrulamasını verir; servis doğrulanmamış profil siparişini silmez; iade tek işlemde', () => {
  const action = read('app/(panel)/siparisler/[id]/compensation-actions.ts');
  assert.match(action, /requirePermission\('ORDER_CANCEL'\)/);
  assert.match(action, /fgoCheck: \(\) => verifyFgoForRemoval\(db, \{ secret \}\)/);
  const svc = read('server/orders/removal.js');
  // FGO doğrulaması işlemden ÖNCE, işlem içinde yeniden denetlenir
  assert.ok(svc.indexOf('fgoCheck ? await fgoCheck()') < svc.indexOf('return db.$transaction(async (tx) => {\n    // Profil'));
  assert.match(svc, /if \(profile && !fgo\) return fail\('FGO_UNVERIFIED'/);
  // Stok iadesi yalnızca gerçek hareketlerden (stockToReturn) ve IADE hareketiyle
  assert.match(svc, /returnRemovedOrderStock\(tx, \{ orderId: order\.id/);
  const stock = read('server/profile/stock.js');
  assert.match(stock, /const back = stockToReturn\(await tx\.stockMovement\.findMany/);
  assert.match(stock, /kind: 'IADE', orderId, note: `\$\{orderNo\} — sipariş silindi`/);
  // FGO'ya yalnızca okuma isteği (belge kesme / iptal yok)
  assert.doesNotMatch(svc, /fgoEmit|emitere|anulare|stornare/i);
  // Stoğu iade edilmiş profil siparişi geri yüklenmez
  assert.match(svc, /fail\('STOCK_RETURNED'/);
});
