import Link from 'next/link';
import type { OrderStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requirePermission, type CurrentUser } from '@/lib/auth/session';
import { getT, type Dict } from '@/lib/i18n';
import { customerSummaryText, profileCustomerText, profileStageText, slaText } from '@/lib/labels';
import { rich } from '@/lib/rich';
import { customerLabel, drawingScope, orderScope, sanitizeRows } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { fmtDate, fmtDateTime, fmtMonth, isoDay } from '@/lib/format';
import { Badge, CustomerBadge, DrawingBadge, OfferBadge, OrderBadge } from '@/components/StatusBadge';
import { PROFILE_STAGE_TONE } from '@/server/profile/rules.js';
import { CLOSED, slaInfo } from '@/server/orders/rules.js';
import { approvedDrawingList, latestOfferStatus, queuesFor } from '@/server/orders/queues.js';
import { deleteDraftAction } from './yeni/actions';
import { ConfirmButton } from '@/components/ConfirmButton';
import { restoreOrderAction } from './[id]/compensation-actions';

const listInclude = {
  customer: { select: { name: true } },
  // Taslak (müşteriye gönderilmemiş) çizim sürümleri sayılmaz
  drawings: { where: { status: { not: 'TASLAK' } }, orderBy: { version: 'asc' }, select: { id: true, version: true, createdAt: true, sentAt: true } },
  offers: { orderBy: { createdAt: 'desc' }, select: { status: true, sentAt: true } },
  // Müşterinin gönderdiği hazır çizim (DWG/DXF) çizim ekibine işaretlenir
  files: { where: { kind: 'CUSTOMER' }, select: { name: true } },
  events: { where: { event: 'OFFER_CHECKED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
  // Profil siparişi (Aşama 6): adım ve alış günü
  profile: { select: { stage: true, pickupDate: true } },
} satisfies Prisma.OrderInclude;
type Row = Prisma.OrderGetPayload<{ include: typeof listInclude }>;

type SP = Record<string, string | undefined>;
/** /siparisler?panel=cizim — çizim ekibinin paneli (yönetici menüsü: Çizim Ekibi → Çizim Paneli; lib/roles.ts) */
const DRAWING_PANEL = 'cizim';

type Noun = keyof Dict['orders']['units'];
/** Sayı + birim: "3 çizim". Romencede birim sayıya göre çekimlenir (1 desen, 2 desene, 20 de desene). */
function counter(m: Dict, intl: string) {
  const rules = new Intl.PluralRules(intl);
  const unit = (noun: Noun, n: number) => {
    const c = rules.select(n);
    return m.orders.units[noun][c === 'one' || c === 'few' ? c : 'other'];
  };
  return { unit, count: (noun: Noun, n: number) => `${n} ${unit(noun, n)}` };
}

const offerOf = (o: Row) => latestOfferStatus(o);
const sentOf = (o: Row) => (o.offers.some((x) => x.status === 'GONDERILDI') ? 'GONDERILDI' : null);
export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePermission('ORDER_VIEW');
  const sp = await searchParams;
  return user.appRole === 'MUSTERI' ? <CustomerOrders user={user} sp={sp} /> : <InternalOrders user={user} sp={sp} />;
}

function searchWhere(q?: string): Prisma.OrderWhereInput {
  const s = (q ?? '').trim();
  if (!s) return {};
  return {
    OR: [
      { orderNo: { contains: s, mode: 'insensitive' } },
      { title: { contains: s, mode: 'insensitive' } },
      ...(/^\d+$/.test(s) ? [{ customerOrderNo: Number(s) }] : []),
    ],
  };
}

async function Sla({ deadline }: { deadline: Date | null }) {
  const s = slaInfo(deadline);
  if (!s) return <span className="muted">—</span>;
  const { t } = await getT();
  return <span className={s.over ? 'sla-over' : s.risk ? 'sla-risk' : 'sla-ok'}>● {slaText(t, s)}</span>;
}

function GroupRows({ label, cols, children }: { label: string; cols: number; children: React.ReactNode }) {
  return (
    <>
      {label && <tr className="group-row"><td colSpan={cols}>{label}</td></tr>}
      {children}
    </>
  );
}

// ---------------- Müşteri ----------------
async function CustomerOrders({ user, sp }: { user: CurrentUser; sp: SP }) {
  const { t, locale, m, intl } = await getT();
  const { unit } = counter(m, intl);
  const archive = sp.view === 'archive';
  const orders = sanitizeRows(user, await db.order.findMany({
    where: {
      ...orderScope(user),
      ...searchWhere(sp.q),
      status: archive ? { in: CLOSED as OrderStatus[] } : { notIn: CLOSED as OrderStatus[] },
    },
    include: listInclude,
    orderBy: [{ estimatedShipDate: archive ? 'desc' : 'asc' }, { createdAt: 'desc' }],
  }));
  const count = (f: (o: Row) => boolean) => (archive ? 0 : orders.filter(f).length);
  const groups = new Map<string, Row[]>();
  for (const o of orders) {
    const day = o.profile?.pickupDate ?? o.estimatedShipDate;
    const k = day ? fmtMonth(day, locale) : t('orders.customer.noDate');
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  // Taslaklar yalnızca bu firmanın müşteri kullanıcılarına görünür (sipariş değildir)
  const drafts = archive || !user.customerId ? [] : await db.orderDraft.findMany({
    where: { customerId: user.customerId }, orderBy: { updatedAt: 'desc' }, include: { _count: { select: { files: true } } },
  });
  const awaiting = count((o) => o.status === 'HAZIRLANIYOR' && o.drawingTrack === 'ONAY_BEKLIYOR');
  const drawing = count((o) => o.status === 'HAZIRLANIYOR' && ['GEREKLI', 'YAPILIYOR', 'REVIZYON_ISTENDI'].includes(o.drawingTrack));
  const production = count((o) => o.status === 'URETIMDE');

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('orders.customer.title', { name: user.customer?.name ?? '' })}</h1>
          <p className="muted">{t('orders.customer.intro')}</p>
        </div>
        <div className="row">
          <Link href="/teklifler" className="btn">{t('nav.myOffers')}</Link>
          <Link href="/siparisler/yeni" className="btn btn-primary">{t('orders.customer.newOrder')}</Link>
        </div>
      </div>

      {!archive && (
        <div className="stats">
          <div className="stat" style={{ borderLeftColor: 'var(--warn-accent)' }}><div className="k">{t('status.customer.awaitingApproval.label')}</div><div className="v">{awaiting}<small>{unit('drawing', awaiting)}</small></div></div>
          <div className="stat" style={{ borderLeftColor: 'var(--purple)' }}><div className="k">{t('status.customer.drawing.label')}</div><div className="v">{drawing}<small>{unit('order', drawing)}</small></div></div>
          <div className="stat" style={{ borderLeftColor: 'var(--ok)' }}><div className="k">{t('status.customer.production.label')}</div><div className="v">{production}<small>{unit('order', production)}</small></div></div>
          <div className="stat"><div className="k">{t('orders.customer.totalActive')}</div><div className="v">{orders.length}<small>{unit('order', orders.length)}</small></div></div>
        </div>
      )}

      {sp.ok === 'draftDeleted' && <div className="alert alert-ok">{t('orders.customer.drafts.deleted')}</div>}
      {sp.ok === 'draftGone' && <div className="alert alert-warn">{t('orders.customer.drafts.gone')}</div>}
      {drafts.length > 0 && (
        <div className="card card-flush">
          <div className="card-head">
            <h2>{t('orders.customer.drafts.title')} <span className="badge">{drafts.length}</span></h2>
            <span className="muted small">{t('orders.customer.drafts.intro')}</span>
          </div>
          <div className="table-wrap">
            <table>
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/siparisler/yeni?taslak=${d.id}`}>{d.title || t('orders.customer.drafts.untitled')}</Link>
                      <div className="muted small">{t('orders.customer.drafts.saved', { date: fmtDate(d.updatedAt) })} · {t('orders.customer.drafts.files', { n: d._count.files })}</div>
                    </td>
                    <td className="actions">
                      <Link href={`/siparisler/yeni?taslak=${d.id}`} className="btn">{t('orders.customer.drafts.continue')}</Link>
                      <form action={deleteDraftAction}>
                        <input type="hidden" name="draftId" value={d.id} />
                        <button type="submit" className="btn btn-link danger">{t('orders.customer.drafts.delete')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="tabs">
        <Link href="/siparisler" className={archive ? '' : 'active'}>{t('orders.tabs.active')}</Link>
        <Link href="/siparisler?view=archive" className={archive ? 'active' : ''}>{t('orders.tabs.archive')}</Link>
      </div>
      <form className="toolbar">
        {archive && <input type="hidden" name="view" value="archive" />}
        <input type="search" name="q" placeholder={t('orders.customer.searchPlaceholder')} defaultValue={sp.q ?? ''} />
        <button className="btn" type="submit">{t('common.search')}</button>
      </form>

      <div className="card card-flush">
        {orders.length === 0 ? (
          <div className="empty">
            {sp.q
              ? t('orders.customer.empty.search')
              : archive
                ? t('orders.customer.empty.archive')
                : rich(t('orders.customer.empty.none'), { link: <Link href="/siparisler/yeni">{t('orders.customer.empty.firstOrder')}</Link> })}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('orders.cols.order')}</th><th>{t('orders.cols.status')}</th><th className="hide-sm">{t('orders.cols.next')}</th><th>{t('orders.cols.ship')}</th><th /></tr></thead>
              <tbody>
                {[...groups.entries()].map(([month, list]) => (
                  <GroupRows key={month} label={`${month} (${list.length})`} cols={5}>
                    {list.map((o) => (
                      <tr key={o.id}>
                        <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link>{o.profile && <> <Badge tone="purple">{t('profile.type')}</Badge></>}<div className="muted small">{o.title}</div></td>
                        {o.profile ? (() => {
                          const s = profileCustomerText(t, { status: o.status, stage: o.profile.stage });
                          return <><td><Badge tone={s.tone}>{s.label}</Badge></td><td className="hide-sm">{s.next}</td></>;
                        })() : (
                          <>
                            <td><CustomerBadge status={o.status} drawing={o.drawingTrack} offer={sentOf(o)} /></td>
                            <td className="hide-sm">{customerSummaryText(t, { status: o.status, drawing: o.drawingTrack, offer: sentOf(o) }).next}</td>
                          </>
                        )}
                        <td>{fmtDate(o.profile ? o.profile.pickupDate : o.actualShipDate ?? o.estimatedShipDate)}</td>
                        <td className="actions"><Link href={`/siparisler/${o.id}`} className="btn">{t('common.details')}</Link></td>
                      </tr>
                    ))}
                  </GroupRows>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------- İç ekip ----------------
async function InternalTable({ user, rows, empty, group = true }: { user: CurrentUser; rows: Row[]; empty: string; group?: boolean }) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  const { t, m, intl } = await getT();
  const { count } = counter(m, intl);
  const groups = new Map<string, Row[]>();
  for (const o of rows) {
    const k = group ? t('orders.internal.shipGroup', { date: fmtDate(o.estimatedShipDate) }) : '';
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t('orders.cols.order')}</th><th>{t('orders.cols.customer')}</th><th>{t('orders.cols.status')}</th><th>{t('orders.cols.drawing')}</th><th>{t('orders.cols.offer')}</th>
            <th className="hide-sm">{t('orders.cols.revision')}</th><th>{t('orders.cols.sla')}</th><th>{t('orders.cols.ship')}</th><th />
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([label, list]) => (
            <GroupRows key={label || 'all'} label={label ? `${label} (${list.length})` : ''} cols={9}>
              {list.map((o) => (
                <tr key={o.id}>
                  <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link>{o.profile && <> <Badge tone="purple">{t('profile.type')}</Badge></>}<div className="muted small">{o.title}</div></td>
                  <td className="mono">{customerLabel(user, o.customer.name)}</td>
                  {o.profile ? (
                    <>
                      <td>{o.status === 'IPTAL' ? <OrderBadge status={o.status} /> : <Badge tone={PROFILE_STAGE_TONE[o.profile.stage as keyof typeof PROFILE_STAGE_TONE]}>{profileStageText(t, o.profile.stage)}</Badge>}</td>
                      <td><span className="muted">—</span></td>
                      <td><span className="muted">—</span></td>
                    </>
                  ) : (
                    <>
                      <td><OrderBadge status={o.status} onHold={o.onHold} /></td>
                      <td>{o.status === 'YENI' ? <span className="muted">—</span> : <><DrawingBadge track={o.drawingTrack} />{o.drawings.length > 0 && <div className="muted small">{count('drawing', o.drawings.length)}</div>}</>}
                        {o.files.some((f) => /\.(dwg|dxf)$/i.test(f.name)) && <div><span className="badge badge-info" title={t('order.drawings.customerFiles')}>DWG/DXF</span></div>}</td>
                      <td>{o.status === 'YENI' ? <span className="muted">—</span> : <OfferBadge status={offerOf(o)} />}</td>
                    </>
                  )}
                  <td className="hide-sm">{o.revisionCount > 0 ? <span className="badge badge-danger">{t('orders.internal.revisions', { v: o.drawings.length, rounds: count('round', o.revisionCount) })}</span> : '—'}</td>
                  <td>{o.onHold ? <span className="muted">—</span> : <Sla deadline={o.slaDeadline} />}</td>
                  <td>{fmtDate(o.profile ? o.profile.pickupDate : o.estimatedShipDate)}</td>
                  <td className="actions"><Link href={`/siparisler/${o.id}`} className="btn">{t('common.open')}</Link></td>
                </tr>
              ))}
            </GroupRows>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, count, tone, id, children }: { title: string; count: number; tone?: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="card card-flush" id={id}>
      <div className="card-head">
        <h2>{title} <span className={`badge ${tone ?? ''}`}>{count}</span></h2>
      </div>
      {children}
    </div>
  );
}

async function InternalOrders({ user, sp }: { user: CurrentUser; sp: SP }) {
  const { t } = await getT();
  // "Sıra bende" yalnızca işlem yapan rollerde; denetimci doğrudan tüm aktif siparişleri görür
  const hasTurn = userCan(user, 'ORDER_REVIEW') || userCan(user, 'DRAWING_WORK');
  const view = sp.view ?? (hasTurn ? 'work' : 'all');
  // Çizim Paneli, çizim ekibinin bu sayfasıdır. Çizim yetkisi (DRAWING_WORK) olan ama kendi paneli başka olan kullanıcı
  // (yönetici) soldaki "Çizim Ekibi → Çizim Paneli" ile aynı paneli açar (?panel=cizim): aynı kapsam, aynı kuyruklar,
  // ekibin tamamı için. Yetkisi olmayan rollerde (satış, denetimci, müşteri) parametre yok sayılır. Satırlar yine
  // bakan kullanıcıya göre temizlenir: yönetici tam firma adını, çizim ekibi maskeli adı görür.
  const teamPanel = sp.panel === DRAWING_PANEL && userCan(user, 'DRAWING_WORK') && userCan(user, 'ORDER_REVIEW');
  /** Bu sayfanın bağlantıları: yöneticinin Çizim Paneli'nde panel parametresi korunur */
  const here = (params: Record<string, string | undefined> = {}, hash = '') => {
    const p = new URLSearchParams();
    if (teamPanel) p.set('panel', DRAWING_PANEL);
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    const qs = p.toString();
    return `/siparisler${qs ? `?${qs}` : ''}${hash}`;
  };
  const rows = sanitizeRows(user, await db.order.findMany({
    where: {
      ...orderScope(user),
      ...(teamPanel ? drawingScope : {}),
      ...searchWhere(sp.q),
      status: view === 'archive' ? { in: CLOSED as OrderStatus[] } : { notIn: CLOSED as OrderStatus[] },
    },
    include: listInclude,
    orderBy: [{ estimatedShipDate: view === 'archive' ? 'desc' : 'asc' }, { createdAt: 'asc' }],
    take: 300,
  }));

  const role = user.appRole;
  const queues = teamPanel
    ? queuesFor(rows, { review: false, send: false, drawing: true, allDrawers: true })
    : queuesFor(rows, { review: userCan(user, 'ORDER_REVIEW'), send: userCan(user, 'OFFER_SEND'), drawing: userCan(user, 'DRAWING_WORK'), userId: user.id });
  // Yöneticiye: karantinada virüslü dosya varsa uyarı (ayrıntı Entegrasyonlar sayfasında)
  // Yöneticiye: bekleyen önemli kararlar (ör. satışçı liste fiyatını değiştirdi) — girişte ilk bu görünür
  // (Çizim Paneli'nde gösterilmez: o panel çizim ekibinin gördüğüyle aynıdır)
  const alerts = !teamPanel && userCan(user, 'ALERT_VIEW') ? await db.adminAlert.count({ where: { resolvedAt: null } }) : 0;
  const infected = !teamPanel && userCan(user, 'SETTINGS_MANAGE')
    ? (await db.orderFile.count({ where: { scanStatus: 'INFECTED' } })) + (await db.drawing.count({ where: { scanStatus: 'INFECTED' } })) + (await db.drawingFile.count({ where: { scanStatus: 'INFECTED' } }))
    : 0;

  return (
    <>
      <div className="page-head">
        <h1>{role === 'CIZIM' || teamPanel ? t('orders.internal.titles.drawing') : role === 'ADMIN' ? t('orders.internal.titles.admin') : role === 'DENETIMCI' ? t('orders.internal.titles.inspector') : t('orders.internal.titles.sales')}</h1>
      </div>
      {alerts > 0 && (
        <div className="alert alert-warn">
          {t('orders.internal.alertsBanner', { n: alerts })} <Link href="/admin/kararlar">{t('orders.internal.alertsLink')}</Link>
        </div>
      )}
      {infected > 0 && (
        <div className="alert alert-error">
          {t('orders.internal.infectedBanner', { n: infected })} <Link href="/admin/entegrasyonlar#antivirus">{t('orders.internal.infectedLink')}</Link>
        </div>
      )}
      <div className="tabs">
        {hasTurn && <Link href={here()} className={view === 'work' ? 'active' : ''}>{t('orders.tabs.work')}</Link>}
        <Link href={here({ view: hasTurn ? 'all' : undefined })} className={view === 'all' ? 'active' : ''}>{t('orders.tabs.all')}</Link>
        <Link href={here({ view: 'archive' })} className={view === 'archive' ? 'active' : ''}>{t('orders.tabs.archive')}</Link>
      </div>
      <form className="toolbar">
        {teamPanel && <input type="hidden" name="panel" value={DRAWING_PANEL} />}
        <input type="hidden" name="view" value={view} />
        <input type="search" name="q" placeholder={t('orders.internal.searchPlaceholder')} defaultValue={sp.q ?? ''} />
        <button className="btn" type="submit">{t('common.search')}</button>
      </form>

      {view === 'work' && (
        <>
          {queues.map((q) => {
            if (q.key === 'held') {
              return (
                <Section key={q.key} title={t('status.onHold')} count={q.rows.length}>
                  <InternalTable user={user} rows={q.rows} empty="" />
                </Section>
              );
            }
            if (q.key === 'approvedDrawings') {
              // Onaylanmış çizimler (çizim ekibi, satış, yönetici): yükleme gününe göre süzülür ve gruplanır; grup içinde
              // onay zamanına göre en yeni / en eski. Satırlar bu kullanıcı için zaten temizlenmiş (maskeli firma adı).
              const oldest = sp.onay === 'eski';
              const list = approvedDrawingList(q.rows, { day: sp.yukleme, oldest, dayOf: isoDay });
              const href = (old: boolean) => here({ onay: old ? 'eski' : undefined, yukleme: list.day ?? undefined }, '#onayli-cizimler');
              return (
                <Section key={q.key} id="onayli-cizimler" title={t('orders.internal.sections.approvedDrawings.title')} count={list.rows.length}>
                  <div className="card-tools">
                    <span className="muted">{t('orders.internal.sortBy')}</span>
                    <Link href={href(false)} className={oldest ? '' : 'active'} aria-current={oldest ? undefined : 'true'}>{t('orders.internal.sortNewest')}</Link>
                    <Link href={href(true)} className={oldest ? 'active' : ''} aria-current={oldest ? 'true' : undefined}>{t('orders.internal.sortOldest')}</Link>
                    <form action="/siparisler#onayli-cizimler" className="card-filter">
                      {teamPanel && <input type="hidden" name="panel" value={DRAWING_PANEL} />}
                      {oldest && <input type="hidden" name="onay" value="eski" />}
                      <label htmlFor="onayli-yukleme">{t('orders.internal.shipFilter')}</label>
                      <select id="onayli-yukleme" name="yukleme" defaultValue={list.day ?? ''}>
                        <option value="">{t('orders.internal.shipAll')}</option>
                        {list.days.map((d) => <option key={d} value={d}>{fmtDate(new Date(`${d}T12:00:00Z`))}</option>)}
                      </select>
                      <button className="btn" type="submit">{t('orders.internal.shipApply')}</button>
                    </form>
                  </div>
                  <InternalTable user={user} rows={list.rows} empty={t('orders.internal.sections.approvedDrawings.empty')} />
                </Section>
              );
            }
            const k = q.key as Exclude<keyof Dict['orders']['internal']['sections'], 'active' | 'archive' | 'none'>;
            return (
              <Section key={q.key} title={t(`orders.internal.sections.${k}.title`)} count={q.rows.length} tone={q.key === 'sla' && q.rows.length ? 'badge-danger' : undefined}>
                <InternalTable user={user} rows={q.rows} empty={t(`orders.internal.sections.${k}.empty`)} group={false} />
              </Section>
            );
          })}
        </>
      )}
      {view !== 'work' && (
        <Section title={view === 'archive' ? t('orders.internal.sections.archive') : t('orders.internal.sections.active')} count={rows.length}>
          <InternalTable user={user} rows={rows} empty={t('orders.internal.sections.none')} />
        </Section>
      )}
      {!teamPanel && userCan(user, 'ORDER_CANCEL') && <RemovedOrders sp={sp} />}
    </>
  );
}

/**
 * Silinen siparişler (yalnızca yönetici; karar 110): olağan listelerde görünmezler (sipariş kapsamı silinmişleri dışlar).
 * Burada yalnızca geri yükleme için listelenir — ayrı bir "geri dönüşüm kutusu" ekranı yoktur.
 */
async function RemovedOrders({ sp }: { sp: SP }) {
  const { t, m } = await getT();
  const rows = await db.order.findMany({
    where: { removedAt: { not: null } },
    orderBy: { removedAt: 'desc' },
    take: 50,
    select: { id: true, orderNo: true, title: true, removedAt: true, customer: { select: { name: true } }, removedBy: { select: { name: true } }, _count: { select: { fgoDocuments: true } } },
  });
  const errors = m.compensation.remove.errors;
  const error = sp.silHata ? errors[sp.silHata as keyof typeof errors] ?? errors.NOT_FOUND : null;
  if (rows.length === 0 && !sp.silindi && !error) return null;
  return (
    <div className="card" id="silinen">
      {sp.silindi && <div className="alert alert-ok">{t('compensation.remove.ok', { order: sp.silindi })}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      <details className="removed-list" open={!!sp.silindi || !!error}>
        <summary>{t('compensation.remove.listTitle')} <span className="badge">{rows.length}</span></summary>
        <p className="muted small">{t('compensation.remove.listIntro')}</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('compensation.remove.colOrder')}</th><th>{t('compensation.remove.colCustomer')}</th><th>{t('compensation.remove.colWhen')}</th><th>{t('compensation.remove.colWho')}</th><th /></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} data-removed={o.orderNo}>
                  <td><span className="mono">{o.orderNo}</span>{o.title && <div className="small muted">{o.title}</div>}</td>
                  <td>{o.customer.name}</td>
                  <td className="nowrap">{fmtDateTime(o.removedAt)}{o._count.fgoDocuments > 0 && <div className="small muted">{t('compensation.remove.docs', { n: o._count.fgoDocuments })}</div>}</td>
                  <td>{o.removedBy?.name ?? '—'}</td>
                  <td className="actions">
                    <form action={restoreOrderAction}>
                      <input type="hidden" name="id" value={o.id} />
                      <ConfirmButton primary message={t('compensation.remove.restoreConfirm')}>{t('compensation.remove.restore')}</ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
