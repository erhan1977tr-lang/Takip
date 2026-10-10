// Paket A — saf kurallar ve yapı (kararlar 219–225). Veritabanıyla olanlar: test/db/paket-a.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { can, ROLES } from '../server/auth/permissions.js';
import { parseEmail, targetProblem } from '../server/users/lifecycle.js';
import { LOGIN_LOG_RETENTION_DAYS, loginEventData, loginWhere, parseLoginFilter, safeIp } from '../server/auth/login-log.js';
import { deletionBlockers, emptyFacts } from '../server/customers/deletion.js';
import { renderInviteEmail } from '../server/mail/templates/invite.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const firstLine = (src, name) => {
  const body = src.slice(src.indexOf(`export async function ${name}(`));
  // gövde: imzanın sonundaki ") {" (dönüş türü varsa "> {") satır sonundan sonra başlar
  const open = body.search(/\)(: [^\n]+)? \{\n/);
  return body.slice(body.indexOf('{\n', open) + 2).trim().split('\n')[0].trim();
};

test('Yönetici Yardımcısı (karar 219): operasyonu yapar; kullanıcı / rol, güvenlik ve kritik ayar, giriş logları yok', () => {
  assert.ok(ROLES.includes('YONETICI_YARDIMCISI'));
  const yy = (p) => can('YONETICI_YARDIMCISI', p);
  for (const p of ['ORDER_VIEW', 'ORDER_CANCEL', 'CUSTOMER_MANAGE', 'CUSTOMER_DELETE', 'OPS_SETTINGS_MANAGE', 'OFFER_PREPARE', 'OFFER_SEND', 'OFFER_DRAFT_VIEW',
    'PRICE_FINAL_VIEW', 'ACCOUNTING_MANAGE', 'DRAWING_WORK', 'LOADING_CONFIRM', 'CRATE_EDIT', 'STOCK_MANAGE', 'CATALOG_MANAGE', 'PRICE_TABLE_MANAGE', 'ALERT_VIEW']) assert.ok(yy(p), p);
  for (const p of ['USER_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_VIEW', 'ORDER_CREATE', 'ACCOUNT_SETTINGS']) assert.equal(yy(p), false, p);
  // Mevcut roller değişmedi: yönetici her şeyi (müşteriye özgü hariç), satış / çizim / denetimci / müşteri yeni yetki almadı
  for (const p of ['USER_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_VIEW', 'OPS_SETTINGS_MANAGE', 'CUSTOMER_DELETE']) assert.ok(can('ADMIN', p), p);
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) for (const p of ['OPS_SETTINGS_MANAGE', 'CUSTOMER_DELETE']) assert.equal(can(role, p), false, `${role} ${p}`);
  // Menü: yönetici menüsü eksi "Kullanıcılar"
  assert.match(read('lib/roles.ts'), /YONETICI_YARDIMCISI: ADMIN_NAV\.filter\(\(d\) => !\('href' in d\) \|\| d\.href !== '\/admin\/users'\),/);
});

