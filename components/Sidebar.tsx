'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';

// Sol menü davranışı (eski GKH TAKIP düzeni), tüm roller için ortak düzende (app/(panel)/layout.tsx):
//   - Masaüstü: "‹" menüyü tamamen gizler, içerik genişler; soldaki küçük "›" sekmesi geri açar.
//     Tercih tarayıcıda saklanır (gkh.sidebar.collapsed = "1" | "0"), sayfa değişse de korunur.
//   - Dar ekran: menü içeriğin üstüne açılan çekmece olur; sayfa değişince kapanır.
// Durum <html data-sidebar="collapsed"> ve data-sidebar-mobile="open" öznitelikleriyle CSS'e verilir;
// ilk boyamadan önce SIDEBAR_INIT betiği uygular (menü bir an açılıp kapanmasın).

export const SIDEBAR_KEY = 'gkh.sidebar.collapsed';
export const SIDEBAR_INIT = `try{if(localStorage.getItem('${SIDEBAR_KEY}')==='1')document.documentElement.setAttribute('data-sidebar','collapsed')}catch(e){}`;
export const SIDEBAR_SLOT = 'sidebar-activity';

const narrow = () => window.matchMedia('(max-width: 800px)').matches;

function toggle(open: boolean) {
  const root = document.documentElement;
  if (narrow()) {
    if (open) root.setAttribute('data-sidebar-mobile', 'open');
    else root.removeAttribute('data-sidebar-mobile');
    return;
  }
  if (open) root.removeAttribute('data-sidebar');
  else root.setAttribute('data-sidebar', 'collapsed');
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? '0' : '1');
  } catch {
    // tarayıcı depolaması kapalıysa yalnızca bu sayfada geçerli olur
  }
}

/** Menüdeki "‹" düğmesi ve menü kapalıyken soldaki "›" sekmesi */
export function SidebarToggle({ hide, show }: { hide: string; show: string }) {
  const path = usePathname();
  const [y, setY] = useState<number | null>(null);
  useEffect(() => {
    document.documentElement.removeAttribute('data-sidebar-mobile');
  }, [path]);
  return (
    <>
      <button type="button" className="sidebar-hide" onClick={() => toggle(false)} aria-label={hide} title={hide}>‹</button>
      {/* Menü kapalıyken sol kenar boyunca görünmez alan: ok, farenin bulunduğu yükseklikte belirir */}
      <div className="sidebar-zone" onMouseMove={(e) => setY(e.clientY)}>
        <button
          type="button" className="sidebar-edge" onClick={() => toggle(true)} aria-label={show} title={show}
          style={y == null ? undefined : { top: Math.min(Math.max(y - 22, 8), window.innerHeight - 52) }}
        >›</button>
      </div>
    </>
  );
}

/** Çocuklarını sol menünün altındaki alana taşır (ör. siparişin Hareketler listesi); veri sayfanın kendisinden gelir. */
export function SidebarPortal({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(SIDEBAR_SLOT));
  }, []);
  return slot ? createPortal(children, slot) : null;
}
