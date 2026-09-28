import { STATUS } from '@/server/orders/rules.js';

const TONE: Record<string, string> = {
  muted: 'badge-muted', purple: 'badge-purple', warn: 'badge-warn', danger: 'badge-danger',
  info: 'badge-info', ok: 'badge-ok',
};

export function StatusBadge({ status, customer = false, onHold = false }: { status: string; customer?: boolean; onHold?: boolean }) {
  const s = STATUS[status as keyof typeof STATUS];
  if (!s) return <span className="badge">{status}</span>;
  return (
    <>
      <span className={`badge ${TONE[s.tone] ?? ''}`}>{customer ? s.customer : s.label}</span>
      {onHold && <> <span className="badge badge-muted">Beklemede</span></>}
    </>
  );
}
