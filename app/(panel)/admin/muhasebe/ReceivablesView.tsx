import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { absentInFgo, backfillDocuments, listDocuments, paymentStatus, receivables, syncStatus, unitOf } from '@/server/accounting/receivables.js';
import { emailStates } from '@/server/documents/delivery.js';
import { getAccountingSettings, uninvoicedLoadings } from '@/server/accounting/uninvoiced.js';
import { ConfirmButton } from '@/components/ConfirmButton';
import { refreshFgoAction, removeDeletedDocAction, resendDocEmailAction } from './actions';

type Doc = Prisma.FgoDocumentGetPayload<{ include: {
  order: { select: { id: true; orderNo: true; status: true; customer: { select: { name: true } } } };
  batch: { select: {
    id: true; kind: true; parentId: true; loadingDays: true; customer: { select: { name: true } }; orders: { select: { orderId: true; orderNo: true } };
    confirmation: { select: { shipDay: true } }; parent: { select: { document: { select: { series: true; number: true } } } };
  } };
} }>;
const dayText = (d: Date) => new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.');
type Share = { debt: number | null; rest: number | null; replaced: boolean };
type Sums = Record<string, { total: number; paid: number; rest: number }>;

const TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok' } as const;
// Müşteri e-postası (yalnızca TAKİP gönderir — karar 111): belgenin son e-posta işinin durumu
type Mail = { state: 'SENT' | 'PENDING' | 'FAILED' | 'NO_EMAIL'; at: Date | null; error: string | null; to: string | null };
const MAIL_TONE = { SENT: 'ok', PENDING: 'muted', FAILED: 'danger', NO_EMAIL: 'warn' } as const;
const MAIL_ERRORS = ['NOT_FOUND', 'ALREADY_QUEUED', 'FORBIDDEN'];
const FILTERS = ['hepsi', 'acik', 'odendi'] as const;
const FILTER_KEY = { hepsi: 'all', acik: 'open', odendi: 'paid' } as const;
const ERRORS = ['FGO_DISABLED', 'NO_KEY', 'BUSY'];
// "TAKİP'ten kaldır" (karar 132) sonucu: belge FGO'da duruyor / doğrulanamadı (FGO kapalı, anahtar yok, geçici ya da
// belirsiz yanıt — hepsi aynı "hiçbir değişiklik yapılmadı" metni) / eşitleme sürüyor / kayıt yok
const DOC_ERRORS: Record<string, string> = {
  EXISTS: 'EXISTS', UNVERIFIED: 'UNVERIFIED', FGO_DISABLED: 'UNVERIFIED', NO_KEY: 'UNVERIFIED', CLEANUP_FAILED: 'CLEANUP_FAILED',
  BUSY: 'BUSY', NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN', CONFIRM: 'CONFIRM',
};
/** Adres çubuğundan gelen belge numarası yalnızca harf / rakamsa gösterilir */
const docLabel = (v: string | undefined) => (v && /^[A-Za-z0-9-]{1,30}$/.test(v) ? v : '');

/**
 * Profil ve Cam Tahsilat ortak ekranı: FGO belgeleri ve FGO'dan okunan ödeme durumu (yalnızca yönetici).
 * Belgelerin hepsi listelenir; toplamlar sipariş başına tek borç üzerinden (server/accounting/receivables.js → receivables).
 */
