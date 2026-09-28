// Davet kodu: üretme, saklanacak özetini çıkarma ve doğrulama.
// Kod veritabanına asla açık hâliyle yazılmaz; yalnızca HMAC özeti saklanır.
import crypto from 'node:crypto';

export const MAX_ATTEMPTS = 5;

export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function hashCode(code, email, secret) {
  if (!secret || String(secret).length < 32) {
    throw new Error('INVITE_CODE_SECRET en az 32 karakter olmalı');
  }
  return crypto.createHmac('sha256', secret).update(`${normEmail(email)}:${code}`).digest('hex');
}

/** Yeni davet kaydı için saklanacak alanlar (Prisma UserInvite modeliyle aynı). */
export function createInvite(email, secret, ttlHours = 24, now = new Date()) {
  const code = generateCode();
  return {
    code, // yalnızca e-postaya konur, veritabanına YAZILMAZ
    record: {
      codeHash: hashCode(code, email, secret),
      expiresAt: new Date(now.getTime() + ttlHours * 3_600_000),
      attempts: 0,
      usedAt: null,
    },
  };
}

/**
 * Girilen kodu kayıtla karşılaştırır. Her yanlış denemede attempts artırılmalıdır (çağıran kaydeder).
 * @returns {{ok: true} | {ok: false, reason: 'no_invite'|'used'|'expired'|'locked'|'wrong_code'}}
 */
export function checkInvite({ code, email, record, secret, now = new Date() }) {
  if (!record) return { ok: false, reason: 'no_invite' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (new Date(record.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if ((record.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (!/^\d{6}$/.test(String(code || '').trim())) return { ok: false, reason: 'wrong_code' };

  const expected = Buffer.from(record.codeHash, 'hex');
  const actual = Buffer.from(hashCode(String(code).trim(), email, secret), 'hex');
  const same = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return same ? { ok: true } : { ok: false, reason: 'wrong_code' };
}
