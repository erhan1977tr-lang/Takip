// Uygulama içi bildirimlerin İSTEMCİ kuralları (saf işlevler; tek içe aktarması yine saf ve bağımsız olan ortak
// "uygulama içi yol" kuralıdır — components/NotificationCenter.tsx kullanır, test/notification-feed.test.js sınar):
//   - İlk yükleme SESSİZDİR: o anda var olan okunmamış bildirimler "yeni" değildir (yalnızca rozet).
//   - Sonraki her yoklamada yalnızca daha önce görülmemiş ve okunmamış bildirimler yenidir.
//   - Bir yoklama partisi için en çok BİR ses; aynı parti başka bir sekmede çalındıysa bu sekmede çalınmaz.
//   - Ses yalnızca ses açıkken ve tarayıcı kullanıcı etkileşimi almışken; ses kapalıyken zil / açılır bildirim sürer.
import { internalPath } from '../security/internal-path.js';

/** Zil rozeti: 1 … 99, fazlası "99+"; okunmamış yoksa boş */
export const badgeText = (n) => (n > 99 ? '99+' : n > 0 ? String(n) : '');

/** Sekme başlığındaki sayaç öneki ("(3) ") atılmış hâli */
export const stripCount = (title) => String(title ?? '').replace(/^\(\d+\+?\)\s+/, '');

/** Sekme başlığı: okunmamış varsa "(3) <başlık>", yoksa başlık aynen. Sayfanın kendi başlığı korunur. */
export function titleWithCount(title, unread) {
  const base = stripCount(title);
  const b = badgeText(Number(unread) || 0);
  return b ? `(${b}) ${base}` : base;
}

/**
 * Akışı işler. state boşsa (ilk yükleme) temel alınır ve hiçbir bildirim yeni sayılmaz.
 * @template {{ id: string, isRead: boolean, createdAt: string }} N
 * @param {{ seen: Set<string> } | null} state
 * @param {{ items: N[] }} feed
 * @returns {{ state: { seen: Set<string> }, fresh: N[] }}  fresh: bu yoklamada gelen yeni bildirimler (en yeni önce)
 */
export function ingest(state, feed) {
  const items = feed?.items ?? [];
  if (!state) return { state: { seen: new Set(items.map((i) => i.id)) }, fresh: [] };
  const fresh = items.filter((i) => !state.seen.has(i.id) && !i.isRead);
  const seen = new Set(state.seen);
  for (const i of items) seen.add(i.id);
  return { state: { seen }, fresh };
}

/**
 * Bu parti için ses çalınsın mı? En çok bir ses: parti boşsa, ses kapalıysa ya da tarayıcı henüz kullanıcı etkileşimi
 * almadıysa çalınmaz. stored: başka bir sekmenin en son seslendirdiği partinin işareti (localStorage) — bu partinin en
 * yeni bildirimi ondan yeni değilse başka sekme zaten çalmıştır.
 * @param {{ fresh: { createdAt: string }[], soundEnabled: boolean, interacted: boolean, stored?: string | null }} p
 * @returns {{ play: boolean, mark: string | null }}  mark: çalınacaksa saklanacak işaret
 */
export function soundFor({ fresh, soundEnabled, interacted, stored = null }) {
  if (!fresh.length) return { play: false, mark: null };
  const newest = fresh.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), '');
  if (!soundEnabled || !interacted) return { play: false, mark: null };
  if (stored && newest <= stored) return { play: false, mark: null };
  return { play: true, mark: newest };
}

/**
 * Yeni bildirim partisinin açılır bildirimi: tek bildirimse kendisi (başlık, metin, bağlantı); birden çoksa tek özet
 * (en yeni üç başlık + kalan sayısı) — parti başına tek açılır bildirim.
 * @param {{ id: string, title: string, body: string, link: string | null }[]} fresh
 * @returns {null | { single: true, id: string, title: string, body: string, link: string | null } | { single: false, count: number, titles: string[], more: number }}
 */
export function toastFor(fresh) {
  if (!fresh.length) return null;
  if (fresh.length === 1) return { single: true, id: fresh[0].id, title: fresh[0].title, body: fresh[0].body, link: fresh[0].link ?? null };
  return { single: false, count: fresh.length, titles: fresh.slice(0, 3).map((i) => i.title), more: Math.max(0, fresh.length - 3) };
}

/**
 * Bağlantı yalnızca uygulama içi yol olabilir; başka her şey bağlantısız sayılır. Kural ortak doğrulayıcıdır
 * (server/security/internal-path.js, karar 145) — /dil yönlendirmesiyle AYNI kural; burada ikinci bir denetim yazılmaz.
 */
export const safeLink = internalPath;
