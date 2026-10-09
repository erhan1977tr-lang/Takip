'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Sipariş sayfası açıkken bu siparişin mesajlarını "okundu" işaretler (karar 199): sayfanın gösterdiği en yeni mesaja
 * kadar. Yalnızca sekme görünürken ve en yeni mesaj değiştiğinde bir kez çağrılır (ortak 60 sn yenilemesi aynı mesajı
 * yeniden işaretlemez). Okunma kaydı değiştiyse menüdeki / zildeki sayaç için sayfa tazelenir. Bu bir kullanıcı etkinliği
 * değildir: oturumu uzatmaz (karar 135).
 */
export function MarkNotesRead({ orderId, latest, mark }: { orderId: string; latest: string | null; mark: (orderId: string, upTo: string | null) => Promise<boolean> }) {
  const router = useRouter();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!latest) return;
    const key = `${orderId}|${latest}`;
    const run = () => {
      if (done.current === key || document.visibilityState !== 'visible') return;
      done.current = key;
      mark(orderId, latest).then((changed) => { if (changed) router.refresh(); }).catch(() => { done.current = null; });
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => document.removeEventListener('visibilitychange', run);
  }, [orderId, latest, mark, router]);
  return null;
}
