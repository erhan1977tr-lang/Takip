'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { interpolate } from '@/server/i18n/interpolate.js';
import { badgeText, ingest, soundFor, stripCount, titleWithCount, toastFor } from '@/server/notifications/feed.js';
import { markAllNotificationsReadAction, markNotificationReadAction, setNotificationSoundAction } from '@/app/(panel)/bildirim-actions';
import type { Feed } from '@/lib/notifications';

/** Ortak otomatik yenileme sayfayı yenilemediğinde (arka plan sekmesi, doldurulan form) zilin yoklanması için olay */
export const POLL_EVENT = 'takip:poll';
const FEED_URL = '/bildirimler/akis';
const SOUND_URL = '/ses/bildirim';
/** Sekmeler arası: en son seslendirilen partinin işareti (aynı parti her sekmede ayrı ayrı çalınmasın) */
const SOUND_MARK = 'takip:notify:sound';
const TOAST_MS = 9000;

export type NotificationLabels = {
  title: string; bell: string; bellUnread: string; empty: string; unread: string; markRead: string; markAll: string; close: string;
  newOne: string; newMany: string; more: string; showAll: string; sound: string; soundOn: string; soundOff: string;
};
type Toast = NonNullable<ReturnType<typeof toastFor>>;

/**
 * Zil + okunmamış sayacı + açılır bildirim + ses + sekme başlığı (karar 107). Kurallar server/notifications/feed.js'te:
 *   - veri: panel düzeninin sunucuda yüklediği akış (ortak 60 sn'lik yenilemeyle tazelenir); yenileme atlandığında aynı
 *     zamanlayıcının olayıyla JSON akışı — ayrı bir yoklama döngüsü yoktur;
 *   - ilk yükleme sessizdir (var olan okunmamışlar yeni sayılmaz); yeni parti → tek açılır bildirim + en çok tek ses;
 *   - listeyi açmak okundu işaretlemez; okundu işaretleme açık istekle (bildirimi açmak / "okundu" / "tümünü").
 */
