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
import { isGlassLine, itemKey, loadConfirmation, loadedDays, previewLoading, summarize } from '@/server/loading/confirmation.js';
import { NOT_LOADED_REASONS, notLoadedOfDay } from '@/server/loading/replan.js';
import { cancelReplanAction, confirmLoadingAction, replanAction } from './actions';

type Money = Record<string, { sale: number; cost: number }>;
type GlassRow = { name: string; adet: number; m2: number; sale: number; cost: number };
type OrderRow = { orderId: string; orderNo: string; title: string | null; currency: string; glass: GlassRow[]; adet: number; m2: number; sale: number; cost: number; noCost: number; replanFrom: string[] };
type CustomerRow = { customerId: string; name: string; orders: OrderRow[]; adet: number; m2: number; byCur: Money };
type Summary = { customers: CustomerRow[]; totals: { orders: number; adet: number; m2: number; items: number; byCur: Money; noCost: number } };
type Skipped = { orderId: string; orderNo: string; reason: 'NO_SENT_OFFER' | 'ALREADY_CONFIRMED' | 'ORDER_CANCELLED' | 'ORDER_ON_HOLD'; day?: string };
/** Önizlemedeki cam satırı (yüklenmeyen adet girişi için) */
type PlanItem = { orderId: string; offerLineId: string | null; replanId?: string; kind: string; unit: string; description: string; descriptionRo: string | null; enMm: number | null; boyMm: number | null; quantity: number };
type PlanOrder = { orderId: string; orderNo: string; customerName: string; items: PlanItem[]; replanFrom?: string[] };

