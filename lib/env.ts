// Ortam değişkenlerine tek yerden erişim.

export function authSecret(): string {
  const s = process.env.AUTH_SECRET || '';
  if (s.length < 32) {
    throw new Error('AUTH_SECRET en az 32 karakter olmalı (.env.example dosyasına bakın).');
  }
  return s;
}

/** Çerezler yalnızca HTTPS üzerinden gönderilsin mi? Üretimde varsayılan: evet. */
export function secureCookies(): boolean {
  if (process.env.COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export function inviteTtlHours(): number {
  const n = Number(process.env.INVITE_CODE_TTL_HOURS || 24);
  return Number.isFinite(n) && n > 0 ? n : 24;
}
