import Link from 'next/link';
import { readSetupToken } from '@/lib/auth/setupToken';
import { AuthCard } from '../AuthCard';
import { setPasswordAction, verifyCodeAction } from './actions';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  wrong_code: 'Doğrulama kodu hatalı ya da geçersiz.',
  no_invite: 'Doğrulama kodu hatalı ya da geçersiz.',
  used: 'Doğrulama kodu hatalı ya da geçersiz.',
  expired: 'Kodun süresi dolmuş. Yöneticinizden yeni bir kod isteyin.',
  locked: 'Çok fazla hatalı deneme yapıldı. Yöneticinizden yeni bir kod isteyin.',
  session: 'Süre doldu, lütfen kodu yeniden girin.',
  weak: 'Şifre en az 8 karakter olmalı; en az bir harf ve bir rakam içermeli.',
  mismatch: 'Şifreler eşleşmiyor.',
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const email = (sp.email ?? '').trim().toLowerCase();
  const error = sp.error ? ERRORS[sp.error] : undefined;
  const token = await readSetupToken();
  const step = token ? 2 : 1;

  return (
    <AuthCard>
      <div className="steps">
        <div className="on" />
        <div className={step === 2 ? 'on' : ''} />
      </div>
      {step === 1 ? (
        <>
          <h2 style={{ marginTop: 14 }}>Hesabınızı etkinleştirin</h2>
          <p className="muted">
            Adım 1/2 · <b>{email || 'e-posta adresinize'}</b> gönderilen 6 haneli doğrulama kodunu girin.
          </p>
          <form action={verifyCodeAction} style={{ marginTop: 16 }}>
            <input type="hidden" name="email" value={email} />
            <div className="field">
              <label htmlFor="code">Doğrulama kodu</label>
              <input
                id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}" maxLength={7} required className="code-input" placeholder="••••••"
              />
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-block">Doğrula</button>
          </form>
        </>
      ) : (
        <>
          <h2 style={{ marginTop: 14 }}>Şifrenizi belirleyin</h2>
          <p className="muted">Adım 2/2 · Kod doğrulandı. Şifrenizi oluşturun ve onaylamak için tekrar girin.</p>
          <form action={setPasswordAction} style={{ marginTop: 16 }}>
            <input type="hidden" name="email" value={email} />
            <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
            <div className="field">
              <label htmlFor="password">Yeni şifre</label>
              <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
            </div>
            <div className="field">
              <label htmlFor="password2">Yeni şifre (tekrar)</label>
              <input id="password2" name="password2" type="password" autoComplete="new-password" required minLength={8} />
              <div className="hint">En az 8 karakter; en az bir harf ve bir rakam.</div>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-block">Şifreyi kaydet ve giriş yap</button>
          </form>
        </>
      )}
      <p style={{ textAlign: 'center', marginTop: 14 }}>
        <Link href="/login" className="small">← Girişe dön</Link>
      </p>
    </AuthCard>
  );
}
