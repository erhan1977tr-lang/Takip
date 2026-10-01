import Link from 'next/link';
import { type CurrentUser, requirePermission } from '@/lib/auth/session';
import { getT, type Dict } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { customerLabel } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { crateDay, cratesBetween, loadOf, ordersShippingBetween, shipDay, type CrateRow, type Load, type LoadRow } from '@/lib/loading';
import { fmtDate, fmtDateTime, fmtMoney, fmtMonth, fmtNum, weekdayNames } from '@/lib/format';
import { CustomerBadge, OrderBadge } from '@/components/StatusBadge';
import { parseDateOnly } from '@/server/orders/rules.js';
import { CRATE_MAX_KG, CRATE_TARE_KG, dayKey, gridRange, monthGrid, parseMonth, shiftMonth } from '@/server/orders/loading.js';
import { groupLoad } from '@/server/loading/crates.js';
import { CrateEditor } from './CrateEditor';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | undefined>;
type Entry = { o: LoadRow; load: Load };
type Total = ReturnType<typeof groupLoad>;
type Group = { key: string; label: string; entries: Entry[]; crates: CrateRow[]; total: Total; amount: number; salesAmount: number };
/** Hangi tutar sütunları görünür (karar 4): yönetici ikisini yan yana, satış yalnız satış tutarını, müşteri/denetimci yalnız teklif tutarını */
type Money = { sales: boolean; offer: boolean };

const kg = (n: number) => fmtNum(n, 0);
const dash = (n: number) => (n ? String(n) : '–');

type Noun = keyof Dict['orders']['units'];
/** Sayı + birim: "3 sipariş". Romencede birim sayıya göre çekimlenir (1 comandă, 2 comenzi, 20 de comenzi). */
function counter(m: Dict, intl: string) {
  const rules = new Intl.PluralRules(intl);
  const unit = (noun: Noun, n: number) => {
    const c = rules.select(n);
    return m.orders.units[noun][c === 'one' || c === 'few' ? c : 'other'];
  };
  return { unit, count: (noun: Noun, n: number) => `${n} ${unit(noun, n)}` };
}

/**
 * Bir günün siparişlerini müşteriye göre gruplar; sandıklar müşteriler arasında karışmaz. Müşterinin o gün için
 * girilmiş sandıkları varsa o müşterinin ağırlık ve sandık sayısı onlardan gelir (server/loading/crates.js → groupLoad).
 */
function groupDay(entries: Entry[], user: CurrentUser, crates: CrateRow[] = []): { groups: Group[]; total: Total & { amount: number; salesAmount: number } } {
  const map = new Map<string, { name: string; entries: Entry[]; crates: CrateRow[] }>();
  const at = (id: string, name: string) => {
    if (!map.has(id)) map.set(id, { name, entries: [], crates: [] });
    return map.get(id)!;
  };
  for (const e of entries) at(e.o.customer.id, e.o.customer.name).entries.push(e);
  // Siparişi başka güne alınmış olsa da o güne girilmiş sandıklar görünür (silinebilsin)
  for (const c of crates) if (c.customer) at(c.customer.id, c.customer.name).crates.push(c);
  const groups = [...map.entries()].map(([key, g]) => ({
    key, label: customerLabel(user, g.name), entries: g.entries, crates: g.crates,
    total: groupLoad(g.entries.map((e) => e.load), g.crates), amount: g.entries.reduce((s, e) => s + (e.load.amount ?? 0), 0),
    salesAmount: g.entries.reduce((s, e) => s + (e.load.salesAmount ?? 0), 0),
  })).sort((a, b) => b.total.metraj - a.total.metraj);
  const t = groups.reduce(
    (acc, g) => ({
      orders: acc.orders + g.total.orders, metraj: Math.round((acc.metraj + g.total.metraj) * 100) / 100, camAdet: acc.camAdet + g.total.camAdet,
      cnc: acc.cnc + g.total.cnc, delik: acc.delik + g.total.delik,
      netKg: acc.netKg + g.total.netKg, crates: acc.crates + g.total.crates, grossKg: acc.grossKg + g.total.grossKg,
      estimatedCrates: acc.estimatedCrates + g.total.estimatedCrates, estimatedNetKg: acc.estimatedNetKg + g.total.estimatedNetKg,
      realCrates: acc.realCrates || g.total.realCrates, amount: acc.amount + g.amount, salesAmount: acc.salesAmount + g.salesAmount,
    }),
    { orders: 0, metraj: 0, camAdet: 0, cnc: 0, delik: 0, netKg: 0, crates: 0, grossKg: 0, estimatedCrates: 0, estimatedNetKg: 0, realCrates: false, amount: 0, salesAmount: 0 },
  );
  return { groups, total: t };
}

