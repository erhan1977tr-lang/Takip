// TAKİP'in bütün HTML e-postalarının ORTAK düzeni (karar 129): üstte resmî GKH Trading Invest logosu, altında içerik.
// Logo e-postaya GÖMÜLÜR (satır içi ek, Content-ID) — dış adresten yüklenmez; bu yüzden alıcının posta programı
// uzaktaki görselleri engellese de görünür ve hiçbir sunucuya / geçici dosyaya bağlı değildir.
//   brandedHtml({ lang, title, body })  → tam HTML belge (şablonlar gövdeyi verir)
//   brandMessage(msg)                   → gönderilecek ileti: HTML markalı değilse sarılır, logo eki eklenir
//   sendBrandedMail(transport, msg)     → TEK gönderim noktası (server/mail/send.js bunu dışa verir)
//   mailSender(from)                    → gönderen kimliği: "GKH Trading Invest SRL <adres>" (karar 133) — görünen ad
//                                         her e-postada resmî firma adıdır; ADRES ayardan (MAIL_FROM) gelir, değişmez
// Düz metin (text) sürümüne dokunulmaz: HTML göstermeyen programlar e-postayı eskisi gibi okur.
// E-posta programlarıyla uyum: tablo düzeni, satır içi stiller, sabit genişlik niteliği (width) + height:auto
// (oran korunur; Outlook dahil), en fazla 600 px ve küçük ekranda tam genişlik.
// Logo saydam zeminli PNG'dir (koyu yazılı): başlık hücresi açıkça BEYAZDIR ve belge "yalnızca açık tema" olarak
// işaretlenir (color-scheme) — karanlık temayı uygulayan programlarda yazının zemine karışmaması için.
import { BRAND, brandLogoBytes } from '../branding/index.js';

/** Logonun e-posta içindeki kimliği (Content-ID) */
export const MAIL_LOGO_CID = 'gkh-logo@takip';
/** Logonun e-postadaki genişliği (px). Yükseklik verilmez (height:auto): posta programı oranı korur. */
export const MAIL_LOGO_WIDTH = 200;
const MARK = `cid:${MAIL_LOGO_CID}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** HTML zaten ortak düzende mi (logo başlığı var mı) */
export const isBranded = (html) => typeof html === 'string' && html.includes(MARK);

/** Ortak başlık: logo (oranı korunur) */
export function brandHeader() {
  return `<img src="${MARK}" width="${MAIL_LOGO_WIDTH}" alt="${esc(BRAND.company)}" title="${esc(BRAND.company)}" style="display:block;border:0;outline:none;text-decoration:none;width:${MAIL_LOGO_WIDTH}px;height:auto;max-width:100%;">`;
}

/**
 * Tam HTML e-posta: ortak başlık (logo) + gövde.
 * @param {{ lang?: string, title?: string, body: string }} p  body: şablonun ürettiği HTML parçası (kaçışlama şablonda)
 * @returns {string}
 */
export function brandedHtml({ lang = 'ro', title = '', body }) {
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;">
<tr><td bgcolor="#ffffff" style="padding:18px 24px 14px;border-bottom:1px solid #e2e8f0;background:#ffffff;border-radius:10px 10px 0 0;">${brandHeader()}</td></tr>
<tr><td style="padding:20px 24px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111827;">
${body}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** Logonun satır içi eki (nodemailer: cid → multipart/related) */
export function mailLogoAttachment() {
  return { filename: BRAND.logo.file, content: brandLogoBytes(), contentType: BRAND.logo.mime, cid: MAIL_LOGO_CID, contentDisposition: 'inline' };
}

const ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+$/;
/**
 * Gönderen kimliği (karar 133): görünen ad her zaman resmî firma adı (BRAND.company), adres ayarlanan gönderen adresi.
 * Girdi "info@gkh.ro", "Takip <info@gkh.ro>" ya da { name, address } olabilir; ayardaki ad kullanılmaz, adres AYNEN kalır
 * (SMTP zarfı / kimlik doğrulaması değişmez). Geçerli bir adres bulunamazsa girdi olduğu gibi döner (ad uydurulmaz).
 * @param {unknown} from
 * @returns {any}
 */
export function mailSender(from) {
  const raw = from && typeof from === 'object' ? String(/** @type {any} */ (from).address ?? '') : String(from ?? '');
  // Tek bir gönderen beklenir: birden çok adres içeren girdiye dokunulmaz
  if ((raw.match(/</g) ?? []).length > 1) return from;
  const m = /<([^<>]*)>\s*$/.exec(raw);
  const address = (m ? m[1] : raw).trim();
  return ADDRESS.test(address) ? `${BRAND.company} <${address}>` : from;
}

/** Markasız bir HTML belgenin gövdesi (<body> içi); parça ise kendisi */
const bodyOf = (html) => {
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return m ? m[1] : html;
};

/**
 * Gönderilecek iletiyi ortak düzene sokar. HTML'i olan her ileti logoyla gider: şablon ortak düzeni kullanmadıysa
 * burada sarılır (yeni yazılan şablon markayı unutamaz); logo eki bir kez eklenir (öbür ekler — PDF — aynen, önde kalır).
 * HTML'i olmayan (yalnızca düz metin) ileti gövdesiyle olduğu gibi gider. Alıcı, konu, metin, ekler ve varsa yanıt
 * adresi (replyTo) DEĞİŞMEZ; gönderenin yalnızca GÖRÜNEN ADI resmî firma adı olur (mailSender), adresi aynı kalır.
 * @param {{ html?: string, text?: string, subject?: string, lang?: string, attachments?: any[], [k: string]: any }} msg
 */
export function brandMessage({ lang = undefined, ...rest }) {
  // Gönderen kimliği her iletide (düz metin dahil) aynı: resmî firma adı + ayarlanan adres
  const msg = rest.from == null ? rest : { ...rest, from: mailSender(rest.from) };
  if (!msg.html) return msg;
  const html = isBranded(msg.html) ? msg.html : brandedHtml({ lang, title: msg.subject ?? '', body: bodyOf(msg.html) });
  const others = (msg.attachments ?? []).filter((a) => a?.cid !== MAIL_LOGO_CID);
  return { ...msg, html, attachments: [...others, mailLogoAttachment()] };
}

/**
 * TAKİP'in e-posta gönderdiği TEK nokta: iletiyi ortak düzene sokar (gönderen kimliği + logo) ve taşıyıcıya verir. Taşıyıcı (SMTP ya da testte
 * sahte / klasöre yazan taşıyıcı) dışarıdan gelir; burada ağ bağlantısı kurulmaz.
 * @param {{ sendMail: (m: object) => Promise<any> }} transport
 * @param {Parameters<typeof brandMessage>[0]} msg
 */
export function sendBrandedMail(transport, msg) {
  return transport.sendMail(brandMessage(msg));
}
