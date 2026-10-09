'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { NavItem } from '@/lib/roles';

export function NavLinks({ items, variant }: { items: NavItem[]; variant: 'side' | 'mobile' }) {
  const path = usePathname();
  const query = useSearchParams();
  /**
   * Bağlantının bu sayfayla eşleşme puanı (eşleşmiyorsa -1). Birden fazla bağlantı eşleşirse en özel olan seçili sayılır:
   * en uzun yol; sorgulu bağlantı (ör. /siparisler?panel=cizim) yalnızca tam o sayfada ve bütün parametreleri
   * eşleşiyorsa — o zaman aynı yolun sorgusuz bağlantısının önüne geçer.
   */
  const score = (href: string) => {
    const [p, q] = href.split('?');
    if (!q) return path === p || path.startsWith(`${p}/`) ? p.length : -1;
    if (path !== p) return -1;
    for (const [k, v] of new URLSearchParams(q)) if (query.get(k) !== v) return -1;
    return href.length + 1;
  };
  const hrefs = items.flatMap((it) => ('href' in it ? [it.href] : []));
  const activeHref = hrefs.map((h) => [h, score(h)] as const).filter(([, s]) => s >= 0).sort((x, y) => y[1] - x[1])[0]?.[0];
  const num = (n: number) => (n > 99 ? '99+' : String(n));
  const links = items.map((it, i) => {
    if ('section' in it) {
      if (variant !== 'side') return null;
      // Bölüm sayacı (karar 216 — yeni profil siparişi): bölüm adının yanında kırmızı yuvarlak; açıklaması ekran okuyucuya
      return (
        <div key={`s${i}`} className="nav-section" title={it.count ? it.countLabel : undefined}>
          {it.section}
          {it.count ? <><span className="msg-count" data-nav-count={it.count} aria-hidden="true">{num(it.count)}</span><span className="sr-only">{it.countLabel}</span></> : null}
        </div>
      );
    }
    const active = it.href === activeHref;
    // Telefonda bölüm adı yok: bölüm sayacı bölümün bağlantısında (mobileCount)
    const section = variant === 'mobile' ? it.mobileCount ?? 0 : 0;
    return (
      <Link key={it.href} href={it.href} className={active ? 'active' : undefined} title={it.count || section ? it.countLabel : undefined}>
        {it.label}
        {/* Okunmamış sipariş mesajları (karar 199) — sayı sunucuda hesaplanır; bağlantının adı değişmez (açıklama title'da) */}
        {it.count ? <span className="msg-count" data-nav-unread={it.count} aria-hidden="true">{num(it.count)}</span> : null}
        {/* Bölüm sayacı telefonda (karar 216): bağlantının adı değişmez — açıklama title'da (karar 199 ile aynı) */}
        {section ? <span className="msg-count" data-nav-count={section} aria-hidden="true">{num(section)}</span> : null}
      </Link>
    );
  });
  return variant === 'side' ? <nav className="nav">{links}</nav> : <nav className="mobile-nav">{links}</nav>;
}
