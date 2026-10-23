// Sorumlu satışçı kartı (karar 300, 304): yalnızca atama yetkisi olanlara (ORDER_ASSIGN — yönetici, yönetici yardımcısı) ve
// yalnızca cam siparişinde. "Sorumlu satışçı: Murat · Değiştir" — değiştirme formu kapalı başlar, "Değiştir"e basınca açılır.
// Çizimci bağımsız değiştirilmez (karar 304): satışçıyla birlikte, yeni satışçının varsayılan çizimcisi olur.
// Atama / yönlendirme işlemi sunucuda denetlenir (server/orders/transitions.js → assign_sales); buradaki engel listesi yalnızca
// bilgi içindir (aynı kural: server/orders/sales-routing.js → reassignBlocks).
import { ConfirmButton } from '@/components/ConfirmButton';
import type { MsgKey, T } from '@/lib/i18n';
import { assignSalesAction } from './actions';

export type SalesOption = { id: string; name: string; drawer: string | null; team: string | null };

function AssignForm({ orderId, version, assigned, choices, t }: { orderId: string; version: number; assigned: boolean; choices: SalesOption[]; t: T }) {
  return (
    <form action={assignSalesAction} className="row" data-sales-form>
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="v" value={version} />
      <label className="sr-only" htmlFor="sorumlu-satis">{t('team.assign.pick')}</label>
      <select id="sorumlu-satis" name="salesUserId" required defaultValue="">
        <option value="" disabled>{t('team.assign.pick')}</option>
        {choices.map((o) => (
          <option key={o.id} value={o.id}>
            {o.team ? `${o.team} · ` : ''}{t('team.assign.option', { name: o.name, drawer: o.drawer ?? t('team.assign.noDrawer') })}
          </option>
        ))}
      </select>
      <ConfirmButton primary message={t(assigned ? 'team.assign.confirmReassign' : 'team.assign.confirmAssign')}>
        {t(assigned ? 'team.assign.submitReassign' : 'team.assign.submitAssign')}
      </ConfirmButton>
    </form>
  );
}

export function SalesAssign({
  orderId, version, ownerId, owner, drawer, via, options, blocks, linked, t,
}: {
  orderId: string; version: number;
  ownerId: string | null; owner: string | null; drawer: string | null; via: string | null;
  options: SalesOption[]; blocks: string[]; linked: boolean; t: T;
}) {
  const assigned = !!owner;
  const choices = options.filter((o) => o.id !== ownerId);
  const viaText = via && ['AUTO', 'MANUAL', 'REASSIGN', 'MIGRATION'].includes(via) ? t(`team.assign.via.${via}` as MsgKey) : null;
  const canChange = linked && blocks.length === 0 && choices.length > 0;
  return (
    <div className="card" id="sorumlu" data-sales-assign={assigned ? 'assigned' : 'unassigned'}>
      <h2>{t('team.assign.title')}</h2>
      {!assigned && <div className="alert alert-warn" data-sales-unassigned>{t('team.assign.unassigned')}</div>}
      {assigned && (
        <>
          <div className="owner-line">
            <span>{t('team.assign.ownerLabel')}: <b data-sales-owner>{owner}</b></span>
            {canChange && (
              <details className="sales-change" data-sales-change>
                <summary><span className="when-closed">· {t('team.assign.change')}</span><span className="when-open">· {t('team.assign.changeCancel')}</span></summary>
                <AssignForm orderId={orderId} version={version} assigned choices={choices} t={t} />
              </details>
            )}
          </div>
          <div className="owner-line">
            <span>{t('team.assign.drawerLabel')}: <b data-sales-drawer>{drawer ?? t('team.assign.noDrawer')}</b></span>
          </div>
          {viaText && <p className="muted small">{t('team.assign.assignedAt')}: {viaText}</p>}
        </>
      )}
      {!linked ? (
        <p className="muted" data-sales-not-linked>{t('team.assign.notLinked')}</p>
      ) : assigned && blocks.length > 0 ? (
        <p className="muted" data-sales-blocked>
          {t('team.assign.reassignClosed')} {blocks.map((b) => t(`team.block.${b}` as MsgKey)).join(', ')}
        </p>
      ) : choices.length === 0 ? (
        <p className="muted">{t('team.assign.noSales')}</p>
      ) : !assigned ? (
        <AssignForm orderId={orderId} version={version} assigned={false} choices={choices} t={t} />
      ) : null}
    </div>
  );
}
