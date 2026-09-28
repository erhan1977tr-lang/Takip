import Link from 'next/link';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { customerLabel } from '@/lib/orders';
import { loadOf, ordersShippingBetween, shipDay, type Load, type LoadRow } from '@/lib/loading';
import { fmtDate, fmtMoney, fmtMonth, fmtNum } from '@/lib/format';
import { CustomerBadge, OrderBadge } from '@/components/StatusBadge';
import { parseDateOnly } from '@/server/orders/rules.js';
import { CRATE_MAX_KG, CRATE_TARE_KG, dayKey, gridRange, monthGrid, parseMonth, shiftMonth, sumLoads } from '@/server/orders/loading.js';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | undefined>;
type Entry = { o: LoadRow; load: Load };
type Group = { key: string; label: string; entries: Entry[]; total: ReturnType<typeof sumLoads>; amount: number };

const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const kg = (n: number) => fmtNum(n, 0);
const dash = (n: number) => (n ? String(n) : '–');

/** Bir günün siparişlerini müşteriye göre gruplar; sandıklar müşteriler arasında karışmaz. */
function groupDay(entries: Entry[], user: CurrentUser): { groups: Group[]; total: ReturnType<typeof sumLoads> & { amount: number } } {
  const map = new Map<string, Entry[]>();
  for (const e of entries) map.set(e.o.customer.id, [...(map.get(e.o.customer.id) ?? []), e]);
  const groups = [...map.entries()].map(([key, list]) => ({
    key, label: customerLabel(user, list[0].o.customer.name), entries: list,
    total: sumLoads(list.map((e) => e.load)), amount: list.reduce((s, e) => s + (e.load.amount ?? 0), 0),
  })).sort((a, b) => b.total.metraj - a.total.metraj);
  const t = groups.reduce(
    (acc, g) => ({
      orders: acc.orders + g.total.orders, metraj: Math.round((acc.metraj + g.total.metraj) * 100) / 100, camAdet: acc.camAdet + g.total.camAdet,
      cnc: acc.cnc + g.total.cnc, delik: acc.delik + g.total.delik,
      netKg: acc.netKg + g.total.netKg, crates: acc.crates + g.total.crates, grossKg: acc.grossKg + g.total.grossKg,
      estimatedCrates: acc.estimatedCrates + g.total.estimatedCrates, estimatedNetKg: acc.estimatedNetKg + g.total.estimatedNetKg,
      amount: acc.amount + g.amount,
    }),
    { orders: 0, metraj: 0, camAdet: 0, cnc: 0, delik: 0, netKg: 0, crates: 0, grossKg: 0, estimatedCrates: 0, estimatedNetKg: 0, amount: 0 },
  );
  return { groups, total: t };
}

