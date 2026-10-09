import Link from 'next/link';
import { countText } from '@/server/notes/unread.js';

/**
 * Okunmamış sipariş mesajı sayacı (karar 199): kırmızı yuvarlak sayı (1…99, "99+"). Sayı 0 ise hiçbir şey çizilmez.
 * Sayı sunucuda server/notes/unread.js'ten gelir; bu bileşen yalnızca gösterir. href verilirse sayaç siparişin mesajlarına götürür.
 */
export function MsgCount({ n, label, href }: { n: number | null | undefined; label: string; href?: string }) {
  if (!n || n <= 0) return null;
  const badge = <span className="msg-count" data-unread={n} title={label} aria-label={label}>{countText(n)}</span>;
  return href ? <Link href={href} className="msg-count-link" aria-label={label}>{badge}</Link> : badge;
}
