import { requirePermission } from '@/lib/auth/session';
import { PriceTablesView } from './PriceTablesView';

// Satışçıların fiyat tabloları (karar 26)
export default async function PriceTablesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('PRICE_TABLE_MANAGE');
  return <PriceTablesView kind="SALES" sp={await searchParams} />;
}
