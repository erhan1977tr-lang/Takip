import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { homeFor } from '@/lib/roles';
import { getT } from '@/lib/i18n';
import { roleText } from '@/lib/labels';
import { AuthCard } from '../AuthCard';
import { loginAction } from './actions';
import { DEMO_ACCOUNTS, isDemo } from '@/server/demo/accounts.js';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(homeFor(user.appRole));
  const sp = await searchParams;
  const { t, locale } = await getT();
  const error = sp.error === 'invalid' ? t('auth.login.errorInvalid')
    : sp.error === 'locked' ? t('auth.login.errorLocked', { minutes: String(Math.max(1, Number(sp.m) || 15)) })
    : undefined;
  const info = sp.info === 'logout' ? t('auth.login.infoLogout') : sp.info === 'idle' ? t('auth.login.infoIdle') : undefined;
  // Dil değiştirilince aynı sayfaya (yazılan e-postayla) dönülür
  const here = `/login${sp.email ? `?email=${encodeURIComponent(sp.email)}` : ''}`;

  return (
    <AuthCard next={here}>
      <p className="muted" style={{ margin: '6px 0 20px' }}>{t('auth.login.tagline')}</p>
      {info && <div className="alert alert-info" data-info={sp.info}>{info}</div>}
      <form action={loginAction}>
        {/* Girişte bu dil çereze yazılır; panel aynı dille açılır */}
        <input type="hidden" name="lang" value={locale} />
        <div className="field">
          <label htmlFor="email">{t('auth.login.email')}</label>
          <input id="email" name="email" type="email" autoComplete="username" required defaultValue={sp.email ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="password">{t('auth.login.password')}</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          {/* İlk giriş / şifre sıfırlama: herkese aynı görünen sabit bağlantı (hesabın durumunu açığa vurmaz — SEC-10) */}
          <div className="hint">{t('auth.login.passwordHint')} <Link href="/setup">{t('auth.login.setupLink')}</Link></div>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block">{t('auth.login.submit')}</button>
      </form>
      <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>{t('auth.login.noAccount')}</p>
      {isDemo() && (
        <div className="alert alert-warn demo-accounts" style={{ marginTop: 16, marginBottom: 0 }}>
          <b>{t('auth.login.demoTitle')}</b> {t('auth.login.demoIntro')}
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email}><a href={`/login?email=${encodeURIComponent(a.email)}`}>{a.email}</a> — {roleText(t, a.role)}</li>
            ))}
          </ul>
          <span className="small">{t('auth.login.demoPassword')}</span>
        </div>
      )}
    </AuthCard>
  );
}
