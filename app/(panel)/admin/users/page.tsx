import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { inviteStatus } from '@/lib/invite';
import { ROLE_LABEL } from '@/lib/roles';
import { CreateUserForm } from './UserForm';
import { ConfirmButton } from '@/components/ConfirmButton';
import { resetPasswordAction, sendInviteAction, toggleActiveAction } from './actions';

const OK: Record<string, string> = {
  invite: 'davet e-postası gönderildi.',
  reset: 'şifresi sıfırlandı ve yeni kod gönderildi.',
  activated: 'hesabı etkinleştirildi.',
  deactivated: 'hesabı pasifleştirildi; açık oturumları kapatıldı.',
};
const ERR: Record<string, string> = {
  mail: 'E-posta gönderilemedi. SMTP ayarlarını kontrol edin.',
  self: 'Kendi hesabınız üzerinde bu işlemi yapamazsınız.',
  active: 'Bu kullanıcı şifresini zaten belirlemiş; yeni kod için “Şifreyi sıfırla”yı kullanın.',
  notfound: 'Kullanıcı bulunamadı.',
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const me = await requireUser(['ADMIN']);
  const sp = await searchParams;
  const [firms, users] = await Promise.all([
    db.customer.findMany({ orderBy: [{ type: 'desc' }, { name: 'asc' }], select: { id: true, name: true, type: true } }),
    db.user.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], include: { customer: true } }),
  ]);
  const statuses = await Promise.all(users.map((u) => inviteStatus(u.id, !!u.passwordHash)));

  return (
    <>
      <div className="page-head">
        <h1>Kullanıcılar</h1>
        <p className="muted">Kullanıcıyı bir firmaya atayın; davet e-postasındaki kodla kişi ilk girişte şifresini kendisi belirler.</p>
      </div>
      {sp.ok && OK[sp.ok] && <div className="alert alert-ok">{sp.email} {OK[sp.ok]}</div>}
      {sp.error && ERR[sp.error] && <div className="alert alert-error">{ERR[sp.error]}</div>}

      <CreateUserForm firms={firms} />

      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>Kayıtlı kullanıcılar ({users.length})</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Kullanıcı</th><th>Firma</th><th>Rol</th><th>Birim</th><th>Durum</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const st = statuses[i];
                const self = u.id === me.id;
                return (
                  <tr key={u.id} style={u.isActive ? undefined : { opacity: 0.55 }}>
                    <td>
                      <b>{u.name || u.email}</b>{self && <span className="muted"> (siz)</span>}
                      {u.name && <div className="muted small">{u.email}</div>}
                      {u.phone && <div className="muted small">{u.phone}</div>}
                    </td>
                    <td>{u.customer?.name ?? '—'}{u.customer?.type === 'FACTORY' && <span className="muted"> (fabrika)</span>}</td>
                    <td>
                      {ROLE_LABEL[u.appRole]}
                      {u.appRole === 'MUSTERI' && u.canApprove && <> <span className="badge badge-info">onay yetkili</span></>}
                    </td>
                    <td className="muted">{u.unit ?? '—'}</td>
                    <td>
                      {!u.isActive ? <span className="badge badge-muted">Pasif</span>
                        : st.state === 'active' ? <span className="badge badge-ok">Aktif</span>
                        : st.state === 'sent' ? <span className="badge badge-warn">Davet gönderildi</span>
                        : st.state === 'expired' ? <span className="badge badge-warn">Kodun süresi doldu</span>
                        : <span className="badge badge-muted">Davet edilmedi</span>}
                    </td>
                    <td className="actions">
                      {!self && (
                        <>
                          {u.isActive && !u.passwordHash && (
                            <form action={sendInviteAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <button type="submit" className="btn btn-link">{st.state === 'sent' ? 'Yeni kod gönder' : 'Davet gönder'}</button>
                            </form>
                          )}
                          {u.isActive && u.passwordHash && (
                            <form action={resetPasswordAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <ConfirmButton message={`${u.email} için şifre sıfırlansın mı? Kişi yeni kodla şifresini yeniden belirleyecek.`}>Şifreyi sıfırla</ConfirmButton>
                            </form>
                          )}
                          <form action={toggleActiveAction}>
                            <input type="hidden" name="id" value={u.id} />
                            {u.isActive
                              ? <ConfirmButton danger message={`${u.email} pasifleştirilsin mi? Giriş yapamaz, kayıtları silinmez.`}>Pasifleştir</ConfirmButton>
                              : <button type="submit" className="btn btn-link">Etkinleştir</button>}
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
