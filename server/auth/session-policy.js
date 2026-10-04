// Oturum süreleri (güvenlik denetimi SEC-11, karar 118). Saf kural; oturum kaydı lib/auth/session.ts'te.
//   Mutlak ömür   : 30 gün — girişten sonra, kullanılsa da kullanılmasa da oturum biter (Session.expiresAt).
//   Boşta kalma   : 7 gün — bu süre boyunca hiç istek gelmeyen oturum geçersizdir (Session.lastSeenAt).
//   Etkinlik kaydı: lastSeenAt en çok 15 dakikada bir yazılır (her istekte veritabanına yazılmaz).
//   Temizlik      : süresi dolmuş / boşta kalmış oturum satırlarını arka plan işçisi saatte bir siler (pruneSessions).
export const SESSION_TTL_MS = 30 * 86_400_000;
export const SESSION_IDLE_MS = 7 * 86_400_000;
export const SESSION_TOUCH_MS = 15 * 60_000;

/**
 * @param {{ expiresAt: Date | string | number, lastSeenAt: Date | string | number }} s
 * @param {number} [now]
 * @returns {'expired' | 'idle' | 'touch' | 'ok'}  expired / idle: geçersiz · touch: geçerli, etkinlik kaydı yenilenmeli
 */
export function sessionState(s, now = Date.now()) {
  if (new Date(s.expiresAt).getTime() <= now) return 'expired';
  const idle = now - new Date(s.lastSeenAt).getTime();
  if (idle > SESSION_IDLE_MS) return 'idle';
  return idle >= SESSION_TOUCH_MS ? 'touch' : 'ok';
}

/** Geçersiz oturumların sorgu koşulu (süresi dolmuş ya da boşta kalmış). */
export const deadSessions = (now = new Date()) => ({
  OR: [{ expiresAt: { lte: now } }, { lastSeenAt: { lt: new Date(now.getTime() - SESSION_IDLE_MS) } }],
});

/**
 * Geçersiz oturum satırlarını siler (arka plan işçisi; kullanıcıyı etkilemez — bu oturumlar zaten kabul edilmiyordu).
 * Bir günden eski hatalı giriş kayıtları da aynı turda silinir (sınır 15 dakikalık pencereye bakar).
 * @param {any} db  @param {Date} [now]
 * @returns {Promise<{ sessions: number, failures: number }>}
 */
export async function pruneSessions(db, now = new Date()) {
  const sessions = await db.session.deleteMany({ where: deadSessions(now) });
  const failures = await db.authFailure.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  return { sessions: sessions.count, failures: failures.count };
}
