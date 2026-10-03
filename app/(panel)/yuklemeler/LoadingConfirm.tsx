import Link from 'next/link';
import { db } from '@/lib/db';
import type { CurrentUser } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import { customerLabel } from '@/lib/orders';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { dayKey } from '@/server/orders/loading.js';
import { loadConfirmation, loadedDays, previewLoading, summarize } from '@/server/loading/confirmation.js';
import { confirmLoadingAction } from './actions';

type Money = Record<string, { sale: number; cost: number }>;
type GlassRow = { name: string; adet: number; m2: number; sale: number; cost: number };
type OrderRow = { orderId: string; orderNo: string; title: string | null; currency: string; glass: GlassRow[]; adet: number; m2: number; sale: number; cost: number; noCost: number };
type CustomerRow = { customerId: string; name: string; orders: OrderRow[]; adet: number; m2: number; byCur: Money };
type Summary = { customers: CustomerRow[]; totals: { orders: number; adet: number; m2: number; items: number; byCur: Money; noCost: number } };
type Skipped = { orderId: string; orderNo: string; reason: 'NO_SENT_OFFER' | 'ALREADY_CONFIRMED'; day?: string };

const ERRORS = ['FORBIDDEN', 'BAD_DAY', 'FUTURE_DAY', 'ALREADY_CONFIRMED', 'NOTHING_TO_CONFIRM', 'STALE_PREVIEW'];
const dmy = (day: string) => fmtDate(`${day}T12:00:00Z`);

/**
 * Yükleme onayı bölümü (Yüklemeler → gün ayrıntısı; iç ekip). Kurallar server/loading/confirmation.js'te.
 *   - Onaylanmış gün: onay anındaki kayıt (müşteri → sipariş → cam). Tutarlar yalnızca yöneticiye; satış / çizim müşteri
 *     adını maskeli görür.
 *   - Onaylanmamış gün: yalnızca yönetici önizlemeyi ve "Eksiksiz Yüklendi" düğmesini görür. Yetki sunucuda kontrol edilir.
 */
