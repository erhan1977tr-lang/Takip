'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/roles';

export function NavLinks({ items, variant }: { items: NavItem[]; variant: 'side' | 'mobile' }) {
  const path = usePathname();
  // Birden fazla bağlantı eşleşirse en uzun (en özel) olan seçili sayılır.
  const hrefs = items.flatMap((it) => ('href' in it ? [it.href] : []));
  const activeHref = hrefs.filter((h) => path === h || path.startsWith(`${h}/`)).sort((x, y) => y.length - x.length)[0];
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
