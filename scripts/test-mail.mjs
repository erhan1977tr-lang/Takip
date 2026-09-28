// Test maili: SMTP ayarlarını doğrular ve verilen adrese örnek bir davet e-postası yollar.
// Kullanım:  npm run mail:test -- adres@ornek.com [tr|ro|en]
import { readMailConfig } from '../server/mail/config.js';
import { createTransport, verifyTransport } from '../server/mail/transport.js';
import { sendInviteEmail } from '../server/mail/sendInvite.js';
import { generateCode } from '../server/auth/inviteCode.js';

const [to, language = 'tr'] = process.argv.slice(2);
if (!to) {
  console.error('Kullanım: npm run mail:test -- adres@ornek.com [tr|ro|en]');
  process.exit(1);
}

try {
  const cfg = readMailConfig();
  console.log(`SMTP: ${cfg.host}:${cfg.port} (${cfg.secure ? 'TLS' : 'STARTTLS'}) · kullanıcı: ${cfg.user}`);
  const transport = createTransport(cfg);

  process.stdout.write('Sunucuya bağlanılıyor ve giriş yapılıyor… ');
  await verifyTransport(transport);
  console.log('tamam');

  const code = generateCode();
  const { messageId } = await sendInviteEmail(transport, cfg, {
    to,
    code,
    name: 'Test Kullanıcısı',
    firmName: 'Test Firması',
    language,
  });
  console.log(`Gönderildi → ${to} · kod: ${code} · messageId: ${messageId}`);
  console.log('Gelmezse spam klasörüne bakın; orada ise alan adının SPF/DKIM kayıtlarını kontrol edin.');
} catch (err) {
  console.error('\nHATA:', err.message);
  const hint = {
    EAUTH: 'Kullanıcı adı/şifre reddedildi. Google/Microsoft ise normal şifre değil "uygulama şifresi" gerekir.',
    ECONNECTION: 'Sunucuya bağlanılamadı. SMTP_HOST ve SMTP_PORT doğru mu, sunucu bu portu dışarıya açıyor mu?',
    ETIMEDOUT: 'Zaman aşımı. Port engellenmiş olabilir (bazı ağlar 25/465/587 portlarını kapatır).',
    ESOCKET: 'TLS/bağlantı hatası. 465 için SMTP_SECURE=true, 587 için SMTP_SECURE=false deneyin.',
    EENVELOPE: 'Gönderen ya da alıcı adresi reddedildi. MAIL_FROM, SMTP_USER ile aynı alan adında mı?',
  }[err.code];
  if (hint) console.error('İpucu:', hint);
  process.exit(1);
}
