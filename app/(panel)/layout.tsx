import { requireUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { NAV, type NavDef, type NavItem } from '@/lib/roles';
import { getT } from '@/lib/i18n';
import { roleText } from '@/lib/labels';
import { NavLinks } from './NavLinks';
import { BrandLogo } from '@/components/BrandLogo';
import { LanguageSelect } from '@/components/LanguageSelect';
import { SIDEBAR_INIT, SIDEBAR_SLOT, SidebarToggle } from '@/components/Sidebar';
import { isDemo } from '@/server/demo/accounts.js';
import { logoutAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { t, locale, m } = await getT();
  const demo = isDemo();
  const defs: NavDef[] = demo && userCan(user, 'SETTINGS_MANAGE')
    ? [...NAV.ADMIN, { section: 'nav.demo' }, { href: '/demo/posta', key: 'nav.demoMail' }]
    : NAV[user.appRole];
  const nav: NavItem[] = defs.map((d) => ('section' in d ? { section: t(d.section) } : { href: d.href, label: t(d.key) }));
  const firm = user.customer?.name;
  const role = roleText(t, user.appRole);
  const sub = user.appRole === 'MUSTERI' && firm ? `${role} · ${firm}` : role;

  return (
    <div className="shell">
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_INIT }} />
      <aside className="sidebar">
        <BrandLogo />
        <div className="tag">{t('common.productUpper')}</div>
        <NavLinks items={nav} variant="side" />
        {/* Sipariş sayfasında Hareketler buraya gelir (components/Sidebar.tsx → SidebarPortal) */}
        <div id={SIDEBAR_SLOT} className="sidebar-activity" />
      </aside>
      <SidebarToggle hide={t('common.sidebarHide')} show={t('common.sidebarShow')} />
      <div className="main">
        <header className="topbar">
          <div className="topbar-brand"><BrandLogo compact /></div>
          <div className="who">
            <div className="avatar">{(user.name || user.email).charAt(0).toUpperCase()}</div>
            <div style={{ minWidth: 0 }}>
              <div className="name">{user.name || user.email}</div>
              <div className="sub">{sub}</div>
            </div>
          </div>
          <div className="row topbar-right" style={{ gap: 8 }}>
            {demo && <span className="badge badge-warn" title={t('common.demoTitle')}>{t('common.demoBadge')}</span>}
            <LanguageSelect locale={locale} names={m.lang} title={t('lang.label')} />
            <form action={logoutAction}>
              <button type="submit" className="btn btn-link">{t('common.logout')}</button>
            </form>
          </div>
        </header>
        <NavLinks items={nav} variant="mobile" />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
