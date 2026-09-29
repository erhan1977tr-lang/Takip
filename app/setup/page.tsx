import Link from 'next/link';
import { readSetupToken } from '@/lib/auth/setupToken';
import { AuthCard } from '../AuthCard';
import { getT } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { setPasswordAction, verifyCodeAction } from './actions';

export const dynamic = 'force-dynamic';

const ERROR_CODES = ['wrong_code', 'no_invite', 'used', 'expired', 'locked', 'session', 'weak', 'mismatch', 'throttled'] as const;
type ErrorCode = (typeof ERROR_CODES)[number];
const isErrorCode = (x: string | undefined): x is ErrorCode => !!x && (ERROR_CODES as readonly string[]).includes(x);

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const email = (sp.email ?? '').trim().toLowerCase();
  const { t, locale } = await getT();
  const error = isErrorCode(sp.error) ? t(`auth.setup.errors.${sp.error}`, { minutes: String(Math.max(1, Number(sp.m) || 15)) }) : undefined;
  const token = await readSetupToken();
  const step = token ? 2 : 1;

  return (
    <AuthCard next={`/setup?email=${encodeURIComponent(email)}`}>
      <div className="steps">
        <div className="on" />
        <div className={step === 2 ? 'on' : ''} />
      </div>
      {step === 1 ? (
        <>
          <h2 style={{ marginTop: 14 }}>{t('auth.setup.step1Title')}</h2>
          <p className="muted">
            {rich(t('auth.setup.step1Text'), { email: <b>{email || t('auth.setup.yourEmail')}</b> })}
          </p>
          <form action={verifyCodeAction} style={{ marginTop: 16 }}>
            <input type="hidden" name="email" value={email} />
            <div className="field">
              <label htmlFor="code">{t('auth.setup.code')}</label>
              <input
                id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}" maxLength={7} required className="code-input" placeholder="••••••"
              />
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-block">{t('auth.setup.verify')}</button>
          </form>
        </>
      ) : (
        <>
          <h2 style={{ marginTop: 14 }}>{t('auth.setup.step2Title')}</h2>
          <p className="muted">{t('auth.setup.step2Text')}</p>
          <form action={setPasswordAction} style={{ marginTop: 16 }}>
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="lang" value={locale} />
            <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
            <div className="field">
              <label htmlFor="password">{t('auth.setup.newPassword')}</label>
              <input id="password" name="password" type="password" autoComplete="new-password" required minLength={6} />
            </div>
            <div className="field">
              <label htmlFor="password2">{t('auth.setup.newPassword2')}</label>
              <input id="password2" name="password2" type="password" autoComplete="new-password" required minLength={6} />
              <div className="hint">{t('auth.setup.passwordRule')}</div>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-block">{t('auth.setup.submit')}</button>
          </form>
        </>
      )}
      <p style={{ textAlign: 'center', marginTop: 14 }}>
        <Link href="/login" className="small">{t('auth.setup.backToLogin')}</Link>
      </p>
    </AuthCard>
  );
}
