import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { fmtBytes, fmtDate, fmtDateTime, fmtDec, fmtNum, isoDay } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { loadSupplierOrder, orderableProducts } from '@/server/suppliers/service.js';
import { LIMITS, catalogPrice, etaCalendarWarning, etaReminderDue, orderUnitOf, showPrices, supplierEmail, supplierOrderActions } from '@/server/suppliers/rules.js';
import { calendarOverrides } from '@/server/calendar/service.js';
import { dayKeyOf, localDay } from '@/server/profile/dates.js';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import { UNITS } from '@/prisma/seed/data/units.js';
import {
  cancelAction, deleteDraftAction, discardRevisionAction, etaAction, receivedAction, removeFileAction, resendAction, startRevisionAction,
  uploadFilesAction,
} from '../actions';
import { supplierErrorText } from '../labels';
import { SupplierStatusBadge } from '@/components/SupplierStatus';
import { SupplierOrderEditor, type EditorProduct } from './SupplierOrderEditor';

export const dynamic = 'force-dynamic';

const OK = ['created', 'saved', 'approved', 'resent', 'revision', 'discarded', 'eta', 'etaCleared', 'received', 'cancelled', 'files', 'fileRemoved'];
const SEND_ERRORS = ['NO_EMAIL', 'FILE_NOT_CLEAN', 'FILE_MISSING', 'SMTP', 'UNKNOWN'];
const SKIP = ['CANCELLED', 'SUPERSEDED', 'GONE', 'IPTAL', 'TESLIM_ALINDI'];
const SCAN_TONE: Record<string, string> = { CLEAN: 'ok', SKIPPED: 'muted', PENDING: 'warn', INFECTED: 'danger' };
type JobPayload = { revision?: number; attempt?: number; manual?: boolean; to?: string | null };

/**
 * Tedarikçi siparişi (Paket 6, kararlar 181–184). Taslak düzenlenir; tedarikçiye yalnızca "Siparişi onayla / gönder" ile
 * gider. Gönderilmiş revizyon değişmez (değişiklik yeni revizyon); e-posta gönderimleri, tahmini yükleme tarihi, teslim /
 * iptal ve geçmiş burada. Yalnızca SUPPLIER_MANAGE (yönetici).
 */
