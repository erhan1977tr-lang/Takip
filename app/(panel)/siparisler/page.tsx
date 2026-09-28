import Link from 'next/link';
import type { OrderStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { customerLabel, orderScope } from '@/lib/orders';
import { fmtDate, fmtMonth } from '@/lib/format';
import { StatusBadge } from '@/components/StatusBadge';
import { CLOSED, STATUS, slaInfo } from '@/server/orders/rules.js';

const listInclude = {
  customer: { select: { name: true } },
  drawings: { select: { id: true } },
} satisfies Prisma.OrderInclude;
type Row = Prisma.OrderGetPayload<{ include: typeof listInclude }>;

type SP = Record<string, string | undefined>;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
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

function Sla({ deadline }: { deadline: Date | null }) {
  const s = slaInfo(deadline);
  if (!s) return <span className="muted">—</span>;
  return <span className={s.over ? 'sla-over' : s.risk ? 'sla-risk' : 'sla-ok'}>● {s.text}</span>;
}

// ---------------- Müşteri ----------------
async function CustomerOrders({ user, sp }: { user: CurrentUser; sp: SP }) {
  const archive = sp.view === 'archive';
  const orders = await db.order.findMany({
    where: {
      ...orderScope(user),
      ...searchWhere(sp.q),
      status: archive ? { in: ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'] } : { notIn: ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'] },
    },
    include: listInclude,
    orderBy: [{ estimatedShipDate: archive ? 'desc' : 'asc' }, { createdAt: 'desc' }],
  });
  const active = archive ? [] : orders;
  const count = (f: (o: Row) => boolean) => active.filter(f).length;
  const groups = new Map<string, Row[]>();
  for (const o of orders) {
    const k = o.estimatedShipDate ? fmtMonth(o.estimatedShipDate) : 'Tarih belirlenmedi';
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>{user.customer?.name} — Siparişlerim</h1>
          <p className="muted">Sipariş bilgisini ve teknik dosyanızı yükleyin; sürecin tamamını buradan izleyin.</p>
        </div>
        <Link href="/siparisler/yeni" className="btn btn-primary">+ Yeni Sipariş</Link>
      </div>
      {sp.ok === 'created' && <div className="alert alert-ok">Siparişiniz alındı. Satış ekibi inceleyip size dönecek.</div>}

      {!archive && (
        <div className="stats">
          <div className="stat" style={{ borderLeftColor: '#f59e0b' }}><div className="k">Onayınız bekleniyor</div><div className="v">{count((o) => o.status === 'ONAY_BEKLIYOR' || o.status === 'FIYATLANDI')}<small>sipariş</small></div></div>
          <div className="stat" style={{ borderLeftColor: '#7c3aed' }}><div className="k">Çizim hazırlanıyor</div><div className="v">{count((o) => ['CIZIM_GEREKLI', 'CIZIM_YAPILIYOR', 'REVIZYON_ISTENDI'].includes(o.status))}<small>sipariş</small></div></div>
          <div className="stat" style={{ borderLeftColor: '#047857' }}><div className="k">Onaylandı, üretimde</div><div className="v">{count((o) => o.status === 'URETIMDE')}<small>sipariş</small></div></div>
          <div className="stat"><div className="k">Toplam aktif</div><div className="v">{active.length}<small>sipariş</small></div></div>
        </div>
      )}

      <div className="tabs">
        <Link href="/siparisler" className={archive ? '' : 'active'}>Aktif</Link>
        <Link href="/siparisler?view=archive" className={archive ? 'active' : ''}>Yüklenen ve arşiv</Link>
      </div>
      <form className="toolbar">
        {archive && <input type="hidden" name="view" value="archive" />}
        <input type="search" name="q" placeholder="Sipariş ara — ad, sipariş no ya da kendi numaranız" defaultValue={sp.q ?? ''} />
        <button className="btn" type="submit">Ara</button>
      </form>

      <div className="card card-flush">
        {orders.length === 0 ? (
          <div className="empty">{sp.q ? 'Aramaya uyan sipariş yok.' : archive ? 'Arşivde sipariş yok.' : <>Henüz aktif siparişiniz yok. <Link href="/siparisler/yeni">İlk siparişinizi oluşturun →</Link></>}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sipariş</th><th>Durum</th><th className="hide-sm">Sıradaki adım</th><th>Tahmini yükleme</th><th /></tr></thead>
              <tbody>
                {[...groups.entries()].map(([month, list]) => (
                  <GroupRows key={month} label={`${month} (${list.length})`} cols={5}>
                    {list.map((o) => (
                      <tr key={o.id}>
                        <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                        <td><StatusBadge status={o.status} customer /></td>
                        <td className="hide-sm">{STATUS[o.status as keyof typeof STATUS]?.next}</td>
                        <td>{fmtDate(o.actualShipDate ?? o.estimatedShipDate)}</td>
                        <td className="actions"><Link href={`/siparisler/${o.id}`} className="btn">Detay</Link></td>
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

function GroupRows({ label, cols, children }: { label: string; cols: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="group-row"><td colSpan={cols}>{label}</td></tr>
      {children}
    </>
  );
}

// ---------------- İç ekip ----------------
function InternalTable({ user, rows, empty, group = true }: { user: CurrentUser; rows: Row[]; empty: string; group?: boolean }) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  const groups = new Map<string, Row[]>();
  for (const o of rows) {
    const k = group ? `Yükleme: ${fmtDate(o.estimatedShipDate)}` : '';
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Sipariş</th><th>Müşteri</th><th>Durum</th><th className="hide-sm">Çizim</th><th className="hide-sm">Revizyon</th><th>SLA</th><th>Tahmini yükleme</th><th /></tr></thead>
        <tbody>
          {[...groups.entries()].map(([label, list]) => (
            <GroupRows key={label || 'all'} label={label ? `${label} (${list.length})` : ''} cols={8}>
              {list.map((o) => (
                <tr key={o.id}>
                  <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                  <td className="mono">{customerLabel(user, o.customer.name)}</td>
                  <td><StatusBadge status={o.status} onHold={o.onHold} /></td>
                  <td className="hide-sm">{o.needsDrawing ? `${o.drawings.length} çizim` : <span className="muted">Çizimsiz</span>}</td>
                  <td className="hide-sm">{o.revisionCount > 0 ? <span className="badge badge-danger">v{o.drawings.length} · {o.revisionCount} tur</span> : '—'}</td>
                  <td>{o.onHold ? <span className="muted">—</span> : <Sla deadline={o.slaDeadline} />}</td>
                  <td>{fmtDate(o.estimatedShipDate)}</td>
                  <td className="actions"><Link href={`/siparisler/${o.id}`} className="btn">Aç</Link></td>
                </tr>
              ))}
            </GroupRows>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, count, tone, children }: { title: string; count: number; tone?: string; children: React.ReactNode }) {
  return (
    <div className="card card-flush">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>{title} <span className={`badge ${tone ?? ''}`}>{count}</span></h2>
      </div>
      {children}
    </div>
  );
}

async function InternalOrders({ user, sp }: { user: CurrentUser; sp: SP }) {
  const view = sp.view ?? 'work';
  const base: Prisma.OrderWhereInput = { ...orderScope(user), ...searchWhere(sp.q) };
  const rows = await db.order.findMany({
    where: {
      ...base,
      status: view === 'archive' ? { in: CLOSED as OrderStatus[] } : { notIn: CLOSED as OrderStatus[] },
    },
    include: listInclude,
    orderBy: [{ estimatedShipDate: view === 'archive' ? 'desc' : 'asc' }, { createdAt: 'asc' }],
    take: 300,
  });

  const now = Date.now();
  const late = (o: Row) => !o.onHold && o.slaDeadline && o.slaDeadline.getTime() - now < 6 * 3_600_000;
  const role = user.appRole;
  const myTurn: { title: string; rows: Row[]; empty: string }[] = [];
  if (role === 'SATIS' || role === 'ADMIN') {
    myTurn.push({ title: 'Yeni siparişler — karar bekliyor', rows: rows.filter((o) => o.status === 'YENI' && !o.onHold), empty: 'Karar bekleyen sipariş yok.' });
    myTurn.push({ title: 'Teklif hazırlanacaklar', rows: rows.filter((o) => o.status === 'TEKLIF_HAZIRLANIYOR' && !o.onHold), empty: 'Hazırlanacak teklif yok.' });
  }
  if (role === 'ADMIN') {
    myTurn.push({ title: 'Fiyat onayı bekleyen teklifler', rows: rows.filter((o) => o.status === 'FIYAT_BEKLIYOR' && !o.onHold), empty: 'Onay bekleyen teklif yok.' });
  }
  if (role === 'CIZIM') {
    myTurn.push({ title: 'Çizim işleri', rows: rows.filter((o) => ['CIZIM_GEREKLI', 'CIZIM_YAPILIYOR', 'REVIZYON_ISTENDI'].includes(o.status) && !o.onHold), empty: 'Bekleyen çizim işi yok.' });
  }
  const risky = rows.filter(late);
  const held = rows.filter((o) => o.onHold);

  return (
    <>
      <div className="page-head">
        <h1>{role === 'CIZIM' ? 'Çizim Paneli' : role === 'ADMIN' ? 'Siparişler' : 'Satış Paneli'}</h1>
      </div>
      <div className="tabs">
        <Link href="/siparisler" className={view === 'work' ? 'active' : ''}>Sıra bende</Link>
        <Link href="/siparisler?view=all" className={view === 'all' ? 'active' : ''}>Tüm aktif siparişler</Link>
        <Link href="/siparisler?view=archive" className={view === 'archive' ? 'active' : ''}>Yüklenen ve arşiv</Link>
      </div>
      <form className="toolbar">
        <input type="hidden" name="view" value={view} />
        <input type="search" name="q" placeholder="Sipariş no / başlık ara" defaultValue={sp.q ?? ''} />
        <button className="btn" type="submit">Ara</button>
      </form>

      {view === 'work' && (
        <>
          {myTurn.map((s) => (
            <Section key={s.title} title={s.title} count={s.rows.length}>
              <InternalTable user={user} rows={s.rows} empty={s.empty} />
            </Section>
          ))}
          <Section title="SLA riski / gecikenler" count={risky.length} tone={risky.length ? 'badge-danger' : ''}>
            <InternalTable user={user} rows={risky} empty="Geciken sipariş yok." />
          </Section>
          {held.length > 0 && (
            <Section title="Beklemede" count={held.length}>
              <InternalTable user={user} rows={held} empty="" />
            </Section>
          )}
        </>
      )}
      {view !== 'work' && (
        <Section title={view === 'archive' ? 'Yüklenen ve arşiv' : 'Aktif siparişler'} count={rows.length}>
          <InternalTable user={user} rows={rows} empty="Sipariş yok." />
        </Section>
      )}
    </>
  );
}
