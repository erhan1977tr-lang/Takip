'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Bir notun okunmuş sayılması için ekranda kesintisiz görünmesi gereken süre (ms) ve görünür oranı */
const SEEN_MS = 600;
const SEEN_RATIO = 0.6;

/**
 * Sipariş sayfasının mesaj listesi (karar 205; Paket 9'un "sipariş açılınca okundu" kuralının yerine). Mesajlar YALNIZCA
 * kullanıcı onları gerçekten gördüğünde okunmuş sayılır:
 *   - Okunmamış mesaj varsa liste KAPALI başlar ("Mesajları göster"); sipariş sayfasını açmak, sayfayı yenilemek, ortak 60 sn
 *     yenileme ya da bildirim yoklaması hiçbir şeyi okumaz.
 *   - Liste açıkken (kullanıcı açtı ya da adres #notlar — bildirimden gelindi) bir not, sekme görünürken ekranda en az
 *     %60 oranında SEEN_MS boyunca kesintisiz görününce "görüldü" sayılır; okunma anı görülen en yeni notun anına ilerler
 *     (sunucu: markNotesRead — kullanıcıya özel, geri gitmez, aynı not iki kez sayılmaz) ve o notların zil bildirimleri de
 *     okunur. Görülmeyen (aşağıda kalan) yeni not okunmamış kalır.
 * Bu bir kullanıcı etkinliği değildir: oturumu uzatmaz (karar 135).
 */
export function NotesList({ orderId, unread, mark, labels, children }: {
  orderId: string;
  /** sayfa açılırken okunmamış mesaj sayısı (sunucu) */
  unread: number;
  mark: (orderId: string, upTo: string | null) => Promise<boolean>;
  labels: { show: string; hide: string };
  children: React.ReactNode;
}) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(unread === 0);
  const sent = useRef<number>(0); // sunucuya bildirilen en yeni an (ms)
  const pending = useRef(false);

  // Bildirimden / bağlantıdan gelindi (#notlar): liste açılır ve görünür yapılır
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash !== '#notlar') return;
      setOpen(true);
      requestAnimationFrame(() => document.getElementById('notlar')?.scrollIntoView({ block: 'start' }));
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  useEffect(() => {
    const root = box.current;
    if (!open || !root || typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    let seen = sent.current;
    const report = () => {
      if (pending.current || seen <= sent.current) return;
      pending.current = true;
      const upTo = seen;
      mark(orderId, new Date(upTo).toISOString())
        .then((changed) => { sent.current = Math.max(sent.current, upTo); if (changed) router.refresh(); })
        .catch(() => {})
        .finally(() => { pending.current = false; if (seen > sent.current) report(); });
    };
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        const visible = e.isIntersecting && e.intersectionRatio >= SEEN_RATIO;
        if (!visible) {
          clearTimeout(timers.get(el));
          timers.delete(el);
          continue;
        }
        if (timers.has(el)) continue;
        timers.set(el, setTimeout(() => {
          timers.delete(el);
          if (document.visibilityState !== 'visible' || !el.isConnected) return;
          const at = Date.parse((el as HTMLElement).dataset.at ?? '');
          if (Number.isFinite(at) && at > seen) { seen = at; report(); }
        }, SEEN_MS));
      }
    }, { threshold: [0, SEEN_RATIO, 1] });
    for (const el of root.querySelectorAll('[data-note][data-at]')) observer.observe(el);
    return () => {
      observer.disconnect();
      for (const t of timers.values()) clearTimeout(t);
    };
    // children değişince (yeni not geldi) gözlem yeniden kurulur
  }, [open, orderId, mark, router, children]);

  return (
    <>
      {unread > 0 || !open ? (
        <button type="button" className="btn btn-link notes-toggle" aria-expanded={open} aria-controls="notlar-liste" onClick={() => setOpen((v) => !v)} data-notes-toggle>
          {open ? labels.hide : labels.show}
        </button>
      ) : null}
      <div id="notlar-liste" ref={box} hidden={!open} data-notes-open={open ? '1' : '0'}>
        {children}
      </div>
    </>
  );
}
