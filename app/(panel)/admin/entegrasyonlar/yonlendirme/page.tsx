import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey, type T } from '@/lib/i18n';
import { ConfirmButton } from '@/components/ConfirmButton';
import { LINK_SETTING, ROUTING_TIMEZONE, routingState } from '@/server/orders/sales-routing.js';
import { SettingsTabs } from '../SettingsTabs';
import { saveRoutingRuleAction } from './actions';

export const dynamic = 'force-dynamic';

const ERR = ['FORBIDDEN', 'MODE', 'TARGET', 'TIME', 'PAST', 'FAR', 'NOT_LINKED'];

type Rule = {
  id: string; mode: string; startsAt: Date; note: string | null;
  targetUser: { id: string; name: string; email: string; isActive: boolean } | null;
  createdBy: { name: string; email: string } | null;
};

function modeText(t: T, r: Rule) {
  if (r.mode !== 'AUTO') return t('team.routing.mode.MANUAL');
  const u = r.targetUser;
  const name = u ? `${u.name || u.email}${u.isActive ? '' : ` ${t('team.routing.inactiveTarget')}`}` : '—';
  return t('team.routing.mode.AUTO', { name });
}

/**
 * Ayarlar → Satış Yönlendirme (karar 300): yeni cam siparişlerinin sorumlu satışçısı. Kural yalnızca eklenir ve yalnızca
 * İLERİYE etkilidir (server/orders/sales-routing.js). Satış ekipleri (satışçı → varsayılan çizimci → satış fiyat tablosu)
 * bilgi olarak gösterilir; eşleşme Kullanıcılar ekranında, tablo ataması Fiyat Tabloları ekranında değiştirilir.
 * Yalnızca SETTINGS_MANAGE (yönetici).
 */
export default async function RoutingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('SETTINGS_MANAGE');
  const { t, intl } = await getT();
  const sp = await searchParams;
  const now = new Date();
  const [raw, link, sales] = await Promise.all([
    routingState(db, now),
    db.integrationSetting.findUnique({ where: { key: LINK_SETTING } }),
    db.user.findMany({
      where: { appRole: 'SATIS', type: 'INTERNAL', isActive: true, deletedAt: null },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      select: {
        id: true, name: true, email: true,
        defaultDrawer: { select: { name: true, email: true, isActive: true } },
        priceTable: { select: { name: true, isActive: true } },
      },
    }),
  ]);
  const state = raw as unknown as { rules: Rule[]; linked: boolean; current: Rule | null; upcoming: Rule[] };
  const fmt = (d: Date) => new Intl.DateTimeFormat(intl, { dateStyle: 'short', timeStyle: 'short', timeZone: ROUTING_TIMEZONE }).format(d);
  const linkedAt = (link?.value as unknown as { linkedAt?: string } | null)?.linkedAt;
  const errText = sp.error ? t(`team.routing.errors.${ERR.includes(sp.error) ? sp.error : 'MODE'}` as MsgKey) : null;

  return (
    <>
      <div className="page-head">
        <h1>{t('supplier.settingsTabs.title')}</h1>
        <p className="muted">{t('team.routing.intro')}</p>
      </div>
      <SettingsTabs user={user} active="routing" />
      {sp.ok === 'saved' && <div className="alert alert-ok">{t('team.routing.ok')}</div>}
      {errText && <div className="alert alert-error" role="alert">{errText}</div>}

      <div className="card" id="yonlendirme" data-routing-linked={state.linked ? '1' : '0'}>
        <h2>{t('team.routing.current')}</h2>
        {!state.linked
          ? <div className="alert alert-warn" data-routing-not-linked>{t('team.routing.notLinked')}</div>
          : linkedAt && <p className="muted small">{t('team.routing.linkedAt', { at: fmt(new Date(linkedAt)) })}</p>}
        <p data-routing-current={state.current ? state.current.mode : 'NONE'}>
          {state.current ? <><b>{modeText(t, state.current)}</b> · {fmt(state.current.startsAt)}</> : t('team.routing.noRule')}
        </p>
      </div>

      {state.linked && (
        <form action={saveRoutingRuleAction} className="card" id="yeni-kural">
          <h2>{t('team.routing.newRule')}</h2>
          <div className="grid-2">
            <div>
              <label htmlFor="rt-mode">{t('team.routing.modeLabel')}</label>
              <select id="rt-mode" name="mode" required defaultValue="AUTO">
                <option value="AUTO">{t('team.routing.modeOption.AUTO')}</option>
                <option value="MANUAL">{t('team.routing.modeOption.MANUAL')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="rt-target">{t('team.routing.target')}</label>
              <select id="rt-target" name="targetUserId" defaultValue="">
                <option value="">—</option>
                {sales.map((s) => <option key={s.id} value={s.id}>{s.name || s.email}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="rt-start">{t('team.routing.startsAt')}</label>
              <input id="rt-start" name="startsAt" type="datetime-local" />
            </div>
            <div>
              <label htmlFor="rt-note">{t('team.routing.note')}</label>
              <input id="rt-note" name="note" type="text" maxLength={500} />
            </div>
          </div>
          <div className="row end" style={{ marginTop: 12 }}>
            <ConfirmButton primary message={t('team.routing.confirm')}>{t('team.routing.submit')}</ConfirmButton>
          </div>
        </form>
      )}

      <div className="card card-flush" id="satis-ekipleri">
        <div className="card-head"><h2>{t('team.routing.team')}</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('team.routing.teamCol.sales')}</th><th>{t('team.routing.teamCol.drawer')}</th><th>{t('team.routing.teamCol.table')}</th></tr></thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} data-team-row={s.id}>
                  <td>{s.name || s.email}</td>
                  <td>{s.defaultDrawer && s.defaultDrawer.isActive ? s.defaultDrawer.name || s.defaultDrawer.email : <span className="muted">{t('team.assign.noDrawer')}</span>}</td>
                  <td>{s.priceTable && s.priceTable.isActive ? s.priceTable.name : <span className="muted">{t('team.routing.noTable')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {state.rules.length > 0 && (
        <div className="card card-flush" id="kural-gecmisi">
          <div className="card-head"><h2>{t('team.routing.history')}</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('team.routing.col.startsAt')}</th><th>{t('team.routing.col.mode')}</th><th>{t('team.routing.col.note')}</th><th>{t('team.routing.col.by')}</th></tr></thead>
              <tbody>
                {state.rules.map((r) => (
                  <tr key={r.id} data-rule={r.id}>
                    <td>{fmt(r.startsAt)}{r.startsAt > now && <> <span className="badge badge-info">{t('team.routing.upcoming')}</span></>}</td>
                    <td>{modeText(t, r)}</td>
                    <td className="muted">{r.note ?? '—'}</td>
                    <td className="muted">{r.createdBy?.name || r.createdBy?.email || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
