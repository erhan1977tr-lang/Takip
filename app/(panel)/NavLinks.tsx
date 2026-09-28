'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/roles';

export function NavLinks({ items, variant }: { items: NavItem[]; variant: 'side' | 'mobile' }) {
  const path = usePathname();
  const links = items.map((it, i) => {
    if ('section' in it) {
      return variant === 'side' ? <div key={`s${i}`} className="nav-section">{it.section}</div> : null;
    }
    const active = path === it.href || path.startsWith(`${it.href}/`);
    return (
      <Link key={it.href} href={it.href} className={active ? 'active' : undefined}>
        {it.label}
      </Link>
    );
  });
  return variant === 'side' ? <nav className="nav">{links}</nav> : <nav className="mobile-nav">{links}</nav>;
}
