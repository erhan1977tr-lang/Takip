// Davet / doğrulama kodu e-postası — TR, RO, EN.
// Hem HTML hem düz metin sürüm üretir (düz metin, spam filtreleri ve eski istemciler için önemli).

const STRINGS = {
  tr: {
    subject: 'Takip hesabınız oluşturuldu — doğrulama kodunuz',
    hello: (n) => (n ? `Merhaba ${n},` : 'Merhaba,'),
    intro: (f) =>
      f
        ? `${f} için Takip sipariş portalında sizin adınıza bir hesap açıldı.`
        : 'Takip sipariş portalında sizin adınıza bir hesap açıldı.',
    steps:
      'Hesabınızı etkinleştirmek için giriş ekranında e-posta adresinizi yazın, ardından aşağıdaki kodu girin ve şifrenizi belirleyin.',
    codeLabel: 'Doğrulama kodunuz',
    validity: (h) => `Bu kod ${h} saat geçerlidir ve yalnızca bir kez kullanılabilir.`,
    button: 'Giriş ekranına git',
    ignore: 'Bu hesabı siz talep etmediyseniz bu e-postayı dikkate almayın; hesap etkinleşmez.',
    footer: 'Bu e-posta otomatik olarak gönderilmiştir, lütfen yanıtlamayın.',
  },
  ro: {
    subject: 'Contul dumneavoastră Takip a fost creat — codul de verificare',
    hello: (n) => (n ? `Bună ziua, ${n},` : 'Bună ziua,'),
    intro: (f) =>
      f
        ? `A fost creat un cont pe numele dumneavoastră în portalul de comenzi Takip, pentru ${f}.`
        : 'A fost creat un cont pe numele dumneavoastră în portalul de comenzi Takip.',
    steps:
      'Pentru a vă activa contul, introduceți adresa de e-mail pe ecranul de autentificare, apoi codul de mai jos, și setați-vă parola.',
    codeLabel: 'Codul de verificare',
    validity: (h) => `Codul este valabil ${h} ore și poate fi folosit o singură dată.`,
    button: 'Mergi la autentificare',
    ignore: 'Dacă nu ați solicitat acest cont, ignorați acest e-mail; contul nu va fi activat.',
    footer: 'Acest e-mail a fost trimis automat, vă rugăm să nu răspundeți.',
  },
  en: {
    subject: 'Your Takip account has been created — verification code',
    hello: (n) => (n ? `Hello ${n},` : 'Hello,'),
    intro: (f) =>
      f
        ? `An account has been created for you on the Takip order portal for ${f}.`
        : 'An account has been created for you on the Takip order portal.',
    steps:
      'To activate your account, enter your email address on the sign-in screen, then enter the code below and set your password.',
    codeLabel: 'Your verification code',
    validity: (h) => `This code is valid for ${h} hours and can be used only once.`,
    button: 'Go to sign-in',
    ignore: "If you didn't request this account, you can ignore this email; the account will not be activated.",
    footer: 'This email was sent automatically, please do not reply.',
  },
};

export const SUPPORTED_LANGUAGES = Object.keys(STRINGS);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * @param {object} p
 * @param {string} p.code        6 haneli kod
 * @param {string} [p.name]      kullanıcının adı
 * @param {string} [p.firmName]  atandığı firma
 * @param {string} [p.language]  'tr' | 'ro' | 'en' (varsayılan tr)
 * @param {number} [p.ttlHours]  geçerlilik süresi
 * @param {string} [p.appUrl]    giriş ekranının adresi
 */
export function renderInviteEmail({ code, name, firmName, language = 'tr', ttlHours = 24, appUrl = '' }) {
  if (!/^\d{6}$/.test(String(code))) throw new Error('Kod 6 haneli olmalı');
  const t = STRINGS[language] || STRINGS.tr;
  const lang = STRINGS[language] ? language : 'tr';
  const loginUrl = appUrl ? `${appUrl.replace(/\/+$/, '')}/login` : '';
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

  const text = [
    t.hello(name),
    '',
    t.intro(firmName),
    t.steps,
    '',
    `${t.codeLabel}: ${code}`,
    t.validity(ttlHours),
    ...(loginUrl ? ['', `${t.button}: ${loginUrl}`] : []),
    '',
    t.ignore,
    '',
    '—',
    t.footer,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
        <tr><td style="padding:28px 28px 8px;">
          <div style="font-size:22px;font-weight:bold;letter-spacing:0.5px;">TAKİP</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Sipariş, çizim onayı ve üretim takibi</div>
        </td></tr>
        <tr><td style="padding:16px 28px 0;font-size:15px;line-height:1.55;">
          <p style="margin:0 0 12px;">${esc(t.hello(name))}</p>
          <p style="margin:0 0 12px;">${esc(t.intro(firmName))}</p>
          <p style="margin:0 0 20px;">${esc(t.steps)}</p>
        </td></tr>
        <tr><td style="padding:0 28px;">
          <div style="background:#f1f5f9;border-radius:10px;padding:18px;text-align:center;">
            <div style="font-size:12px;color:#64748b;margin-bottom:6px;">${esc(t.codeLabel)}</div>
            <div style="font-size:32px;font-weight:bold;letter-spacing:6px;font-family:'Courier New',monospace;color:#1e3a8a;">${esc(spaced)}</div>
          </div>
          <p style="margin:12px 0 0;font-size:13px;color:#64748b;text-align:center;">${esc(t.validity(ttlHours))}</p>
        </td></tr>
        ${loginUrl ? `<tr><td align="center" style="padding:22px 28px 4px;">
          <a href="${esc(loginUrl)}" style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:8px;">${esc(t.button)}</a>
        </td></tr>` : ''}
        <tr><td style="padding:22px 28px 26px;font-size:12px;line-height:1.5;color:#94a3b8;">
          <p style="margin:0 0 8px;">${esc(t.ignore)}</p>
          <p style="margin:0;">${esc(t.footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: t.subject, text, html };
}
