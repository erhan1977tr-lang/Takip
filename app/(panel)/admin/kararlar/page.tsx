import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/format';
import { resolveAlertAction } from './actions';
import { unitLabel } from '@/server/profile/catalog.js';

type Diff = { line: number; kind: string; description: string; listPrice: number; unitPrice: number; free: boolean };
/**
 * Telafi camı uyarıları (karar 108, 157): glass = adet × cam, tier = kararın fiyat kademesi, normal / price = o kademedeki
 * fiyatlar (price boş: yönetici belirleyecek), mode = karar (bedelsiz / aynı fiyat / farklı fiyat), direct = teklif
 * yöneticiye uğramadan müşteriye gitti, source = kaynak siparişin adedi (düştüyse önce → sonra; düşmediyse nedeni).
 */
type Details = {
  orderNo?: string; currency?: string; lines?: Diff[]; error?: string; compensationId?: string; glass?: string; tier?: 'CUSTOMER' | 'SALES'; mode?: string;
  normal?: number | null; price?: number | null; destOrderNo?: string; day?: string; direct?: boolean;
  source?: { reduced?: boolean; reason?: string | null; before?: number | null; after?: number | null };
  /** Stok yetersizliği (karar 165): sipariş anındaki gereken / mevcut / eksik */
  stock?: { code?: string; nameTr?: string; nameRo?: string; unitCode?: string; qty?: number; stock?: number; missing?: number }[];
  /** Kritik stok (karar 177): ürün, o anki stok (level), eşik, neden (giriş / sayım / depo çıkışı / eşik değişikliği) */
  productId?: string; code?: string; nameTr?: string; nameRo?: string; unitCode?: string; level?: number; threshold?: number; cause?: string;
  /** Finans (Paket 10): FINANCE_REVIEW (code, proforma, FGO / elle tutarlar), DUPLICATE_RISK (subject, amountRon, matches),
   * FGO_UNCERTAIN (kind, idExtern, expectedGross); müşteri proforması zincirinde sipariş yok → customerId */
  proforma?: string | null; fgoPaid?: number; manualRon?: number; subject?: string; amountRon?: number;
  matches?: { ref?: string | null; orderNo?: string | null; kind?: string }[]; kind?: string; idExtern?: string; expectedGross?: number; customerId?: string | null;
};
const FINANCE_CODES = ['MISMATCH', 'OVERPAID', 'MANUAL_UNVERIFIED', 'FGO_PAID_CANCELLED'];
const UNC_KINDS = ['PROFORMA', 'ADVANCE', 'INVOICE', 'FGO_PROFORMA', 'FGO_INVOICE'];
/** Finans kaydının açılacağı yer: siparişin Ödemeler kartı / belirsiz kutusu ya da (sipariş yoksa) müşteri proforması sayfası */
const financeHref = (type: string, orderId: string | null, d: Details) => {
  const at = type === 'FGO_UNCERTAIN' ? 'belirsiz' : 'odemeler';
  if (orderId) return `/siparisler/${orderId}#${at}`;
  const c = typeof d.customerId === 'string' && /^[a-z0-9]{8,40}$/i.test(d.customerId) ? `?musteri=${d.customerId}` : '';
  return `/admin/muhasebe/cam/proforma${c}#${type === 'FGO_UNCERTAIN' ? 'belirsiz' : 'partiler'}`;
};
const FINANCE_TYPES = ['FINANCE_REVIEW', 'DUPLICATE_RISK', 'FGO_UNCERTAIN'];
const CRITICAL_SOURCES = ['GIRIS', 'SAYIM', 'CIKIS', 'THRESHOLD'];
const COMP_MODES = ['FREE', 'NORMAL', 'CUSTOM'];
const SOURCE_REASONS = ['LOADED', 'BILLING', 'CLOSED'];

