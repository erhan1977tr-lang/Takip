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
import { planCorrection, unpackCorrection } from '@/server/loading/correction.js';
import { cancelReplanAction, confirmLoadingAction, correctLoadingAction, previewCorrectionAction, replanAction } from './actions';
import { ImpactNote, type Impact } from './ImpactNote';

type Money = Record<string, { sale: number; cost: number }>;
type GlassRow = { name: string; adet: number; m2: number; sale: number; cost: number };
type OrderRow = { orderId: string; orderNo: string; title: string | null; currency: string; glass: GlassRow[]; adet: number; m2: number; sale: number; cost: number; noCost: number; replanFrom: string[] };
type CustomerRow = { customerId: string; name: string; orders: OrderRow[]; adet: number; m2: number; byCur: Money };
type Summary = { customers: CustomerRow[]; totals: { orders: number; adet: number; m2: number; items: number; byCur: Money; noCost: number } };
type Skipped = { orderId: string; orderNo: string; reason: 'NO_SENT_OFFER' | 'ALREADY_CONFIRMED' | 'ORDER_CANCELLED' | 'ORDER_ON_HOLD'; day?: string };

const ERRORS = ['FORBIDDEN', 'BAD_DAY', 'FUTURE_DAY', 'ALREADY_CONFIRMED', 'NOTHING_TO_CONFIRM', 'STALE_PREVIEW', 'BAD_EXCEPTION', 'BAD_QUANTITY', 'BAD_REASON', 'NOTE_REQUIRED'];
const REPLAN_ERRORS = ['FORBIDDEN', 'BAD_DAY', 'NOT_FUTURE', 'NOT_FOUND', 'NOT_ALLOWED', 'BAD_QUANTITY', 'NO_REMAINDER', 'ORDER_CANCELLED', 'ORDER_ON_HOLD', 'DAY_CONFIRMED', 'ALREADY_LOADED', 'ALREADY_PLANNED'];
const CORRECT_ERRORS = ['FORBIDDEN', 'BAD_DAY', 'REASON_REQUIRED', 'NOT_CONFIRMED', 'BAD_EXCEPTION', 'BAD_QUANTITY', 'BAD_REASON', 'NOTE_REQUIRED', 'NO_CHANGE', 'DOWNSTREAM_CONFLICT', 'QUEUED_BILLING', 'FAILED_BILLING', 'STALE_PREVIEW'];
/** Onay kalemi (geçerli durum) — düzeltme formu için */
type ConfItem = { orderId: string; offerLineId: string | null; replanId: string | null; kind: string; unit: string; description: string; descriptionRo: string | null; enMm: number | null; boyMm: number | null; quantity: number; status: string; notLoadedReason: string | null; notLoadedNote: string | null };
type ConfOrder = { orderId: string; orderNo: string; customerName: string; items: ConfItem[] };
const dmy = (day: string) => fmtDate(`${day}T12:00:00Z`);

