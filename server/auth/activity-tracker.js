// Tarayıcıdaki etkinlik izleyicisinin kuralları (karar 135) — saf mantık; saat, zamanlayıcı ve ağ dışarıdan verilir
// (components/SessionActivity.tsx gerçeklerini, testler sahtelerini verir). Sunucu kuralı: server/auth/session-policy.js.
//
//   - Sunucuya istek YALNIZCA gerçek kullanıcı etkinliği olduğunda gider: ilk etkinlik hemen, süren etkinlik en çok
//     `reportMs`te (1 dakika) bir. Etkinlik yoksa hiçbir istek yoktur (kalp atışı / yoklama döngüsü değildir).
//   - Bildirim, son etkinliğin YAŞINI taşır (şimdi − son etkinlik): sunucu etkinlik anını buna göre yazar; bildirim
//     gecikse de oturum fazladan uzamaz.
//   - `sync(kalan)`: sunucunun bildirdiği kalan süre (sayfa her yenilendiğinde düzen bileşeninden, her bildirimin
//     yanıtından). Başka sekmedeki etkinlik bu yolla öğrenilir; sekmeler arası ayrı bir kanal yoktur.
//   - Süre dolduğunda oturum istemcide kapatılmaz: sunucuya sorulur (uzatmayan tek istek). Sunucu "bitti" derse giriş
//     sayfasına gidilir; "sürüyor" derse (başka sekmede etkinlik olmuş) zamanlayıcı sunucunun süresine kurulur.
export const ACTIVITY_REPORT_MS = 60_000;
export const IDLE_CHECK_GRACE_MS = 1_000;
/** Etkinlik bildiriminin adresi ve zorunlu başlığı (başka siteden yollanamayan özel başlık) */
export const ACTIVITY_URL = '/oturum/etkinlik';
export const ACTIVITY_HEADER = 'x-takip-activity';
/** Bir oturumdan dakikada en çok bu kadar bildirim kabul edilir (olağan kullanım: sekme başına dakikada en çok bir) */
export const ACTIVITY_RATE_LIMIT = 30;

/**
 * @param {{
 *   remainingMs: number, idleMs: number, reportMs?: number, graceMs?: number,
 *   now?: () => number,
 *   send: (idleMs: number) => Promise<{ state: 'active', remainingMs: number } | { state: 'expired' }>,
 *   setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (id: any) => void,
 *   onExpired: (reason: 'idle' | 'ended') => void,
 * }} o
 */
export function createActivityTracker({
  remainingMs, idleMs, reportMs = ACTIVITY_REPORT_MS, graceMs = IDLE_CHECK_GRACE_MS,
  now = Date.now, send, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), onExpired,
}) {
  /** @type {number | null} */ let lastActivity = null; // son gerçek etkinlik
  /** @type {number | null} */ let confirmed = null; // sunucunun aldığı en son etkinlik
  /** @type {number | null} */ let sending = null; // yoldaki bildirimin taşıdığı etkinlik
  let lastSent = -Infinity;
  let deadline = now() + Math.max(0, remainingMs);
  let reportTimer = null;
  let idleTimer = null;
  let checking = false;
  let stopped = false;

  const unreported = () => lastActivity != null && (confirmed == null || lastActivity > confirmed);

  function stop() {
    stopped = true;
    if (reportTimer != null) clearTimer(reportTimer);
    if (idleTimer != null) clearTimer(idleTimer);
    reportTimer = idleTimer = null;
  }
  function expire(reason) {
    if (stopped) return;
    stop();
    onExpired(reason);
  }
  function scheduleIdle(delay = Math.max(0, deadline - now()) + graceMs) {
    if (stopped) return;
    if (idleTimer != null) clearTimer(idleTimer);
    idleTimer = setTimer(onIdle, delay);
  }
  function scheduleReport() {
    if (stopped || reportTimer != null || sending != null) return;
    reportTimer = setTimer(flush, Math.max(0, lastSent + reportMs - now()));
  }
  /** Sunucunun bildirdiği kalan süre: bildirilmemiş yerel etkinlik varsa o da hesaba katılır */
  function sync(remaining) {
    if (stopped || !Number.isFinite(remaining)) return;
    const t = now();
    deadline = t + Math.max(0, remaining);
    if (unreported() && /** @type {number} */ (lastActivity) + idleMs > deadline) deadline = /** @type {number} */ (lastActivity) + idleMs;
    scheduleIdle();
  }
  function flush() {
    reportTimer = null;
    if (stopped || sending != null || !unreported()) return;
    const t = now();
    const mark = /** @type {number} */ (lastActivity);
    if (t - mark >= idleMs) return; // artık uzatamaz: süre denetimi karar verir
    sending = mark;
    lastSent = t;
    send(t - mark).then((res) => {
      sending = null;
      if (stopped) return;
      if (!res || res.state !== 'active') return expire(now() >= deadline ? 'idle' : 'ended');
      confirmed = mark;
      sync(res.remainingMs);
      if (unreported()) scheduleReport();
    }, () => {
      // Ağ hatası: etkinlik bildirilmemiş sayılır; bir sonraki turda yeniden denenir
      sending = null;
      if (unreported()) scheduleReport();
    });
  }
  /** Süre doldu görünüyor: sunucuya sorulur (bu istek oturumu uzatmaz) */
  function check(after) {
    if (stopped || checking) return;
    checking = true;
    send(idleMs).then((res) => {
      checking = false;
      if (stopped) return;
      if (!res || res.state !== 'active') return expire('idle');
      sync(res.remainingMs);
      if (after && now() < deadline) after();
    }, () => {
      checking = false;
      scheduleIdle(reportMs); // sunucuya ulaşılamadı: sonra yeniden sorulur
    });
  }
  function onIdle() {
    idleTimer = null;
    if (stopped) return;
    if (now() < deadline) return scheduleIdle();
    check();
  }
  /** Gerçek kullanıcı etkinliği (klavye / fare / dokunma) */
  function activity() {
    if (stopped) return;
    const t = now();
    // Süre dolmuşsa uzatma denenmez: önce sunucuya sorulur; oturum sürüyorsa (başka sekme) etkinlik sonra işlenir
    if (t >= deadline) return check(activity);
    lastActivity = t;
    if (t + idleMs > deadline) deadline = t + idleMs;
    scheduleIdle();
    if (t - lastSent >= reportMs) flush();
    else scheduleReport();
  }
  /** Sekme yeniden göründü / bilgisayar uyandı: süre dolmuşsa sunucuya sorulur */
  function wake() {
    if (!stopped && now() >= deadline) check();
  }

  scheduleIdle();
  return { activity, sync, wake, stop, state: () => ({ lastActivity, confirmed, deadline, stopped }) };
}

/**
 * Fare / işaretçi hareketinin gerçek olup olmadığı: tarayıcı, imleç DURURKEN altındaki sayfa değişince de (otomatik
 * yenileme) hareket olayı üretebilir — konum değişmediyse etkinlik sayılmaz. İlk olay yalnızca başlangıç konumudur.
 * @returns {(x: number, y: number) => boolean}
 */
export function createMoveFilter() {
  /** @type {[number, number] | null} */ let last = null;
  return (x, y) => {
    const moved = last != null && (last[0] !== x || last[1] !== y);
    last = [x, y];
    return moved;
  };
}
