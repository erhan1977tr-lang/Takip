import Link from 'next/link';
import { db } from '@/lib/db';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { currentOffer, customerLabel, loadOrder, sentOffer, type OrderDetail } from '@/lib/orders';
import { fmtBytes, fmtDate, fmtDateTime, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/roles';
import { CustomerBadge, DrawingBadge, OfferBadge, OrderBadge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { OfferEditor } from './OfferEditor';
import { loadOf } from '@/lib/loading';
import { CRATE_MAX_KG, CRATE_TARE_KG } from '@/server/orders/loading.js';
import {
  EVENTS, LINE_KIND, STAGES, availableActions, customerDrawingLabel, customerSummary, offerLineTotals, offerNeedsCheck, productionBlockers, slaInfo, stageIndex,
} from '@/server/orders/rules.js';
import {
  addFilesAction, addNoteAction, approveDrawingAction, archiveAction, cancelAction, checkOfferAction, holdAction, saveCratesAction,
  markShippedAction, noDrawingAction, requestRevisionAction, sendToDrawingAction, setShipDateAction,
  startDrawingAction, undoDrawingAction, undoNoDrawingAction, uploadDrawingAction,
} from './actions';

const OK: Record<string, string> = {
  created: 'Siparişiniz alındı. Satış ekibi inceleyip size dönecek.',
  to_drawing: 'Sipariş çizim ekibine yönlendirildi. Teklifi de şimdi hazırlayabilirsiniz.',
  to_offer: 'Çizim gerekmiyor olarak işaretlendi. Teklif tablosunu doldurup yöneticiye gönderin.',
  held: 'Sipariş beklemeye alındı.',
  unheld: 'Sipariş beklemeden çıkarıldı.',
  unheld_production: 'Sipariş beklemeden çıkarıldı ve koşullar tamam olduğu için otomatik olarak üretime alındı.',
  ship_date: 'Tahmini yükleme tarihi güncellendi.',
  shipped: 'Sipariş yüklendi olarak işaretlendi.',
  archived: 'Sipariş arşivlendi.',
  cancelled: 'Sipariş iptal edildi.',
  drawing_started: 'Çizim işini üstlendiniz.',
  drawing_uploaded: 'Çizim yüklendi ve müşterinin onayına gönderildi.',
  drawing_approved: 'Çizimi onayladınız. Teşekkürler.',
  drawing_approved_production: 'Çizimi onayladınız. Teklifiniz de hazır olduğu için siparişiniz üretime alındı.',
  revision_requested: 'Revizyon talebiniz çizim ekibine iletildi.',
  files_added: 'Dosyalar eklendi.',
  note_added: 'Not eklendi.',
  offer_saved: 'Teklif taslak olarak kaydedildi.',
  offer_submit: 'Teklif sistem yöneticisinin onayına gönderildi.',
  offer_approve: 'Fiyat onaylandı; teklif müşterinin panelinde.',
  offer_approve_production: 'Fiyat onaylandı; teklif müşterinin panelinde. Çizim onaylı (ya da gereksiz) olduğu için sipariş otomatik olarak üretime alındı.',
  offer_return: 'Teklif satışa geri gönderildi.',
  offer_updated: 'Teklif güncellendi; müşteri yeni sürümü görüyor.',
  offer_checked: 'Teklif yeni çizime göre güncel olarak işaretlendi.',
  undo_drawing: 'Çizime gönderme geri alındı. Sipariş yeniden karar bekliyor; teklif taslağı korundu.',
  crates_saved: 'Sandık ölçü ve ağırlıkları kaydedildi; yükleme planı güncellendi.',
  undo_no_drawing: 'Teklife gönderme geri alındı. Sipariş yeniden karar bekliyor; teklif taslağı korundu.',
};

// "Sıradaki adım" satırında gösterilen işlemler
const STEP_LABEL: Record<string, string> = {
  send_to_drawing: 'Çizim Ekibine Gönder', no_drawing: 'Teklife Gönder', edit_offer: 'Teklifi hazırla', approve_price: 'Fiyatı onayla',
  start_drawing: 'Çizimi üstlen', upload_drawing: 'Çizimi yükle', approve_drawing: 'Çizimi onayla',
  request_revision: 'Revizyon iste', mark_shipped: 'Yüklendi olarak işaretle', archive: 'Arşivle', unhold: 'Beklemeden çıkar',
};

function turnText(order: OrderDetail): string {
  if (order.onHold) return 'Beklemede';
  const offer = currentOffer(order)?.status ?? null;
  if (order.status === 'YENI') return 'satış';
  if (order.status === 'URETIMDE') return 'satış (yükleme)';
  if (order.status === 'YUKLENDI') return 'satış (arşiv)';
  if (order.status !== 'HAZIRLANIYOR') return '—';
  const parts: string[] = [];
  const d = order.drawingTrack;
  if (d === 'GEREKLI' || d === 'YAPILIYOR' || d === 'REVIZYON_ISTENDI') parts.push('çizim ekibi');
  if (d === 'ONAY_BEKLIYOR') parts.push('müşteri (çizim onayı)');
  if (offer === null || offer === 'HAZIRLANIYOR') parts.push('satış (teklif)');
  if (offer === 'YONETIMDE') parts.push('sistem yöneticisi (fiyat onayı)');
  return parts.join(' · ') || '—';
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const order = await loadOrder(id, user);
  const isCustomer = user.appRole === 'MUSTERI';
  const offer = currentOffer(order);
  const sent = sentOffer(order);
  const acts = availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: offer?.status ?? null,
  });
  const can = (a: string) => acts.includes(a);
  const sla = isCustomer ? null : slaInfo(order.slaDeadline);
  const stage = stageIndex(order.status);
  const editable = !!offer && (can('edit_offer') || can('approve_price'));
  const updating = !editable && !!offer && can('update_offer') && sp.teklif === 'guncelle';
  const catalog = editable || updating
    ? (await db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true } })).map((g) => g.name)
    : [];
  const shownOffer = isCustomer ? sent : editable || updating ? undefined : offer;
  const sentVersions = order.offers.filter((o) => o.status === 'GONDERILDI').length;
  const lastDrawing = order.drawings[order.drawings.length - 1];
  // Teklif müşteriye gittikten sonra yeni çizim geldiyse ölçüler değişmiş olabilir (events en yeniden eskiye sıralı)
  const needsCheck = !isCustomer && user.appRole !== 'CIZIM' && (order.status === 'HAZIRLANIYOR' || order.status === 'URETIMDE') && offerNeedsCheck({
    offer: offer?.status ?? null, sentAt: offer?.sentAt ?? null, lastDrawing: lastDrawing ?? null,
    checkedAt: order.events.find((e) => e.event === 'OFFER_CHECKED')?.createdAt ?? null,
  });
  const updateHref = `/siparisler/${order.id}?teklif=guncelle#teklif`;

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p className="small"><Link href="/siparisler">← {isCustomer ? 'Siparişlerim' : 'Siparişler'}</Link></p>
          <h1>{order.title || order.orderNo}</h1>
          <div className="row">
            <span className="mono muted">{order.orderNo}</span>
            {isCustomer
              ? <CustomerBadge status={order.status} drawing={order.drawingTrack} offer={sent ? 'GONDERILDI' : null} />
              : <OrderBadge status={order.status} onHold={order.onHold} />}
            {!isCustomer && <span className="muted small">· {customerLabel(user, order.customer.name)}</span>}
          </div>
        </div>
        {sla && <span className={sla.over ? 'sla-over' : sla.risk ? 'sla-risk' : 'sla-ok'}>● {sla.text}</span>}
      </div>

      {sp.ok && OK[sp.ok] && <div className="alert alert-ok">{OK[sp.ok]}</div>}
      {sp.error && <div className="alert alert-error">{sp.error}</div>}

      <div className="card">
        <div className="stepper">
          {STAGES.map((label, i) => {
            const cls = i < stage ? 'done' : i === stage ? 'current' : '';
            return (
              <div key={label} className={`step ${cls}`}>
                <div className="dot">{i < stage ? '✓' : String(i + 1).padStart(2, '0')}</div>
                <div className="lbl">{label}</div>
                {i === stage && sla && <div className={`sla-chip ${sla.over ? 'over' : ''}`}>{sla.text}</div>}
              </div>
            );
          })}
        </div>
        {order.status === 'HAZIRLANIYOR' && (
          <div className="tracks">
            <div className="track">
              <span className="k">Çizim</span>
              {isCustomer
                ? <span>{customerDrawingLabel(order.drawingTrack)}</span>
                : <DrawingBadge track={order.drawingTrack} />}
            </div>
            <div className="track">
              <span className="k">Teklif</span>
              {isCustomer ? <span>{sent ? 'Teklifiniz hazır' : 'Hazırlanıyor'}</span> : <OfferBadge status={offer?.status} />}
            </div>
          </div>
        )}
      </div>

      {needsCheck && lastDrawing && (
        <div className="alert alert-warn">
          <b>Teklif müşteriye gönderildikten sonra revize çizim yüklendi (v{lastDrawing.version}, {fmtDateTime(lastDrawing.createdAt)}).</b>{' '}
          {can('update_offer')
            ? 'Ölçüler değiştiyse teklifi güncelleyin; değişmediyse güncel olarak işaretleyin.'
            : 'Ölçüler değiştiyse teklifin güncellenmesi için sistem yöneticisine haber verin. Gönderilmiş teklifi yalnızca yönetici değiştirebilir.'}
          {can('update_offer') && !updating && (
            <div className="row" style={{ marginTop: 10 }}>
              <Link href={updateHref} className="btn btn-primary">Teklifi güncelle</Link>
              <form action={checkOfferAction}>
                <input type="hidden" name="id" value={order.id} />
                <button className="btn">Teklif güncel, değişiklik yok</button>
              </form>
            </div>
          )}
        </div>
      )}

      {isCustomer ? <CustomerActions order={order} user={user} can={can} /> : <InternalActions order={order} user={user} can={can} acts={acts} />}

      {(editable || updating) && offer && (
        <OfferEditor
          orderId={order.id}
          mode={updating ? 'update' : can('approve_price') ? 'admin' : 'sales'}
          cancelHref={`/siparisler/${order.id}#teklif`}
          currency={offer.currency}
          catalog={catalog}
          statusLabel={updating ? `müşteride · sürüm ${sentVersions + 1} hazırlanıyor` : offer.status === 'YONETIMDE' ? 'yönetici onayında' : 'satışta hazırlanıyor'}
          camEtiket={order.camEtiket ?? order.customer.camEtiket ?? ''}
          sandikEtiket={order.sandikEtiket ?? order.customer.sandikEtiket ?? ''}
          initial={offer.lines.map((l) => ({
            description: l.description, poz: l.poz ?? '', enMm: l.enMm?.toString() ?? '', boyMm: l.boyMm?.toString() ?? '',
            adet: String(l.adet), unit: l.unit, unitPrice: Number(l.unitPrice) ? Number(l.unitPrice).toFixed(2) : '',
            kind: l.kind, free: l.free,
          }))}
        />
      )}

      <div className="detail-grid">
        <div>
          {shownOffer && (
            <OfferView order={order} offer={shownOffer} isCustomer={isCustomer} versions={sentVersions} updateHref={can('update_offer') ? updateHref : undefined} />
          )}
          {!isCustomer && order.status !== 'YENI' && <Crates order={order} canEdit={can('edit_crates')} />}
          <Drawings order={order} user={user} />
          <Files order={order} user={user} canAdd={can('add_file')} />
          <Notes order={order} user={user} />
        </div>

        <aside>
          <div className="card">
            <h2>Sipariş bilgileri</h2>
            <table className="kv"><tbody>
              <tr><td>Sipariş no</td><td className="mono">{order.orderNo}</td></tr>
              <tr><td>Müşteri sipariş no</td><td>{order.customerOrderNo}</td></tr>
              {!isCustomer && <tr><td>Müşteri</td><td>{customerLabel(user, order.customer.name)}</td></tr>}
              <tr><td>Sipariş tarihi</td><td>{fmtDate(order.createdAt)}</td></tr>
              <tr><td>Tahmini yükleme</td><td>{fmtDate(order.estimatedShipDate)}</td></tr>
              {order.actualShipDate && <tr><td>Yüklendi</td><td>{fmtDate(order.actualShipDate)}</td></tr>}
              <tr><td>Çizim</td><td>{order.status === 'YENI' ? (isCustomer ? '—' : 'Karar bekliyor') : order.drawingTrack === 'YOK' ? 'Gerekmiyor' : 'Gerekli'}</td></tr>
              {order.drawingTrack !== 'YOK' && <tr><td>Revizyon</td><td>{order.revisionCount} tur</td></tr>}
              {order.assignedDrawer && !isCustomer && <tr><td>Çizimci</td><td>{order.assignedDrawer.name || order.assignedDrawer.email}</td></tr>}
              {!isCustomer && <tr><td>Cam / sandık etiketi</td><td>{order.camEtiket ?? '—'} / {order.sandikEtiket ?? '—'}</td></tr>}
            </tbody></table>
            {order.items.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>İstenen camlar</h2>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {order.items.map((it) => <li key={it.id}>{it.glassName || 'Cam'} × {it.camAdedi}</li>)}
                </ul>
              </>
            )}
          </div>
          <div className="card">
            <h2>Hareketler</h2>
            <ul className="timeline">
              {order.events.map((e) => {
                const def = EVENTS[e.event as keyof typeof EVENTS];
                if (isCustomer && !def?.customer) return null;
                const label = isCustomer ? def.customer : def?.label ?? e.event;
                const showNote = e.note && (!isCustomer || ('note' in def && def.note));
                return (
                  <li key={e.id}>
                    <div><b>{label}</b>{showNote ? ` — ${e.note}` : ''}</div>
                    <div className="when">{fmtDateTime(e.createdAt)}{!isCustomer && e.user ? ` · ${e.user.name || e.user.email}` : ''}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}

// ---------------- işlem kartları ----------------
function CustomerActions({ order, user, can }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean }) {
  const s = customerSummary({ status: order.status, drawing: order.drawingTrack, offer: sentOffer(order) ? 'GONDERILDI' : null });
  const hidden = <input type="hidden" name="id" value={order.id} />;
  const waiting = order.drawingTrack === 'ONAY_BEKLIYOR' && order.status === 'HAZIRLANIYOR';
  return (
    <div className={`card ${waiting ? 'turn' : ''}`}>
      <h2 style={{ marginBottom: 4 }}>{s.next}</h2>
      {waiting && !user.canApprove && (
        <div className="alert alert-warn" style={{ marginTop: 8 }}>Çizim onayınızı bekliyor. Hesabınızın onay yetkisi yok; firmanızdaki onay yetkili kullanıcı onaylayabilir. Siz revizyon isteyebilirsiniz.</div>
      )}
      {waiting && <p className="muted small">Çizimi aşağıdaki “Teknik çizimler” bölümünden indirip inceleyin.</p>}
      {can('approve_drawing') && (
        <form action={approveDrawingAction} style={{ marginTop: 10 }}>
          {hidden}
          <ConfirmButton primary message="Çizimi onaylıyor musunuz?">Çizimi onayla</ConfirmButton>
        </form>
      )}
      {can('request_revision') && (
        <form action={requestRevisionAction} style={{ marginTop: 14 }}>
          {hidden}
          <label htmlFor="rev-comment">Revizyon talebi</label>
          <textarea id="rev-comment" name="comment" rows={2} required placeholder="Çizimde neyin değişmesi gerektiğini yazın" />
          <div className="row end" style={{ marginTop: 8 }}><button className="btn btn-danger">Revizyon iste</button></div>
        </form>
      )}
      {!waiting && <p className="muted small">Şu an sizden beklenen bir işlem yok.</p>}
    </div>
  );
}

function InternalActions({ order, user, can, acts }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean; acts: string[] }) {
  const hidden = <input type="hidden" name="id" value={order.id} />;
  const offerStatus = currentOffer(order)?.status ?? null;
  const steps = acts.filter((a) => STEP_LABEL[a]).map((a) => STEP_LABEL[a]);
  const blockers = order.status === 'HAZIRLANIYOR' && !order.onHold && (user.appRole === 'SATIS' || user.appRole === 'ADMIN')
    ? productionBlockers({ status: order.status, drawing: order.drawingTrack, offer: offerStatus })
    : [];
  const buttons: React.ReactNode[] = [];
  const btn = (key: string, action: (fd: FormData) => Promise<void>, label: string, extra?: React.ReactNode, confirm?: string) =>
    buttons.push(
      <form key={key} action={action}>
        {hidden}{extra}
        {confirm ? <ConfirmButton primary message={confirm}>{label}</ConfirmButton> : <button className="btn btn-primary">{label}</button>}
      </form>
    );

  if (can('send_to_drawing')) btn('d', sendToDrawingAction, 'Çizim Ekibine Gönder');
  if (can('no_drawing')) btn('o', noDrawingAction, 'Teklife Gönder');
  if (can('start_drawing')) btn('sd', startDrawingAction, 'Çizimi üstlen');
  if (can('mark_shipped')) btn('ms', markShippedAction, 'Yüklendi olarak işaretle');
  if (can('archive')) btn('ar', archiveAction, 'Arşivle');
  const undo = (key: string, action: (fd: FormData) => Promise<void>, label: string, message: string) =>
    buttons.push(<form key={key} action={action}>{hidden}<ConfirmButton message={message}>{label}</ConfirmButton></form>);
  if (can('undo_drawing')) undo('ud', undoDrawingAction, 'Çizime Göndermeyi Geri Al', 'Çizime gönderme geri alınsın mı? Sipariş yeniden karar bekler; teklif taslağı korunur.');
  if (can('undo_no_drawing')) undo('un', undoNoDrawingAction, 'Teklife Göndermeyi Geri Al', 'Teklife gönderme geri alınsın mı? Sipariş yeniden karar bekler; teklif taslağı korunur.');
  if (can('hold')) btn('h', holdAction, 'Beklemeye Al', <input type="hidden" name="hold" value="1" />);
  if (can('unhold')) btn('uh', holdAction, 'Beklemeden çıkar', <input type="hidden" name="hold" value="0" />);

  const hasForms = can('upload_drawing') || can('set_ship_date') || can('cancel');

  return (
    <>
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Sıra {turnText(order)} tarafında.</h2>
        <p className="muted small">
          {steps.length ? <>Sıradaki adım: {steps.join(' · ')}</> : 'Bu durumda sizin rolünüz için bir işlem yok.'}
          {' '}· Rolünüz: {ROLE_LABEL[user.appRole]}
        </p>
      </div>

      {(buttons.length > 0 || hasForms || blockers.length > 0) && (
        <div className="card turn">
          <h2 style={{ marginBottom: 2 }}>Yapılabilecek işlemler</h2>
          <p className="muted small">Bu durumda siparişi ilerletebileceğiniz komutlar.</p>
          {buttons.length > 0 && <div className="row" style={{ marginTop: 10 }}>{buttons}</div>}

          {blockers.length > 0 && (
            <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
              <b>Otomatik üretime geçmesi için bekleniyor:</b> {blockers.join(' · ')}
            </div>
          )}

          {can('upload_drawing') && (
            <form action={uploadDrawingAction} style={{ marginTop: 14 }}>
              {hidden}
              <label htmlFor="drawing-file">{order.drawingTrack === 'REVIZYON_ISTENDI' ? 'Revize çizimi yükle' : 'Çizimi yükle'} (v{order.drawings.length + 1}) — yüklenince müşterinin onayına gider</label>
              <div className="row">
                <input id="drawing-file" name="file" type="file" required accept=".pdf,.dwg,.dxf,.jpg,.jpeg,.png,.zip" style={{ flex: 1 }} />
                <button className="btn btn-primary">Yükle ve onaya gönder</button>
              </div>
            </form>
          )}

          {can('set_ship_date') && (
            <form action={setShipDateAction} className="row" style={{ marginTop: 14 }}>
              {hidden}
              <label htmlFor="ship-date" style={{ margin: 0 }}>Tahmini yükleme</label>
              <input id="ship-date" name="date" type="date" defaultValue={isoDay(order.estimatedShipDate)} style={{ width: 'auto' }} required />
              <button className="btn">Tarihi güncelle</button>
            </form>
          )}

          {can('cancel') && (
            <details style={{ marginTop: 14 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Siparişi iptal et</summary>
              <form action={cancelAction} className="row" style={{ marginTop: 8 }}>
                {hidden}
                <input name="note" type="text" required placeholder="İptal nedeni" style={{ flex: 1 }} />
                <ConfirmButton danger message="Sipariş iptal edilsin mi? Bu işlem geri alınamaz.">İptal et</ConfirmButton>
              </form>
            </details>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- teklif ----------------
type Offer = OrderDetail['offers'][number];

function OfferView({ order, offer, isCustomer, versions, updateHref }: { order: OrderDetail; offer: Offer; isCustomer: boolean; versions: number; updateHref?: string }) {
  const total = offer.status === 'GONDERILDI' && order.price && isCustomer ? order.price.amount : offer.amount;
  const updated = offer.status === 'GONDERILDI' && versions > 1;
  return (
    <div className="card" id="teklif">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{isCustomer ? 'Teklifiniz' : 'Teklif'}</h2>
        <span className="row">
          {!isCustomer && <OfferBadge status={offer.status} />}
          {!isCustomer && updated && <span className="badge badge-info">sürüm {versions}</span>}
          {offer.sentAt && <span className="muted small">{updated ? 'Güncellendi: ' : isCustomer ? '' : 'Gönderildi: '}{fmtDate(offer.sentAt)}</span>}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Açıklama</th><th>Poz</th><th className="num">En</th><th className="num">Boy</th><th className="num">Adet</th><th className="num">Metraj</th><th className="num">Birim fiyat</th><th className="num">Tutar</th></tr></thead>
          <tbody>
            {(() => {
              let n = 0;
              return offer.lines.map((l) => {
                const t = offerLineTotals({ ...l, unitPrice: l.unitPrice.toString() });
                const sub = l.kind === 'CNC' || l.kind === 'DELIK';
                if (!sub) n += 1;
                const kindLabel = LINE_KIND[l.kind as keyof typeof LINE_KIND];
                return (
                  <tr key={l.id} className={sub ? 'sub-line' : undefined}>
                    <td className="muted">{sub ? '' : n}</td>
                    <td>
                      {sub && <span className="badge badge-info">{kindLabel}</span>}{' '}
                      {sub && l.description === kindLabel ? '' : l.description}
                      {l.free && <> <span className="badge badge-ok">bedelsiz</span></>}
                    </td>
                    <td>{l.poz ?? ''}</td>
                    <td className="num">{l.enMm ?? ''}</td><td className="num">{l.boyMm ?? ''}</td><td className="num">{l.adet}</td>
                    <td className="num">{!sub && l.unit === 'm2' ? `${fmtNum(t.metraj)} m²` : '—'}</td>
                    <td className="num">{l.free ? 'bedelsiz' : `${fmtNum(l.unitPrice.toString())} / ${!sub && l.unit === 'm2' ? 'm²' : 'adet'}`}</td>
                    <td className="num">{fmtNum(t.amount)}</td>
                  </tr>
                );
              });
            })()}
          </tbody>
          <tfoot><tr><td colSpan={8}>Toplam</td><td className="num"><b>{fmtMoney(total.toString(), offer.currency)}</b></td></tr></tfoot>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <p className="muted small" style={{ margin: 0 }}>Fiyatlar KDV hariçtir.</p>
        {updateHref && <Link href={updateHref} className="btn">Teklifi güncelle</Link>}
      </div>
    </div>
  );
}

// ---------------- sandıklar ----------------
function Crates({ order, canEdit }: { order: OrderDetail; canEdit: boolean }) {
  const load = loadOf(order, false);
  const blanks = Math.max(1, 2 - order.crates.length) + (order.crates.length ? 0 : 1);
  const rows = [...order.crates.map((c) => ({ key: c.id, dim: c.dimensions ?? '', net: c.netAgirlik?.toString() ?? '', brut: c.brutAgirlik?.toString() ?? '' })),
    ...Array.from({ length: canEdit ? blanks : 0 }, (_, i) => ({ key: `new${i}`, dim: '', net: '', brut: '' }))];
  return (
    <div className="card" id="sandik">
      <h2>Sandık ölçüleri ve ağırlıkları</h2>
      <p className="muted small">
        Yükleme planı: {fmtNum(load.metraj)} m² · {load.camAdet} cam · net {fmtNum(load.netKg, 0)} kg · {load.crates} sandık · brüt {fmtNum(load.grossKg, 0)} kg
        {load.realCrates
          ? ' (girilen gerçek kayıtlar).'
          : ` (tahmin: cam ağırlığı ${fmtNum(CRATE_MAX_KG, 0)} kg'a bölünüp yukarı yuvarlanır, sandık başına ${CRATE_TARE_KG} kg dara). Gerçek ölçü ve ağırlıkları girince tahminin önüne geçer.`}
      </p>
      {rows.length > 0 && (
        <form action={saveCratesAction}>
          <input type="hidden" name="id" value={order.id} />
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Ölçü (ör. 2400×1600×900 mm)</th><th>Net (kg)</th><th>Brüt (kg)</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.key}>
                    <td className="muted">{i + 1}</td>
                    <td><input name="c_dim" defaultValue={r.dim} disabled={!canEdit} aria-label="Sandık ölçüsü" /></td>
                    <td><input name="c_net" inputMode="decimal" defaultValue={r.net} disabled={!canEdit} style={{ width: 100 }} aria-label="Net kg" /></td>
                    <td><input name="c_brut" inputMode="decimal" defaultValue={r.brut} disabled={!canEdit} style={{ width: 100 }} aria-label="Brüt kg" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span className="hint">Daha fazla sandık için kaydedin; yeni boş satır açılır. Satırı silmek için alanlarını boşaltın.</span>
              <button className="btn btn-primary">Sandıkları kaydet</button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

// ---------------- çizim, dosya, not ----------------
function Drawings({ order, user }: { order: OrderDetail; user: CurrentUser }) {
  if (order.drawingTrack === 'YOK' && order.drawings.length === 0) return null;
  const isCustomer = user.appRole === 'MUSTERI';
  return (
    <div className="card">
      <h2>Teknik çizimler ve onay</h2>
      {order.drawings.length === 0 ? (
        <p className="muted">Henüz çizim yok.</p>
      ) : (
        [...order.drawings].reverse().map((d, i) => (
          <div key={d.id} style={{ marginBottom: 10 }}>
            <div className="file-row">
              <div className="file-ext">{(d.fileName ?? '').split('.').pop()?.slice(0, 4) || 'dosya'}</div>
              <div className="grow">
                <div className="fname">{d.fileName ?? `Çizim v${d.version}`}</div>
                <div className="small muted">
                  <span className={`badge ${i === 0 ? 'badge-info' : 'badge-muted'}`}>v{d.version}{i === 0 ? ' · güncel' : ''}</span>{' '}
                  {d.status === 'ONAYLANDI' ? <span className="badge badge-ok">onaylandı</span> : d.status === 'REVIZYON_ISTENDI' ? <span className="badge badge-danger">revizyon istendi</span> : d.status === 'ONAY_BEKLIYOR' ? <span className="badge badge-warn">onay bekliyor</span> : null}
                  {' '}{d.fileSize ? fmtBytes(d.fileSize) : ''} · {fmtDateTime(d.createdAt)}{!isCustomer ? ` · ${d.uploadedBy.name || d.uploadedBy.email}` : ''}
                </div>
              </div>
              <FileButtons href={`/dosya/cizim/${d.id}`} name={d.fileName ?? ''} />
            </div>
            {d.revisions.map((r) => (
              <div key={r.id} className="note" style={{ marginLeft: 50 }}>
                <b className="small">Revizyon talebi:</b> {r.comment}
                <div className="meta">{fmtDateTime(r.createdAt)}</div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

const VIEWABLE = ['pdf', 'png', 'jpg', 'jpeg'];
function FileButtons({ href, name }: { href: string; name: string }) {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      {VIEWABLE.includes(ext) && <a className="btn" href={`${href}?ac=1`} target="_blank" rel="noopener">Aç</a>}
      <a className="btn" href={href}>İndir</a>
    </span>
  );
}

function Files({ order, user, canAdd }: { order: OrderDetail; user: CurrentUser; canAdd: boolean }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const files = order.files.filter((f) => !isCustomer || f.kind === 'CUSTOMER');
  return (
    <div className="card">
      <h2>{isCustomer ? 'Sipariş dosyalarınız' : 'Müşteri sipariş dosyaları'}</h2>
      {files.length === 0 && <p className="muted">Dosya yok.</p>}
      {files.map((f) => (
        <div key={f.id} className="file-row">
          <div className="file-ext">{f.name.split('.').pop()?.slice(0, 4)}</div>
          <div className="grow">
            <div className="fname">{f.name}</div>
            <div className="small muted">
              {fmtBytes(f.size)} · {fmtDateTime(f.createdAt)}
              {!isCustomer && <> · {f.kind === 'CUSTOMER' ? 'müşteri' : <span className="badge badge-muted">iç dosya</span>}</>}
            </div>
          </div>
          <FileButtons href={`/dosya/siparis/${f.id}`} name={f.name} />
        </div>
      ))}
      {canAdd && (
        <form action={addFilesAction} className="row" style={{ marginTop: 10 }}>
          <input type="hidden" name="id" value={order.id} />
          <input name="files" type="file" multiple required accept=".pdf,.dwg,.dxf,.step,.stp,.igs,.iges,.xls,.xlsx,.doc,.docx,.zip,.jpg,.jpeg,.png" style={{ flex: 1 }} aria-label="Dosya ekle" />
          <button className="btn">Dosya ekle</button>
        </form>
      )}
      {canAdd && !isCustomer && <p className="hint">İç ekibin eklediği dosyaları müşteri görmez.</p>}
    </div>
  );
}

function Notes({ order, user }: { order: OrderDetail; user: CurrentUser }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const notes = order.notes.filter((n) => !isCustomer || !n.internal);
  return (
    <div className="card" id="notlar">
      <h2>Notlar</h2>
      <p className="muted small">Müşteri ve ekipler bu akışı birlikte görür.{!isCustomer && ' “İç not” işaretlerseniz müşteriye gitmez.'}</p>
      {notes.length === 0 && <p className="muted">Henüz not yok.</p>}
      {notes.map((n) => (
        <div key={n.id} className={`note ${n.internal ? 'internal' : ''}`}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
          <div className="meta">
            {n.user.name || n.user.email}{!isCustomer || n.user.appRole === 'MUSTERI' ? ` (${ROLE_LABEL[n.user.appRole]})` : ''} · {fmtDateTime(n.createdAt)}
            {n.internal && <> · <b>iç not</b></>}
          </div>
        </div>
      ))}
      <form action={addNoteAction} style={{ marginTop: 10 }}>
        <input type="hidden" name="id" value={order.id} />
        <textarea name="text" rows={2} required placeholder="Not yazın..." aria-label="Not" />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          {!isCustomer ? <label className="check small"><input type="checkbox" name="internal" /> İç not — müşteri görmez</label> : <span />}
          <span className="row"><span className="muted small">Gönderilen not düzeltilemez</span><button className="btn btn-primary">Gönder</button></span>
        </div>
      </form>
    </div>
  );
}
