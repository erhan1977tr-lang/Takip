import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey, type T } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import { canFirmDocs, customerPriceOf, dayEntry, firmsOfDay, loadDay, moneyView } from '@/lib/loading';
import { fmtDate, fmtM2, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { parseDateOnly } from '@/server/orders/rules.js';
import { firmSummaryData } from '@/server/loading/firm-export.js';
import { rowsTotal } from '@/server/loading/day-firms.js';

export const dynamic = 'force-dynamic';

const kg = (n: number) => fmtNum(n, 0);
const dash = (n: number) => (n ? String(n) : '–');

type Summary = ReturnType<typeof firmSummaryData>;
type SummaryOrder = Summary['orders'][number];

/**
 * Firma satırının "Özet"i (Paket 7, karar 187; ayrıntı Yönetici Paneli Paketi 1, karar 215): YALNIZCA seçilen firma ve yükleme
 * günü. Kim: firma satırının belge işlemlerini gören rol (canFirmDocs — yönetici, salt okuyan denetimci); satış yalnızca "Sandık"ı
 * görür ve bu adresten yükleme gününe döner; müşteri ve çizim erişemez. Değerler yükleme ekranının firma tablosuyla aynı hesaptan
 * (firmsOfDay); sipariş ayrıntısı firma PDF / Excel'iyle aynı satırlardan (firmSummaryData → orderDetail; sandık parası ayrı kalem).
 * Finansal içerik (fabrika satış VE müşteri teklifi) yalnızca yöneticiye (OFFER_SEND): iki tutar ayrı sütun gruplarında, para
 * birimi başına (toplanmaz); diğer rolde tutar bölümü ve sütunları hiç yazılmaz — veri sunucuda süzülür. Fiziksel sandık ilişkisi
 * ayrı bölümde ("Sandık (Fiziksel)" sütunu yok).
 */
export default async function FirmSummaryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('TRANSPORT_LIST_VIEW');
  const { t, locale } = await getT();
  const sp = await searchParams;
  const day = parseDateOnly(sp.gun ?? '') ? sp.gun! : null;
  const dmy = day ? fmtDate(`${day}T12:00:00Z`) : '';
  const back = day ? `/yuklemeler?gun=${day}` : '/yuklemeler';
  if (!canFirmDocs(user)) redirect(back);
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
  // Satırlar: yöneticide satış fiyatı (unitPrice) ve müşteri fiyatı (offerPrice) ayrı; diğer rolde fiyatsız
  const kindLabel = (k: string) => t(`status.lineKind.${k}` as MsgKey);
  const s = firmSummaryData(firm, { finance: admin, salesPrice: (l: { unitPrice?: unknown }) => l.unitPrice, price: customerPriceOf(user), locale, kindLabel });
  const sub = rowsTotal(firm.rows);
  const rowOf = new Map(sum.firms.flatMap((f) => f.rows.map((r) => [r.entry.orderId, r] as const)));
  const away = firm.rows.filter((r) => r.guest);
  const stats: [string, string][] = [
    [t('loading.firm.cols.orders'), String(firm.orders)], [t('loading.firm.cols.glass'), String(firm.camAdet)],
    [t('loading.firm.cols.cnc'), String(firm.cnc)], [t('loading.firm.cols.holes'), String(firm.delik)],
    [t('loading.firm.cols.m2'), fmtM2(firm.metraj)], [t('loading.firm.cols.net'), kg(firm.netKg)],
    [t('loading.firm.cols.crates'), `${firm.crates}${firm.realCrates || firm.crates === 0 ? '' : ` (${t('loading.day.estimated')})`}`],
    [t('loading.firm.cols.gross'), kg(firm.grossKg)],
  ];
  const L = {
    order: t('loading.firmSummary.cols.order'), project: t('loading.firmSummary.cols.project'), glass: t('loading.firmSummary.cols.glass'),
    cnc: t('loading.firmSummary.cols.cnc'), holes: t('loading.firmSummary.cols.holes'), m2: t('loading.firmSummary.cols.m2'),
    factory: t('loading.firmSummary.cols.factory'), offer: t('loading.firmSummary.cols.offer'),
  };
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
              <thead><tr><th>{t('loading.firmSummary.cols.currency')}</th><th className="num">{L.factory}</th><th className="num">{L.offer}</th></tr></thead>
              <tbody>
                {s.currencies.map((cur) => (
                  <tr key={cur} data-currency={cur}>
                    <td>{cur}</td>
                    <td className="num" data-col="factory">{s.totals[cur].hasSales ? fmtMoney(s.totals[cur].sales, cur) : '—'}</td>
                    <td className="num" data-col="offer">{s.totals[cur].hasOffer ? fmtMoney(s.totals[cur].offer, cur) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card card-flush" id="ozet-siparisler">
        <div className="card-head"><h2>{t('loading.firmSummary.ordersTitle')}</h2></div>
        {/* Dar alanda her sipariş etiketli bir ızgara (.stack-wrap; yöneticide iki tutar sütunuyla daha geniş eşik) — sayfa yatay kaymaz */}
        <div className={`table-wrap stack-wrap${admin ? ' stack-wide' : ''}`}>
          <table className="load-table sub-table stack-table">
            <thead>
              <tr>
                <th>{L.order}</th><th>{L.project}</th>
                <th className="num">{L.glass}</th><th className="num">{L.cnc}</th>
                <th className="num">{L.holes}</th><th className="num">{L.m2}</th>
                {admin && <th className="num">{L.factory}</th>}
                {admin && <th className="num">{L.offer}</th>}
              </tr>
            </thead>
            <tbody>
              {s.orders.map((o, i) => (
                <tr key={`${o.orderId}:${i}`} data-order={o.orderId}>
                  <td className="stack-head"><Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link></td>
                  <td className="stack-full" data-label={L.project}>{o.title}</td>
                  <td className="num" data-label={L.glass}>{o.camAdet}</td>
                  <td className="num" data-label={L.cnc}>{dash(o.cnc)}</td>
                  <td className="num" data-label={L.holes}>{dash(o.delik)}</td>
                  <td className="num" data-label={L.m2}>{fmtM2(o.metraj)}</td>
                  {admin && <td className="num" data-col="factory" data-label={L.factory}>{o.sales != null ? fmtMoney(o.sales, o.currency) : '—'}</td>}
                  {admin && <td className="num" data-col="offer" data-label={L.offer}>{o.offer != null ? fmtMoney(o.offer, o.currency) : '—'}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="stack-head">{t('loading.firm.sub.total', { n: sub.orders })}</td>
                <td className="num" data-label={L.glass}>{sub.camAdet}</td>
                <td className="num" data-label={L.cnc}>{dash(sub.cnc)}</td>
                <td className="num" data-label={L.holes}>{dash(sub.delik)}</td>
                <td className="num" data-label={L.m2}>{fmtM2(sub.metraj)}</td>
                {admin && <td className="num" data-col="factory" data-label={L.factory}>{s.currencies.filter((c) => s.totals[c].hasSales).map((c) => <div key={c}>{fmtMoney(s.totals[c].sales, c)}</div>)}</td>}
                {admin && <td className="num" data-col="offer" data-label={L.offer}>{s.currencies.filter((c) => s.totals[c].hasOffer).map((c) => <div key={c}>{fmtMoney(s.totals[c].offer, c)}</div>)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Sipariş ayrıntısı (karar 215): her siparişin teklif satırları — cam, altındaki CNC / delik ve sandık parası ayrı kalem */}
      <div className="card card-flush" id="ozet-ayrinti">
        <div className="card-head"><h2>{t('loading.firmSummary.detailTitle')}</h2></div>
        {s.orders.map((o, i) => <OrderDetail key={`${o.orderId}:${i}`} o={o} admin={admin} t={t} />)}
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
                          <Badge tone="warn">{t('loading.firm.guestLine', { order: g.orderNo, owner: g.ownerName, glass: rowOf.get(g.orderId)?.entry.load.camAdet ?? 0, m2: fmtM2(rowOf.get(g.orderId)?.entry.load.metraj ?? 0) })}</Badge>
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

/**
 * Bir siparişin teklif satırları. Yöneticide iki fiyat grubu: fabrika satış (satış fiyatı) ve müşteri teklifi (müşteriye
 * gönderilen fiyat; gönderilmemiş teklifte boş). Para birimi grup başlığında ve toplamlarda; satırdaki tutarlar o para birimiyle.
 */
function OrderDetail({ o, admin, t }: { o: SummaryOrder; admin: boolean; t: T }) {
  const cur = o.currency;
  const rows = o.detail.rows;
  const C = {
    desc: t('offer.cols.description'), poz: t('offer.cols.poz'), en: t('offer.cols.width'), boy: t('offer.cols.height'), adet: t('offer.cols.qty'),
    m2: 'm²', unit: t('offer.cols.unitPrice'), amount: t('offer.cols.amount'),
    f: t('loading.firmSummary.factoryShort'), c: t('loading.firmSummary.offerShort'),
  };
  const free = t('offer.free');
  const unitOf = (r: (typeof rows)[number], v: number | null | undefined) => {
    if (v == null) return <span className="muted">—</span>;
    if (r.free) return <span className="muted">{free}</span>;
    return <>{fmtNum(v, 2)}<span className="muted small"> / {r.unit === 'm2' ? 'm²' : t('common.unitPiece')}</span></>;
  };
  const amountOf = (v: number | null | undefined) => (v == null ? <span className="muted">—</span> : fmtNum(v, 2));
  return (
    <section className="order-detail" data-order-detail={o.orderId}>
      <div className="order-detail-head">
        <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>
        {o.title && <span className="muted">{o.title}</span>}
        {o.replanFrom && <Badge tone="info">{t('loading.firmExport.replanNote', { from: fmtDate(`${o.replanFrom}T12:00:00Z`) })}</Badge>}
        {admin && rows.length > 0 && !o.sent && <Badge tone="warn">{t('loading.firmSummary.notSent')}</Badge>}
      </div>
      {rows.length === 0 ? <p className="muted small">{t('loading.firmSummary.noLines')}</p> : (
        <div className={`stack-wrap${admin ? ' stack-wide' : ''}`}>
          <table className="sub-table stack-table detail-table" data-currency={cur}>
            <thead>
              {admin && (
                <tr className="detail-groups">
                  <td colSpan={7} />
                  <th colSpan={2} scope="colgroup" className="grp-factory">{t('loading.firmSummary.factoryGroup', { cur })}</th>
                  <th colSpan={2} scope="colgroup" className="grp-offer">{t('loading.firmSummary.offerGroup', { cur })}</th>
                </tr>
              )}
              <tr>
                <th className="num">#</th><th>{C.desc}</th><th>{C.poz}</th><th className="num">{C.en}</th><th className="num">{C.boy}</th>
                <th className="num">{C.adet}</th><th className="num">{C.m2}</th>
                {admin && (
                  <>
                    <th className="num grp-factory">{C.unit}</th><th className="num grp-factory">{C.amount}</th>
                    <th className="num grp-offer">{C.unit}</th><th className="num grp-offer">{C.amount}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.sub ? 'sub-line' : undefined} data-line={i}>
                  <td className="num stack-n">{r.n ?? ''}</td>
                  <td className="stack-full c-desc">{r.n != null && <b className="stack-only">{r.n}. </b>}{r.desc}</td>
                  <td data-label={C.poz}>{r.poz || '—'}</td>
                  <td className="num" data-label={C.en}>{r.en ?? '—'}</td>
                  <td className="num" data-label={C.boy}>{r.boy ?? '—'}</td>
                  <td className="num" data-label={C.adet}>{r.adet}</td>
                  <td className="num" data-label={C.m2}>{r.m2 != null ? fmtM2(r.m2) : '—'}</td>
                  {admin && (
                    <>
                      <td className="num grp-factory" data-label={`${C.f} · ${C.unit}`}>{unitOf(r, r.salesUnitPrice)}</td>
                      <td className="num grp-factory" data-col="factory" data-label={`${C.f} · ${C.amount}`}>{amountOf(r.salesAmount)}</td>
                      <td className="num grp-offer" data-label={`${C.c} · ${C.unit}`}>{unitOf(r, r.unitPrice)}</td>
                      <td className="num grp-offer" data-col="offer" data-label={`${C.c} · ${C.amount}`}>{amountOf(r.amount)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} className="stack-head">{t('loading.firmSummary.orderTotal')}</td>
                <td className="num" data-label={C.m2}>{fmtM2(o.detail.metraj)}</td>
                {admin && (
                  <>
                    <td className="grp-factory stack-skip" />
                    <td className="num grp-factory" data-col="factory" data-label={`${C.f} · ${C.amount}`}>{o.sales != null ? fmtMoney(o.sales, cur) : '—'}</td>
                    <td className="grp-offer stack-skip" />
                    <td className="num grp-offer" data-col="offer" data-label={`${C.c} · ${C.amount}`}>{o.offer != null ? fmtMoney(o.offer, cur) : '—'}</td>
                  </>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
