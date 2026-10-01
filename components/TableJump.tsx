'use client';

import { useEffect, useState } from 'react';

// Uzun teklif tablosunda ekranın sağında küçük ↑ / ↓ düğmeleri: ↑ tablonun başına, ↓ tablonun sonuna gider (sayfanın
// değil, yalnızca tablonun üst / alt noktası). Tablo ekrandan kısaysa ya da tablo ekranda değilse görünmez.
export function TableJump({ targetId, up, down }: { targetId: string; up: string; down: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const check = () => {
      const r = el.getBoundingClientRect();
      const long = r.height > window.innerHeight * 0.9;
      const visible = r.bottom > 0 && r.top < window.innerHeight;
      setShow(long && visible);
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      ro.disconnect();
    };
  }, [targetId]);

  if (!show) return null;
  const go = (block: 'start' | 'end') => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block });
  return (
    <div className="table-jump" role="group">
      <button type="button" className="btn" aria-label={up} title={up} onClick={() => go('start')}>↑</button>
      <button type="button" className="btn" aria-label={down} title={down} onClick={() => go('end')}>↓</button>
    </div>
  );
}
