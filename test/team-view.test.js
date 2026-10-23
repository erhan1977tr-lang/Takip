// Satış ekibinin ortak GÖRÜNTÜLEMESİ (4.3.17, karar 301) — saf kurallar ve yapı.
// Aynı geçerli varsayılan çizimciye bağlı satışçılar birbirlerinin siparişini görür; DEĞİŞTİREMEZ. Yazma, görev listesi,
// bildirim ve sayaçlar sorumlu satışçı kapsamında (orderScope / actorScope) kalır.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { salesTeamOf } from '../server/orders/sales-team.js';
import { actorScope, orderScope, orderViewScope, teamViewOnly } from '../server/orders/scope.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const drawer = { id: 'D', appRole: 'CIZIM', type: 'INTERNAL', isActive: true, deletedAt: null };
const sales = (id, extra = {}) => ({ id, appRole: 'SATIS', type: 'INTERNAL', isActive: true, deletedAt: null, defaultDrawerId: 'D', ...extra });

test('ekip: aynı GEÇERLİ varsayılan çizimciye bağlı etkin satışçılar; ilk eleman her zaman kendisi', () => {
  const me = { id: 'M', appRole: 'SATIS' };
  assert.deepEqual(salesTeamOf(me, drawer, [sales('M'), sales('H'), sales('A')]), ['M', 'A', 'H']);
  // Pasif / silinmiş / müşteri / satış olmayan / başka çizimciye bağlı aday ekip sayılmaz
  assert.deepEqual(salesTeamOf(me, drawer, [
    sales('P', { isActive: false }), sales('X', { deletedAt: new Date() }), sales('C', { type: 'CUSTOMER' }),
    sales('Z', { appRole: 'CIZIM' }), sales('O', { defaultDrawerId: 'D2' }),
  ]), ['M']);
});

test('ekip: varsayılan çizimcisi olmayan ya da çizimcisi geçersiz satışçı yalnızca kendi siparişlerini görür', () => {
  const me = { id: 'M', appRole: 'SATIS' };
  assert.deepEqual(salesTeamOf(me, null, [sales('H')]), ['M']);
  assert.deepEqual(salesTeamOf(me, { ...drawer, isActive: false }, [sales('H')]), ['M'], 'pasif çizimci');
  assert.deepEqual(salesTeamOf(me, { ...drawer, deletedAt: new Date() }, [sales('H')]), ['M'], 'silinmiş çizimci');
  assert.deepEqual(salesTeamOf(me, { ...drawer, appRole: 'SATIS' }, [sales('H')]), ['M'], 'çizimci değil');
  assert.deepEqual(salesTeamOf(me, { ...drawer, type: 'CUSTOMER' }, [sales('H')]), ['M'], 'müşteri hesabı');
  // Satış dışı rol: ekip yok
  assert.deepEqual(salesTeamOf({ id: 'A', appRole: 'ADMIN' }, drawer, [sales('H')]), ['A']);
});

test('görüntüleme kapsamı: satışta ekip, diğer rollerde orderScope ile birebir aynı; yazma kapsamı değişmez', () => {
  const s = { id: 'M', appRole: 'SATIS', salesTeam: ['M', 'H'] };
  assert.deepEqual(orderViewScope(s), { removedAt: null, orderType: { usesSales: true }, salesUserId: { in: ['M', 'H'] } });
  // Yazma / görev kapsamı ekipten etkilenmez
  assert.equal(orderScope(s).salesUserId, 'M');
  assert.equal(actorScope({ id: 'M', role: 'SATIS' }).salesUserId, 'M');
  // Ekip bilgisi yok / kendisini içermiyor (sahte liste) → yalnızca kendisi
  assert.deepEqual(orderViewScope({ id: 'M', appRole: 'SATIS' }).salesUserId, { in: ['M'] });
  assert.deepEqual(orderViewScope({ id: 'M', appRole: 'SATIS', salesTeam: ['H'] }).salesUserId, { in: ['M'] });
  assert.deepEqual(orderViewScope({ appRole: 'SATIS', salesTeam: ['H'] }).salesUserId, { in: ['__none__'] }, 'kimliksiz → hiçbir şey');
  for (const u of [
    { id: 'A', appRole: 'ADMIN' }, { id: 'Y', appRole: 'YONETICI_YARDIMCISI' }, { id: 'I', appRole: 'DENETIMCI' },
    { id: 'D', appRole: 'CIZIM', salesTeam: ['x'] }, { id: 'C', appRole: 'MUSTERI', customerId: 'F', salesTeam: ['x'] },
  ]) assert.deepEqual(orderViewScope(u), orderScope(u), u.appRole);
  assert.equal(teamViewOnly(s, { salesUserId: 'H' }), true);
  assert.equal(teamViewOnly(s, { salesUserId: 'M' }), false);
  assert.equal(teamViewOnly({ id: 'A', appRole: 'ADMIN' }, { salesUserId: 'H' }), false);
});

