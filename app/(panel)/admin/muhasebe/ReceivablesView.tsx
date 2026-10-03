import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { backfillDocuments, listDocuments, paymentStatus, receivables, syncStatus, unitOf } from '@/server/accounting/receivables.js';
import { refreshFgoAction } from './actions';

type Doc = Prisma.FgoDocumentGetPayload<{ include: {
  order: { select: { id: true; orderNo: true; status: true; customer: { select: { name: true } } } };
  batch: { select: {
    id: true; kind: true; parentId: true; loadingDays: true; customer: { select: { name: true } }; orders: { select: { orderId: true; orderNo: true } };
    confirmation: { select: { shipDay: true } }; parent: { select: { document: { select: { series: true; number: true } } } };
  } };
} }>;
const dayText = (d: Date) => new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.');
type Share = { debt: number | null; rest: number | null; replaced: boolean };
type Sums = Record<string, { total: number; paid: number; rest: number }>;

const TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok' } as const;
const FILTERS = ['hepsi', 'acik', 'odendi'] as const;
const FILTER_KEY = { hepsi: 'all', acik: 'open', odendi: 'paid' } as const;
const ERRORS = ['FGO_DISABLED', 'NO_KEY', 'BUSY'];

/**
 * Profil ve Cam Tahsilat ortak ekranı: FGO belgeleri ve FGO'dan okunan ödeme durumu (yalnızca yönetici).
 * Belgelerin hepsi listelenir; toplamlar sipariş başına tek borç üzerinden (server/accounting/receivables.js → receivables).
 */
