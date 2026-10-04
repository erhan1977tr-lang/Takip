// Geliştirme/test/demo: MAIL_OUTBOX_DIR ayarlıysa e-posta gönderilmez, JSON dosyası olarak bu klasöre yazılır
// (lib/invite.ts de bu taşıyıcıyı kullanır). Ekler içerik yerine ad, tür, boyut ve (satır içi ekte — logo) Content-ID ile
// yazılır. Üretimde ayarlanmaz.
import fs from 'node:fs/promises';
import path from 'node:path';

/** @param {string} dir */
export function outboxTransport(dir) {
  return {
    async sendMail(m) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${String(m.to).replace(/[^a-z0-9@._-]/gi, '_')}.json`);
      const attachments = (m.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content?.length ?? 0, ...(a.cid ? { cid: a.cid } : {}) }));
      await fs.writeFile(file, JSON.stringify({ ...m, attachments }, null, 2));
      return { messageId: `outbox:${path.basename(file)}` };
    },
  };
}