/**
 * Yükleme onayı bölümü (Yüklemeler → gün ayrıntısı; iç ekip). Kurallar server/loading/confirmation.js'te.
 *   - Onaylanmış gün: GEÇERLİ durum (müşteri → sipariş → cam; düzeltmeler uygulanmış — karar 105) + "Düzeltildi" rozeti ve
 *     tarihçe (ilk onay kaydı ve her düzeltme: kim, ne zaman, neden, önce → sonra). İlk onay kaydı değişmez. Tutarlar
 *     yalnızca yöneticiye; satış / çizim müşteri adını maskeli görür. "Düzelt" ve aktarım yalnızca yöneticide.
 *   - Onaylanmamış gün: yalnızca yönetici önizlemeyi ve "Yükleme yapıldı" düğmesini görür (Paket 7, karar 189 — eski adı
 *     "Eksiksiz Yüklendi"; yüklenmeyen cam girişi yok: onaydan sonra "Düzelt"). Yetki sunucuda kontrol edilir.
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
    const split = (x: { loaded: number; notLoaded: number }) => t('loading.correct.split', { loaded: x.loaded, notLoaded: x.notLoaded });
    const glassOf = (x: { description: string; descriptionRo: string | null; enMm: number | null; boyMm: number | null }) => `${nameOf(x)}${x.enMm && x.boyMm ? ` · ${x.enMm} × ${x.boyMm}` : ''}`;
    // Düzeltme önizlemesi (yalnızca yönetici): adres çubuğundaki girdi sunucuda yeniden hesaplanır; hiçbir şey yazılmaz
    const draft = canConfirm && sp.dz ? await planCorrection(db, { day, input: unpackCorrection(sp.dz) }) : null;
    // Düzeltme formu: geçerli durumdaki cam kapsamları (yüklenen + yüklenmeyen)
    const scopes = canConfirm ? (confirmation.orders as ConfOrder[]).flatMap((o) => {
      const byKey = new Map<string, ConfItem[]>();
      for (const i of o.items.filter((x) => isGlassLine(x))) byKey.set(itemKey(i), [...(byKey.get(itemKey(i)) ?? []), i]);
      return [...byKey.entries()].map(([key, rows]) => {
        const nl = rows.find((r) => r.status === 'NOT_LOADED') ?? null;
        return { key, order: o, base: rows[0], total: rows.reduce((n, r) => n + r.quantity, 0), notLoaded: nl?.quantity ?? 0, reason: nl?.notLoadedReason ?? '', note: nl?.notLoadedNote ?? '' };
      });
    }) : [];
    return (
      <div className="card" id="onay">
        <div className="section-head">
          <h2>
            {t('loading.confirm.title')} <Badge tone="ok">{t('loading.confirm.badgeDone')}</Badge>
            {confirmation.revision > 0 && <> <Badge tone="warn">{t('loading.correct.badge')} #{confirmation.revision}</Badge></>}
          </h2>
        </div>
        {flash}
        {sp.duzeltme === 'ok' && <div className="alert alert-ok">{t('loading.correct.ok', { n: sp.rev ?? '' })}</div>}
        {sp.duzeltme === 'ok' && sp.muh && <div className="alert alert-error">{t('loading.correct.okAccounting')}</div>}
        <p className="muted">{t('loading.confirm.doneIntro')}</p>
        {confirmation.revision > 0 && <div className="alert alert-info" id="gecerli-durum">{t('loading.correct.effective', { n: confirmation.revision })}</div>}
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
        {/* Düzeltme tarihçesi (karar 105): ilk onay kaydı ve her düzeltme — kim, ne zaman, neden, önce → sonra */}
        {confirmation.revision > 0 && confirmation.original && (
          <details className="nl-box" id="duzeltme-gecmisi">
            <summary>{t('loading.correct.history.title')}</summary>
            <h3>{t('loading.correct.history.original', { who: confirmation.confirmedBy, when: fmtDateTime(confirmation.confirmedAt) })}</h3>
            {table(summarize(confirmation.original, nameOf) as Summary)}
            {confirmation.corrections.map((c) => (
              <div key={c.revision} className="correction-rev" data-revision={c.revision}>
                <h3>{t('loading.correct.history.revision', { n: c.revision, who: c.by, when: fmtDateTime(c.at) })}</h3>
                <p className="small">{t('loading.correct.history.reason', { reason: c.reason })}</p>
                <ul className="small">
                  {c.changes.map((x) => (
                    <li key={x.key}>
                      <Link className="order-no" href={`/siparisler/${x.orderId}`}>{x.orderNo}</Link> <span className="muted">({customerLabel(user, x.customerName)})</span> · {glassOf(x)}:{' '}
                      {split(x.before)} → <b>{split(x.after)}</b>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
        )}
        {/* Düzelt (yalnızca yönetici): giriş → önizleme (önce / sonra, aktarımlar, finansal etki) → kayıt. Onay değişmez. */}
        {canConfirm && (
          <div id="duzelt" className="nl-box">
            {sp.duzeltHata && <div className="alert alert-error">{t(`loading.correct.errors.${CORRECT_ERRORS.includes(sp.duzeltHata) ? sp.duzeltHata : 'STALE_PREVIEW'}` as MsgKey)}</div>}
            {draft?.ok ? (
              <div id="duzelt-onizleme">
                <h3>{t('loading.correct.previewTitle', { n: draft.revision })}</h3>
                <p className="muted small">{t('loading.correct.previewIntro')}</p>
                <div className="table-wrap load-wrap">
                  <table className="load-table nl-table">
                    <thead>
                      <tr>
                        <th>{t('loading.correct.cols.order')}</th><th>{t('loading.correct.cols.glass')}</th><th className="num">{t('loading.correct.cols.total')}</th>
                        <th>{t('loading.correct.before')}</th><th>{t('loading.correct.after')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.changes.map((x) => (
                        <tr key={x.key} data-key={x.key}>
                          <td>
                            <Link className="order-no" href={`/siparisler/${x.orderId}`}>{x.orderNo}</Link>
                            <div className="muted small">{customerLabel(user, x.customerName)}</div>
                          </td>
                          <td>{glassOf(x)}</td>
                          <td className="num">{x.total}</td>
                          <td>{split(x.before)}</td>
                          <td>
                            <b>{split(x.after)}</b>
                            {x.after.reason && <div className="muted small">{t(`loading.replan.reasons.${NOT_LOADED_REASONS.includes(x.after.reason) ? x.after.reason : 'OTHER'}` as MsgKey)}{x.after.note ? ` · ${x.after.note}` : ''}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>{t('loading.correct.replansTitle')}</h3>
                {draft.closing.length === 0 && draft.conflicts.length === 0 && <p className="muted small">{t('loading.correct.replansNone')}</p>}
                <ul className="small">
                  {draft.closing.map((r) => <li key={r.id}>{t('loading.correct.replanLine', { order: r.orderNo, qty: r.quantity, date: dmy(r.day) })}</li>)}
                  {draft.conflicts.map((r) => <li key={r.key}><b>{t('loading.correct.conflictLine', { order: r.orderNo, qty: r.confirmed, dates: r.days.map(dmy).join(', ') })}</b></li>)}
                </ul>
                <h3>{t('loading.correct.impactTitle')}</h3>
                {(draft.impacts as Impact[]).map((x) => <ImpactNote key={x.orderId} x={x} t={t} money={money} />)}
                {draft.blocked ? (
                  <>
                    <div className="alert alert-error" id="duzelt-engel">{t(`loading.correct.blocked.${draft.blocked}` as MsgKey)}</div>
                    <Link className="btn" href={`/yuklemeler?gun=${day}#duzelt`}>{t('loading.correct.back')}</Link>
                  </>
                ) : (
                  <form action={correctLoadingAction} className="tool-bar confirm-bar">
                    <input type="hidden" name="day" value={day} />
                    <input type="hidden" name="dz" value={sp.dz ?? ''} />
                    <input type="hidden" name="key" value={draft.key} />
                    <div className="group confirm-note">
                      <input name="reason" required minLength={3} maxLength={500} defaultValue={sp.dzn ?? ''} placeholder={t('loading.correct.reasonLabel')} aria-label={t('loading.correct.reasonLabel')} />
                    </div>
                    <div className="group">
                      <Link className="btn" href={`/yuklemeler?gun=${day}#duzelt`}>{t('loading.correct.back')}</Link>
                      <ConfirmButton primary message={t('loading.correct.dialog', { date: dmy(day), n: draft.revision })}>{t('loading.correct.save')}</ConfirmButton>
                    </div>
                  </form>
                )}
              </div>
            ) : scopes.length > 0 && (
              <details className="nl-entry" id="duzelt-giris">
                <summary>{t('loading.correct.button')}</summary>
                <p className="muted small">{t('loading.correct.intro')}</p>
                <form action={previewCorrectionAction}>
                  <input type="hidden" name="day" value={day} />
                  <div className="table-wrap load-wrap">
                    <table className="load-table nl-table">
                      <thead>
                        <tr>
                          <th>{t('loading.correct.cols.order')}</th><th>{t('loading.correct.cols.glass')}</th><th className="num">{t('loading.correct.cols.total')}</th>
                          <th className="num">{t('loading.correct.cols.loaded')}</th><th className="num">{t('loading.correct.cols.notLoaded')}</th>
                          <th>{t('loading.correct.cols.newQty')}</th><th>{t('loading.correct.cols.reason')}</th><th>{t('loading.correct.cols.note')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scopes.map((x) => (
                          <tr key={x.key} data-key={x.key}>
                            <td>
                              <Link className="order-no" href={`/siparisler/${x.order.orderId}`}>{x.order.orderNo}</Link>
                              <div className="muted small">{customerLabel(user, x.order.customerName)}</div>
                            </td>
                            <td>{glassOf(x.base)}</td>
                            <td className="num">{x.total}</td>
                            <td className="num">{x.total - x.notLoaded}</td>
                            <td className="num">{x.notLoaded}</td>
                            <td><input type="number" name={`cq:${x.key}`} min={0} max={x.total} step={1} inputMode="numeric" className="nl-qty" defaultValue={x.notLoaded} aria-label={`${t('loading.correct.cols.newQty')} (${x.order.orderNo})`} /></td>
                            <td>
                              <select name={`cr:${x.key}`} defaultValue={x.reason} aria-label={`${t('loading.correct.cols.reason')} (${x.order.orderNo})`}>
                                <option value="">{t('loading.replan.entry.pick')}</option>
                                {NOT_LOADED_REASONS.map((r) => <option key={r} value={r}>{t(`loading.replan.reasons.${r}` as MsgKey)}</option>)}
                              </select>
                            </td>
                            <td><input name={`cn:${x.key}`} maxLength={200} defaultValue={x.note} aria-label={`${t('loading.correct.cols.note')} (${x.order.orderNo})`} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="tool-bar confirm-bar">
                    <div className="group confirm-note">
                      <input name="reason" required minLength={3} maxLength={500} placeholder={t('loading.correct.reasonLabel')} aria-label={t('loading.correct.reasonLabel')} />
                    </div>
                    <div className="group"><button className="btn btn-primary">{t('loading.correct.preview')}</button></div>
                  </div>
                </form>
              </details>
            )}
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
                          {/* Kısmi aktarım (karar 106): kalanın her aktarımı ayrı satır (adet → gün); aktarılmamış adet ayrıca */}
                          {r.replans.map((p) => {
                            const done = p.status === 'CONFIRMED';
                            return (
                              <div key={p.id} className="nl-replan" data-replan={p.id}>
                                <Link href={`/yuklemeler?gun=${p.day}`} className={`badge ${done ? 'badge-ok' : 'badge-info'}`}>
                                  {done
                                    ? p.notLoaded > 0 ? t('loading.replan.doneRest', { date: dmy(p.day), loaded: p.loaded, rest: p.notLoaded }) : t('loading.replan.done', { date: dmy(p.day), loaded: p.loaded })
                                    : t('loading.replan.planned', { qty: p.quantity, date: dmy(p.day) })}
                                </Link>
                                {canConfirm && !done && !r.blocked && (
                                  <form action={replanAction} className="row nl-form">
                                    <input type="hidden" name="day" value={day} />
                                    <input type="hidden" name="itemId" value={r.itemId} />
                                    <input type="hidden" name="replanId" value={p.id} />
                                    <input type="date" name="newDay" required min={tomorrow} aria-label={`${t('loading.replan.newDay')} (${r.orderNo} · ${p.quantity})`} />
                                    <ConfirmButton message={t('loading.replan.moveDialog', { order: r.orderNo, glass, qty: p.quantity })}>{t('loading.replan.move')}</ConfirmButton>
                                  </form>
                                )}
                                {canConfirm && !done && (
                                  <form action={cancelReplanAction}>
                                    <input type="hidden" name="day" value={day} />
                                    <input type="hidden" name="replanId" value={p.id} />
                                    <ConfirmButton danger message={t('loading.replan.cancelDialog')}>{t('loading.replan.cancel')}</ConfirmButton>
                                  </form>
                                )}
                              </div>
                            );
                          })}
                          {r.replans.length === 0 && <span className="muted">{t('loading.replan.none')}</span>}
                          {r.replans.length > 0 && r.free > 0 && <div className="muted small nl-free">{t('loading.replan.free', { n: r.free })}</div>}
                          {r.blocked && <span className="muted small"> · {t(`loading.replan.blocked.${r.blocked}` as MsgKey)}</span>}
                          {canConfirm && r.free > 0 && !r.blocked && (
                            <form action={replanAction} className="row nl-form nl-new">
                              <input type="hidden" name="day" value={day} />
                              <input type="hidden" name="itemId" value={r.itemId} />
                              <input type="number" name="quantity" required min={1} max={r.free} step={1} defaultValue={r.free} inputMode="numeric" className="nl-qty" aria-label={`${t('loading.replan.qty')} (${r.orderNo})`} />
                              <input type="date" name="newDay" required min={tomorrow} aria-label={`${t('loading.replan.newDay')} (${r.orderNo})`} />
                              <ConfirmButton primary message={t('loading.replan.dialog', { order: r.orderNo, glass, planned: r.planned, loaded: r.loaded, remaining: r.remaining, free: r.free, reason, date: dmy(day) })}>
                                {t('loading.replan.button')}
                              </ConfirmButton>
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
          {/* "Yükleme yapıldı" (Paket 7, karar 189): önizlemedeki kalemler YÜKLENDİ olarak kaydedilir. Ayrı "yüklenmeyen cam"
              girişi yoktur — yüklenmeyen cam onaydan sonra "Düzelt" ile kaydedilir (karar 105) ve ileri güne aktarılır. */}
          <form action={confirmLoadingAction}>
            <input type="hidden" name="day" value={day} />
            <input type="hidden" name="key" value={plan.key} />
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
