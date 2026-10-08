import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import { dayEntry, firmsOfDay, loadDay, moneyView } from '@/lib/loading';
import { fmtDate, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { parseDateOnly } from '@/server/orders/rules.js';
import { rowsTotal } from '@/server/loading/day-firms.js';

export const dynamic = 'force-dynamic';

const kg = (n: number) => fmtNum(n, 0);
const dash = (n: number) => (n ? String(n) : '–');

/**
 * Firma satırının "Özet"i (Paket 7, karar 187): YALNIZCA seçilen firma ve yükleme günü. İç ekip (yönetici, satış, denetimci —
 * TRANSPORT_LIST_VIEW); müşteri ve çizim erişemez. Değerler yükleme ekranının firma tablosuyla aynı hesaptan (firmsOfDay).
 * Finansal içerik (fabrika satış tutarı VE teklif tutarı) yalnızca yöneticiye (OFFER_SEND): diğer rollerde tutar bölümü ve tutar
 * sütunları hiç yazılmaz — veri sunucuda süzülür. Fiziksel sandık ilişkisi ayrı bölümde ("Sandık (Fiziksel)" sütunu yok).
 */
export default async function FirmSummaryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('TRANSPORT_LIST_VIEW');
  const { t } = await getT();
  const sp = await searchParams;
  const day = parseDateOnly(sp.gun ?? '') ? sp.gun! : null;
  const dmy = day ? fmtDate(`${day}T12:00:00Z`) : '';
  const back = day ? `/yuklemeler?gun=${day}` : '/yuklemeler';
  const data = day ? await loadDay(user, day) : null;
  // Özetin finansal içeriği yalnızca yöneticide; tutarlar firma tablosuna da yalnızca yöneticide girer
  const admin = userCan(user, 'OFFER_SEND');
  const money = admin ? moneyView(user) : { sales: false, offer: false };
  const sum = data ? firmsOfDay(user, data.rows.map((o) => dayEntry(o, { customer: false, money })), data.crates, data.guests, data.hostNames) : null;
  const firm = sum?.firms.find((f) => f.id === sp.firma);
  if (!day || !firm || !sum) {
    return (
      <>
        <div className="page-head"><Link href={back}>{t('loading.firmSummary.back')}</Link></div>
        <div className="card"><p className="muted">{t('loading.firmSummary.notFound')}</p></div>
      </>
    );
  }
  const sub = rowsTotal(firm.rows);
  const currencies = Object.keys(sub.money).sort();
  const rowOf = new Map(sum.firms.flatMap((f) => f.rows.map((r) => [r.entry.orderId, r] as const)));
  const away = firm.rows.filter((r) => r.guest);
  const stats: [string, string][] = [
    [t('loading.firm.cols.orders'), String(firm.orders)], [t('loading.firm.cols.glass'), String(firm.camAdet)],
    [t('loading.firm.cols.cnc'), String(firm.cnc)], [t('loading.firm.cols.holes'), String(firm.delik)],
    [t('loading.firm.cols.m2'), fmtNum(firm.metraj)], [t('loading.firm.cols.net'), kg(firm.netKg)],
    [t('loading.firm.cols.crates'), String(firm.crates)], [t('loading.firm.cols.gross'), kg(firm.grossKg)],
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <Link href={back} className="small">{t('loading.firmSummary.back')}</Link>
          <h1>{t('loading.firmSummary.title', { firm: firm.name })}</h1>
          <p className="muted">{t('loading.firmSummary.intro', { date: dmy })}</p>
        </div>
      </div>

      <div className="card" id="ozet" data-firm={firm.id}>
        <div className="stats summary-stats">
          {stats.map(([k, v]) => <div key={k} className="stat"><div className="k">{k}</div><div className="v">{v}</div></div>)}
        </div>
      </div>

      {/* Tutarlar: yalnızca yönetici — fabrika satış ve teklif tutarı ayrı sütunlarda, para birimi başına */}
      {admin && (
        <div className="card card-flush" id="ozet-tutarlar">
          <div className="card-head"><h2>{t('loading.firmSummary.financeTitle')}</h2></div>
          <p className="card-sub">{t('loading.firmSummary.financeNote')}</p>
          <div className="table-wrap">
            <table className="acc-table">
              <thead><tr><th>{t('loading.firmSummary.cols.currency')}</th><th className="num">{t('loading.firmSummary.cols.factory')}</th><th className="num">{t('loading.firmSummary.cols.offer')}</th></tr></thead>
              <tbody>
                {currencies.map((cur) => (
                  <tr key={cur} data-currency={cur}>
                    <td>{cur}</td>
                    <td className="num" data-col="factory">{sub.money[cur].hasSales ? fmtMoney(sub.money[cur].sales, cur) : '—'}</td>
                    <td className="num" data-col="offer">{sub.money[cur].hasOffer ? fmtMoney(sub.money[cur].offer, cur) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card card-flush" id="ozet-siparisler">
        <div className="card-head"><h2>{t('loading.firmSummary.ordersTitle')}</h2></div>
        <div className="table-wrap">
          <table className="load-table sub-table">
            <thead>
              <tr>
                <th>{t('loading.firmSummary.cols.order')}</th><th>{t('loading.firmSummary.cols.project')}</th>
                <th className="num">{t('loading.firmSummary.cols.glass')}</th><th className="num">{t('loading.firmSummary.cols.cnc')}</th>
                <th className="num">{t('loading.firmSummary.cols.holes')}</th><th className="num">{t('loading.firmSummary.cols.m2')}</th>
                {admin && <th className="num">{t('loading.firmSummary.cols.factory')}</th>}
                {admin && <th className="num">{t('loading.firmSummary.cols.offer')}</th>}
              </tr>
            </thead>
            <tbody>
              {firm.rows.map((r) => (
                <tr key={`${r.entry.orderId}${r.entry.replan ? ':r' : ''}`} data-order={r.entry.orderId}>
                  <td><Link className="order-no" href={`/siparisler/${r.entry.orderId}`}>{r.entry.orderNo}</Link></td>
                  <td>{r.entry.o.title ?? ''}</td>
                  <td className="num">{r.entry.load.camAdet}</td><td className="num">{dash(r.entry.load.cnc)}</td><td className="num">{dash(r.entry.load.delik)}</td>
                  <td className="num">{fmtNum(r.entry.load.metraj)}</td>
                  {admin && <td className="num">{r.entry.money.sales != null ? fmtMoney(r.entry.money.sales, r.entry.money.currency) : '—'}</td>}
                  {admin && <td className="num">{r.entry.money.offer != null ? fmtMoney(r.entry.money.offer, r.entry.money.currency) : '—'}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{t('loading.firm.sub.total', { n: sub.orders })}</td>
                <td className="num">{sub.camAdet}</td><td className="num">{dash(sub.cnc)}</td><td className="num">{dash(sub.delik)}</td><td className="num">{fmtNum(sub.metraj)}</td>
                {admin && <td className="num">{currencies.filter((c) => sub.money[c].hasSales).map((c) => <div key={c}>{fmtMoney(sub.money[c].sales, c)}</div>)}</td>}
                {admin && <td className="num">{currencies.filter((c) => sub.money[c].hasOffer).map((c) => <div key={c}>{fmtMoney(sub.money[c].offer, c)}</div>)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Fiziksel sandık ilişkisi: ticari sahiplik değişmez; sandık ve ağırlık sandığın sahibinde (adlar role göre maskeli) */}
      <div className="card" id="ozet-fiziksel">
        <h2>{t('loading.firmSummary.physicalTitle')}</h2>
        <h3>{t('loading.firmSummary.cratesTitle')}</h3>
        {firm.crateList.length === 0 ? <p className="muted small">{t('loading.firmSummary.noCrates')}</p> : (
          <div className="table-wrap">
            <table className="crate-table readonly" data-crates>
              <thead>
                <tr>
                  <th>{t('loading.firmSummary.cols.crate')}</th><th>{t('loading.firmSummary.cols.dims')}</th><th>{t('loading.firmSummary.cols.net')}</th>
                  <th>{t('loading.firmSummary.cols.gross')}</th><th>{t('loading.firmSummary.cols.contents')}</th>
                </tr>
              </thead>
              <tbody>
                {firm.crateList.map((c) => (
                  <tr key={c.id} data-crate={c.crateNo}>
                    <td>{c.crateNo}</td>
                    <td>{[c.lengthMm, c.widthMm, c.heightMm].some((x) => x != null) ? [c.lengthMm, c.widthMm, c.heightMm].map((x) => x ?? '—').join(' × ') : '—'}</td>
                    <td>{c.netAgirlik != null ? kg(Number(c.netAgirlik)) : '—'}</td>
                    <td>{c.brutAgirlik != null ? kg(Number(c.brutAgirlik)) : '—'}</td>
                    <td className="crate-contents">
                      {(c.orderIds ?? []).map((id) => rowOf.get(id)).filter((r) => r && r.entry.customerId === firm.id).map((r) => <div key={r!.entry.orderId}>{r!.entry.orderNo}</div>)}
                      {firm.guestsIn.filter((g) => g.crateId === c.id).map((g) => (
                        <div key={g.orderId} data-guest={g.orderId}>
                          <Badge tone="warn">{t('loading.firm.guestLine', { order: g.orderNo, owner: g.ownerName, glass: rowOf.get(g.orderId)?.entry.load.camAdet ?? 0, m2: fmtNum(rowOf.get(g.orderId)?.entry.load.metraj ?? 0) })}</Badge>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>{t('loading.firmSummary.awayTitle')}</h3>
        {away.length === 0 ? <p className="muted small">{t('loading.firmSummary.noAway')}</p> : (
          <ul className="small" data-away>
            {away.map((r) => (
              <li key={r.entry.orderId} data-order={r.entry.orderId}>
                <b>{r.entry.orderNo}</b> — {t('loading.guest.travelsWith', { host: r.guest!.hostName })}{' '}
                {r.guest!.crateNo != null ? <Badge tone="info">{t('loading.guest.crateNo', { no: r.guest!.crateNo })}</Badge> : <Badge tone="danger">{t('loading.guest.waitingShort')}</Badge>}
              </li>
            ))}
          </ul>
        )}
        <h3>{t('loading.firmSummary.inTitle')}</h3>
        {firm.guestsIn.length === 0 ? <p className="muted small">{t('loading.firmSummary.noIn')}</p> : (
          <ul className="small" data-in>
            {firm.guestsIn.map((g) => (
              <li key={g.orderId} data-order={g.orderId}>
                <b>{g.orderNo}</b> · {g.ownerName} · {g.crateNo != null ? t('loading.guest.crateNo', { no: g.crateNo }) : t('loading.guest.waitingShort')}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