test('sunucu yetkisi (karar 219): kullanıcı yönetimi USER_MANAGE, giriş logları AUDIT_VIEW, operasyonel ayarlar OPS_SETTINGS_MANAGE, firma silme CUSTOMER_DELETE — her işlemin ilk satırı', () => {
  const users = strip(read('app/(panel)/admin/users/actions.ts'));
  for (const fn of ['createUserAction', 'sendInviteAction', 'resetPasswordAction', 'toggleActiveAction', 'changeEmailAction', 'deleteUserAction']) {
    assert.equal(firstLine(users, fn), "const admin = await requirePermission('USER_MANAGE');", fn);
  }
  assert.ok(strip(read('app/(panel)/admin/users/page.tsx')).includes("await requirePermission('USER_MANAGE')"));
  assert.ok(strip(read('app/(panel)/admin/entegrasyonlar/giris-loglari/page.tsx')).includes("await requirePermission('AUDIT_VIEW')"));
  const settings = strip(read('app/(panel)/admin/entegrasyonlar/actions.ts'));
  for (const fn of ['saveWarehouseAction', 'saveAccountingAction', 'saveDailyRateAction']) assert.equal(firstLine(settings, fn), "const user = await requirePermission('OPS_SETTINGS_MANAGE');", fn);
  for (const fn of ['saveAntivirusAction', 'testAntivirusAction', 'scanNowAction', 'saveFgoAction', 'saveTranslateAction', 'testTranslateAction', 'testFgoAction']) {
    assert.match(firstLine(settings, fn), /^(const user = )?await requirePermission\('SETTINGS_MANAGE'\);$/, fn);
  }
  // Ayarlar sayfası: kritik bölümler yalnızca `full` (SETTINGS_MANAGE) iken çizilir
  const page = strip(read('app/(panel)/admin/entegrasyonlar/page.tsx'));
  for (const id of ['id="fgo"', 'id="ceviri"', 'id="antivirus"']) {
    const at = page.indexOf(id);
    const gate = page.lastIndexOf('{full && (<>', at);
    assert.ok(gate > 0 && page.lastIndexOf('</>)}', at) < gate, `${id} yalnızca tam yetkide`);
  }
  for (const id of ['id="kur"', 'id="muhasebe"', 'id="depo"']) {
    const at = page.indexOf(id);
    assert.ok(page.lastIndexOf('{ops && ', at) > page.lastIndexOf('</>)}', at) || page.lastIndexOf('{ops && (', at) > 0, id);
  }
  const firms = strip(read('app/(panel)/admin/firms/actions.ts'));
  assert.equal(firstLine(firms, 'deleteCustomerAction'), "const user = await requirePermission('CUSTOMER_DELETE');");
  // Servisler de yetkiyi kendisi denetler (ilk satır)
  const life = strip(read('server/users/lifecycle.js'));
  for (const fn of ['userDeletionPreview', 'deleteUser', 'checkEmailChange', 'applyEmailChange']) assert.equal(firstLine(life, fn), 'if (!allowed(actor)) return FORBIDDEN;', fn);
  assert.ok(life.includes("can(actor.role, 'USER_MANAGE')"));
  const del = strip(read('server/customers/deletion.js'));
  for (const fn of ['customerDeletionPreview', 'deleteCustomer']) assert.equal(firstLine(del, fn), "if (!allowed(actor)) return fail('FORBIDDEN');", fn);
  assert.ok(del.includes("can(actor.role, 'CUSTOMER_DELETE')"));
  assert.ok(strip(read('server/calendar/service.js')).includes("can(actor.role, 'OPS_SETTINGS_MANAGE')"));
});

test('e-posta değişikliği / kullanıcı silme kuralları (karar 221–222): biçim, korunan hesaplar', () => {
  assert.deepEqual(parseEmail('  Ali@Ornek.RO '), { ok: true, email: 'ali@ornek.ro' });
  for (const bad of ['', 'a', 'a@b', 'a b@c.ro', 'a@@b.ro', 'x@silindi.invalid', `${'a'.repeat(200)}@b.ro`, null, 42]) assert.equal(parseEmail(bad).ok, false, String(bad));
  const actor = { id: 'me' };
  assert.equal(targetProblem(null, actor), 'NOT_FOUND');
  assert.equal(targetProblem({ id: 'me', appRole: 'SATIS' }, actor), 'SELF');
  assert.equal(targetProblem({ id: 'x', appRole: 'ADMIN' }, actor), 'PROTECTED');
  assert.equal(targetProblem({ id: 'x', appRole: 'SATIS', deletedAt: new Date() }, actor), 'DELETED');
  assert.equal(targetProblem({ id: 'x', appRole: 'YONETICI_YARDIMCISI' }, actor), null);
  // Davet şablonu: e-posta değişikliği metni, aynı tek kullanımlık kod ve bağlantı
  const m = renderInviteEmail({ code: '123456', language: 'ro', purpose: 'emailChange', appUrl: 'https://takip.test', email: 'yeni@ornek.ro' });
  assert.match(m.subject, /schimbată/);
  assert.match(m.text, /123456/);
  assert.match(m.text, /\/setup\?email=yeni%40ornek\.ro/);
  assert.match(renderInviteEmail({ code: '123456', language: 'xx', purpose: 'emailChange' }).subject, /değiştirildi/);
  assert.match(renderInviteEmail({ code: '123456', language: 'tr' }).subject, /oluşturuldu/, 'olağan davet değişmedi');
});

