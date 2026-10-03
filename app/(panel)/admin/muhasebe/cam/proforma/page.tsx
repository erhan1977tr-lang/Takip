import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FxInfo, FxUnavailableNote } from '@/components/FxInfo';
import { bnrRate } from '@/server/fx/bnr.js';
import { getFgoSettings } from '@/server/integrations/fgo.js';
import { batchCustomers, cleanDays, customerLoadingDays, listBatches, previewBatch } from '@/server/glass/batch.js';
import { chainState } from '@/server/glass/invoice-batch.js';
import { createAdvanceAction, reviewInvoiceBatchAction } from '@/app/(panel)/yuklemeler/billing-actions';
import { createBatchAction, reviewBatchAction } from './actions';

export const dynamic = 'force-dynamic';

const PAGE = '/admin/muhasebe/cam/proforma';
const STATUS_TONE = { PENDING: 'info', ISSUED: 'ok', FAILED: 'danger', VOID: 'muted' } as const;
const PROBLEMS = ['NO_DAYS', 'PAST_DAY', 'NOTHING_ELIGIBLE', 'MIXED_CURRENCY', 'BILLING_MISSING', 'FX_UNAVAILABLE'];
const ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'NOT_ALLOWED', 'FGO_DISABLED', 'FGO_DAILY_LIMIT', 'STALE_PREVIEW', 'ALREADY_COVERED'];
type Batch = Prisma.BillingBatchGetPayload<{ include: {
  customer: { select: { name: true } }; document: true; createdBy: { select: { name: true } };
  orders: { select: { orderId: true; orderNo: true; loadingDay: true } };
} }>;
const INVOICE_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'NOT_ALLOWED', 'FGO_DISABLED', 'FGO_DAILY_LIMIT', 'NOTHING_TO_ADVANCE', 'ADVANCE_PENDING'];
const dmy = (day: string) => day.split('-').reverse().join('.');
const dayText = (d: Date) => dmy(new Date(d).toISOString().slice(0, 10));

