'use client';

import { ErrorView } from '@/components/ErrorView';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="auth-bg">
      <main className="auth-card"><ErrorView error={error} reset={reset} /></main>
    </div>
  );
}
