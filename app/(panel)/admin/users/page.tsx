import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { inviteStatus } from '@/lib/invite';
import { getT, type MsgKey } from '@/lib/i18n';
import { roleText } from '@/lib/labels';
import { CreateUserForm } from './UserForm';
import { ConfirmButton } from '@/components/ConfirmButton';
import Link from 'next/link';
import { changeEmailAction, deleteUserAction, resetPasswordAction, sendInviteAction, toggleActiveAction } from './actions';
import { actorOf } from '@/lib/actor';
import { userDeletionPreview } from '@/server/users/lifecycle.js';

// ?ok= / ?error= kodu → sözlük anahtarı
const OK: Record<string, MsgKey> = {
  invite: 'admin.users.ok.invite',
  reset: 'admin.users.ok.reset',
  activated: 'admin.users.ok.activated',
  deactivated: 'admin.users.ok.deactivated',
  emailChanged: 'admin.users.ok.emailChanged',
  deleted: 'admin.users.ok.deleted',
};
const ERR: Record<string, MsgKey> = {
  mail: 'admin.users.error.mail',
  self: 'admin.users.error.self',
  active: 'admin.users.error.active',
  notfound: 'admin.users.error.notfound',
  forbidden: 'admin.users.error.forbidden',
  protected: 'admin.users.error.protected',
  invalidEmail: 'admin.users.error.invalidEmail',
  sameEmail: 'admin.users.error.sameEmail',
  emailTaken: 'admin.users.error.emailTaken',
  stale: 'admin.users.error.stale',
  confirm: 'admin.users.error.confirm',
  mailChange: 'admin.users.error.mailChange',
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const me = await requirePermission('USER_MANAGE');
  const { t, locale, m } = await getT();
  const sp = await searchParams;
  const okKey = sp.ok && Object.hasOwn(OK, sp.ok) ? OK[sp.ok] : null;
  const errKey = sp.error && Object.hasOwn(ERR, sp.error) ? ERR[sp.error] : null;
  const [firms, users] = await Promise.all([
    db.customer.findMany({ orderBy: [{ type: 'desc' }, { name: 'asc' }], select: { id: true, name: true, type: true } }),
    // Silinmiş (anonimleştirilmiş) kullanıcılar listede gösterilmez — karar 221
    db.user.findMany({ where: { deletedAt: null }, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], include: { customer: true } }),
  ]);
  // Silme önizlemesi (?sil=<id>) ve e-posta değişikliği kartı (?eposta=<id>): hedef listedeki, korunmayan bir kullanıcı olmalı
  const actor = await actorOf(me);
  const del = sp.sil ? await userDeletionPreview(db, { targetId: sp.sil, actor }) : null;
  const preview = del && del.ok ? del : null;
  const editTarget = sp.eposta ? users.find((u) => u.id === sp.eposta && u.id !== me.id && u.appRole !== 'ADMIN') ?? null : null;
  // Yönetici rolündeki hesap ve kişinin kendisi korunur (sunucu da reddeder): işlem bağlantıları gösterilmez
  const manageable = (u: { id: string; appRole: string }) => u.id !== me.id && u.appRole !== 'ADMIN';
  const statuses = await Promise.all(users.map((u) => inviteStatus(u.id, !!u.passwordHash)));

  return (
    <>
      <div className="page-head">
        <h1>{t('admin.users.title')}</h1>
        <p className="muted">{t('admin.users.intro')}</p>
      </div>
      {okKey && <div className="alert alert-ok">{t(okKey, { email: sp.email ?? '' })}</div>}
      {errKey && <div className="alert alert-error">{t(errKey)}</div>}

      {editTarget && (
        <form action={changeEmailAction} className="card" id="eposta-degistir" data-email-change={editTarget.id}>
          <h2>{t('admin.users.emailChange.title', { name: editTarget.name || editTarget.email })}</h2>
          <p className="muted small">{t('admin.users.emailChange.current', { email: editTarget.email })}</p>
          <div className="alert alert-warn">{t('admin.users.emailChange.intro')}</div>
          <input type="hidden" name="id" value={editTarget.id} />
          <label htmlFor="new-email">{t('admin.users.emailChange.newEmail')}</label>
          <input id="new-email" name="email" type="email" required maxLength={200} autoComplete="off" />
          <div className="row end" style={{ marginTop: 12 }}>
            <Link href="/admin/users" className="btn">{t('admin.users.emailChange.cancel')}</Link>
            <ConfirmButton primary message={t('admin.users.emailChange.confirm')}>{t('admin.users.emailChange.submit')}</ConfirmButton>
          </div>
        </form>
      )}
      {preview && (
        <form action={deleteUserAction} className="card" id="kullanici-sil" data-user-delete={preview.user.id}>
          <h2>{t('admin.users.deletePreview.title', { name: preview.user.name || preview.user.email })}</h2>
          <div className="alert alert-error">{t('admin.users.deletePreview.intro')}</div>
          <p className="small" data-delete-removed>{t('admin.users.deletePreview.removed', preview.removed)}</p>
          <p className="small" data-delete-kept>{t('admin.users.deletePreview.kept', preview.kept)}</p>
          <input type="hidden" name="id" value={preview.user.id} />
          <label htmlFor="sil-onay">{t('admin.users.deletePreview.confirmLabel', { email: preview.user.email })}</label>
          <input id="sil-onay" name="confirm" type="email" required autoComplete="off" />
          <div className="row end" style={{ marginTop: 12 }}>
            <Link href="/admin/users" className="btn">{t('admin.users.deletePreview.cancel')}</Link>
            <button type="submit" className="btn btn-danger-solid">{t('admin.users.deletePreview.submit')}</button>
          </div>
        </form>
      )}

      <CreateUserForm firms={firms} m={m.admin.userForm} langs={m.lang} locale={locale} />

      <div className="card card-flush">
        <div className="card-head"><h2>{t('admin.users.listTitle', { n: users.length })}</h2></div>
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
                          {manageable(u) && (
                            <>
                              <Link href={`/admin/users?eposta=${u.id}#eposta-degistir`} className="btn btn-link" data-action="change-email">{t('admin.users.changeEmail')}</Link>
                              <Link href={`/admin/users?sil=${u.id}#kullanici-sil`} className="btn btn-link danger" data-action="delete-user">{t('admin.users.delete')}</Link>
                            </>
                          )}
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
