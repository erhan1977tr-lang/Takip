import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { ConfirmButton } from '@/components/ConfirmButton';
import { loadTeamsAdmin } from '@/server/teams/service.js';
import { SettingsTabs } from '../SettingsTabs';
import { saveTeamAction, setTeamActiveAction } from './actions';

export const dynamic = 'force-dynamic';

const ERR = ['FORBIDDEN', 'NAME', 'NAME_TAKEN', 'SALES', 'SALES_IN_TEAM', 'DRAWER', 'DRAWER_IN_TEAM', 'TABLE', 'TABLE_IN_TEAM', 'NOT_FOUND'];
const OK = ['created', 'saved', 'activated', 'deactivated', 'deactivatedRouting'];

type Person = { id: string; name: string; email: string; isActive: boolean; deletedAt: Date | null } | null;
type Team = {
  id: string; name: string; isActive: boolean; salesUserId: string;
  salesUser: { id: string; name: string; email: string; isActive: boolean; deletedAt: Date | null; defaultDrawer: Person; priceTable: { id: string; name: string; isActive: boolean } | null };
};
type Data = {
  teams: Team[]; freeSales: { id: string; name: string; email: string }[]; drawers: { id: string; name: string; email: string }[];
  tables: { id: string; name: string; currency: string }[]; routingToInactive: boolean;
};

const who = (u: { name: string; email: string } | null | undefined) => (u ? u.name || u.email : '—');

/**
 * Ayarlar → Fabrika Ekipleri (4.3.19, karar 304): ekip = satışçı hesabı + ad + aktiflik. Çizimci ve fiyat tablosu
 * satışçının var olan alanlarına yazılır; finansal hesap satışçı hesabıdır (Muhasebe → Cam Fabrika Hesap Durumu).
 * Yetki: USER_MANAGE + PRICE_TABLE_MANAGE (yönetici); servis ayrıca denetler.
 */
