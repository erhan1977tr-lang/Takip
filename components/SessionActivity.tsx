'use client';

import { useEffect, useRef } from 'react';
import { ACTIVITY_HEADER, ACTIVITY_URL, createActivityTracker, createMoveFilter } from '@/server/auth/activity-tracker.js';
import { SESSION_IDLE_MS } from '@/server/auth/session-policy.js';

const ENDED_REDIRECT_MS = 1500;
type Tracker = ReturnType<typeof createActivityTracker>;
type Reply = { state: 'active'; remainingMs: number } | { state: 'expired' };

/** Etkinlik bildirimi: 200 → sürüyor (kalan süre), 401 → oturum bitti; başka her yanıt / ağ hatası → sonra yeniden */
async function send(idleMs: number): Promise<Reply> {
  const res = await fetch(ACTIVITY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ACTIVITY_HEADER]: '1' },
    body: JSON.stringify({ idle: Math.max(0, Math.round(idleMs)) }),
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive: true,
  });
  if (res.status === 401) return { state: 'expired' };
  if (!res.ok) throw new Error(`activity ${res.status}`);
  const body = (await res.json()) as { state?: string; remainingMs?: number };
  if (body.state !== 'active' || typeof body.remainingMs !== 'number') throw new Error('activity reply');
  return { state: 'active', remainingMs: body.remainingMs };
}

/**
 * 30 dakika gerçek kullanıcı etkinliği olmayan oturum kapanır (karar 135). Kural SUNUCUDADIR
 * (server/auth/session-policy.js); bu bileşen yalnızca:
 *   - gerçek etkinliği (klavye, fare / işaretçi, tekerlek, dokunma) sunucuya bildirir — en çok dakikada bir, etkinlik
 *     yoksa hiç (server/auth/activity-tracker.js). Otomatik yenileme, bildirim yoklaması, betiklerin ürettiği olaylar
 *     (isTrusted = false) ve imleç dururken sayfanın altında değişmesinden doğan "hareket" etkinlik DEĞİLDİR;
 *   - süre dolduğunda sunucuya sorar ve oturum bittiyse giriş sayfasına götürür (açık sekme içeride gibi görünmesin).
 * `remainingMs`: sunucunun bu sayfayı çizerken bildirdiği kalan süre (her otomatik yenilemede tazelenir; başka
 * sekmedeki etkinlik böyle öğrenilir).
 */
export function SessionActivity({ remainingMs }: { remainingMs: number }) {
  const tracker = useRef<Tracker | null>(null);
  const initial = useRef(remainingMs);

  useEffect(() => {
    // Oturum kullanıcı çalışırken başka yerden kapandıysa ("Çıkış", pasifleştirme) girişe kısa bir gecikmeyle gidilir:
    // kullanıcı tam o anda bu sekmede "Çıkış"a bastıysa sayfa zaten giriş sayfasına geçer (bileşen kalkar, gecikme iptal)
    let leave: number | undefined;
    const t = createActivityTracker({
      remainingMs: initial.current,
      idleMs: SESSION_IDLE_MS,
      send,
      onExpired: (reason) => {
        if (reason === 'idle') window.location.assign('/login?info=idle');
        else leave = window.setTimeout(() => window.location.assign('/login'), ENDED_REDIRECT_MS);
      },
    });
    tracker.current = t;
    const moved = createMoveFilter();
    const onAct = (e: Event) => { if (e.isTrusted) t.activity(); };
    const onMove = (e: Event) => {
      const p = e as PointerEvent;
      if (e.isTrusted && moved(p.screenX, p.screenY)) t.activity();
    };
    const onVisible = () => { if (!document.hidden) t.wake(); };
    const opts = { capture: true, passive: true } as const;
    const kinds = ['keydown', 'pointerdown', 'wheel', 'touchstart', 'touchmove'] as const;
    for (const k of kinds) window.addEventListener(k, onAct, opts);
    window.addEventListener('pointermove', onMove, opts);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      t.stop();
      window.clearTimeout(leave);
      tracker.current = null;
      for (const k of kinds) window.removeEventListener(k, onAct, opts);
      window.removeEventListener('pointermove', onMove, opts);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Sayfa yenilendiğinde (otomatik yenileme dahil) sunucunun bildirdiği süre: yalnızca zamanlayıcıyı kurar, istek yollamaz
  useEffect(() => {
    tracker.current?.sync(remainingMs);
  }, [remainingMs]);

  return null;
}