// Görüntüleme kapsamını YALNIZCA okuma yolları kullanır. Yazma yolları (server action'lar, iş akışı, not, telafi, PDF aktarımı,
// sandık kaydı) ve kişisel sayaçlar / kuyruklar / bildirimler onu çağıramaz: görüntüleme hiçbir zaman düzenleme yetkisi vermez.
const VIEW_USERS = new Set([
  'server/orders/scope.js',
  'lib/orders.ts',
  'lib/auth/session.ts', // yalnızca açıklama (ekip oturumla okunur)
  'lib/loading.ts',
  'app/(panel)/siparisler/page.tsx',
  'app/(panel)/siparisler/[id]/page.tsx',
  'app/(panel)/siparisler/[id]/cizim/[drawingId]/page.tsx',
  'app/(panel)/siparisler/[id]/teklif/route.ts',
  'app/dosya/[kind]/[id]/route.ts',
  'app/(panel)/yuklemeler/nakliye/route.ts',
]);

test('yapı: orderViewScope / loadOrderView / salesView yalnızca izinli okuma dosyalarında', () => {
  const files = [...walk('app'), ...walk('lib'), ...walk('server'), ...walk('components'), ...walk('scripts')];
  const users = files.filter((f) => /\b(orderViewScope|loadOrderView|salesView|viewScopeOf)\b/.test(read(f)) && !f.startsWith('server/orders/sales-team'));
  for (const f of users) assert.ok(VIEW_USERS.has(f), `görüntüleme kapsamını beklenmeyen dosya kullanıyor: ${f}`);
  for (const f of users) assert.ok(!/^['"]use server['"]/m.test(read(f)), `server action dosyası görüntüleme kapsamını kullanamaz: ${f}`);
  // Yazma ve kişisel sayaç dosyaları açıkça
  for (const f of [
    'server/orders/transitions.js', 'server/domain/transition.js', 'server/notes/translation.js', 'server/notes/unread.js',
    'server/notifications/order-alerts.js', 'server/orders/queues.js', 'server/orders/compensation.js', 'server/orders/pdf-import/service.js',
    'server/loading/crates.js', 'app/(panel)/siparisler/[id]/actions.ts', 'app/(panel)/siparisler/[id]/compensation-actions.ts',
    'app/(panel)/yuklemeler/actions.ts', 'app/(panel)/teklifler/page.tsx',
  ]) assert.ok(!/\b(orderViewScope|loadOrderView|salesView)\b/.test(read(f)), f);
  // Server action'lar siparişi yazma kapsamıyla yükler (loadOrder), görüntüleme yüklemesiyle değil
  assert.match(read('app/(panel)/siparisler/[id]/actions.ts'), /loadOrder\(/);
  // Sipariş sayfası ekip görüntülemesinde işlem listesini boşaltır, not formunu ve okundu işaretini kapatır
  const page = read('app/(panel)/siparisler/[id]/page.tsx');
  assert.match(page, /const acts = viewOnly \? \[\] : availableActions/);
  assert.match(page, /readOnly=\{viewOnly\}/);
  assert.match(page, /!readOnly && <OrderSeen/);
  assert.match(page, /!readOnly && userCan\(user, 'NOTE_ADD'\)/);
  assert.match(page, /const canComp = !isCustomer && !viewOnly/);
  const viewer = read('app/(panel)/siparisler/[id]/cizim/[drawingId]/page.tsx');
  assert.match(viewer, /const acts = viewOnly \? \[\] : availableActions/);
  // "Sıra bende" kendi işi: liste kapsamı yalnızca "work" dışında görüntüleme kapsamı
  assert.match(read('app/(panel)/siparisler/page.tsx'), /view === 'work' \? orderScope\(user\) : orderViewScope\(user\)/);
  // Ekip oturumda her istekte okunur
  assert.match(read('lib/auth/session.ts'), /loadSalesTeam\(db, user\)/);
});
