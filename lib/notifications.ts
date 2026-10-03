import { db } from './db';
import type { Locale } from './i18n';
import { renderInApp } from '../server/notifications/inapp.js';
import { safeLink } from '../server/notifications/feed.js';

/** Zilde gösterilen bildirim (metin kullanıcının diliyle, sunucuda üretilmiş) */
export type FeedItem = { id: string; title: string; body: string; link: string | null; isRead: boolean; createdAt: string };
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
      return { id: n.id, title: text.title, body: text.body, link: safeLink(n.link), isRead: n.isRead, createdAt: n.createdAt.toISOString() };
    }),
  };
}
