import { getT, type MsgKey } from '@/lib/i18n';
import { Badge } from '@/components/StatusBadge';

/** Tedarikçi siparişinin durum rozeti (Paket 6). Renk tek başına anlam taşımaz: rozet her zaman metinlidir. */
export const SUPPLIER_STATUS_TONE: Record<string, string> = {
  TASLAK: 'muted', GONDERIM_BEKLIYOR: 'info', GONDERILDI: 'ok', GONDERIM_HATASI: 'danger', TESLIM_ALINDI: 'purple', IPTAL: 'muted',
};

export async function SupplierStatusBadge({ status }: { status: string }) {
  const { t } = await getT();
  return <span data-supplier-status={status}><Badge tone={SUPPLIER_STATUS_TONE[status]}>{t(`supplier.status.${status}` as MsgKey)}</Badge></span>;
}