const ERRORS = ['FORBIDDEN', 'BAD_DAY', 'FUTURE_DAY', 'ALREADY_CONFIRMED', 'NOTHING_TO_CONFIRM', 'STALE_PREVIEW', 'BAD_EXCEPTION', 'BAD_QUANTITY', 'BAD_REASON', 'NOTE_REQUIRED'];
const REPLAN_ERRORS = ['FORBIDDEN', 'BAD_DAY', 'NOT_FUTURE', 'NOT_FOUND', 'NOT_ALLOWED', 'BAD_QUANTITY', 'ORDER_CANCELLED', 'ORDER_ON_HOLD', 'DAY_CONFIRMED', 'ALREADY_LOADED', 'ALREADY_PLANNED'];
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
      {sp.onay === 'ok' && sp.yok && <div className="alert alert-warn">{t('loading.confirm.partial', { n: sp.yok })}</div>}
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
            <CustomerRows key={c.customerId} c={c} label={customerLabel(user, c.name)} money={money} amounts={amounts} from={(d) => t('loading.replan.from', { date: dmy(d) })} />
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
    const missing = await notLoadedOfDay(db, day);
    const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
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
        {/* Yüklenmeyen camlar (karar 102): onay kaydı değişmez; kalan ileri bir güne aktarılır. Aktarım yalnızca yöneticide. */}
        {missing.length > 0 && (
          <div id="yuklenmeyen" className="nl-box">
            <h3>{t('loading.replan.title')}</h3>
            <p className="muted small">{t('loading.replan.intro')}</p>
            {sp.aktar && <div className="alert alert-ok">{t(`loading.replan.ok.${['planned', 'moved', 'cancelled'].includes(sp.aktar) ? sp.aktar : 'planned'}` as MsgKey)}</div>}
            {sp.aktarHata && <div className="alert alert-error">{t(`loading.replan.errors.${REPLAN_ERRORS.includes(sp.aktarHata) ? sp.aktarHata : 'NOT_ALLOWED'}` as MsgKey)}</div>}
            <div className="table-wrap load-wrap">
              <table className="load-table nl-table">
                <thead>
                  <tr>
                    <th>{t('loading.replan.cols.order')}</th><th>{t('loading.replan.cols.glass')}</th>
                    <th className="num">{t('loading.replan.cols.planned')}</th><th className="num">{t('loading.replan.cols.loaded')}</th><th className="num">{t('loading.replan.cols.remaining')}</th>
                    <th>{t('loading.replan.cols.reason')}</th><th>{t('loading.replan.cols.next')}</th>
                  </tr>
                </thead>
                <tbody>
                  {missing.map((r) => {
                    const glass = nameOf({ description: r.glass, descriptionRo: r.glassRo });
                    const reason = t(`loading.replan.reasons.${r.reason && NOT_LOADED_REASONS.includes(r.reason) ? r.reason : 'OTHER'}` as MsgKey);
                    const done = r.replan?.status === 'CONFIRMED';
                    return (
                      <tr key={r.itemId} data-item={r.itemId}>
                        <td>
                          <Link className="order-no" href={`/siparisler/${r.orderId}`}>{r.orderNo}</Link>
                          <div className="muted small">{customerLabel(user, r.customerName)}</div>
                          {r.origin && <span className="badge badge-warn">{t('loading.replan.from', { date: dmy(r.origin) })}</span>}
                        </td>
                        <td>{glass}{r.enMm && r.boyMm ? <span className="muted small"> · {r.enMm} × {r.boyMm}</span> : null}</td>
                        <td className="num">{r.planned}</td>
                        <td className="num">{r.loaded}</td>
                        <td className="num"><b>{r.remaining}</b></td>
                        <td>{reason}{r.note && <div className="muted small">{r.note}</div>}</td>
                        <td className="nl-next">
                          {r.replan && (
                            <Link href={`/yuklemeler?gun=${r.replan.day}`} className={`badge ${done ? 'badge-ok' : 'badge-info'}`}>
                              {done
                                ? r.replan.notLoaded > 0 ? t('loading.replan.doneRest', { date: dmy(r.replan.day), loaded: r.replan.loaded, rest: r.replan.notLoaded }) : t('loading.replan.done', { date: dmy(r.replan.day), loaded: r.replan.loaded })
                                : t('loading.replan.planned', { date: dmy(r.replan.day) })}
                            </Link>
                          )}
                          {!r.replan && <span className="muted">{t('loading.replan.none')}</span>}
                          {r.blocked && <span className="muted small"> · {t(`loading.replan.blocked.${r.blocked}` as MsgKey)}</span>}
                          {canConfirm && !done && !r.blocked && (
                            <form action={replanAction} className="row nl-form">
                              <input type="hidden" name="day" value={day} />
                              <input type="hidden" name="itemId" value={r.itemId} />
                              <input type="hidden" name="quantity" value={r.remaining} />
                              <input type="date" name="newDay" required min={tomorrow} aria-label={`${t('loading.replan.newDay')} (${r.orderNo})`} />
                              <ConfirmButton primary message={t('loading.replan.dialog', { order: r.orderNo, glass, planned: r.planned, loaded: r.loaded, remaining: r.remaining, reason, date: dmy(day) })}>
                                {r.replan ? t('loading.replan.move') : t('loading.replan.button')}
                              </ConfirmButton>
                            </form>
                          )}
                          {canConfirm && r.replan && !done && (
                            <form action={cancelReplanAction}>
                              <input type="hidden" name="day" value={day} />
                              <input type="hidden" name="replanId" value={r.replan.id} />
                              <ConfirmButton danger message={t('loading.replan.cancelDialog')}>{t('loading.replan.cancel')}</ConfirmButton>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
              ({x.reason === 'ALREADY_CONFIRMED' ? t('loading.confirm.skipped.ALREADY_CONFIRMED', { date: dmy(x.day ?? day) }) : t(`loading.confirm.skipped.${x.reason}` as MsgKey)})
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
          <form action={confirmLoadingAction}>
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="key" value={plan.key} />
            {/* Yüklenmeyen cam (kırık / eksik / hazır değil — karar 102): cam satırı başına yüklenmeyen adet ve neden.
                Boş bırakılan satır eksiksiz yüklenmiş sayılır; sunucu adedi ve nedeni yeniden doğrular. */}
            <details className="nl-box nl-entry" id="yuklenmeyen-giris">
              <summary>{t('loading.replan.entry.toggle')}</summary>
              <p className="muted small">{t('loading.replan.entry.intro')}</p>
              <div className="table-wrap load-wrap">
                <table className="load-table nl-table">
                  <thead>
                    <tr>
                      <th>{t('loading.replan.entry.cols.order')}</th><th>{t('loading.replan.entry.cols.glass')}</th><th className="num">{t('loading.replan.entry.cols.planned')}</th>
                      <th>{t('loading.replan.entry.cols.qty')}</th><th>{t('loading.replan.entry.cols.reason')}</th><th>{t('loading.replan.entry.cols.note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(plan.orders as PlanOrder[]).flatMap((o) => o.items.filter((i) => isGlassLine(i)).map((i) => {
                      const k = itemKey(i);
                      return (
                        <tr key={k} data-key={k}>
                          <td>
                            <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>
                            <div className="muted small">{customerLabel(user, o.customerName)}</div>
                          </td>
                          <td>{nameOf(i)}{i.enMm && i.boyMm ? <span className="muted small"> · {i.enMm} × {i.boyMm}</span> : null}</td>
                          <td className="num">{i.quantity}</td>
                          <td><input type="number" name={`nl:${k}`} min={0} max={i.quantity} step={1} inputMode="numeric" className="nl-qty" aria-label={`${t('loading.replan.entry.cols.qty')} (${o.orderNo})`} /></td>
                          <td>
                            <select name={`nlr:${k}`} defaultValue="" aria-label={`${t('loading.replan.entry.cols.reason')} (${o.orderNo})`}>
                              <option value="">{t('loading.replan.entry.pick')}</option>
                              {NOT_LOADED_REASONS.map((r) => <option key={r} value={r}>{t(`loading.replan.reasons.${r}` as MsgKey)}</option>)}
                            </select>
                          </td>
                          <td><input name={`nln:${k}`} maxLength={200} aria-label={`${t('loading.replan.entry.cols.note')} (${o.orderNo})`} /></td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className="tool-bar confirm-bar">
              <div className="group confirm-note">
                <input name="note" maxLength={300} placeholder={t('loading.confirm.notePlaceholder')} aria-label={t('loading.confirm.note')} />
              </div>
              <div className="group">
                <ConfirmButton success message={t('loading.confirm.dialog', { date: dmy(day), orders: s.totals.orders, pieces: s.totals.adet, m2: fmtNum(s.totals.m2) })}>
                  {t('loading.confirm.button')}
                </ConfirmButton>
              </div>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function CustomerRows({ c, label, money, amounts, from }: { c: CustomerRow; label: string; money: boolean; amounts: (byCur: Money, key: 'sale' | 'cost') => React.ReactNode; from: (day: string) => string }) {
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
        <OrderRows key={o.orderId} o={o} money={money} from={from} />
      ))}
    </>
  );
}

function OrderRows({ o, money, from }: { o: OrderRow; money: boolean; from: (day: string) => string }) {
  return (
    <>
      <tr className="sub">
        <td>
          <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>
          {o.title && <span className="muted small"> · {o.title}</span>}
          {/* Aktarılmış kalan: siparişin tamamı değil, önceki yüklemede yüklenmeyen adet */}
          {o.replanFrom.map((d) => <span key={d} className="badge badge-warn replan-badge">{from(d)}</span>)}
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
