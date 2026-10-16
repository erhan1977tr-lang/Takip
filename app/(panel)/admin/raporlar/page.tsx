import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { actorOf } from '@/lib/actor';
import { fmtDateTime, fmtDec, fmtM2, fmtNum } from '@/lib/format';
import { PANEL_ROWS, reportCustomers, runReport } from '@/server/reports/service.js';
import { LOADING_STATES, ORDER_TYPES, PERIODS, REPORT_KINDS, REPORT_STATUSES, filterQuery, filtersFromQuery, parseReportFilters } from '@/server/reports/filters.js';
import { cardLabel, cellLabel, dayText, filtersText, isNumericCol } from '@/server/reports/present.js';

export const dynamic = 'force-dynamic';

type Col = { key: string; type: string; dict?: string };
type Cell = string | number | null;
type Table = { key: string; columns: Col[]; rows: Cell[][]; totals?: Cell[][]; basis?: string; chart?: { label: number; value: number } };
type Card = { key: string; value: number | null; type: string; unit?: string; note?: string };

/**
 * Yönetici raporları (3.89.0, karar 284) — salt okunur. Yalnızca REPORT_VIEW (yönetici ve yönetici yardımcısı); sunucu da
 * denetler (runReport). Filtreler GET formunda (adres çubuğunda), Excel bağlantısı aynı filtrelerle aynı servisi çağırır.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('REPORT_VIEW');
  const { t } = await getT();
  const tt = (key: string, p?: Record<string, unknown>) => t(key as MsgKey, p as Record<string, string | number>);
  const sp = await searchParams;
  const tz = getEnv().APP_TIMEZONE;
  const now = new Date();
  const input = filtersFromQuery(sp);
  const f = parseReportFilters(input, { now, timeZone: tz });
  const actor = await actorOf(user);
  const [r, customers] = await Promise.all([runReport(db, input, { actor, now, timeZone: tz }), reportCustomers(db, actor)]);
  const q = filterQuery(f);
  const tabHref = (kind: string) => `/admin/raporlar?${filterQuery({ ...f, kind })}`;

  const num = (c: Col, v: Cell) => {
    if (v == null || v === '') return '—';
    if (c.type === 'int') return fmtNum(v, 0);
    if (c.type === 'm2') return fmtM2(v);
    if (c.type === 'money') return fmtNum(v, 2);
    if (c.type === 'dec3') return fmtDec(v, 3);
    return String(v);
  };
  const cell = (c: Col, v: Cell) => (isNumericCol(c) ? num(c, v) : (cellLabel(c, v, tt) ?? '—'));
  const cardValue = (c: Card) => (c.value == null ? null : c.type === 'm2' ? `${fmtM2(c.value)} m²` : c.type === 'money' ? `${fmtNum(c.value, 2)} ${c.unit ?? ''}` : fmtNum(c.value, 0));

  const Chart = ({ tb }: { tb: Table }) => {
    if (!tb.chart || tb.rows.length < 2) return null;
    const cur = tb.columns.findIndex((c) => c.type === 'currency');
    if (cur >= 0 && new Set(tb.rows.map((r) => r[cur])).size > 1) return null; // farklı para birimleri tek grafikte gösterilmez
    const rows = tb.rows.slice(0, 12).map((r) => ({ label: String(cell(tb.columns[tb.chart!.label], r[tb.chart!.label])), v: Number(r[tb.chart!.value] ?? 0) }));
    const max = Math.max(...rows.map((x) => Math.abs(x.v)), 0);
    if (!(max > 0)) return null;
    const vc = tb.columns[tb.chart.value];
    return (
      <div className="report-bars" data-chart={tb.key} aria-label={tt(`reports.col.${vc.key}`)}>
        {rows.map((x, i) => (
          <div className="report-bar" key={i}>
            <span className="label" title={x.label}>{x.label}</span>
            <span className="track"><span className="fill" style={{ width: `${Math.round((Math.abs(x.v) / max) * 100)}%` }} /></span>
            <span className="val">{num(vc, x.v)}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('reports.title')}</h1>
        <p className="muted">{t('reports.intro')}</p>
      </div>

      <nav className="tabs" aria-label={t('reports.title')}>
        {REPORT_KINDS.map((k: string) => <Link key={k} href={tabHref(k)} className={k === f.kind ? 'active' : undefined} data-report-tab={k}>{tt(`reports.kinds.${k}`)}</Link>)}
      </nav>

      <form className="card" method="get" action="/admin/raporlar" id="rapor-filtre">
        <input type="hidden" name="tur" value={f.kind} />
        <div className="report-filters">
          <div className="calc-field">
            <label htmlFor="r-donem">{t('reports.filter.period')}</label>
            <select id="r-donem" name="donem" defaultValue={PERIODS.includes(f.period) ? f.period : ''}>
              <option value="">—</option>
              {PERIODS.map((p: string) => <option key={p} value={p}>{tt(`reports.periods.${p}`)}</option>)}
            </select>
          </div>
          <div className="calc-field">
            <label htmlFor="r-bas">{t('reports.filter.from')}</label>
            <input id="r-bas" type="date" name="bas" defaultValue={f.period === 'custom' ? f.from ?? '' : ''} />
          </div>
          <div className="calc-field">
            <label htmlFor="r-bit">{t('reports.filter.to')}</label>
            <input id="r-bit" type="date" name="bit" defaultValue={f.period === 'custom' ? f.to ?? '' : ''} />
          </div>
          <div className="calc-field">
            <label htmlFor="r-ay">{t('reports.filter.month')}</label>
            <input id="r-ay" type="month" name="ay" defaultValue={f.month} />
          </div>
          <div className="calc-field">
            <label htmlFor="r-yil">{t('reports.filter.year')}</label>
            <input id="r-yil" type="number" name="yil" min={2000} max={2100} inputMode="numeric" defaultValue={f.year} />
          </div>
          <div className="calc-field">
            <label htmlFor="r-firma">{t('reports.filter.customer')}</label>
            <select id="r-firma" name="firma" defaultValue={f.customerId}>
              <option value="">{t('reports.filter.allCustomers')}</option>
              {customers.map((c: { id: string; name: string }) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="calc-field">
            <label htmlFor="r-tip">{t('reports.filter.orderType')}</label>
            <select id="r-tip" name="tip" defaultValue={f.orderType}>
              {ORDER_TYPES.map((o: string) => <option key={o} value={o}>{tt(`reports.types.${o}`)}</option>)}
            </select>
          </div>
          <div className="calc-field">
            <label htmlFor="r-durum">{t('reports.filter.status')}</label>
            <select id="r-durum" name="durum" defaultValue={f.status}>
              <option value="">{t('reports.filter.allStatuses')}</option>
              {REPORT_STATUSES.map((s: string) => <option key={s} value={s}>{tt(`status.order.${s}`)}</option>)}
            </select>
          </div>
          <div className="calc-field">
            <label htmlFor="r-urun">{t('reports.filter.product')}</label>
            <input id="r-urun" type="text" name="urun" maxLength={60} placeholder={t('reports.filter.productHint')} defaultValue={f.product} />
          </div>
          <div className="calc-field">
            <label htmlFor="r-yukleme">{t('reports.filter.loading')}</label>
            <select id="r-yukleme" name="yukleme" defaultValue={f.loading}>
              {LOADING_STATES.map((s: string) => <option key={s} value={s}>{tt(`reports.loadingStates.${s}`)}</option>)}
            </select>
          </div>
        </div>
        <div className="report-actions">
          <button className="btn btn-primary" type="submit">{t('reports.filter.apply')}</button>
          <Link className="btn" href={`/admin/raporlar?tur=${f.kind}`}>{t('reports.filter.reset')}</Link>
          {r.ok && <a className="btn" href={`/admin/raporlar/excel?${q}`} data-report-excel>{t('reports.filter.excel')}</a>}
        </div>
      </form>

      {!r.ok && (
        <div className="alert alert-error" role="alert" data-report-error={r.code}>
          {r.code === 'INVALID_FILTERS'
            ? (r.errors ?? []).map((e: string) => tt(`reports.errors.${e}`)).join(' ')
            : tt(`reports.errors.${r.code}`, { names: (r.candidates ?? []).join(', ') })}
        </div>
      )}

      {r.ok && (() => {
        const rep = r.report;
        return (
          <div id="rapor" data-report={rep.kind} data-from={rep.range.from} data-to={rep.range.to}>
            <p className="report-meta">
              <span data-report-range>{t('reports.filter.range', { from: dayText(rep.range.from), to: dayText(rep.range.to) })}</span>
              <span>{t('reports.filter.basis', { basis: tt(`reports.basis.${rep.basis}`) })}</span>
              <span data-report-filters>{t('reports.excel.info.filters')}: {filtersText(rep, tt)}</span>
              <span>{t('reports.filter.generated', { at: fmtDateTime(rep.generatedAt) })}</span>
            </p>
            <div className="stats stats-money">
              {(rep.cards as Card[]).map((c, i) => (
                <div key={i} className={`stat${c.value == null ? ' stat-warn' : ''}`} data-card={c.key} data-unit={c.unit ?? ''} data-value={c.value ?? ''}>
                  <div className="k">{cardLabel(c, tt)}{c.unit ? ` · ${c.unit}` : ''}</div>
                  {c.value == null ? <div className="v missing">{t('reports.missing')}</div> : <div className="v">{cardValue(c)}</div>}
                  {c.note && <div className="note">{tt(`reports.val.note.${c.note}`)}</div>}
                </div>
              ))}
            </div>
            {(rep.tables as Table[]).map((tb) => (
              <section key={tb.key} className="card card-flush" data-table={tb.key} data-rows={tb.rows.length}>
                <div className="card-head">
                  <h2>{tt(`reports.tables.${tb.key}`)}</h2>
                  {tb.basis && tb.basis !== rep.basis && <span className="muted">{t('reports.filter.basis', { basis: tt(`reports.basis.${tb.basis}`) })}</span>}
                </div>
                <Chart tb={tb} />
                {tb.rows.length > PANEL_ROWS && <p className="muted" style={{ padding: '0 20px' }}>{t('reports.filter.rowsShown', { n: PANEL_ROWS, total: tb.rows.length })}</p>}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>{tb.columns.map((c) => <th key={c.key} className={isNumericCol(c) ? 'num' : undefined}>{tt(`reports.col.${c.key}`)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {tb.rows.length === 0 && <tr><td colSpan={tb.columns.length} className="empty">{t('reports.filter.empty')}</td></tr>}
                      {tb.rows.slice(0, PANEL_ROWS).map((row, i) => (
                        <tr key={i}>{tb.columns.map((c, j) => <td key={j} className={isNumericCol(c) ? 'num' : undefined} data-col={c.key}>{cell(c, row[j])}</td>)}</tr>
                      ))}
                      {(tb.totals ?? []).map((row, i) => (
                        <tr key={`t${i}`} className="report-total" data-total>
                          {tb.columns.map((c, j) => <td key={j} className={isNumericCol(c) ? 'num' : undefined} data-col={c.key}>{j === 0 && (row[0] === '' || row[0] == null) ? t('reports.totals') : (row[j] === '' ? '' : cell(c, row[j]))}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            {rep.notes.length > 0 && (
              <div className="card" id="rapor-notlar">
                <ul className="report-notes">
                  {rep.notes.map((n: string) => <li key={n} data-note={n}>{tt(`reports.notes.${n}`, { n: rep.counts?.outside ?? 0 })}</li>)}
                </ul>
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}
