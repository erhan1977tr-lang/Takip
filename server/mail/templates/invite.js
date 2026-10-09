// Davet / doğrulama kodu e-postası — TR, RO, EN.
// Hem HTML hem düz metin sürüm üretir (düz metin, spam filtreleri ve eski istemciler için önemli).

import { brandedHtml } from '../layout.js';

const STRINGS = {
  tr: {
    subject: 'Takip hesabınız oluşturuldu — doğrulama kodunuz',
    hello: (n) => (n ? `Merhaba ${n},` : 'Merhaba,'),
    intro: (f) =>
      f
        ? `${f} için Takip sipariş portalında sizin adınıza bir hesap açıldı.`
        : 'Takip sipariş portalında sizin adınıza bir hesap açıldı.',
    steps:
      'Hesabınızı etkinleştirmek için aşağıdaki bağlantıyı açın (ya da giriş ekranındaki “ilk giriş” bağlantısını), kodu girin ve şifrenizi belirleyin.',
    codeLabel: 'Doğrulama kodunuz',
    validity: (h) => `Bu kod ${h} saat geçerlidir ve yalnızca bir kez kullanılabilir.`,
    button: 'Hesabı etkinleştir',
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
      'Pentru a vă activa contul, deschideți linkul de mai jos (sau linkul „prima autentificare” de pe ecranul de autentificare), introduceți codul și setați-vă parola.',
    codeLabel: 'Codul de verificare',
    validity: (h) => `Codul este valabil ${h} ore și poate fi folosit o singură dată.`,
    button: 'Activează contul',
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
      'To activate your account, open the link below (or the “first sign-in” link on the sign-in screen), enter the code and set your password.',
    codeLabel: 'Your verification code',
    validity: (h) => `This code is valid for ${h} hours and can be used only once.`,
    button: 'Activate account',
    ignore: "If you didn't request this account, you can ignore this email; the account will not be activated.",
    footer: 'This email was sent automatically, please do not reply.',
  },
};

// E-posta adresi değişikliği (karar 222): aynı kod / bağlantı akışı, farklı metin — hesap yeni adrese taşındı, şifre yeniden belirlenir
const EMAIL_CHANGE = {
  tr: {
    subject: 'Takip hesabınızın e-posta adresi değiştirildi — doğrulama kodunuz',
    intro: (f) => (f ? `${f} için Takip hesabınızın e-posta adresi yönetici tarafından bu adresle değiştirildi.` : 'Takip hesabınızın e-posta adresi yönetici tarafından bu adresle değiştirildi.'),
    steps: 'Güvenliğiniz için önceki oturumlar kapatıldı ve şifreniz sıfırlandı. Aşağıdaki bağlantıyı açın, kodu girin ve yeni şifrenizi belirleyin.',
    button: 'Şifremi belirle',
    ignore: 'Bu değişikliği beklemiyorsanız sistem yöneticinize haber verin.',
  },
  ro: {
    subject: 'Adresa de e-mail a contului dumneavoastră Takip a fost schimbată — codul de verificare',
    intro: (f) => (f ? `Adresa de e-mail a contului dumneavoastră Takip (${f}) a fost schimbată de administrator cu această adresă.` : 'Adresa de e-mail a contului dumneavoastră Takip a fost schimbată de administrator cu această adresă.'),
    steps: 'Pentru siguranța dumneavoastră, sesiunile anterioare au fost închise și parola a fost resetată. Deschideți linkul de mai jos, introduceți codul și setați o parolă nouă.',
    button: 'Setează parola',
    ignore: 'Dacă nu vă așteptați la această schimbare, anunțați administratorul sistemului.',
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
 * @param {string} [p.appUrl]    uygulamanın adresi
 * @param {string} [p.email]     alıcının e-postası: ilk giriş ekranı bu adresle açılır (kodun gönderildiği kişi zaten odur)
 * @param {'invite' | 'emailChange'} [p.purpose]  emailChange: yönetici e-posta adresini değiştirdi (karar 222)
 */
export function renderInviteEmail({ code, name, firmName, language = 'tr', ttlHours = 24, appUrl = '', email = '', purpose = 'invite' }) {
  if (!/^\d{6}$/.test(String(code))) throw new Error('Kod 6 haneli olmalı');
  const base = STRINGS[language] || STRINGS.tr;
  const change = purpose === 'emailChange' ? (Object.hasOwn(EMAIL_CHANGE, language) ? EMAIL_CHANGE[language] : EMAIL_CHANGE.tr) : null;
  const t = change ? { ...base, ...change } : base;
  const lang = STRINGS[language] ? language : 'tr';
  // İlk giriş ekranı (kod + şifre). Giriş ekranı davet bekleyen hesabı ayırt etmez (SEC-10); bağlantı doğrudan buraya gelir.
  const loginUrl = appUrl ? `${appUrl.replace(/\/+$/, '')}/setup${email ? `?email=${encodeURIComponent(email)}` : ''}` : '';
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

  // Ortak GKH düzeni (logo başlığı — server/mail/layout.js); burada yalnızca gövde üretilir
  const html = brandedHtml({ lang, title: t.subject, body: `<div style="font-size:20px;font-weight:bold;letter-spacing:0.5px;color:#1e293b;">TAKİP</div>
<div style="font-size:12px;color:#64748b;margin:2px 0 16px;">Sipariş, çizim onayı ve üretim takibi</div>
<div style="font-size:15px;line-height:1.55;color:#1e293b;">
  <p style="margin:0 0 12px;">${esc(t.hello(name))}</p>
  <p style="margin:0 0 12px;">${esc(t.intro(firmName))}</p>
  <p style="margin:0 0 20px;">${esc(t.steps)}</p>
</div>
<div style="background:#f1f5f9;border-radius:10px;padding:18px;text-align:center;">
  <div style="font-size:12px;color:#64748b;margin-bottom:6px;">${esc(t.codeLabel)}</div>
  <div style="font-size:32px;font-weight:bold;letter-spacing:6px;font-family:'Courier New',monospace;color:#1e3a8a;">${esc(spaced)}</div>
</div>
<p style="margin:12px 0 0;font-size:13px;color:#64748b;text-align:center;">${esc(t.validity(ttlHours))}</p>
${loginUrl ? `<p style="margin:22px 0 4px;text-align:center;">
  <a href="${esc(loginUrl)}" style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:8px;">${esc(t.button)}</a>
</p>` : ''}
<div style="margin-top:22px;font-size:12px;line-height:1.5;color:#94a3b8;">
  <p style="margin:0 0 8px;">${esc(t.ignore)}</p>
  <p style="margin:0;">${esc(t.footer)}</p>
</div>` });

  return { subject: t.subject, text, html };
}