// Önemli kararlar: bir insan kararı bekleyen durumlar (şimdilik: satışçı liste fiyatını değiştirdi).
export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('ALERT_VIEW');
  // Kritik stok satırından tedarikçi siparişi hazırlama (Paket 6, karar 184) — yalnızca SUPPLIER_MANAGE
  const supply = userCan(user, 'SUPPLIER_MANAGE');
  const { t, locale } = await getT();
  const sp = await searchParams;
  const include = {
    order: { select: { id: true, orderNo: true } },
    createdBy: { select: { name: true } },
    resolvedBy: { select: { name: true } },
  } as const;
  const [open, closed] = await Promise.all([
    db.adminAlert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: 'desc' }, include, take: 200 }),
    db.adminAlert.findMany({ where: { resolvedAt: { not: null } }, orderBy: { resolvedAt: 'desc' }, include, take: 20 }),
  ]);

  const what = (a: (typeof open)[number]) => {
    const d = (a.details ?? {}) as Details;
    return (
      <>
        <b>{t(`pricing.alerts.type.${a.type}` as MsgKey)}</b>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {(d.lines ?? []).map((l) => (
            <li key={l.line}>
              {t('pricing.alerts.line', {
                n: l.line, kind: l.kind === 'CAM' ? t('pricing.alerts.kindGlass') : t(`status.lineKind.${l.kind}` as MsgKey),
                desc: l.description, list: fmtNum(l.listPrice), price: l.free ? t('pricing.alerts.free') : fmtNum(l.unitPrice), cur: l.free ? '' : d.currency ?? '',
              })}
            </li>
          ))}
          {d.error && a.type !== 'FGO_UNCERTAIN' && <li>{t('pricing.alerts.error', { error: d.error })}</li>}
          {a.type === 'FINANCE_REVIEW' && d.code && FINANCE_CODES.includes(d.code) && (
            <li data-finance-review={d.code}>
              {t(`finance.alerts.review.${d.code}` as MsgKey, { fgo: fmtMoney(d.fgoPaid ?? 0, 'RON'), manual: fmtMoney(d.manualRon ?? 0, 'RON') })}
              {d.proforma && <span className="muted"> · {t('finance.alerts.proforma', { ref: d.proforma })}</span>}
            </li>
          )}
          {a.type === 'DUPLICATE_RISK' && (
            <li data-duplicate-alert={d.subject}>
              {t('finance.alerts.dup', {
                subject: t(`finance.alerts.subject.${d.subject === 'PAYMENT' ? 'PAYMENT' : 'ADVANCE'}` as MsgKey), amount: fmtMoney(d.amountRon ?? 0, 'RON'),
                list: (Array.isArray(d.matches) ? d.matches : []).map((x) => x.ref || x.orderNo || '—').join(', '),
              })}
            </li>
          )}
          {a.type === 'FGO_UNCERTAIN' && (
            <li data-uncertain-alert={d.idExtern}>
              {t('finance.alerts.uncertain', {
                kind: t(`finance.uncertain.kinds.${UNC_KINDS.includes(d.kind ?? '') ? d.kind : 'INVOICE'}` as MsgKey), ref: d.idExtern ?? '—', amount: fmtMoney(d.expectedGross ?? 0, 'RON'),
              })}
            </li>
          )}
          {a.type === 'STOCK_CRITICAL' && (
            <li data-critical={d.code}>
              {t('pricing.alerts.criticalLine', {
                code: d.code ?? '', name: (locale === 'tr' ? d.nameTr : d.nameRo) ?? '', stock: d.level ?? 0, threshold: d.threshold ?? 0, unit: unitLabel(d.unitCode ?? '', locale),
              })}
              {d.cause && CRITICAL_SOURCES.includes(d.cause) && <span className="muted"> · {t(`pricing.alerts.criticalSource.${d.cause}` as MsgKey, { orderNo: d.orderNo ?? '' })}</span>}
            </li>
          )}
          {(Array.isArray(d.stock) ? d.stock : []).map((l, i) => (
            <li key={`s${i}`} data-stock-line={l.code}>
              {t('pricing.alerts.stockLine', {
                code: l.code ?? '', name: (locale === 'tr' ? l.nameTr : l.nameRo) ?? '', qty: l.qty ?? 0, unit: unitLabel(l.unitCode ?? '', locale),
                stock: l.stock ?? 0, missing: l.missing ?? 0,
              })}
            </li>
          ))}
          {d.compensationId && (
            <li>{t('pricing.alerts.comp', { glass: d.glass ?? '', dest: d.destOrderNo ?? '—', date: d.day ? fmtDate(`${d.day}T12:00:00Z`) : '—' })}</li>
          )}
          {/* Karar (bedelsiz / aynı fiyat / farklı fiyat) — eski kayıtlarda yoksa satır yazılmaz */}
          {d.compensationId && d.mode && COMP_MODES.includes(d.mode) && (
            <li data-comp-mode={d.mode}>
              {t('pricing.alerts.compMode', { mode: t(`pricing.alerts.compModes.${d.mode}` as MsgKey) })}{d.direct ? ` — ${t('pricing.alerts.compDirect')}` : ''}
            </li>
          )}
          {d.compensationId && (a.type === 'COMPENSATION_PRICE' || d.mode === 'CUSTOM') && (
            <li>
              {t('pricing.alerts.compPrice', {
                normal: d.normal == null ? '—' : `${fmtNum(d.normal)} ${d.currency ?? ''}/m²`,
                price: d.mode === 'FREE' || d.price === 0 ? t('pricing.alerts.compFree') : d.price == null ? (d.mode === 'CUSTOM' ? t('pricing.alerts.compToPrice') : '—') : `${fmtNum(d.price)} ${d.currency ?? ''}/m²`,
              })}{d.tier ? ` (${t(`pricing.alerts.compTier.${d.tier}` as MsgKey)})` : ''}
            </li>
          )}
          {/* Kaynak siparişin adedi (karar 157) */}
          {d.compensationId && d.source && (d.source.reduced
            ? <li data-comp-source="dustu">{t('pricing.alerts.compSource', { before: d.source.before ?? '—', after: d.source.after ?? '—' })}</li>
            : d.source.reason && SOURCE_REASONS.includes(d.source.reason)
              ? <li data-comp-source={d.source.reason}>{t('pricing.alerts.compSourceKept', { reason: t(`pricing.alerts.compSourceReason.${d.source.reason}` as MsgKey) })}</li>
              : a.type === 'COMPENSATION_PENDING' ? <li data-comp-source="PENDING">{t('pricing.alerts.compSourcePending')}</li> : null)}
        </ul>
      </>
    );
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('pricing.alerts.title')}</h1>
        <p className="muted">{t('pricing.alerts.intro')}</p>
      </div>
      {sp.ok === 'resolved' && <div className="alert alert-ok">{t('pricing.alerts.resolved')}</div>}
      <div className="card card-flush">
        <div className="card-head"><h2>{t('pricing.alerts.title')} <span className={`badge ${open.length ? 'badge-danger' : ''}`}>{open.length}</span></h2></div>
        {open.length === 0 ? <div className="empty">{t('pricing.alerts.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('pricing.alerts.colOrder')}</th><th>{t('pricing.alerts.colWhat')}</th><th>{t('pricing.alerts.colWho')}</th><th>{t('pricing.alerts.colWhen')}</th><th /></tr></thead>
              <tbody>
                {open.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.type === 'STOCK_CRITICAL'
                        ? <Link href={`/admin/stok#s-${encodeURIComponent(((a.details ?? {}) as Details).productId ?? '')}`}>{((a.details ?? {}) as Details).code ?? '—'}</Link>
                        : a.order ? <Link href={FINANCE_TYPES.includes(a.type) ? financeHref(a.type, a.order.id, (a.details ?? {}) as Details) : `/siparisler/${a.order.id}#${a.type.startsWith('COMPENSATION') ? 'kararlar' : a.type === 'STOCK_SHORTAGE' ? 'stok' : 'teklif'}`}>{a.order.orderNo}</Link> : ((a.details ?? {}) as Details).orderNo ?? '—'}
                    </td>
                    <td>{what(a)}</td>
                    <td>{a.createdBy?.name ?? '—'}</td>
                    <td className="nowrap">{fmtDateTime(a.createdAt)}</td>
                    <td className="actions">
                      {a.type === 'STOCK_CRITICAL' && supply && /^[a-z0-9]{8,40}$/i.test(((a.details ?? {}) as Details).productId ?? '') && (
                        <Link className="btn btn-link" href={`/siparisler/tedarik/yeni?urun=${((a.details ?? {}) as Details).productId}`} data-prepare-order>{t('supplier.alerts.prepare')}</Link>
                      )}
                      {/* Finans kayıtları: kayda götüren bağlantı (belirsiz FGO belgesi "Gördüm" ile kapanmaz — karar Ödemeler kartında) */}
                      {FINANCE_TYPES.includes(a.type) && (
                        <Link className={`btn${a.type === 'FGO_UNCERTAIN' ? ' btn-primary' : ' btn-link'}`} href={financeHref(a.type, a.order?.id ?? null, (a.details ?? {}) as Details)} data-finance-open>{t('finance.alerts.open')}</Link>
                      )}
                      {a.type === 'FGO_UNCERTAIN' ? null : a.type === 'COMPENSATION_PENDING' && a.order ? (
                        // Onay bekleyen telafi "Gördüm" ile kapanmaz: karar siparişin "Önemli kararlar" kartında verilir
                        <Link className="btn btn-primary" href={`/siparisler/${a.order.id}#kararlar`}>{t('pricing.alerts.compOpen')}</Link>
                      ) : (
                        <form action={resolveAlertAction}>
                          <input type="hidden" name="alertId" value={a.id} />
                          <button className="btn">{t('pricing.alerts.resolve')}</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-flush">
        <div className="card-head"><h2>{t('pricing.alerts.historyTitle')}</h2></div>
        {closed.length === 0 ? <div className="empty">{t('pricing.alerts.historyEmpty')}</div> : (
          <div className="table-wrap">
            <table>
              <tbody>
                {closed.map((a) => (
                  <tr key={a.id}>
                    <td>{a.order ? <Link href={`/siparisler/${a.order.id}`}>{a.order.orderNo}</Link> : a.type === 'STOCK_CRITICAL' ? ((a.details ?? {}) as Details).code ?? '—' : '—'}</td>
                    <td>{what(a)}</td>
                    <td>{a.createdBy?.name ?? '—'}</td>
                    <td className="muted small">
                      {a.resolvedBy ? t('pricing.alerts.closedBy', { who: a.resolvedBy.name, when: fmtDateTime(a.resolvedAt) }) : t('pricing.alerts.superseded')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
