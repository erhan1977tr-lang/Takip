import crypto from 'node:crypto';
import Link from 'next/link';
import { db } from '@/lib/db';
import type { CurrentUser } from '@/lib/auth/session';
import { customerLabel, type OrderDetail } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import type { Dict, MsgKey, T } from '@/lib/i18n';
import { profileCustomerText, profileStageText } from '@/lib/labels';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FxInfo } from '@/components/FxInfo';
import { fxOfferNote } from '@/lib/fx-note';
import { padRate } from '@/server/fx/decimal.js';
import { OrderInfo } from './OrderInfo';
import { BEFORE_WAREHOUSE, PROFILE_STAGES, PROFILE_STAGE_TONE, PICKUP_EDITABLE, profileActions, profileTotals } from '@/server/profile/rules.js';
import { DEPOT_CALENDAR, depotPhase, depotToday, earliestPickup, localDay, dayDate } from '@/server/profile/dates.js';
import { calendarOverrides } from '@/server/calendar/service.js';
import { coverageGaps, hasYearData } from '@/server/calendar/rules.js';
import { DELIVERY_DOC_STAGES, takesDeliveryDocs } from '@/server/delivery/rules.js';
import { deliveryDocs } from '@/server/delivery/service.js';
import { DeliveryPhotoUpload } from '@/components/DeliveryPhotoUpload';
import { unitLabel } from '@/server/profile/catalog.js';
import { STOCK_SHORTAGE_ALERT, customerShortageView, stockLevels } from '@/server/profile/stock.js';
import { profilePricesFor } from '@/server/profile/pricing.js';
import { getEnv } from '@/server/env.js';
import { FgoDocLink } from '@/components/FgoDocLink';
import {
  approveProfileAction, cancelProfileAction, deliveredAction, deliveryPhotoAction, deliveryReportAction, invoicedAction, paidAction,
  profilePricesAction, proformaAction, resendWarehouseAction, retryFgoAction, updatePickupAction, warehouseAction,
} from './profile-actions';

type Offer = OrderDetail['offers'][number];
type Line = Offer['lines'][number];

/** ?ok=<kod> → profile.ok.<kod> metni */
function okText(t: T, m: Dict, code: string | undefined, at: string | undefined, n?: string): string | null {
  if (code === 'profile_created') return t('profile.ok.created');
  if (!code || !Object.hasOwn(m.profile.ok, code)) return null;
  // at: gün ("YYYY-MM-DD", taşınan alış günü) ya da an · n: teslimat raporunun sürümü
  return t(`profile.ok.${code}` as MsgKey, { date: !at ? '' : /^\d{4}-\d{2}-\d{2}$/.test(at) ? fmtDate(at) : fmtDateTime(at), n: /^\d{1,4}$/.test(n ?? '') ? String(n) : '' });
}

const num = (v: { toString(): string } | null | undefined) => (v == null ? null : Number(v.toString()));

/**
 * Profil siparişi sayfası (Aşama 6). Veriler lib/orders.ts → sanitizeOrder'dan geçmiştir: müşteri yalnızca gönderilmiş
 * teklifi ve müşteri fiyatını görür; depo bağlantısının özeti hiç gelmez; e-posta kuyruğunu yalnızca yönetici görür.
 */
