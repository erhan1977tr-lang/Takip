import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { homeFor } from '@/lib/roles';
import { AuthCard } from '../AuthCard';
import { loginAction } from './actions';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  invalid: 'E-posta veya şifre hatalı.',
};
const INFOS: Record<string, string> = {
  logout: 'Çıkış yaptınız.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(homeFor(user.appRole));
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : undefined;
  const info = sp.info ? INFOS[sp.info] : undefined;

  return (
    <AuthCard>
      <p className="muted" style={{ margin: '6px 0 20px' }}>Sipariş, çizim onayı ve üretim takibi</p>
      {info && <div className="alert alert-info">{info}</div>}
      <form action={loginAction}>
        <div className="field">
          <label htmlFor="email">E-posta</label>
          <input id="email" name="email" type="email" autoComplete="username" required defaultValue={sp.email ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="password">Şifre</label>
          <input id="password" name="password" type="password" autoComplete="current-password" />
          <div className="hint">İlk girişinizde şifre alanını boş bırakın; doğrulama kodu ekranına yönlendirilirsiniz.</div>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block">Giriş yap</button>
      </form>
      <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>Hesabınız yoksa firma yöneticinize başvurun.</p>
    </AuthCard>
  );
}
