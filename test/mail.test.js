import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMailConfig } from '../server/mail/config.js';
import { renderInviteEmail } from '../server/mail/templates/invite.js';
import { sendInviteEmail } from '../server/mail/sendInvite.js';
import { generateCode, createInvite, checkInvite, hashCode, MAX_ATTEMPTS } from '../server/auth/inviteCode.js';

const SECRET = 'x'.repeat(64);
const baseEnv = { SMTP_HOST: 'mail.ornek.ro', SMTP_USER: 'noreply@ornek.ro', SMTP_PASS: 'p', MAIL_FROM: 'Takip <noreply@ornek.ro>' };

test('config: eksik alanlar tek hata mesajında', () => {
  assert.throws(() => readMailConfig({}), /SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM/);
});

test('config: port ve TLS varsayılanları', () => {
  assert.deepEqual([readMailConfig(baseEnv).port, readMailConfig(baseEnv).secure], [587, false]);
  assert.equal(readMailConfig({ ...baseEnv, SMTP_PORT: '465' }).secure, true);
  assert.equal(readMailConfig({ ...baseEnv, SMTP_PORT: '587', SMTP_SECURE: 'true' }).secure, true);
  assert.equal(readMailConfig({ ...baseEnv, APP_URL: 'https://a.ro/' }).appUrl, 'https://a.ro');
  assert.throws(() => readMailConfig({ ...baseEnv, SMTP_PORT: 'abc' }), /SMTP_PORT/);
});

test('şablon: üç dil, kod, süre ve bağlantı', () => {
  for (const [lang, word] of [['tr', 'Doğrulama'], ['ro', 'verificare'], ['en', 'verification']]) {
    const m = renderInviteEmail({ code: '482913', name: 'Ali', firmName: 'Ünsal Cam', language: lang, ttlHours: 24, appUrl: 'https://takip.ro' });
    assert.match(m.subject, new RegExp(word, 'i'));
    assert.match(m.text, /482913/);
    assert.match(m.html, /482 913/);
    assert.match(m.html, /https:\/\/takip\.ro\/setup/);
    assert.match(m.text, /24/);
    assert.match(m.html, new RegExp(`lang="${lang}"`));
  }
});

test('şablon: bilinmeyen dil Türkçeye düşer, HTML kaçışı yapılır', () => {
  const m = renderInviteEmail({ code: '000123', name: '<script>x</script>', firmName: 'A & B', language: 'de' });
  assert.match(m.subject, /Takip hesabınız/);
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /A &amp; B/);
  assert.doesNotMatch(m.html, /\/setup/); // appUrl yoksa düğme yok
});

test('şablon: geçersiz kod reddedilir', () => {
  assert.throws(() => renderInviteEmail({ code: '12345' }), /6 haneli/);
});

test('gönderim: doğru alanlarla sendMail çağrılır', async () => {
  const sent = [];
  const fake = { sendMail: async (m) => (sent.push(m), { messageId: '<id@x>' }) };
  const cfg = readMailConfig({ ...baseEnv, APP_URL: 'https://t.ro', INVITE_CODE_TTL_HOURS: '48' });
  const r = await sendInviteEmail(fake, cfg, { to: 'ali@unsal.ro', code: '123456', name: 'Ali', firmName: 'Ünsal', language: 'ro' });
  assert.equal(r.messageId, '<id@x>');
  // Gönderen (karar 133): görünen ad resmî firma adı, adres ayardaki adres (ayardaki "Takip" adı kullanılmaz)
  assert.equal(sent[0].from, 'GKH Trading Invest SRL <noreply@ornek.ro>');
  assert.equal(sent[0].to, 'ali@unsal.ro');
  assert.match(sent[0].text, /48 ore/);
  await assert.rejects(() => sendInviteEmail(fake, cfg, { to: 'bozuk', code: '123456' }), /Geçersiz alıcı/);
});

test('kod: her zaman 6 hane', () => {
  for (let i = 0; i < 2000; i++) assert.match(generateCode(), /^\d{6}$/);
});

test('kod: veritabanına açık kod yazılmaz, doğru kod kabul edilir', () => {
  const { code, record } = createInvite('Ali@Unsal.ro', SECRET, 24);
  assert.ok(!JSON.stringify(record).includes(code));
  assert.deepEqual(checkInvite({ code, email: 'ali@unsal.ro', record, secret: SECRET }), { ok: true });
});

test('kod: yanlış kod, başka e-posta, süre dolmuş, kullanılmış, kilitli', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const { code, record } = createInvite('a@b.ro', SECRET, 24, now);
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal(checkInvite({ code: wrong, email: 'a@b.ro', record, secret: SECRET, now }).reason, 'wrong_code');
  assert.equal(checkInvite({ code, email: 'baska@b.ro', record, secret: SECRET, now }).reason, 'wrong_code');
  assert.equal(checkInvite({ code, email: 'a@b.ro', record, secret: SECRET, now: new Date('2026-09-29T10:00:01Z') }).reason, 'expired');
  assert.equal(checkInvite({ code, email: 'a@b.ro', record: { ...record, usedAt: now }, secret: SECRET, now }).reason, 'used');
  assert.equal(checkInvite({ code, email: 'a@b.ro', record: { ...record, attempts: MAX_ATTEMPTS }, secret: SECRET, now }).reason, 'locked');
  assert.equal(checkInvite({ code, email: 'a@b.ro', record: null, secret: SECRET, now }).reason, 'no_invite');
});

test('kod: kısa gizli anahtar reddedilir', () => {
  assert.throws(() => hashCode('123456', 'a@b.ro', 'kisa'), /32 karakter/);
});
