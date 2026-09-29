import { requirePermission } from '@/lib/auth/session';
import { PriceTablesView } from '../fiyatlar/PriceTablesView';

// Müşteriye özel fiyatlar (karar 32): yönetim kopyasında müşteri fiyatı olarak kendiliğinden gelir
export default async function CustomerPricesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('PRICE_TABLE_MANAGE');
  return <PriceTablesView kind="CUSTOMER" sp={await searchParams} />;
}
