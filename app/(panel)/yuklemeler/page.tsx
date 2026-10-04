import Link from 'next/link';
import { type CurrentUser, requirePermission } from '@/lib/auth/session';
import { getT, type Dict, type MsgKey } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { customerLabel } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { crateDay, cratesBetween, guestCratesBetween, guestHostNames, loadOf, notLoadedByOrder, ordersShippingBetween, replanRowsBetween, shipDay, type CrateRow, type GuestLink, type Load, type LoadRow } from '@/lib/loading';
import { fmtDate, fmtDateTime, fmtMoney, fmtMonth, fmtNum, weekdayNames } from '@/lib/format';
import { CustomerBadge, OrderBadge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { parseDateOnly } from '@/server/orders/rules.js';
import { CRATE_MAX_KG, CRATE_TARE_KG, dayKey, gridRange, monthGrid, parseMonth, shiftMonth } from '@/server/orders/loading.js';
import { groupLoad } from '@/server/loading/crates.js';
import { CrateEditor } from './CrateEditor';
import { guestCrateAction } from './actions';
import { LoadingConfirm } from './LoadingConfirm';
import { LoadingBilling } from './LoadingBilling';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | undefined>;
type Entry = { o: LoadRow; load: Load };
type Total = ReturnType<typeof groupLoad>;
/**
 * guestsOut: bu müşterinin, BAŞKA müşterinin sandığında giden siparişleri · guestsIn: bu müşterinin sandıklarında giden
 * başka müşteri siparişleri (karar 103 — yalnızca fiziksel yerleşim; müşteri görünümünde guestsIn hiç gelmez).
 */
type Group = {
  key: string; label: string; entries: Entry[]; crates: CrateRow[]; total: Total; amount: number; salesAmount: number; crateLabels: string[]; guestsOut: GuestLink[]; guestsIn: GuestLink[];
  /** Özel durum (karar 124) — sandık seçimi bekleyenler: bu müşterinin başka firmayla gidecek siparişleri / bu firmayla gidecek başka müşteri siparişleri */
  waitingOut: Waiting[]; waitingIn: Waiting[];
};
/** Yönetici ev sahibi firmayı seçti, sandık henüz seçilmedi. hostHere: ev sahibi firmanın o gün satırı (sipariş / sandık) var mı */
type Waiting = { orderId: string; orderNo: string; ownerName: string; hostId: string; hostName: string; hostHere: boolean };
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
function groupDay(entries: Entry[], user: CurrentUser, crates: CrateRow[] = [], guests: GuestLink[] = [], hostNames: Map<string, string> = new Map()): { groups: Group[]; total: Total & { amount: number; salesAmount: number } } {
  // Başka müşterinin sandığına konmuş sipariş: metrajı / adedi kendi müşterisinde sayılır; ağırlığı taşındığı sandığın
  // müşterisine yazılır (kendi müşterisinde ayrıca tahmini sandık üretmez).
  const hosted = new Map(guests.map((l) => [l.orderId, l.hostId]));
  const kgOf = new Map<string, number>();
  for (const e of entries) kgOf.set(e.o.id, (kgOf.get(e.o.id) ?? 0) + e.load.netKg);
  const guestKg = (hostId: string) => [...hosted.entries()].filter(([, h]) => h === hostId).reduce((s, [orderId]) => s + (kgOf.get(orderId) ?? 0), 0);
  const map = new Map<string, { name: string; entries: Entry[]; crates: CrateRow[] }>();
  const at = (id: string, name: string) => {
    if (!map.has(id)) map.set(id, { name, entries: [], crates: [] });
    return map.get(id)!;
  };
  for (const e of entries) at(e.o.customer.id, e.o.customer.name).entries.push(e);
  // Siparişi başka güne alınmış olsa da o güne girilmiş sandıklar görünür (silinebilsin)
  for (const c of crates) if (c.customer) at(c.customer.id, c.customer.name).crates.push(c);
  // Özel durum: ev sahibi firması seçilmiş ama o gün henüz hiçbir misafir sandığa konmamış siparişler (sipariş başına bir kez).
  // Aktarılan kalan (replan satırı) yalnızca ev sahibi firmanın o gün de yüklemesi varsa bekler; yoksa kendi firmasıyla gider.
  const waiting = [...new Map(entries.filter((e) => e.o.guestHostId && !hosted.has(e.o.id) && (!e.o.replan || map.has(e.o.guestHostId))).map((e): [string, Waiting] => [e.o.id, {
    orderId: e.o.id, orderNo: e.o.orderNo, ownerName: e.o.customer.name, hostId: e.o.guestHostId!, hostName: hostNames.get(e.o.guestHostId!) ?? '', hostHere: map.has(e.o.guestHostId!),
  }])).values()];
  const groups = [...map.entries()].map(([key, g]) => ({
    key, label: customerLabel(user, g.name), entries: g.entries, crates: g.crates,
    total: groupLoad(g.entries.map((e) => (hosted.has(e.o.id) ? { ...e.load, netKg: 0 } : e.load)), g.crates, { guestKg: guestKg(key) }),
    amount: g.entries.reduce((s, e) => s + (e.load.amount ?? 0), 0),
    salesAmount: g.entries.reduce((s, e) => s + (e.load.salesAmount ?? 0), 0),
    // Sandık etiketi: siparişte girilmişse o, yoksa müşterinin varsayılanı (sipariş sayfasındaki kuralla aynı)
    crateLabels: [...new Set(g.entries.map((e) => e.o.sandikEtiket ?? e.o.customer.sandikEtiket ?? '').filter(Boolean))],
    guestsOut: guests.filter((l) => g.entries.some((e) => e.o.id === l.orderId)), guestsIn: guests.filter((l) => l.hostId === key),
    waitingOut: waiting.filter((w) => g.entries.some((e) => e.o.id === w.orderId)), waitingIn: waiting.filter((w) => w.hostId === key),
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
  const [dated, carried, crates, guests] = await Promise.all([
    ordersShippingBetween(user, from, to), replanRowsBetween(user, from, to), cratesBetween(user, from, to), guestCratesBetween(user, from, to),
  ]);
  // Gün satırları: o güne planlı siparişler + yüklenmeyen camın o güne aktarılmış kalanları (yalnızca aktarılan adetle)
  const withNotes = async (list: LoadRow[]) => {
    const missing = await notLoadedByOrder(list);
    return list.map((o) => (missing.has(o.id) && !o.replan ? { ...o, notLoaded: missing.get(o.id) } : o));
  };
  const rows = [...(await withNotes(dated)), ...carried];
  let hostNames = await guestHostNames(user, rows);
  const guestsOf = (k: string, list: GuestLink[] = guests) => list.filter((l) => l.day === k);
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
  const dayTotal = (k: string) => groupDay(byDay.get(k) ?? [], user, cratesByDay.get(k) ?? [], guestsOf(k)).total;
  const grid = monthGrid(ym);
  const monthDays = [...byDay.keys()].filter((k) => k.startsWith(ym)).sort();
  // Seçili gün: istenen gün; yoksa bu aydaki ilk (bugünden sonraki) yükleme günü
  const selected = gun ?? monthDays.find((k) => k >= today) ?? monthDays[monthDays.length - 1];
  let dayEntries = selected ? byDay.get(selected) ?? [] : [];
  let dayCrates = selected ? cratesByDay.get(selected) ?? [] : [];
  let dayGuests = selected ? guestsOf(selected) : [];
  if (selected && !grid.some((w) => w.some((d) => d.key === selected))) {
    const d = new Date(`${selected}T00:00:00Z`);
    const next = new Date(d.getTime() + 86_400_000);
    const [extra, extraCarried, extraCrates, extraGuests] = await Promise.all([
      ordersShippingBetween(user, new Date(d.getTime() - 86_400_000), new Date(d.getTime() + 2 * 86_400_000)),
      replanRowsBetween(user, d, next), cratesBetween(user, d, next), guestCratesBetween(user, d, next),
    ]);
    const extraRows = [...(await withNotes(extra)), ...extraCarried].filter((o) => shipDay(o) === selected);
    dayEntries = extraRows.map((o) => ({ o, load: loadOf(o, isCustomer) }));
    hostNames = await guestHostNames(user, extraRows);
    dayCrates = extraCrates;
    dayGuests = guestsOf(selected, extraGuests);
  }
  const monthTotal = monthDays.map(dayTotal).reduce(
    (a, x) => ({ orders: a.orders + x.orders, metraj: Math.round((a.metraj + x.metraj) * 100) / 100, netKg: a.netKg + x.netKg }),
    { orders: 0, metraj: 0, netKg: 0 },
  );

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{isCustomer ? t('loading.titleCustomer') : t('loading.title')}</h1>
          <p className="muted">{isCustomer ? t('loading.introCustomer') : t('loading.intro')}</p>
        </div>
        {userCan(user, 'TRANSPORT_LIST_VIEW') && (
          // Seçilen yükleme gününün belgeleri (iç ekip): nakliye listesi (PDF, /yuklemeler/nakliye — server/loading/transport.js)
          // ve yükleme dökümü (Excel, /yuklemeler/dokum — server/loading/summary.js). Gün, aşağıda seçili günle başlar.
          <form className="page-tools" action="/yuklemeler/nakliye" method="get">
            <label htmlFor="nakliye-gun">{t('loading.transport.dayLabel')}</label>
            <input id="nakliye-gun" name="gun" type="date" defaultValue={selected ?? today} required />
            <button className="btn">{t('loading.transport.button')}</button>
            <button className="btn btn-primary" formAction="/yuklemeler/dokum">{t('loading.summary.button')}</button>
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
            <label htmlFor="gun">{t('loading.nav.goToDay')}</label>
            <input id="gun" name="gun" type="date" defaultValue={gun ?? ''} required />
            <button className="btn">{t('loading.nav.go')}</button>
          </form>
        </div>
        <p className="cal-sum">
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
                ? [...new Set(list.map((e) => e.o.orderNo))]
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
          <DayList user={user} days={monthDays.map((k) => ({ key: k, entries: byDay.get(k)!, crates: cratesByDay.get(k) ?? [], guests: guestsOf(k) }))} href={(k) => q({ ay: ym, gun: k })} selected={selected} isCustomer={isCustomer} />
        )}
      </div>

      {selected && <DayDetail user={user} day={selected} entries={dayEntries} crates={dayCrates} guests={dayGuests} hostNames={hostNames} isCustomer={isCustomer} sp={sp} />}
      {/* Yükleme onayı (karar 92): iç ekip onaylı kaydı görür; önizleme ve "Eksiksiz Yüklendi" yalnızca yöneticide */}
      {selected && !isCustomer && (
        <>
          <LoadingConfirm user={user} day={selected} planned={dayEntries.filter((e) => !e.o.replan).map((e) => ({ id: e.o.id, orderNo: e.o.orderNo }))} sp={sp} />
          {/* Faturalama (Aşama 7D-3): yalnızca yönetici ve yalnızca onaylı günde — müşteri başına tek fatura, yüklenen kalemlerden */}
          <LoadingBilling user={user} day={selected} sp={sp} />
        </>
      )}
    </>
  );
}

async function DayList({ user, days, href, selected, isCustomer }: { user: CurrentUser; days: { key: string; entries: Entry[]; crates: CrateRow[]; guests: GuestLink[] }[]; href: (k: string) => string; selected?: string; isCustomer: boolean }) {
  const { t } = await getT();
  if (days.length === 0) return <div className="empty">{t('loading.list.empty')}</div>;
  return (
    <div className="table-wrap load-wrap">
      <table className="day-table">
        <thead>
          <tr>
            <th>{t('loading.list.cols.day')}</th><th className="num">{t('loading.list.cols.orders')}</th><th>{isCustomer ? t('loading.list.cols.orderList') : t('loading.list.cols.customers')}</th>
            <th className="num">{t('loading.list.cols.metraj')}</th><th className="num">{t('loading.list.cols.glass')}</th><th className="num">{t('loading.list.cols.crates')}</th><th className="num">{t('loading.list.cols.gross')}</th>
          </tr>
        </thead>
        <tbody>
          {days.map(({ key, entries, crates, guests }) => {
            const { total } = groupDay(entries, user, crates, guests);
            const names = isCustomer ? [...new Set(entries.map((e) => e.o.orderNo))] : [...new Set(entries.map((e) => customerLabel(user, e.o.customer.name)))];
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

const GUEST_ERRORS = ['FORBIDDEN', 'NOT_FOUND', 'ORDER_CANCELLED', 'NOT_SAME_LOADING', 'OWN_CRATE', 'NO_HOST', 'NOT_HOST_CRATE', 'ALREADY_ASSIGNED'];

async function DayDetail({ user, day, entries, crates, guests, hostNames, isCustomer, sp }: { user: CurrentUser; day: string; entries: Entry[]; crates: CrateRow[]; guests: GuestLink[]; hostNames: Map<string, string>; isCustomer: boolean; sp: SP }) {
  const { t, m, intl } = await getT();
  const { count } = counter(m, intl);
  const { groups, total } = groupDay(entries, user, crates, guests, hostNames);
  // Özel durum — sandık seçimi bekleyenler (yalnızca iç ekip; müşteri satırlarında ev sahibi bilgisi hiç yoktur)
  const waiting = isCustomer ? [] : groups.flatMap((g) => g.waitingOut);
  const canEdit = userCan(user, 'CRATE_EDIT');
  const money: Money = { sales: userCan(user, 'OFFER_PREPARE'), offer: userCan(user, 'OFFER_SEND') || userCan(user, 'PRICE_FINAL_VIEW') };
  return (
    <div className="card" id="gun">
      <div className="section-head">
        <h2>{t('loading.day.title', { date: fmtDate(`${day}T12:00:00Z`) })} <span className="badge">{count('order', total.orders)}</span></h2>
      </div>
      {!isCustomer && sp.sandik && <div className="alert alert-ok">{t(`loading.guest.ok.${sp.sandik === 'removed' ? 'removed' : 'assigned'}` as MsgKey)}</div>}
      {!isCustomer && sp.sandikHata && <div className="alert alert-error">{t(`loading.guest.errors.${GUEST_ERRORS.includes(sp.sandikHata) ? sp.sandikHata : 'NOT_FOUND'}` as MsgKey)}</div>}
      {/* Kırmızı uyarı (karar 124): yönetici ev sahibi firmayı seçti, sandık henüz seçilmedi. Adlar role göre maskeli. */}
      {waiting.map((w) => (
        <div key={w.orderId} className="alert alert-error guest-waiting" data-order={w.orderId}>
          <b>{t('loading.guest.waitingTitle')}</b>
          <div><Link className="order-no" href={`/siparisler/${w.orderId}`}>{w.orderNo}</Link> · {customerLabel(user, w.ownerName)}</div>
          <div>{t('loading.guest.waitingHost', { host: customerLabel(user, w.hostName) })}</div>
          {!w.hostHere && <div className="small">{t('loading.guest.waitingNoLoad')}</div>}
        </div>
      ))}
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
          <p className="muted small load-note">
            {total.estimatedCrates > 0 && (
              <>
                {t('loading.day.estimate', {
                  netKg: kg(total.estimatedNetKg), crates: count('crate', total.estimatedCrates), tare: CRATE_TARE_KG, max: fmtNum(CRATE_MAX_KG, 0),
                })}{' '}
              </>
            )}
            {t('loading.day.note')}
          </p>

          <div className="table-wrap load-wrap">
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
                  <GroupRows key={g.key} g={g} isCustomer={isCustomer} money={money} canEdit={canEdit} canPlace={userCan(user, 'LOADING_CONFIRM')} day={day} dayCrates={crates} user={user} m={m} />
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

async function GroupRows({ g, isCustomer, money, canEdit, canPlace, day, dayCrates, user, m }: { g: Group; isCustomer: boolean; money: Money; canEdit: boolean; canPlace: boolean; day: string; dayCrates: CrateRow[]; user: CurrentUser; m: Dict }) {
  const { t } = await getT();
  const dmy = (k: string) => fmtDate(`${k}T12:00:00Z`);
  const cratesOf = (orderId: string) => g.crates.filter((c) => c.orders.some((x) => x.orderId === orderId)).map((c) => c.crateNo);
  // Fiziksel yerleşim: siparişin başka müşterinin sandığındaki yeri. Müşteri yalnızca sandık numarasını görür.
  const guestOf = (orderId: string) => g.guestsOut.filter((l) => l.orderId === orderId);
  const orderRows = g.entries.map(({ o, load }) => {
    const nos = cratesOf(o.id);
    const away = guestOf(o.id);
    const wait = g.waitingOut.find((w) => w.orderId === o.id);
    return (
      <tr key={`${o.id}${o.replan ? ':r' : ''}`} className={isCustomer ? undefined : 'sub'}>
        <td>
          <Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link>{' '}
          {isCustomer ? <CustomerBadge status={o.status} drawing={o.drawingTrack} offer={load.amount != null ? 'GONDERILDI' : null} /> : <OrderBadge status={o.status} onHold={o.onHold} />}
          {/* Aktarılmış kalan: satır siparişin tamamı değil, önceki yüklemede yüklenmeyen adet (karar 102) */}
          {o.replan && <> <span className="badge badge-warn replan-badge">{t('loading.replan.from', { date: dmy(o.replan.fromDay) })}</span></>}
          {o.notLoaded && (
            <> <span className="badge badge-warn replan-badge">
              {t('loading.replan.notLoadedBadge', { n: o.notLoaded.quantity })}{o.notLoaded.replanDays.map((d) => ` ${t('loading.replan.movedTo', { date: dmy(d) })}`).join('')}
            </span></>
          )}
          <div className="muted small">{o.title}</div>
        </td>
        {!isCustomer && <td />}
        <td className="num">{load.camAdet}</td>
        <td className="num">{dash(load.cnc)}</td>
        <td className="num">{dash(load.delik)}</td>
        <td className="num">{fmtNum(load.metraj)}</td>
        <td className="num">{kg(load.netKg)}</td>
        <td className="num">
          {wait && <span className="badge badge-danger guest-badge" title={t('loading.guest.waitingTitle')}>{t('loading.guest.waitingBadge', { host: customerLabel(user, wait.hostName) })}</span>}
          {nos.length || away.length
            ? (
              <span className="crate-nos" title={t('loading.day.real')}>
                {nos.map((n) => <span key={n} className="badge badge-ok">#{n}</span>)}
                {away.map((l) => (isCustomer
                  ? <span key={`g${l.crateNo}`} className="badge badge-ok">#{l.crateNo}</span>
                  : <span key={`g${l.crateId}`} className="badge badge-info guest-badge" title={t('loading.guest.badgeTitle', { no: l.crateNo, host: customerLabel(user, l.hostName) })}>{t('loading.guest.badge', { no: l.crateNo, host: customerLabel(user, l.hostName) })}</span>))}
              </span>
            )
            : wait || g.total.realCrates ? '' : <span className="muted">{t('loading.day.estimated')}</span>}
        </td>
        <td className="num"><span className="muted">—</span></td>
        {money.sales && <td className="num">{load.salesAmount != null ? fmtMoney(load.salesAmount, load.currency) : <span className="muted">—</span>}</td>}
        {money.offer && <td className="num">{load.amount != null ? fmtMoney(load.amount, load.currency) : <span className="muted">—</span>}</td>}
      </tr>
    );
  });
  const groupTotal = (
    <tr className="group-total">
      <td>
        <b className="group-name">{g.label}</b>
        {/* Sandık etiketi (iç ekip): siparişteki / müşteri kaydındaki mevcut değer */}
        {!isCustomer && g.crateLabels.length > 0 && <span className="muted small"> · {t('loading.day.crates.label')}: <span className="mono">{g.crateLabels.join(', ')}</span></span>}
      </td>{!isCustomer && <td className="num">{g.total.orders}</td>}
      <td className="num">{g.total.camAdet}</td><td className="num">{dash(g.total.cnc)}</td><td className="num">{dash(g.total.delik)}</td><td className="num">{fmtNum(g.total.metraj)}</td><td className="num">{kg(g.total.netKg)}</td>
      <td className="num">{g.total.crates}{' '}{g.total.realCrates ? <span className="badge badge-ok">{t('loading.day.real')}</span> : <span className="muted small">{t('loading.day.estimated')}</span>}</td>
      <td className="num">{kg(g.total.grossKg)}</td>
      {money.sales && <td className="num">{g.salesAmount ? fmtMoney(g.salesAmount) : '—'}</td>}
      {money.offer && <td className="num">{g.amount ? fmtMoney(g.amount) : '—'}</td>}
    </tr>
  );
  const span = (isCustomer ? 8 : 9) + (money.sales ? 1 : 0) + (money.offer ? 1 : 0);
  // Salt okunur sandık listesi: no, uzunluk × genişlik × yükseklik, net, brüt (not: yalnızca iç ekip)
  const crateList = (note: boolean) => (
    <table className="crate-table readonly">
      <thead><tr><th>{t('loading.day.crates.cols.no')}</th><th>{t('loading.day.crates.cols.length')}</th><th>{t('loading.day.crates.cols.width')}</th><th>{t('loading.day.crates.cols.height')}</th><th>{t('loading.day.crates.cols.net')}</th><th>{t('loading.day.crates.cols.gross')}</th>{note && <th>{t('loading.day.crates.cols.note')}</th>}</tr></thead>
      <tbody>
        {g.crates.map((c) => (
          <tr key={c.id}>
            <td>{c.crateNo}</td><td>{c.lengthMm ?? '—'}</td><td>{c.widthMm ?? '—'}</td><td>{c.heightMm ?? '—'}</td>
            <td>{c.netAgirlik != null ? kg(Number(c.netAgirlik)) : '—'}</td><td>{c.brutAgirlik != null ? kg(Number(c.brutAgirlik)) : '—'}</td>{note && <td>{c.note ?? ''}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
  // Müşteri: kendi siparişleri, (sandık girildiyse) kendi toplamı ve kendi sandıklarının ölçü / ağırlıkları.
  // g.crates yalnızca bu firmanın sandıklarıdır (lib/loading.ts → cratesBetween müşteriyi kendi firmasıyla sınırlar).
  if (isCustomer) {
    return (
      <>
        {orderRows}
        {g.crates.length > 0 && groupTotal}
        {g.crates.length > 0 && (
          <tr className="crate-row">
            <td colSpan={span}>
              <details open>
                <summary>{t('loading.day.crates.toggle')} · {t('loading.day.crates.count', { n: g.crates.length })}</summary>
                {crateList(false)}
              </details>
            </td>
          </tr>
        )}
      </>
    );
  }
  const last = [...g.crates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  // Sandık formu yalnızca bu müşterinin kendi siparişlerini yönetir; sandıktaki başka müşteri siparişi (fiziksel yerleşim) formun dışındadır
  const ownOrders = [...new Map(g.entries.map((e) => [e.o.id, { id: e.o.id, orderNo: e.o.orderNo }])).values()];
  const ownIds = new Set(ownOrders.map((o) => o.id));
  const init = g.crates.map((c) => ({
    crateNo: String(c.crateNo), lengthMm: c.lengthMm?.toString() ?? '', widthMm: c.widthMm?.toString() ?? '', heightMm: c.heightMm?.toString() ?? '',
    netKg: c.netAgirlik?.toString() ?? '', grossKg: c.brutAgirlik?.toString() ?? '', note: c.note ?? '', orderIds: c.orders.map((x) => x.orderId).filter((id) => ownIds.has(id)),
  }));
  const others = dayCrates.filter((c) => c.customer && c.customer.id !== g.key).map((c) => ({ no: c.crateNo, label: customerLabel(user, c.customer!.name) }));
  return (
    <>
      {groupTotal}
      {orderRows}
      <tr className="crate-row">
        <td colSpan={span}>
          <details open={g.crates.length > 0 || undefined}>
            <summary>{t('loading.day.crates.toggle')} · {t('loading.day.crates.count', { n: g.crates.length })}</summary>
            {canEdit ? (
              <CrateEditor
                day={day}
                customerId={g.key}
                orders={ownOrders}
                initial={init}
                dayUsed={others}
                glassKg={g.entries.reduce((s, e) => s + e.load.netKg, 0)}
                tare={CRATE_TARE_KG}
                updated={last ? t('loading.day.crates.updated', { when: fmtDateTime(last.updatedAt), who: last.updatedBy?.name ?? '—' }) : null}
                m={m.loading.day.crates}
              />
            ) : g.crates.length > 0 ? crateList(true) : <p className="muted small">{t('loading.day.crates.readOnly')}</p>}
          </details>
          {/* Fiziksel yerleşim (karar 103, 124): ticari sahip ≠ sandığın müşterisi. İç ekip görür (ad, role göre maskeli).
              Ev sahibi firmayı yönetici sipariş sayfasında seçer; SANDIĞI burada, o firmanın sandıkları girilirken satış seçer. */}
          {(g.guestsOut.length > 0 || g.guestsIn.length > 0 || g.waitingIn.length > 0) && (
            <div className="guest-box" data-owner={g.key}>
              {(g.guestsIn.length > 0 || g.waitingIn.length > 0) && <p className="small guest-head"><b>{t('loading.guest.blockTitle')}</b></p>}
              {[
                ...g.guestsIn.map((l) => ({ orderId: l.orderId, orderNo: l.orderNo, ownerName: l.ownerName, crateId: l.crateId, crateNo: l.crateNo as number | null, byHost: l.byHost })),
                ...g.waitingIn.map((w) => ({ orderId: w.orderId, orderNo: w.orderNo, ownerName: w.ownerName, crateId: '', crateNo: null as number | null, byHost: true })),
              ].map((x) => (
                <form key={`in-${x.orderId}-${x.crateId}`} action={guestCrateAction} className="row small guest-line guest-in" data-order={x.orderId}>
                  <span><Link className="order-no" href={`/siparisler/${x.orderId}`}>{x.orderNo}</Link> · {customerLabel(user, x.ownerName)}</span>
                  {canEdit && x.byHost ? (
                    g.crates.length > 0 ? (
                      <>
                        <input type="hidden" name="day" value={day} />
                        <input type="hidden" name="orderId" value={x.orderId} />
                        <input type="hidden" name="current" value={x.crateId} />
                        <label className="small">{t('loading.guest.crate')}{' '}
                          <select name="crateId" defaultValue={x.crateId} aria-label={`${t('loading.guest.crate')} — ${x.orderNo}`}>
                            <option value="">{t('loading.guest.waitingOption')}</option>
                            {g.crates.map((c) => <option key={c.id} value={c.id}>{c.crateNo}</option>)}
                          </select>
                        </label>
                        <button className="btn">{t('common.save')}</button>
                      </>
                    ) : <span className="badge badge-danger">{t('loading.guest.noCrates')}</span>
                  ) : x.crateNo != null
                    ? <span className="badge badge-info">{t('loading.guest.crateNo', { no: x.crateNo })}</span>
                    : <span className="badge badge-danger">{t('loading.guest.waitingShort')}</span>}
                </form>
              ))}
              {g.guestsOut.map((l) => (
                <form key={`out-${l.crateId}-${l.orderId}`} action={guestCrateAction} className="row small guest-line guest-out">
                  <span>{t('loading.guest.out', { order: l.orderNo, owner: g.label, no: l.crateNo, host: customerLabel(user, l.hostName) })}</span>
                  {/* Eski kayıt (ev sahibi firma seçilmeden yapılmış yerleşim): yalnızca yönetici kaldırır */}
                  {canPlace && !l.byHost && (
                    <>
                      <input type="hidden" name="day" value={day} />
                      <input type="hidden" name="orderId" value={l.orderId} />
                      <input type="hidden" name="crateId" value={l.crateId} />
                      <ConfirmButton danger name="do" value="remove" message={t('loading.guest.removeDialog')}>{t('loading.guest.remove')}</ConfirmButton>
                    </>
                  )}
                </form>
              ))}
            </div>
          )}
        </td>
      </tr>
    </>
  );
}
