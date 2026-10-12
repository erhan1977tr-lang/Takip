import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandLogo } from '@/components/BrandLogo';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { getT } from '@/lib/i18n';
import { POLICY, POLICY_UPDATED, type Policy } from './content';

/**
 * Gizlilik politikası — herkese açık (oturum gerekmez), uygulama mağazası / entegrasyon formlarındaki
 * "privacy policy" bağlantısı: https://takip.gkh.ro/privacy. Metin sayfanın dilinde (RO | TR), altında İngilizcesi.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getT();
  return { title: `${POLICY[locale].title} · TAKİP` };
}

function PolicyBody({ policy }: { policy: Policy }) {
  return (
    <>
      <p>{policy.intro}</p>
      {policy.sections.map((s) => (
        <section key={s.h}>
          <h2>{s.h}</h2>
          {s.p?.map((x) => <p key={x}>{x}</p>)}
          {s.li && (
            <ul>
              {s.li.map((x) => <li key={x}>{x}</li>)}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

export default async function PrivacyPage() {
  const { t, locale } = await getT();
  const policy = POLICY[locale];
  return (
    <div className="auth-bg">
      <main className="auth-card legal-card">
        <LanguageSwitch locale={locale} next="/privacy" title={t('lang.label')} />
        <div className="auth-brand">
          <BrandLogo width={180} />
          <div className="auth-product">{t('common.product')}</div>
        </div>
        <h1>{policy.title}</h1>
        <p className="muted small">{policy.updatedLabel}: {POLICY_UPDATED}</p>
        <PolicyBody policy={policy} />
        <details className="legal-en" lang="en">
          <summary>{POLICY.en.title} (English)</summary>
          <p className="muted small">{POLICY.en.updatedLabel}: {POLICY_UPDATED}</p>
          <PolicyBody policy={POLICY.en} />
        </details>
        <p style={{ marginTop: 24, textAlign: 'center' }}><Link href="/login">{t('auth.login.submit')}</Link></p>
        <div className="footer-note">GKH TRADING INVEST SRL</div>
      </main>
    </div>
  );
}
