import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { addGlassAction, updateGlassAction } from './actions';

const MSG: Record<string, [string, MsgKey]> = {
  added: ['ok', 'admin.catalog.msg.added'],
  saved: ['ok', 'admin.catalog.msg.saved'],
  empty: ['error', 'admin.catalog.msg.empty'],
  exists: ['error', 'admin.catalog.msg.exists'],
  notfound: ['error', 'admin.catalog.msg.notfound'],
};

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('CATALOG_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const items = await db.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  const code = sp.ok ?? sp.error ?? '';
  const msg = Object.hasOwn(MSG, code) ? MSG[code] : undefined;

  return (
    <>
      <div className="page-head">
        <h1>{t('admin.catalog.title')}</h1>
        <p className="muted">{t('admin.catalog.intro')}</p>
      </div>
      {msg && <div className={`alert ${msg[0] === 'ok' ? 'alert-ok' : 'alert-error'}`}>{t(msg[1])}</div>}
      <form action={addGlassAction} className="card row">
        <input name="name" type="text" required maxLength={200} placeholder={t('admin.catalog.namePlaceholder')} aria-label={t('admin.catalog.name')} style={{ flex: 1 }} />
        <button className="btn btn-primary">{t('admin.catalog.add')}</button>
      </form>
      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('admin.catalog.listTitle', { n: items.length })}</h2></div>
        {items.length === 0 ? <div className="empty">{t('admin.catalog.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('admin.catalog.col.order')}</th><th>{t('admin.catalog.col.glass')}</th><th>{t('admin.catalog.col.status')}</th><th /></tr></thead>
              <tbody>
                {items.map((g, i) => (
                  <tr key={g.id} style={g.isActive ? undefined : { opacity: 0.55 }}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <form action={updateGlassAction} className="row">
                        <input type="hidden" name="id" value={g.id} />
                        <input type="hidden" name="intent" value="rename" />
                        <input name="name" type="text" defaultValue={g.name} aria-label={t('admin.catalog.name')} style={{ flex: 1, minWidth: 220 }} />
                        <button className="btn btn-link">{t('common.save')}</button>
                      </form>
                    </td>
                    <td>{g.isActive ? <span className="badge badge-ok">{t('admin.catalog.active')}</span> : <span className="badge badge-muted">{t('admin.catalog.inactive')}</span>}</td>
                    <td className="actions">
                      {([['up', '↑', t('admin.catalog.up'), i === 0], ['down', '↓', t('admin.catalog.down'), i === items.length - 1], ['toggle', g.isActive ? t('admin.catalog.deactivate') : t('admin.catalog.activate'), undefined, false]] as const).map(([it, label, aria, disabled]) => (
                        <form key={it} action={updateGlassAction}>
                          <input type="hidden" name="id" value={g.id} />
                          <input type="hidden" name="intent" value={it} />
                          <button className="btn btn-link" disabled={disabled} aria-label={aria}>{label}</button>
                        </form>
                      ))}
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
