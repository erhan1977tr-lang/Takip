// Hatalı giriş/kod denemelerinin kaydı ve kilit kontrolü (kural: server/auth/throttle.js).
import { headers } from 'next/headers';
import { db } from '../db';
import { throttleState, WINDOW_MS } from '../../server/auth/throttle.js';
import { clientIp } from '../../server/i18n/detect.js';

export type ThrottleKind = 'LOGIN' | 'CODE';

export async function requestIp(): Promise<string> {
  const h = await headers();
  return clientIp((k: string) => h.get(k)) ?? 'unknown';
}

export async function throttleCheck(email: string, ip: string): Promise<{ locked: boolean; minutes?: number }> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    db.authFailure.findMany({ where: { email, createdAt: { gte: since } }, select: { createdAt: true, ip: true } }),
    db.authFailure.findMany({ where: { ip, createdAt: { gte: since } }, select: { createdAt: true } }),
  ]);
  const ms = (rows: { createdAt: Date }[]) => rows.map((r) => r.createdAt.getTime());
  return throttleState({ account: ms(byEmail.filter((r) => r.ip === ip)), email: ms(byEmail), ip: ms(byIp) }, Date.now());
}

export async function recordFailure(kind: ThrottleKind, email: string, ip: string): Promise<void> {
  await db.authFailure.create({ data: { kind, email: email.slice(0, 200), ip: ip.slice(0, 64) } });
  // Bir günden eski kayıtlar işe yaramaz; tablo büyümesin
  await db.authFailure.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
}

export async function clearFailures(email: string, ip: string): Promise<void> {
  await db.authFailure.deleteMany({ where: { email, ip } });
}
