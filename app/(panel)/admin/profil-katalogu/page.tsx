import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDec, fmtNum } from '@/lib/format';
import { UNITS } from '@/prisma/seed/data/units.js';
import { stockLevels } from '@/server/profile/stock.js';
import { SUPPLIER_CURRENCIES } from '@/server/suppliers/rules.js';
import { changeProductAction, productImageAction, saveCategoryAction, saveProductAction } from './actions';
import { ImportProducts } from './ImportProducts';

export const dynamic = 'force-dynamic';

const MSG: Record<string, [string, MsgKey]> = {
  added: ['ok', 'profile.catalog.msg.added'],
  saved: ['ok', 'profile.catalog.msg.saved'],
  image: ['ok', 'profile.catalog.msg.imageSaved'],
  imported: ['ok', 'profile.catalog.msg.imported'],
  exists: ['error', 'profile.catalog.msg.exists'],
  not_found: ['error', 'profile.catalog.msg.notFound'],
  category: ['error', 'profile.catalog.msg.category'],
  image_infected: ['error', 'profile.catalog.msg.imageInfected'],
  import_failed: ['error', 'profile.catalog.msg.importFailed'],
  code: ['error', 'profile.catalog.problem.CODE'],
  name_ro: ['error', 'profile.catalog.problem.NAME_RO'],
  too_long: ['error', 'profile.catalog.problem.TOO_LONG'],
  unit: ['error', 'profile.catalog.problem.UNIT'],
  price: ['error', 'profile.catalog.problem.PRICE'],
  pack: ['error', 'profile.catalog.problem.PACK'],
  pack_measure: ['error', 'profile.catalog.problem.PACK_MEASURE'],
  pack_int: ['error', 'profile.catalog.problem.PACK_INT'],
  // Alış bilgisi (Paket 6, karar 180)
  purchase_price: ['error', 'supplier.catalog.errors.purchase_price'],
  purchase_currency: ['error', 'supplier.catalog.errors.purchase_currency'],
  purchase_unit: ['error', 'supplier.catalog.errors.purchase_unit'],
  supplier: ['error', 'supplier.catalog.errors.supplier'],
  forbidden: ['error', 'supplier.catalog.errors.forbidden'],
};

