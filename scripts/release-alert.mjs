// Yayın / geri dönüş alarm e-postası (3.92.0, karar 287). YALNIZCA sunucu aracı çağırır (deploy/takip.sh → release_alert):
//   node scripts/release-alert.mjs TÜR --host AD --from SÜRÜM --to SÜRÜM --mode gozlem|otomatik [KOD …]
// Kodlar sabit listedendir (server/release/alert.js); başka metin e-postaya girmez. Alıcı: BACKUP_ALERT_EMAIL, yoksa etkin
// yöneticiler (yedek alarmıyla aynı). Çıkış: 0 hepsi aldı · 3 kısmen · 1 gönderilemedi. Çıktıda yalnızca sabit metin vardır.
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../server/env.js';
import { readMailConfig } from '../server/mail/config.js';
import { createTransport } from '../server/mail/transport.js';
import { outboxTransport } from '../server/mail/outbox-transport.js';
import { parseRecipients, resolveRecipients } from '../server/backup/alert.js';
import { sendReleaseAlert } from '../server/release/alert.js';

const args = process.argv.slice(2);
const kind = String(args.shift() ?? '');
let host = '';
let fromVersion = '';
let toVersion = '';
let mode = 'gozlem';
const codes = [];
while (args.length) {
  const a = args.shift();
  if (a === '--host') host = String(args.shift() ?? '');
  else if (a === '--from') fromVersion = String(args.shift() ?? '');
  else if (a === '--to') toVersion = String(args.shift() ?? '');
  else if (a === '--mode') mode = String(args.shift() ?? '');
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
  const r = await sendReleaseAlert({ ...mail, recipients, kind, codes, host, fromVersion, toVersion, mode });
  if (r.ok) { say(`yayın alarmı gönderildi (${r.sent} alıcı)`); code = 0; }
  else if (r.code === 'PARTIAL') { say(`yayın alarmı kısmen gönderildi (${r.sent} alıcı; ${r.failed} alıcıya gönderilemedi)`); code = 3; }
  else say(`yayın alarmı gönderilemedi: ${r.code}`);
} catch {
  // SMTP ayarı eksik / ortam hatalı: ayrıntı yazılmaz (ayar değeri sızmasın)
  say('yayın alarmı gönderilemedi: MAIL_CONFIG');
} finally {
  await db?.$disconnect().catch(() => {});
}
process.exit(code);