export default async function LoadingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser(['ADMIN', 'SATIS', 'MUSTERI']);
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
  const rows = await ordersShippingBetween(user, from, to);
  const byDay = new Map<string, Entry[]>();
  for (const o of rows) {
    const k = shipDay(o);
    if (k) byDay.set(k, [...(byDay.get(k) ?? []), { o, load: loadOf(o, isCustomer) }]);
  }
  const grid = monthGrid(ym);
  const monthDays = [...byDay.keys()].filter((k) => k.startsWith(ym)).sort();
  // Seçili gün: istenen gün; yoksa bu aydaki ilk (bugünden sonraki) yükleme günü
  const selected = gun ?? monthDays.find((k) => k >= today) ?? monthDays[monthDays.length - 1];
  let dayEntries = selected ? byDay.get(selected) ?? [] : [];
  if (selected && !grid.some((w) => w.some((d) => d.key === selected))) {
    const d = new Date(`${selected}T00:00:00Z`);
    const extra = await ordersShippingBetween(user, new Date(d.getTime() - 86_400_000), new Date(d.getTime() + 2 * 86_400_000));
    dayEntries = extra.filter((o) => shipDay(o) === selected).map((o) => ({ o, load: loadOf(o, isCustomer) }));
  }
  const monthTotal = sumLoads(monthDays.flatMap((k) => byDay.get(k)!.map((e) => e.load)));

  return (
    <>
      <div className="page-head">
        <h1>{isCustomer ? 'Yükleme takvimim' : 'Yüklemeler'}</h1>
        <p className="muted">
          {isCustomer
            ? 'Siparişlerinizin hangi gün yükleneceği. Bir güne tıklayınca o günün siparişleri açılır.'
            : 'Yükleme gününe göre gruplanmış işler. Beklemeye alınanlar bu listede görünmez.'}
        </p>
      </div>

      <div className="tabs">
        <Link href={q({ view: undefined, ay: ym, gun: selected })} className={view === 'takvim' ? 'active' : ''}>Takvim</Link>
        <Link href={q({ view: 'liste', ay: ym, gun: selected })} className={view === 'liste' ? 'active' : ''}>Liste</Link>
      </div>

      <div className="card">
        <div className="cal-head">
          <div className="row">
            <Link className="btn" href={q({ ay: shiftMonth(ym, -1) })}>‹ Önceki ay</Link>
            <h2 className="cal-title">{fmtMonth(`${ym}-15T12:00:00Z`)}</h2>
            <Link className="btn" href={q({ ay: shiftMonth(ym, 1) })}>Sonraki ay ›</Link>
            <Link className="btn" href={q({ ay: today.slice(0, 7), gun: today })}>Bu ay</Link>
          </div>
          <form className="row" action="/yuklemeler">
            {view === 'liste' && <input type="hidden" name="view" value="liste" />}
            <label htmlFor="gun" style={{ margin: 0 }}>Güne git</label>
            <input id="gun" name="gun" type="date" defaultValue={gun ?? ''} style={{ width: 'auto' }} required />
            <button className="btn">Git</button>
          </form>
        </div>
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          Ay toplamı: <b>{monthTotal.orders}</b> sipariş · <b>{fmtNum(monthTotal.metraj)}</b> m² · <b>{kg(monthTotal.netKg)}</b> kg cam
        </p>

        {view === 'takvim' ? (
          <div className="cal">
            {WEEKDAYS.map((w) => <div key={w} className="cal-wd">{w}</div>)}
            {grid.flat().map((d) => {
              const list = byDay.get(d.key) ?? [];
              const names = isCustomer
                ? list.map((e) => e.o.orderNo)
                : [...new Map(list.map((e) => [e.o.customer.id, customerLabel(user, e.o.customer.name)])).values()];
              const isSel = d.key === selected;
              const t = isSel && list.length ? sumLoads(list.map((e) => e.load)) : null;
              return (
                <Link key={d.key} href={q({ ay: ym, gun: d.key })} className={`cal-day${d.inMonth ? '' : ' other'}${isSel ? ' sel' : ''}${list.length ? ' has' : ''}`}>
                  <div className="cal-top">
                    <b>{d.day}</b>
                    {d.key === today && <span className="badge badge-info">bugün</span>}
                    {list.length > 0 && <span className="cal-count" title={`${list.length} sipariş`}>{list.length}</span>}
                  </div>
                  <div className="cal-names">
                    {names.slice(0, 3).map((n) => <div key={n}>{n}</div>)}
                    {names.length > 3 && <div className="muted">+{names.length - 3} {isCustomer ? 'sipariş' : 'müşteri'}</div>}
                    {t && <div className="muted small">{fmtNum(t.metraj)} m² · {kg(t.grossKg)} kg</div>}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <DayList user={user} days={monthDays.map((k) => ({ key: k, entries: byDay.get(k)! }))} href={(k) => q({ ay: ym, gun: k })} selected={selected} isCustomer={isCustomer} />
        )}
      </div>

      {selected && <DayDetail user={user} day={selected} entries={dayEntries} isCustomer={isCustomer} />}
    </>
  );
}

function DayList({ user, days, href, selected, isCustomer }: { user: CurrentUser; days: { key: string; entries: Entry[] }[]; href: (k: string) => string; selected?: string; isCustomer: boolean }) {
  if (days.length === 0) return <div className="empty">Bu ay yükleme yok.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Yükleme günü</th><th className="num">Sipariş</th><th>{isCustomer ? 'Siparişler' : 'Müşteriler'}</th><th className="num">Metraj</th><th className="num">Cam</th><th className="num">Sandık</th><th className="num">Brüt</th></tr></thead>
        <tbody>
          {days.map(({ key, entries }) => {
            const { total } = groupDay(entries, user);
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

function DayDetail({ user, day, entries, isCustomer }: { user: CurrentUser; day: string; entries: Entry[]; isCustomer: boolean }) {
  const { groups, total } = groupDay(entries, user);
  return (
    <div className="card" id="gun">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Yükleme: {fmtDate(`${day}T12:00:00Z`)}</h2>
        <span className="badge">{total.orders} sipariş</span>
      </div>
      {entries.length === 0 ? (
        <p className="muted">Bu gün için yükleme yok.</p>
      ) : (
        <>
          <div className="stats stats-5">
            <div className="stat"><div className="k">Sipariş</div><div className="v">{total.orders}</div></div>
            <div className="stat"><div className="k">Toplam metraj</div><div className="v">{fmtNum(total.metraj)}<small>m²</small></div></div>
            <div className="stat"><div className="k">Cam adedi</div><div className="v">{total.camAdet}<small>adet</small></div></div>
            <div className="stat"><div className="k">Brüt ağırlık</div><div className="v">{kg(total.grossKg)}<small>kg</small></div></div>
            <div className="stat"><div className="k">Sandık</div><div className="v">{total.crates}<small>adet</small></div></div>
          </div>
          <p className="muted small">
            {total.estimatedCrates > 0 && <>Planlama tahmini: brüt = cam {kg(total.estimatedNetKg)} kg + {total.estimatedCrates} sandık × {CRATE_TARE_KG} kg dara (cam ağırlığı müşteri başına azami {fmtNum(CRATE_MAX_KG, 0)} kg'a bölünüp yukarı yuvarlanıyor). </>}
            Satış siparişe sandık ölçü ve ağırlıklarını girdiyse o siparişte GERÇEK kayıtlar kullanılır ve tahminin önüne geçer.
            Cam ağırlığı teklifteki cam kalınlığından hesaplanır (mm başına 2,5 kg/m²).
          </p>

          <div className="table-wrap">
            <table className="load-table">
              <thead>
                <tr>
                  <th>{isCustomer ? 'Sipariş' : 'Müşteri / sipariş'}</th>{!isCustomer && <th className="num">Sipariş</th>}
                  <th className="num">Cam</th><th className="num">CNC</th><th className="num">Delik</th><th className="num">Metraj</th><th className="num">Net ağırlık</th>
                  <th className="num">Sandık</th><th className="num">Brüt ağırlık</th><th className="num">Teklif tutarı</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.key} g={g} isCustomer={isCustomer} />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Toplam</td>{!isCustomer && <td className="num">{total.orders}</td>}
                  <td className="num">{total.camAdet}</td><td className="num">{dash(total.cnc)}</td><td className="num">{dash(total.delik)}</td><td className="num">{fmtNum(total.metraj)}</td><td className="num">{kg(total.netKg)}</td>
                  <td className="num">{total.crates}</td><td className="num">{kg(total.grossKg)}</td>
                  <td className="num">{total.amount ? fmtMoney(total.amount) : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function GroupRows({ g, isCustomer }: { g: Group; isCustomer: boolean }) {
  const orderRows = g.entries.map(({ o, load }) => (
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
      <td className="num">{load.realCrates ? <>{load.crates} <span className="badge badge-ok">gerçek</span></> : <span className="muted">tahmini</span>}</td>
      <td className="num">{load.realCrates ? kg(load.grossKg) : <span className="muted">—</span>}</td>
      <td className="num">{load.amount != null ? fmtMoney(load.amount, load.currency) : <span className="muted">—</span>}</td>
    </tr>
  ));
  if (isCustomer) return <>{orderRows}</>;
  return (
    <>
      <tr className="group-total">
        <td><b>{g.label}</b></td><td className="num">{g.total.orders}</td>
        <td className="num">{g.total.camAdet}</td><td className="num">{dash(g.total.cnc)}</td><td className="num">{dash(g.total.delik)}</td><td className="num">{fmtNum(g.total.metraj)}</td><td className="num">{kg(g.total.netKg)}</td>
        <td className="num">{g.total.crates}</td><td className="num">{kg(g.total.grossKg)}</td>
        <td className="num">{g.amount ? fmtMoney(g.amount) : '—'}</td>
      </tr>
      {orderRows}
    </>
  );
}
