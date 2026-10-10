'use client';

import { useEffect, useRef } from 'react';
import { POLL_EVENT } from '@/components/NotificationCenter';

/**
 * Sipariş uyarılarının "görüldü" işareti (Paket B — karar 228; karar 224'ün "sayfa açılınca hepsi okunur" kuralını
 * daraltır). Sayfayı AÇMAK tek başına uyarıları okumaz: her uyarı türü sayfanın bir bölümünde gösterilir
 * (server/notifications/order-alerts.js → ALERT_SECTIONS) ve o bölüm ekranda GERÇEKTEN göründüğünde okunur:
 *   - sekme görünür (arka plandaki sekme okumaz),
 *   - bölüm ekranda yeterince görünür (kendi yüksekliğinin %60'ı ya da ekranın %40'ı, hangisi küçükse),
 *   - en az 600 ms orada kalır (hızlı kaydırma okumaz).
 * Mesajlar tek tek: bir mesaj ekranda görününce o mesajın anına kadar okunur (sonraki görülmemiş mesaj okunmamış kalır).
 * Sayfada bölümü olmayan uyarı (bu rol için gösterilmeyen bölüm) sayfa başlığı (durum) ile birlikte okunur — sonsuza dek
 * okunmamış kalmaz. Uyarılar sayfanın çizildiği ana (upTo) kadarki kayıtlarla sınırlıdır.
 * Karar 224'ün korunan kuralları: sayfa YENİDEN ÇİZDİRİLMEZ (router.refresh yok — açık formlar bozulmaz, "yeni" vurgusu
 * kalır, yeniden çizim → yeniden işaretleme döngüsü olmaz); yalnızca zil akışı ortak yoklama olayıyla tazelenir. Oturumu
 * uzatmaz (karar 135). Sunucu her istekte kapsamı ve bölüm adlarını yeniden denetler.
 */
const SECTIONS: Record<string, string> = {
  durum: '.page-head',
  cizim: '#cizim-onay, #cizim-hatali, #revizyon, #dwg-karar, #cizim-dosyalari, #cizim, .viewer',
  teklif: '#teklif',
  kararlar: '#kararlar',
  teslim: '#teslim',
};
const DWELL_MS = 600;

export function OrderSeen({ orderId, upTo, mark, only }: {
  orderId: string;
  /** sayfanın sunucuda çizildiği an (ISO) */
  upTo: string;
  mark: (orderId: string, upTo: string, sections: string[]) => Promise<boolean>;
  /** yalnızca bu bölümler izlenir (ör. çizim görüntüleyici: ['cizim']) */
  only?: string[];
}) {
  const sent = useRef(new Set<string>());
  const onlyKey = only?.join(',') ?? '';
  useEffect(() => {
    const only = onlyKey ? onlyKey.split(',') : null;
    const visible = () => document.visibilityState === 'visible';
    const send = (sections: string[], at: string) => {
      const fresh = sections.filter((s) => !sent.current.has(`${s}|${at}`));
      if (!fresh.length) return;
      for (const s of fresh) sent.current.add(`${s}|${at}`);
      mark(orderId, at, fresh).then((changed) => { if (changed) window.dispatchEvent(new Event(POLL_EVENT)); }).catch(() => {
        for (const s of fresh) sent.current.delete(`${s}|${at}`);
      });
    };
    const watched = Object.keys(SECTIONS).filter((k) => !only || only.includes(k));
    // Bu sayfada bulunmayan bölümlerin uyarıları sayfa başlığıyla okunur (yalnızca tam sayfada; "only" ile değil)
    const absent = only ? [] : watched.filter((k) => k !== 'durum' && !document.querySelector(SECTIONS[k]));
    if (!only && !document.querySelector('[data-note][data-at]')) absent.push('notlar');
    const timers = new Map<Element, number>();
    // Arka plandayken süresi dolan bölüm: sekme görünür olunca işaretlenir
    const pending = new Set<Element>();
    const owner = new Map<Element, { sections: string[]; at: string }>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const r = e.boundingClientRect;
        const need = Math.min(r.height * 0.6, window.innerHeight * 0.4);
        const enough = e.isIntersecting && e.intersectionRect.height >= Math.max(1, need);
        const t = timers.get(e.target);
        if (enough && t == null) {
          timers.set(e.target, window.setTimeout(() => {
            timers.delete(e.target);
            const o = owner.get(e.target);
            if (o && visible()) send(o.sections, o.at);
            else if (o) pending.add(e.target);
          }, DWELL_MS));
        } else if (!enough && t != null) {
          window.clearTimeout(t);
          timers.delete(e.target);
        }
      }
    }, { threshold: [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1] });
    const observe = (el: Element, sections: string[], at: string) => { owner.set(el, { sections, at }); io.observe(el); };
    for (const k of watched) {
      const el = document.querySelector(SECTIONS[k]);
      if (el) observe(el, k === 'durum' ? ['durum', ...absent] : [k], upTo);
    }
    if (!only || only.includes('notlar')) {
      for (const el of document.querySelectorAll('[data-note][data-at]')) {
        const at = el.getAttribute('data-at') ?? '';
        // Mesajın anı sayfanın çizildiği andan sonra olamaz
        if (at) observe(el, ['notlar'], at < upTo ? at : upTo);
      }
    }
    const onVisible = () => {
      if (!visible()) return;
      for (const el of pending) { const o = owner.get(el); if (o) send(o.sections, o.at); }
      pending.clear();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      io.disconnect();
      for (const t of timers.values()) window.clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [orderId, upTo, mark, onlyKey]);
  return null;
}
