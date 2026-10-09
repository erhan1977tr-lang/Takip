import { Suspense } from 'react';
import { requireUser, sessionRemainingMs } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { NAV, type NavDef, type NavItem } from '@/lib/roles';
import { getT } from '@/lib/i18n';
import { roleText } from '@/lib/labels';
import { NavLinks } from './NavLinks';
import { BrandLogo, VersionTag } from '@/components/BrandLogo';
import { LanguageSelect } from '@/components/LanguageSelect';
import { SIDEBAR_INIT, SIDEBAR_SLOT, SidebarToggle } from '@/components/Sidebar';
import { isDemo } from '@/server/demo/accounts.js';
import { logoutAction } from './actions';
import { AutoRefresh } from '@/components/AutoRefresh';
import { SessionActivity } from '@/components/SessionActivity';
import { NotificationCenter } from '@/components/NotificationCenter';
import { loadFeed } from '@/lib/notifications';
import { db } from '@/lib/db';
import { unreadTotal } from '@/server/notes/unread.js';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { t, locale, m, intl } = await getT();
  const demo = isDemo();
  // Bildirim akışı (zil): yalnızca bu kullanıcının bildirimleri; ortak otomatik yenilemeyle birlikte tazelenir
  const feed = await loadFeed(user.id, locale);
  const n = m.notifications;
  const defs: NavDef[] = demo && userCan(user, 'SETTINGS_MANAGE')
    ? [...NAV.ADMIN, { section: 'nav.demo' }, { href: '/demo/posta', key: 'nav.demoMail' }]
    : NAV[user.appRole];
  // Okunmamış sipariş mesajlarının toplamı (karar 199): yalnızca kullanıcının kapsamındaki siparişler; "Siparişler" bağlantısında
  const messages = await unreadTotal(db, user);
  const ordersHref = '/siparisler';
  const nav: NavItem[] = defs.map((d) => ('section' in d ? { section: t(d.section) }
    : d.href === ordersHref && messages.total > 0
      ? { href: d.href, label: t(d.key), count: messages.total, countLabel: t('order.notes.unread', { n: messages.total }) }
      : { href: d.href, label: t(d.key) }));
  const firm = user.customer?.name;
  const role = roleText(t, user.appRole);
  const customerFirm = user.appRole === 'MUSTERI' && firm ? firm : '';

  return (
    <div className="shell">
      <script dangerouslySetInnerHTML={{ __html: SIDEBAR_INIT }} />
      <aside className="sidebar">
        {/* Başlık satırı (eski TAKİP düzeni): ürün adı + sürüm; sağında menüyü gizleme düğmesi (SidebarToggle) */}
        <div className="side-head"><span className="side-product">{t('common.brand')}</span><VersionTag /></div>
        <BrandLogo version={false} />
        <div className="tag">{t('common.taglineUpper')}</div>
        {/* Suspense: NavLinks adres sorgusunu okur (useSearchParams) */}
        <Suspense fallback={null}><NavLinks items={nav} variant="side" /></Suspense>
        <div className="side-foot">
          Developed by <a href="https://gkhdigital.ro" target="_blank" rel="noopener noreferrer">gkhdigital.ro</a> and <a href="https://gkhdigital.com" target="_blank" rel="noopener noreferrer">gkhdigital.com</a>
        </div>
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
              {/* Rol: geniş ekranda sağdaki rozette, dar ekranda adın altında (aynı anda yalnızca biri görünür) */}
              <div className="sub"><span className="sub-role">{role}{customerFirm ? ' · ' : ''}</span>{customerFirm}</div>
            </div>
          </div>
          <div className="row topbar-right">
            <span className="role-pill" title={role}>{role}</span>
            {demo && <span className="badge badge-warn" title={t('common.demoTitle')}>{t('common.demoBadge')}</span>}
            <NotificationCenter
              feed={feed} sound={user.notificationSound} intl={intl}
              m={{
                title: n.title, bell: n.bell, bellUnread: n.bellUnread, empty: n.empty, unread: n.unread, markRead: n.markRead, markAll: n.markAll, close: n.close,
                newOne: n.newOne, newMany: n.newMany, more: n.more, showAll: n.showAll, sound: n.sound, soundOn: n.soundOn, soundOff: n.soundOff,
              }}
            />
            <LanguageSelect locale={locale} names={m.lang} title={t('lang.label')} />
            <form action={logoutAction}>
              <button type="submit" className="btn btn-link">{t('common.logout')}</button>
            </form>
          </div>
        </header>
        <Suspense fallback={null}><NavLinks items={nav} variant="mobile" /></Suspense>
        <main className="content">{children}</main>
        <AutoRefresh />
        {/* 30 dakika etkinlik olmayan oturum kapanır (karar 135): gerçek etkinliği bildirir; yenilemeler uzatmaz */}
        <SessionActivity remainingMs={await sessionRemainingMs()} />
      </div>
    </div>
  );
}
