// Güvenlik denetimi 3.93.2 düşük bulguları (karar 289): imzalı sonuç süresi ve kullanıcı bağı (Y-5), tarayıcıda açma içerik
// denetimi ve başlıklar (Y-7), FGO yönlendirmesi, boş KDV (NEW-GL-05), scrypt maliyeti (AUD-14), giriş yarışı (NEW-GL-13),
// izlenen dal / günlük izinleri (Y-10). Gerçek FGO'ya istek YOK: fetch sahte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signResult, verifyResult, RESULT_TTL_MS } from '../server/security/signed-param.js';
import { FILE_SECURITY_HEADERS, inlineMime } from '../server/files/preview.js';
import { needsRehash, verifyPassword, hashPassword } from '../server/auth/password-hash.js';
import { fgoStatus, validateFgoSettings, fgoEmit, FgoError, uncertainEmit } from '../server/integrations/fgo.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SECRET = 's'.repeat(40);

test('imzalı sonuç: yalnızca işlemi yapan kullanıcıya ve kısa süreye geçerli', () => {
  const now = 1_800_000_000_000;
  const { sig, exp } = signResult({ secret: SECRET, scope: 'error:warehouse', userId: 'u1', values: ['a@b.test', ''], now });
  const v = (o) => verifyResult({ secret: SECRET, scope: 'error:warehouse', userId: 'u1', values: ['a@b.test', ''], sig, exp, now, ...o });
  assert.equal(v({}), true);
  assert.equal(v({ userId: 'u2' }), false, 'başka kullanıcıya gönderilen adres geçersiz');
  assert.equal(v({ now: now + RESULT_TTL_MS + 1000 }), false, 'süresi dolmuş');
  assert.equal(v({ values: ['Sahte uyarı: şifrenizi girin', ''] }), false);
  assert.equal(v({ exp: String(Number(exp) + 60) }), false, 'süre uzatılamaz');
  assert.equal(v({ exp: undefined }), false);
  assert.equal(v({ userId: null }), false);
});

test('silme bandı ve ayar sonuçları imzalı adresle gösterilir (yapı)', () => {
  const list = read('app/(panel)/siparisler/page.tsx');
  assert.match(list, /verifyResult\(\{ secret: getEnv\(\)\.AUTH_SECRET, scope: 'removed', userId/);
  assert.match(list, /const sp = removedOk \? raw : \{ \.\.\.raw, silindi: undefined, iade: undefined \}/);
  assert.match(read('app/(panel)/siparisler/[id]/compensation-actions.ts'), /signResult\(\{ secret, scope: 'removed', userId: user\.id/);
  const settings = read('app/(panel)/admin/entegrasyonlar/actions.ts');
  assert.doesNotMatch(settings, /signedBack\(\{/);
  assert.match(read('app/(panel)/admin/entegrasyonlar/page.tsx'), /verifyResult\(\{ secret: getEnv\(\)\.AUTH_SECRET, scope: resultScope, userId: user\.id/);
});

test('tarayıcıda açma: yalnızca dosya başı uzantıyla uyuşursa; karışık PDF/HTML indirilir', () => {
  const pdf = Buffer.from('%PDF-1.7\n...');
  const html = Buffer.from('<html><script>alert(1)</script>%PDF-1.4');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(inlineMime('a.pdf', pdf), 'application/pdf');
  assert.equal(inlineMime('a.pdf', html), null);
  assert.equal(inlineMime('a.png', png), 'image/png');
  assert.equal(inlineMime('a.jpg', png), null);
  assert.equal(inlineMime('a.html', pdf), null);
  assert.equal(inlineMime('a.svg', Buffer.from('<svg')), null);
  assert.match(FILE_SECURITY_HEADERS['Content-Security-Policy'], /^sandbox/);
  assert.equal(FILE_SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
  const route = read('app/dosya/[kind]/[id]/route.ts');
  assert.match(route, /\.\.\.FILE_SECURITY_HEADERS,\n\s+'Content-Type': mime \?\? 'application\/octet-stream'/);
  assert.doesNotMatch(route, /ext in INLINE/);
});

test('boş KDV %0 sayılmaz; açıkça "0" kabul edilir', () => {
  const base = { enabled: true, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura' };
  for (const vatRate of ['', '   ', undefined, null, 'yok']) assert.ok(validateFgoSettings({ ...base, vatRate }).errors?.includes('VAT'), String(vatRate));
  assert.equal(validateFgoSettings({ ...base, vatRate: '0' }).value?.vatRate, 0);
  assert.equal(validateFgoSettings({ ...base, vatRate: '21' }).value?.vatRate, 21);
  assert.equal(validateFgoSettings({ ...base, vatRate: '19,5' }).value?.vatRate, 19.5);
});

test('FGO: yönlendirme izlenmez; belge kesen istekte sonuç belirsiz, okuma isteğinde belge "yok" sayılmaz', async () => {
  const seen = [];
  const redirect = async (url, init) => {
    seen.push(init.redirect);
    return { status: 307, type: 'basic', headers: new Headers({ location: 'https://evil.example/x' }), body: { cancel: async () => {} }, text: async () => '' };
  };
  const settings = { env: 'test', cui: '123', proformaSeries: 'PRF', invoiceSeries: 'GKH' };
  await assert.rejects(fgoEmit(settings, { Serie: 'PRF' }, redirect), (e) => e instanceof FgoError && uncertainEmit(e) && e.retry === false);
  await assert.rejects(fgoStatus(settings, 'K', { series: 'PRF', number: '1' }, redirect), (e) => e instanceof FgoError && !/nu exista|not found/i.test(e.message));
  assert.ok(seen.length >= 2 && seen.every((r) => r === 'manual'));
});

test('scrypt: yeni özet güncel maliyetle; eski özet geçerli ve yenilenmeli; aşırı / bozuk parametre reddedilir', async () => {
  const h = await hashPassword('Uzun-bir-parola-1');
  assert.match(h, /^scrypt\$16384\$8\$5\$/);
  assert.equal(needsRehash(h), false);
  assert.equal(await verifyPassword('Uzun-bir-parola-1', h), true);
  const legacy = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);
  assert.equal(needsRehash(legacy), true);
  for (const bad of ['scrypt$1073741824$8$1$AA$AA', 'scrypt$16384$1024$1$AA$AA', 'scrypt$16384$8$100$AA$AA', 'scrypt$1000$8$1$AA$AA']) {
    assert.equal(await verifyPassword('x', bad), false, bad);
  }
  const login = read('app/login/actions.ts');
  assert.match(login, /createSession\(user\.id, \{ expectHash: user\.passwordHash \?\? '' \}\)/);
  assert.match(login, /needsRehash\(user\.passwordHash\)/);
  assert.match(login, /updateMany\(\{ where: \{ id: user\.id, passwordHash: user\.passwordHash \}/);
  assert.match(read('lib/auth/session.ts'), /FOR UPDATE/);
});

test('takip dal: yalnızca root, geçerli dal adı; günlük klasörü 0750', () => {
  const sh = read('deploy/takip.sh');
  assert.match(sh, /dal\)\n(?:.*\n){0,3}\s+require_root dal \|\| return 1/);
  assert.match(sh, /chmod 0750 "\$LOGS"/);
});
