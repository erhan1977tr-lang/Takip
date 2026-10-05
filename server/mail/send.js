// E-posta gönderiminin tek giriş noktası (karar 129): TAKİP'in her e-postası buradan geçer ve ortak GKH başlığını alır.
// Yeni bir e-posta yolu yazarken taşıyıcının sendMail'ini DOĞRUDAN çağırmayın — sendBrandedMail kullanın
// (test/branding.test.js başka yerde doğrudan sendMail çağrısı olmadığını denetler).
// Gönderen kimliği de burada tek yerden verilir (karar 133): "GKH Trading Invest SRL <MAIL_FROM adresi>".
export { sendBrandedMail, brandMessage, brandedHtml, isBranded, mailLogoAttachment, mailSender, MAIL_LOGO_CID, MAIL_LOGO_WIDTH } from './layout.js';