// Profil kataloğu (Aşama 6): kategoriler, ürünler (kod, iki dilde ad, birim, liste fiyatı, görsel, sıra, etkin/pasif), Excel.
export default async function ProfileCatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('CATALOG_MANAGE');
  // Alış bilgisi (tedarikçi, alış fiyatı, para birimi, sipariş birimi — Paket 6, karar 180) yalnızca SUPPLIER_MANAGE
  const supply = userCan(user, 'SUPPLIER_MANAGE');
  const { t, m, locale } = await getT();
  const sp = await searchParams;
  const [categories, products, suppliers] = await Promise.all([
    db.profileCategory.findMany({ orderBy: { sortOrder: 'asc' } }),
    db.profileProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { category: { select: { code: true } }, supplier: { select: { name: true } } } }),
    supply ? db.supplier.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], select: { id: true, name: true, isActive: true } }) : Promise.resolve([] as { id: string; name: string; isActive: boolean }[]),
  ]);
  const stock = await stockLevels(db);
  const editing = sp.urun ? products.find((p) => p.id === sp.urun) ?? null : null;
  const editCat = sp.kategori ? categories.find((c) => c.id === sp.kategori) ?? null : null;
  const code = sp.ok ?? (sp.error === 'image' ? 'image_error' : sp.error) ?? '';
  const msg = code === 'image_error' ? (['error', 'profile.catalog.msg.image'] as [string, MsgKey]) : Object.hasOwn(MSG, code) ? MSG[code] : undefined;
  const unitName = (c: string) => UNITS.find((u) => u.code === c)?.name[locale] ?? c;
  // Paket içeriği (hesaplayıcı — karar 175): "137 m / kutu", "100 adet / poşet"
  const packText = (p: { packContent: { toString(): string } | null; packMeasure: string | null; unitCode: string }) =>
    p.packContent == null || !p.packMeasure ? null
      : t('profile.catalog.packValue', { n: fmtDec(p.packContent.toString(), 3), measure: t(`profile.calc.measure.${p.packMeasure}` as MsgKey), unit: unitName(p.unitCode) });

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('profile.catalog.title')}</h1>
          <p className="muted">{t('profile.catalog.intro')}</p>
        </div>
        <div className="row">
          <Link className="btn" href="/admin/profil-katalogu/hesaplama">{t('profile.calcAdmin.link')}</Link>
          <a className="btn" href="/admin/profil-katalogu/excel">{t('profile.catalog.download')}</a>
          <a className="btn" href="#excel">{t('profile.catalog.import.title')}</a>
        </div>
      </div>
      {msg && (
        <div className={`alert ${msg[0] === 'ok' ? 'alert-ok' : 'alert-error'}`}>
          {code === 'imported' ? t('profile.catalog.msg.imported', { c: Number(sp.c) || 0, u: Number(sp.u) || 0 }) : t(msg[1])}
        </div>
      )}

      <form action={saveProductAction} className="card" key={editing?.id ?? 'new'} id="urun">
        <h2>{editing ? t('profile.catalog.editProduct') : t('profile.catalog.addProduct')}</h2>
        {editing && <input type="hidden" name="productId" value={editing.id} />}
        {categories.length === 0 ? <div className="alert alert-warn">{t('profile.catalog.noCategories')}</div> : (
          <>
            <div className="grid-3">
              <div>
                <label htmlFor="pc-code">{t('profile.catalog.field.code')}</label>
                <input id="pc-code" name="code" required maxLength={40} defaultValue={editing?.code} readOnly={!!editing} placeholder="GK15" />
                <div className="hint">{t('profile.catalog.field.codeHint')}</div>
              </div>
              <div>
                <label htmlFor="pc-cat">{t('profile.catalog.field.category')}</label>
                <select id="pc-cat" name="categoryCode" required defaultValue={editing?.category.code ?? categories[0]?.code}>
                  {categories.map((c) => <option key={c.id} value={c.code}>{locale === 'tr' ? c.nameTr : c.nameRo}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pc-unit">{t('profile.catalog.field.unit')}</label>
                <select id="pc-unit" name="unitCode" required defaultValue={editing?.unitCode ?? 'BUCATI'}>
                  {UNITS.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.name[locale]}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pc-ro">{t('profile.catalog.field.nameRo')}</label>
                <input id="pc-ro" name="nameRo" required maxLength={160} defaultValue={editing?.nameRo} />
              </div>
              <div>
                <label htmlFor="pc-tr">{t('profile.catalog.field.nameTr')}</label>
                <input id="pc-tr" name="nameTr" maxLength={160} defaultValue={editing?.nameTr} />
                <div className="hint">{t('profile.catalog.field.nameTrHint')}</div>
              </div>
              <div>
                <label htmlFor="pc-price">{t('profile.catalog.field.listPrice')}</label>
                <input id="pc-price" name="listPrice" inputMode="decimal" defaultValue={editing?.listPrice != null ? Number(editing.listPrice).toFixed(2) : ''} />
                <div className="hint">{t('profile.catalog.field.listPriceHint')}</div>
              </div>
              {/* Paket içeriği (hesaplayıcı — karar 175): bir satış birimindeki miktar; tüketim değildir */}
              <div>
                <label htmlFor="pc-pack">{t('profile.catalog.field.packContent')}</label>
                <input id="pc-pack" name="packContent" inputMode="decimal" defaultValue={editing?.packContent != null ? String(Number(editing.packContent.toString())) : ''} />
                <div className="hint">{t('profile.catalog.field.packContentHint')}</div>
              </div>
              <div>
                <label htmlFor="pc-measure">{t('profile.catalog.field.packMeasure')}</label>
                <select id="pc-measure" name="packMeasure" defaultValue={editing?.packMeasure ?? ''}>
                  <option value="">—</option>
                  <option value="M">{t('profile.calc.measure.M')}</option>
                  <option value="BUC">{t('profile.calc.measure.BUC')}</option>
                </select>
                <div className="hint">{t('profile.catalog.field.packMeasureHint')}</div>
              </div>
            </div>
            {/* Alış bilgisi (Paket 6, karar 180): yalnızca yönetici; müşterinin liste fiyatından ayrı. Boş fiyat = fiyat yok. */}
            {supply && (
              <div className="purchase-box" id="alis">
                <h3 className="sub-title">{t('supplier.catalog.title')}</h3>
                <p className="muted small">{t('supplier.catalog.intro')}</p>
                <input type="hidden" name="purchase" value="1" />
                <div className="grid-3">
                  <div>
                    <label htmlFor="pc-supplier">{t('supplier.catalog.supplier')}</label>
                    <select id="pc-supplier" name="supplierId" defaultValue={editing?.supplierId ?? ''}>
                      <option value="">{t('supplier.catalog.none')}</option>
                      {suppliers.map((x) => <option key={x.id} value={x.id} disabled={!x.isActive && x.id !== editing?.supplierId}>{x.name}{x.isActive ? '' : ` (${t('supplier.catalog.inactive')})`}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="pc-pprice">{t('supplier.catalog.price')}</label>
                    <input id="pc-pprice" name="purchasePrice" inputMode="decimal" maxLength={14} defaultValue={editing?.purchasePrice != null ? fmtDec(editing.purchasePrice.toString(), 4).replace(/\./g, '') : ''} />
                    <div className="hint">{t('supplier.catalog.priceHint')}</div>
                  </div>
                  <div>
                    <label htmlFor="pc-pcur">{t('supplier.catalog.currency')}</label>
                    <select id="pc-pcur" name="purchaseCurrency" defaultValue={editing?.purchaseCurrency ?? ''}>
                      <option value="">—</option>
                      {SUPPLIER_CURRENCIES.map((c: string) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="pc-punit">{t('supplier.catalog.unit')}</label>
                    <select id="pc-punit" name="purchaseUnit" defaultValue={editing?.purchaseUnit ?? ''}>
                      <option value="">—</option>
                      {UNITS.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.name[locale]}</option>)}
                    </select>
                    <div className="hint">{t('supplier.catalog.unitHint')}</div>
                  </div>
                </div>
              </div>
            )}
            <label className="row" style={{ marginTop: 10 }}>
              <input type="checkbox" name="isActive" defaultChecked={editing ? editing.isActive : true} /> {t('profile.catalog.field.isActive')}
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-primary">{editing ? t('common.save') : t('profile.catalog.addProduct')}</button>
              {editing && <Link href="/admin/profil-katalogu" className="btn btn-link">{t('common.cancel')}</Link>}
            </div>
          </>
        )}
      </form>

      {editing && (
        <div className="card">
          <h2>{t('profile.catalog.field.image')} — {editing.code}</h2>
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {editing.imageId && <img className="product-thumb" src={`/dosya/urun/${editing.imageId}`} alt={editing.code} />}
            <form action={productImageAction} style={{ flex: 1 }}>
              <input type="hidden" name="productId" value={editing.id} />
              <div className="row">
                <input name="image" type="file" accept=".jpg,.jpeg,.png" required aria-label={t('profile.catalog.field.image')} style={{ flex: 1 }} />
                <button className="btn btn-primary">{t('common.save')}</button>
              </div>
              <div className="hint">{t('profile.catalog.field.imageHint')}</div>
            </form>
            {editing.imageId && (
              <form action={productImageAction}>
                <input type="hidden" name="productId" value={editing.id} />
                <input type="hidden" name="remove" value="1" />
                <button className="btn btn-link danger">{t('profile.catalog.field.removeImage')}</button>
              </form>
            )}
          </div>
        </div>
      )}

      {categories.map((c) => {
        const list = products.filter((p) => p.categoryId === c.id);
        return (
          <div className="card card-flush" key={c.id} id={`k-${c.id}`}>
            <div className="card-head row">
              <h2 style={{ margin: 0, opacity: c.isActive ? 1 : 0.55 }}>
                {locale === 'tr' ? c.nameTr : c.nameRo} <span className="muted small mono">{c.code}</span> <span className="badge">{list.length}</span>
                {!c.isActive && <> <span className="badge badge-muted">{t('profile.catalog.inactive')}</span></>}
              </h2>
              <Link className="btn btn-link" href={`/admin/profil-katalogu?kategori=${c.id}#kategori`}>{t('profile.catalog.edit')}</Link>
            </div>
            {list.length === 0 ? <div className="empty">{t('profile.catalog.empty')}</div> : (
              <div className="table-wrap">
                <table className="profile-table">
                  <thead>
                    <tr>
                      <th>{t('profile.catalog.col.image')}</th><th>{t('profile.catalog.col.code')}</th><th>{t('profile.catalog.col.name')}</th>
                      <th>{t('profile.catalog.col.unit')}</th><th>{t('profile.catalog.col.pack')}</th><th className="num">{t('profile.catalog.col.price')}</th>
                      {supply && <th className="num">{t('supplier.catalog.col')}</th>}
                      <th className="num">{t('profile.catalog.col.stock')}</th>
                      <th>{t('profile.catalog.col.status')}</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p, i) => {
                      const st = stock.get(p.id) ?? 0;
                      return (
                        <tr key={p.id} id={`p-${p.id}`} style={p.isActive ? undefined : { opacity: 0.55 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <td className="thumb">{p.imageId ? <img src={`/dosya/urun/${p.imageId}`} alt="" loading="lazy" /> : null}</td>
                          <td className="mono">{p.code}</td>
                          <td>{p.nameRo}{p.nameTr !== p.nameRo && <div className="muted small">{p.nameTr}</div>}</td>
                          <td className="muted">{unitName(p.unitCode)}</td>
                          <td className="nowrap" data-pack={p.code}>{packText(p) ?? <span className="muted">—</span>}</td>
                          <td className="num">{p.listPrice != null ? fmtNum(p.listPrice.toString()) : <span className="badge badge-warn">{t('profile.catalog.noPrice')}</span>}</td>
                          {supply && (
                            <td className="num nowrap" data-purchase={p.code}>
                              {p.purchasePrice != null ? `${fmtDec(p.purchasePrice.toString(), 4)} ${p.purchaseCurrency ?? ''}` : <span className="muted">—</span>}
                              {p.supplier && <div className="muted small">{p.supplier.name}</div>}
                            </td>
                          )}
                          <td className={`num${st < 0 ? ' stock-neg' : ''}`}>{st}</td>
                          <td>{p.isActive ? <span className="badge badge-ok">{t('profile.catalog.active')}</span> : <span className="badge badge-muted">{t('profile.catalog.inactive')}</span>}</td>
                          <td className="actions">
                            <Link className="btn btn-link" href={`/admin/profil-katalogu?urun=${p.id}#urun`}>{t('profile.catalog.edit')}</Link>
                            {([
                              ['up', '↑', t('profile.catalog.up'), i === 0],
                              ['down', '↓', t('profile.catalog.down'), i === list.length - 1],
                              ['toggle', p.isActive ? t('profile.catalog.deactivate') : t('profile.catalog.activate'), undefined, false],
                            ] as const).map(([it, label, aria, disabled]) => (
                              <form key={it} action={changeProductAction}>
                                <input type="hidden" name="productId" value={p.id} />
                                <input type="hidden" name="intent" value={it} />
                                <button className="btn btn-link" disabled={disabled} aria-label={aria}>{label}</button>
                              </form>
                            ))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <form action={saveCategoryAction} className="card" id="kategori" key={editCat?.id ?? 'newcat'}>
        <h2>{editCat ? t('profile.catalog.editCategory') : t('profile.catalog.addCategory')}</h2>
        {editCat && <input type="hidden" name="categoryId" value={editCat.id} />}
        <div className="grid-3">
          <div>
            <label htmlFor="cat-code">{t('profile.catalog.field.code')}</label>
            <input id="cat-code" name="code" required maxLength={40} defaultValue={editCat?.code} readOnly={!!editCat} placeholder="ACCESORII" />
          </div>
          <div>
            <label htmlFor="cat-ro">{t('profile.catalog.field.nameRo')}</label>
            <input id="cat-ro" name="nameRo" required maxLength={80} defaultValue={editCat?.nameRo} />
          </div>
          <div>
            <label htmlFor="cat-tr">{t('profile.catalog.field.nameTr')}</label>
            <input id="cat-tr" name="nameTr" maxLength={80} defaultValue={editCat?.nameTr} />
          </div>
        </div>
        <label className="row" style={{ marginTop: 10 }}>
          <input type="checkbox" name="isActive" defaultChecked={editCat ? editCat.isActive : true} /> {t('profile.catalog.field.isActive')}
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary">{editCat ? t('common.save') : t('profile.catalog.addCategory')}</button>
          {editCat && <Link href="/admin/profil-katalogu" className="btn btn-link">{t('common.cancel')}</Link>}
        </div>
      </form>

      <ImportProducts m={m.profile.catalog.import} />
    </>
  );
}
