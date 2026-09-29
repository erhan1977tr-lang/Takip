import { DRAWING, OFFER, ORDER_STATUS } from '@/server/orders/rules.js';
import { getT } from '@/lib/i18n';
import { customerSummaryText, drawingText, offerText, orderStatusText } from '@/lib/labels';

const TONE: Record<string, string> = {
  muted: 'badge-muted', purple: 'badge-purple', warn: 'badge-warn', danger: 'badge-danger', info: 'badge-info', ok: 'badge-ok',
};

export function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge ${TONE[tone ?? ''] ?? ''}`}>{children}</span>;
}

/** Siparişin genel aşaması (iç ekip). */
export async function OrderBadge({ status, onHold = false }: { status: string; onHold?: boolean }) {
  const { t } = await getT();
  const s = ORDER_STATUS[status as keyof typeof ORDER_STATUS];
  return (
    <>
      <Badge tone={s?.tone}>{orderStatusText(t, status)}</Badge>
      {onHold && <> <Badge tone="muted">{t('status.onHold')}</Badge></>}
    </>
  );
}

export async function DrawingBadge({ track }: { track: string }) {
  const { t } = await getT();
  const d = DRAWING[track as keyof typeof DRAWING];
  return <Badge tone={d?.tone}>{drawingText(t, track)}</Badge>;
}

export async function OfferBadge({ status }: { status: string | null | undefined }) {
  const { t } = await getT();
  const o = OFFER[(status ?? 'NONE') as keyof typeof OFFER];
  return <Badge tone={o?.tone}>{offerText(t, status)}</Badge>;
}

/** Müşterinin gördüğü tek rozet. */
export async function CustomerBadge({ status, drawing, offer }: { status: string; drawing: string; offer: string | null }) {
  const { t } = await getT();
  const s = customerSummaryText(t, { status, drawing, offer });
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
