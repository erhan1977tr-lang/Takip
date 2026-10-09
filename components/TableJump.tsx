'use client';

import { useEffect, useState } from 'react';

// Uzun teklif tablosunda ekranın sağında küçük ↑ / ↓ düğmeleri: ↑ tablonun başına, ↓ tablonun sonuna gider (sayfanın
// değil, yalnızca tablonun üst / alt noktası). Tablo ekrandan kısaysa ya da tablo ekranda değilse görünmez.
// Teklifin durumundan bağımsızdır (karar 213): düzenlenebilir tabloda (OfferEditor) ve salt okunur teklifte (sipariş
// sayfası → OfferView: yöneticide, müşteride) aynı bileşen. Sayfanın yapışkan üst çubuğu (.topbar) hesaba katılır: ↑
// tablonun başlık satırını çubuğun hemen altına getirir (çubuğun altında kalmaz), ↓ tablonun son satırını ekranın altına.
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
  const go = (block: 'start' | 'end') => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('.topbar')?.getBoundingClientRect();
    const top = Math.max(0, bar && bar.bottom > 0 ? bar.bottom : 0) + 8;
    const y = block === 'start' ? r.top - top : r.bottom - window.innerHeight + 8;
    window.scrollTo({ top: Math.max(0, window.scrollY + y), behavior: 'smooth' });
  };
  return (
    <div className="table-jump" role="group" data-table-jump={targetId}>
      <button type="button" className="btn" aria-label={up} title={up} onClick={() => go('start')}>↑</button>
      <button type="button" className="btn" aria-label={down} title={down} onClick={() => go('end')}>↓</button>
    </div>
  );
}