export async function LoadingConfirm({ user, day, planned, sp }: {
  user: CurrentUser; day: string; planned: { id: string; orderNo: string }[]; sp: Record<string, string | undefined>;
}) {
  const { t, locale } = await getT();
  const canConfirm = userCan(user, 'LOADING_CONFIRM');
  const money = userCan(user, 'ACCOUNTING_MANAGE');
  const nameOf = (l: { description: string; descriptionRo?: string | null }) => (locale === 'ro' && l.descriptionRo) || l.description;
  const confirmation = await loadConfirmation(db, day);
  if (!confirmation && !canConfirm) return null;

  const flash = (
    <>
      {sp.onay === 'ok' && <div className="alert alert-ok">{t('loading.confirm.ok', { orders: sp.n ?? '' })}</div>}
      {sp.onayHata && <div className="alert alert-error">{t(`loading.confirm.errors.${ERRORS.includes(sp.onayHata) ? sp.onayHata : 'STALE_PREVIEW'}` as MsgKey)}</div>}
    </>
  );
  const moneyLine = (byCur: Money) => Object.entries(byCur).map(([cur, v]) => t('loading.confirm.money', { sale: fmtNum(v.sale), cost: fmtNum(v.cost), cur })).join(' · ');
  const amounts = (byCur: Money, key: 'sale' | 'cost') => Object.entries(byCur).map(([cur, v]) => <div key={cur}>{fmtMoney(v[key], cur)}</div>);

  const table = (s: Summary) => (
    <div className="table-wrap load-wrap">
      <table className="load-table confirm-table">
        <thead>
          <tr>
            <th>{t('loading.confirm.cols.customerOrder')}</th>
            <th className="num">{t('loading.confirm.cols.pieces')}</th>
            <th className="num">{t('loading.confirm.cols.m2')}</th>
            {money && <th className="num">{t('loading.confirm.cols.sale')}</th>}
            {money && <th className="num">{t('loading.confirm.cols.cost')}</th>}
          </tr>
        </thead>
        <tbody>
          {s.customers.map((c) => (
            <CustomerRows key={c.customerId} c={c} label={customerLabel(user, c.name)} money={money} amounts={amounts} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t('loading.confirm.total')} · {t('loading.confirm.totalLine', { orders: s.totals.orders, pieces: s.totals.adet, m2: fmtNum(s.totals.m2) })}</td>
            <td className="num">{s.totals.adet}</td>
            <td className="num">{fmtNum(s.totals.m2)}</td>
            {money && <td className="num">{amounts(s.totals.byCur, 'sale')}</td>}
            {money && <td className="num">{amounts(s.totals.byCur, 'cost')}</td>}
          </tr>
        </tfoot>
      </table>
    </div>
  );

  // ---------- onaylanmış gün ----------
  if (confirmation) {
    const s = summarize(confirmation.orders, nameOf) as Summary;
    const inside = new Set(confirmation.orders.map((o: { orderId: string }) => o.orderId));
    const rest = planned.filter((p) => !inside.has(p.id));
    const elsewhere = await loadedDays(db, rest.map((p) => p.id));
    const outside = rest.filter((p) => !elsewhere.has(p.id));
    return (
      <div className="card" id="onay">
        <div className="section-head">
          <h2>{t('loading.confirm.title')} <Badge tone="ok">{t('loading.confirm.badgeDone')}</Badge></h2>
        </div>
        {flash}
        <p className="muted">{t('loading.confirm.doneIntro')}</p>
        <p className="confirm-by">
          <b>{t('loading.confirm.by', { who: confirmation.confirmedBy, when: fmtDateTime(confirmation.confirmedAt) })}</b>
          {confirmation.note && <span className="muted"> · {t('loading.confirm.note')}: {confirmation.note}</span>}
        </p>
        {money && <p className="small muted">{moneyLine(s.totals.byCur)}</p>}
        {money && s.totals.noCost > 0 && <div className="alert alert-warn">{t('loading.confirm.noCostDone', { n: s.totals.noCost })}</div>}
        {table(s)}
        {outside.length > 0 && (
          <div className="alert alert-warn confirm-outside">
            {t('loading.confirm.outside')}{' '}
            {outside.map((o, i) => <span key={o.id}>{i > 0 && ', '}<Link href={`/siparisler/${o.id}`}>{o.orderNo}</Link></span>)}
          </div>
        )}
      </div>
    );
  }

  // ---------- onaylanmamış gün (yalnızca yönetici) ----------
  const future = day > dayKey(new Date());
  if (future) {
    return (
      <div className="card" id="onay">
        <div className="section-head">
          <h2>{t('loading.confirm.title')} <Badge tone="muted">{t('loading.confirm.badgeOpen')}</Badge></h2>
        </div>
        {flash}
        <p className="muted">{t('loading.confirm.future')}</p>
      </div>
    );
  }
  const plan = await previewLoading(db, day);
  const s = summarize(plan.orders, nameOf) as Summary;
  const skipped = plan.skipped as Skipped[];
  return (
    <div className="card" id="onay">
      <div className="section-head">
        <h2>{t('loading.confirm.title')} <Badge tone="warn">{t('loading.confirm.badgeOpen')}</Badge></h2>
      </div>
      {flash}
      <p className="muted">{t('loading.confirm.previewIntro')}</p>
      {skipped.length > 0 && (
        <div className="alert alert-warn">
          {t('loading.confirm.skipped.title')}{' '}
          {skipped.map((x, i) => (
            <span key={x.orderId}>
              {i > 0 && ' · '}
              <Link href={`/siparisler/${x.orderId}`}>{x.orderNo}</Link>{' '}
              ({x.reason === 'ALREADY_CONFIRMED' ? t('loading.confirm.skipped.ALREADY_CONFIRMED', { date: dmy(x.day ?? day) }) : t('loading.confirm.skipped.NO_SENT_OFFER')})
            </span>
          ))}
        </div>
      )}
      {plan.items.length === 0 ? <p className="muted">{t('loading.confirm.nothing')}</p> : (
        <>
          {money && s.totals.noCost > 0 && (
            <div className="alert alert-warn">
              {t('loading.confirm.noCost', { n: s.totals.noCost })}{' '}
              <Link href="/admin/muhasebe/tedarikci#maliyet-eksik">{t('loading.confirm.noCostLink')}</Link>
            </div>
          )}
          {table(s)}
          <form action={confirmLoadingAction} className="tool-bar confirm-bar">
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="key" value={plan.key} />
            <div className="group confirm-note">
              <input name="note" maxLength={300} placeholder={t('loading.confirm.notePlaceholder')} aria-label={t('loading.confirm.note')} />
            </div>
            <div className="group">
              <ConfirmButton success message={t('loading.confirm.dialog', { date: dmy(day), orders: s.totals.orders, pieces: s.totals.adet, m2: fmtNum(s.totals.m2) })}>
                {t('loading.confirm.button')}
              </ConfirmButton>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function CustomerRows({ c, label, money, amounts }: { c: CustomerRow; label: string; money: boolean; amounts: (byCur: Money, key: 'sale' | 'cost') => React.ReactNode }) {
  return (
    <>
      <tr className="group-total">
        <td><b className="group-name">{label}</b></td>
        <td className="num">{c.adet}</td>
        <td className="num">{fmtNum(c.m2)}</td>
        {money && <td className="num">{amounts(c.byCur, 'sale')}</td>}
        {money && <td className="num">{amounts(c.byCur, 'cost')}</td>}
      </tr>
      {c.orders.map((o) => (
        <OrderRows key={o.orderId} o={o} money={money} />
      ))}
    </>
  );
}

function OrderRows({ o, money }: { o: OrderRow; money: boolean }) {
  return (
    <>
      <tr className="sub">
        <td>
          <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>
          {o.title && <span className="muted small"> · {o.title}</span>}
        </td>
        <td className="num">{o.adet}</td>
        <td className="num">{fmtNum(o.m2)}</td>
        {money && <td className="num">{fmtMoney(o.sale, o.currency)}</td>}
        {money && <td className="num">{fmtMoney(o.cost, o.currency)}</td>}
      </tr>
      {o.glass.map((g) => (
        <tr className="sub glass-row" key={g.name}>
          <td>{g.name}</td>
          <td className="num">{g.adet}</td>
          <td className="num">{fmtNum(g.m2)}</td>
          {money && <td className="num">{fmtNum(g.sale)}</td>}
          {money && <td className="num">{fmtNum(g.cost)}</td>}
        </tr>
      ))}
    </>
  );
}
