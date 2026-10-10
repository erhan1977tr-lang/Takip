import { db } from '@/lib/db';
import type { T, MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FxInfo, FxUnavailableNote, fxPolicyLabel } from '@/components/FxInfo';
import { bnrRate } from '@/server/fx/bnr.js';
import { padRate } from '@/server/fx/decimal.js';
import { previewExchangeRate } from '@/server/fx/resolve.js';
import { paymentStatus, remaining } from '@/server/accounting/receivables.js';
import { DOC_EMAIL, GLASS_FGO, billingState } from '@/server/glass/billing.js';
import { invoiceOrderKey } from '@/server/glass/invoice-batch.js';
import { localDay } from '@/server/profile/dates.js';
import { FgoDocLink } from '@/components/FgoDocLink';
import { DuplicateAck } from '@/components/DuplicateAck';
import { dupTexts, matchLines, type MatchView } from '@/lib/finance';
import { advanceRisk } from '@/server/finance/service.js';
import { isParked } from '@/server/finance/uncertain.js';
import { glassDocumentAction } from './glass-billing-actions';

const TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok' } as const;
const KIND_ACTION = { proforma: 'PROFORMA', advance: 'ADVANCE' } as const;
type Doc = { id: string; kind: string; seq: number; advanced: { toString(): string } | null; series: string; number: string; link: string | null; issuedAt: Date; total: { toString(): string } | null; paid: { toString(): string } | null };
type Job = { type: string; status: string; lastError: string | null; payload: unknown; createdAt: Date; sentAt: Date | null };

/**
 * Cam siparişinin Finans / FGO bölümü (yönetici). Muhasebe → Cam Tahsilat ile aynı kayıtlar (FgoDocument).
 * Düğmeler belge durumuna göre: proforma → (tahsilat) → avans faturası. Nihai fatura burada değil (P1, karar 239): onaylı
 * yüklemeden, yükleme gününün Faturalama kartında — yalnızca yüklenen miktar, ödeme şartı yok; bu kart onaylı yüklemeleri ve
 * faturalanıp faturalanmadıklarını gösterir, oraya bağlantı verir. Tahsilat = FGO'nun gösterdiği
 * ya da yöneticinin elle kaydettiği (büyük olan; karar 207): tahsilat − avansı kesilen > 0 ise avans faturası düğmesi
 * yüklemeden sonra da çıkar. Aynı müşteride aynı tutarlı avans / ödeme varsa düğmenin formunda eşleşmeler ve zorunlu onay
 * kutusu (karar 208). Sonucu belirsiz iş (karar 209) yeniden denenmez; karar kutusu Ödemeler kartında (#belirsiz).
 */
