// Yedek alarm e-postası (P7, karar 249). YALNIZCA sunucu aracı çağırır (deploy/takip.sh → backup_alert):
//   node scripts/backup-alert.mjs FAIL|RECOVERED [--age SAAT] [--host AD] [KOD …]
// Kodlar sabit listedendir (server/backup/alert.js); başka metin e-postaya girmez. Alıcı: BACKUP_ALERT_EMAIL, yoksa etkin
// yöneticiler. Çıkış: 0 gönderildi · 1 gönderilemedi (sunucu aracı bir sonraki denetimde yeniden dener). Çıktıda yalnızca
// sabit metin ve kodlar vardır (adres, şifre, hata metni yazılmaz).
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../server/env.js';
import { readMailConfig } from '../server/mail/config.js';
import { createTransport } from '../server/mail/transport.js';
import { outboxTransport } from '../server/mail/outbox-transport.js';
import { cleanAge, parseRecipients, resolveRecipients, sendBackupAlert } from '../server/backup/alert.js';

const args = process.argv.slice(2);
const kind = args.shift();
let age = null;
let host = '';
const codes = [];
while (args.length) {
  const a = args.shift();
  if (a === '--age') age = cleanAge(args.shift());
  else if (a === '--host') host = String(args.shift() ?? '');
  else codes.push(a);
}

const say = (s) => process.stdout.write(`${s}\n`);
let code = 1;
let db = null;
try {
  const env = getEnv();
  let mail;
  if (env.MAIL_OUTBOX_DIR) mail = { transport: outboxTransport(env.MAIL_OUTBOX_DIR), from: env.MAIL_FROM || 'noreply@localhost' };
  else {
    const cfg = readMailConfig(process.env);
    mail = { transport: createTransport(cfg), from: cfg.from };
  }
  let configured = [];
  try { configured = parseRecipients(env.BACKUP_ALERT_EMAIL ?? ''); } catch { configured = []; }
  if (!configured.length) db = new PrismaClient();
  const recipients = await resolveRecipients({ configured, db });
  const r = await sendBackupAlert({ ...mail, recipients, kind, codes, host, ageHours: age });
  if (r.ok) { say(`yedek alarmı gönderildi (${kind}, ${r.sent} alıcı)`); code = 0; }
  else say(`yedek alarmı gönderilemedi: ${r.code}`);
} catch {
  // SMTP ayarı eksik / ortam hatalı: ayrıntı yazılmaz (ayar değeri sızmasın)
  say('yedek alarmı gönderilemedi: MAIL_CONFIG');
} finally {
  await db?.$disconnect().catch(() => {});
}
process.exit(code);
