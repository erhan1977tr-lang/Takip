import { BrandLogo } from '@/components/BrandLogo';
import { LanguageSwitch } from '@/components/LanguageSwitch';
import { getT } from '@/lib/i18n';

/** Giriş ve ilk giriş ekranlarının kartı. next: dil değiştirilince dönülecek adres (bu sayfa). */
export async function AuthCard({ children, next }: { children: React.ReactNode; next: string }) {
  const { t, locale } = await getT();
  return (
    <div className="auth-bg">
      <main className="auth-card">
        <LanguageSwitch locale={locale} next={next} title={t('lang.label')} />
        <div className="auth-brand">
          <BrandLogo width={220} />
          <div className="auth-product">{t('common.product')}</div>
        </div>
        {children}
        <div className="footer-note">Developed by gkhdigital.ro and gkhdigital.com</div>
      </main>
    </div>
  );
}
