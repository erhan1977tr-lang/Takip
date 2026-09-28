import { DRAWING, OFFER, ORDER_STATUS, customerSummary } from '@/server/orders/rules.js';

const TONE: Record<string, string> = {
  muted: 'badge-muted', purple: 'badge-purple', warn: 'badge-warn', danger: 'badge-danger', info: 'badge-info', ok: 'badge-ok',
};

export function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge ${TONE[tone ?? ''] ?? ''}`}>{children}</span>;
}

/** Siparişin genel aşaması (iç ekip). */
export function OrderBadge({ status, onHold = false }: { status: string; onHold?: boolean }) {
  const s = ORDER_STATUS[status as keyof typeof ORDER_STATUS];
  return (
    <>
      <Badge tone={s?.tone}>{s?.label ?? status}</Badge>
      {onHold && <> <Badge tone="muted">Beklemede</Badge></>}
    </>
  );
}

export function DrawingBadge({ track }: { track: string }) {
  const d = DRAWING[track as keyof typeof DRAWING];
  return <Badge tone={d?.tone}>{d?.label ?? track}</Badge>;
}

export function OfferBadge({ status }: { status: string | null | undefined }) {
  const o = OFFER[(status ?? 'NONE') as keyof typeof OFFER];
  return <Badge tone={o?.tone}>{o?.label ?? status}</Badge>;
}

/** Müşterinin gördüğü tek rozet. */
export function CustomerBadge({ status, drawing, offer }: { status: string; drawing: string; offer: string | null }) {
  const s = customerSummary({ status, drawing, offer });
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