export async function ReceivablesView({ type, sp }: { type: 'PROFILE_ORDER' | 'GLASS_ORDER'; sp: Record<string, string | undefined> }) {
  const { t } = await getT();
  if (type === 'PROFILE_ORDER') await backfillDocuments(db);
  const [docs, sync] = await Promise.all([listDocuments(db, type) as Promise<Doc[]>, syncStatus(db)]);
  const mails = await emailStates(db, docs) as Map<string, Mail>;
  // "Fatura bekliyor" (karar 126): yalnızca cam — yüklenmiş, uyarı günü dolmuş, kapanış faturası kesilmemiş kapsamlar.
  // Kalıcıdır: bildirim okunsa da fatura kesilene kadar burada durur; fatura kesilince kendiliğinden kalkar.
  const accounting = type === 'GLASS_ORDER' ? await getAccountingSettings(db) : null;
  const overdue = accounting ? await uninvoicedLoadings(db, { days: accounting.uninvoicedDays }) : [];
  const key = type === 'PROFILE_ORDER' ? 'profile' : 'glass';
  const path = type === 'PROFILE_ORDER' ? '/admin/muhasebe/profil' : '/admin/muhasebe/cam';
  const r = receivables(docs) as { shares: Map<string, Share>; sums: Sums };
  const shareOf = (d: Doc) => r.shares.get(d.id) as Share;
  // Sipariş başına grup: en yeni belgesi olan sipariş önce; sipariş içinde belgeler kesim sırasıyla (proforma → fatura)
  // Borç birimi: sipariş ya da müşteri belge zinciri (müşteri proforması + avans + o proformadan düşen müşteri faturaları)
  const groups: { docs: Doc[] }[] = [];
  const byOrder = new Map<string, { docs: Doc[] }>();
  for (const d of docs) {
    const unit = unitOf(d) as string;
    let g = byOrder.get(unit);
    if (!g) {
      g = { docs: [] };
      byOrder.set(unit, g);
      groups.push(g);
    }
    g.docs.unshift(d);
  }
  const open = (g: { docs: Doc[] }) => g.docs.some((d) => { const s = shareOf(d); return s.rest == null || s.rest > 0; });
  const filter = FILTERS.find((f) => f === sp.durum) ?? 'hepsi';
  const shown = filter === 'hepsi' ? groups : groups.filter((g) => open(g) === (filter === 'acik'));
  const openDocs = docs.filter((d) => !shareOf(d).replaced && paymentStatus(d.total, d.paid) !== 'PAID').length;
  const curs = Object.keys(r.sums).sort();
  // Proformanın bir kısmı başka belgeye dönmüş: avans faturası ya da (müşteri zincirinde) yüklenen kısmın faturası
  const hasAdvance = (g: { docs: Doc[] }) => g.docs.some((d) => d.kind === 'ADVANCE' || (d.batchId != null && d.kind === 'INVOICE'));
  // Son kontrolde FGO'nun "belge yok" dediği belgeler (yönetici FGO'da elle silmiş olabilir): üstte uyarı + satırda işlem
  const absent = docs.filter((d) => absentInFgo(d));

  return (
    <>
      <div className="page-head row">
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <h1>{t(`accounting.${key}.title` as MsgKey)}</h1>
          <p className="muted">{t(`accounting.${key}.intro` as MsgKey)}</p>
        </div>
        <form action={refreshFgoAction} className="page-tools">
          <input type="hidden" name="type" value={type} />
          {type === 'GLASS_ORDER' && <Link className="btn" href="/admin/muhasebe/cam/proforma">{t('accounting.batch.open')}</Link>}
          <button className="btn btn-primary" disabled={docs.length === 0}>{t('accounting.receivables.refresh')}</button>
        </form>
      </div>
      {sp.ok === 'refreshed' && <div className="alert alert-ok">{t('accounting.receivables.refreshed', { n: sp.n ?? '0', f: sp.f ?? '0' })}</div>}
      {sp.error && <div className="alert alert-error">{t(`accounting.receivables.errors.${ERRORS.includes(sp.error) ? sp.error : 'FGO_DISABLED'}` as MsgKey)}</div>}
      {sp.ok === 'docRemoved' && <div className="alert alert-ok" id="doc-removed">{t('accounting.receivables.remove.removed', { doc: docLabel(sp.doc) })}</div>}
      {sp.docError && <div className="alert alert-error" id="doc-remove-error">{t(`accounting.receivables.remove.errors.${DOC_ERRORS[sp.docError] ?? 'UNVERIFIED'}` as MsgKey, { doc: docLabel(sp.doc) })}</div>}
      {absent.length > 0 && (
        <div className="alert alert-warn" id="fgo-absent">
          {t('accounting.receivables.remove.banner', { n: absent.length })}{' '}
          {absent.map((d, n) => <span key={d.id}>{n > 0 && ', '}<a className="mono" href={`${path}#doc-${d.id}`}>{d.series}{d.number}</a></span>)}
          {'. '}{t('accounting.receivables.remove.bannerHint')}
        </div>
      )}
      {sp.ok === 'resent' && <div className="alert alert-ok">{t('accounting.receivables.email.resent')}</div>}
      {sp.mailError && <div className="alert alert-error">{t(`accounting.receivables.email.errors.${MAIL_ERRORS.includes(sp.mailError) ? sp.mailError : 'NOT_FOUND'}` as MsgKey)}</div>}

      {overdue.length > 0 && (
        <div className="card card-flush" id="fatura-bekliyor">
          <div className="card-head">
            <h2><span className="text-danger">{t('accounting.overdue.title')}</span> <span className="badge badge-danger">{overdue.length}</span></h2>
          </div>
          <div className="card-tools"><span className="muted small">{t('accounting.overdue.intro', { days: accounting?.uninvoicedDays ?? 0 })}</span></div>
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('accounting.overdue.col.order')}</th>
                  <th>{t('accounting.overdue.col.loaded')}</th>
                  <th>{t('accounting.overdue.col.waiting')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overdue.map((o) => (
                  <tr key={`${o.confirmationId}-${o.orderId}`} data-overdue={o.orderNo}>
                    <td>
                      <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link> · {o.customerName}
                      {o.removed && <> <Badge tone="muted">{t('accounting.overdue.removed')}</Badge></>}
                    </td>
                    <td className="nowrap">{t('accounting.overdue.loaded', { date: dayText(new Date(`${o.day}T00:00:00Z`)) })}</td>
                    <td>
                      <Badge tone="danger">{t('accounting.overdue.days', { n: o.daysSince })}</Badge>
                      {o.note && <span className="cell-note">{t(`accounting.overdue.note.${o.note}` as MsgKey)}</span>}
                    </td>
                    <td className="actions">
                      {o.note === 'ORDER_CHAIN'
                        ? <Link className="btn" href={`/siparisler/${o.orderId}#finans`}>{t('accounting.overdue.openOrder')}</Link>
                        : <Link className="btn" href={`/yuklemeler?gun=${o.day}#faturalama`}>{t('accounting.overdue.open')}</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Özet: para birimi başına (para birimleri toplanmaz) */}
      {curs.map((cur, i) => {
        const s = r.sums[cur];
        return (
          <div className="stats stats-money" key={cur}>
            <div className="stat">
              <div className="k">{t('accounting.receivables.stat.total', { cur })}</div>
              <div className="v">{fmtNum(s.total)}</div>
            </div>
            <div className="stat stat-ok">
              <div className="k">{t('accounting.receivables.stat.paid', { cur })}</div>
              <div className="v">{fmtNum(s.paid)}</div>
            </div>
            <div className={`stat ${s.rest > 0 ? 'stat-danger' : 'stat-ok'}`}>
              <div className="k">{t('accounting.receivables.stat.rest', { cur })}</div>
              <div className="v">{fmtNum(s.rest)}</div>
            </div>
            {i === 0 && (
              <div className="stat stat-muted">
                <div className="k">{t('accounting.receivables.stat.open')}</div>
                <div className="v">{openDocs}</div>
                <div className="muted small">{t('accounting.receivables.stat.openHint')}</div>
              </div>
            )}
          </div>
        );
      })}

      <div className="card card-flush">
        <div className="card-head">
          <h2>{t('accounting.receivables.listTitle')} <span className="badge">{docs.length}</span></h2>
        </div>
        {docs.length > 0 && (
          <div className="card-tools">
            {FILTERS.map((f) => (
              <Link key={f} className={filter === f ? 'active' : undefined} href={f === 'hepsi' ? path : `${path}?durum=${f}`}>
                {t(`accounting.receivables.filter.${FILTER_KEY[f]}` as MsgKey)}
              </Link>
            ))}
          </div>
        )}
        {docs.length === 0 ? <div className="empty">{t(`accounting.${key}.empty` as MsgKey)}</div>
          : shown.length === 0 ? <div className="empty">{t('accounting.receivables.noMatch')}</div> : (
            <div className="table-wrap">
              <table className="acc-table">
                <thead>
                  <tr>
                    <th>{t('accounting.receivables.col.order')}</th>
                    <th>{t('accounting.receivables.col.customer')}</th>
                    <th>{t('accounting.receivables.col.doc')}</th>
                    <th>{t('accounting.receivables.col.kind')}</th>
                    <th>{t('accounting.receivables.col.date')}</th>
                    <th className="num">{t('accounting.receivables.col.total')}</th>
                    <th className="num">{t('accounting.receivables.col.paid')}</th>
                    <th className="num">{t('accounting.receivables.col.rest')}</th>
                    <th>{t('accounting.receivables.col.status')}</th>
                    <th>{t('accounting.receivables.col.email')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((g) => g.docs.map((d, i) => {
                    const st = paymentStatus(d.total, d.paid);
                    const s = shareOf(d);
                    const partly = d.kind === 'PROFORMA' && !s.replaced && hasAdvance(g);
                    const mail = mails.get(d.id) ?? null;
                    const gone = absentInFgo(d);
                    return (
                      <tr key={d.id} id={`doc-${d.id}`} data-doc={`${d.series}${d.number}`} className={i === 0 ? 'grp-first' : undefined}>
                        <td>
                          {i === 0 && d.order && <Link className="order-no" href={`/siparisler/${d.order.id}`}>{d.order.orderNo}</Link>}
                          {/* Müşteri belgesi (her satırda): kaynak siparişler; proformada seçilen yükleme günleri, faturada onaylı yükleme günü, avansta kaynak proforma */}
                          {d.batch && (
                            <>
                              {d.batch.orders.map((o, n) => <span key={o.orderId}>{n > 0 && ', '}<Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link></span>)}
                              <span className="cell-note">
                                {d.batch.kind === 'INVOICE' ? t('accounting.invoice.docNote.INVOICE', { day: d.batch.confirmation ? dayText(d.batch.confirmation.shipDay) : '—' })
                                  : d.batch.kind === 'ADVANCE' ? t('accounting.invoice.docNote.ADVANCE', { ref: d.batch.parent?.document ? `${d.batch.parent.document.series}${d.batch.parent.document.number}` : '—' })
                                    : `${t('accounting.batch.docNote')} · ${t('accounting.batch.docDays', { days: d.batch.loadingDays.map(dayText).join(', ') })}`}
                              </span>
                            </>
                          )}
                        </td>
                        <td>{i === 0 && (d.order?.customer.name ?? d.batch?.customer.name)}</td>
                        <td className="mono">{d.link ? <a href={d.link} target="_blank" rel="noopener noreferrer">{d.series}{d.number}</a> : `${d.series}${d.number}`}</td>
                        <td>{t(`accounting.receivables.kind.${['INVOICE', 'ADVANCE'].includes(d.kind) ? d.kind : 'PROFORMA'}` as MsgKey)}</td>
                        <td className="nowrap">{fmtDate(d.issuedAt)}</td>
                        <td className="num">{d.total != null ? fmtMoney(d.total.toString(), d.currency) : '—'}</td>
                        <td className="num">{d.paid != null ? fmtMoney(d.paid.toString(), d.currency) : '—'}</td>
                        <td className="num">
                          {s.replaced || s.rest == null ? <span className="muted">—</span> : <b>{fmtMoney(s.rest, d.currency)}</b>}
                          {partly && <span className="cell-note">{t('accounting.receivables.partlyInvoiced')}</span>}
                        </td>
                        {/* Ödeme durumu + altında FGO'dan son okunduğu an (ayrı sütun yerine: tablo ekrana sığsın) */}
                        <td>
                          {s.replaced
                            ? <Badge tone="muted">{t('accounting.receivables.replaced')}</Badge>
                            : <Badge tone={TONE[st]}>{t(`accounting.receivables.status.${st}` as MsgKey)}</Badge>}
                          <span className="cell-note nowrap" title={t('accounting.receivables.col.checked')}>FGO · {d.checkedAt ? fmtDateTime(d.checkedAt) : '—'}</span>
                          {d.checkError && !gone && <span className="cell-note text-danger" title={d.checkError}>{t('accounting.receivables.checkError')}</span>}
                          {/* FGO "belge yok" dedi: yalnızca TAKİP kaydını kaldırma (önce FGO'ya yeniden sorulur; FGO'da hiçbir şey silinmez) */}
                          {gone && (
                            <form action={removeDeletedDocAction} className="doc-absent" title={t('accounting.receivables.remove.title')}>
                              <input type="hidden" name="type" value={type} />
                              <input type="hidden" name="docId" value={d.id} />
                              <span className="cell-note text-danger">{t('accounting.receivables.remove.gone')}</span>
                              <ConfirmButton danger name="confirmed" value="1" message={t('accounting.receivables.remove.confirm', { doc: `${d.series}${d.number}` })}>{t('accounting.receivables.remove.button')}</ConfirmButton>
                            </form>
                          )}
                        </td>
                        {/* Müşteri e-postası: durum + yalnızca e-postayı yeniden gönderme (FGO'da belge KESMEZ) */}
                        <td className="doc-mail small" data-mail={mail?.state ?? 'NONE'}>
                          {mail
                            ? <span title={mail.state === 'NO_EMAIL' ? t('accounting.receivables.email.noEmailHint') : mail.error ?? mail.to ?? undefined}><Badge tone={MAIL_TONE[mail.state]}>{t(`accounting.receivables.email.${mail.state}` as MsgKey)}</Badge></span>
                            : <span className="muted">{t('accounting.receivables.email.none')}</span>}
                          {mail?.state !== 'PENDING' && (
                            <form action={resendDocEmailAction} title={t('accounting.receivables.email.resendTitle')}>
                              <input type="hidden" name="type" value={type} />
                              <input type="hidden" name="docId" value={d.id} />
                              <ConfirmButton message={t('accounting.receivables.email.resendConfirm', { doc: `${d.series}${d.number}` })}>{t('accounting.receivables.email.resend')}</ConfirmButton>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  }))}
                </tbody>
              </table>
            </div>
          )}
        <p className="card-note">
          {t('accounting.receivables.sumNote')}{' '}{type === 'GLASS_ORDER' && `${t('accounting.invoice.sumNote')} `}{t('accounting.receivables.email.note')}{' '}
          {sync.lastRun
            ? t('accounting.receivables.auto', { at: fmtDateTime(sync.lastRun), n: sync.checked ?? 0, f: sync.failed ?? 0 })
            : t('accounting.receivables.autoNever')}
        </p>
      </div>
    </>
  );
}
