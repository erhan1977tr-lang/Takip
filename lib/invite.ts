import { db } from './db';
import { authSecret, getEnv, inviteTtlHours } from './env';
import { createInvite } from '../server/auth/inviteCode.js';
import { readMailConfig } from '../server/mail/config.js';
import { sendInviteEmail } from '../server/mail/sendInvite.js';
import { outboxTransport } from '../server/mail/outbox-transport.js';

type Mailer = { sendMail: (m: Record<string, unknown>) => Promise<{ messageId?: string }> };
type MailCfg = ReturnType<typeof readMailConfig>;

/**
 * MAIL_OUTBOX_DIR ayarlıysa e-posta gönderilmez, JSON dosyası olarak bu klasöre yazılır
 * (yalnızca geliştirme ve otomatik testler için; üretimde ayarlanmaz).
 */
async function getMailer(): Promise<{ mailer: Mailer; cfg: MailCfg }> {
  const env = getEnv();
  const outbox: string | undefined = env.MAIL_OUTBOX_DIR;
  if (outbox) {
    const cfg = {
      host: 'outbox', port: 0, secure: false, user: '', pass: '',
      from: env.MAIL_FROM || 'Takip <noreply@localhost>',
      appUrl: env.APP_URL || '',
      inviteTtlHours: inviteTtlHours(),
    };
    return { mailer: outboxTransport(outbox) as Mailer, cfg };
  }
  const cfg = readMailConfig();
  const { createTransport } = await import('../server/mail/transport.js');
  return { mailer: createTransport(cfg) as unknown as Mailer, cfg };
}

export type InviteResult = { sent: boolean; error?: string };

/**
 * Kullanıcı için yeni bir davet kodu üretir; eski açık davetleri kapatır.
 * send=true ise e-postayı gönderir; false ise kod e-postası sonradan "Davet gönder" ile yollanır.
 */
export async function issueInvite(
  userId: string,
  opts: { send: boolean }
): Promise<InviteResult> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { customer: true } });
  const { code, record } = createInvite(user.email, authSecret(), inviteTtlHours());

  const invite = await db.$transaction(async (tx) => {
    await tx.userInvite.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    return tx.userInvite.create({ data: { userId, codeHash: record.codeHash, expiresAt: record.expiresAt } });
  });

  if (!opts.send) return { sent: false };

  try {
    const { mailer, cfg } = await getMailer();
    await sendInviteEmail(mailer, cfg, {
      to: user.email,
      code,
      name: user.name,
      firmName: user.customer?.name,
      language: user.language,
    });
    await db.userInvite.update({ where: { id: invite.id }, data: { sentAt: new Date() } });
    return { sent: true };
  } catch (err) {
    console.error('Davet e-postası gönderilemedi:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, error: msg };
  }
}

/** Kullanıcının durumu: aktif / davet gönderildi / davet edilmedi. */
export async function inviteStatus(userId: string, hasPassword: boolean) {
  if (hasPassword) return { state: 'active' as const };
  const inv = await db.userInvite.findFirst({ where: { userId, usedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!inv) return { state: 'none' as const };
  if (!inv.sentAt) return { state: 'not_sent' as const };
  if (inv.expiresAt <= new Date()) return { state: 'expired' as const };
  return { state: 'sent' as const, expiresAt: inv.expiresAt };
}
