import Link from 'next/link';
import type { AppRole } from '@prisma/client';
import { db } from '@/lib/db';
import { getT, type MsgKey } from '@/lib/i18n';
import { ROLES, can } from '@/server/auth/permissions.js';
import { glassLabel } from '@/server/catalog/glass.js';
import { CURRENCIES } from '@/server/pricing/tables.js';
import { assignCustomerTableAction, assignTableAction, changeTableAction, saveTableAction } from './actions';
import { ImportPrices } from './ImportPrices';
import { PricesEditor } from './PricesEditor';

const OK = new Set(['created', 'saved', 'imported', 'assigned', 'deleted']);
const ERR = new Set(['exists', 'not_found', 'currency_locked', 'is_default', 'inactive', 'in_use', 'invalid', 'import_failed']);

/**
 * Fiyat tabloları: tablolar, seçili tablonun fiyatları (ekranda ya da Excel ile) ve atamalar.
 *  - SALES (karar 26): satışçıların liste fiyatları; satışçılara atanır, biri varsayılan.
 *  - CUSTOMER (karar 32): müşteriye özel fiyatlar; müşteri firmalarına atanır, yönetim kopyasında müşteri fiyatı olarak gelir.
 */
export async function PriceTablesView({ kind, sp }: { kind: 'SALES' | 'CUSTOMER'; sp: Record<string, string | undefined> }) {
  const { t, m, locale } = await getT();
  const forCustomers = kind === 'CUSTOMER';
  const kindInput = <input type="hidden" name="kind" value={kind} />;
  const base = forCustomers ? '/admin/musteri-fiyatlari' : '/admin/fiyatlar';
  const tables = await db.priceTable.findMany({
    where: { kind },
    orderBy: [{ isDefault: 'desc' }, { isActive: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { items: true, users: true, customers: true } } },
  });
  const sel = tables.find((x) => x.id === sp.tablo) ?? tables[0] ?? null;
  const defaultTable = tables.find((x) => x.isDefault && x.isActive) ?? null;
  const preparers = ROLES.filter((r) => can(r, 'OFFER_PREPARE')) as AppRole[];
  const [glasses, items, users, firms] = await Promise.all([
    sel ? db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] }) : [],
    sel ? db.priceTableItem.findMany({ where: { tableId: sel.id } }) : [],
    sel && !forCustomers ? db.user.findMany({ where: { type: 'INTERNAL', isActive: true, appRole: { in: preparers } }, orderBy: { name: 'asc' }, include: { priceTable: { select: { name: true } } } }) : [],
    sel && forCustomers ? db.customer.findMany({ where: { type: 'CUSTOMER' }, orderBy: { name: 'asc' }, include: { priceTable: { select: { name: true } } } }) : [],
  ]);
  const prices = new Map(items.map((i) => [i.glassProductId, Number(i.unitPrice)]));

  const code = sp.ok ?? sp.error ?? '';
  const isOk = OK.has(code);
  const msgText = isOk || ERR.has(code)
    ? code === 'imported' ? t('pricing.msg.imported', { n: Number(sp.n) || 0 })
      : code === 'invalid' ? t('pricing.msg.invalid', { what: (sp.what ?? '').split(',').filter(Boolean).map((c) => t(`pricing.problem.${c}` as MsgKey)).join(', ') })
        : t(`pricing.msg.${code}` as MsgKey)
    : null;

  return (
    <>
      <div className="page-head">
        <h1>{forCustomers ? t('pricing.customer.title') : t('pricing.title')}</h1>
        <p className="muted">{forCustomers ? t('pricing.customer.intro') : t('pricing.intro')}</p>
      </div>
      {msgText && <div className={`alert ${isOk ? 'alert-ok' : 'alert-error'}`}>{msgText}</div>}

      <form action={saveTableAction} className="card">
{kindInput}
        <h2>{t('pricing.create.title')}</h2>
        <div className="grid-2">
          <div>
            <label htmlFor="new-name">{t('pricing.create.name')}</label>
            <input id="new-name" name="name" required maxLength={120} placeholder={t('pricing.create.namePlaceholder')} />
            <div className="hint">{t('pricing.create.nameHint')}</div>
          </div>
          <div>
            <label htmlFor="new-currency">{t('pricing.create.currency')}</label>
            <select id="new-currency" name="currency" defaultValue="EUR">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            <div className="hint">{t('pricing.create.currencyHint')}</div>
          </div>
          <div>
            <label htmlFor="new-hole">{t('pricing.create.holePrice')}</label>
            <input id="new-hole" name="holePrice" inputMode="decimal" />
          </div>
          <div>
            <label htmlFor="new-cnc">{t('pricing.create.cncPrice')}</label>
            <input id="new-cnc" name="cncPrice" inputMode="decimal" />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" style={{ marginTop: 12 }}>{t('pricing.create.submit')}</button>
      </form>

      <div className="card card-flush">
        <div className="card-head"><h2>{t('pricing.tables.title')}</h2></div>
        {tables.length === 0 ? <div className="empty">{t('pricing.tables.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('pricing.tables.col.name')}</th><th>{t('pricing.tables.col.currency')}</th>
                  <th className="num">{t('pricing.tables.col.priced')}</th><th className="num">{forCustomers ? t('pricing.customer.colFirms') : t('pricing.tables.col.users')}</th>
                  <th>{t('pricing.tables.col.status')}</th><th />
                </tr>
              </thead>
              <tbody>
                {tables.map((x) => (
                  <tr key={x.id} className={x.id === sel?.id ? 'row-selected' : undefined}>
                    <td><Link href={`${base}?tablo=${x.id}`}>{x.name}</Link></td>
                    <td>{x.currency}</td>
                    <td className="num">{x._count.items}</td>
                    <td className="num">{forCustomers ? x._count.customers : x._count.users}</td>
                    <td>
                      {x.isActive ? <span className="badge badge-ok">{t('pricing.tables.active')}</span> : <span className="badge badge-muted">{t('pricing.tables.inactive')}</span>}{' '}
                      {x.isDefault && <span className="badge badge-info">{t('pricing.tables.isDefault')}</span>}
                    </td>
                    <td className="actions">
                      <Link className="btn btn-link" href={`${base}?tablo=${x.id}`}>{t('pricing.tables.open')}</Link>
                      {(forCustomers ? (['toggle', 'delete'] as const) : (['toggle', 'default', 'delete'] as const)).map((intent) => {
                        const label = intent === 'toggle' ? (x.isActive ? t('pricing.tables.deactivate') : t('pricing.tables.activate'))
                          : intent === 'default' ? t('pricing.tables.makeDefault') : t('pricing.tables.remove');
                        const disabled = intent === 'toggle' ? x.isDefault && x.isActive : intent === 'default' ? x.isDefault || !x.isActive : x.isDefault;
                        return (
                        <form key={intent} action={changeTableAction}>
                          {kindInput}
                          <input type="hidden" name="tableId" value={x.id} />
                          <input type="hidden" name="intent" value={intent} />
                          <button className={`btn btn-link${intent === 'delete' ? ' danger' : ''}`} disabled={disabled}>{label}</button>
                        </form>
                        );
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sel && (
        <>
          <form action={saveTableAction} className="card" key={`s-${sel.id}-${sel.updatedAt.getTime()}`}>
{kindInput}
            <input type="hidden" name="tableId" value={sel.id} />
            <h2>{sel.name} — {t('pricing.edit.settings')}</h2>
            <div className="grid-2">
              <div>
                <label htmlFor="t-name">{t('pricing.create.name')}</label>
                <input id="t-name" name="name" required maxLength={120} defaultValue={sel.name} />
              </div>
              <div>
                <label htmlFor="t-currency">{t('pricing.create.currency')}</label>
                <select id="t-currency" name="currency" defaultValue={sel.currency}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
              </div>
              <div>
                <label htmlFor="t-hole">{t('pricing.create.holePrice')} ({sel.currency})</label>
                <input id="t-hole" name="holePrice" inputMode="decimal" defaultValue={sel.holePrice != null ? String(sel.holePrice) : ''} />
              </div>
              <div>
                <label htmlFor="t-cnc">{t('pricing.create.cncPrice')} ({sel.currency})</label>
                <input id="t-cnc" name="cncPrice" inputMode="decimal" defaultValue={sel.cncPrice != null ? String(sel.cncPrice) : ''} />
              </div>
            </div>
            <button type="submit" className="btn" style={{ marginTop: 12 }}>{t('pricing.edit.saveSettings')}</button>
          </form>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{t('pricing.edit.pricesTitle', { name: sel.name, cur: sel.currency })}</h2>
              <div className="row">
                <a className="btn" href={`/admin/fiyatlar/excel?tablo=${sel.id}`}>{t('pricing.edit.download')}</a>
                <a className="btn" href="#excel">{t('pricing.import.title')}</a>
              </div>
            </div>
            <p className="muted small">{t('pricing.edit.pricesIntro')}</p>
            {glasses.length === 0 ? <div className="alert alert-warn">{t('pricing.edit.noGlass')}</div> : (
              <PricesEditor
                key={sel.id}
                tableId={sel.id}
                currency={sel.currency}
                rows={glasses.map((g) => ({ id: g.id, label: glassLabel(g, locale), price: prices.get(g.id) ?? null }))}
                m={m.pricing.edit}
              />
            )}
          </div>

          <ImportPrices key={`i-${sel.id}`} tableId={sel.id} kind={kind} m={m.pricing.import} />

          {forCustomers ? (
          <div className="card card-flush">
              <div className="card-head">
                <h2>{t('pricing.customer.assignTitle', { name: sel.name })}</h2>
                <p className="muted small" style={{ margin: '4px 0 0' }}>{t('pricing.customer.assignIntro')}</p>
              </div>
              {firms.length === 0 ? <div className="empty">{t('pricing.customer.noFirms')}</div> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>{t('pricing.customer.colFirm')}</th><th>{t('pricing.assign.colTable')}</th><th /></tr></thead>
                    <tbody>
                      {firms.map((f) => {
                        const here = f.priceTableId === sel.id;
                        return (
                          <tr key={f.id}>
                            <td>{f.name}{f.prefix && <div className="muted small mono">{f.prefix}</div>}</td>
                            <td>
                              {here ? <span className="badge badge-ok">{t('pricing.assign.thisTable')}</span>
                                : f.priceTable ? f.priceTable.name : <span className="muted">{t('pricing.customer.none')}</span>}
                            </td>
                            <td className="actions">
                              <form action={assignCustomerTableAction}>
                                {kindInput}
                                <input type="hidden" name="tableId" value={sel.id} />
                                <input type="hidden" name="customerId" value={f.id} />
                                <input type="hidden" name="intent" value={here ? 'unassign' : 'assign'} />
                                <button className="btn btn-link">{here ? t('pricing.assign.unassign') : t('pricing.assign.assign')}</button>
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
            ) : (
          <div className="card card-flush">
            <div className="card-head">
              <h2>{t('pricing.assign.title', { name: sel.name })}</h2>
              <p className="muted small" style={{ margin: '4px 0 0' }}>{t('pricing.assign.intro')}</p>
            </div>
            {users.length === 0 ? <div className="empty">{t('pricing.assign.empty')}</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('pricing.assign.colUser')}</th><th>{t('pricing.assign.colTable')}</th><th /></tr></thead>
                  <tbody>
                    {users.map((u) => {
                      const here = u.priceTableId === sel.id;
                      return (
                        <tr key={u.id}>
                          <td>{u.name}<div className="muted small">{u.email}</div></td>
                          <td>
                            {here ? <span className="badge badge-ok">{t('pricing.assign.thisTable')}</span>
                              : u.priceTable ? u.priceTable.name
                                : defaultTable ? <span className="muted">{t('pricing.assign.viaDefault', { name: defaultTable.name })}</span>
                                  : <span className="muted">{t('pricing.assign.none')}</span>}
                          </td>
                          <td className="actions">
                            <form action={assignTableAction}>
{kindInput}
                              <input type="hidden" name="tableId" value={sel.id} />
                              <input type="hidden" name="userId" value={u.id} />
                              <input type="hidden" name="intent" value={here ? 'unassign' : 'assign'} />
                              <button className="btn btn-link">{here ? t('pricing.assign.unassign') : t('pricing.assign.assign')}</button>
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
          )}
        </>
      )}
    </>
  );
}
