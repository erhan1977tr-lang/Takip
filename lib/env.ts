// Ortam değişkenlerine tek yerden erişim; tanım ve doğrulama server/env.js içinde (ADR 0011).
import { getEnv } from '../server/env.js';

export { getEnv };

export function authSecret(): string {
  const s: string = getEnv().AUTH_SECRET || '';
  if (s.length < 32) {
    throw new Error('AUTH_SECRET en az 32 karakter olmalı (.env.example dosyasına bakın).');
  }
  return s;
}

/** Çerezler yalnızca HTTPS üzerinden gönderilsin mi? Üretimde varsayılan: evet. */
export function secureCookies(): boolean {
  return getEnv().COOKIE_SECURE;
}

export function inviteTtlHours(): number {
  return getEnv().INVITE_CODE_TTL_HOURS;
}
