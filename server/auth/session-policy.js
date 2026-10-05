// Oturum süreleri ve oturum kaydının kuralları (güvenlik denetimi SEC-11, karar 118; boşta kalma: karar 135).
// Çerez ve React tarafı lib/auth/session.ts'te; buradaki işlevler saf kural + veritabanı (testte saat verilir).
//   Mutlak ömür  : 30 gün — girişten sonra, kullanılsa da kullanılmasa da oturum biter (Session.expiresAt).
//   Boşta kalma  : 30 dakika — son GERÇEK kullanıcı etkinliğinden (Session.lastSeenAt) bu yana geçen süre.
//   Etkinlik     : yalnızca recordActivity yazar (tarayıcının etkinlik bildirimi: klavye / fare / dokunma). Sayfa
//                  istekleri, 60 saniyelik otomatik yenileme, bildirim yoklaması, dosya indirme ve arka plan işleri
//                  oturumu OKUR ama asla uzatmaz (liveSession hiçbir koşulda lastSeenAt yazmaz).
//   Temizlik     : geçersiz oturum satırı ilk görüldüğünde silinir; kalanları arka plan işçisi saatte bir siler.
export const SESSION_TTL_MS = 30 * 86_400_000;
export const SESSION_IDLE_MS = 30 * 60_000;

const ms = (d) => new Date(d).getTime();

/**
 * @param {{ expiresAt: Date | string | number, lastSeenAt: Date | string | number }} s
 * @param {number} [now]
 * @returns {'expired' | 'idle' | 'ok'}  expired: mutlak ömür doldu · idle: 30 dakikadır etkinlik yok · ok: geçerli
 */
export function sessionState(s, now = Date.now()) {
  if (ms(s.expiresAt) <= now) return 'expired';
  return now - ms(s.lastSeenAt) >= SESSION_IDLE_MS ? 'idle' : 'ok';
}

/** Oturumun kendiliğinden biteceği ana kalan süre (boşta kalma ya da mutlak ömür — hangisi önceyse); bitmişse 0. */
export function sessionRemainingMs(s, now = Date.now()) {
  return Math.max(0, Math.min(ms(s.lastSeenAt) + SESSION_IDLE_MS, ms(s.expiresAt)) - now);
}

/** Geçersiz oturumların sorgu koşulu (süresi dolmuş ya da boşta kalmış). */
export const deadSessions = (now = new Date()) => ({
  OR: [{ expiresAt: { lte: now } }, { lastSeenAt: { lte: new Date(now.getTime() - SESSION_IDLE_MS) } }],
});

/**
 * Çerezdeki oturumun geçerli kaydı; yoksa / kullanıcı pasifse / süresi dolmuşsa / boşta kalmışsa null.
 * SALT OKUR: geçerli oturumda hiçbir şey yazmaz (istek geldi diye oturum uzamaz). Geçersiz satırı siler.
 * @param {any} db  @param {string} tokenHash
 * @param {{ now?: number, include?: object }} [o]  include: kullanıcıyla birlikte yüklenecek ilişkiler
 * @returns {Promise<{ session: any | null, remainingMs: number, reason: 'ok' | 'none' | 'inactive' | 'expired' | 'idle' }>}
 *   session null ise `reason` nedenini söyler (idle: 30 dakikadır etkinlik yok)
 */
export async function liveSession(db, tokenHash, { now = Date.now(), include = { user: true } } = {}) {
  /** @param {'none' | 'inactive' | 'expired' | 'idle'} reason */
  const dead = (reason) => ({ session: null, remainingMs: 0, reason });
  if (!tokenHash) return dead('none');
  const session = await db.session.findUnique({ where: { tokenHash }, include });
  if (!session) return dead('none');
  if (!session.user?.isActive) return dead('inactive');
  const state = sessionState(session, now);
  if (state !== 'ok') {
    await db.session.deleteMany({ where: { id: session.id } }).catch(() => undefined);
    return dead(state);
  }
  return { session, remainingMs: sessionRemainingMs(session, now), reason: /** @type {const} */ ('ok') };
}

/**
 * Tarayıcının etkinlik bildirimi — oturumu uzatan TEK yol. `idleMs`: son gerçek etkinlikten bu yana geçen süre
 * (tarayıcı bildirimi en çok dakikada bir yollar; etkinlik anı = şimdi − idleMs).
 *   - Geçersiz (süresi dolmuş / boşta kalmış / silinmiş) oturum CANLANDIRILMAZ: 'expired'.
 *   - idleMs ≥ 30 dakika ("ben boştayım, oturum bitti mi?" sorusu) hiçbir şeyi uzatmaz; yalnızca durum döner.
 *   - Etkinlik anı ileriye doğru yazılır (geri alınmaz; gelecek bir an yazılamaz); mutlak ömür (30 gün) değişmez.
 * @param {any} db  @param {string} tokenHash  @param {{ idleMs?: unknown, now?: number }} [o]
 * @returns {Promise<{ state: 'active' | 'expired', remainingMs: number, extended: boolean, reason: string }>}
 */
export async function recordActivity(db, tokenHash, { idleMs = 0, now = Date.now() } = {}) {
  const live = await liveSession(db, tokenHash, { now, include: { user: { select: { isActive: true } } } });
  /** @param {string} reason */
  const gone = (reason) => ({ state: /** @type {const} */ ('expired'), remainingMs: 0, extended: false, reason });
  /** @param {number} remainingMs @param {boolean} extended */
  const active = (remainingMs, extended) => ({ state: /** @type {const} */ ('active'), remainingMs, extended, reason: 'ok' });
  if (!live.session) return gone(live.reason);
  const { session } = live;
  // Sayı olmayan / okunamayan değer etkinlik sayılmaz (uzatmaz)
  const idle = typeof idleMs === 'number' && Number.isFinite(idleMs) ? Math.max(0, idleMs) : SESSION_IDLE_MS;
  const at = new Date(now - idle);
  if (idle >= SESSION_IDLE_MS || at.getTime() <= ms(session.lastSeenAt)) return active(live.remainingMs, false);
  // Koşullu yazım: araya giren bir istek oturumu boşta saydıysa (ya da daha yeni bir etkinlik yazıldıysa) dokunulmaz
  const done = await db.session.updateMany({
    where: { id: session.id, expiresAt: { gt: new Date(now) }, lastSeenAt: { gt: new Date(now - SESSION_IDLE_MS), lt: at } },
    data: { lastSeenAt: at },
  });
  if (done.count) return active(sessionRemainingMs({ ...session, lastSeenAt: at }, now), true);
  const again = await liveSession(db, tokenHash, { now, include: { user: { select: { isActive: true } } } });
  return again.session ? active(again.remainingMs, false) : gone(again.reason);
}

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
