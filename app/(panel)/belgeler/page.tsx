import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { customerDocuments } from '@/server/documents/customer.js';

export const dynamic = 'force-dynamic';

const TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok', REPLACED: 'muted' } as const;

/**
 * Müşteri: "Documente financiare" (karar 111) — firmanın FGO'da kesilmiş proforma / avans faturası / faturaları (cam ve
 * profil birlikte). Salt okunur belge dolabı: liste muhasebenin kayıtlarından (FgoDocument), ödeme durumu mevcut FGO
 * eşitlemesinden okunur; bu sayfa FGO'ya istek göndermez. PDF yalnızca "Vezi PDF" tıklanınca, sunucu üzerinden açılır
 * (belgeler/[id]/pdf — sahiplik orada yeniden denetlenir).
 */
export default async function FinanceDocumentsPage() {
  // Müşteri hesabı yetkisi (yalnızca müşteri rolünde): iç roller bu sayfayı açamaz; belgeler ayrıca firmaya göre süzülür
  const user = await requirePermission('ACCOUNT_SETTINGS');
  const { t } = await getT();
  const docs = await customerDocuments(db, user.customerId);
  return (
    <>
      <div className="page-head">
        <h1>{t('documents.title')}</h1>
        <p className="muted">{t('documents.intro')}</p>
      </div>
      <div className="card card-flush" id="belgeler">
        {docs.length === 0 ? <div className="empty">{t('documents.empty')}</div> : (
          <div className="table-wrap">
            <table className="doc-table">
              <thead>
                <tr>
                  <th>{t('documents.cols.kind')}</th>
                  <th>{t('documents.cols.number')}</th>
                  <th>{t('documents.cols.date')}</th>
                  <th>{t('documents.cols.orders')}</th>
                  <th className="num">{t('documents.cols.total')}</th>
                  <th>{t('documents.cols.currency')}</th>
                  <th>{t('documents.cols.payment')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} id={`doc-${d.id}`} data-doc={d.ref}>
                    <td>{t(`documents.kind.${d.kind}` as MsgKey)}</td>
                    <td className="mono">{d.ref}</td>
                    <td className="nowrap">{fmtDate(d.issuedAt)}</td>
                    <td>
                      {d.orders.map((o, i) => (
                        <span key={o.orderNo}>
                          {i > 0 && ', '}
                          {o.id ? <Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link> : <span className="order-no">{o.orderNo}</span>}
                        </span>
                      ))}
                    </td>
                    <td className="num">{d.total != null ? <b>{fmtNum(d.total)}</b> : '—'}</td>
                    <td>{d.currency}</td>
                    <td><Badge tone={TONE[d.payment]}>{t(`documents.payment.${d.payment}` as MsgKey)}</Badge></td>
                    <td className="actions"><a className="btn" href={`/belgeler/${d.id}/pdf`} target="_blank" rel="noopener noreferrer">{t('documents.viewPdf')}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {docs.length > 0 && <p className="card-note">{t('documents.totalNote')}</p>}
      </div>
    </>
  );
}
