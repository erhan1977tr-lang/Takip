import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission, type CurrentUser } from '@/lib/auth/session';
import { currentOffer, customerLabel, loadOrder, sentOffer, type OrderDetail } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { fmtBytes, fmtDate, fmtDateTime, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import { getT, type Dict, type T } from '@/lib/i18n';
import {
  blockerText, customerDrawingText, customerSummaryText, eventNoteText, eventText, lineKindText, roleText, slaText, stageText,
} from '@/lib/labels';
import { CustomerBadge, DrawingBadge, OfferBadge, OrderBadge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { OfferEditor } from './OfferEditor';
import { loadOf } from '@/lib/loading';
import { CRATE_MAX_KG, CRATE_TARE_KG } from '@/server/orders/loading.js';
import { glassLabel, itemGlassName } from '@/server/catalog/glass.js';
import {
  ALLOWED_EXT, STAGES, availableActions, offerLineTotals, offerNeedsCheck, productionBlockers, slaInfo, stageIndex,
} from '@/server/orders/rules.js';
import {
  addFilesAction, addNoteAction, approveDrawingAction, archiveAction, cancelAction, checkOfferAction, holdAction, saveCratesAction,
  markShippedAction, noDrawingAction, requestRevisionAction, sendToDrawingAction, setShipDateAction,
  startDrawingAction, undoDrawingAction, undoNoDrawingAction, uploadDrawingAction,
} from './actions';

/** İşlem sonrası bildirim (?ok=<kod>, metni: order.ok.<kod>); bilinmeyen kodda null. */
function okText(m: Dict, code: string | undefined): string | null {
  const ok = m.order.ok;
  return code && Object.hasOwn(ok, code) ? ok[code as keyof typeof ok] : null;
}

// "Sıradaki adım" satırında gösterilen işlemler (metinleri: order.steps.<işlem>)
const STEP_ACTIONS = [
  'send_to_drawing', 'no_drawing', 'edit_offer', 'approve_price', 'start_drawing', 'upload_drawing', 'approve_drawing',
  'request_revision', 'mark_shipped', 'archive', 'unhold',
] as const;
type StepAction = (typeof STEP_ACTIONS)[number];
const isStep = (a: string): a is StepAction => (STEP_ACTIONS as readonly string[]).includes(a);

function turnText(t: T, order: OrderDetail): string {
  if (order.onHold) return t('order.turn.onHold');
  const offer = currentOffer(order)?.status ?? null;
  const at = (who: string) => t('order.turn.text', { who });
  if (order.status === 'YENI') return at(t('order.turn.sales'));
  if (order.status === 'URETIMDE') return at(t('order.turn.salesLoading'));
  if (order.status === 'YUKLENDI') return at(t('order.turn.salesArchive'));
  if (order.status !== 'HAZIRLANIYOR') return t('order.turn.none');
  const parts: string[] = [];
  const d = order.drawingTrack;
  if (d === 'GEREKLI' || d === 'YAPILIYOR' || d === 'REVIZYON_ISTENDI') parts.push(t('order.turn.drawingTeam'));
  if (d === 'ONAY_BEKLIYOR') parts.push(t('order.turn.customerApproval'));
  if (offer === null || offer === 'HAZIRLANIYOR') parts.push(t('order.turn.salesOffer'));
  if (offer === 'YONETIMDE') parts.push(t('order.turn.adminPrice'));
  return parts.length ? at(parts.join(' · ')) : t('order.turn.none');
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePermission('ORDER_VIEW');
  const { t, m, locale } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const order = await loadOrder(id, user);
  const isCustomer = user.appRole === 'MUSTERI';
  const offer = currentOffer(order);
  const sent = sentOffer(order);
  const acts = availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: offer?.status ?? null,
  });
  const can = (a: string) => acts.includes(a);
  const sla = isCustomer ? null : slaInfo(order.slaDeadline);
  const stage = stageIndex(order.status);
  const editable = !!offer && (can('edit_offer') || can('approve_price'));
  const updating = !editable && !!offer && can('update_offer') && sp.teklif === 'guncelle';
  const catalog = editable || updating
    ? (await db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] })).map((g) => glassLabel(g, locale))
    : [];
  // Veri zaten sunucuda temizlendi (lib/orders.ts → sanitizeOrder); çizim ekibi teklif görmez,
  // müşteri ve denetimci yalnızca müşteriye gönderilmiş teklifi görür.
  const shownOffer = !userCan(user, 'OFFER_VIEW') ? undefined : isCustomer ? sent : editable || updating ? undefined : offer;
  const finalPrice = !userCan(user, 'OFFER_DRAFT_VIEW');
  const sentVersions = order.offers.filter((o) => o.status === 'GONDERILDI').length;
  const lastDrawing = order.drawings[order.drawings.length - 1];
  // Teklif müşteriye gittikten sonra yeni çizim geldiyse ölçüler değişmiş olabilir (events en yeniden eskiye sıralı)
  const needsCheck = !isCustomer && userCan(user, 'OFFER_VIEW') && (order.status === 'HAZIRLANIYOR' || order.status === 'URETIMDE') && offerNeedsCheck({
    offer: offer?.status ?? null, sentAt: offer?.sentAt ?? null, lastDrawing: lastDrawing ?? null,
    checkedAt: order.events.find((e) => e.event === 'OFFER_CHECKED')?.createdAt ?? null,
  });
  const updateHref = `/siparisler/${order.id}?teklif=guncelle#teklif`;
  const ok = okText(m, sp.ok);

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p className="small"><Link href="/siparisler">← {isCustomer ? t('order.back.myOrders') : t('order.back.orders')}</Link></p>
          <h1>{order.title || order.orderNo}</h1>
          <div className="row">
            <span className="mono muted">{order.orderNo}</span>
            {isCustomer
              ? <CustomerBadge status={order.status} drawing={order.drawingTrack} offer={sent ? 'GONDERILDI' : null} />
              : <OrderBadge status={order.status} onHold={order.onHold} />}
            {!isCustomer && <span className="muted small">· {customerLabel(user, order.customer.name)}</span>}
          </div>
        </div>
        {sla && <span className={sla.over ? 'sla-over' : sla.risk ? 'sla-risk' : 'sla-ok'}>● {slaText(t, sla)}</span>}
      </div>

      {ok && <div className="alert alert-ok">{ok}</div>}
      {sp.error && <div className="alert alert-error">{sp.error}</div>}

      <div className="card">
        <div className="stepper">
          {STAGES.map((key, i) => {
            const cls = i < stage ? 'done' : i === stage ? 'current' : '';
            return (
              <div key={key} className={`step ${cls}`}>
                <div className="dot">{i < stage ? '✓' : String(i + 1).padStart(2, '0')}</div>
                <div className="lbl">{stageText(t, key)}</div>
                {i === stage && sla && <div className={`sla-chip ${sla.over ? 'over' : ''}`}>{slaText(t, sla)}</div>}
              </div>
            );
          })}
        </div>
        {order.status === 'HAZIRLANIYOR' && (
          <div className="tracks">
            <div className="track">
              <span className="k">{t('order.tracks.drawing')}</span>
              {isCustomer
                ? <span>{customerDrawingText(t, order.drawingTrack)}</span>
                : <DrawingBadge track={order.drawingTrack} />}
            </div>
            <div className="track">
              <span className="k">{t('order.tracks.offer')}</span>
              {isCustomer ? <span>{sent ? t('order.tracks.offerReady') : t('order.tracks.preparing')}</span> : <OfferBadge status={offer?.status} />}
            </div>
          </div>
        )}
      </div>

      {needsCheck && lastDrawing && (
        <div className="alert alert-warn">
          <b>{t('order.check.title', { v: lastDrawing.version, date: fmtDateTime(lastDrawing.createdAt) })}</b>{' '}
          {can('update_offer') ? t('order.check.admin') : t('order.check.other')}
          {can('update_offer') && !updating && (
            <div className="row" style={{ marginTop: 10 }}>
              <Link href={updateHref} className="btn btn-primary">{t('order.check.update')}</Link>
              <form action={checkOfferAction}>
                <input type="hidden" name="id" value={order.id} />
                <button className="btn">{t('order.check.noChange')}</button>
              </form>
            </div>
          )}
        </div>
      )}

      {isCustomer ? <CustomerActions order={order} user={user} can={can} t={t} /> : <InternalActions order={order} user={user} can={can} acts={acts} t={t} />}

      {(editable || updating) && offer && (
        <OfferEditor
          orderId={order.id}
          version={order.version}
          mode={updating ? 'update' : can('approve_price') ? 'admin' : 'sales'}
          cancelHref={`/siparisler/${order.id}#teklif`}
          currency={offer.currency}
          catalog={catalog}
          statusLabel={updating ? t('offer.editor.statusUpdating', { n: sentVersions + 1 }) : offer.status === 'YONETIMDE' ? t('offer.editor.statusAdmin') : t('offer.editor.statusSales')}
          camEtiket={order.camEtiket ?? order.customer.camEtiket ?? ''}
          sandikEtiket={order.sandikEtiket ?? order.customer.sandikEtiket ?? ''}
          initial={offer.lines.map((l) => ({
            description: l.description, poz: l.poz ?? '', enMm: l.enMm?.toString() ?? '', boyMm: l.boyMm?.toString() ?? '',
            adet: String(l.adet), unit: l.unit, unitPrice: Number(l.unitPrice) ? Number(l.unitPrice).toFixed(2) : '',
            kind: l.kind, free: l.free,
          }))}
          m={m.offer}
          common={m.common}
          problemsMsg={m.offerProblems}
          lineKind={m.status.lineKind}
        />
      )}

      <div className="detail-grid">
        <div>
          {shownOffer && (
            <OfferView order={order} offer={shownOffer} isCustomer={isCustomer} finalPrice={finalPrice} versions={sentVersions} updateHref={can('update_offer') ? updateHref : undefined} t={t} />
          )}
          {!isCustomer && order.status !== 'YENI' && <Crates order={order} canEdit={can('edit_crates')} t={t} />}
          <Drawings order={order} user={user} t={t} />
          <Files order={order} user={user} canAdd={can('add_file')} t={t} />
          <Notes order={order} user={user} t={t} />
        </div>

        <aside>
          <div className="card">
            <h2>{t('order.info.title')}</h2>
            <table className="kv"><tbody>
              <tr><td>{t('order.info.orderNo')}</td><td className="mono">{order.orderNo}</td></tr>
              <tr><td>{t('order.info.customerOrderNo')}</td><td>{order.customerOrderNo}</td></tr>
              {!isCustomer && <tr><td>{t('order.info.customer')}</td><td>{customerLabel(user, order.customer.name)}</td></tr>}
              <tr><td>{t('order.info.orderDate')}</td><td>{fmtDate(order.createdAt)}</td></tr>
              <tr><td>{t('order.info.estimatedShip')}</td><td>{fmtDate(order.estimatedShipDate)}</td></tr>
              {order.actualShipDate && <tr><td>{t('order.info.shipped')}</td><td>{fmtDate(order.actualShipDate)}</td></tr>}
              <tr><td>{t('order.info.drawing')}</td><td>{order.status === 'YENI' ? (isCustomer ? '—' : t('order.info.drawingPending')) : order.drawingTrack === 'YOK' ? t('order.info.drawingNotNeeded') : t('order.info.drawingNeeded')}</td></tr>
              {order.drawingTrack !== 'YOK' && <tr><td>{t('order.info.revisions')}</td><td>{t('order.info.revisionRounds', { n: order.revisionCount })}</td></tr>}
              {order.assignedDrawer && !isCustomer && <tr><td>{t('order.info.drawer')}</td><td>{order.assignedDrawer.name || order.assignedDrawer.email}</td></tr>}
              {!isCustomer && <tr><td>{t('order.info.labels')}</td><td>{order.camEtiket ?? '—'} / {order.sandikEtiket ?? '—'}</td></tr>}
            </tbody></table>
            {order.items.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>{t('order.info.requestedGlass')}</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {order.items.map((it) => <li key={it.id}>{itemGlassName(it, locale) || t('order.info.glassFallback')} × {it.camAdedi}</li>)}
                </ul>
              </>
            )}
          </div>
          <div className="card">
            <h2>{t('order.history')}</h2>
            <ul className="timeline">
              {order.events.map((e) => {
                const label = eventText(t, e.event, isCustomer);
                if (label === null) return null;
                const note = eventNoteText(t, e.event, e.note, isCustomer);
                return (
                  <li key={e.id}>
                    <div><b>{label}</b>{note ? ` — ${note}` : ''}</div>
                    <div className="when">{fmtDateTime(e.createdAt)}{!isCustomer && e.user ? ` · ${e.user.name || e.user.email}` : ''}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}

// ---------------- işlem kartları ----------------
function CustomerActions({ order, user, can, t }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean; t: T }) {
  const s = customerSummaryText(t, { status: order.status, drawing: order.drawingTrack, offer: sentOffer(order) ? 'GONDERILDI' : null });
  const latest = order.drawings[order.drawings.length - 1];
  // Müşteri ekranda gördüğü sürüme karar verir; bu arada yeni sürüm yüklendiyse işlem reddedilir
  const hidden = <><input type="hidden" name="id" value={order.id} />{latest && <input type="hidden" name="drawingId" value={latest.id} />}</>;
  const waiting = order.drawingTrack === 'ONAY_BEKLIYOR' && order.status === 'HAZIRLANIYOR';
  return (
    <div className={`card ${waiting ? 'turn' : ''}`}>
      <h2 style={{ marginBottom: 4 }}>{s.next}</h2>
      {waiting && !user.canApprove && (
        <div className="alert alert-warn" style={{ marginTop: 8 }}>{t('order.customer.noApproveRight')}</div>
      )}
      {waiting && <p className="muted small">{t('order.customer.reviewHint')}</p>}
      {can('approve_drawing') && (
        <form action={approveDrawingAction} style={{ marginTop: 10 }}>
          {hidden}
          <ConfirmButton primary message={t('order.customer.approveConfirm')}>{t('order.steps.approve_drawing')}</ConfirmButton>
        </form>
      )}
      {can('request_revision') && (
        <form action={requestRevisionAction} style={{ marginTop: 14 }}>
          {hidden}
          <label htmlFor="rev-comment">{t('order.customer.revisionLabel')}</label>
          <textarea id="rev-comment" name="comment" rows={2} required placeholder={t('order.customer.revisionPlaceholder')} />
          <div className="row end" style={{ marginTop: 8 }}><button className="btn btn-danger">{t('order.steps.request_revision')}</button></div>
        </form>
      )}
      {!waiting && <p className="muted small">{t('order.customer.nothingToDo')}</p>}
    </div>
  );
}

function InternalActions({ order, user, can, acts, t }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean; acts: string[]; t: T }) {
  const hidden = <input type="hidden" name="id" value={order.id} />;
  const offerStatus = currentOffer(order)?.status ?? null;
  const steps = acts.filter(isStep).map((a) => t(`order.steps.${a}`));
  const blockers = order.status === 'HAZIRLANIYOR' && !order.onHold && userCan(user, 'ORDER_REVIEW')
    ? productionBlockers({ status: order.status, drawing: order.drawingTrack, offer: offerStatus })
    : [];
  const buttons: React.ReactNode[] = [];
  const btn = (key: string, action: (fd: FormData) => Promise<void>, label: string, extra?: React.ReactNode, confirm?: string) =>
    buttons.push(
      <form key={key} action={action}>
        {hidden}{extra}
        {confirm ? <ConfirmButton primary message={confirm}>{label}</ConfirmButton> : <button className="btn btn-primary">{label}</button>}
      </form>
    );

  if (can('send_to_drawing')) btn('d', sendToDrawingAction, t('order.steps.send_to_drawing'));
  if (can('no_drawing')) btn('o', noDrawingAction, t('order.steps.no_drawing'));
  if (can('start_drawing')) btn('sd', startDrawingAction, t('order.steps.start_drawing'));
  if (can('mark_shipped')) btn('ms', markShippedAction, t('order.steps.mark_shipped'));
  if (can('archive')) btn('ar', archiveAction, t('order.steps.archive'));
  const undo = (key: string, action: (fd: FormData) => Promise<void>, label: string, message: string) =>
    buttons.push(<form key={key} action={action}>{hidden}<ConfirmButton message={message}>{label}</ConfirmButton></form>);
  if (can('undo_drawing')) undo('ud', undoDrawingAction, t('order.actions.undoDrawing'), t('order.actions.undoDrawingConfirm'));
  if (can('undo_no_drawing')) undo('un', undoNoDrawingAction, t('order.actions.undoNoDrawing'), t('order.actions.undoNoDrawingConfirm'));
  if (can('hold')) btn('h', holdAction, t('order.actions.hold'), <input type="hidden" name="hold" value="1" />);
  if (can('unhold')) btn('uh', holdAction, t('order.steps.unhold'), <input type="hidden" name="hold" value="0" />);

  const hasForms = can('upload_drawing') || can('set_ship_date') || can('cancel');

  return (
    <>
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>{turnText(t, order)}</h2>
        <p className="muted small">
          {steps.length ? t('order.turn.nextStep', { steps: steps.join(' · ') }) : t('order.turn.noAction')}
          {' '}· {t('order.turn.yourRole', { role: roleText(t, user.appRole) })}
        </p>
      </div>

      {(buttons.length > 0 || hasForms || blockers.length > 0) && (
        <div className="card turn">
          <h2 style={{ marginBottom: 2 }}>{t('order.actions.title')}</h2>
          <p className="muted small">{t('order.actions.hint')}</p>
          {buttons.length > 0 && <div className="row" style={{ marginTop: 10 }}>{buttons}</div>}

          {blockers.length > 0 && (
            <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
              <b>{t('order.actions.waitingFor')}</b> {blockers.map((b) => blockerText(t, b)).join(' · ')}
            </div>
          )}

          {can('upload_drawing') && (
            <form action={uploadDrawingAction} style={{ marginTop: 14 }}>
              {hidden}
              <label htmlFor="drawing-file">{t(order.drawingTrack === 'REVIZYON_ISTENDI' ? 'order.upload.labelRevised' : 'order.upload.label', { v: order.drawings.length + 1 })}</label>
              <div className="row">
                <input id="drawing-file" name="file" type="file" required accept={ACCEPT} style={{ flex: 1 }} />
                <button className="btn btn-primary">{t('order.upload.submit')}</button>
              </div>
            </form>
          )}

          {can('set_ship_date') && (
            <form action={setShipDateAction} className="row" style={{ marginTop: 14 }}>
              {hidden}
              <label htmlFor="ship-date" style={{ margin: 0 }}>{t('order.shipDate.label')}</label>
              <input id="ship-date" name="date" type="date" defaultValue={isoDay(order.estimatedShipDate)} style={{ width: 'auto' }} required />
              <button className="btn">{t('order.shipDate.submit')}</button>
            </form>
          )}

          {can('cancel') && (
            <details style={{ marginTop: 14 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>{t('order.cancel.summary')}</summary>
              <form action={cancelAction} className="row" style={{ marginTop: 8 }}>
                {hidden}
                <input name="note" type="text" required placeholder={t('order.cancel.reason')} style={{ flex: 1 }} />
                <ConfirmButton danger message={t('order.cancel.confirm')}>{t('order.cancel.submit')}</ConfirmButton>
              </form>
            </details>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- teklif ----------------
type Offer = OrderDetail['offers'][number];

// Eski kayıtlarda açıklaması boş CNC / delik satırına tür adı yazılırdı; rozetle aynı bilgi tekrar gösterilmez.
const LEGACY_SUB_DESC: Record<string, string> = { CNC: 'CNC', DELIK: 'Delik' };

function OfferView({ order, offer, isCustomer, finalPrice, versions, updateHref, t }: { order: OrderDetail; offer: Offer; isCustomer: boolean; finalPrice: boolean; versions: number; updateHref?: string; t: T }) {
  // Müşteri ve denetimci müşteriye giden (yönetici) tutarı görür
  const total = offer.status === 'GONDERILDI' && order.price && finalPrice ? order.price.amount : offer.amount;
  const updated = offer.status === 'GONDERILDI' && versions > 1;
  return (
    <div className="card" id="teklif">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{isCustomer ? t('offer.view.titleCustomer') : t('offer.view.title')}</h2>
        <span className="row">
          {!isCustomer && <OfferBadge status={offer.status} />}
          {!isCustomer && updated && <span className="badge badge-info">{t('offer.view.version', { n: versions })}</span>}
          {offer.sentAt && (
            <span className="muted small">
              {updated
                ? t('offer.view.updatedAt', { date: fmtDate(offer.sentAt) })
                : isCustomer ? fmtDate(offer.sentAt) : t('offer.view.sentAt', { date: fmtDate(offer.sentAt) })}
            </span>
          )}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>{t('offer.cols.description')}</th><th>{t('offer.cols.poz')}</th><th className="num">{t('offer.cols.width')}</th><th className="num">{t('offer.cols.height')}</th><th className="num">{t('offer.cols.qty')}</th><th className="num">{t('offer.cols.metraj')}</th><th className="num">{t('offer.cols.unitPrice')}</th><th className="num">{t('offer.cols.amount')}</th></tr></thead>
          <tbody>
            {(() => {
              let n = 0;
              return offer.lines.map((l) => {
                const tot = offerLineTotals({ ...l, unitPrice: l.unitPrice.toString() });
                const sub = l.kind === 'CNC' || l.kind === 'DELIK';
                if (!sub) n += 1;
                const kindLabel = sub ? lineKindText(t, l.kind) : '';
                const desc = sub && (l.description === kindLabel || l.description === LEGACY_SUB_DESC[l.kind]) ? '' : l.description;
                return (
                  <tr key={l.id} className={sub ? 'sub-line' : undefined}>
                    <td className="muted">{sub ? '' : n}</td>
                    <td>
                      {sub && <span className="badge badge-info">{kindLabel}</span>}{' '}
                      {desc}
                      {l.free && <> <span className="badge badge-ok">{t('offer.free')}</span></>}
                    </td>
                    <td>{l.poz ?? ''}</td>
                    <td className="num">{l.enMm ?? ''}</td><td className="num">{l.boyMm ?? ''}</td><td className="num">{l.adet}</td>
                    <td className="num">{!sub && l.unit === 'm2' ? `${fmtNum(tot.metraj)} m²` : '—'}</td>
                    <td className="num">{l.free ? t('offer.free') : `${fmtNum(l.unitPrice.toString())} / ${!sub && l.unit === 'm2' ? 'm²' : t('common.unitPiece')}`}</td>
                    <td className="num">{fmtNum(tot.amount)}</td>
                  </tr>
                );
              });
            })()}
          </tbody>
          <tfoot><tr><td colSpan={8}>{t('common.total')}</td><td className="num"><b>{fmtMoney(total.toString(), offer.currency)}</b></td></tr></tfoot>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <p className="muted small" style={{ margin: 0 }}>{t('common.pricesExclVat')}</p>
        {updateHref && <Link href={updateHref} className="btn">{t('offer.view.update')}</Link>}
      </div>
    </div>
  );
}

// ---------------- sandıklar ----------------
function Crates({ order, canEdit, t }: { order: OrderDetail; canEdit: boolean; t: T }) {
  const load = loadOf(order, false);
  const blanks = Math.max(1, 2 - order.crates.length) + (order.crates.length ? 0 : 1);
  const rows = [...order.crates.map((c) => ({ key: c.id, dim: c.dimensions ?? '', net: c.netAgirlik?.toString() ?? '', brut: c.brutAgirlik?.toString() ?? '' })),
    ...Array.from({ length: canEdit ? blanks : 0 }, (_, i) => ({ key: `new${i}`, dim: '', net: '', brut: '' }))];
  return (
    <div className="card" id="sandik">
      <h2>{t('order.crates.title')}</h2>
      <p className="muted small">
        {t('order.crates.plan', { m2: fmtNum(load.metraj), glass: load.camAdet, net: fmtNum(load.netKg, 0), crates: load.crates, gross: fmtNum(load.grossKg, 0) })}{' '}
        {load.realCrates
          ? t('order.crates.real')
          : t('order.crates.estimate', { max: fmtNum(CRATE_MAX_KG, 0), tare: CRATE_TARE_KG })}
      </p>
      {rows.length > 0 && (
        <form action={saveCratesAction}>
          <input type="hidden" name="id" value={order.id} />
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>{t('order.crates.dim')}</th><th>{t('order.crates.net')}</th><th>{t('order.crates.gross')}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.key}>
                    <td className="muted">{i + 1}</td>
                    <td><input name="c_dim" defaultValue={r.dim} disabled={!canEdit} aria-label={t('order.crates.dimAria')} /></td>
                    <td><input name="c_net" inputMode="decimal" defaultValue={r.net} disabled={!canEdit} style={{ width: 100 }} aria-label={t('order.crates.netAria')} /></td>
                    <td><input name="c_brut" inputMode="decimal" defaultValue={r.brut} disabled={!canEdit} style={{ width: 100 }} aria-label={t('order.crates.grossAria')} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span className="hint">{t('order.crates.hint')}</span>
              <button className="btn btn-primary">{t('order.crates.save')}</button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

// ---------------- çizim, dosya, not ----------------
function Drawings({ order, user, t }: { order: OrderDetail; user: CurrentUser; t: T }) {
  if (order.drawingTrack === 'YOK' && order.drawings.length === 0) return null;
  const isCustomer = user.appRole === 'MUSTERI';
  return (
    <div className="card">
      <h2>{t('order.drawings.title')}</h2>
      {order.drawings.length === 0 ? (
        <p className="muted">{t('order.drawings.none')}</p>
      ) : (
        [...order.drawings].reverse().map((d, i) => (
          <div key={d.id} style={{ marginBottom: 10 }}>
            <div className="file-row">
              <div className="file-ext">{(d.fileName ?? '').split('.').pop()?.slice(0, 4) || t('order.drawings.fileFallback')}</div>
              <div className="grow">
                <div className="fname">{d.fileName ?? t('order.drawings.fallbackName', { v: d.version })}</div>
                <div className="small muted">
                  <span className={`badge ${i === 0 ? 'badge-info' : 'badge-muted'}`}>v{d.version}{i === 0 ? ` · ${t('order.drawings.current')}` : ''}</span>{' '}
                  {d.status === 'ONAYLANDI' ? <span className="badge badge-ok">{t('order.drawings.approved')}</span> : d.status === 'REVIZYON_ISTENDI' ? <span className="badge badge-danger">{t('order.drawings.revisionRequested')}</span> : d.status === 'ONAY_BEKLIYOR' ? <span className="badge badge-warn">{t('order.drawings.pending')}</span> : null}
                  {' '}<ScanBadge status={d.scanStatus} t={t} />
                  {' '}{d.fileSize ? fmtBytes(d.fileSize) : ''} · {fmtDateTime(d.createdAt)}{!isCustomer ? ` · ${d.uploadedBy.name || d.uploadedBy.email}` : ''}
                </div>
              </div>
              <FileButtons href={`/dosya/cizim/${d.id}`} name={d.fileName ?? ''} scanStatus={d.scanStatus} t={t} />
            </div>
            {d.revisions.map((r) => (
              <div key={r.id} className="note" style={{ marginLeft: 50 }}>
                <b className="small">{t('order.drawings.revisionRequest')}</b> {r.comment}
                <div className="meta">{fmtDateTime(r.createdAt)}</div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// Müşterinin ve çizimcinin yükleyebileceği türler (server/orders/rules.js → ALLOWED_EXT)
const ACCEPT = ALLOWED_EXT.map((e: string) => `.${e}`).join(',');
const VIEWABLE = ['pdf', 'png', 'jpg', 'jpeg'];

/** Antivirüs durumu: taranmadı (uyarı) ya da virüslü (karantina, indirilemez). Temiz/tarama kapalı → rozet yok. */
function ScanBadge({ status, t }: { status: string; t: T }) {
  if (status === 'PENDING') return <span className="badge badge-warn" title={t('order.files.scanPendingTitle')}>{t('order.files.scanPending')}</span>;
  if (status === 'INFECTED') return <span className="badge badge-danger">{t('order.files.infected')}</span>;
  return null;
}

function FileButtons({ href, name, scanStatus, t }: { href: string; name: string; scanStatus: string; t: T }) {
  if (scanStatus === 'INFECTED') return null;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      {VIEWABLE.includes(ext) && <a className="btn" href={`${href}?ac=1`} target="_blank" rel="noopener">{t('common.open')}</a>}
      <a className="btn" href={href}>{t('common.download')}</a>
    </span>
  );
}

function Files({ order, user, canAdd, t }: { order: OrderDetail; user: CurrentUser; canAdd: boolean; t: T }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const files = order.files.filter((f) => !isCustomer || f.kind === 'CUSTOMER');
  return (
    <div className="card">
      <h2>{isCustomer ? t('order.files.titleCustomer') : t('order.files.title')}</h2>
      {files.length === 0 && <p className="muted">{t('order.files.none')}</p>}
      {files.map((f) => (
        <div key={f.id} className="file-row">
          <div className="file-ext">{f.name.split('.').pop()?.slice(0, 4)}</div>
          <div className="grow">
            <div className="fname">{f.name}</div>
            <div className="small muted">
              <ScanBadge status={f.scanStatus} t={t} />{f.scanStatus === 'PENDING' || f.scanStatus === 'INFECTED' ? ' ' : ''}
              {fmtBytes(f.size)} · {fmtDateTime(f.createdAt)}
              {!isCustomer && <> · {f.kind === 'CUSTOMER' ? t('order.files.fromCustomer') : <span className="badge badge-muted">{t('order.files.internal')}</span>}</>}
            </div>
          </div>
          <FileButtons href={`/dosya/siparis/${f.id}`} name={f.name} scanStatus={f.scanStatus} t={t} />
        </div>
      ))}
      {canAdd && (
        <form action={addFilesAction} className="row" style={{ marginTop: 10 }}>
          <input type="hidden" name="id" value={order.id} />
          <input name="files" type="file" multiple required accept={ACCEPT} style={{ flex: 1 }} aria-label={t('order.files.add')} />
          <button className="btn">{t('order.files.add')}</button>
        </form>
      )}
      {canAdd && !isCustomer && <p className="hint">{t('order.files.internalHint')}</p>}
    </div>
  );
}

function Notes({ order, user, t }: { order: OrderDetail; user: CurrentUser; t: T }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const notes = order.notes; // iç notlar müşteriye hiç yüklenmez (sanitizeOrder)
  return (
    <div className="card" id="notlar">
      <h2>{t('order.notes.title')}</h2>
      <p className="muted small">{t('order.notes.intro')}{!isCustomer && ` ${t('order.notes.introInternal')}`}</p>
      {notes.length === 0 && <p className="muted">{t('order.notes.none')}</p>}
      {notes.map((n) => (
        <div key={n.id} className={`note ${n.internal ? 'internal' : ''}`}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
          <div className="meta">
            {n.user.name || n.user.email}{!isCustomer || n.user.appRole === 'MUSTERI' ? ` (${roleText(t, n.user.appRole)})` : ''} · {fmtDateTime(n.createdAt)}
            {n.internal && <> · <b>{t('order.notes.internal')}</b></>}
          </div>
        </div>
      ))}
      {userCan(user, 'NOTE_ADD') && <form action={addNoteAction} style={{ marginTop: 10 }}>
        <input type="hidden" name="id" value={order.id} />
        <textarea name="text" rows={2} required placeholder={t('order.notes.placeholder')} aria-label={t('order.notes.aria')} />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          {userCan(user, 'NOTE_INTERNAL_VIEW') ? <label className="check small"><input type="checkbox" name="internal" /> {t('order.notes.internalCheck')}</label> : <span />}
          <span className="row"><span className="muted small">{t('order.notes.noEdit')}</span><button className="btn btn-primary">{t('order.notes.send')}</button></span>
        </div>
      </form>}
    </div>
  );
}
