import Link from 'next/link';
import { type CurrentUser, requirePermission } from '@/lib/auth/session';
import { getT, type Dict, type MsgKey, type T } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { userCan } from '@/lib/permissions';
import {
  canFirmDocs, crateDay, cratesBetween, dayEntry, firmsOfDay, guestCratesBetween, guestHostNames, moneyView, notLoadedByOrder, ordersShippingBetween, replanRowsBetween, shipDay,
  type CrateRow, type DayEntry, type DayFirm, type DayFirms, type GuestLink, type LoadRow, type MoneyView,
} from '@/lib/loading';
import { customerLabel } from '@/lib/orders';
import { fmtDate, fmtDateTime, fmtM2, fmtMoney, fmtMonth, fmtNum, weekdayNames } from '@/lib/format';
import { Badge, CustomerBadge, OrderBadge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { parseDateOnly } from '@/server/orders/rules.js';
import { CRATE_MAX_KG, CRATE_TARE_KG, dayKey, gridRange, monthGrid, parseMonth, shiftMonth } from '@/server/orders/loading.js';
import { rowsTotal } from '@/server/loading/day-firms.js';
import { CrateEditor } from './CrateEditor';
import { FirmRows } from './FirmRows';
import { guestCrateAction } from './actions';
import { LoadingConfirm } from './LoadingConfirm';
import { LoadingBilling } from './LoadingBilling';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | undefined>;
type Money = Record<string, { sales: number; offer: number; hasSales: boolean; hasOffer: boolean }>;
type Row = DayFirm['rows'][number];

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

/** Para birimi başına tutar hücresi (farklı para birimleri toplanmaz, alt alta yazılır) */
function amounts(money: Money, key: 'sales' | 'offer') {
  const list = Object.entries(money).filter(([, v]) => (key === 'sales' ? v.hasSales : v.hasOffer));
  if (list.length === 0) return <span className="muted">—</span>;
  return list.map(([cur, v]) => <div key={cur}>{fmtMoney(v[key], cur)}</div>);
}

/** Firma işlemlerinin adresleri (firma + yükleme günü; yetki her adreste sunucuda yeniden denetlenir) */
const firmUrls = (day: string, id: string) => {
  const q = `gun=${day}&firma=${encodeURIComponent(id)}`;
  return { pdf: `/yuklemeler/firma?${q}&bicim=pdf`, xlsx: `/yuklemeler/firma?${q}&bicim=xlsx`, summary: `/yuklemeler/ozet?${q}` };
};

export default async function LoadingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePermission('SHIPMENT_VIEW');
  const { t, locale, m, intl } = await getT();
  const { unit, count } = counter(m, intl);
  const sp = await searchParams;
  const isCustomer = user.appRole === 'MUSTERI';
  const view = { customer: isCustomer, money: moneyView(user) };
  const today = dayKey(new Date());
  const gun = parseDateOnly(sp.gun ?? '') ? sp.gun! : undefined;
  const ym = parseMonth(sp.ay) ?? (gun ?? today).slice(0, 7);
  const tab = sp.view === 'liste' ? 'liste' : 'takvim';
  const q = (p: Record<string, string | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries({ view: tab === 'liste' ? 'liste' : undefined, ...p })) if (v) s.set(k, v);
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
  const byDay = new Map<string, DayEntry[]>();
  for (const o of rows) {
    const k = shipDay(o);
    if (k) byDay.set(k, [...(byDay.get(k) ?? []), dayEntry(o, view)]);
  }
  const cratesByDay = new Map<string, CrateRow[]>();
  for (const c of crates) {
    const k = crateDay(c);
    if (k) cratesByDay.set(k, [...(cratesByDay.get(k) ?? []), c]);
  }
  // Günün firma tablosu (tek atıf kuralı — server/loading/day-firms.js); gün başına bir kez hesaplanır
  const sums = new Map<string, DayFirms>();
  const sumOf = (k: string) => {
    if (!sums.has(k)) sums.set(k, firmsOfDay(user, byDay.get(k) ?? [], cratesByDay.get(k) ?? [], guestsOf(k), hostNames));
    return sums.get(k)!;
  };
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
    dayEntries = extraRows.map((o) => dayEntry(o, view));
    hostNames = await guestHostNames(user, extraRows);
    dayCrates = extraCrates;
    dayGuests = guestsOf(selected, extraGuests);
  }
  const monthTotal = monthDays.map((k) => sumOf(k).total).reduce(
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
          // ve yükleme özeti (Excel, /yuklemeler/dokum — server/loading/summary.js). Gün, aşağıda seçili günle başlar.
          <form className="page-tools" action="/yuklemeler/nakliye" method="get">
            <label htmlFor="nakliye-gun">{t('loading.transport.dayLabel')}</label>
            <input id="nakliye-gun" name="gun" type="date" defaultValue={selected ?? today} required />
            <button className="btn">{t('loading.transport.button')}</button>
            <button className="btn btn-primary" formAction="/yuklemeler/dokum">{t('loading.summary.button')}</button>
          </form>
        )}
      </div>

      <div className="tabs">
        <Link href={q({ view: undefined, ay: ym, gun: selected })} className={tab === 'takvim' ? 'active' : ''}>{t('loading.tabs.calendar')}</Link>
        <Link href={q({ view: 'liste', ay: ym, gun: selected })} className={tab === 'liste' ? 'active' : ''}>{t('loading.tabs.list')}</Link>
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
            {tab === 'liste' && <input type="hidden" name="view" value="liste" />}
            <label htmlFor="gun">{t('loading.nav.goToDay')}</label>
            <input id="gun" name="gun" type="date" defaultValue={gun ?? ''} required />
            <button className="btn">{t('loading.nav.go')}</button>
          </form>
        </div>
        <p className="cal-sum">
          {rich(t('loading.monthTotal'), {
            orders: <><b>{monthTotal.orders}</b> {unit('order', monthTotal.orders)}</>,
            m2: <b>{fmtM2(monthTotal.metraj)}</b>,
            kg: <b>{kg(monthTotal.netKg)}</b>,
          })}
        </p>

        {tab === 'takvim' ? (
          <div className="cal">
            {weekdayNames(locale).map((w) => <div key={w} className="cal-wd">{w}</div>)}
            {grid.flat().map((d) => {
              const list = byDay.get(d.key) ?? [];
              const names = isCustomer
                ? [...new Set(list.map((e) => e.orderNo))]
                : [...new Map(list.map((e) => [e.customerId, customerLabel(user, e.customerName)])).values()];
              const isSel = d.key === selected;
              const s = list.length ? sumOf(d.key) : null;
              return (
                <Link key={d.key} href={q({ ay: ym, gun: d.key })} className={`cal-day${d.inMonth ? '' : ' other'}${isSel ? ' sel' : ''}${list.length ? ' has' : ''}`}>
                  <div className="cal-top">
                    <b>{d.day}</b>
                    {d.key === today && <span className="badge badge-info">{t('loading.today')}</span>}
                    {/* Sağ üstte iki yuvarlak (Paket 7): sarı = o günün sipariş sayısı; kırmızı = misafir yük olarak giden
                        sipariş sayısı (gerçek misafir ilişkilerinden; yoksa gösterilmez). Müşteriye yalnızca sarı gösterge. */}
                    {s && (
                      <span className="cal-badges">
                        <span className={`cal-count${s.total.orders > 99 ? ' long' : ''}`} title={count('order', s.total.orders)} aria-label={count('order', s.total.orders)} data-n={s.total.orders}>{s.total.orders}</span>
                        {!isCustomer && s.guestOrders > 0 && (
                          <span className={`cal-guests${s.guestOrders > 99 ? ' long' : ''}`} title={t('loading.calendar.guests', { n: s.guestOrders })} aria-label={t('loading.calendar.guests', { n: s.guestOrders })} data-n={s.guestOrders}>{s.guestOrders}</span>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="cal-names">
                    {names.slice(0, 3).map((n) => <div key={n}>{n}</div>)}
                    {names.length > 3 && <div className="muted">+{count(isCustomer ? 'order' : 'customer', names.length - 3)}</div>}
                    {isSel && s && <div className="muted small">{fmtM2(s.total.metraj)} m² · {kg(s.total.grossKg)} kg</div>}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <DayList user={user} days={monthDays.map((k) => ({ key: k, entries: byDay.get(k)!, sum: sumOf(k) }))} href={(k) => q({ ay: ym, gun: k })} selected={selected} isCustomer={isCustomer} />
        )}
      </div>

      {selected && <DayDetail user={user} day={selected} sum={firmsOfDay(user, dayEntries, dayCrates, dayGuests, hostNames)} crates={dayCrates} money={view.money} isCustomer={isCustomer} sp={sp} />}
      {/* Yükleme onayı (karar 92): iç ekip onaylı kaydı görür; önizleme ve "Yükleme yapıldı" yalnızca yöneticide */}
      {selected && !isCustomer && (
        <>
          <LoadingConfirm user={user} day={selected} planned={dayEntries.filter((e) => !e.replan).map((e) => ({ id: e.orderId, orderNo: e.orderNo }))} sp={sp} />
          {/* Faturalama (Aşama 7D-3): yalnızca yönetici ve yalnızca onaylı günde — müşteri başına tek fatura, yüklenen kalemlerden */}
          <LoadingBilling user={user} day={selected} sp={sp} />
        </>
      )}
    </>
  );
}

async function DayList({ user, days, href, selected, isCustomer }: { user: CurrentUser; days: { key: string; entries: DayEntry[]; sum: DayFirms }[]; href: (k: string) => string; selected?: string; isCustomer: boolean }) {
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
          {days.map(({ key, entries, sum }) => {
            const { total } = sum;
            const names = isCustomer ? [...new Set(entries.map((e) => e.orderNo))] : [...new Set(entries.map((e) => customerLabel(user, e.customerName)))];
            return (
              <tr key={key} className={key === selected ? 'row-sel' : undefined}>
                <td><Link href={href(key)}><b>{fmtDate(`${key}T12:00:00Z`)}</b></Link></td>
                <td className="num">{total.orders}</td>
                <td>{names.join(', ')}</td>
                <td className="num">{fmtM2(total.metraj)} m²</td>
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

async function DayDetail({ user, day, sum, crates, money, isCustomer, sp }: { user: CurrentUser; day: string; sum: DayFirms; crates: CrateRow[]; money: MoneyView; isCustomer: boolean; sp: SP }) {
  const { t, m, intl } = await getT();
  const { count } = counter(m, intl);
  const { firms, total } = sum;
  // Özel durum — sandık seçimi bekleyenler (yalnızca iç ekip; müşteri satırlarında ev sahibi bilgisi hiç yoktur)
  const waiting = isCustomer ? [] : firms.flatMap((f) => f.rows.filter((r) => r.guest?.waiting).map((r) => ({ firm: f, row: r })));
  return (
    <div className="card" id="gun">
      <div className="section-head">
        <h2>{t('loading.day.title', { date: fmtDate(`${day}T12:00:00Z`) })} <span className="badge">{count('order', total.orders)}</span></h2>
      </div>
      {!isCustomer && sp.sandik && <div className="alert alert-ok">{t(`loading.guest.ok.${sp.sandik === 'removed' ? 'removed' : 'assigned'}` as MsgKey)}</div>}
      {!isCustomer && sp.sandikHata && <div className="alert alert-error">{t(`loading.guest.errors.${GUEST_ERRORS.includes(sp.sandikHata) ? sp.sandikHata : 'NOT_FOUND'}` as MsgKey)}</div>}
      {/* Kırmızı uyarı (karar 124): yönetici ev sahibi firmayı seçti, sandık henüz seçilmedi. Adlar role göre maskeli. */}
      {waiting.map(({ firm, row }) => (
        <div key={`${row.entry.orderId}:${row.entry.replan ? 'r' : ''}`} className="alert alert-error guest-waiting" data-order={row.entry.orderId}>
          <b>{t('loading.guest.waitingTitle')}</b>
          <div><Link className="order-no" href={`/siparisler/${row.entry.orderId}`}>{row.entry.orderNo}</Link> · {firm.name}</div>
          <div>{t('loading.guest.waitingHost', { host: row.guest!.hostName })}</div>
          {row.guest!.hostHere
            ? <div className="small"><Link href={`/yuklemeler?gun=${day}&acik=${encodeURIComponent(row.guest!.hostId)}#firma-${row.guest!.hostId}`}>{t('loading.guest.pickCrate')}</Link></div>
            : <div className="small">{t('loading.guest.waitingNoLoad')}</div>}
        </div>
      ))}
      {firms.length === 0 ? (
        <p className="muted">{t('loading.day.empty')}</p>
      ) : (
        <>
          <div className="stats stats-5">
            <div className="stat"><div className="k">{t('loading.day.stats.orders')}</div><div className="v">{total.orders}</div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.metraj')}</div><div className="v">{fmtM2(total.metraj)}<small>{t('common.unitM2')}</small></div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.glass')}</div><div className="v">{total.camAdet}<small>{t('common.unitPiece')}</small></div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.gross')}</div><div className="v">{kg(total.grossKg)}<small>{t('common.unitKg')}</small></div></div>
            <div className="stat"><div className="k">{t('loading.day.stats.crates')}</div><div className="v">{total.crates}<small>{t('common.unitPiece')}</small></div></div>
          </div>
          {/* Açıklama: iç ekipte kısa (karar 215); müşterinin takvimindeki metin değişmez */}
          <p className="muted small load-note">
            {total.estimatedCrates > 0 && (
              <>
                {t(isCustomer ? 'loading.day.estimateCustomer' : 'loading.day.estimate', {
                  netKg: kg(total.estimatedNetKg), crates: count('crate', total.estimatedCrates), tare: CRATE_TARE_KG, max: fmtNum(CRATE_MAX_KG, 0),
                })}{' '}
              </>
            )}
            {t(isCustomer ? 'loading.day.noteCustomer' : 'loading.day.note')}
          </p>
          {isCustomer
            ? <CustomerDay firm={firms[0]} money={money} t={t} />
            : <FirmTable user={user} day={day} sum={sum} dayCrates={crates} money={money} sp={sp} t={t} m={m} />}
        </>
      )}
    </div>
  );
}

/** Firma tablosunun sayı sütunları: kısa başlık (ekranda) + tam adı (title, dar ekranda hücre etiketi kısa ad) */
const FIRM_COLS = ['orders', 'glass', 'cnc', 'holes', 'm2', 'net', 'crates', 'gross'] as const;
type FirmCol = (typeof FIRM_COLS)[number] | 'factory' | 'offer';

/**
 * İç ekip: firma bazlı ana tablo (Paket 7, karar 186). Her firma o gün TEK satırdır; satır açılınca alt siparişler, "Sandık" ile
 * o firmanın o günkü sandıkları açılır. Ticari sütunlar siparişin sahibinde, sandık / ağırlık sütunları camı taşıyan firmada
 * (misafir yükte ev sahibi). Tutar sütunları yetkiye göre: fabrika satış (yönetici, satış), teklif (yönetici, denetimci).
 * Düzen (Yönetici Paneli Paketi 1, karar 215): kısa başlıklar (tam ad ipucunda), sıkı hücreler; tablo kendi alanına sığmıyorsa
 * (dar masaüstü, telefon) her firma etiketli bir kart olur — sayfa ve tablo yatay kaymaz (app/globals.css → .firm-wrap).
 * Sağdaki işlemler: belge yetkisi olan rolde PDF | Excel | Özet | Sandık; satışta yalnızca Sandık.
 */
function FirmTable({ user, day, sum, dayCrates, money, sp, t, m }: { user: CurrentUser; day: string; sum: DayFirms; dayCrates: CrateRow[]; money: MoneyView; sp: SP; t: T; m: Dict }) {
  const { firms, total } = sum;
  const cols = 10 + (money.sales ? 1 : 0) + (money.offer ? 1 : 0);
  const canEdit = userCan(user, 'CRATE_EDIT');
  const canPlace = userCan(user, 'LOADING_CONFIRM');
  const docs = canFirmDocs(user);
  const short = (c: FirmCol) => t(`loading.firm.short.${c}` as MsgKey);
  const head = (c: FirmCol) => <th key={c} className="num" scope="col" title={t(`loading.firm.cols.${c}` as MsgKey)}>{short(c)}</th>;
  // Misafir camın bilgisi (ev sahibinin sandık içeriğinde): sipariş no · sahibi · cam adedi · m² — tüm firmaların satırlarından
  const rowOf = new Map(firms.flatMap((f) => f.rows.map((r) => [r.entry.orderId, r] as const)));
  return (
    <div className={`table-wrap load-wrap firm-wrap${money.sales && money.offer ? ' firm-wrap-both' : ''}${docs ? ' firm-wrap-docs' : ''}`}>
      <table className="load-table firm-table">
        <thead>
          <tr>
            <th scope="col">{t('loading.firm.cols.firm')}</th>
            {FIRM_COLS.map(head)}
            {money.sales && head('factory')}
            {money.offer && head('offer')}
            {/* İşlemler sütununun başlığı yalnızca ekran okuyucuya (dar sütun: düğmeler sütunun genişliğini belirler) */}
            <th className="actions" scope="col"><span className="sr-only">{t('loading.firm.short.actions')}</span></th>
          </tr>
        </thead>
        {firms.map((f) => {
          const waiting = f.rows.filter((r) => r.guest?.waiting).length;
          const away = f.rows.filter((r) => r.guest);
          const hosts = [...new Set(away.map((r) => r.guest!.hostName))];
          const labels = [...new Set(f.rows.map((r) => r.entry.o.sandikEtiket ?? r.entry.o.customer.sandikEtiket ?? '').filter(Boolean))];
          return (
            <FirmRows
              key={f.id}
              id={f.id}
              name={f.name}
              cols={cols}
              to={docs ? firmUrls(day, f.id) : null}
              open={{ crates: sp.acik === f.id }}
              m={{
                toggle: t('loading.firm.toggle'), crates: t('loading.firm.actions.crates'), pdf: t('loading.firm.actions.pdf'), xlsx: t('loading.firm.actions.xlsx'),
                summary: t('loading.firm.actions.summary'), actions: t('loading.firm.short.actions'),
              }}
              badges={(
                <div className="firm-badges">
                  {/* Fiziksel sandık sahipliği (ticari sahiplik değişmez): bu firmanın başka firma sandığıyla giden siparişleri / bu firmanın sandıklarıyla giden misafir yük */}
                  {away.length > 0 && (
                    <span className="badge badge-info" data-guest-out={away.length} title={t('loading.firm.awayTitle', { hosts: hosts.join(', ') })}>
                      {t('loading.firm.away', { n: away.length, hosts: hosts.join(', ') })}
                    </span>
                  )}
                  {f.guestsIn.length > 0 && (
                    <span className="badge badge-warn" data-guest-in={f.guestsIn.length} title={f.guestsIn.map((g) => `${g.orderNo} · ${g.ownerName}`).join(', ')}>
                      {t('loading.firm.hosting', { n: f.guestsIn.length })}
                    </span>
                  )}
                  {waiting > 0 && <span className="badge badge-danger guest-badge">{t('loading.firm.waiting', { n: waiting })}</span>}
                  {labels.length > 0 && <span className="muted small">{t('loading.day.crates.label')}: <span className="mono">{labels.join(', ')}</span></span>}
                </div>
              )}
              cells={(
                <>
                  <td className="num" data-col="orders" data-label={short('orders')}>{f.orders}</td>
                  <td className="num" data-col="glass" data-label={short('glass')}>{f.camAdet}</td>
                  <td className="num" data-col="cnc" data-label={short('cnc')}>{dash(f.cnc)}</td>
                  <td className="num" data-col="holes" data-label={short('holes')}>{dash(f.delik)}</td>
                  <td className="num" data-col="m2" data-label={short('m2')}>{fmtM2(f.metraj)}</td>
                  <td className="num" data-col="net" data-label={short('net')}>{kg(f.netKg)}</td>
                  <td className="num" data-col="crates" data-label={short('crates')}>
                    {f.crates}{' '}
                    {f.realCrates ? <span className="badge badge-ok">{t('loading.day.real')}</span> : f.crates > 0 ? <span className="muted small">{t('loading.day.estimated')}</span> : null}
                  </td>
                  <td className="num" data-col="gross" data-label={short('gross')}>{kg(f.grossKg)}</td>
                  {money.sales && <td className="num" data-col="factory" data-label={short('factory')}>{amounts(f.money, 'sales')}</td>}
                  {money.offer && <td className="num" data-col="offer" data-label={short('offer')}>{amounts(f.money, 'offer')}</td>}
                </>
              )}
              orders={<FirmOrders firm={f} money={money} t={t} />}
              crates={<FirmCrates user={user} firm={f} day={day} dayCrates={dayCrates} rowOf={rowOf} canEdit={canEdit} canPlace={canPlace} t={t} m={m} />}
            />
          );
        })}
        <tfoot>
          <tr>
            <td className="firm-total">{t('common.total')}</td>
            <td className="num" data-col="orders" data-label={short('orders')}>{total.orders}</td>
            <td className="num" data-col="glass" data-label={short('glass')}>{total.camAdet}</td>
            <td className="num" data-col="cnc" data-label={short('cnc')}>{dash(total.cnc)}</td>
            <td className="num" data-col="holes" data-label={short('holes')}>{dash(total.delik)}</td>
            <td className="num" data-col="m2" data-label={short('m2')}>{fmtM2(total.metraj)}</td>
            <td className="num" data-col="net" data-label={short('net')}>{kg(total.netKg)}</td>
            <td className="num" data-col="crates" data-label={short('crates')}>{total.crates}</td>
            <td className="num" data-col="gross" data-label={short('gross')}>{kg(total.grossKg)}</td>
            {money.sales && <td className="num" data-col="factory" data-label={short('factory')}>{amounts(total.money, 'sales')}</td>}
            {money.offer && <td className="num" data-col="offer" data-label={short('offer')}>{amounts(total.money, 'offer')}</td>}
            <td className="firm-total-pad" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Siparişin satır rozetleri: durum, aktarılan kalan, yüklenmeyen adet */
function OrderBadges({ row, t, customer }: { row: Row; t: T; customer: boolean }) {
  const o = row.entry.o;
  const dmy = (k: string) => fmtDate(`${k}T12:00:00Z`);
  return (
    <>
      {customer
        ? <CustomerBadge status={o.status} drawing={o.drawingTrack} offer={o.offers.some((x) => x.status === 'GONDERILDI') ? 'GONDERILDI' : null} />
        : <OrderBadge status={o.status} onHold={o.onHold} />}
      {/* Aktarılmış kalan: satır siparişin tamamı değil, önceki yüklemede yüklenmeyen adet (karar 102) */}
      {o.replan && <> <span className="badge badge-warn replan-badge">{t('loading.replan.from', { date: dmy(o.replan.fromDay) })}</span></>}
      {o.notLoaded && (
        <> <span className="badge badge-warn replan-badge">
          {t('loading.replan.notLoadedBadge', { n: o.notLoaded.quantity })}{o.notLoaded.replanDays.map((d) => ` ${t('loading.replan.movedTo', { date: dmy(d) })}`).join('')}
        </span></>
      )}
    </>
  );
}

/** Firma satırı açılınca: alt siparişler. Toplam satırı ana satırla aynı işlevden (rowsTotal) — ana ve alt toplam eşittir. */
function FirmOrders({ firm, money, t }: { firm: DayFirm; money: MoneyView; t: T }) {
  const sub = rowsTotal(firm.rows);
  if (firm.rows.length === 0) return <p className="muted small">{t('loading.firm.noOrders')}</p>;
  const L = {
    glass: t('loading.firm.sub.glass'), cnc: t('loading.firm.sub.cnc'), holes: t('loading.firm.sub.holes'), m2: t('loading.firm.sub.m2'),
    factory: t('loading.firm.sub.factory'), offer: t('loading.firm.sub.offer'),
  };
  return (
    <table className="sub-table firm-orders-table">
      <thead>
        <tr>
          <th>{t('loading.firm.sub.order')}</th><th className="num">{L.glass}</th><th className="num">{L.cnc}</th>
          <th className="num">{L.holes}</th><th className="num">{L.m2}</th>
          {money.sales && <th className="num">{L.factory}</th>}
          {money.offer && <th className="num">{L.offer}</th>}
        </tr>
      </thead>
      <tbody>
        {firm.rows.map((r) => {
          const e = r.entry;
          return (
            <tr key={`${e.orderId}${e.replan ? ':r' : ''}`} data-order={e.orderId}>
              <td>
                <Link className="order-no" href={`/siparisler/${e.orderId}`}>{e.orderNo}</Link>{' '}
                <OrderBadges row={r} t={t} customer={false} />
                {e.o.title && <div className="muted small">{e.o.title}</div>}
                {/* Fiziksel sandık (yalnızca bilgi; ticari sahiplik bu firmada): kendi sandıkları / başka firmanın sandığı */}
                {r.crateNos.length > 0 && <div className="small crate-nos">{r.crateNos.map((n) => <span key={n} className="badge badge-ok">#{n}</span>)}</div>}
                {r.guest && (
                  <div className="small">
                    {r.guest.crateNo != null
                      ? <span className="badge badge-info guest-badge" title={t('loading.guest.badgeTitle', { no: r.guest.crateNo, host: r.guest.hostName })}>{t('loading.guest.badge', { no: r.guest.crateNo, host: r.guest.hostName })}</span>
                      : <span className="badge badge-danger guest-badge">{t('loading.guest.waitingBadge', { host: r.guest.hostName })}</span>}
                  </div>
                )}
              </td>
              <td className="num" data-label={L.glass}>{e.load.camAdet}</td>
              <td className="num" data-label={L.cnc}>{dash(e.load.cnc)}</td>
              <td className="num" data-label={L.holes}>{dash(e.load.delik)}</td>
              <td className="num" data-label={L.m2}>{fmtM2(e.load.metraj)}</td>
              {money.sales && <td className="num" data-label={L.factory}>{e.money.sales != null ? fmtMoney(e.money.sales, e.money.currency) : <span className="muted">—</span>}</td>}
              {money.offer && <td className="num" data-label={L.offer}>{e.money.offer != null ? fmtMoney(e.money.offer, e.money.currency) : <span className="muted">—</span>}</td>}
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>{t('loading.firm.sub.total', { n: sub.orders })}</td>
          <td className="num" data-label={L.glass}>{sub.camAdet}</td><td className="num" data-label={L.cnc}>{dash(sub.cnc)}</td>
          <td className="num" data-label={L.holes}>{dash(sub.delik)}</td><td className="num" data-label={L.m2}>{fmtM2(sub.metraj)}</td>
          {money.sales && <td className="num" data-label={L.factory}>{amounts(sub.money, 'sales')}</td>}
          {money.offer && <td className="num" data-label={L.offer}>{amounts(sub.money, 'offer')}</td>}
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * "Sandık": firmanın o günkü sandıkları. Misafir sipariş (başka firmanın sandığıyla giden) için açık uyarı; misafir sipariş bu
 * firmanın sandığına konamaz ve firmanın misafir olmayan siparişi yoksa "+ Sandık ekle" kapalıdır (sunucu da reddeder —
 * server/loading/crates.js → saveDayCrates). Ev sahibinin sandık listesinde misafir camın sipariş / cam bilgisi görünür.
 */
function FirmCrates({ user, firm, day, dayCrates, rowOf, canEdit, canPlace, t, m }: {
  user: CurrentUser; firm: DayFirm; day: string; dayCrates: CrateRow[]; rowOf: Map<string, Row>; canEdit: boolean; canPlace: boolean; t: T; m: Dict;
}) {
  const own = [...new Map(firm.rows.filter((r) => !r.guest).map((r) => [r.entry.orderId, { id: r.entry.orderId, orderNo: r.entry.orderNo }])).values()];
  const away = firm.rows.filter((r) => r.guest);
  const locked = firm.rows.length > 0 && own.length === 0;
  const ownIds = new Set(own.map((o) => o.id));
  const guestText = (orderId: string) => {
    const r = rowOf.get(orderId);
    return r ? t('loading.firm.guestLine', { order: r.entry.orderNo, owner: r.entry.customerName, glass: r.entry.load.camAdet, m2: fmtM2(r.entry.load.metraj) }) : '';
  };
  const guestsOf = (crateId: string) => firm.guestsIn.filter((g) => g.crateId === crateId).map((g) => guestText(g.orderId)).filter(Boolean);
  const last = [...firm.crateList].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  // Taşınan cam (tahmini ağırlığın sandıklara bölünmesi için): bu firmanın taşıdığı kendi siparişleri + misafir yük
  const carriedKg = [...rowOf.values()].filter((r) => r.carrierId === firm.id).reduce((s, r) => s + r.entry.load.netKg, 0);
  const others = dayCrates.filter((c) => c.customer && c.customer.id !== firm.id).map((c) => ({ no: c.crateNo, label: customerLabel(user, c.customer!.name) }));
  return (
    <div className="firm-crates-box" data-owner={firm.id}>
      {/* Misafir sipariş: bu firmanın sandığı açılmaz; cam ev sahibi firmanın sandığıyla gider (ad role göre maskeli) */}
      {away.map((r) => {
        const g = r.guest!;
        return (
          <form key={`${r.entry.orderId}:${g.crateId ?? ''}`} action={guestCrateAction} className="alert alert-warn guest-note" data-order={r.entry.orderId}>
            <span>
              <Link className="order-no" href={`/siparisler/${r.entry.orderId}`}>{r.entry.orderNo}</Link> — {t('loading.guest.travelsWith', { host: g.hostName })}{' '}
              {g.crateNo != null ? <Badge tone="info">{t('loading.guest.crateNo', { no: g.crateNo })}</Badge> : <Badge tone="danger">{g.hostHere ? t('loading.guest.waitingShort') : t('loading.guest.noHostLoad')}</Badge>}
            </span>
            {/* Eski kayıt (ev sahibi firma seçilmeden yapılmış yerleşim): yalnızca yönetici kaldırır */}
            {canPlace && g.crateId && !g.byHost && (
              <>
                <input type="hidden" name="day" value={day} />
                <input type="hidden" name="orderId" value={r.entry.orderId} />
                <input type="hidden" name="crateId" value={g.crateId} />
                <input type="hidden" name="acik" value={firm.id} />
                <ConfirmButton danger name="do" value="remove" message={t('loading.guest.removeDialog')}>{t('loading.guest.remove')}</ConfirmButton>
              </>
            )}
          </form>
        );
      })}
      {canEdit ? (
        <CrateEditor
          day={day}
          customerId={firm.id}
          orders={own}
          initial={firm.crateList.map((c) => ({
            crateNo: String(c.crateNo), lengthMm: c.lengthMm?.toString() ?? '', widthMm: c.widthMm?.toString() ?? '', heightMm: c.heightMm?.toString() ?? '',
            netKg: c.netAgirlik?.toString() ?? '', grossKg: c.brutAgirlik?.toString() ?? '', note: c.note ?? '',
            orderIds: (c.orderIds ?? []).filter((id) => ownIds.has(id)), guests: guestsOf(c.id),
          }))}
          locked={locked}
          dayUsed={others}
          glassKg={carriedKg}
          tare={CRATE_TARE_KG}
          updated={last ? t('loading.day.crates.updated', { when: fmtDateTime(last.updatedAt), who: last.updatedBy?.name ?? '—' }) : null}
          m={m.loading.day.crates}
        />
      ) : firm.crateList.length > 0 ? (
        <CrateList crates={firm.crateList} contents={(c) => [...(c.orderIds ?? []).filter((id) => rowOf.get(id)?.entry.customerId === firm.id).map((id) => rowOf.get(id)!.entry.orderNo), ...guestsOf(c.id)]} t={t} note />
      ) : <p className="muted small">{locked ? t('loading.firm.lockedNote') : t('loading.day.crates.readOnly')}</p>}
      {/* Ev sahibi (karar 124): bu firmanın sandıklarıyla gidecek başka firma siparişleri. Sandığı satış (CRATE_EDIT) seçer. */}
      {firm.guestsIn.length > 0 && (
        <div className="guest-box" data-owner={firm.id}>
          <p className="small guest-head"><b>{t('loading.guest.blockTitle')}</b></p>
          {firm.guestsIn.map((x) => (
            <form key={`in-${x.orderId}-${x.crateId ?? ''}`} action={guestCrateAction} className="row small guest-line guest-in" data-order={x.orderId}>
              <span><Link className="order-no" href={`/siparisler/${x.orderId}`}>{x.orderNo}</Link> · {x.ownerName}{rowOf.get(x.orderId) && <span className="muted"> · {t('loading.firm.guestGlass', { glass: rowOf.get(x.orderId)!.entry.load.camAdet, m2: fmtM2(rowOf.get(x.orderId)!.entry.load.metraj) })}</span>}</span>
              {canEdit && x.byHost ? (
                firm.crateList.length > 0 ? (
                  <>
                    <input type="hidden" name="day" value={day} />
                    <input type="hidden" name="orderId" value={x.orderId} />
                    <input type="hidden" name="current" value={x.crateId ?? ''} />
                    <input type="hidden" name="acik" value={firm.id} />
                    <label className="small">{t('loading.guest.crate')}{' '}
                      <select name="crateId" defaultValue={x.crateId ?? ''} aria-label={`${t('loading.guest.crate')} — ${x.orderNo}`}>
                        <option value="">{t('loading.guest.waitingOption')}</option>
                        {firm.crateList.map((c) => <option key={c.id} value={c.id}>{c.crateNo}</option>)}
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
        </div>
      )}
    </div>
  );
}

/** Salt okunur sandık listesi: no, uzunluk × genişlik × yükseklik, net, brüt, (not), içerik */
function CrateList({ crates, contents, t, note }: { crates: DayFirm['crateList']; contents?: (c: DayFirm['crateList'][number]) => string[]; t: T; note: boolean }) {
  return (
    <table className="crate-table readonly">
      <thead>
        <tr>
          <th>{t('loading.day.crates.cols.no')}</th><th>{t('loading.day.crates.cols.length')}</th><th>{t('loading.day.crates.cols.width')}</th><th>{t('loading.day.crates.cols.height')}</th>
          <th>{t('loading.day.crates.cols.net')}</th><th>{t('loading.day.crates.cols.gross')}</th>{note && <th>{t('loading.day.crates.cols.note')}</th>}
          {contents && <th>{t('loading.day.crates.cols.contents')}</th>}
        </tr>
      </thead>
      <tbody>
        {crates.map((c) => (
          <tr key={c.id}>
            <td>{c.crateNo}</td><td>{c.lengthMm ?? '—'}</td><td>{c.widthMm ?? '—'}</td><td>{c.heightMm ?? '—'}</td>
            <td>{c.netAgirlik != null ? kg(Number(c.netAgirlik)) : '—'}</td><td>{c.brutAgirlik != null ? kg(Number(c.brutAgirlik)) : '—'}</td>{note && <td>{c.note ?? ''}</td>}
            {contents && <td className="crate-contents">{contents(c).map((x) => <div key={x}>{x}</div>)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Müşteri: kendi siparişleri, (sandık girildiyse) kendi toplamı ve kendi sandıklarının ölçü / ağırlıkları. Sandıklar yalnızca bu
 * firmanınkidir (lib/loading.ts → cratesBetween); başka firmanın sandığındaki siparişi için yalnızca sandık numarası görünür.
 */
function CustomerDay({ firm, money, t }: { firm: DayFirm | undefined; money: MoneyView; t: T }) {
  if (!firm) return null;
  const span = 8 + (money.offer ? 1 : 0);
  return (
    <div className="table-wrap load-wrap">
      <table className="load-table">
        <thead>
          <tr>
            <th>{t('loading.day.cols.order')}</th>
            <th className="num">{t('loading.day.cols.glass')}</th><th className="num">{t('loading.day.cols.cnc')}</th><th className="num">{t('loading.day.cols.holes')}</th><th className="num">{t('loading.day.cols.metraj')}</th><th className="num">{t('loading.day.cols.net')}</th>
            <th className="num">{t('loading.day.cols.crates')}</th><th className="num">{t('loading.day.cols.gross')}</th>
            {money.offer && <th className="num">{t('loading.day.cols.amount')}</th>}
          </tr>
        </thead>
        <tbody>
          {firm.rows.map((r) => {
            const e = r.entry;
            return (
              <tr key={`${e.orderId}${e.replan ? ':r' : ''}`}>
                <td>
                  <Link className="order-no" href={`/siparisler/${e.orderId}`}>{e.orderNo}</Link>{' '}
                  <OrderBadges row={r} t={t} customer />
                  <div className="muted small">{e.o.title}</div>
                </td>
                <td className="num">{e.load.camAdet}</td>
                <td className="num">{dash(e.load.cnc)}</td>
                <td className="num">{dash(e.load.delik)}</td>
                <td className="num">{fmtM2(e.load.metraj)}</td>
                <td className="num">{kg(e.load.netKg)}</td>
                <td className="num">
                  {r.crateNos.length || r.guest?.crateNo != null
                    ? (
                      <span className="crate-nos" title={t('loading.day.real')}>
                        {r.crateNos.map((n) => <span key={n} className="badge badge-ok">#{n}</span>)}
                        {r.guest?.crateNo != null && <span className="badge badge-ok">#{r.guest.crateNo}</span>}
                      </span>
                    )
                    : firm.realCrates ? '' : <span className="muted">{t('loading.day.estimated')}</span>}
                </td>
                <td className="num"><span className="muted">—</span></td>
                {money.offer && <td className="num">{e.money.offer != null ? fmtMoney(e.money.offer, e.money.currency) : <span className="muted">—</span>}</td>}
              </tr>
            );
          })}
          {firm.crateList.length > 0 && (
            <tr className="group-total">
              <td><b className="group-name">{firm.name}</b></td>
              <td className="num">{firm.camAdet}</td><td className="num">{dash(firm.cnc)}</td><td className="num">{dash(firm.delik)}</td><td className="num">{fmtM2(firm.metraj)}</td><td className="num">{kg(firm.netKg)}</td>
              <td className="num">{firm.crates}{' '}<span className="badge badge-ok">{t('loading.day.real')}</span></td>
              <td className="num">{kg(firm.grossKg)}</td>
              {money.offer && <td className="num">{amounts(firm.money, 'offer')}</td>}
            </tr>
          )}
          {firm.crateList.length > 0 && (
            <tr className="crate-row">
              <td colSpan={span}>
                <details open>
                  <summary>{t('loading.day.crates.toggle')} · {t('loading.day.crates.count', { n: firm.crateList.length })}</summary>
                  <CrateList crates={firm.crateList} t={t} note={false} />
                </details>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>{t('common.total')}</td>
            <td className="num">{firm.camAdet}</td><td className="num">{dash(firm.cnc)}</td><td className="num">{dash(firm.delik)}</td><td className="num">{fmtM2(firm.metraj)}</td><td className="num">{kg(firm.netKg)}</td>
            <td className="num">{firm.crates}</td><td className="num">{kg(firm.grossKg)}</td>
            {money.offer && <td className="num">{amounts(firm.money, 'offer')}</td>}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