/**
 * Müşteri düzeyinde yükleme öncesi proforma (Aşama 7D-2): müşteri → gelecekteki yükleme günleri → önizleme → tek FGO
 * proforması. Önizleme, kesilecek belgeyle aynı sunucu hesabından gelir (server/glass/batch.js → previewBatch).
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission('ACCOUNTING_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const customerId = one(sp.musteri);
  const days = cleanDays(sp.gun ?? []);
  const rate = one(sp.kur).trim();
  const error = one(sp.error);
  const ok = one(sp.ok);

  const customers = await batchCustomers(db);
  const chosen = customerId ? await db.customer.findFirst({ where: { id: customerId, type: 'CUSTOMER' }, select: { id: true, name: true } }) : null;
  const [loadingDays, batches, settings] = await Promise.all([
    chosen ? customerLoadingDays(db, { customerId: chosen.id }) : [],
    listBatches(db, { customerId: chosen?.id ?? null }) as Promise<Batch[]>,
    getFgoSettings(db),
  ]);
  // Önizleme: BNR 30 dakika saklanır; kur alınamazsa "alınamadı" gösterilir ve parti oluşturulamaz
  const preview = chosen && days.length > 0
    ? await previewBatch(db, { customerId: chosen.id, days, manualRate: rate || null, vatRate: settings.vatRate, bnrImpl: (o) => bnrRate({ ...o, timeoutMs: 6000 }) })
    : null;
  const p = preview?.ok ? preview : null;
  // Kesilmiş proformaların avans durumu (FGO'da görünen tahsilat, avansı kesilen, avansı kesilmemiş tahsilat)
  const chains = new Map<string, { paid: number; advanced: number; advanceRequired: number; advancePending: boolean; ref: string | null; failed: { batchId: string; lastError: string | null }[] }>();
  for (const b of batches) {
    if (b.status !== 'ISSUED') continue;
    const st = await chainState(db, b.id);
    if (st) {
      chains.set(b.id, {
        paid: st.paid, advanced: st.advanced, advanceRequired: st.advanceRequired, advancePending: st.advancePending, ref: st.ref,
        failed: (st.advances as { batchId: string; status: string; lastError: string | null }[]).filter((a) => a.status === 'FAILED').map((a) => ({ batchId: a.batchId, lastError: a.lastError })),
      });
    }
  }
  const errorKind = one(sp.faturaHata);
  const okKind = one(sp.fatura);
  const problemText = (code: string) => t(`accounting.batch.problems.${code}` as MsgKey, {
    list: code === 'MIXED_CURRENCY' ? (p?.currencies ?? []).join(', ') : (p?.missingBilling ?? []).join(', '),
  });
  const errorText = PROBLEMS.includes(error) ? problemText(error) : t(`accounting.batch.errors.${ERRORS.includes(error) ? error : 'NOT_ALLOWED'}` as MsgKey);

  return (
    <>
      <div className="page-head">
        <p className="small"><Link href="/admin/muhasebe/cam">{t('accounting.batch.back')}</Link></p>
        <h1>{t('accounting.batch.title')}</h1>
        <p className="muted">{t('accounting.batch.intro')}</p>
      </div>
      {ok && <div className="alert alert-ok">{t(`accounting.batch.ok.${['created', 'retry', 'void'].includes(ok) ? ok : 'created'}` as MsgKey, { n: one(sp.n) || '0' })}</div>}
      {error && <div className="alert alert-error">{errorText}</div>}
      {okKind && <div className="alert alert-ok">{t(`accounting.invoice.ok.${['created', 'advance', 'retry', 'void'].includes(okKind) ? okKind : 'advance'}` as MsgKey)}</div>}
      {errorKind && <div className="alert alert-error">{t(`accounting.invoice.errors.${INVOICE_ERRORS.includes(errorKind) ? errorKind : 'NOT_ALLOWED'}` as MsgKey)}</div>}

      {/* 1. Müşteri */}
      <form method="get" action={PAGE} className="card" id="musteri">
        <h2>{t('accounting.batch.customer')}</h2>
        {customers.length === 0 && !chosen ? <p className="muted">{t('accounting.batch.noCustomers')}</p> : (
          <div className="row">
            <select name="musteri" defaultValue={chosen?.id ?? ''} aria-label={t('accounting.batch.customer')} style={{ maxWidth: 520 }}>
              <option value="">{t('accounting.batch.choose')}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{t('accounting.batch.customerOption', { name: c.name, days: c.days, orders: c.orders })}</option>
              ))}
              {chosen && !customers.some((c) => c.id === chosen.id) && <option value={chosen.id}>{chosen.name}</option>}
            </select>
            <button className="btn">{t('accounting.batch.show')}</button>
          </div>
        )}
      </form>

      {/* 2. Gelecekteki yükleme günleri */}
      {chosen && (
        <form method="get" action={PAGE} className="card" id="gunler">
          <input type="hidden" name="musteri" value={chosen.id} />
          <h2>{t('accounting.batch.daysTitle')} — {chosen.name}</h2>
          {loadingDays.length === 0 ? <p className="muted">{t('accounting.batch.noDays')}</p> : (
            <>
              <p className="muted small">{t('accounting.batch.daysHint')}</p>
              <div className="chips" style={{ marginBottom: 12 }}>
                {loadingDays.map((d) => (
                  <label key={d.day} className="chip" style={{ margin: 0 }}>
                    <input type="checkbox" name="gun" value={d.day} defaultChecked={days.includes(d.day)} />
                    <span>
                      {t('accounting.batch.dayOption', { day: dmy(d.day), n: d.eligible + d.excluded })}
                      {d.excluded > 0 && ` (${t('accounting.batch.dayExcluded', { n: d.excluded })})`}
                    </span>
                  </label>
                ))}
              </div>
              <button className="btn btn-primary">{t('accounting.batch.preview')}</button>
            </>
          )}
        </form>
      )}

      {/* 3. Önizleme = kesilecek belge */}
      {chosen && p && (
        <div className="card" id="onizleme">
          <h2>{t('accounting.batch.previewTitle')}</h2>
          {p.problems.map((code) => <div key={code} className="alert alert-warn">{problemText(code)}</div>)}
          {p.included.length > 0 && (
            <div className="table-wrap load-wrap">
              <table className="load-table confirm-table">
                <thead>
                  <tr>
                    <th>{t('accounting.batch.col.line')}</th>
                    <th className="num">{t('accounting.batch.col.qty')}</th>
                    <th>{t('accounting.batch.col.unit')}</th>
                    <th className="num">{t('accounting.batch.col.price')}</th>
                    <th className="num">{t('accounting.batch.col.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {p.byDay.map((d) => {
                    const list = d.orders.filter((o) => !o.reason);
                    if (list.length === 0) return null;
                    return [
                      <tr className="group-total" key={d.day}>
                        <td colSpan={4}><b className="group-name">{t('accounting.batch.dayHead', { day: dmy(d.day) })}</b></td>
                        <td className="num">{fmtMoney(list.reduce((s, o) => s + o.subtotal, 0), list[0].currency ?? '')}</td>
                      </tr>,
                      ...list.flatMap((o) => [
                        <tr className="sub" key={o.orderId}>
                          <td colSpan={4}>
                            <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>
                            {o.title && <span className="muted small"> · {o.title}</span>}
                          </td>
                          <td className="num">{fmtMoney(o.subtotal, o.currency ?? '')}</td>
                        </tr>,
                        ...o.lines.map((l, i) => (
                          <tr className="sub glass-row" key={`${o.orderId}-${i}`}>
                            <td>{l.name}</td>
                            <td className="num">{fmtNum(l.qty)}</td>
                            <td>{l.unit}</td>
                            <td className="num">{fmtNum(l.price)}</td>
                            <td className="num">{fmtNum(l.amount)}</td>
                          </tr>
                        )),
                      ]),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}

          {p.excluded.length > 0 && (
            <div className="fx-block" id="disarida">
              <h3>{t('accounting.batch.excludedTitle')}</h3>
              <ul className="small">
                {p.excluded.map((o) => (
                  <li key={o.orderId}>
                    <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link> · {dmy(o.day)} — {t(`accounting.batch.reason.${o.reason}` as MsgKey)}{o.ref ? ` (${o.ref})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {p.included.length > 0 && p.currency && (
            <>
              <div className="stats stats-money" style={{ marginTop: 16 }}>
                <div className="stat stat-muted"><div className="k">{t('accounting.batch.totals.orders')}</div><div className="v">{p.included.length}</div></div>
                <div className="stat"><div className="k">{t('accounting.batch.totals.source', { cur: p.currency })}</div><div className="v">{fmtNum(p.sourceTotal)}</div></div>
                <div className="stat"><div className="k">{t('accounting.batch.totals.ronNet')}</div><div className="v">{p.ronNet != null ? fmtNum(p.ronNet) : '—'}</div></div>
                <div className="stat"><div className="k">{t('accounting.batch.totals.ronGross')}</div><div className="v">{p.ronGross != null ? fmtNum(p.ronGross) : '—'}</div></div>
              </div>

              {/* Kur: müşterinin kur politikası (tek çözücü) ya da yöneticinin elle girdiği kur */}
              <div className="fx-block" id="kur">
                <h3>{t('accounting.batch.fxTitle')}</h3>
                {p.currency === 'RON' ? <p className="muted small">{t('accounting.batch.ronNote')}</p> : (
                  <>
                    {p.fx ? <FxInfo fx={p.fx} t={t} /> : p.fxError && <FxUnavailableNote code={p.fxError.code} error={p.fxError.error} t={t} />}
                    <form method="get" action={PAGE} className="row">
                      <input type="hidden" name="musteri" value={chosen.id} />
                      {p.days.map((d) => <input key={d} type="hidden" name="gun" value={d} />)}
                      <label htmlFor="lot-kur" style={{ margin: 0 }}>{t('fx.manualLabel')}</label>
                      <input id="lot-kur" name="kur" inputMode="decimal" maxLength={10} style={{ width: 110 }} defaultValue={rate} title={t('fx.manualHint')} />
                      <button className="btn">{t('accounting.batch.manualApply')}</button>
                    </form>
                  </>
                )}
              </div>

              {p.problems.length === 0 && (
                <form action={createBatchAction} className="row end" style={{ marginTop: 16 }} id="olustur">
                  <input type="hidden" name="customerId" value={chosen.id} />
                  {p.days.map((d) => <input key={d} type="hidden" name="day" value={d} />)}
                  <input type="hidden" name="fxRate" value={rate} />
                  <input type="hidden" name="key" value={p.key} />
                  <ConfirmButton primary message={t('accounting.batch.confirm', { n: p.included.length })}>{t('accounting.batch.create')}</ConfirmButton>
                </form>
              )}
            </>
          )}
        </div>
      )}

      {/* 4. Partiler: kuyrukta / kesildi / kesilemedi / geçersiz */}
      <div className="card card-flush" id="partiler">
        <div className="card-head"><h2>{t('accounting.batch.listTitle')}{chosen ? ` — ${chosen.name}` : ''} <span className="badge">{batches.length}</span></h2></div>
        {batches.length === 0 ? <div className="empty">{t('accounting.batch.listEmpty')}</div> : (
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('accounting.batch.listCol.created')}</th>
                  <th>{t('accounting.batch.listCol.customer')}</th>
                  <th>{t('accounting.batch.listCol.days')}</th>
                  <th>{t('accounting.batch.listCol.orders')}</th>
                  <th className="num">{t('accounting.batch.listCol.total')}</th>
                  <th className="num">{t('accounting.batch.listCol.rate')}</th>
                  <th>{t('accounting.batch.listCol.status')}</th>
                  <th>{t('accounting.batch.listCol.doc')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="grp-first">
                    <td className="small nowrap">{fmtDateTime(b.createdAt)}<span className="cell-note">{b.createdBy.name}</span></td>
                    <td>{b.customer.name}</td>
                    <td className="small">{b.loadingDays.map(dayText).join(', ')}</td>
                    <td className="small">
                      {b.orders.map((o, i) => <span key={o.orderId}>{i > 0 && ', '}<Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link></span>)}
                    </td>
                    <td className="num">
                      {fmtMoney(b.sourceTotal.toString(), b.currency)}
                      {b.currency !== 'RON' && <span className="cell-note">{fmtMoney(b.ronNet.toString(), 'RON')}</span>}
                    </td>
                    <td className="num mono">
                      {b.currency === 'RON' ? '—' : Number(b.fxRate).toFixed(4).replace('.', ',')}
                      {b.fxSource === 'MANUAL' && <span className="cell-note">{t('fx.manualBadge')}</span>}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[b.status]}>{t(`accounting.batch.status.${b.status}` as MsgKey)}</Badge>
                      {b.status === 'VOID' && b.voidReason && <span className="cell-note">{t(`accounting.batch.voidReason.${b.voidReason === 'FGO_DELETED' ? 'FGO_DELETED' : 'ADMIN'}` as MsgKey)}</span>}
                      {(b.status === 'FAILED' || b.status === 'PENDING') && b.lastError && <span className="cell-note text-danger">{t('accounting.batch.lastError', { error: b.lastError.slice(0, 160) })}</span>}
                    </td>
                    <td className="mono">
                      {b.document
                        ? (b.document.link ? <a href={b.document.link} target="_blank" rel="noopener noreferrer">{b.document.series}{b.document.number}</a> : `${b.document.series}${b.document.number}`)
                        : '—'}
                      {b.issuedAt && <span className="cell-note">{fmtDate(b.issuedAt)}</span>}
                      {chains.has(b.id) && chains.get(b.id)!.paid > 0 && (
                        <span className="cell-note">{t('accounting.invoice.chainInfo', { paid: fmtMoney(chains.get(b.id)!.paid, 'RON'), advanced: fmtMoney(chains.get(b.id)!.advanced, 'RON') })}</span>
                      )}
                    </td>
                    <td className="actions">
                      {/* Proformaya tahsilat gelmiş ve avansı kesilmemiş: avans faturası (yükleme öncesi ya da sonrası) */}
                      {chains.has(b.id) && chains.get(b.id)!.advanceRequired > 0 && !chains.get(b.id)!.advancePending && (
                        <form action={createAdvanceAction}>
                          <input type="hidden" name="proformaBatchId" value={b.id} />
                          <input type="hidden" name="customerId" value={chosen?.id ?? ''} />
                          <ConfirmButton primary message={t('accounting.invoice.advanceConfirm', { ref: chains.get(b.id)!.ref ?? '', amount: fmtMoney(chains.get(b.id)!.advanceRequired, 'RON') })}>
                            {t('accounting.invoice.advanceCreate', { amount: fmtMoney(chains.get(b.id)!.advanceRequired, 'RON') })}
                          </ConfirmButton>
                        </form>
                      )}
                      {/* Kesilemeyen avans faturası: gerçek FGO hatası; yeniden dene ya da vazgeç (tahsilat yeniden avanslanabilir) */}
                      {chains.get(b.id)?.failed.map((a) => (
                        <form key={a.batchId} action={reviewInvoiceBatchAction} className="row">
                          <input type="hidden" name="batchId" value={a.batchId} />
                          <input type="hidden" name="customerId" value={chosen?.id ?? ''} />
                          <span className="cell-note text-danger">{t('accounting.invoice.advanceFailed', { error: (a.lastError ?? '—').slice(0, 160) })}</span>
                          <button className="btn" name="do" value="retry">{t('accounting.batch.retry')}</button>
                          <ConfirmButton danger name="do" value="void" message={t('accounting.invoice.advanceVoidConfirm')}>{t('accounting.batch.void')}</ConfirmButton>
                        </form>
                      ))}
                      {b.status === 'FAILED' && (
                        <form action={reviewBatchAction} className="row">
                          <input type="hidden" name="batchId" value={b.id} />
                          <input type="hidden" name="customerId" value={chosen?.id ?? ''} />
                          <button className="btn" name="do" value="retry">{t('accounting.batch.retry')}</button>
                          <ConfirmButton danger name="do" value="void" message={t('accounting.batch.voidConfirm')}>{t('accounting.batch.void')}</ConfirmButton>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
