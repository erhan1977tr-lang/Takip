'use client';

import './globals.css';
import { ErrorView } from '@/components/ErrorView';

// Kök düzen dahil her şey çöktüğünde (Next'in boş "Application error" ekranı yerine).
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="tr">
      <body>
        <div className="auth-bg">
          <main className="auth-card"><ErrorView error={error} /></main>
        </div>
      </body>
    </html>
  );
}
