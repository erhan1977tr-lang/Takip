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
  const links = items.map((it, i) => {
    if ('section' in it) {
      return variant === 'side' ? <div key={`s${i}`} className="nav-section">{it.section}</div> : null;
    }
    const active = it.href === activeHref;
    return (
      <Link key={it.href} href={it.href} className={active ? 'active' : undefined}>
        {it.label}
      </Link>
    );
  });
  return variant === 'side' ? <nav className="nav">{links}</nav> : <nav className="mobile-nav">{links}</nav>;
}