export function NotificationCenter({ feed, sound, m, intl }: { feed: Feed; sound: boolean; m: NotificationLabels; intl: string }) {
  const router = useRouter();
  const [data, setData] = useState<Feed>(feed);
  const [soundOn, setSoundOn] = useState(sound);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [, start] = useTransition();
  const seen = useRef<{ seen: Set<string> } | null>(null);
  const soundPref = useRef(sound);
  const interacted = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  // Tarayıcı ses politikası: ses yalnızca kullanıcı sayfayla etkileşime geçtikten sonra başlatılabilir
  useEffect(() => {
    const mark = () => { interacted.current = true; };
    window.addEventListener('pointerdown', mark, { once: true, capture: true });
    window.addEventListener('keydown', mark, { once: true, capture: true });
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
    };
  }, []);

  const play = useCallback(() => {
    try {
      audio.current ??= new Audio(SOUND_URL);
      audio.current.volume = 0.6;
      audio.current.currentTime = 0;
      // Tarayıcı engellerse (otomatik oynatma politikası) sessizce geçilir; kullanıcıya teknik hata gösterilmez
      void audio.current.play()?.catch(() => {});
    } catch {
      // ses desteklenmiyor: sessiz
    }
  }, []);

  /** Yeni akışı işler: sayaç güncellenir; yalnızca temel alındıktan SONRA gelenler için açılır bildirim + tek ses */
  const apply = useCallback((next: Feed, nextSound: boolean) => {
    const r = ingest(seen.current, next);
    seen.current = r.state;
    soundPref.current = nextSound;
    setData(next);
    setSoundOn(nextSound);
    if (r.fresh.length === 0) return;
    setToast(toastFor(r.fresh));
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(SOUND_MARK); } catch { stored = null; }
    const active = interacted.current || (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === true;
    const s = soundFor({ fresh: r.fresh, soundEnabled: nextSound, interacted: active, stored });
    if (!s.play) return;
    try { if (s.mark) window.localStorage.setItem(SOUND_MARK, s.mark); } catch { /* özel pencere: sekmeler arası işaret yok */ }
    play();
  }, [play]);

  // Sunucudan gelen akış (ilk yükleme = sessiz temel; sonraki her ortak yenileme)
  useEffect(() => { apply(feed, sound); }, [feed, sound, apply]);

  // Ortak yenileme atlandığında (arka plan sekmesi / doldurulan form): aynı zamanlayıcının olayıyla hafif JSON yoklaması
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(FEED_URL, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const j = (await res.json()) as Feed & { sound?: boolean };
        apply({ unread: j.unread, items: j.items }, j.sound ?? soundPref.current);
      } catch {
        // ağ hatası: bir sonraki turda yeniden denenir
      }
    };
    window.addEventListener(POLL_EVENT, poll);
    return () => window.removeEventListener(POLL_EVENT, poll);
  }, [apply]);

  // Sekme başlığı: "(3) <sayfanın başlığı>"; sayfa başlığını değiştirirse önek yeniden eklenir, çıkışta geri alınır
  useEffect(() => {
    const set = () => {
      const want = titleWithCount(document.title, data.unread);
      if (document.title !== want) document.title = want;
    };
    set();
    const el = document.querySelector('title');
    const obs = el ? new MutationObserver(set) : null;
    if (el && obs) obs.observe(el, { childList: true, characterData: true, subtree: true });
    return () => obs?.disconnect();
  }, [data.unread]);
  useEffect(() => () => { document.title = stripCount(document.title); }, []);

  // Açılır bildirim kendiliğinden kapanır
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Liste: dışarı tıklayınca / Esc ile kapanır
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const localRead = (id: string | null) => setData((d) => ({
    unread: id ? Math.max(0, d.unread - (d.items.some((i) => i.id === id && !i.isRead) ? 1 : 0)) : 0,
    items: d.items.map((i) => (id == null || i.id === id ? { ...i, isRead: true } : i)),
  }));
  const markRead = (id: string, go: string | null = null) => {
    localRead(id);
    start(async () => {
      await markNotificationReadAction(id);
      if (go) router.push(go);
      else router.refresh();
    });
  };
  const markAll = () => {
    localRead(null);
    start(async () => {
      await markAllNotificationsReadAction();
      router.refresh();
    });
  };
  const toggleSound = () => {
    const next = !soundOn;
    soundPref.current = next;
    setSoundOn(next);
    start(async () => {
      await setNotificationSoundAction(next);
      router.refresh();
    });
  };
  const openItem = (e: React.MouseEvent, id: string, link: string | null) => {
    e.preventDefault();
    setOpen(false);
    setToast(null);
    markRead(id, link);
  };

  const badge = badgeText(data.unread);
  const time = new Intl.DateTimeFormat(intl, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="notif" ref={box}>
      <button
        type="button" className="notif-bell" aria-haspopup="dialog" aria-expanded={open} data-unread={data.unread}
        aria-label={data.unread > 0 ? interpolate(m.bellUnread, { n: data.unread }) : m.bell} title={m.bell}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {badge && <span className="notif-badge">{badge}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label={m.title}>
          <div className="notif-head">
            <b>{m.title}</b>
            <button type="button" className="btn btn-link" disabled={data.unread === 0} onClick={markAll}>{m.markAll}</button>
          </div>
          {data.items.length === 0 ? <p className="notif-empty muted">{m.empty}</p> : (
            <ul className="notif-list">
              {data.items.map((n) => (
                <li key={n.id} className={`notif-item${n.isRead ? '' : ' unread'}`} data-id={n.id}>
                  {n.link ? (
                    <a href={n.link} className="notif-main" onClick={(e) => openItem(e, n.id, n.link)}>
                      <span className="notif-title">{n.title}</span>
                      {n.body && <span className="notif-body">{n.body}</span>}
                      <span className="notif-time">{time.format(new Date(n.createdAt))}</span>
                    </a>
                  ) : (
                    <div className="notif-main">
                      <span className="notif-title">{n.title}</span>
                      {n.body && <span className="notif-body">{n.body}</span>}
                      <span className="notif-time">{time.format(new Date(n.createdAt))}</span>
                    </div>
                  )}
                  {!n.isRead && (
                    <button type="button" className="notif-read" title={m.markRead} aria-label={m.markRead} onClick={() => markRead(n.id)}>
                      <span className="notif-dot" aria-hidden="true" />
                      <span className="sr-only">{m.unread}</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="notif-foot">
            <span>{m.sound}</span>
            <button type="button" role="switch" aria-checked={soundOn} className={`notif-switch${soundOn ? ' on' : ''}`} onClick={toggleSound}>
              {soundOn ? m.soundOn : m.soundOff}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="notif-toast" role="status" aria-live="polite">
          <div className="notif-toast-head">
            <b>{toast.single ? m.newOne : interpolate(m.newMany, { n: toast.count })}</b>
            <button type="button" className="notif-close" aria-label={m.close} onClick={() => setToast(null)}>×</button>
          </div>
          {toast.single ? (
            toast.link ? (
              <a href={toast.link} className="notif-main" onClick={(e) => openItem(e, toast.id, toast.link)}>
                <span className="notif-title">{toast.title}</span>
                {toast.body && <span className="notif-body">{toast.body}</span>}
              </a>
            ) : (
              <div className="notif-main">
                <span className="notif-title">{toast.title}</span>
                {toast.body && <span className="notif-body">{toast.body}</span>}
              </div>
            )
          ) : (
            <button type="button" className="notif-main notif-many" onClick={() => { setToast(null); setOpen(true); }}>
              {toast.titles.map((x, i) => <span key={i} className="notif-body">{x}</span>)}
              {toast.more > 0 && <span className="notif-time">{interpolate(m.more, { n: toast.more })}</span>}
              <span className="notif-link">{m.showAll}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