export default async function LoadingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePermission('SHIPMENT_VIEW');
  const { t, locale, m, intl } = await getT();
  const { unit, count } = counter(m, intl);
  const sp = await searchParams;
  const isCustomer = user.appRole === 'MUSTERI';
  const today = dayKey(new Date());
  const gun = parseDateOnly(sp.gun ?? '') ? sp.gun! : undefined;
  const ym = parseMonth(sp.ay) ?? (gun ?? today).slice(0, 7);
  const view = sp.view === 'liste' ? 'liste' : 'takvim';
  const q = (p: Record<string, string | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries({ view: view === 'liste' ? 'liste' : undefined, ...p })) if (v) s.set(k, v);
    const str = s.toString();
    return `/yuklemeler${str ? `?${str}` : ''}`;
  };

  const { from, to } = gridRange(ym);
  const [rows, crates] = await Promise.all([ordersShippingBetween(user, from, to), cratesBetween(user, from, to)]);
  const byDay = new Map<string, Entry[]>();
  for (const o of rows) {
    const k = shipDay(o);
    if (k) byDay.set(k, [...(byDay.get(k) ?? []), { o, load: loadOf(o, isCustomer) }]);
  }
  const cratesByDay = new Map<string, CrateRow[]>();
  for (const c of crates) {
    const k = crateDay(c);
    if (k) cratesByDay.set(k, [...(cratesByDay.get(k) ?? []), c]);
  }
  const dayTotal = (k: string) => groupDay(byDay.get(k) ?? [], user, cratesByDay.get(k) ?? []).total;
  const grid = monthGrid(ym);
  const monthDays = [...byDay.keys()].filter((k) => k.startsWith(ym)).sort();
  // Seçili gün: istenen gün; yoksa bu aydaki ilk (bugünden sonraki) yükleme günü
  const selected = gun ?? monthDays.find((k) => k >= today) ?? monthDays[monthDays.length - 1];
  let dayEntries = selected ? byDay.get(selected) ?? [] : [];
  let dayCrates = selected ? cratesByDay.get(selected) ?? [] : [];
  if (selected && !grid.some((w) => w.some((d) => d.key === selected))) {
    const d = new Date(`${selected}T00:00:00Z`);
    const [extra, extraCrates] = await Promise.all([
      ordersShippingBetween(user, new Date(d.getTime() - 86_400_000), new Date(d.getTime() + 2 * 86_400_000)),
      cratesBetween(user, d, new Date(d.getTime() + 86_400_000)),
    ]);
    dayEntries = extra.filter((o) => shipDay(o) === selected).map((o) => ({ o, load: loadOf(o, isCustomer) }));
    dayCrates = extraCrates;
  }
  const monthTotal = monthDays.map(dayTotal).reduce(
    (a, x) => ({ orders: a.orders + x.orders, metraj: Math.round((a.metraj + x.metraj) * 100) / 100, netKg: a.netKg + x.netKg }),
    { orders: 0, metraj: 0, netKg: 0 },
  );

  return (
    <>
      <div className="page-head">
        <h1>{isCustomer ? t('loading.titleCustomer') : t('loading.title')}</h1>
        <p className="muted">
          {isCustomer ? t('loading.introCustomer') : t('loading.intro')}
        </p>
        {userCan(user, 'TRANSPORT_LIST_VIEW') && (
          // Nakliye listesi (PDF): seçilen yükleme günü — /yuklemeler/nakliye (server/loading/transport.js)
          <form className="row" action="/yuklemeler/nakliye" method="get" style={{ gap: 8, marginTop: 8 }}>
            <label htmlFor="nakliye-gun" style={{ margin: 0 }}>{t('loading.transport.dayLabel')}</label>
            <input id="nakliye-gun" name="gun" type="date" defaultValue={selected ?? today} style={{ width: 'auto' }} required />
            <button className="btn btn-primary">{t('loading.transport.button')}</button>
          </form>
        )}
      </div>

      <div className="tabs">
        <Link href={q({ view: undefined, ay: ym, gun: selected })} className={view === 'takvim' ? 'active' : ''}>{t('loading.tabs.calendar')}</Link>
        <Link href={q({ view: 'liste', ay: ym, gun: selected })} className={view === 'liste' ? 'active' : ''}>{t('loading.tabs.list')}</Link>
      </div>

      <div className="card">
        <div className="cal-head">
          <div className="row">
            <Link className="btn" href={q({ ay: shiftMonth(ym, -1) })}>{t('loading.nav.prev')}</Link>
            <h2 className="cal-title">{fmtMonth(`${ym}-15T12:00:00Z`, locale)}</h2>
            <Link className="btn" href={q({ ay: shiftMonth(ym, 1) })}>{t('loading.nav.next')}</Link>
            <Link className="btn" href={q({ ay: today.slice(0, 7), gun: today })}>{t('loading.nav.thisMonth')}</Link>
          </div>
          <form className="row" action="/yuklemeler">
            {view === 'liste' && <input type="hidden" name="view" value="liste" />}
            <label htmlFor="gun" style={{ margin: 0 }}>{t('loading.nav.goToDay')}</label>
            <input id="gun" name="gun" type="date" defaultValue={gun ?? ''} style={{ width: 'auto' }} required />
            <button className="btn">{t('loading.nav.go')}</button>
          </form>
        </div>
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          {rich(t('loading.monthTotal'), {
            orders: <><b>{monthTotal.orders}</b> {unit('order', monthTotal.orders)}</>,
            m2: <b>{fmtNum(monthTotal.metraj)}</b>,
            kg: <b>{kg(monthTotal.netKg)}</b>,
          })}
        </p>

        {view === 'takvim' ? (
          <div className="cal">
            {weekdayNames(locale).map((w) => <div key={w} className="cal-wd">{w}</div>)}
            {grid.flat().map((d) => {
              const list = byDay.get(d.key) ?? [];
              const names = isCustomer
                ? list.map((e) => e.o.orderNo)
                : [...new Map(list.map((e) => [e.o.customer.id, customerLabel(user, e.o.customer.name)])).values()];
              const isSel = d.key === selected;
              const sum = isSel && list.length ? dayTotal(d.key) : null;
              return (
                <Link key={d.key} href={q({ ay: ym, gun: d.key })} className={`cal-day${d.inMonth ? '' : ' other'}${isSel ? ' sel' : ''}${list.length ? ' has' : ''}`}>
                  <div className="cal-top">
                    <b>{d.day}</b>
                    {d.key === today && <span className="badge badge-info">{t('loading.today')}</span>}
                    {list.length > 0 && <span className="cal-count" title={count('order', list.length)}>{list.length}</span>}
                  </div>
                  <div className="cal-names">
                    {names.slice(0, 3).map((n) => <div key={n}>{n}</div>)}
                    {names.length > 3 && <div className="muted">+{count(isCustomer ? 'order' : 'customer', names.length - 3)}</div>}
                    {sum && <div className="muted small">{fmtNum(sum.metraj)} m² · {kg(sum.grossKg)} kg</div>}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <DayList user={user} days={monthDays.map((k) => ({ key: k, entries: byDay.get(k)!, crates: cratesByDay.get(k) ?? [] }))} href={(k) => q({ ay: ym, gun: k })} selected={selected} isCustomer={isCustomer} />
        )}
      </div>

      {selected && <DayDetail user={user} day={selected} entries={dayEntries} crates={dayCrates} isCustomer={isCustomer} />}
    </>
  );
}

async function DayList({ user, days, href, selected, isCustomer }: { user: CurrentUser; days: { key: string; entries: Entry[]; crates: CrateRow[] }[]; href: (k: string) => string; selected?: string; isCustomer: boolean }) {
  const { t } = await getT();
  if (days.length === 0) return <div className="empty">{t('loading.list.empty')}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('loading.list.cols.day')}</th><th className="num">{t('loading.list.cols.orders')}</th><th>{isCustomer ? t('loading.list.cols.orderList') : t('loading.list.cols.customers')}</th>
            <th className="num">{t('loading.list.cols.metraj')}</th><th className="num">{t('loading.list.cols.glass')}</th><th className="num">{t('loading.list.cols.crates')}</th><th className="num">{t('loading.list.cols.gross')}</th>
          </tr>
        </thead>
        <tbody>
          {days.map(({ key, entries, crates }) => {
            const { total } = groupDay(entries, user, crates);
            const names = isCustomer ? entries.map((e) => e.o.orderNo) : [...new Set(entries.map((e) => customerLabel(user, e.o.customer.name)))];
            return (
              <tr key={key} className={key === selected ? 'row-sel' : undefined}>
                <td><Link href={href(key)}><b>{fmtDate(`${key}T12:00:00Z`)}</b></Link></td>
                <td className="num">{total.orders}</td>
                <td>{names.join(', ')}</td>
                <td className="num">{fmtNum(total.metraj)} m²</td>
                <td className="num">{total.camAdet}</td>
                <td className="num">{total.crates}</td>
                <td className="num">{kg(total.grossKg)} kg</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function DayDetail({ user, day, entries, crates, isCustomer }: { user: CurrentUser; day: string; entries: Entry[]; crates: CrateRow[]; isCustomer: boolean }) {
  const { t, m, intl } = await getT();
  const { count } = counter(m, intl);
  const { groups, total } = groupDay(entries, user, crates);
  const canEdit = userCan(user, 'CRATE_EDIT');
  const money: Money = { sales: userCan(user, 'OFFER_PREPARE'), offer: userCan(user, 'OFFER_SEND') || userCan(user, 'PRICE_FINAL_VIEW') };
  return (
    <div className="card" id="gun">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{t('loading.day.title', { date: fmtDate(`${day}T12:00:00Z`) })}</h2>
        <span className="badge">{count('order', total.orders)}</span>
      </div>
      {entries.length === 0 && groups.length === 0 ? (
        <p className="muted">{t('loading.day.empty')}</p>
      ) : (
        <>
          <div className="stats stats-5">
            <div className="stat"><div className="k">{t('loading.day.stats.orders')}</div><div className="v">{total.orders}</div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.metraj')}</div><div className="v">{fmtNum(total.metraj)}<small>{t('common.unitM2')}</small></div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.glass')}</div><div className="v">{total.camAdet}<small>{t('common.unitPiece')}</small></div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.gross')}</div><div className="v">{kg(total.grossKg)}<small>{t('common.unitKg')}</small></div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.crates')}</div><div className="v">{total.crates}<small>{t('common.unitPiece')}</small></div></div>
          </div>
          <p className="muted small">
            {total.estimatedCrates > 0 && (
              <>
                {t('loading.day.estimate', {
                  netKg: kg(total.estimatedNetKg), crates: count('crate', total.estimatedCrates), tare: CRATE_TARE_KG, max: fmtNum(CRATE_MAX_KG, 0),
                })}{' '}
              </>
            )}
            {t('loading.day.note')}
          </p>

          <div className="table-wrap">
            <table className="load-table">
              <thead>
                <tr>
                  <th>{isCustomer ? t('loading.day.cols.order') : t('loading.day.cols.customerOrder')}</th>{!isCustomer && <th className="num">{t('loading.day.cols.orders')}</th>}
                  <th className="num">{t('loading.day.cols.glass')}</th><th className="num">{t('loading.day.cols.cnc')}</th><th className="num">{t('loading.day.cols.holes')}</th><th className="num">{t('loading.day.cols.metraj')}</th><th className="num">{t('loading.day.cols.net')}</th>
                  <th className="num">{t('loading.day.cols.crates')}</th><th className="num">{t('loading.day.cols.gross')}</th>
                  {money.sales && <th className="num">{t('loading.day.cols.salesAmount')}</th>}{money.offer && <th className="num">{t('loading.day.cols.amount')}</th>}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.key} g={g} isCustomer={isCustomer} money={money} canEdit={canEdit} day={day} dayCrates={crates} user={user} m={m} />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('common.total')}</td>{!isCustomer && <td className="num">{total.orders}</td>}
                  <td className="num">{total.camAdet}</td><td className="num">{dash(total.cnc)}</td><td className="num">{dash(total.delik)}</td><td className="num">{fmtNum(total.metraj)}</td><td className="num">{kg(total.netKg)}</td>
                  <td className="num">{total.crates}</td><td className="num">{kg(total.grossKg)}</td>
                  {money.sales && <td className="num">{total.salesAmount ? fmtMoney(total.salesAmount) : '—'}</td>}
                  {money.offer && <td className="num">{total.amount ? fmtMoney(total.amount) : '—'}</td>}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

async function GroupRows({ g, isCustomer, money, canEdit, day, dayCrates, user, m }: { g: Group; isCustomer: boolean; money: Money; canEdit: boolean; day: string; dayCrates: CrateRow[]; user: CurrentUser; m: Dict }) {
  const { t } = await getT();
  const cratesOf = (orderId: string) => g.crates.filter((c) => c.orders.some((x) => x.orderId === orderId)).map((c) => c.crateNo);
  const orderRows = g.entries.map(({ o, load }) => {
    const nos = cratesOf(o.id);
    return (
      <tr key={o.id} className={isCustomer ? undefined : 'sub'}>
        <td>
          <Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link>{' '}
          {isCustomer ? <CustomerBadge status={o.status} drawing={o.drawingTrack} offer={load.amount != null ? 'GONDERILDI' : null} /> : <OrderBadge status={o.status} onHold={o.onHold} />}
          <div className="muted small">{o.title}</div>
        </td>
        {!isCustomer && <td />}
        <td className="num">{load.camAdet}</td>
        <td className="num">{dash(load.cnc)}</td>
        <td className="num">{dash(load.delik)}</td>
        <td className="num">{fmtNum(load.metraj)}</td>
        <td className="num">{kg(load.netKg)}</td>
        <td className="num">{nos.length ? <span title={t('loading.day.real')}>#{nos.join(', #')}</span> : g.total.realCrates ? '' : <span className="muted">{t('loading.day.estimated')}</span>}</td>
        <td className="num"><span className="muted">—</span></td>
        {money.sales && <td className="num">{load.salesAmount != null ? fmtMoney(load.salesAmount, load.currency) : <span className="muted">—</span>}</td>}
        {money.offer && <td className="num">{load.amount != null ? fmtMoney(load.amount, load.currency) : <span className="muted">—</span>}</td>}
      </tr>
    );
  });
  const groupTotal = (
    <tr className="group-total">
      <td><b>{g.label}</b></td>{!isCustomer && <td className="num">{g.total.orders}</td>}
      <td className="num">{g.total.camAdet}</td><td className="num">{dash(g.total.cnc)}</td><td className="num">{dash(g.total.delik)}</td><td className="num">{fmtNum(g.total.metraj)}</td><td className="num">{kg(g.total.netKg)}</td>
      <td className="num">{g.total.crates}{' '}{g.total.realCrates ? <span className="badge badge-ok">{t('loading.day.real')}</span> : <span className="muted small">{t('loading.day.estimated')}</span>}</td>
      <td className="num">{kg(g.total.grossKg)}</td>
      {money.sales && <td className="num">{g.salesAmount ? fmtMoney(g.salesAmount) : '—'}</td>}
      {money.offer && <td className="num">{g.amount ? fmtMoney(g.amount) : '—'}</td>}
    </tr>
  );
  if (isCustomer) return <>{orderRows}{g.crates.length > 0 && groupTotal}</>;
  const last = [...g.crates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  const init = g.crates.map((c) => ({
    crateNo: String(c.crateNo), lengthMm: c.lengthMm?.toString() ?? '', widthMm: c.widthMm?.toString() ?? '', heightMm: c.heightMm?.toString() ?? '',
    netKg: c.netAgirlik?.toString() ?? '', grossKg: c.brutAgirlik?.toString() ?? '', note: c.note ?? '', orderIds: c.orders.map((x) => x.orderId),
  }));
  const others = dayCrates.filter((c) => c.customer && c.customer.id !== g.key)
    .map((c) => ({ no: c.crateNo, label: customerLabel(user, c.customer!.name) }));
  return (
    <>
      {groupTotal}
      {orderRows}
      <tr className="crate-row">
        <td colSpan={9 + (money.sales ? 1 : 0) + (money.offer ? 1 : 0)}>
          <details open={g.crates.length > 0 || undefined}>
            <summary>{t('loading.day.crates.toggle')} · {t('loading.day.crates.count', { n: g.crates.length })}</summary>
            {canEdit ? (
              <CrateEditor
                day={day}
                customerId={g.key}
                orders={g.entries.map((e) => ({ id: e.o.id, orderNo: e.o.orderNo }))}
                initial={init}
                dayUsed={others}
                glassKg={g.entries.reduce((s, e) => s + e.load.netKg, 0)}
                tare={CRATE_TARE_KG}
                updated={last ? t('loading.day.crates.updated', { when: fmtDateTime(last.updatedAt), who: last.updatedBy?.name ?? '—' }) : null}
                m={m.loading.day.crates}
              />
            ) : g.crates.length > 0 ? (
              <table className="crate-table">
                <thead><tr><th>{t('loading.day.crates.cols.no')}</th><th>{t('loading.day.crates.cols.length')}</th><th>{t('loading.day.crates.cols.width')}</th><th>{t('loading.day.crates.cols.height')}</th><th>{t('loading.day.crates.cols.net')}</th><th>{t('loading.day.crates.cols.gross')}</th><th>{t('loading.day.crates.cols.note')}</th></tr></thead>
                <tbody>
                  {g.crates.map((c) => (
                    <tr key={c.id}>
                      <td>{c.crateNo}</td><td>{c.lengthMm ?? '—'}</td><td>{c.widthMm ?? '—'}</td><td>{c.heightMm ?? '—'}</td>
                      <td>{c.netAgirlik != null ? kg(Number(c.netAgirlik)) : '—'}</td><td>{c.brutAgirlik != null ? kg(Number(c.brutAgirlik)) : '—'}</td><td>{c.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted small">{t('loading.day.crates.readOnly')}</p>}
          </details>
        </td>
      </tr>
    </>
  );
}
