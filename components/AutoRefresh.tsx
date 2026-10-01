'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// Tüm panel sayfaları için tek ortak otomatik yenileme (app/(panel)/layout.tsx): 60 saniyede bir router.refresh()
// sunucu bileşenlerinin verisini yeniden çeker — tam sayfa yeniden yükleme değildir, istemci durumu korunur.
// Kullanıcı bir forma yazmaya başladıysa (input/change olayı) o sayfada form gönderilene ya da sayfa değişene kadar
// yenileme yapılmaz; sekme arka plandayken de yapılmaz (geri gelince hemen yenilenir).
export const AUTO_REFRESH_MS = 60_000;

export function AutoRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const dirty = useRef(false);

  useEffect(() => {
    dirty.current = false;
  }, [pathname]);

  useEffect(() => {
    const markDirty = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (el && el.closest('form, input, textarea, select')) dirty.current = true;
    };
    const markClean = () => { dirty.current = false; };
    let last = Date.now();
    const refresh = () => {
      if (document.hidden || dirty.current) return;
      last = Date.now();
      router.refresh();
    };
    const timer = window.setInterval(refresh, AUTO_REFRESH_MS);
    const onVisible = () => { if (!document.hidden && Date.now() - last >= AUTO_REFRESH_MS) refresh(); };
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);
    document.addEventListener('submit', markClean, true);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('input', markDirty, true);
      document.removeEventListener('change', markDirty, true);
      document.removeEventListener('submit', markClean, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}
