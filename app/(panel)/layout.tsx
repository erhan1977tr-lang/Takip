import { requireUser } from '@/lib/auth/session';
import { NAV, ROLE_LABEL } from '@/lib/roles';
import { NavLinks } from './NavLinks';
import { logoutAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = NAV[user.appRole];
  const firm = user.customer?.name;
  const sub = user.appRole === 'MUSTERI' && firm ? `${ROLE_LABEL[user.appRole]} · ${firm}` : ROLE_LABEL[user.appRole];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <b>TAKİP</b>
          <span className="version">v2.25</span>
        </div>
        <div className="tag">SİPARİŞ VE ÜRETİM PORTALI</div>
        <NavLinks items={nav} variant="side" />
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="who">
            <div className="avatar">{(user.name || user.email).charAt(0).toUpperCase()}</div>
            <div style={{ minWidth: 0 }}>
              <div className="name">{user.name || user.email}</div>
              <div className="sub">{sub}</div>
            </div>
          </div>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-link">Çıkış</button>
          </form>
        </header>
        <NavLinks items={nav} variant="mobile" />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
