// Müşterilere tek seferlik bilgi e-postası (4.2.33, karar 331): TAKİP'i ana ekrana ekleme ve telefon bildirimlerini açma.
// Metin sabittir (Türkçe / Romence), alıcının diliyle; yalnızca gövde üretilir, GKH düzeni (logo) server/mail/layout.js.
import { brandedHtml } from '../layout.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const TEXT = {
  tr: {
    subject: 'GKH TAKİP artık telefonunuzda: ana ekrana ekleyin, bildirimleri açın',
    hello: (n) => (n ? `Merhaba ${n},` : 'Merhaba,'),
    intro: 'GKH TAKİP portalını artık telefonunuzda bir uygulama gibi kullanabilirsiniz. Uygulama mağazasından bir şey indirmeniz gerekmez.',
    steps: [
      (url) => `Telefonunuzda ${url} adresini açın ve giriş yapın.`,
      () => 'Android (Chrome): sağ üstteki üç noktaya (⋮) dokunun → "Yükle ve kısayol oluştur" → "Sayfayı uygulama olarak yükle" → "Yükle". ("Kısayol oluştur"u seçmeyin.)',
      () => 'iPhone (Safari): alttaki Paylaş düğmesi (yukarı oklu kare; yeni iOS sürümlerinde önce "•••", sonra "Paylaş") → "Ana Ekrana Ekle" → "Ekle".',
      () => 'Ana ekrandaki TAKİP simgesinden açın, Ayarlar sayfasında "Bu cihazda bildirimleri aç" düğmesine basın ve izin verin.',
    ],
    after: 'Bundan sonra teklif, çizim onayı ve yükleme tarihi gibi bildirimler telefonunuza da gelir. Bildirimlerde tutar ve fiyat yazmaz; bildirime dokununca ilgili sipariş açılır. Bildirimleri aynı sayfadan istediğiniz zaman kapatabilirsiniz.',
    button: 'Adım adım anlatımı ve videoyu aç',
    guideHint: 'Ekran görüntülü anlatım ve kısa video:',
    questions: 'Sorularınız için bize her zamanki iletişim kanallarımızdan yazabilirsiniz.',
    sign: 'Saygılarımızla,\nGKH Trading Invest SRL',
  },
  ro: {
    subject: 'GKH TAKİP este acum pe telefonul dumneavoastră: adăugați-l pe ecranul principal și activați notificările',
    hello: (n) => (n ? `Bună ziua ${n},` : 'Bună ziua,'),
    intro: 'Portalul GKH TAKİP poate fi folosit acum pe telefon ca o aplicație. Nu trebuie să descărcați nimic din magazinul de aplicații.',
    steps: [
      (url) => `Deschideți pe telefon adresa ${url} și autentificați-vă.`,
      () => 'Android (Chrome): atingeți cele trei puncte (⋮) din dreapta sus → „Instalează și creează o comandă rapidă” → „Instalează pagina ca aplicație” → „Instalează”. (Nu alegeți „Creează o comandă rapidă”.)',
      () => 'iPhone (Safari): butonul Partajare de jos (pătratul cu săgeată în sus; pe iOS nou întâi „•••”, apoi „Partajare”) → „Mai multe”, dacă e nevoie → „Adăugați la ecranul principal” → „Adăugați”.',
      () => 'Deschideți TAKİP din pictograma de pe ecranul principal, apăsați pe pagina Setări butonul „Activează notificările pe acest dispozitiv” și permiteți notificările.',
    ],
    after: 'De acum, notificările despre oferte, aprobarea desenelor și data încărcării vă vor ajunge și pe telefon. Notificările nu conțin sume sau prețuri; atingând notificarea se deschide comanda respectivă. Le puteți dezactiva oricând din aceeași pagină.',
    button: 'Deschide ghidul pas cu pas și videoul',
    guideHint: 'Ghid cu imagini și video scurt:',
    questions: 'Pentru întrebări, vă rugăm să ne scrieți pe canalele de comunicare obișnuite.',
    sign: 'Cu stimă,\nGKH Trading Invest SRL',
  },
};

/**
 * @param {{ lang: 'tr' | 'ro', name?: string | null, appUrl: string }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderAnnouncementPwa({ lang, name = null, appUrl }) {
  const x = TEXT[lang === 'tr' ? 'tr' : 'ro'];
  const base = String(appUrl ?? '').replace(/\/+$/, '');
  // Dil çerezini yazıp herkese açık rehbere gider (/dil yalnızca çerez yazar; /kurulum oturum istemez)
  const link = `${base}/dil?l=${lang === 'tr' ? 'tr' : 'ro'}&next=/kurulum`;
  const steps = x.steps.map((f, i) => `${i + 1}. ${f(base)}`);
  const text = [x.hello(name), '', x.intro, '', ...steps, '', x.after, '', `${x.guideHint} ${link}`, '', x.questions, '', x.sign].join('\n');
  const body = `<p style="margin:0 0 12px">${esc(x.hello(name))}</p>
<p>${esc(x.intro)}</p>
<ol style="padding-left:20px">${x.steps.map((f) => `<li style="margin:0 0 8px">${esc(f(base))}</li>`).join('')}</ol>
<p>${esc(x.after)}</p>
<p style="margin:18px 0"><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px">${esc(x.button)}</a></p>
<p style="color:#6b7280">${esc(x.questions)}</p>
<p>${esc(x.sign).replace('\n', '<br>')}</p>`;
  return { subject: x.subject, text, html: brandedHtml({ lang: lang === 'tr' ? 'tr' : 'ro', title: x.subject, body }) };
}
