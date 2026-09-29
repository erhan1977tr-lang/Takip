import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { inviteStatus } from '@/lib/invite';
import { getT, type MsgKey } from '@/lib/i18n';
import { roleText } from '@/lib/labels';
import { CreateUserForm } from './UserForm';
import { ConfirmButton } from '@/components/ConfirmButton';
import { resetPasswordAction, sendInviteAction, toggleActiveAction } from './actions';

// ?ok= / ?error= kodu → sözlük anahtarı
const OK: Record<string, MsgKey> = {
  invite: 'admin.users.ok.invite',
  reset: 'admin.users.ok.reset',
  activated: 'admin.users.ok.activated',
  deactivated: 'admin.users.ok.deactivated',
};
const ERR: Record<string, MsgKey> = {
  mail: 'admin.users.error.mail',
  self: 'admin.users.error.self',
  active: 'admin.users.error.active',
  notfound: 'admin.users.error.notfound',
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const me = await requireUser(['ADMIN']);
  const { t, locale, m } = await getT();
  const sp = await searchParams;
  const okKey = sp.ok && Object.hasOwn(OK, sp.ok) ? OK[sp.ok] : null;
  const errKey = sp.error && Object.hasOwn(ERR, sp.error) ? ERR[sp.error] : null;
  const [firms, users] = await Promise.all([
    db.customer.findMany({ orderBy: [{ type: 'desc' }, { name: 'asc' }], select: { id: true, name: true, type: true } }),
    db.user.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], include: { customer: true } }),
  ]);
  const statuses = await Promise.all(users.map((u) => inviteStatus(u.id, !!u.passwordHash)));

  return (
    <>
      <div className="page-head">
        <h1>{t('admin.users.title')}</h1>
        <p className="muted">{t('admin.users.intro')}</p>
      </div>
      {okKey && <div className="alert alert-ok">{t(okKey, { email: sp.email ?? '' })}</div>}
      {errKey && <div className="alert alert-error">{t(errKey)}</div>}

      <CreateUserForm firms={firms} m={m.admin.userForm} langs={m.lang} locale={locale} />

      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('admin.users.listTitle', { n: users.length })}</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{t('admin.users.col.user')}</th><th>{t('admin.users.col.firm')}</th><th>{t('admin.users.col.role')}</th><th>{t('admin.users.col.unit')}</th><th>{t('admin.users.col.status')}</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const st = statuses[i];
                const self = u.id === me.id;
                return (
                  <tr key={u.id} style={u.isActive ? undefined : { opacity: 0.55 }}>
                    <td>
                      <b>{u.name || u.email}</b>{self && <span className="muted"> {t('admin.users.you')}</span>}
                      {u.name && <div className="muted small">{u.email}</div>}
                      {u.phone && <div className="muted small">{u.phone}</div>}
                    </td>
                    <td>{u.customer?.name ?? '—'}{u.customer?.type === 'FACTORY' && <span className="muted"> {t('admin.users.factory')}</span>}</td>
                    <td>
                      {roleText(t, u.appRole)}
                      {u.appRole === 'MUSTERI' && u.canApprove && <> <span className="badge badge-info">{t('admin.users.canApprove')}</span></>}
                    </td>
                    <td className="muted">{u.unit ?? '—'}</td>
                    <td>
                      {!u.isActive ? <span className="badge badge-muted">{t('admin.users.state.inactive')}</span>
                        : st.state === 'active' ? <span className="badge badge-ok">{t('admin.users.state.active')}</span>
                        : st.state === 'sent' ? <span className="badge badge-warn">{t('admin.users.state.sent')}</span>
                        : st.state === 'expired' ? <span className="badge badge-warn">{t('admin.users.state.expired')}</span>
                        : <span className="badge badge-muted">{t('admin.users.state.none')}</span>}
                    </td>
                    <td className="actions">
                      {!self && (
                        <>
                          {u.isActive && !u.passwordHash && (
                            <form action={sendInviteAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <button type="submit" className="btn btn-link">{st.state === 'sent' ? t('admin.users.sendNewCode') : t('admin.users.sendInvite')}</button>
                            </form>
                          )}
                          {u.isActive && u.passwordHash && (
                            <form action={resetPasswordAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <ConfirmButton message={t('admin.users.resetConfirm', { email: u.email })}>{t('admin.users.resetPassword')}</ConfirmButton>
                            </form>
                          )}
                          <form action={toggleActiveAction}>
                            <input type="hidden" name="id" value={u.id} />
                            {u.isActive
                              ? <ConfirmButton danger message={t('admin.users.deactivateConfirm', { email: u.email })}>{t('admin.users.deactivate')}</ConfirmButton>
                              : <button type="submit" className="btn btn-link">{t('admin.users.activate')}</button>}
                          </form>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
