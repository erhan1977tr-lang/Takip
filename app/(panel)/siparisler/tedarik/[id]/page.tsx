import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { fmtBytes, fmtDate, fmtDateTime, fmtDec, fmtNum, isoDay } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { loadSupplierOrder, orderableProducts } from '@/server/suppliers/service.js';
import { loadReceipts } from '@/server/suppliers/receipt.js';
import { LIMITS, catalogPrice, etaCalendarWarning, etaReminderDue, orderUnitOf, activeRecipients, showPrices, supplierOrderActions } from '@/server/suppliers/rules.js';
import { calendarOverrides } from '@/server/calendar/service.js';
import { dayKeyOf, localDay } from '@/server/profile/dates.js';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import { UNITS } from '@/prisma/seed/data/units.js';
import {
  cancelAction, correctReceiptAction, deleteDraftAction, discardRevisionAction, etaAction, receiveGoodsAction, receivedAction, removeFileAction, resendAction,
  startRevisionAction, uploadFilesAction,
} from '../actions';
import { supplierErrorText } from '../labels';
import { SupplierStatusBadge } from '@/components/SupplierStatus';
import { SupplierOrderEditor, type EditorProduct } from './SupplierOrderEditor';
import { PreviewFor } from '@/components/PreviewFor';

export const dynamic = 'force-dynamic';

const OK = ['created', 'saved', 'approved', 'resent', 'revision', 'discarded', 'eta', 'etaCleared', 'received', 'receivedPart', 'receivedAll', 'corrected', 'correctedReopened', 'cancelled', 'files', 'fileRemoved'];
const SEND_ERRORS = ['NO_EMAIL', 'FILE_NOT_CLEAN', 'FILE_MISSING', 'SMTP', 'UNKNOWN', 'PARTIAL', 'NO_SUPPLIER_CODE'];
const SKIP = ['CANCELLED', 'SUPERSEDED', 'GONE', 'IPTAL', 'TESLIM_ALINDI'];
const SCAN_TONE: Record<string, string> = { CLEAN: 'ok', SKIPPED: 'muted', PENDING: 'warn', INFECTED: 'danger' };
type JobPayload = {
  revision?: number; attempt?: number; manual?: boolean; to?: string | null;
  recipients?: string[]; sentTo?: string[]; unknown?: string[]; failed?: string[];
};
/** İşin alıcıları ve her birinin sonucu (DÜZELTME 10 M9; eski işlerde tek "to") */
const jobRecipients = (p: JobPayload) => {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const list = arr(p.recipients).length ? arr(p.recipients) : typeof p.to === 'string' ? [p.to] : [];
  return list.map((to) => ({ to, result: arr(p.sentTo).includes(to) || (p.to === to && !p.recipients) ? 'SENT' : arr(p.unknown).includes(to) ? 'UNKNOWN' : arr(p.failed).includes(to) ? 'FAILED' : 'WAIT' }));
};

/**
 * Tedarikçi siparişi (Paket 6, kararlar 181–184). Taslak düzenlenir; tedarikçiye yalnızca "Siparişi onayla / gönder" ile
 * gider. Gönderilmiş revizyon değişmez (değişiklik yeni revizyon); e-posta gönderimleri, tahmini yükleme tarihi, teslim /
 * iptal ve geçmiş burada. Yalnızca SUPPLIER_MANAGE (yönetici).
 */
