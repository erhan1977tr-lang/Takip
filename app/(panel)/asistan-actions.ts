'use server';
// Panel AI asistanı (3.95.0, karar 290) — sunucu eylemi. Next server action'ları Origin denetimiyle gelir (CSRF);
// oturum ve ASSISTANT_PANEL yetkisi BURADA denetlenir, işçi kullanıcıyı ayrıca veritabanında yeniden denetler.
// Bu dosya yapay zekâ kodu / anahtarı içermez: soruyu imzalayıp işçinin iç adresine iletir (server/assistant/panel-client.js).
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getEnv } from '@/lib/env';
import { askPanel } from '@/server/assistant/panel-client.js';
import { PANEL_LIMITS } from '@/server/assistant/panel-protocol.js';
import { createRateLimiter } from '@/server/security/rate-limit.js';

export type AssistantResult = { ok: true; text: string } | { ok: false; code: string };

// Uygulama tarafında kaba ön sınır (işçinin kendi kullanıcı sınırlarından önce; işçiye boşuna istek gitmesin)
const appLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Soru sorar ya da (reset) bu kullanıcının sohbet belleğini işçide siler. */
export async function askAssistantAction(input: { question?: unknown; orderId?: unknown; reset?: unknown }): Promise<AssistantResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, code: 'SESSION' };
  if (!userCan(user, 'ASSISTANT_PANEL')) return { ok: false, code: 'FORBIDDEN' };
  const reset = input?.reset === true;
  const question = typeof input?.question === 'string' ? input.question.trim() : '';
  // Sayfa bağlamı yalnızca kimlik biçimindeyse iletilir; işçi siparişi veritabanından okur (yetki kaynağı değildir)
  const orderId = typeof input?.orderId === 'string' && ID_RE.test(input.orderId) ? input.orderId : null;
  if (!reset) {
    if (!question) return { ok: false, code: 'EMPTY' };
    if (question.length > PANEL_LIMITS.questionChars) return { ok: false, code: 'TOO_LONG' };
  }
  if (!appLimiter.take(user.id).ok) return { ok: false, code: 'RATE' };
  const env = getEnv();
  return askPanel({ url: env.ASSISTANT_PANEL_URL, authSecret: env.AUTH_SECRET, userId: user.id, question: reset ? '' : question, orderId, reset });
}
