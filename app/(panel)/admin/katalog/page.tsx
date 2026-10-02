import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { changeGlassAction, saveGlassAction } from './actions';
import { ImportCatalog } from './ImportCatalog';

const MSG: Record<string, [string, MsgKey]> = {
  added: ['ok', 'admin.catalog.msg.added'],
  saved: ['ok', 'admin.catalog.msg.saved'],
  imported: ['ok', 'admin.catalog.msg.imported'],
  name_tr: ['error', 'admin.catalog.problem.NAME_TR'],
  name_ro: ['error', 'admin.catalog.problem.NAME_RO'],
  too_long: ['error', 'admin.catalog.problem.TOO_LONG'],
  weight: ['error', 'admin.catalog.problem.WEIGHT'],
  active: ['error', 'admin.catalog.problem.ACTIVE'],
  exists: ['error', 'admin.catalog.msg.exists'],
  not_found: ['error', 'admin.catalog.msg.notfound'],
  import_failed: ['error', 'admin.catalog.msg.importFailed'],
};

// Cam kataloğu: Türkçe / Romence ad ve renk, ağırlık (kg/m²), etkin/pasif, sıra. Excel ile indirilip yüklenebilir.
export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('CATALOG_MANAGE');
  const { t, m } = await getT();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 100);
  const onlyInactive = sp.durum === 'pasif';
  const where: Prisma.GlassProductWhereInput = {
    ...(onlyInactive ? { isActive: false } : {}),
    ...(q ? { OR: (['nameTr', 'colorTr', 'nameRo', 'colorRo'] as const).map((f) => ({ [f]: { contains: q, mode: 'insensitive' as const } })) } : {}),
  };
  const [items, total] = await Promise.all([
    db.glassProduct.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] }),
    db.glassProduct.count(),
  ]);
  const editing = sp.duzenle ? await db.glassProduct.findUnique({ where: { id: sp.duzenle } }) : null;
  const code = sp.ok ?? sp.error ?? '';
  const msg = Object.hasOwn(MSG, code) ? MSG[code] : undefined;
  const filtered = !!q || onlyInactive;
  const keep = new URLSearchParams({ ...(q ? { q } : {}), ...(onlyInactive ? { durum: 'pasif' } : {}) }).toString();

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('admin.catalog.title')}</h1>
          <p className="muted">{t('admin.catalog.intro')}</p>
        </div>
        <div className="row">
          <a className="btn" href="/admin/katalog/excel">{t('admin.catalog.download')}</a>
          <a className="btn" href="#excel">{t('admin.catalog.import.title')}</a>
        </div>
      </div>
      {msg && (
        <div className={`alert ${msg[0] === 'ok' ? 'alert-ok' : 'alert-error'}`}>
          {code === 'imported' ? t('admin.catalog.msg.imported', { c: Number(sp.c) || 0, u: Number(sp.u) || 0 }) : t(msg[1])}
        </div>
      )}

      <form action={saveGlassAction} className="card" key={editing?.id ?? 'new'}>
        <h2>{editing ? t('admin.catalog.editTitle') : t('admin.catalog.addTitle')}</h2>
        {editing && <input type="hidden" name="glassId" value={editing.id} />}
        <div className="grid-2">
          <div>
            <label htmlFor="nameTr">{t('admin.catalog.field.nameTr')}</label>
            <input id="nameTr" name="nameTr" required maxLength={120} defaultValue={editing?.nameTr} placeholder="10 MM TEMPER CAM" />
          </div>
          <div>
            <label htmlFor="colorTr">{t('admin.catalog.field.colorTr')}</label>
            <input id="colorTr" name="colorTr" maxLength={80} defaultValue={editing?.colorTr} placeholder="ŞEFFAF" />
          </div>
          <div>
            <label htmlFor="nameRo">{t('admin.catalog.field.nameRo')}</label>
            <input id="nameRo" name="nameRo" required maxLength={120} defaultValue={editing?.nameRo} placeholder="STICLĂ SECURIZATĂ 10 MM" />
          </div>
          <div>
            <label htmlFor="colorRo">{t('admin.catalog.field.colorRo')}</label>
            <input id="colorRo" name="colorRo" maxLength={80} defaultValue={editing?.colorRo} placeholder="TRANSPARENTĂ" />
          </div>
          <div>
            <label htmlFor="weightKgM2">{t('admin.catalog.field.weightKgM2')}</label>
            <input id="weightKgM2" name="weightKgM2" required inputMode="decimal" defaultValue={editing?.weightKgM2 != null ? String(editing.weightKgM2) : ''} placeholder="25" />
            <div className="hint">{t('admin.catalog.weightHint')}</div>
          </div>
          <div>
            <label className="row" style={{ marginTop: 28 }}>
              <input type="checkbox" name="isActive" defaultChecked={editing ? editing.isActive : true} /> {t('admin.catalog.field.isActive')}
            </label>
          </div>
        </div>
        {/* İngilizce ad yalnızca Excel'de tutulur; düzenlemede korunur */}
        <input type="hidden" name="nameEn" value={editing?.nameEn ?? ''} />
        <input type="hidden" name="colorEn" value={editing?.colorEn ?? ''} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary">{editing ? t('common.save') : t('admin.catalog.add')}</button>
          {editing && <Link href="/admin/katalog" className="btn btn-link">{t('common.cancel')}</Link>}
        </div>
      </form>

      <ImportCatalog m={m.admin.catalog.import} />

      <div className="card card-flush">
        <div className="card-head row">
          <h2>{t('admin.catalog.listTitle', { n: filtered ? `${items.length} / ${total}` : total })}</h2>
          <form className="row">
            <input type="search" name="q" defaultValue={q} placeholder={t('admin.catalog.search')} aria-label={t('admin.catalog.search')} />
            <label className="row small"><input type="checkbox" name="durum" value="pasif" defaultChecked={onlyInactive} /> {t('admin.catalog.onlyInactive')}</label>
            <button className="btn" type="submit">{t('common.search')}</button>
          </form>
        </div>
        {items.length === 0 ? <div className="empty">{total === 0 ? t('admin.catalog.empty') : t('admin.catalog.noMatch')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('admin.catalog.col.order')}</th>
                  <th>{t('admin.catalog.col.tr')}</th>
                  <th>{t('admin.catalog.col.ro')}</th>
                  <th className="num">{t('admin.catalog.col.weight')}</th>
                  <th>{t('admin.catalog.col.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((g, i) => (
                  <tr key={g.id} id={`g-${g.id}`} style={g.isActive ? undefined : { opacity: 0.55 }}>
                    <td className="muted">{i + 1}</td>
                    <td>{g.nameTr}{g.colorTr && <div className="muted small">{g.colorTr}</div>}</td>
                    <td>{g.nameRo}{g.colorRo && <div className="muted small">{g.colorRo}</div>}</td>
                    <td className="num">{g.weightKgM2 != null ? String(g.weightKgM2) : <span className="badge badge-warn">{t('admin.catalog.noWeight')}</span>}</td>
                    <td>{g.isActive ? <span className="badge badge-ok">{t('admin.catalog.active')}</span> : <span className="badge badge-muted">{t('admin.catalog.inactive')}</span>}</td>
                    <td className="actions">
                      <Link className="btn btn-link" href={`/admin/katalog?duzenle=${g.id}`}>{t('admin.catalog.edit')}</Link>
                      {([
                        ['up', '↑', t('admin.catalog.up'), filtered || i === 0],
                        ['down', '↓', t('admin.catalog.down'), filtered || i === items.length - 1],
                        ['toggle', g.isActive ? t('admin.catalog.deactivate') : t('admin.catalog.activate'), undefined, false],
                      ] as const).map(([it, label, aria, disabled]) => (
                        <form key={it} action={changeGlassAction}>
                          <input type="hidden" name="glassId" value={g.id} />
                          <input type="hidden" name="intent" value={it} />
                          <input type="hidden" name="keep" value={keep} />
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
