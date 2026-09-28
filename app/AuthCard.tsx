import { BrandLogo } from '@/components/BrandLogo';

export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-bg">
      <main className="auth-card">
        <div className="auth-brand">
          <BrandLogo width={220} />
          <div className="auth-product">TAKİP · Sipariş ve Üretim Portalı</div>
        </div>
        {children}
        <div className="footer-note">Developed by gkhdigital.ro and gkhdigital.com</div>
      </main>
    </div>
  );
}