export async function GlassFinance({ order, t, sp }: {
  order: { id: string; customerId: string; status: string; actualShipDate: Date | null; estimatedShipDate: Date | null; offers: { status: string }[] };
  t: T; sp: Record<string, string | undefined>;
}) {
  const [docs, billing, jobs, batchOrders, payments, confirmed] = await Promise.all([
    db.fgoDocument.findMany({ where: { orderId: order.id }, orderBy: { issuedAt: 'asc' } }) as Promise<Doc[]>,
    db.glassBilling.findUnique({ where: { orderId: order.id } }),
    db.notificationOutbox.findMany({ where: { orderId: order.id, type: { in: [GLASS_FGO, DOC_EMAIL] } }, orderBy: { createdAt: 'desc' }, take: 10 }) as Promise<Job[]>,
    // Sipariş etkin bir müşteri partisinde mi (müşteri proforması, karar 100): sipariş başına belge istenemez
    db.billingBatchOrder.findMany({
      where: { orderId: order.id, activeKey: { not: null } }, orderBy: { batch: { createdAt: 'asc' } },
      select: { activeKey: true, batch: { select: { kind: true, status: true, customerId: true, document: { select: { series: true, number: true, link: true } } } } },
    }),
    // Sipariş başına zincirin elle ödeme kayıtları (karar 206; müşteri proformasındakiler partinin zincirinde)
    db.manualPayment.findMany({ where: { orderId: order.id, batchId: null }, select: { ron: true, voidedAt: true, proformaRef: true } }),
    // Siparişin onaylı yüklemeleri (karar 239): nihai fatura bunlardan, yükleme gününün Faturalama kartında kesilir
    db.loadingConfirmation.findMany({ where: { items: { some: { orderId: order.id } } }, orderBy: { shipDay: 'asc' }, select: { id: true, shipDay: true } }),
  ]);
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const pending = jobs.filter((j) => j.type === GLASS_FGO && j.status === 'PENDING');
  // Yalnızca müşteri PROFORMA partisi sipariş başına belgeyi dışlar; onaylı yüklemeden kesilen fatura partileri ayrı listelenir
  const proformaBatches = batchOrders.filter((x) => x.batch.kind === 'PROFORMA');
  const st = billingState({
    status: order.status, loaded: confirmed.length > 0, docs,
    pending: pending.map((j) => (j.payload as { kind?: string } | null)?.kind ?? ''), hasOffer: order.offers.some((o) => o.status === 'GONDERILDI'),
    inBatch: proformaBatches.length > 0, payments, invoiced: batchOrders.some((x) => x.activeKey?.startsWith('INVOICE:')),
  });
  // Onaylı yükleme başına fatura durumu: bu onaydan fatura partisi (kuyrukta / kesildi / kesilemedi) ya da henüz yok
  const invoiceOf = new Map(batchOrders.filter((x) => x.activeKey?.startsWith('INVOICE:')).map((x) => [x.activeKey, x.batch]));
  const loadings = confirmed.map((c) => ({ day: c.shipDay.toISOString().slice(0, 10), batch: invoiceOf.get(invoiceOrderKey(c.id, order.id)) ?? null }));
  // Aynı müşteride aynı tutar (karar 208): avans düğmesinin formunda eşleşmeler + onay kutusu (sunucu yeniden denetler)
  const risk = st.actions.includes('advance')
    ? await advanceRisk(db, { customerId: order.customerId, ron: st.advanceRequired, chainKey: `order:${order.id}` })
    : { matches: [], ackKey: '' };
  const parked = jobs.find((j) => j.type === GLASS_FGO && isParked(j));
  // Müşteri düzeyindeki belgeler (müşteri proforması, onaylı yüklemeden müşteri faturası): numaraları ya da durumu
  const batchRefs = proformaBatches.map((x) => (x.batch.document ? `${x.batch.document.series}${x.batch.document.number}` : t(`accounting.batch.status.${x.batch.status}` as MsgKey)));
  // Kur henüz belirlenmediyse (proforma ya da doğrudan fatura bu belgeyle belirleyecek) ve teklif EUR ise:
  // müşterinin kur politikasıyla bugünün kuru gösterilir, yönetici isterse elle kur girer (karar 95–96).
  const setsRate = billing?.fxRate == null && st.actions.includes('proforma');
  const fxOrder = setsRate ? await db.order.findUnique({
    where: { id: order.id },
    select: { customer: { select: { fxPolicy: true, fxMarkupPercent: true } }, offers: { where: { status: 'GONDERILDI' }, orderBy: { createdAt: 'desc' }, take: 1, select: { currency: true } } },
  }) : null;
  const fxCurrency = fxOrder?.offers[0]?.currency ?? null;
  const askRate = setsRate && fxCurrency === 'EUR';
  const fxNow = askRate && fxOrder
    ? await previewExchangeRate(db, { customer: fxOrder.customer, currency: 'EUR', day: today, bnrImpl: (o) => bnrRate({ ...o, timeoutMs: 6000 }) })
    : null;
  const hasProforma = docs.some((d) => d.kind === 'PROFORMA');
  const lastJob = jobs.find((j) => j.type === GLASS_FGO);
  const lastMail = jobs.find((j) => j.type === DOC_EMAIL);
  const hidden = <input type="hidden" name="id" value={order.id} />;
  return (
    <div className="card" id="finans">
      <h2>{t('glassBilling.title')}</h2>
      {sp.fgoOk && <div className="alert alert-ok">{t('glassBilling.ok.requested')}</div>}
      {sp.fgoError && <div className="alert alert-error" data-fgo-error={sp.fgoError}>{t(`glassBilling.errors.${['FGO_DISABLED', 'FGO_DAILY_LIMIT', 'BAD_RATE', 'RATE_LOCKED', 'DUPLICATE_RISK', 'FORBIDDEN'].includes(sp.fgoError) ? sp.fgoError : 'NOT_ALLOWED'}` as MsgKey)}</div>}
      {docs.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('accounting.receivables.col.kind')}</th><th>{t('accounting.receivables.col.doc')}</th><th>{t('accounting.receivables.col.date')}</th>
                <th className="num">{t('accounting.receivables.col.total')}</th><th className="num">{t('accounting.receivables.col.paid')}</th>
                <th className="num">{t('accounting.receivables.col.rest')}</th><th>{t('accounting.receivables.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const s = paymentStatus(d.total, d.paid);
                const rest = remaining(d.total, d.paid);
                return (
                  <tr key={d.id}>
                    <td>{t(`accounting.receivables.kind.${d.kind}` as MsgKey)}</td>
                    <td className="mono"><FgoDocLink link={d.link}>{d.series}{d.number}</FgoDocLink></td>
                    <td>{fmtDate(d.issuedAt)}</td>
                    <td className="num">{d.total != null ? fmtMoney(d.total.toString(), 'RON') : '—'}</td>
                    <td className="num">{d.paid != null ? fmtMoney(d.paid.toString(), 'RON') : '—'}</td>
                    <td className="num"><b>{rest != null ? fmtMoney(rest, 'RON') : '—'}</b></td>
                    <td><Badge tone={TONE[s]}>{t(`accounting.receivables.status.${s}` as MsgKey)}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">{t('glassBilling.none')}</p>}
      {billing?.fxRate != null && <p className="small muted">{t('glassBilling.rate', { rate: Number(billing.fxRate).toFixed(4).replace('.', ','), date: fmtDate(billing.fxDate) })}</p>}
      {/* Belgeyle saklanan kur kaydı: sonradan BNR / BT ya da politika değişse de değişmez */}
      {billing?.fxRate != null && billing.fxPolicy && billing.fxSource !== 'RON' && (
        <div className="fx-block" id="belge-kuru">
          <h3>{t('fx.docTitle')}</h3>
          <FxInfo t={t} fx={{
            policy: billing.fxPolicy, currency: billing.fxCurrency ?? 'EUR', baseRate: padRate((billing.fxBaseRate ?? billing.fxRate).toString()) ?? '',
            markupPercent: billing.fxMarkupPercent?.toString() ?? null, finalRate: Number(billing.fxRate).toFixed(4), source: billing.fxSource ?? '',
            sourceDate: billing.fxSourceDate ?? billing.fxDate, manual: billing.fxManual === true,
          }} />
        </div>
      )}
      {askRate && (
        <div className="fx-block" id="kur-onizleme">
          <h3>{t('fx.todayTitle')}</h3>
          {fxNow?.ok ? (
            <>
              <FxInfo fx={fxNow.fx} t={t} />
              {fxOrder?.customer.fxPolicy === 'BT_UNIT_SELL' && <p className="muted small">{t('fx.btAutoNote')}</p>}
            </>
          ) : fxNow && (
            <>
              <p className="small"><b>{t('fx.policyLabel')}:</b> {fxPolicyLabel(t, fxOrder?.customer.fxPolicy, fxOrder?.customer.fxMarkupPercent?.toString())}</p>
              <FxUnavailableNote code={fxNow.code} error={fxNow.error} t={t} />
            </>
          )}
        </div>
      )}
      {/* Proformanın tahsilatı ve avans durumu — tek kaynak FGO (karar 104): tahsilat − avansı kesilen = avansı kesilecek */}
      {hasProforma && !docs.some((d) => d.kind === 'INVOICE') && (
        <div className="fx-block" id="avans-durumu">
          <h3>{t('glassBilling.chain.title')}</h3>
          <p className="small">
            {t('glassBilling.chain.paid')}: <b>{fmtMoney(st.paid, 'RON')}</b> · {t('glassBilling.chain.manual')}: <b>{fmtMoney(st.manualRon, 'RON')}</b> ·{' '}
            {t('glassBilling.chain.advanced')}: <b>{fmtMoney(st.advanced, 'RON')}</b> ·{' '}
            {t('glassBilling.chain.required')}: {st.advanceRequired > 0 ? <Badge tone="warn">{fmtMoney(st.advanceRequired, 'RON')}</Badge> : <b>{fmtMoney(st.advanceRequired, 'RON')}</b>}
          </p>
          <p className="muted small">{t('glassBilling.chain.note')}</p>
        </div>
      )}
      {billing?.paidAmount != null && <p className="small muted">{t('glassBilling.paidManual', { amount: fmtMoney(billing.paidAmount.toString(), 'RON'), date: fmtDateTime(billing.paidAt) })}</p>}
      {/* Yüklenmiş + FGO'da avansı kesilmemiş tahsilat: kapanış faturası engellenir, önce avans faturası (karar 104) */}
      {st.wait === 'advance_required'
        ? <div className="alert alert-warn" id="fatura-engeli">{t('glassBilling.wait.advance_required', { amount: fmtMoney(st.advanceRequired, 'RON') })}</div>
        : st.wait === 'batch' && proformaBatches.length > 0 ? (
          <div className="alert alert-info" id="musteri-proformasi">
            {t('glassBilling.wait.batch', { ref: batchRefs.join(', ') })}{' '}
            {proformaBatches.map((x) => x.batch.document && (
              <FgoDocLink key={`${x.batch.document.series}${x.batch.document.number}`} link={x.batch.document.link} fallback={null}>{x.batch.document.series}{x.batch.document.number} </FgoDocLink>
            ))}
            <a href={`/admin/muhasebe/cam/proforma?musteri=${proformaBatches[0].batch.customerId}#partiler`}>{t('accounting.batch.open')}</a>
          </div>
        ) : st.wait === 'payment_after_invoice'
          ? <div className="alert alert-warn" id="tahsilat-karari" data-billing-wait={st.wait}>{t('glassBilling.wait.payment_after_invoice', { amount: fmtMoney(st.advanceRequired, 'RON') })}</div>
          : st.wait && <p className="small muted" data-billing-wait={st.wait}>{t(`glassBilling.wait.${st.wait}` as MsgKey)}</p>}
      {/* Nihai fatura onaylı yüklemeden (karar 239): her onaylı yüklemenin fatura durumu ve Faturalama kartı */}
      {loadings.length > 0 && (
        <div className="fx-block" id="nihai-fatura">
          <h3>{t('glassBilling.final.title')}</h3>
          <ul className="small">
            {loadings.map((l) => (
              <li key={l.day} data-loading-day={l.day} data-invoice-state={l.batch ? l.batch.status : 'OPEN'}>
                {fmtDate(l.day)} —{' '}
                {l.batch
                  ? l.batch.document
                    ? <FgoDocLink link={l.batch.document.link}>{l.batch.document.series}{l.batch.document.number}</FgoDocLink>
                    : t(`accounting.batch.status.${l.batch.status}` as MsgKey)
                  : t('glassBilling.final.open')}{' '}
                <a href={`/yuklemeler?gun=${l.day}#faturalama`}>{t('glassBilling.final.go')}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lastJob?.status === 'FAILED' && <div className="alert alert-error">{t('glassBilling.failed', { error: lastJob.lastError ?? '—' })}</div>}
      {parked
        ? <div className="alert alert-warn" data-fgo-uncertain>{t('glassBilling.uncertain')} <a href="#belirsiz">{t('finance.uncertain.title')}</a></div>
        : lastJob?.status === 'PENDING' && lastJob.lastError && <div className="alert alert-warn">{t('glassBilling.retry', { error: lastJob.lastError })}</div>}
      {/* Müşteri e-postası (yalnızca TAKİP gönderir): kapatılmış iş yalnızca "e-posta yok" ise gösterilir */}
      {lastMail && (lastMail.status !== 'SKIPPED' || lastMail.lastError === 'NO_EMAIL') && (
        <p className="small">
          <b>{t('glassBilling.mail')}:</b>{' '}
          {lastMail.status === 'SENT' ? t('glassBilling.mailSent', { date: fmtDateTime(lastMail.sentAt) })
            : lastMail.status === 'FAILED' ? <span className="danger">{t('glassBilling.mailFailed', { error: lastMail.lastError ?? '—' })}</span>
              : lastMail.status === 'SKIPPED' ? <span className="danger">{t('accounting.receivables.email.NO_EMAIL')}</span>
                : t('glassBilling.mailPending')}
        </p>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {st.actions.filter((a): a is keyof typeof KIND_ACTION => a in KIND_ACTION).map((a) => (
          <form key={a} action={glassDocumentAction} className="row">
            {hidden}
            <input type="hidden" name="kind" value={KIND_ACTION[a]} />
            {/* Elle kur: yalnızca kuru bu belge belirleyecekse; doldurulursa belge MANUAL diye işaretlenir */}
            {askRate && a !== 'advance' && (
              <span className="fx-manual">
                <label htmlFor={`gb-rate-${a}`} style={{ margin: 0 }}>{t('fx.manualLabel')}</label>
                <input id={`gb-rate-${a}`} name="fxRate" inputMode="decimal" maxLength={10} style={{ width: 110 }} title={t('fx.manualHint')} />
              </span>
            )}
            {a === 'advance' && <DuplicateAck lines={matchLines(t, risk.matches as MatchView[])} ackKey={risk.ackKey} texts={dupTexts(t)} id="gb-ack" />}
            <ConfirmButton primary message={t(`glassBilling.confirm.${a}` as MsgKey, { amount: fmtMoney(st.advanceRequired, 'RON'), basis: t(`finance.badge.${st.basis}` as MsgKey) })}>{t(`glassBilling.button.${a}` as MsgKey)}</ConfirmButton>
          </form>
        ))}
      </div>
    </div>
  );
}
