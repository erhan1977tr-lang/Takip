import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { assignProfileTableAction, saveProfileTableAction, saveProfileTablePricesAction, toggleProfileTableAction } from './actions';

export const dynamic = 'force-dynamic';

const MSG: Record<string, [string, MsgKey]> = {
  created: ['ok', 'profile.prices.msg.created'],
  saved: ['ok', 'profile.prices.msg.saved'],
  assigned: ['ok', 'profile.prices.msg.assigned'],
  exists: ['error', 'profile.prices.msg.exists'],
  not_found: ['error', 'profile.prices.msg.notFound'],
  bad_price: ['error', 'profile.prices.msg.badPrice'],
  name: ['error', 'profile.prices.msg.name'],
};

// Müşteriye özel profil fiyat tabloları (Aşama 6): tablo, ürün fiyatları, bağlı firmalar.
export default async function ProfilePricesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('PRICE_TABLE_MANAGE');
  const { t, locale } = await getT();
  const sp = await searchParams;
  const tables = await db.profilePriceTable.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { items: true, customers: true } } } });
  const table = sp.tablo ? await db.profilePriceTable.findUnique({ where: { id: sp.tablo }, include: { items: true } }) : null;
  const [products, firms] = table ? await Promise.all([
    db.profileProduct.findMany({ where: { isActive: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }], include: { category: true } }),
    db.customer.findMany({ where: { type: 'CUSTOMER' }, orderBy: { name: 'asc' }, include: { profilePriceTable: { select: { id: true, name: true } } } }),
  ]) : [[], []];
  const price = new Map((table?.items ?? []).map((i) => [i.productId, Number(i.unitPrice)]));
  const code = sp.ok ?? sp.error ?? '';
  const msg = code === 'prices' ? (['ok', 'profile.prices.msg.pricesSaved'] as [string, MsgKey]) : Object.hasOwn(MSG, code) ? MSG[code] : undefined;

  return (
    <>
      <div className="page-head">
        <h1>{t('profile.prices.title')}</h1>
        <p className="muted">{t('profile.prices.intro')}</p>
      </div>
      {msg && <div className={`alert ${msg[0] === 'ok' ? 'alert-ok' : 'alert-error'}`}>{t(msg[1], { n: Number(sp.n) || 0 })}</div>}

      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('profile.prices.tables')} <span className="badge">{tables.length}</span></h2></div>
        {tables.length === 0 ? <div className="empty">{t('profile.prices.none')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('profile.prices.col.name')}</th><th className="num">{t('profile.prices.col.priced')}</th><th className="num">{t('profile.prices.col.firms')}</th><th>{t('profile.prices.col.status')}</th><th /></tr></thead>
              <tbody>
                {tables.map((x) => (
                  <tr key={x.id} className={x.id === table?.id ? 'picked' : undefined}>
                    <td><b>{x.name}</b></td>
                    <td className="num">{x._count.items}</td>
                    <td className="num">{x._count.customers}</td>
                    <td>{x.isActive ? <span className="badge badge-ok">{t('profile.prices.active')}</span> : <span className="badge badge-muted">{t('profile.prices.inactive')}</span>}</td>
                    <td className="actions">
                      <Link className="btn" href={`/admin/profil-fiyatlari?tablo=${x.id}`}>{t('profile.prices.open')}</Link>
                      <form action={toggleProfileTableAction}>
                        <input type="hidden" name="tableId" value={x.id} />
                        <button className="btn btn-link">{x.isActive ? t('profile.prices.deactivate') : t('profile.prices.activate')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form action={saveProfileTableAction} className="row" style={{ padding: 12 }}>
          <label htmlFor="pt-new" style={{ margin: 0 }}>{t('profile.prices.name')}</label>
          <input id="pt-new" name="name" required maxLength={120} placeholder={t('profile.prices.namePlaceholder')} style={{ flex: 1 }} />
          <button className="btn btn-primary">{t('profile.prices.create')}</button>
        </form>
      </div>

      {table && (
        <>
          <form action={saveProfileTableAction} className="card row">
            <input type="hidden" name="tableId" value={table.id} />
            <label htmlFor="pt-name" style={{ margin: 0 }}>{t('profile.prices.name')}</label>
            <input id="pt-name" name="name" required maxLength={120} defaultValue={table.name} style={{ flex: 1 }} />
            <button className="btn">{t('profile.prices.rename')}</button>
          </form>

          <form action={saveProfileTablePricesAction} className="card card-flush">
            <input type="hidden" name="tableId" value={table.id} />
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('profile.prices.pricesTitle', { name: table.name })}</h2>
              <span className="muted small">{t('profile.prices.pricesIntro')}</span>
            </div>
            <div className="table-wrap">
              <table className="profile-table">
                <thead><tr><th>{t('profile.prices.colProduct')}</th><th className="num">{t('profile.prices.colList')}</th><th className="num">{t('profile.prices.colPrice')}</th></tr></thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id}>
                      <td><b>{locale === 'tr' ? p.nameTr : p.nameRo}</b> <span className="muted small mono">{p.code}</span></td>
                      <td className="num muted">{p.listPrice != null ? fmtNum(p.listPrice.toString()) : '—'}</td>
                      <td className="num">
                        <input type="hidden" name="p_id" value={p.id} />
                        <input name="p_price" inputMode="decimal" className="price-input" defaultValue={price.has(p.id) ? price.get(p.id)!.toFixed(2) : ''} aria-label={`${p.code} — ${t('profile.prices.colPrice')}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row end" style={{ padding: 12 }}><button className="btn btn-primary">{t('profile.prices.save')}</button></div>
          </form>

          <div className="card card-flush" id="firmalar">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{t('profile.prices.firmsTitle', { name: table.name })}</h2>
              <span className="muted small">{t('profile.prices.firmsIntro')}</span>
            </div>
            {firms.length === 0 ? <div className="empty">{t('profile.prices.noFirms')}</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('profile.prices.colFirm')}</th><th>{t('profile.prices.colTable')}</th><th /></tr></thead>
                  <tbody>
                    {firms.map((f) => {
                      const mine = f.profilePriceTableId === table.id;
                      return (
                        <tr key={f.id} className={mine ? 'picked' : undefined}>
                          <td>{f.name} <span className="muted small mono">{f.prefix}</span></td>
                          <td>{f.profilePriceTable?.name ?? <span className="muted">{t('profile.prices.listOnly')}</span>}</td>
                          <td className="actions">
                            <form action={assignProfileTableAction}>
                              <input type="hidden" name="tableId" value={table.id} />
                              <input type="hidden" name="customerId" value={f.id} />
                              <input type="hidden" name="intent" value={mine ? 'unassign' : 'assign'} />
                              <button className={mine ? 'btn btn-link danger' : 'btn'}>{mine ? t('profile.prices.unassign') : t('profile.prices.assign')}</button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
