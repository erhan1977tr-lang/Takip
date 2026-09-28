// SMTP bağlantısı. nodemailer yalnızca burada yüklenir; şablon ve kod modülleri ona bağlı değildir.
import nodemailer from 'nodemailer';

export function createTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure, // 587'de STARTTLS'e zorla; şifre düz metin gitmesin
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

// Sunucuya bağlanıp kimlik doğrulamayı dener; mail göndermez.
export async function verifyTransport(transport) {
  await transport.verify();
  return true;
}
