import { requirePermission } from '@/lib/auth/session';
import { ReceivablesView } from '../ReceivablesView';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('ACCOUNTING_MANAGE');
  return <ReceivablesView type="PROFILE_ORDER" sp={await searchParams} />;
}
