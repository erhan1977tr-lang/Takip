'use client';

import { ErrorView } from '@/components/ErrorView';

// Panel sayfalarındaki hatalar: menü ve üst çubuk yerinde kalır.
export default function PanelError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="card"><ErrorView error={error} reset={reset} /></div>;
}