test('giriş logu (karar 223): yalnızca izinli alanlar; sır / e-posta yok; bilinmeyen hesap atfedilmez; süzgeç girdisi doğrulanır', () => {
  assert.equal(LOGIN_LOG_RETENTION_DAYS, 365);
  const now = new Date('2026-10-10T10:00:00Z');
  const ok = loginEventData({ kind: 'LOGIN', success: true, user: { id: 'u1', appRole: 'ADMIN', email: 'a@b.ro', passwordHash: 'h' }, ip: '203.0.113.5', now });
  assert.deepEqual(ok, { kind: 'LOGIN', success: true, locked: false, userId: 'u1', role: 'ADMIN', ip: '203.0.113.5', createdAt: now });
  assert.deepEqual(loginEventData({ kind: 'LOGIN', success: false, user: null, ip: '::1', locked: true, now }), { kind: 'LOGIN', success: false, locked: true, userId: null, role: null, ip: '::1', createdAt: now });
  assert.equal(loginEventData({ kind: 'LOGIN', success: true, locked: true, now }).locked, false, 'başarılı giriş kilit başlatmaz');
  assert.equal(loginEventData({ kind: 'BASKA', success: true }), null);
  assert.equal(safeIp('1.2.3.4, 5.6.7.8'), null);
  assert.equal(safeIp('<script>'), null);
  const f = parseLoginFilter({ sonuc: 'basarisiz', tur: 'CODE', rol: 'SATIS', kullanici: 'abc_123', bas: '2026-10-01', bit: '2026-10-09', ip: '1.2.3.4', sayfa: '3' });
  assert.deepEqual(loginWhere(f), {
    success: false, kind: 'CODE', role: 'SATIS', userId: 'abc_123', ip: '1.2.3.4',
    createdAt: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-10-10T00:00:00Z') },
  });
  assert.equal(f.page, 3);
  const junk = parseLoginFilter({ sonuc: 'x', tur: 'DROP', rol: 'ROOT', kullanici: "'; --", bas: '2026-13-45', ip: 'evil', sayfa: '-5' });
  assert.deepEqual(loginWhere(junk), {});
  assert.equal(junk.page, 1);
  assert.deepEqual(loginWhere(parseLoginFilter({ kullanici: 'bilinmeyen' })), { userId: null });
  assert.equal(parseLoginFilter({ sayfa: '999999' }).page, 1000);
  // Giriş ekranları: kilitliyken gelen istek yazmaz (kayıt kilit kontrolünden SONRA); şifre / kod / e-posta metni verilmez
  const login = strip(read('app/login/actions.ts'));
  assert.ok(login.indexOf('if (attempt.locked) redirect(') < login.indexOf('recordLoginEvent('));
  assert.equal((login.match(/recordLoginEvent\(db, \{/g) ?? []).length, 2);
  assert.doesNotMatch(login.slice(login.indexOf('recordLoginEvent(')), /recordLoginEvent\(db, \{[^}]*(password|email|code)/);
  const setup = strip(read('app/setup/actions.ts'));
  assert.ok(setup.indexOf('if (attempt.locked) redirect(') < setup.indexOf('recordLoginEvent('));
  assert.match(setup, /const owner = result\.reason === 'wrong_code' \? await codeOwner\(db, email\) : null;/);
  // İşçi saatte bir temizler
  assert.match(read('scripts/worker.mjs'), /loginEvents: await pruneLoginEvents\(db\)/);
});

test('müşteri silme engelleri (karar 221): resmî belge izi, değiştirilemez kayıt, başka müşteriye bağ, fabrika', () => {
  assert.deepEqual(deletionBlockers(emptyFacts()), []);
  const all = { ...emptyFacts(), factory: true, fgoDocuments: 1, billingBatches: 2, fgoJobs: 1, glassBillings: 1, profileDocuments: 1, manualPayments: 1, loadingItems: 3, replans: 1, deliveryRecords: 1, stockMovements: 1, hostedOrders: 1, sharedCrates: 1 };
  assert.deepEqual(deletionBlockers(all).map((b) => b.code), [
    'FACTORY', 'FGO_DOCUMENT', 'BILLING_BATCH', 'FGO_JOB', 'GLASS_BILLING', 'PROFILE_DOCUMENT', 'MANUAL_PAYMENT', 'LOADING_CONFIRMED', 'LOADING_REPLAN', 'DELIVERY_RECORD',
    'STOCK_MOVEMENT', 'HOSTS_OTHER_CUSTOMER', 'SHARED_CRATE',
  ]);
  // Silme hiçbir FGO / ağ çağrısı yapmaz, denetim kaydını silmez
  const src = strip(read('server/customers/deletion.js'));
  assert.doesNotMatch(src, /fetch\(|integrations\/fgo|auditLog\.(delete|update)/);
  assert.match(src, /action: 'CUSTOMER_DELETED'/);
  // Migration'larda veri silme yok (test verisinin toplu silinmesi yasak)
  for (const dir of fs.readdirSync(new URL('../prisma/migrations', import.meta.url))) {
    const f = new URL(`../prisma/migrations/${dir}/migration.sql`, import.meta.url);
    if (!fs.existsSync(f) || !/paket|20261010/i.test(dir)) continue;
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /DELETE FROM|TRUNCATE/i, dir);
  }
});

test('bildirimler (karar 220): güvenlik kitlesi yalnızca USER_MANAGE; pasif kullanıcı e-posta kitlelerinde yok', () => {
  const email = strip(read('server/notifications/email.js'));
  assert.match(email, /if \(mine && creator\.isActive !== false\) add\(creator\.email, lang, null\);/);
  assert.match(email, /if \(order\.assignedDrawer\.isActive !== false\) add\(/);
  assert.match(email, /u\.isActive !== false && ROLE_SETS\.sales\.includes\(u\.appRole\)/);
  assert.equal((email.match(/appRole: \{ in: ROLE_SETS\.(sales|admin) \}, isActive: true/g) ?? []).length, 2);
  assert.match(email, /appRole: \{ in: ROLE_SETS\[a\] \?\? \[\] \}, isActive: true/);
  assert.match(email, /assignedDrawer: \{ select: \{ email: true, language: true, appRole: true, isActive: true \} \}/);
  assert.match(strip(read('server/auth/lock-events.js')), /audience: 'security'/);
});

test('sipariş uyarıları ve mesajlar (karar 224–225, Paket B karar 228): sayfa çizimi yazmaz; okuma istemci bileşeninden, bölüm görülünce; mesajlar doğrudan açık', () => {
  const svc = strip(read('server/notifications/order-alerts.js'));
  assert.match(svc, /where: \{ userId: user\.id, orderId: order\.id, isRead: false, createdAt: \{ lte: at \}, OR: or \}/);
  assert.doesNotMatch(svc, /recordActivity|lastSeenAt|session/);
  const page = strip(read('app/(panel)/siparisler/[id]/page.tsx'));
  assert.doesNotMatch(page, /markOrderSeen\(db|markOrderSeenAction\(/, 'sayfa çizimi okundu yazmaz');
  assert.match(page, /<div id="notlar-liste" data-notes-open="1">/);
  const list = strip(read('app/(panel)/siparisler/page.tsx'));
  assert.match(list, /const alerts = await orderAlertsFor\(user, rows\.map\(\(o\) => o\.id\)\);/);
  // Müşteri listesi: kırmızı "Bir mesajınız var" (Paket B — karar 228), mesaj uyarıları dahil
  assert.match(list, /const alerts = await orderAlertsFor\(user, orders\.map\(\(o\) => o\.id\), \{ messages: true \}\);/);
  assert.match(list, /text=\{t\('orders\.alerts\.customer'\)\}/);
  // İlk mesaj çevirisi: sipariş kaydından sonra, hata siparişi bozmaz
  const fn = strip(read('app/(panel)/siparisler/yeni/actions.ts'));
  assert.match(fn, /async function firstNoteTranslation\(orderId: string, actor[^)]*\) \{\n\s+try \{\n\s+await translateOrderNote\(db, \{ orderId, actor \}\);\n\s+\} catch/);
});