export default async function TeamsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('USER_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const canTables = userCan(user, 'PRICE_TABLE_MANAGE');
  const data = (await loadTeamsAdmin(db)) as unknown as Data;
  const editing = sp.duzenle ? data.teams.find((x) => x.id === sp.duzenle) ?? null : null;
  const errText = sp.error ? t(`team.factory.errors.${ERR.includes(sp.error) ? sp.error : 'FORBIDDEN'}` as MsgKey) : null;
  const okText = sp.ok && OK.includes(sp.ok) ? t(`team.factory.ok.${sp.ok}` as MsgKey) : null;
  const drawerOf = (x: Team) => x.salesUser.defaultDrawer && x.salesUser.defaultDrawer.isActive && !x.salesUser.defaultDrawer.deletedAt ? x.salesUser.defaultDrawer : null;

  return (
    <>
      <div className="page-head">
        <h1>{t('supplier.settingsTabs.title')}</h1>
        <p className="muted">{t('team.factory.intro')}</p>
      </div>
      <SettingsTabs user={user} active="teams" />
      {okText && <div className={`alert ${sp.ok === 'deactivatedRouting' ? 'alert-warn' : 'alert-ok'}`} data-team-ok={sp.ok}>{okText}</div>}
      {errText && <div className="alert alert-error" role="alert" data-team-error={sp.error}>{errText}</div>}
      {data.routingToInactive && <div className="alert alert-error" role="alert" data-team-routing-inactive>{t('team.factory.routingToInactive')}</div>}

      <div className="card card-flush" id="ekipler">
        <div className="card-head"><h2>{t('team.factory.listTitle', { n: data.teams.length })}</h2></div>
        {data.teams.length === 0 ? <p className="muted" style={{ padding: '0 16px 16px' }}>{t('team.factory.none')}</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('team.factory.col.name')}</th><th>{t('team.factory.col.sales')}</th><th>{t('team.factory.col.drawer')}</th>
                  <th>{t('team.factory.col.table')}</th><th>{t('team.factory.col.account')}</th><th>{t('team.factory.col.status')}</th><th />
                </tr>
              </thead>
              <tbody>
                {data.teams.map((x) => (
                  <tr key={x.id} data-team={x.id} data-team-active={x.isActive ? '1' : '0'}>
                    <td><b>{x.name}</b></td>
                    <td>{who(x.salesUser)}</td>
                    <td>{drawerOf(x) ? who(drawerOf(x)) : <span className="muted">{t('team.factory.noDrawer')}</span>}</td>
                    <td>{x.salesUser.priceTable && x.salesUser.priceTable.isActive ? x.salesUser.priceTable.name : <span className="muted">{t('team.factory.noTable')}</span>}</td>
                    <td><Link href="/admin/muhasebe/tedarikci#hesaplar">{t('team.factory.accountLink')}</Link></td>
                    <td>{x.isActive ? <span className="badge badge-ok">{t('team.factory.active')}</span> : <span className="badge badge-muted">{t('team.factory.inactive')}</span>}</td>
                    <td className="actions">
                      {canTables && <Link href={`/admin/entegrasyonlar/ekipler?duzenle=${x.id}#ekip-formu`} className="btn btn-link">{t('team.factory.edit')}</Link>}
                      <form action={setTeamActiveAction}>
                        <input type="hidden" name="id" value={x.id} />
                        <input type="hidden" name="active" value={x.isActive ? '0' : '1'} />
                        {x.isActive
                          ? <ConfirmButton danger message={t('team.factory.confirmDeactivate')}>{t('team.factory.deactivate')}</ConfirmButton>
                          : <button type="submit" className="btn btn-link">{t('team.factory.activate')}</button>}
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canTables && (
        <form action={saveTeamAction} className="card" id="ekip-formu" data-team-form={editing ? 'edit' : 'new'}>
          <h2>{editing ? t('team.factory.editTitle', { name: editing.name }) : t('team.factory.newTitle')}</h2>
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid-2">
            <div>
              <label htmlFor="ek-name">{t('team.factory.name')}</label>
              <input id="ek-name" name="name" type="text" required minLength={2} maxLength={80} defaultValue={editing?.name ?? ''} />
            </div>
            <div>
              <label htmlFor="ek-sales">{t('team.factory.sales')}</label>
              {editing ? (
                <>
                  <input id="ek-sales" type="text" value={who(editing.salesUser)} disabled />
                  <p className="hint">{t('team.factory.salesFixed')}</p>
                </>
              ) : data.freeSales.length === 0 ? <p className="muted" id="ek-sales">{t('team.factory.noFreeSales')}</p> : (
                <select id="ek-sales" name="salesUserId" required defaultValue="">
                  <option value="" disabled>{t('team.factory.pick')}</option>
                  {data.freeSales.map((u) => <option key={u.id} value={u.id}>{who(u)}</option>)}
                </select>
              )}
            </div>
            <div>
              <label htmlFor="ek-drawer">{t('team.factory.drawer')}</label>
              <select id="ek-drawer" name="drawerId" required defaultValue={editing ? drawerOf(editing)?.id ?? '' : ''}>
                <option value="" disabled>{t('team.factory.pick')}</option>
                {data.drawers.map((u) => <option key={u.id} value={u.id}>{who(u)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ek-table">{t('team.factory.table')}</label>
              <select id="ek-table" name="priceTableId" defaultValue={editing?.salesUser.priceTable?.isActive ? editing.salesUser.priceTable.id : ''}>
                <option value="">{t('team.factory.noTableOption')}</option>
                {data.tables.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.currency})</option>)}
              </select>
            </div>
          </div>
          <p className="hint">{t('team.factory.newUserHint')} <Link href="/admin/users">→</Link></p>
          <div className="row end" style={{ marginTop: 12 }}>
            {editing && <Link href="/admin/entegrasyonlar/ekipler" className="btn">{t('team.factory.cancel')}</Link>}
            <button type="submit" className="btn btn-primary" disabled={!editing && data.freeSales.length === 0}>{editing ? t('team.factory.save') : t('team.factory.create')}</button>
          </div>
        </form>
      )}
    </>
  );
}
