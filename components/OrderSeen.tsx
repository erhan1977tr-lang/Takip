'use client';

import { useEffect, useRef } from 'react';
import { POLL_EVENT } from '@/components/NotificationCenter';

/**
 * Sipariş sayfası açıldı → bu kullanıcının bu siparişteki uyarıları ve mesajları okundu (Paket A, karar 224 — karar 205'in
 * yerine). Sayfa çizimi / GET isteği hiçbir şey yazmaz: işaretleme, sayfa tarayıcıda göründükten SONRA bu bileşenin
 * çağırdığı sunucu işlemiyle yapılır ve yalnızca sayfanın çizildiği ana (upTo) kadar yazılmış uyarıları kapsar — sonra gelen
 * uyarı okunmamış kalır. Sekme arka plandaysa sekme görünür olunca yapılır. Ortak yenileme sayfayı yeniden çizince (yeni
 * upTo) o ana kadar gelenler de okunur: kullanıcı siparişin sayfasındadır. Oturumu uzatmaz (karar 135); başka kullanıcının
 * kaydına dokunmaz (sunucu: server/notifications/order-alerts.js → markOrderSeen).
 * Sayfa YENİDEN ÇİZDİRİLMEZ (router.refresh yok): açık formların durumu bozulmaz, "yeni" vurgusu bu ziyaret boyunca kalır ve
 * yeni çizim → yeni upTo → yeniden işaretleme döngüsü oluşmaz. Yalnızca zil akışı tazelenir (ortak yoklama olayı); menü
 * sayaçları bir sonraki ortak yenilemede güncellenir.
 */
export function OrderSeen({ orderId, upTo, mark }: {
  orderId: string;
  /** sayfanın sunucuda çizildiği an (ISO) */
  upTo: string;
  mark: (orderId: string, upTo: string) => Promise<boolean>;
}) {
  const done = useRef<string>('');
  useEffect(() => {
    const key = `${orderId}|${upTo}`;
    const run = () => {
      if (document.visibilityState !== 'visible' || done.current === key) return;
      done.current = key;
      mark(orderId, upTo).then((changed) => { if (changed) window.dispatchEvent(new Event(POLL_EVENT)); }).catch(() => {});
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => document.removeEventListener('visibilitychange', run);
  }, [orderId, upTo, mark]);
  return null;
}
