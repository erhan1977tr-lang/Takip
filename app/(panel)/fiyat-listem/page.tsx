import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { LiveSearch } from '@/components/LiveSearch';
import { customerPriceList } from '@/server/pricing/customer-price-list.js';

export const dynamic = 'force-dynamic';

/**
 * Müşteri: "Fiyat listem" (karar 333) — firmanın KENDİ müşteri fiyat tablosu, salt okunur, kullanıcının dilinde.
 * Yalnızca müşteri rolü (OWN_PRICE_LIST_VIEW); firma oturumdan alınır, adres / arama değeri firmayı ya da tabloyu
 * seçemez. Fabrika / satış fiyat tabloları bu sayfanın kaynağında yoktur (server/pricing/customer-price-list.js).
 */
export default async function PriceListPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requirePermission('OWN_PRICE_LIST_VIEW');
  const { t, locale } = await getT();
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 100) : '';
  const list = await customerPriceList(db, user.customerId, locale);
  const needle = q.toLocaleLowerCase(locale === 'tr' ? 'tr-TR' : 'ro-RO');
  const rows = needle ? list.rows.filter((r) => r.label.toLocaleLowerCase(locale === 'tr' ? 'tr-TR' : 'ro-RO').includes(needle)) : list.rows;
  return (
    <>
      <div className="page-head">
        <h1>{t('priceList.title')}</h1>
        <p className="muted">{t('priceList.intro')}</p>
      </div>
      <div className="card card-flush" id="fiyat-listem">
        {list.rows.length === 0 ? <div className="empty" data-price-list-empty>{t('priceList.empty')}</div> : (
          <>
            <div className="card-head row">
              <form className="card-filter">
                <LiveSearch defaultValue={q} placeholder={t('priceList.search')} label={t('priceList.search')} searching={t('common.searching')} />
                <button className="btn" type="submit">{t('common.search')}</button>
              </form>
            </div>
            {rows.length === 0 ? <div className="empty">{t('priceList.noMatch')}</div> : (
              <div className="table-wrap">
                <table className="price-list">
                  <thead>
                    <tr>
                      <th>{t('priceList.cols.glass')}</th>
                      <th className="num">{t('priceList.cols.price', { cur: list.currency ?? '' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${i}-${r.label}`} data-price-row>
                        <td className="pl-glass">{r.label}</td>
                        <td className="num nowrap"><b>{fmtNum(r.price)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="card-note">{t('priceList.note')}</p>
          </>
        )}
      </div>
    </>
  );
}
