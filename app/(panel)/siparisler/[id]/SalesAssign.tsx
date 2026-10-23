// Sorumlu satışçı kartı (karar 300): yalnızca atama yetkisi olanlara (ORDER_ASSIGN — yönetici, yönetici yardımcısı) ve
// yalnızca cam siparişinde. Atama / yönlendirme işlemi sunucuda denetlenir (server/orders/transitions.js → assign_sales);
// buradaki engel listesi yalnızca bilgi içindir (aynı kural: server/orders/sales-routing.js → reassignBlocks).
import { ConfirmButton } from '@/components/ConfirmButton';
import type { MsgKey, T } from '@/lib/i18n';
import { assignDrawerAction, assignSalesAction } from './actions';

export type SalesOption = { id: string; name: string; drawer: string | null };
export type DrawerOption = { id: string; name: string };

export function SalesAssign({
  orderId, version, ownerId, owner, drawer, drawerId = null, drawers = [], canDrawer = false, via, options, blocks, linked, t,
}: {
  orderId: string; version: number;
  ownerId: string | null; owner: string | null; drawer: string | null; via: string | null;
  /** Çizimci değiştirme (karar 303): siparişin şu anki çizimcisi ve seçilebilecek etkin çizimciler */
  drawerId?: string | null; drawers?: DrawerOption[]; canDrawer?: boolean;
  options: SalesOption[]; blocks: string[]; linked: boolean; t: T;
}) {
  const drawerChoices = drawers.filter((d) => d.id !== drawerId);
  const assigned = !!owner;
  const choices = options.filter((o) => o.id !== ownerId);
  const viaText = via && ['AUTO', 'MANUAL', 'REASSIGN', 'MIGRATION'].includes(via) ? t(`team.assign.via.${via}` as MsgKey) : null;
  return (
    <div className="card" id="sorumlu" data-sales-assign={assigned ? 'assigned' : 'unassigned'}>
      <h2>{t('team.assign.title')}</h2>
      {!assigned && <div className="alert alert-warn" data-sales-unassigned>{t('team.assign.unassigned')}</div>}
      {assigned && (
        <dl className="order-info">
          <div><dt>{t('team.assign.owner')}</dt><dd data-sales-owner>{owner}</dd></div>
          <div><dt>{t('team.assign.drawer')}</dt><dd data-sales-drawer>{drawer ?? t('team.assign.noDrawer')}</dd></div>
          {viaText && <div><dt>{t('team.assign.assignedAt')}</dt><dd>{viaText}</dd></div>}
        </dl>
      )}
      {!linked ? (
        <p className="muted" data-sales-not-linked>{t('team.assign.notLinked')}</p>
      ) : assigned && blocks.length > 0 ? (
        <p className="muted" data-sales-blocked>
          {t('team.assign.reassignClosed')} {blocks.map((b) => t(`team.block.${b}` as MsgKey)).join(', ')}
        </p>
      ) : choices.length === 0 ? (
        <p className="muted">{t('team.assign.noSales')}</p>
      ) : (
        <form action={assignSalesAction} className="row">
          <input type="hidden" name="id" value={orderId} />
          <input type="hidden" name="v" value={version} />
          <label className="sr-only" htmlFor="sorumlu-satis">{t('team.assign.pick')}</label>
          <select id="sorumlu-satis" name="salesUserId" required defaultValue="">
            <option value="" disabled>{t('team.assign.pick')}</option>
            {choices.map((o) => (
              <option key={o.id} value={o.id}>{t('team.assign.option', { name: o.name, drawer: o.drawer ?? t('team.assign.noDrawer') })}</option>
            ))}
          </select>
          <ConfirmButton primary message={t(assigned ? 'team.assign.confirmReassign' : 'team.assign.confirmAssign')}>
            {t(assigned ? 'team.assign.submitReassign' : 'team.assign.submitAssign')}
          </ConfirmButton>
        </form>
      )}
      {/* Çizimci değiştirme (karar 303): yalnızca çizimci alanı değişir; sürümler, dosyalar ve müşteri onayları korunur */}
      {canDrawer && (
        <div className="drawer-assign" id="cizimci" data-drawer-assign>
          <h3 className="sub-title">{t('team.drawer.title')}</h3>
          {!assigned && <dl className="order-info"><div><dt>{t('team.assign.drawer')}</dt><dd data-drawer-current>{drawer ?? t('team.assign.noDrawer')}</dd></div></dl>}
          <p className="hint">{t('team.drawer.keeps')}</p>
          {drawerChoices.length === 0 ? <p className="muted">{t('team.drawer.none')}</p> : (
            <form action={assignDrawerAction} className="row">
              <input type="hidden" name="id" value={orderId} />
              <input type="hidden" name="v" value={version} />
              <label className="sr-only" htmlFor="cizimci-sec">{t('team.drawer.pick')}</label>
              <select id="cizimci-sec" name="drawerId" required defaultValue="">
                <option value="" disabled>{t('team.drawer.pick')}</option>
                {drawerChoices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <label className="sr-only" htmlFor="cizimci-gerekce">{t('team.drawer.reason')}</label>
              <input id="cizimci-gerekce" name="reason" type="text" maxLength={500} placeholder={t('team.drawer.reason')} />
              <ConfirmButton message={t('team.drawer.confirm')}>{t('team.drawer.submit')}</ConfirmButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