export async function ReceivablesView({ type, sp }: { type: 'PROFILE_ORDER' | 'GLASS_ORDER'; sp: Record<string, string | undefined> }) {
  const { t } = await getT();
  if (type === 'PROFILE_ORDER') await backfillDocuments(db);
  const [docs, sync] = await Promise.all([listDocuments(db, type) as Promise<Doc[]>, syncStatus(db)]);
  const key = type === 'PROFILE_ORDER' ? 'profile' : 'glass';
  const path = type === 'PROFILE_ORDER' ? '/admin/muhasebe/profil' : '/admin/muhasebe/cam';
  const r = receivables(docs) as { shares: Map<string, Share>; sums: Sums };
  const shareOf = (d: Doc) => r.shares.get(d.id) as Share;
  // Sipariş başına grup: en yeni belgesi olan sipariş önce; sipariş içinde belgeler kesim sırasıyla (proforma → fatura)
  // Borç birimi: sipariş ya da müşteri belge zinciri (müşteri proforması + avans + o proformadan düşen müşteri faturaları)
  const groups: { docs: Doc[] }[] = [];
  const byOrder = new Map<string, { docs: Doc[] }>();
  for (const d of docs) {
    const unit = unitOf(d) as string;
    let g = byOrder.get(unit);
    if (!g) {
      g = { docs: [] };
      byOrder.set(unit, g);
      groups.push(g);
    }
    g.docs.unshift(d);
  }
  const open = (g: { docs: Doc[] }) => g.docs.some((d) => { const s = shareOf(d); return s.rest == null || s.rest > 0; });
  const filter = FILTERS.find((f) => f === sp.durum) ?? 'hepsi';
  const shown = filter === 'hepsi' ? groups : groups.filter((g) => open(g) === (filter === 'acik'));
  const openDocs = docs.filter((d) => !shareOf(d).replaced && paymentStatus(d.total, d.paid) !== 'PAID').length;
  const curs = Object.keys(r.sums).sort();
  // Proformanın bir kısmı başka belgeye dönmüş: avans faturası ya da (müşteri zincirinde) yüklenen kısmın faturası
  const hasAdvance = (g: { docs: Doc[] }) => g.docs.some((d) => d.kind === 'ADVANCE' || (d.batchId != null && d.kind === 'INVOICE'));

  return (
    <>
      <div className="page-head row">
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <h1>{t(`accounting.${key}.title` as MsgKey)}</h1>
          <p className="muted">{t(`accounting.${key}.intro` as MsgKey)}</p>
        </div>
        <form action={refreshFgoAction} className="page-tools">
          <input type="hidden" name="type" value={type} />
          {type === 'GLASS_ORDER' && <Link className="btn" href="/admin/muhasebe/cam/proforma">{t('accounting.batch.open')}</Link>}
          <button className="btn btn-primary" disabled={docs.length === 0}>{t('accounting.receivables.refresh')}</button>
        </form>
      </div>
      {sp.ok === 'refreshed' && <div className="alert alert-ok">{t('accounting.receivables.refreshed', { n: sp.n ?? '0', f: sp.f ?? '0' })}</div>}
      {sp.error && <div className="alert alert-error">{t(`accounting.receivables.errors.${ERRORS.includes(sp.error) ? sp.error : 'FGO_DISABLED'}` as MsgKey)}</div>}

      {/* Özet: para birimi başına (para birimleri toplanmaz) */}
      {curs.map((cur, i) => {
        const s = r.sums[cur];
        return (
          <div className="stats stats-money" key={cur}>
            <div className="stat">
              <div className="k">{t('accounting.receivables.stat.total', { cur })}</div>
              <div className="v">{fmtNum(s.total)}</div>
            </div>
            <div className="stat stat-ok">
              <div className="k">{t('accounting.receivables.stat.paid', { cur })}</div>
              <div className="v">{fmtNum(s.paid)}</div>
            </div>
            <div className={`stat ${s.rest > 0 ? 'stat-danger' : 'stat-ok'}`}>
              <div className="k">{t('accounting.receivables.stat.rest', { cur })}</div>
              <div className="v">{fmtNum(s.rest)}</div>
            </div>
            {i === 0 && (
              <div className="stat stat-muted">
                <div className="k">{t('accounting.receivables.stat.open')}</div>
                <div className="v">{openDocs}</div>
                <div className="muted small">{t('accounting.receivables.stat.openHint')}</div>
              </div>
            )}
          </div>
        );
      })}

      <div className="card card-flush">
        <div className="card-head">
          <h2>{t('accounting.receivables.listTitle')} <span className="badge">{docs.length}</span></h2>
        </div>
        {docs.length > 0 && (
          <div className="card-tools">
            {FILTERS.map((f) => (
              <Link key={f} className={filter === f ? 'active' : undefined} href={f === 'hepsi' ? path : `${path}?durum=${f}`}>
                {t(`accounting.receivables.filter.${FILTER_KEY[f]}` as MsgKey)}
              </Link>
            ))}
          </div>
        )}
        {docs.length === 0 ? <div className="empty">{t(`accounting.${key}.empty` as MsgKey)}</div>
          : shown.length === 0 ? <div className="empty">{t('accounting.receivables.noMatch')}</div> : (
            <div className="table-wrap">
              <table className="acc-table">
                <thead>
                  <tr>
                    <th>{t('accounting.receivables.col.order')}</th>
                    <th>{t('accounting.receivables.col.customer')}</th>
                    <th>{t('accounting.receivables.col.doc')}</th>
                    <th>{t('accounting.receivables.col.kind')}</th>
                    <th>{t('accounting.receivables.col.date')}</th>
                    <th className="num">{t('accounting.receivables.col.total')}</th>
                    <th className="num">{t('accounting.receivables.col.paid')}</th>
                    <th className="num">{t('accounting.receivables.col.rest')}</th>
                    <th>{t('accounting.receivables.col.status')}</th>
                    <th>{t('accounting.receivables.col.checked')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((g) => g.docs.map((d, i) => {
                    const st = paymentStatus(d.total, d.paid);
                    const s = shareOf(d);
                    const partly = d.kind === 'PROFORMA' && !s.replaced && hasAdvance(g);
                    return (
                      <tr key={d.id} className={i === 0 ? 'grp-first' : undefined}>
                        <td>
                          {i === 0 && d.order && <Link className="order-no" href={`/siparisler/${d.order.id}`}>{d.order.orderNo}</Link>}
                          {/* Müşteri belgesi (her satırda): kaynak siparişler; proformada seçilen yükleme günleri, faturada onaylı yükleme günü, avansta kaynak proforma */}
                          {d.batch && (
                            <>
                              {d.batch.orders.map((o, n) => <span key={o.orderId}>{n > 0 && ', '}<Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link></span>)}
                              <span className="cell-note">
                                {d.batch.kind === 'INVOICE' ? t('accounting.invoice.docNote.INVOICE', { day: d.batch.confirmation ? dayText(d.batch.confirmation.shipDay) : '—' })
                                  : d.batch.kind === 'ADVANCE' ? t('accounting.invoice.docNote.ADVANCE', { ref: d.batch.parent?.document ? `${d.batch.parent.document.series}${d.batch.parent.document.number}` : '—' })
                                    : `${t('accounting.batch.docNote')} · ${t('accounting.batch.docDays', { days: d.batch.loadingDays.map(dayText).join(', ') })}`}
                              </span>
                            </>
                          )}
                        </td>
                        <td>{i === 0 && (d.order?.customer.name ?? d.batch?.customer.name)}</td>
                        <td className="mono">{d.link ? <a href={d.link} target="_blank" rel="noopener noreferrer">{d.series}{d.number}</a> : `${d.series}${d.number}`}</td>
                        <td>{t(`accounting.receivables.kind.${['INVOICE', 'ADVANCE'].includes(d.kind) ? d.kind : 'PROFORMA'}` as MsgKey)}</td>
                        <td className="nowrap">{fmtDate(d.issuedAt)}</td>
                        <td className="num">{d.total != null ? fmtMoney(d.total.toString(), d.currency) : '—'}</td>
                        <td className="num">{d.paid != null ? fmtMoney(d.paid.toString(), d.currency) : '—'}</td>
                        <td className="num">
                          {s.replaced || s.rest == null ? <span className="muted">—</span> : <b>{fmtMoney(s.rest, d.currency)}</b>}
                          {partly && <span className="cell-note">{t('accounting.receivables.partlyInvoiced')}</span>}
                        </td>
                        <td>
                          {s.replaced
                            ? <Badge tone="muted">{t('accounting.receivables.replaced')}</Badge>
                            : <Badge tone={TONE[st]}>{t(`accounting.receivables.status.${st}` as MsgKey)}</Badge>}
                        </td>
                        <td className="small nowrap">
                          {d.checkedAt ? fmtDate(d.checkedAt) : '—'}
                          {d.checkedAt && <span className="cell-note">{fmtDateTime(d.checkedAt).split(' ').pop()}</span>}
                          {d.checkError && <span className="cell-note text-danger" title={d.checkError}>{t('accounting.receivables.checkError')}</span>}
                        </td>
                      </tr>
                    );
                  }))}
                </tbody>
              </table>
            </div>
          )}
        <p className="card-note">
          {t('accounting.receivables.sumNote')}{' '}{type === 'GLASS_ORDER' && `${t('accounting.invoice.sumNote')} `}
          {sync.lastRun
            ? t('accounting.receivables.auto', { at: fmtDateTime(sync.lastRun), n: sync.checked ?? 0, f: sync.failed ?? 0 })
            : t('accounting.receivables.autoNever')}
        </p>
      </div>
    </>
  );
}
