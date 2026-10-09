import { db } from './db';
import type { Locale } from './i18n';
import { dispatchInAppFor, renderInApp } from '../server/notifications/inapp.js';
import { safeLink } from '../server/notifications/feed.js';
import { NOTE_EVENT } from '../server/notes/unread.js';

/** Zilde gösterilen bildirim (metin kullanıcının diliyle, sunucuda üretilmiş) */
/**
 * readOnView: tıklamak bildirimi okumaz — ilgili içerik ekranda görülünce okunur (sipariş mesajı, karar 205); öbür türler
 * tıklanınca okunur (değişmedi).
 */
export type FeedItem = { id: string; title: string; body: string; link: string | null; isRead: boolean; createdAt: string; readOnView: boolean };
export type Feed = { unread: number; items: FeedItem[] };
export const FEED_SIZE = 20;

/**
 * Kullanıcının bildirim akışı: okunmamış sayısı + en yeni bildirimler. Yalnızca kendi satırları (userId) — başka
 * kullanıcının bildirimi hiçbir yoldan dönmez. Metin alıcıya göre süzülmüş değerlerden üretilir (maskeli firma adı).
 */
export async function loadFeed(userId: string, locale: Locale): Promise<Feed> {
  const [unread, rows] = await Promise.all([
    db.notification.count({ where: { userId, isRead: false } }),
    db.notification.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: FEED_SIZE }),
  ]);
  return {
    unread,
    items: rows.map((n) => {
      const text = renderInApp(locale, n);
      return { id: n.id, title: text.title, body: text.body, link: safeLink(n.link), isRead: n.isRead, createdAt: n.createdAt.toISOString(), readOnView: n.type === NOTE_EVENT };
    }),
  };
}

/**
 * Bir iş akışı işleminin az önce yazdığı kuyruk olaylarını uygulama içi bildirime HEMEN çevirir (Paket 3 — bildirim
 * gecikmesi: işçinin 60 sn'lik turunu ve o turdaki tarama / FGO işlerini beklemez). Aynı dağıtıcıdır (ikinci bir
 * bildirim sistemi değildir); işçi yedektir: bu adım başarısız olursa olay kuyrukta kalır ve işçi dağıtır. Aynı olay
 * aynı kullanıcıya iki kez yazılmaz (Notification [userId, dedupeKey]). İşlemi hiçbir koşulda bozmaz.
 */
export async function deliverInAppNow(outboxIds: string[] | null | undefined): Promise<void> {
  if (!outboxIds?.length) return;
  try {
    await dispatchInAppFor(db, outboxIds, { log: (...a: unknown[]) => console.warn('[bildirim]', ...a.map((x) => String(x).slice(0, 200))) });
  } catch (e) {
    console.warn('[bildirim] hemen dağıtılamadı; işçi dağıtacak', String((e as { code?: unknown })?.code ?? 'ERROR'));
  }
}
