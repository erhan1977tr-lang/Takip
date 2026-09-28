import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { authSecret, secureCookies } from '../env';

// Kod doğrulandıktan sonra şifre adımına kadar taşınan kısa ömürlü, imzalı çerez.
const COOKIE = 'takip_setup';
const TTL_MS = 15 * 60_000;

type Payload = { inviteId: string; userId: string; exp: number };

function sign(data: string): string {
  return crypto.createHmac('sha256', authSecret()).update(`setup:${data}`).digest('base64url');
}

export async function setSetupToken(inviteId: string, userId: string): Promise<void> {
  const data = Buffer.from(JSON.stringify({ inviteId, userId, exp: Date.now() + TTL_MS })).toString('base64url');
  (await cookies()).set(COOKIE, `${data}.${sign(data)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/setup',
    maxAge: TTL_MS / 1000,
  });
}

export async function readSetupToken(): Promise<Payload | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [data, sig] = raw.split('.');
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString()) as Payload;
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export async function clearSetupToken(): Promise<void> {
  (await cookies()).delete({ name: COOKIE, path: '/setup' });
}