export default async function SupplierOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('SUPPLIER_MANAGE');
  const { t, m, locale } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const data = await loadSupplierOrder(db, id);
  if (!data) notFound();
  const { order, draft, final, jobs, history } = data;
  const products = await orderableProducts(db);
  const approver = final?.finalizedById ? await db.user.findUnique({ where: { id: final.finalizedById }, select: { name: true, email: true } }) : null;
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const pendingJob = jobs.some((j) => j.status === 'PENDING');
  const actions = supplierOrderActions({ status: order.status, hasDraft: !!draft, pendingJob });
  const can = (a: string) => actions.includes(a);
  const email = supplierEmail(order.supplier.email);
  const target = { supplierId: order.supplierId, currency: order.currency };
  const editorProducts: EditorProduct[] = products.map((p) => ({
    id: p.id, code: p.code, label: localName(p, locale), nameTr: p.nameTr || p.nameRo, orderUnit: orderUnitOf(p),
    catalogPrice: catalogPrice(p, target), own: p.supplierId === order.supplierId,
    otherSupplier: p.supplierId && p.supplierId !== order.supplierId ? p.supplier?.name ?? null : null,
  }));
  const units = UNITS.map((u) => ({ code: u.code, label: unitLabel(u.code, locale) }));
  const etaDay = order.etaDate ? dayKeyOf(order.etaDate) : null;
  // Türkiye fabrika takvimi (karar 197): ETA kapalı güne denk geliyorsa yalnızca uyarı (tarih ve hatırlatma değişmez)
  const etaWarn = etaDay ? etaCalendarWarning(etaDay, await calendarOverrides(db, 'TR_FACTORY')) : null;
  const etaReason = etaWarn?.holiday
    ? etaWarn.holiday.names.map((k) => t(`calendar.holiday.TR.${k}` as MsgKey)).join(' / ')
    : etaWarn ? t(`calendar.reason.${etaWarn.reason}` as MsgKey) : '';
  const okText = sp.ok && OK.includes(sp.ok) ? t(`supplier.order.ok.${sp.ok}` as MsgKey) : null;
  const errText = supplierErrorText(t, m, sp.error, { row: sp.row, name: sp.name });
  const reason = SEND_ERRORS.includes(order.sendError ?? '') ? t(`supplier.order.sendError.${order.sendError}` as MsgKey) : t('supplier.order.sendError.SMTP');
  const info = order.status === 'TASLAK' ? t('supplier.order.statusInfo.TASLAK')
    : order.status === 'GONDERIM_BEKLIYOR' ? t('supplier.order.statusInfo.GONDERIM_BEKLIYOR')
      : order.status === 'GONDERILDI' ? t('supplier.order.statusInfo.GONDERILDI', { when: fmtDateTime(order.sentAt) })
        : order.status === 'GONDERIM_HATASI' ? t('supplier.order.statusInfo.GONDERIM_HATASI', { reason })
          : order.status === 'TESLIM_ALINDI' ? t('supplier.order.statusInfo.TESLIM_ALINDI', { when: fmtDateTime(order.receivedAt) })
            : t('supplier.order.statusInfo.IPTAL', { when: fmtDateTime(order.cancelledAt), reason: order.cancelReason ?? '' });
  const infoTone = order.status === 'GONDERIM_HATASI' ? 'alert-error' : order.status === 'GONDERILDI' || order.status === 'TESLIM_ALINDI' ? 'alert-ok' : 'alert-info';
  const finalPrices = final ? showPrices(final.lines.map((l) => ({ unitPrice: l.unitPrice == null ? null : l.unitPrice.toString() }))) : false;

  return (
    <>
      <div className="page-head">
        <p><Link href="/siparisler/tedarik">{t('supplier.order.back')}</Link></p>
        <h1>{t('supplier.order.title', { no: order.orderNo })} <SupplierStatusBadge status={order.status} /></h1>
      </div>
      {okText && <div className="alert alert-ok">{okText}</div>}
      {errText && <div className="alert alert-error" role="alert" data-error={sp.error}>{errText}</div>}
      <div className={`alert ${infoTone}`} data-status-info>{info}</div>

      <div className="card" id="bilgiler">
        <dl className="order-info">
          <div><dt>{t('supplier.order.supplier')}</dt><dd><b>{order.supplier.name}</b>{!order.supplier.isActive && <> <Badge tone="muted">{t('supplier.settings.inactive')}</Badge></>}</dd></div>
          <div>
            <dt>{t('supplier.order.email')}</dt>
            <dd data-supplier-email>{email ? <span className="mono">{email}</span> : <><Badge tone="danger">{t('supplier.settings.noEmail')}</Badge> <Link href="/admin/entegrasyonlar/tedarikciler">{t('supplier.order.settingsLink')}</Link></>}</dd>
          </div>
          <div><dt>{t('supplier.order.currency')}</dt><dd>{order.currency}</dd></div>
          <div><dt>{t('supplier.order.created')}</dt><dd>{fmtDateTime(order.createdAt)}</dd></div>
          {order.sentAt && <div><dt>{t('supplier.orders.col.sent')}</dt><dd>{fmtDateTime(order.sentAt)}</dd></div>}
          {etaDay && <div><dt>{t('supplier.order.eta.title')}</dt><dd data-eta-info>{fmtDate(`${etaDay}T12:00:00Z`)}</dd></div>}
        </dl>
      </div>

      {draft && can('save_draft') && (
        <SupplierOrderEditor
          key={`${order.id}:${order.version}`}
          m={m.supplier.order}
          orderId={order.id}
          version={order.version}
          revision={draft.revision}
          isRevision={order.status !== 'TASLAK'}
          orderNo={order.orderNo}
          orderNoEditable={order.status === 'TASLAK'}
          orderDate={isoDay(draft.orderDate)}
          note={draft.note ?? ''}
          currency={order.currency}
          email={email}
          lines={draft.lines.map((l) => ({
            productId: l.productId, description: l.description, color: l.color ?? '', qty: String(l.qty), unitCode: l.unitCode,
            unitPrice: l.unitPrice == null ? '' : fmtDec(l.unitPrice.toString(), 4).replace(/\./g, ''),
          }))}
          products={editorProducts}
          units={units}
          canApprove={can('approve_send')}
          maxLines={LIMITS.lines}
        />
      )}

      {draft && can('files') && (
        <div className="card" id="ekler">
          <h2>{t('supplier.order.files.title')}</h2>
          <p className="muted small">{t('supplier.order.files.intro')}</p>
          {draft.files.length === 0 ? <div className="empty">{t('supplier.order.files.empty')}</div> : draft.files.map((f) => (
            <FileItem key={f.id} f={f}>
              <form action={removeFileAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="fileId" value={f.id} />
                <button className="btn btn-link danger">{t('supplier.order.files.remove')}</button>
              </form>
            </FileItem>
          ))}
          <form action={uploadFilesAction} className="row" style={{ marginTop: 10 }}>
            <input type="hidden" name="orderId" value={order.id} />
            <input type="file" name="files" multiple required accept=".pdf,.dwg,.dxf,.step,.stp,.igs,.iges,.xls,.xlsx,.doc,.docx,.zip,.jpg,.jpeg,.png" aria-label={t('supplier.order.files.title')} />
            <button className="btn">{t('supplier.order.files.upload')}</button>
          </form>
        </div>
      )}

      {final && (
        <div className="card card-flush" id="gonderilen">
          <div className="card-head"><h2>{t('supplier.order.final.title', { n: final.revision })}</h2></div>
          <p className="card-sub muted small">
            {t('supplier.orders.col.date')}: {fmtDate(final.orderDate)}
            {approver && <> · {t('supplier.order.final.approvedBy', { who: approver.name || approver.email, when: fmtDateTime(final.finalizedAt) })}</>}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('supplier.order.editor.col.code')}</th><th>{t('supplier.order.editor.col.description')}</th><th>{t('supplier.order.editor.col.color')}</th>
                  <th className="num">{t('supplier.order.editor.col.qty')}</th><th>{t('supplier.order.editor.col.unit')}</th>
                  <th className="num">{t('supplier.order.editor.col.price')}</th><th className="num">{t('supplier.order.editor.col.total')}</th>
                </tr>
              </thead>
              <tbody>
                {final.lines.map((l) => (
                  <tr key={l.id} data-final-line={l.code}>
                    <td className="mono">{l.code}</td><td>{l.description}</td><td>{l.color || '—'}</td>
                    <td className="num">{l.qty}</td><td>{unitLabel(l.unitCode, locale)}</td>
                    <td className="num nowrap">{l.unitPrice != null ? `${fmtDec(l.unitPrice.toString(), 4)} ${order.currency}` : <Badge tone="warn">{t('supplier.order.editor.noPrice')}</Badge>}</td>
                    <td className="num nowrap">{l.lineTotal != null ? `${fmtNum(l.lineTotal.toString())} ${order.currency}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6} className="num"><b>{t('supplier.order.editor.grandTotal')}</b></td>
                  <td className="num nowrap" data-final-total><b>{final.total != null ? `${fmtNum(final.total.toString())} ${order.currency}` : '—'}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {!finalPrices && <div className="alert alert-warn" style={{ margin: 12 }}>{t('supplier.order.editor.missingPrice')}</div>}
          {final.note && <div style={{ padding: '0 16px 12px' }}><b>{t('supplier.order.final.note')}</b><p style={{ whiteSpace: 'pre-line', margin: '4px 0 0' }}>{final.note}</p></div>}
          {final.files.length > 0 && <div style={{ padding: '0 16px 12px' }}>{final.files.map((f) => <FileItem key={f.id} f={f} />)}</div>}
        </div>
      )}

      {/* İşlemler: tahmini yükleme tarihi, revizyon, tekrar gönder, teslim, iptal, taslağı silme */}
      {(can('set_eta') || etaDay) && (
        <div className="card" id="eta">
          <h2>{t('supplier.order.eta.title')}</h2>
          <p className="muted small">{t('supplier.order.eta.intro')}</p>
          {can('set_eta') ? (
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <form action={etaAction} className="row">
                <input type="hidden" name="orderId" value={order.id} />
                <input type="date" name="eta" required defaultValue={etaDay ?? ''} aria-label={t('supplier.order.eta.title')} />
                <button className="btn btn-primary">{t('supplier.order.eta.save')}</button>
              </form>
              {etaDay && (
                <form action={etaAction}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="clear" value="1" />
                  <button className="btn btn-link danger">{t('supplier.order.eta.clear')}</button>
                </form>
              )}
              {etaDay && etaReminderDue({ etaDay, today }) && <Badge tone="warn">{t('supplier.orders.etaSoon')}</Badge>}
            </div>
          ) : <p data-eta-readonly>{etaDay ? fmtDate(`${etaDay}T12:00:00Z`) : t('supplier.order.eta.none')}</p>}
          {etaWarn && etaDay && (
            <div className={`alert ${etaWarn.level === 'closed' ? 'alert-warn' : 'alert-info'}`} data-eta-calendar={etaWarn.level} style={{ marginTop: 10, marginBottom: 0 }}>
              {etaWarn.level === 'closed' ? t('supplier.order.eta.calClosed', { date: fmtDate(`${etaDay}T12:00:00Z`), reason: etaReason })
                : etaWarn.level === 'half' ? t('supplier.order.eta.calHalf', { date: fmtDate(`${etaDay}T12:00:00Z`), reason: etaReason })
                  : t('supplier.order.eta.calNoData', { year: etaDay.slice(0, 4) })}
            </div>
          )}
        </div>
      )}

      {(can('start_revision') || can('discard_revision') || can('resend') || can('mark_received') || can('cancel') || can('delete_draft')) && (
        <div className="card" id="islemler">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {can('resend') && (
              <form action={resendAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <ConfirmButton primary message={t('supplier.order.resend.confirm', { n: final?.revision ?? 1 })}>{t('supplier.order.resend.button')}</ConfirmButton>
              </form>
            )}
            {can('start_revision') && (
              <form action={startRevisionAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="version" value={order.version} />
                <button className="btn">{t('supplier.order.revision.start')}</button>
              </form>
            )}
            {can('discard_revision') && (
              <form action={discardRevisionAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <ConfirmButton outline danger message={t('supplier.order.revision.discardConfirm')}>{t('supplier.order.revision.discard')}</ConfirmButton>
              </form>
            )}
            {can('mark_received') && (
              <form action={receivedAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <ConfirmButton success message={t('supplier.order.receive.confirm')}>{t('supplier.order.receive.button')}</ConfirmButton>
              </form>
            )}
            {can('delete_draft') && (
              <form action={deleteDraftAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <ConfirmButton danger solid message={t('supplier.order.remove.confirm')}>{t('supplier.order.remove.button')}</ConfirmButton>
              </form>
            )}
          </div>
          {can('start_revision') && <p className="muted small" style={{ marginTop: 8 }}>{t('supplier.order.revision.startHint')}</p>}
          {can('cancel') && (
            <form action={cancelAction} id="iptal" className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
              <input type="hidden" name="orderId" value={order.id} />
              <div style={{ flex: 1 }}>
                <label htmlFor="so-cancel">{t('supplier.order.cancel.reason')}</label>
                <input id="so-cancel" name="reason" required maxLength={500} />
              </div>
              <ConfirmButton danger outline message={t('supplier.order.cancel.confirm')}>{t('supplier.order.cancel.button')}</ConfirmButton>
            </form>
          )}
        </div>
      )}

      <div className="card card-flush" id="gonderimler">
        <div className="card-head"><h2>{t('supplier.order.emails.title')} <span className="badge">{jobs.length}</span></h2></div>
        {jobs.length === 0 ? <div className="empty">{t('supplier.order.emails.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('supplier.order.emails.col.when')}</th><th className="num">{t('supplier.order.emails.col.revision')}</th>
                  <th className="num">{t('supplier.order.emails.col.attempt')}</th><th>{t('supplier.order.emails.col.to')}</th>
                  <th>{t('supplier.order.emails.col.status')}</th><th>{t('supplier.order.emails.col.note')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const p = (j.payload && typeof j.payload === 'object' && !Array.isArray(j.payload) ? j.payload : {}) as JobPayload;
                  const err = j.lastError ?? '';
                  const note = j.status === 'SKIPPED' && SKIP.includes(err) ? t(`supplier.order.emails.skipped.${err}` as MsgKey)
                    : j.status === 'FAILED' ? (SEND_ERRORS.includes(err) ? t(`supplier.order.sendError.${err}` as MsgKey) : t('supplier.order.sendError.SMTP'))
                      : j.status === 'PENDING' && err === 'SMTP_CONN' ? t('supplier.order.emails.retrying') : '';
                  return (
                    <tr key={j.id} data-email-job={j.status}>
                      <td className="nowrap small">{fmtDateTime(j.sentAt ?? j.createdAt)}</td>
                      <td className="num">{p.revision ?? '—'}</td>
                      <td className="num">{p.attempt ?? 1}{p.manual && <span className="muted small"> ({t('supplier.order.emails.manual')})</span>}</td>
                      <td className="mono small">{typeof p.to === 'string' ? p.to : '—'}</td>
                      <td><Badge tone={j.status === 'SENT' ? 'ok' : j.status === 'FAILED' ? 'danger' : j.status === 'PENDING' ? 'info' : 'muted'}>{t(`supplier.order.emails.status.${j.status}` as MsgKey)}</Badge></td>
                      <td className="small">{note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-flush" id="gecmis">
        <div className="card-head"><h2>{t('supplier.order.history.title')}</h2></div>
        {history.length === 0 ? <div className="empty">{t('supplier.order.history.empty')}</div> : (
          <ul className="timeline" style={{ padding: '0 16px 12px' }}>
            {history.map((h) => {
              const key = `supplier.order.history.action.${h.action}`;
              const label = Object.hasOwn(m.supplier.order.history.action, h.action) ? t(key as MsgKey) : h.action;
              const d = (h.details && typeof h.details === 'object' && !Array.isArray(h.details) ? h.details : {}) as Record<string, unknown>;
              const extra = h.action === 'SUPPLIER_ORDER_ETA' ? `${d.before ? fmtDate(`${d.before}T12:00:00Z`) : '—'} → ${d.after ? fmtDate(`${d.after}T12:00:00Z`) : '—'}`
                : h.action === 'SUPPLIER_ORDER_CANCELLED' ? String(d.reason ?? '')
                  : typeof d.revision === 'number' ? `${t('supplier.orders.col.revision')} ${d.revision}` : '';
              return (
                <li key={h.id} data-history={h.action}>
                  <span className="muted small">{fmtDateTime(h.createdAt)}</span> · <b>{label}</b>{extra && <> · {extra}</>}
                  <span className="muted small"> · {h.user ? h.user.name || h.user.email : t('supplier.order.history.system')}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/** Ek satırı (ortak .file-row düzeni): uzantı, ad, tarama durumu, boyut; indirme yalnızca yetkili yoldan (/dosya/tedarik) */
async function FileItem({ f, children }: { f: { id: string; name: string; size: number; scanStatus: string; createdAt: Date }; children?: React.ReactNode }) {
  const { t } = await getT();
  return (
    <div className="file-row" data-file={f.name}>
      <div className="file-ext">{f.name.split('.').pop()?.slice(0, 4) ?? ''}</div>
      <div className="grow">
        <div className="fname">{f.name}</div>
        <div className="small muted">
          <Badge tone={SCAN_TONE[f.scanStatus]}>{t(`supplier.order.files.scan.${f.scanStatus}` as MsgKey)}</Badge> {fmtBytes(f.size)} · {fmtDateTime(f.createdAt)}
        </div>
      </div>
      {f.scanStatus !== 'INFECTED' && <a className="btn" href={`/dosya/tedarik/${f.id}`}>{t('common.download')}</a>}
      {children}
    </div>
  );
}