export default async function SupplierOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
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
  const rc = await loadReceipts(db, order.id);
  const receipts = rc?.receipts ?? [];
  const actions = supplierOrderActions({ status: order.status, hasDraft: !!draft, pendingJob, hasReceipts: receipts.length > 0 });
  // Mal kabulü (karar 282): tedarik VE stok yetkisi (serviste de denetlenir)
  const canReceive = actions.includes('receive') && userCan(admin, 'STOCK_MANAGE') && !!rc && rc.lines.some((l) => (l.remaining ?? 0) > 0 && l.compatible);
  // Mal kabulü düzeltmesi (karar 286): aynı iki yetki (serviste de denetlenir); kabulün düzeltilebilir satırı varsa form
  const canCorrect = userCan(admin, 'STOCK_MANAGE');
  const can = (a: string) => actions.includes(a);
  const recipients = activeRecipients(order.supplier.emails);
  const email = recipients.length ? recipients.join(', ') : null;
  const target = { supplierId: order.supplierId, currency: order.currency };
  const editorProducts: EditorProduct[] = products.map((p) => ({
    id: p.id, code: p.code, label: localName(p, locale), nameTr: p.nameTr || p.nameRo, orderUnit: orderUnitOf(p),
    catalogPrice: catalogPrice(p, target), own: p.supplierId === order.supplierId,
    otherSupplier: p.supplierId && p.supplierId !== order.supplierId ? p.supplier?.name ?? null : null,
    supplierCode: p.supplierCode ?? null,
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
    // Kuyrukta iş yoksa e-posta "gönderilmedi"dir, hata değil (mal kabulü düzeltmesiyle yeniden açılmış sipariş — karar 286)
    : order.status === 'GONDERIM_BEKLIYOR' ? t(pendingJob ? 'supplier.order.statusInfo.GONDERIM_BEKLIYOR' : 'supplier.order.statusInfo.NOT_SENT')
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
            <dd data-supplier-email>{email ? recipients.map((a) => <div key={a} className="mono">{a}</div>) : <><Badge tone="danger">{t('supplier.settings.noEmail')}</Badge> <Link href="/admin/entegrasyonlar/tedarikciler">{t('supplier.order.settingsLink')}</Link></>}</dd>
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
                  <th>{t('supplier.order.editor.col.code')}</th><th>{t('supplier.order.editor.col.description')}</th>
                  <th className="num">{t('supplier.order.editor.col.qty')}</th><th>{t('supplier.order.editor.col.unit')}</th>
                  <th className="num">{t('supplier.order.editor.col.price')}</th><th className="num">{t('supplier.order.editor.col.total')}</th>
                </tr>
              </thead>
              <tbody>
                {final.lines.map((l) => (
                  <tr key={l.id} data-final-line={l.code}>
                    <td className="mono">{l.code}</td><td>{l.description}</td>
                    <td className="num">{l.qty}</td><td>{unitLabel(l.unitCode, locale)}</td>
                    <td className="num nowrap">{l.unitPrice != null ? `${fmtDec(l.unitPrice.toString(), 4)} ${order.currency}` : <Badge tone="warn">{t('supplier.order.editor.noPrice')}</Badge>}</td>
                    <td className="num nowrap">{l.lineTotal != null ? `${fmtNum(l.lineTotal.toString())} ${order.currency}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="num"><b>{t('supplier.order.editor.grandTotal')}</b></td>
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

      {canReceive && rc && (
        <div className="card card-flush" id="mal-kabul">
          <div className="card-head"><h2>{t('supplier.order.receipt.title')}</h2></div>
          <p className="card-sub muted small">{t('supplier.order.receipt.intro')}</p>
          <form action={receiveGoodsAction}>
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('supplier.order.receipt.col.code')}</th><th>{t('supplier.order.receipt.col.description')}</th>
                    <th>{t('supplier.order.receipt.col.length')}</th><th>{t('supplier.order.receipt.col.unit')}</th>
                    <th className="num">{t('supplier.order.receipt.col.ordered')}</th><th className="num">{t('supplier.order.receipt.col.received')}</th>
                    <th className="num">{t('supplier.order.receipt.col.now')}</th><th className="num">{t('supplier.order.receipt.col.remaining')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rc.lines.map((l) => (
                    <tr key={l.id} data-receipt-line={l.code}>
                      <td className="mono">{l.code}</td>
                      <td>{l.description}</td>
                      <td className="nowrap">{l.length ? `${fmtDec(l.length, 3)} m` : '—'}</td>
                      <td>{unitLabel(l.unitCode, locale)}</td>
                      <td className="num" data-ordered>{l.ordered}</td>
                      <td className="num" data-received>{l.received}</td>
                      <td className="num">
                        {!l.compatible ? <Badge tone="warn">{t('supplier.order.receipt.unitMismatch')}</Badge>
                          : (l.remaining ?? 0) === 0 ? <Badge tone="ok">{t('supplier.order.receipt.done')}</Badge>
                            : <input type="number" name={`q_${l.id}`} min={0} max={l.remaining} step={1} inputMode="numeric" style={{ width: 90 }} aria-label={`${t('supplier.order.receipt.col.now')} ${l.code}`} />}
                      </td>
                      <td className="num" data-remaining>{l.remaining}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12, padding: '12px 16px', alignItems: 'flex-end' }}>
              <div>
                <label htmlFor="rc-date">{t('supplier.order.receipt.date')}</label>
                <input id="rc-date" type="date" name="receivedOn" required defaultValue={today} max={today} />
              </div>
              <div>
                <label htmlFor="rc-ref">{t('supplier.order.receipt.reference')}</label>
                <input id="rc-ref" name="reference" maxLength={100} />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="rc-note">{t('supplier.order.receipt.note')}</label>
                <input id="rc-note" name="note" maxLength={500} />
              </div>
              <ConfirmButton primary message={t('supplier.order.receipt.confirm')}>{t('supplier.order.receipt.submit')}</ConfirmButton>
            </div>
          </form>
        </div>
      )}

      {receipts.length > 0 && (
        <div className="card card-flush" id="kabuller">
          <div className="card-head"><h2>{t('supplier.order.receipt.listTitle')} <span className="badge">{receipts.length}</span></h2></div>
          {receipts.map((r) => (
            <div key={r.id} data-receipt={r.seq} style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <b>{t('supplier.order.receipt.item', { n: r.seq })}</b>
                <span>{fmtDate(r.receivedOn)}</span>
                {r.reference && <span className="mono small">{r.reference}</span>}
                <Badge tone={r.complete ? 'ok' : 'info'}>{r.complete ? t('supplier.order.receipt.complete') : t('supplier.order.receipt.partial')}</Badge>
                {r._count.stockMoves > 0 && <Badge tone="ok">{t('supplier.order.receipt.stock')}</Badge>}
                <Badge tone={r.mail?.status === 'SENT' ? 'ok' : r.mail?.status === 'FAILED' ? 'danger' : r.mail ? 'info' : 'muted'}>
                  {t(`supplier.order.receipt.mail.${r.mail?.status && ['PENDING', 'SENT', 'FAILED', 'SKIPPED'].includes(r.mail.status) ? r.mail.status : 'none'}` as MsgKey)}
                </Badge>
                <a className="btn" href={`/siparisler/tedarik/${order.id}/kabul/${r.id}`} target="_blank" rel="noopener" data-receipt-pdf>{t('supplier.order.receipt.pdf')}</a>
              </div>
              <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {r.lines.map((l) => (
                  <li key={l.id} data-receipt-row={l.code} data-accepted={l.qty} data-corrected={l.corrected} data-net={l.net}>
                    <span className="mono">{l.code}</span> — {l.description}: <b>{l.qty}</b> {unitLabel(l.unitCode, locale)}
                    {l.corrected > 0 && <> · <Badge tone="warn">{t('supplier.order.receipt.corrected')}</Badge> {t('supplier.order.correction.net')}: <b>{l.net}</b> {unitLabel(l.unitCode, locale)} <span className="muted">(−{l.corrected})</span></>}
                  </li>
                ))}
              </ul>
              <div className="muted small">{fmtDateTime(r.createdAt)}{r.by && <> · {t('supplier.order.receipt.by', { who: r.by })}</>}{r.note && <> · {r.note}</>}</div>
              {r.corrections.length > 0 && (
                <div className="receipt-fixes" data-corrections={r.seq}>
                  <b className="small">{t('supplier.order.correction.listTitle')}</b>
                  {r.corrections.map((c) => (
                    <div key={c.id} data-correction={c.seq} style={{ marginTop: 6 }}>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <Badge tone="warn">{t('supplier.order.correction.item', { n: c.seq })}</Badge>
                        <span className="small">{t('supplier.order.correction.ofReceipt', { n: r.seq })}</span>
                        {c.reopened && <Badge tone="info">{t('supplier.order.correction.reopened')}</Badge>}
                        <Badge tone={c.mail?.status === 'SENT' ? 'ok' : c.mail?.status === 'FAILED' ? 'danger' : c.mail ? 'info' : 'muted'}>
                          {t(`supplier.order.receipt.mail.${c.mail?.status && ['PENDING', 'SENT', 'FAILED', 'SKIPPED'].includes(c.mail.status) ? c.mail.status : 'none'}` as MsgKey)}
                        </Badge>
                        <a className="btn" href={`/siparisler/tedarik/${order.id}/duzeltme/${c.id}`} target="_blank" rel="noopener" data-correction-pdf>{t('supplier.order.correction.pdf')}</a>
                      </div>
                      <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {c.lines.map((l) => (
                          <li key={l.id} data-correction-line={l.code}>
                            {t('supplier.order.correction.line', { code: l.code, description: l.description, qty: l.qty, unit: unitLabel(l.unitCode, locale), before: l.stockBefore, after: l.stockAfter })}
                          </li>
                        ))}
                      </ul>
                      <div className="muted small" style={{ whiteSpace: 'pre-line' }} data-correction-reason>{c.reason}</div>
                      <div className="muted small">{fmtDateTime(c.createdAt)}{c.by && <> · {t('supplier.order.correction.by', { who: c.by })}</>}</div>
                    </div>
                  ))}
                </div>
              )}
              {canCorrect && rc && r.lines.some((l) => l.correctable > 0) && (
                <details className="receipt-fix-form" data-correct-receipt={r.seq}>
                  <summary className="btn">{t('supplier.order.correction.title')}</summary>
                  <p className="muted small">{t('supplier.order.correction.intro')}</p>
                  <form action={correctReceiptAction}>
                    <input type="hidden" name="orderId" value={order.id} />
                    <input type="hidden" name="receiptId" value={r.id} />
                    <input type="hidden" name="v" value={rc.version} />
                    <input type="hidden" name="requestKey" value={randomUUID()} />
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{t('supplier.order.correction.col.code')}</th><th>{t('supplier.order.correction.col.description')}</th><th>{t('supplier.order.correction.col.unit')}</th>
                            <th className="num">{t('supplier.order.correction.col.accepted')}</th><th className="num">{t('supplier.order.correction.col.corrected')}</th>
                            <th className="num">{t('supplier.order.correction.col.net')}</th><th className="num">{t('supplier.order.correction.col.now')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.lines.map((l) => (
                            <tr key={l.id} data-correct-line={l.code}>
                              <td className="mono">{l.code}</td>
                              <td>{l.description}</td>
                              <td>{unitLabel(l.unitCode, locale)}</td>
                              <td className="num">{l.qty}</td>
                              <td className="num">{l.corrected}</td>
                              <td className="num">{l.net}</td>
                              <td className="num">
                                {l.correctable > 0
                                  ? <input type="number" name={`c_${l.id}`} min={0} max={l.correctable} step={1} inputMode="numeric" style={{ width: 90 }} aria-label={`${t('supplier.order.correction.col.now')} ${l.code}`} />
                                  : <span className="muted">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ padding: '8px 0' }}>
                      <label htmlFor={`cr-reason-${r.id}`}>{t('supplier.order.correction.reason')}</label>
                      <textarea id={`cr-reason-${r.id}`} name="reason" required maxLength={1000} rows={2} placeholder={t('supplier.order.correction.reasonPlaceholder')} />
                    </div>
                    <ConfirmButton outline danger message={t('supplier.order.correction.confirm')}>{t('supplier.order.correction.submit')}</ConfirmButton>
                  </form>
                </details>
              )}
            </div>
          ))}
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
                      <td className="mono small" data-recipients>
                        {jobRecipients(p).length === 0 ? '—' : jobRecipients(p).map((x) => (
                          <div key={x.to} data-recipient={x.result}>{x.to}{j.status !== 'PENDING' && <span className="muted"> · {t(`supplier.order.emails.result.${x.result}` as MsgKey)}</span>}</div>
                        ))}
                      </td>
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
                  // Düzeltme (karar 286): kabul no, ürün, düzeltilen adet, önceki → yeni stok, gerekçe
                  : h.action === 'SUPPLIER_RECEIPT_CORRECTED' ? [
                    t('supplier.order.correction.ofReceipt', { n: String(d.receiptSeq ?? '') }),
                    ...(Array.isArray(d.lines) ? d.lines : []).map((l: { code?: string; qty?: number; unitCode?: string; stockBefore?: number; stockAfter?: number }) => `${l.code ?? ''} −${l.qty ?? ''} ${l.unitCode ? unitLabel(l.unitCode, locale) : ''} (${l.stockBefore ?? ''} → ${l.stockAfter ?? ''})`),
                    String(d.reason ?? ''),
                  ].filter(Boolean).join(' · ')
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
      <PreviewFor href={`/dosya/tedarik/${f.id}`} name={f.name} scanStatus={f.scanStatus} />
      {f.scanStatus !== 'INFECTED' && <a className="btn" href={`/dosya/tedarik/${f.id}`}>{t('common.download')}</a>}
      {children}
    </div>
  );
}