export async function ProfileOrderView({ order, user, sp, t, m, locale, files, notes, history }: {
  order: OrderDetail; user: CurrentUser; sp: Record<string, string | undefined>; t: T; m: Dict; locale: 'tr' | 'ro';
  files: React.ReactNode; notes: React.ReactNode; history: React.ReactNode;
}) {
  const p = order.profile;
  const stage = p?.stage ?? 'FIYAT_BEKLIYOR';
  const isCustomer = user.appRole === 'MUSTERI';
  const admin = userCan(user, 'OFFER_SEND');
  const cancelled = order.status === 'IPTAL';
  const acts = profileActions({ role: user.appRole, stage, status: order.status, canApprove: user.canApprove, paid: !!p?.paidAt });
  const can = (a: string) => acts.includes(a);
  const latest = order.offers[0];
  const sent = order.offers.find((o) => o.status === 'GONDERILDI');
  const sentVersions = order.offers.filter((o) => o.status === 'GONDERILDI').length;
  const editing = admin && ((can('save_profile_prices') && latest?.status === 'YONETIMDE') || (can('update_profile_offer') && sp.teklif === 'guncelle'));
  const editOffer = can('save_profile_prices') ? latest : sent;
  const tz = getEnv().APP_TIMEZONE;
  const now = new Date();
  const today = dayDate(localDay(now, tz));
  // Romanya deposunun takvimi (karar 192, 194): en erken teslim (alış) günü = sipariş ŞİMDİ depoya iletilse hesaplanan gün
  // (12:00 kuralı, depo açık günleri — sunucuda; tarayıcı saati kullanılmaz). Yönetici bugünden itibaren açık bir gün seçer.
  const overrides = await calendarOverrides(db, DEPOT_CALENDAR, { now });
  let minPickupDate: Date | null = null;
  try { minPickupDate = earliestPickup({ now, overrides }); } catch { minPickupDate = null; }
  const minPickup = minPickupDate ? isoDay(minPickupDate) : '';
  const staffMin = isoDay(depotToday(now));
  const phase = depotPhase({ stage, status: order.status, pickupDate: p?.pickupDate ?? null, now });
  // Tatil verisi eksikse yöneticiye açık uyarı (gizlenmez): önümüzdeki 180 gün ya da siparişin teslim günü
  const pickupYear = p?.pickupDate ? new Date(p.pickupDate).getUTCFullYear() : null;
  const gapYears = admin
    ? [...new Set([...coverageGaps(DEPOT_CALENDAR, isoDay(depotToday(now))), ...(pickupYear && !hasYearData(DEPOT_CALENDAR, pickupYear) ? [pickupYear] : [])])].sort()
    : [];
  // Teslimat belgeleri (karar 195–196): sipariş depoya iletildikten sonra; müşteri kendi siparişinde görür (kişi adı yok)
  const docsStage = DELIVERY_DOC_STAGES.includes(stage);
  const docs: Awaited<ReturnType<typeof deliveryDocs>> = docsStage || cancelled ? await deliveryDocs(db, order.id, { staff: !isCustomer }) : { photos: [], reports: [] };
  const canDocs = admin && takesDeliveryDocs({ stage, status: order.status });
  const reportKey = crypto.randomBytes(18).toString('base64url');
  const idx = PROFILE_STAGES.indexOf(stage);
  const ok = okText(t, m, sp.ok, sp.at, sp.n);
  const summary = profileCustomerText(t, { status: order.status, stage });

  // Stok sayıları yalnızca stok görüntüleyen rollerde (yönetici, denetimci — STOCK_VIEW; karar 177): kalemlerin stoğu ve eksikler
  const stockViewer = userCan(user, 'STOCK_VIEW');
  const levels = stockViewer ? await stockLevels(db, order.profileItems.map((i) => i.productId).filter((x): x is string => !!x)) : new Map<string, number>();
  // "Stok yetersiz" işareti (karar 165) = sipariş gönderilirken stok yetmediği için açılan ve henüz kapatılmamış "Önemli
  // kararlar" kaydı. Yönetici gereken / mevcut / eksik tablosunu görür ve kararı verince kaydı "Önemli kararlar"da kapatır.
  // Müşteri uyarıyı ve KENDİ siparişindeki eksik ürünlerin sipariş anındaki gereken / mevcut / eksik değerini görür
  // (karar 177; mevcut eksiye düşmez) — genel stok listesi değil.
  const stockAlert = (stockViewer || isCustomer) && !cancelled
    ? await db.adminAlert.findFirst({ where: { orderId: order.id, type: STOCK_SHORTAGE_ALERT, resolvedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, details: true, createdAt: true } })
    : null;
  const rawLines = ((stockAlert?.details ?? {}) as { stock?: unknown }).stock;
  const alertLines = (Array.isArray(rawLines) ? rawLines : []) as { productId?: string; code?: string; nameTr?: string; nameRo?: string; unitCode?: string; qty?: number; stock?: number }[];
  const alertProducts = new Set(alertLines.map((l) => l.productId).filter(Boolean));
  const customerShort = isCustomer ? customerShortageView(alertLines) : [];
  const short = stockViewer && !p?.stockDeducted
    ? order.profileItems.filter((i) => i.productId && ((levels.get(i.productId) ?? 0) < i.qty || alertProducts.has(i.productId)))
    : [];
  const source = editing && can('save_profile_prices') ? await profilePricesFor(db, order.customerId) : null;
  const email = order.outbox.find((x) => x.type === 'WAREHOUSE_EMAIL');
  // FGO (Aşama 6b): bu siparişin son proforma/fatura işi
  const fgoJob = order.outbox.find((x) => x.type === 'FGO_PROFORMA' || x.type === 'FGO_INVOICE');
  const fxText = p?.fxRate != null
    ? `${t('profile.page.fgo.fxValue', { rate: Number(p.fxRate).toFixed(4).replace('.', ','), date: fmtDate(p.fxDate) })}${p.fxSource?.startsWith('MANUAL') ? ` (${t('profile.page.fgo.fxManual')})` : ''}`
    : null;
  const warehouseFile = order.files.find((f) => f.source === 'WAREHOUSE_FORM');
  const hidden = <input type="hidden" name="id" value={order.id} />;
  const itemOf = (l: Line) => order.profileItems.find((i) => i.code === l.poz) ?? null;

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p className="small"><Link href="/siparisler">← {isCustomer ? t('order.back.myOrders') : t('order.back.orders')}</Link></p>
          <h1>{order.title || order.orderNo}</h1>
          <div className="row">
            <span className="mono muted">{order.orderNo}</span>
            <Badge tone="purple">{t('profile.type')}</Badge>
            {cancelled ? <Badge tone="muted">{t('status.order.IPTAL')}</Badge>
              : isCustomer ? <Badge tone={summary.tone}>{summary.label}</Badge>
                : <Badge tone={PROFILE_STAGE_TONE[stage as keyof typeof PROFILE_STAGE_TONE]}>{profileStageText(t, stage)}</Badge>}
            {stockAlert && <Badge tone="danger">{t('profile.page.stock.mark')}</Badge>}
            {!isCustomer && <span className="muted small">· {customerLabel(user, order.customer.name)}</span>}
          </div>
        </div>
      </div>

      {ok && <div className="alert alert-ok">{ok}</div>}
      {/* Müşteri: stok uyarısı (karar 165, 177) — sipariş engellenmedi; yalnızca kendi siparişindeki eksik ürünler,
          sipariş anındaki gereken / mevcut / eksik */}
      {isCustomer && stockAlert && (
        <div className="alert alert-warn" id="stok" data-stock-alert>
          <b>{t('profile.page.stock.customerTitle')}</b>{' '}
          {t('profile.page.stock.customerText')}
          <ul className="plain-list" style={{ marginTop: 6 }}>
            {customerShort.map((l, i) => (
              <li key={i} data-stock-line={l.code}>
                {t('profile.page.stock.customerLine', {
                  product: `${l.code} ${(locale === 'tr' ? l.nameTr : l.nameRo) ?? ''}`.trim(), needed: l.needed, unit: unitLabel(l.unitCode, locale),
                  available: l.available, missing: l.missing,
                })}
              </li>
            ))}
          </ul>
          <div className="small muted">{t('profile.page.stock.customerWhen')}</div>
        </div>
      )}
      {sp.error && <div className="alert alert-error">{sp.error}</div>}

      <div className="card">
        <div className="stepper profile-stepper">
          {PROFILE_STAGES.map((s, i) => {
            const cls = cancelled ? '' : i < idx || stage === 'FATURALANDI' ? 'done' : i === idx ? 'current' : '';
            return (
              <div key={s} className={`step ${cls}`}>
                <div className="dot">{cls === 'done' ? '✓' : String(i + 1).padStart(2, '0')}</div>
                <div className="lbl">{t(`profile.steps.${s}` as MsgKey)}</div>
              </div>
            );
          })}
        </div>
        {isCustomer && !cancelled && <p className="muted small" style={{ margin: '8px 0 0' }}>{summary.next}</p>}
      </div>

      {/* ---------- müşteri: onay ---------- */}
      {isCustomer && stage === 'TEKLIF_GONDERILDI' && !cancelled && sent && (
        <div className="card turn" id="onay">
          <h2>{t('profile.page.approve.title')}</h2>
          {can('approve_profile_offer') ? (
            <form action={approveProfileAction}>
              {hidden}
              <input type="hidden" name="offerId" value={sent.id} />
              <p className="muted small">{t('profile.page.approve.intro')}</p>
              <div className="grid-3">
                <div>
                  <label htmlFor="pk-date">{t('profile.page.approve.date')}</label>
                  <input id="pk-date" name="pickupDate" type="date" required min={minPickup} defaultValue={minPickup} />
                  <div className="hint">{t('profile.page.approve.dateHint', { date: fmtDate(minPickup) })}</div>
                </div>
                <div>
                  <label htmlFor="pk-phone">{t('profile.page.approve.phone')}</label>
                  <input id="pk-phone" name="phone" type="tel" required maxLength={40} autoComplete="tel" defaultValue={user.phone ?? ''} />
                </div>
                <div>
                  <label htmlFor="pk-plate">{t('profile.page.approve.plate')}</label>
                  <input id="pk-plate" name="plate" required maxLength={60} placeholder={t('profile.page.approve.platePlaceholder')} style={{ textTransform: 'uppercase' }} />
                </div>
              </div>
              <div className="row end" style={{ marginTop: 10 }}>
                <ConfirmButton primary message={t('profile.page.approve.confirm')}>{t('profile.page.approve.submit')}</ConfirmButton>
              </div>
            </form>
          ) : <div className="alert alert-warn">{t('profile.page.approve.noRight')}</div>}
        </div>
      )}

      {/* ---------- yönetici: sıradaki işlem ---------- */}
      {admin && !cancelled && (
        <div className="card turn">
          <h2 style={{ marginBottom: 4 }}>{t('profile.page.actions.title')}</h2>
          {stage === 'TEKLIF_GONDERILDI' && <p className="muted small">{t('profile.page.approve.notApproved')}</p>}
          {stage === 'DEPODA' && <p className="muted small">{t('profile.page.actions.waitDepot')}</p>}
          <div className="stack">
            {can('update_profile_offer') && sp.teklif !== 'guncelle' && (
              <div><Link href={`/siparisler/${order.id}?teklif=guncelle#teklif`} className="btn">{t('profile.page.pricing.update')}</Link></div>
            )}
            {fgoJob && (
              <div className="small">
                <b>{t('profile.page.fgo.title')}:</b>{' '}
                {fgoJob.status === 'SENT' ? t('profile.page.fgo.sent', { date: fmtDateTime(fgoJob.sentAt) })
                  : fgoJob.status === 'FAILED' ? <span className="danger">{t('profile.page.fgo.failed', { error: fgoJob.lastError ?? '—' })}</span>
                    : fgoJob.status === 'SKIPPED' ? t('profile.page.fgo.skipped')
                      : fgoJob.attempts > 0 ? <span className="danger">{t('profile.page.fgo.retry', { n: fgoJob.attempts, error: fgoJob.lastError ?? '—', date: fmtDateTime(fgoJob.availableAt) })}</span>
                        : t('profile.page.fgo.pending')}
              </div>
            )}
            {/* Belgeyle saklanan kur kaydı (karar 96, 98) — yalnızca yönetici: politika, taban kur, yüzde, uygulanan kur, kaynak */}
            {admin && p?.fxRate != null && p.fxPolicy && (
              <div className="fx-block" id="belge-kuru">
                <h3>{t('fx.docTitle')}</h3>
                <FxInfo t={t} fx={{
                  policy: p.fxPolicy, currency: p.fxCurrency ?? 'EUR', baseRate: padRate((p.fxBaseRate ?? p.fxRate).toString()) ?? '',
                  markupPercent: p.fxMarkupPercent?.toString() ?? null, finalRate: Number(p.fxRate).toFixed(4), source: p.fxSource ?? '',
                  sourceDate: p.fxSourceDate ?? p.fxDate, manual: p.fxManual === true,
                }} />
              </div>
            )}
            {can('retry_fgo') && (!fgoJob || fgoJob.status === 'FAILED' || fgoJob.status === 'SKIPPED') && (
              <form action={retryFgoAction}>
                {hidden}
                <div className="row">
                  <label htmlFor="fgo-rate" style={{ margin: 0 }}>{t('profile.page.fgo.rate')}</label>
                  <input id="fgo-rate" name="fxRate" inputMode="decimal" maxLength={10} style={{ width: 110 }} />
                  <button className="btn">{t('profile.page.fgo.retryButton')}</button>
                </div>
                <div className="hint">{t('profile.page.fgo.rateHint')}</div>
              </form>
            )}
            {can('mark_proforma') && (
              <form action={proformaAction} className="row">
                {hidden}
                <label htmlFor="pf-no" style={{ margin: 0 }}>{t('profile.page.actions.proformaNo')}</label>
                <input id="pf-no" name="proformaNo" maxLength={60} style={{ width: 180 }} />
                <label htmlFor="pf-rate" style={{ margin: 0 }}>{t('profile.page.fgo.rateRequired')}</label>
                <input id="pf-rate" name="fxRate" inputMode="decimal" maxLength={10} style={{ width: 110 }} defaultValue={p?.fxRate != null ? Number(p.fxRate).toFixed(4) : ''} />
                <button className="btn btn-primary">{t('profile.page.actions.proforma')}</button>
              </form>
            )}
            {can('mark_paid') && (
              <form action={paidAction}>
                {hidden}
                <div className="row">
                  <label htmlFor="pd" style={{ margin: 0 }}>{t('profile.page.actions.paidDate')}</label>
                  <input id="pd" name="paidDate" type="date" required max={isoDay(today)} defaultValue={isoDay(today)} style={{ width: 'auto' }} />
                  <button className="btn btn-primary">{t('profile.page.actions.paid')}</button>
                </div>
                <div className="hint">{BEFORE_WAREHOUSE.includes(stage) ? t('profile.page.actions.paidHint') : t('profile.page.actions.paidLateHint')}</div>
              </form>
            )}
            {can('send_to_warehouse') && (
              <form action={warehouseAction}>
                {hidden}
                <input type="hidden" name="v" value={order.version} />
                <p className="hint" style={{ marginTop: 0 }}>{t('profile.page.actions.warehouseHint')}</p>
                <ConfirmButton message={t('profile.page.actions.warehouseConfirm')}>{t('profile.page.actions.warehouse')}</ConfirmButton>
              </form>
            )}
            {can('mark_delivered') && (
              <form action={deliveredAction}>
                {hidden}
                <label htmlFor="dl-files" className="small">{t('profile.page.actions.deliveredFiles')}</label>
                <div className="row">
                  <input id="dl-files" name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png" style={{ flex: 1 }} />
                  <ConfirmButton primary message={t('profile.page.actions.deliveredConfirm')}>{t('profile.page.actions.delivered')}</ConfirmButton>
                </div>
              </form>
            )}
            {can('mark_invoiced') && (
              <form action={invoicedAction} className="row">
                {hidden}
                <label htmlFor="inv-no" style={{ margin: 0 }}>{t('profile.page.actions.invoiceNo')}</label>
                <input id="inv-no" name="invoiceNo" maxLength={60} style={{ width: 180 }} />
                <ConfirmButton primary message={t('profile.page.actions.invoicedConfirm')}>{t('profile.page.actions.invoiced')}</ConfirmButton>
              </form>
            )}
            {(stage === 'DEPODA' || stage === 'TESLIM_EDILDI' || email) && (
              <div className="small">
                <b>{t('profile.page.email.title')}:</b>{' '}
                {!email ? '—'
                  : email.status === 'SENT' ? t('profile.page.email.sent', { date: fmtDateTime(email.sentAt) })
                    : email.status === 'FAILED' ? <span className="danger">{t('profile.page.email.failed', { error: email.lastError ?? '—' })}</span>
                      : email.status === 'SKIPPED' ? t('profile.page.email.skipped')
                        : email.attempts > 0 ? <span className="danger">{t('profile.page.email.retry', { n: email.attempts, error: email.lastError ?? '—', date: fmtDateTime(email.availableAt) })}</span>
                          : t('profile.page.email.pending')}
                {warehouseFile && <> · <a href={`/dosya/siparis/${warehouseFile.id}?ac=1`} target="_blank" rel="noopener">{t('profile.page.email.form')}</a></>}
              </div>
            )}
            {can('resend_warehouse') && (
              <form action={resendWarehouseAction}>
                {hidden}
                <ConfirmButton message={t('profile.page.actions.resendConfirm')}>{t('profile.page.actions.resend')}</ConfirmButton>
              </form>
            )}
            {can('cancel') && (
              <details>
                <summary className="small muted" style={{ cursor: 'pointer' }}>{t('order.cancel.summary')}</summary>
                <form action={cancelProfileAction} className="row" style={{ marginTop: 8 }}>
                  {hidden}
                  <input name="note" type="text" required placeholder={t('order.cancel.reason')} style={{ flex: 1 }} />
                  <ConfirmButton danger message={t('order.cancel.confirm')}>{t('order.cancel.submit')}</ConfirmButton>
                </form>
              </details>
            )}
          </div>
        </div>
      )}

      {/* Yönetici: stok durumu (karar 165) — gereken / mevcut (şu anki stok) / eksik; sipariş engellenmedi, karar yöneticide.
          Sipariş gelir gelmez (fiyat beklerken) görünür ve depoya gidene (stok düşene) kadar kalır. */}
      {stockViewer && !cancelled && short.length > 0 && idx >= 0 && idx < PROFILE_STAGES.indexOf('DEPODA') && (
        <div className="card" id="stok">
          <h2>{t('profile.page.stock.title')} {stockAlert && <Badge tone="danger">{t('profile.page.stock.mark')}</Badge>}</h2>
          <p className="muted small">{t('profile.page.stock.intro')}</p>
          <div className="table-wrap">
            <table className="profile-table stock-table">
              <thead>
                <tr>
                  <th>{t('profile.page.colProduct')}</th><th>{t('profile.page.colUnit')}</th>
                  <th className="num">{t('profile.page.stock.colNeeded')}</th><th className="num">{t('profile.page.stock.colStock')}</th>
                  <th className="num">{t('profile.page.stock.colMissing')}</th>
                </tr>
              </thead>
              <tbody>
                {short.map((i) => {
                  const stock = levels.get(i.productId!) ?? 0;
                  const missing = Math.max(0, i.qty - stock);
                  return (
                    <tr key={i.id} data-stock-row={i.code}>
                      <td><b>{locale === 'tr' ? i.nameTr : i.nameRo}</b><div className="muted small mono">{i.code}</div></td>
                      <td className="muted">{unitLabel(i.unitCode, locale)}</td>
                      <td className="num">{i.qty}</td>
                      <td className="num">{stock}</td>
                      <td className={`num${missing > 0 ? ' text-danger' : ''}`}><b>{missing}</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {stockAlert && userCan(user, 'ALERT_VIEW') && <p className="small" style={{ marginBottom: 0 }}><Link href="/admin/kararlar">{t('profile.page.stock.decide')}</Link></p>}
        </div>
      )}

      <OrderInfo
        title={t('order.info.title')}
        rows={[
          !!order.title && { label: t('order.info.heading'), value: order.title },
          { label: t('order.info.orderNo'), value: order.orderNo, mono: true },
          { label: t('order.info.customerOrderNo'), value: order.customerOrderNo },
          !isCustomer && { label: t('order.info.customer'), value: customerLabel(user, order.customer.name) },
          { label: t('order.info.orderDate'), value: fmtDate(order.createdAt) },
          !!p?.approvedAt && { label: t('profile.page.info.approvedAt'), value: fmtDateTime(p.approvedAt) },
          !!p?.proformaAt && { label: t('profile.page.info.proformaNo'), value: <>{p.proformaNo ?? '—'} · {fmtDate(p.proformaAt)}<FgoDocLink link={p.proformaLink} prefix=" · " fallback={null}>{t('profile.page.fgo.open')}</FgoDocLink></> },
          !!fxText && { label: t('profile.page.fgo.fx'), value: fxText },
          !isCustomer && p?.proformaAmount != null && { label: t('profile.page.fgo.amount'), value: fmtMoney(p.proformaAmount.toString(), 'RON') },
          !!p?.paidAt && { label: t('profile.page.info.paidAt'), value: fmtDate(p.paidAt) },
          // "Depoya gönderildi" müşteri ekranında yok; "Teslim" (Predare) yalnızca tarih — saat yok (karar 161)
          !isCustomer && !!p?.warehouseSentAt && { label: t('profile.page.info.warehouseSentAt'), value: fmtDateTime(p.warehouseSentAt) },
          !!p?.deliveredAt && { label: t('profile.page.info.deliveredAt'), value: `${fmtDate(p.deliveredAt)}${!isCustomer && p.deliveredVia ? ` · ${t(`profile.page.info.via.${p.deliveredVia}` as MsgKey)}` : ''}` },
          !!p?.invoicedAt && { label: t('profile.page.info.invoiceNo'), value: <>{p.invoiceNo ?? '—'} · {fmtDate(p.invoicedAt)}<FgoDocLink link={p.invoiceLink} prefix=" · " fallback={null}>{t('profile.page.fgo.open')}</FgoDocLink></> },
        ]}
      />

          {/* ---------- teklif / fiyatlandırma ---------- */}
          {editing && editOffer ? (
            <form action={profilePricesAction} className="card" id="teklif">
              {hidden}
              <input type="hidden" name="v" value={order.version} />
              <h2>{can('save_profile_prices') ? t('profile.page.pricing.title') : t('profile.page.pricing.updateTitle', { n: sentVersions + 1 })}</h2>
              <p className="muted small">
                {can('save_profile_prices') && source
                  ? t('profile.page.pricing.source', { source: source.tableName ? t('profile.page.pricing.sourceTable', { name: source.tableName }) : t('profile.page.pricing.sourceList') })
                  : t('profile.page.pricing.updateIntro')}
                {editOffer.lines.some((l) => l.offerPrice == null) && <> {t('profile.page.pricing.missing')}</>}
              </p>
              <LinesTable lines={editOffer.lines} itemOf={itemOf} t={t} locale={locale} levels={levels} editable admin />
              {!can('save_profile_prices') && (
                <div style={{ marginTop: 10 }}>
                  <label htmlFor="upd-note" className="small">{t('profile.page.pricing.updateNote')}</label>
                  <input id="upd-note" name="note" maxLength={500} />
                </div>
              )}
              <Notes t={t} policy={order.customer.fxPolicy} />
              <div className="row end" style={{ marginTop: 10 }}>
                {can('save_profile_prices') ? (
                  <>
                    <button className="btn" name="intent" value="save">{t('profile.page.pricing.save')}</button>
                    <ConfirmButton primary name="intent" value="send" message={t('profile.page.pricing.sendConfirm')}>{t('profile.page.pricing.send')}</ConfirmButton>
                  </>
                ) : (
                  <>
                    <Link href={`/siparisler/${order.id}#teklif`} className="btn btn-link">{t('profile.page.pricing.cancel')}</Link>
                    <ConfirmButton primary name="intent" value="update" message={t('profile.page.pricing.updateConfirm')}>{t('profile.page.pricing.updateSubmit')}</ConfirmButton>
                  </>
                )}
              </div>
            </form>
          ) : (() => {
            const shown = isCustomer || !userCan(user, 'OFFER_DRAFT_VIEW') ? sent : latest;
            return (
              <div className="card" id="teklif">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <h2 style={{ margin: 0 }}>{shown ? (isCustomer ? t('profile.page.offerTitleCustomer') : t('profile.page.offerTitle')) : t('profile.page.itemsTitle')}</h2>
                  <span className="row">
                    {sentVersions > 1 && <span className="badge badge-info">{t('profile.page.version', { n: sentVersions })}</span>}
                    {shown?.sentAt && <span className="muted small">{t('profile.page.sentAt', { date: fmtDate(shown.sentAt) })}</span>}
                  </span>
                </div>
                {shown ? (
                  <>
                    <LinesTable lines={shown.lines} itemOf={itemOf} t={t} locale={locale} levels={levels} admin={admin} />
                    <Notes t={t} policy={order.customer.fxPolicy} />
                  </>
                ) : (
                  <>
                    <ItemsTable order={order} t={t} locale={locale} />
                    {isCustomer && <p className="muted small">{t('profile.page.offerWaiting')}</p>}
                  </>
                )}
              </div>
            );
          })()}
          {/* Teslimat (Paket 8, karar 194): tahmini teslim (alış) günü, durum, iletişim. Tarih tahminidir ve stoktan bağımsızdır;
              müşteri yalnızca kendi siparişinin teslim bilgisini görür. Yönetici depoda iken de değiştirebilir (müşteriye bildirilir). */}
          {!cancelled && (
            <div className="card" id="teslim">
              <h2>{t('delivery.card.title')}</h2>
              {gapYears.length > 0 && <div className="alert alert-warn" data-calendar-gap>{t('delivery.card.noData', { years: gapYears.join(', ') })}</div>}
              {p?.pickupDate ? (
                <table className="kv"><tbody>
                  <tr><td>{t('delivery.card.estimate')}</td><td><b data-delivery-date={isoDay(p.pickupDate)}>{fmtDate(p.pickupDate)}</b></td></tr>
                  {phase && (
                    <tr><td>{t('delivery.card.status')}</td><td>
                      <Badge tone={phase === 'DELIVERED' ? 'ok' : phase === 'READY' ? 'info' : 'muted'}>{t(`delivery.card.phase.${phase}` as MsgKey)}</Badge>
                      {phase === 'DELIVERED' && p.deliveredAt ? <span className="muted small"> {fmtDate(p.deliveredAt)}</span> : null}
                    </td></tr>
                  )}
                  <tr><td>{t('profile.page.pickup.phone')}</td><td>{p.contactPhone ?? '—'}</td></tr>
                  <tr><td>{t('profile.page.pickup.plate')}</td><td>{p.vehiclePlate ?? '—'}</td></tr>
                </tbody></table>
              ) : minPickup ? (
                <p data-delivery-estimate={minPickup} style={{ marginTop: 0 }}>
                  {t(isCustomer ? 'delivery.card.estimateBefore' : 'delivery.card.estimateBeforeStaff', { date: fmtDate(minPickup) })}
                </p>
              ) : null}
              {phase !== 'DELIVERED' && <p className="muted small" data-delivery-note>{t('delivery.card.estimateNote')} {t('delivery.card.rule')}</p>}
              {isCustomer && stockAlert && phase !== 'DELIVERED' && <div className="alert alert-warn" data-delivery-stock>{t('delivery.card.stockNote')}</div>}
              {p?.pickupDate && can('update_pickup') && (PICKUP_EDITABLE.includes(stage) || (admin && stage === 'DEPODA')) ? (
                <details style={{ marginTop: 10 }}>
                  <summary className="small" style={{ cursor: 'pointer' }}>{t('profile.page.pickup.edit')}</summary>
                  <form action={updatePickupAction} style={{ marginTop: 8 }}>
                    {hidden}
                    <input type="hidden" name="v" value={order.version} />
                    <label htmlFor="up-date" className="small">{t('profile.page.pickup.date')}</label>
                    <input id="up-date" name="pickupDate" type="date" required min={admin ? staffMin : minPickup} defaultValue={isoDay(p.pickupDate)} />
                    <div className="hint">{admin ? t('delivery.card.adminHint') : t('profile.page.approve.dateHint', { date: fmtDate(minPickup) })}</div>
                    <label htmlFor="up-phone" className="small">{t('profile.page.pickup.phone')}</label>
                    <input id="up-phone" name="phone" type="tel" required maxLength={40} defaultValue={p.contactPhone ?? ''} />
                    <label htmlFor="up-plate" className="small">{t('profile.page.pickup.plate')}</label>
                    <input id="up-plate" name="plate" required maxLength={60} defaultValue={p.vehiclePlate ?? ''} style={{ textTransform: 'uppercase' }} />
                    <div className="row end" style={{ marginTop: 8 }}><button className="btn btn-primary">{t('profile.page.pickup.save')}</button></div>
                  </form>
                  {/* "Depoya iletilene kadar" notu müşterinin değiştirebildiği adımlar için; depodaki siparişte yöneticiye adminHint yeter */}
                  {PICKUP_EDITABLE.includes(stage) && <p className="hint">{t('profile.page.pickup.editHint')}</p>}
                </details>
              ) : ['DEPODA', 'TESLIM_EDILDI', 'FATURALANDI'].includes(stage) && isCustomer ? (
                <div className="alert alert-info" style={{ marginTop: 10, marginBottom: 0 }}>{t('profile.page.pickup.locked')}</div>
              ) : null}
            </div>
          )}

          {/* Teslimat fotoğrafları ve raporu (Paket 8, karar 195–196): sipariş depoya iletildikten sonra. Fotoğraf ve rapor
              bağlantıları kalıcıdır (giriş + sipariş yetkisi; süreli bağlantı yok); teslimattan ve arşivden sonra da açılır. */}
          {(docsStage || docs.photos.length > 0 || docs.reports.length > 0) && (
            <div className="card" id="teslimat">
              <h2>{t('delivery.photos.title')}</h2>
              {docs.photos.length === 0 ? <p className="muted" data-no-photos>{t('delivery.photos.none')}</p> : (
                <div className="photo-grid" data-delivery-photos>
                  {docs.photos.map((ph, i) => (
                    <figure key={ph.id} className="photo-tile" data-photo={ph.id}>
                      <a href={`/dosya/teslimat/${ph.id}?ac=1`} target="_blank" rel="noopener" aria-label={`${t('delivery.photos.open')} — ${ph.name}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/dosya/teslimat/${ph.id}?ac=1`} alt={t('delivery.photos.alt', { n: i + 1 })} loading="lazy" />
                      </a>
                      <figcaption className="small muted">
                        {fmtDateTime(ph.createdAt)} · {ph.by ?? t(`delivery.photos.by.${ph.via === 'DEPOT_LINK' ? 'DEPOT_LINK' : 'ADMIN'}`)}
                        {ph.scanStatus === 'PENDING' ? ` · ${t('delivery.photos.scanning')}` : ''}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {canDocs && <DeliveryPhotoUpload action={deliveryPhotoAction} hidden={{ id: order.id }} m={m.delivery.photos} inputId="dl-photos" />}

              <h3 id="rapor" style={{ marginTop: 16 }}>{t('delivery.report.title')}</h3>
              {docs.reports.length === 0 ? <p className="muted" data-no-reports>{t('delivery.report.none')}</p> : (
                <ul className="plain-list report-list" data-delivery-reports>
                  {docs.reports.map((r, i) => (
                    <li key={r.id} data-report={r.revision}>
                      <a href={`/dosya/rapor/${r.id}`} target="_blank" rel="noopener">{t('delivery.report.item', { n: r.revision, date: fmtDateTime(r.createdAt) })}</a>
                      {i === 0 && <> <Badge tone="ok">{t('delivery.report.latest')}</Badge></>}
                      {!isCustomer && <span className="muted small"> · {r.by ?? t(`delivery.photos.by.${r.via === 'DEPOT_LINK' ? 'DEPOT_LINK' : 'ADMIN'}`)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {canDocs && (
                <form action={deliveryReportAction} style={{ marginTop: 10 }}>
                  {hidden}
                  <input type="hidden" name="key" value={reportKey} />
                  <label htmlFor="dr-note" className="small">{t('delivery.report.note')}</label>
                  <textarea id="dr-note" name="note" rows={2} maxLength={1000} />
                  <div className="hint">{t('delivery.report.noteHint')} {t('delivery.report.createHint')}</div>
                  <div className="row end" style={{ marginTop: 8 }}><button className="btn btn-primary">{t('delivery.report.create')}</button></div>
                </form>
              )}
            </div>
          )}
          {files}
          {notes}
          {history}
    </>
  );
}

function Notes({ t, policy }: { t: T; policy: string }) {
  return (
    <div className="offer-notes">
      <p>{t('profile.notes.vat')}</p>
      <p>{fxOfferNote(t, policy)}</p>
      <p>{t('profile.notes.pickup')}</p>
    </div>
  );
}

function Thumb({ id }: { id: string | null | undefined }) {
  // eslint-disable-next-line @next/next/no-img-element
  return id ? <img src={`/dosya/urun/${id}`} alt="" loading="lazy" /> : null;
}

/** Siparişin kalemleri (teklif henüz yokken) */
function ItemsTable({ order, t, locale }: { order: OrderDetail; t: T; locale: 'tr' | 'ro' }) {
  return (
    <div className="table-wrap">
      <table className="profile-table">
        <thead><tr><th style={{ width: 64 }} /><th>{t('profile.page.colProduct')}</th><th>{t('profile.page.colUnit')}</th><th className="num">{t('profile.page.colQty')}</th></tr></thead>
        <tbody>
          {order.profileItems.map((i) => (
            <tr key={i.id}>
              <td className="thumb"><Thumb id={i.imageId} /></td>
              <td><b>{locale === 'tr' ? i.nameTr : i.nameRo}</b><div className="muted small mono">{i.code}</div></td>
              <td className="muted">{unitLabel(i.unitCode, locale)}</td>
              <td className="num"><b>{i.qty}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Teklif satırları. Müşteri/denetimcide fiyat alanı zaten müşteri fiyatıdır (sanitizeOrder → unitPrice); yönetici
 * offerPrice'ı görür ve (editable) değiştirir. Liste fiyatı ve stok yalnızca yöneticide.
 */
function LinesTable({ lines, itemOf, t, locale, levels, admin, editable = false }: {
  lines: Line[]; itemOf: (l: Line) => { imageId: string | null; productId: string | null } | null; t: T; locale: 'tr' | 'ro';
  levels: Map<string, number>; admin: boolean; editable?: boolean;
}) {
  const priceOf = (l: Line) => (admin ? num(l.offerPrice) : num(l.unitPrice));
  const total = profileTotals(lines.map((l) => ({ adet: l.adet, offerPrice: priceOf(l) }))).amount;
  return (
    <div className="table-wrap">
      <table className="profile-table">
        <thead>
          <tr>
            <th style={{ width: 64 }} /><th>{t('profile.page.colProduct')}</th><th>{t('profile.page.colUnit')}</th><th className="num">{t('profile.page.colQty')}</th>
            {admin && <th className="num">{t('profile.page.colStock')}</th>}
            {admin && <th className="num">{t('profile.page.colListPrice')}</th>}
            <th className="num">{t('profile.page.colPrice')}</th><th className="num">{t('profile.page.colAmount')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const it = itemOf(l);
            const price = priceOf(l);
            const stock = admin && it?.productId ? levels.get(it.productId) ?? 0 : null;
            return (
              <tr key={l.id}>
                <td className="thumb"><Thumb id={it?.imageId} /></td>
                <td><b>{locale === 'ro' && l.descriptionRo ? l.descriptionRo : l.description}</b><div className="muted small mono">{l.poz}</div></td>
                <td className="muted">{unitLabel(l.unitCode ?? '', locale)}</td>
                <td className="num"><b>{l.adet}</b></td>
                {admin && <td className={`num${stock != null && stock < l.adet ? ' danger' : ''}`}>{stock ?? '—'}{stock != null && stock < l.adet && <div className="small">{t('profile.page.stockShort', { n: l.adet - stock })}</div>}</td>}
                {admin && <td className="num muted">{l.listPrice != null ? fmtNum(l.listPrice.toString()) : '—'}</td>}
                <td className="num">
                  {editable ? (
                    <>
                      <input type="hidden" name="l_id" value={l.id} />
                      <input name="l_price" inputMode="decimal" defaultValue={price != null ? price.toFixed(2) : ''} className="price-input" aria-label={`${l.poz} — ${t('profile.page.colPrice')}`} />
                    </>
                  ) : price != null ? fmtNum(price) : '—'}
                </td>
                <td className="num">{price != null ? fmtNum(price * l.adet) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr><td colSpan={admin ? 7 : 5}>{t('profile.page.total')}</td><td className="num"><b>{fmtMoney(total.toFixed(2), 'EUR')}</b></td></tr>
        </tfoot>
      </table>
    </div>
  );
}
