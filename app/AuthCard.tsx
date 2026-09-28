export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-bg">
      <main className="auth-card">
        <div className="brand">
          <b>TAKİP</b>
          <span className="version">v2.25</span>
        </div>
        {children}
        <div className="footer-note">Developed by gkhdigital.ro and gkhdigital.com</div>
      </main>
    </div>
  );
}
