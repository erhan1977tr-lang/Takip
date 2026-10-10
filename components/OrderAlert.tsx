import Link from 'next/link';
import { countText } from '@/server/notes/unread.js';

/**
 * Okunmamış sipariş uyarısı (karar 224): kullanıcının o siparişteki okunmamış zil bildirimleri (çizim onaya gönderildi,
 * revizyon, teklif … — yeni mesajın kendi sayacı MsgCount'tadır). Sayı sunucuda (server/notifications/order-alerts.js);
 * 0 ise hiçbir şey çizilmez. Sipariş sayfası açılınca yalnızca o kullanıcının uyarıları okunur.
 */
export function OrderAlert({ n, label, href, text }: { n: number | null | undefined; label: string; href: string; text?: string }) {
  if (!n || n <= 0) return null;
  return (
    <Link href={href} className="order-alert-link" aria-label={label}>
      {/* Müşteri listesi (Paket B — karar 228): kırmızı "Bir mesajınız var" yazısı; iç ekip: mavi sayı */}
      {text
        ? <span className="order-alert order-alert-msg" data-order-alerts={n} title={label}>{text}</span>
        : <span className="order-alert" data-order-alerts={n} title={label}>{countText(n)}</span>}
    </Link>
  );
}
