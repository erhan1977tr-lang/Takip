import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { fmtDec } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { expectedSupplyMap, listSuppliers } from '@/server/suppliers/service.js';
import { catalogPrice, orderUnitOf } from '@/server/suppliers/rules.js';
import { reservedLevels, stockLevels, stockRowStatus } from '@/server/profile/stock.js';
import { localName, unitLabel } from '@/server/profile/catalog.js';
import { createOrderAction } from '../actions';
import { supplierErrorText } from '../labels';

export const dynamic = 'force-dynamic';

/**
 * Yeni tedarikçi siparişi (Paket 6, karar 181/184): boş taslak, Profil Stoğu satırından tek ürün (?urun=) ya da kritik
 * stok listesinden (?kritik=1, ürünler tanımlı tedarikçilerine göre gruplu). Miktarı yönetici girer — sistem önermez.
 * Taslak e-posta göndermez, borç oluşturmaz, stoğu değiştirmez. Yalnızca SUPPLIER_MANAGE.
 */
export default async function NewSupplierOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('SUPPLIER_MANAGE');
  const { t, m, locale } = await getT();
  const sp = await searchParams;
  const all = await listSuppliers(db);
  const suppliers = all.filter((s) => s.isActive);
  const supplierName = new Map<string, string>(all.map((s) => [s.id, s.isActive ? s.name : `${s.name} (${t('supplier.create.inactiveSupplier')})`]));
  const mode: 'product' | 'critical' | 'empty' = sp.urun ? 'product' : sp.kritik === '1' ? 'critical' : 'empty';
  const products = mode === 'empty' ? [] : await db.profileProduct.findMany({
    where: { isActive: true, category: { isActive: true }, ...(mode === 'product' ? { id: String(sp.urun) } : {}) },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { code: 'asc' }],
  });
  const ids = products.map((p) => p.id);
  const [levels, reserved, expected] = mode === 'empty' ? [new Map(), new Map(), new Map()] : await Promise.all([stockLevels(db, ids), reservedLevels(db, ids), expectedSupplyMap(db)]);
  type Row = (typeof products)[number] & { stock: number; reserved: number; expected: number; critical: boolean };
  const rows: Row[] = products.map((p) => {
    const stock = Number(levels.get(p.id) ?? 0);
    const res = Number(reserved.get(p.id) ?? 0);
    const st = stockRowStatus({ stock, reserved: res, threshold: p.criticalStock });
    return { ...p, stock, reserved: res, expected: expected.get(p.id)?.qty ?? 0, critical: st.critical || st.shortForOrders > 0 };
  });
  const list = mode === 'critical' ? rows.filter((r) => r.critical) : rows;
  const error = supplierErrorText(t, m, sp.error, { row: sp.row });
  const priceOf = (p: Row) => {
    const sup = p.supplierId ? all.find((s) => s.id === p.supplierId) : null;
    return sup ? catalogPrice(p, { supplierId: sup.id, currency: sup.currency }) : null;
  };

  const SupplierSelect = ({ id, value }: { id: string; value?: string | null }) => (
    <select id={id} name="supplierId" required defaultValue={value && suppliers.some((s) => s.id === value) ? value : ''}>
      <option value="" disabled>{t('supplier.create.pick')}</option>
      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.currency}</option>)}
    </select>
  );
  // Ürün satırları (tek ürün ya da bir tedarikçi grubu): seçim kutusu, bilgi sütunları, miktar ve renk
  const Lines = ({ items, single }: { items: Row[]; single: boolean }) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {!single && <th>{t('supplier.create.col.pick')}</th>}
            <th>{t('supplier.create.col.code')}</th><th>{t('supplier.create.col.product')}</th>
            <th className="num">{t('supplier.create.col.stock')}</th><th className="num">{t('supplier.create.col.reserved')}</th>
            <th className="num">{t('supplier.create.col.threshold')}</th><th className="num">{t('supplier.create.col.expected')}</th>
            <th>{t('supplier.create.col.price')}</th><th>{t('supplier.create.col.qty')}</th><th>{t('supplier.create.col.color')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const price = priceOf(p);
            return (
              <tr key={p.id} data-create-row={p.code}>
                {!single && <td><input type="checkbox" name="pick" value={p.id} defaultChecked aria-label={p.code} /></td>}
                <td className="mono">{single && <input type="hidden" name="pick" value={p.id} />}{p.code}</td>
                <td>{localName(p, locale)}{p.supplierId && <div className="muted small">{t('supplier.order.editor.otherSupplier', { name: supplierName.get(p.supplierId) ?? '—' })}</div>}</td>
                <td className={`num${p.stock < 0 ? ' stock-neg' : ''}`}>{p.stock}</td>
                <td className="num muted">{p.reserved || '—'}</td>
                <td className="num">{p.criticalStock ?? '—'}</td>
                <td className="num" data-expected>{p.expected || '—'}</td>
                <td className="nowrap">{price != null ? <>{fmtDec(price, 4)} {p.purchaseCurrency}</> : <Badge tone="warn">{t('supplier.create.noPrice')}</Badge>}</td>
                <td className="nowrap">
                  <input name={`qty-${p.id}`} inputMode="numeric" pattern="[0-9]*" maxLength={6} className="qty-input" required={single}
                    aria-label={`${t('supplier.create.col.qty')} ${p.code}`} /> <span className="muted small">{unitLabel(orderUnitOf(p), locale)}</span>
                </td>
                <td><input name={`color-${p.id}`} maxLength={40} className="qty-input" aria-label={`${t('supplier.create.col.color')} ${p.code}`} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <p><Link href="/siparisler/tedarik">{t('supplier.order.back')}</Link></p>
        <h1>{mode === 'critical' ? t('supplier.create.criticalTitle') : t('supplier.create.title')}</h1>
        <p className="muted">{mode === 'critical' ? t('supplier.create.criticalIntro') : t('supplier.create.intro')}</p>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {suppliers.length === 0 && (
        <div className="alert alert-warn">{t('supplier.create.noSuppliers')} <Link href="/admin/entegrasyonlar/tedarikciler">{t('supplier.order.settingsLink')}</Link></div>
      )}

      {mode === 'empty' && suppliers.length > 0 && (
        <form action={createOrderAction} className="card" id="yeni">
          <label htmlFor="ts-supplier">{t('supplier.create.supplier')}</label>
          <SupplierSelect id="ts-supplier" />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary">{t('supplier.create.submit')}</button>
            <Link className="btn" href="/siparisler/tedarik/yeni?kritik=1">{t('supplier.orders.critical')}</Link>
          </div>
        </form>
      )}

      {mode === 'product' && (list.length === 0 ? <div className="alert alert-error">{t('supplier.errors.NOT_FOUND')}</div> : suppliers.length > 0 && (
        <form action={createOrderAction} className="card" id="yeni">
          <input type="hidden" name="from" value={list[0].id} />
          <input type="hidden" name="needItems" value="1" />
          <label htmlFor="ts-supplier">{t('supplier.create.supplier')}</label>
          <SupplierSelect id="ts-supplier" value={list[0].supplierId} />
          <h2 style={{ marginTop: 14 }}>{t('supplier.create.productTitle')}</h2>
          <Lines items={list} single />
          <div className="row" style={{ marginTop: 12 }}><button className="btn btn-primary">{t('supplier.create.submit')}</button></div>
        </form>
      ))}

      {mode === 'critical' && (list.length === 0 ? <div className="card"><div className="empty">{t('supplier.create.criticalEmpty')}</div></div> : suppliers.length > 0 && (
        <>
          {/* Tanımlı (etkin) tedarikçisine göre gruplar; tedarikçisi olmayan ya da pasif olanlar ayrı grupta, tedarikçi seçilir */}
          {[...new Set(list.map((r) => (r.supplierId && suppliers.some((s) => s.id === r.supplierId) ? r.supplierId : '')))].map((sid) => {
            const items = list.filter((r) => (sid ? r.supplierId === sid : !(r.supplierId && suppliers.some((s) => s.id === r.supplierId))));
            return (
              <form key={sid || 'none'} action={createOrderAction} className="card card-flush" data-critical-group={sid ? supplierName.get(sid) : 'none'}>
                <div className="card-head row">
                  <h2>{sid ? supplierName.get(sid) : t('supplier.create.groupNoSupplier')} <span className="badge">{items.length}</span></h2>
                </div>
                <input type="hidden" name="from" value="kritik" />
                <input type="hidden" name="needItems" value="1" />
                {sid ? <input type="hidden" name="supplierId" value={sid} /> : (
                  <div style={{ padding: '0 16px' }}>
                    <label htmlFor={`ts-supplier-${items[0].id}`}>{t('supplier.create.supplier')}</label>
                    <SupplierSelect id={`ts-supplier-${items[0].id}`} />
                  </div>
                )}
                <Lines items={items} single={false} />
                <div className="row" style={{ padding: '12px 16px' }}><button className="btn btn-primary">{t('supplier.create.groupSubmit')}</button></div>
              </form>
            );
          })}
        </>
      ))}
    </>
  );
}
