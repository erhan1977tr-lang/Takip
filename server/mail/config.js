// SMTP ayarlarını ortam değişkenlerinden okur ve eksikleri tek seferde bildirir.
// Şifreler asla kodda ya da git'te durmaz; yalnızca sunucudaki .env dosyasında.

const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

export function readMailConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new Error(
      `E-posta ayarları eksik: ${missing.join(', ')}. .env.example dosyasına bakın.`
    );
  }

  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT geçersiz: "${env.SMTP_PORT}"`);
  }

  // 465 → doğrudan TLS; 587/25 → STARTTLS. SMTP_SECURE ile elle de belirlenebilir.
  const secure =
    env.SMTP_SECURE === undefined || env.SMTP_SECURE === ''
      ? port === 465
      : /^(1|true|yes)$/i.test(env.SMTP_SECURE);

  const ttlHours = Number(env.INVITE_CODE_TTL_HOURS || 24);

  return {
    host: env.SMTP_HOST.trim(),
    port,
    secure,
    user: env.SMTP_USER.trim(),
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM.trim(),
    appUrl: (env.APP_URL || '').trim().replace(/\/+$/, ''),
    inviteTtlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 24,
  };
}
