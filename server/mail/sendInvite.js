// Davet e-postası gönderimi. Taşıyıcı (transport) dışarıdan verilir; testte sahte taşıyıcı kullanılabilir.
import { renderInviteEmail } from './templates/invite.js';

/**
 * @param {object} transport  nodemailer taşıyıcısı ya da sendMail(msg) metodu olan herhangi bir nesne
 * @param {object} cfg        readMailConfig() çıktısı
 * @param {object} p          { to, code, name, firmName, language }
 * @returns {Promise<{messageId?: string}>}
 */
export async function sendInviteEmail(transport, cfg, { to, code, name, firmName, language }) {
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`Geçersiz alıcı adresi: "${to}"`);
  const { subject, text, html } = renderInviteEmail({
    code,
    name,
    firmName,
    language,
    ttlHours: cfg.inviteTtlHours,
    appUrl: cfg.appUrl,
  });
  const info = await transport.sendMail({ from: cfg.from, to, subject, text, html });
  return { messageId: info && info.messageId };
}
