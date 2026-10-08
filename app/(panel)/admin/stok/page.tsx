import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { UNITS } from '@/prisma/seed/data/units.js';
import { reservedLevels, stockLevels, stockRowStatus } from '@/server/profile/stock.js';
import { expectedSupplyMap } from '@/server/suppliers/service.js';
import { stockImportAction, stockMoveAction, stockThresholdAction } from './actions';

export const dynamic = 'force-dynamic';

const ERR: Record<string, MsgKey> = {
  not_found: 'profile.stock.msg.notFound',
  bad_qty: 'profile.stock.msg.badQty',
  no_change: 'profile.stock.msg.noChange',
  import: 'profile.stock.msg.importFailed',
  bad_threshold: 'profile.stock.msg.badThreshold',
  threshold_same: 'profile.stock.msg.thresholdNoChange',
  forbidden: 'profile.stock.msg.forbidden',
};

// Profil stoğu (Aşama 6; Paket 5 — karar 177): ürün başına stok (hareketlerin toplamı), Rezerve (onaylı, depoya gitmemiş
// siparişlerin adedi — hareket değildir), kritik eşik ve durum; elle giriş / sayım, Excel, son hareketler.
// Görüntüleme: STOCK_VIEW (yönetici, denetimci). Değiştirme (formlar, Excel): yalnızca STOCK_MANAGE (yönetici) — denetimci
// formları hiç görmez; işlemler ve servisler de yetkiyi ayrıca denetler.
export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('STOCK_VIEW');
  const manage = userCan(user, 'STOCK_MANAGE');
  // Tedarik (Paket 6, karar 184): beklenen tedarik sütunu ve "Sipariş hazırla" yalnızca SUPPLIER_MANAGE (yönetici) içindir —
  // denetimci görmez. Beklenen miktar stok ve rezerveden AYRIDIR; stoğu değiştirmez.
  const supply = userCan(user, 'SUPPLIER_MANAGE');
  const { t, locale } = await getT();
  const sp = await searchParams;
  const [products, levels, reserved, moves, expected] = await Promise.all([
    db.profileProduct.findMany({ orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }], include: { category: true } }),
    stockLevels(db),
    reservedLevels(db),
    db.stockMovement.findMany({
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { product: { select: { code: true } }, order: { select: { id: true, orderNo: true } } },
    }),
    supply ? expectedSupplyMap(db) : Promise.resolve(null),
  ]);
  const users = await db.user.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.createdById).filter((x): x is string => !!x))] } }, select: { id: true, name: true, email: true } });
  const who = new Map(users.map((u) => [u.id, u.name || u.email]));
  const unit = (c: string) => UNITS.find((u) => u.code === c)?.name[locale] ?? c;

  let msg: { ok: boolean; text: string } | null = null;
  if (sp.ok === 'saved') msg = { ok: true, text: t('profile.stock.msg.saved', { delta: sp.d ?? '' }) };
  else if (sp.ok === 'imported') msg = { ok: true, text: sp.u ? t('profile.stock.msg.importedUnknown', { n: Number(sp.n) || 0, codes: sp.u }) : t('profile.stock.msg.imported', { n: Number(sp.n) || 0 }) };
  else if (sp.ok === 'threshold') msg = { ok: true, text: t('profile.stock.msg.thresholdSaved') };
  else if (sp.ok === 'threshold_alert') msg = { ok: true, text: t('profile.stock.msg.thresholdAlert') };
  else if (sp.error && Object.hasOwn(ERR, sp.error)) msg = { ok: false, text: t(ERR[sp.error]) };

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('profile.stock.title')}</h1>
          <p className="muted">{t('profile.stock.intro')}</p>
        </div>
        <div className="row">
          {supply && <Link className="btn" href="/siparisler/tedarik/yeni?kritik=1">{t('supplier.stock.prepareCritical')}</Link>}
          {manage && <a className="btn" href="/admin/stok/excel">{t('profile.stock.download')}</a>}
        </div>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'}`}>{msg.text}</div>}
      {!manage && <div className="alert alert-info" data-stock-readonly>{t('profile.stock.viewOnly')}</div>}

      {manage && (
        <div className="grid-2">
          <form action={stockMoveAction} className="card">
            <h2>{t('profile.stock.move.title')}</h2>
            <label htmlFor="st-p">{t('profile.stock.move.product')}</label>
            <select id="st-p" name="productId" required defaultValue="">
              <option value="" disabled>{t('profile.stock.move.pick')}</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {locale === 'tr' ? p.nameTr : p.nameRo}</option>)}
            </select>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <div>
                <label htmlFor="st-k">{t('profile.stock.move.kind')}</label>
                <select id="st-k" name="kind" defaultValue="GIRIS">
                  <option value="GIRIS">{t('profile.stock.move.GIRIS')}</option>
                  <option value="SAYIM">{t('profile.stock.move.SAYIM')}</option>
                </select>
              </div>
              <div>
                <label htmlFor="st-q">{t('profile.stock.move.qty')}</label>
                <input id="st-q" name="qty" required inputMode="numeric" pattern="-?[0-9]+" />
              </div>
            </div>
            <label htmlFor="st-n">{t('profile.stock.move.note')}</label>
            <input id="st-n" name="note" maxLength={300} />
            <div className="row end" style={{ marginTop: 10 }}><button className="btn btn-primary">{t('profile.stock.move.submit')}</button></div>
          </form>

          <form action={stockImportAction} className="card">
            <h2>{t('profile.stock.import.title')}</h2>
            <p className="muted small">{t('profile.stock.import.intro')}</p>
            <label htmlFor="st-mode">{t('profile.stock.import.mode')}</label>
            <select id="st-mode" name="mode" defaultValue="GIRIS">
              <option value="GIRIS">{t('profile.stock.import.GIRIS')}</option>
              <option value="SAYIM">{t('profile.stock.import.SAYIM')}</option>
            </select>
            <label htmlFor="st-file">{t('profile.stock.import.file')}</label>
            <input id="st-file" name="file" type="file" accept=".xlsx" required />
            <div className="row end" style={{ marginTop: 10 }}><button className="btn">{t('profile.stock.import.submit')}</button></div>
          </form>
        </div>
      )}

      <div className="card card-flush">
        {manage && <p className="card-sub muted small">{t('profile.stock.thresholdHint')}</p>}
        <div className="table-wrap">
          <table className="profile-table stock-list">
            <thead>
              <tr>
                <th>{t('profile.stock.colCode')}</th><th>{t('profile.stock.colProduct')}</th><th>{t('profile.stock.colUnit')}</th>
                <th className="num">{t('profile.stock.colStock')}</th>
                <th className="num" title={t('profile.stock.colReservedHint')}>{t('profile.stock.colReserved')}</th>
                <th className="num">{t('profile.stock.colThreshold')}</th><th>{t('profile.stock.colStatus')}</th>
                {supply && <th className="num" title={t('supplier.stock.colExpectedHint')}>{t('supplier.stock.colExpected')}</th>}
                {supply && <th />}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const st = levels.get(p.id) ?? 0;
                const res = reserved.get(p.id) ?? 0;
                const status = stockRowStatus({ stock: st, reserved: res, threshold: p.criticalStock });
                const exp = expected?.get(p.id) ?? null;
                return (
                  <tr key={p.id} id={`s-${p.id}`} data-stock-row={p.code} className={status.critical ? 'row-alert' : undefined} style={p.isActive ? undefined : { opacity: 0.55 }}>
                    <td className="mono">{p.code}</td>
                    <td>{locale === 'tr' ? p.nameTr : p.nameRo} <span className="muted small">· {locale === 'tr' ? p.category.nameTr : p.category.nameRo}</span></td>
                    <td className="muted">{unit(p.unitCode)}</td>
                    <td className={`num${st < 0 ? ' stock-neg' : ''}`}><b>{st}</b>{st < 0 && <div className="small">{t('profile.stock.negative')}</div>}</td>
                    <td className="num muted" data-reserved>{res || '—'}</td>
                    <td className="num" data-threshold>
                      {manage ? (
                        <form action={stockThresholdAction} className="threshold-form">
                          <input type="hidden" name="productId" value={p.id} />
                          <input name="threshold" inputMode="numeric" pattern="[0-9]*" maxLength={7} defaultValue={p.criticalStock ?? ''} className="qty-input"
                            aria-label={t('profile.stock.thresholdLabel', { code: p.code })} />
                          <button className="btn">{t('profile.stock.thresholdSave')}</button>
                        </form>
                      ) : (p.criticalStock ?? '—')}
                    </td>
                    <td data-status>
                      {status.critical && <Badge tone="danger">{t('profile.stock.critical')}</Badge>}
                      {status.shortForOrders > 0 && <div className="small text-danger">{t('profile.stock.shortForOrders', { n: status.shortForOrders })}</div>}
                      {!status.critical && status.shortForOrders === 0 && p.criticalStock != null && <span className="muted small">{t('profile.stock.statusOk')}</span>}
                    </td>
                    {supply && (
                      <td className="num" data-expected>
                        {exp?.qty ? <b>{exp.qty}</b> : exp?.other.length ? null : <span className="muted">—</span>}
                        {exp?.other.map((o) => <div key={o.unitCode} className="small muted">+ {o.qty} {unit(o.unitCode)}</div>)}
                      </td>
                    )}
                    {supply && (
                      <td className="actions">
                        {p.isActive && <Link className="btn btn-link" href={`/siparisler/tedarik/yeni?urun=${p.id}`} data-prepare={p.code}>{t('supplier.stock.prepare')}</Link>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-flush">
        <div className="card-head"><h2>{t('profile.stock.history')}</h2></div>
        {moves.length === 0 ? <div className="empty">{t('profile.stock.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('profile.stock.colWhen')}</th><th>{t('profile.stock.colCode')}</th><th>{t('profile.stock.colKind')}</th><th className="num">{t('profile.stock.colQty')}</th><th>{t('profile.stock.colNote')}</th><th>{t('profile.stock.colWho')}</th></tr></thead>
              <tbody>
                {moves.map((mv) => (
                  <tr key={mv.id}>
                    <td className="small">{fmtDateTime(mv.createdAt)}</td>
                    <td className="mono">{mv.product.code}</td>
                    <td>{t(`profile.stock.kind.${mv.kind}` as MsgKey)}</td>
                    <td className={`num${mv.qty < 0 ? ' danger' : ''}`}><b>{mv.qty > 0 ? `+${mv.qty}` : mv.qty}</b></td>
                    <td>{mv.order ? <Link href={`/siparisler/${mv.order.id}`}>{mv.order.orderNo}</Link> : mv.note ?? ''}</td>
                    <td className="muted small">{mv.createdById ? who.get(mv.createdById) ?? '—' : t('profile.stock.system')}</td>
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
