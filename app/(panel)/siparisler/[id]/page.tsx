import Link from 'next/link';
import { db } from '@/lib/db';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { customerLabel, loadOrder, type OrderDetail } from '@/lib/orders';
import { fmtBytes, fmtDate, fmtDateTime, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/roles';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { OfferEditor } from './OfferEditor';
import {
  STAGES, STATUS, availableActions, offerLineTotals, slaInfo, stageIndex, whoseTurn,
} from '@/server/orders/rules.js';
import {
  acceptOfferAction, addFilesAction, addNoteAction, approveDrawingAction, archiveAction, cancelAction, holdAction,
  markProductionAction, markShippedAction, requestRevisionAction, sendToDrawingAction, setShipDateAction,
  startDrawingAction, startOfferAction, uploadDrawingAction,
} from './actions';

const OK: Record<string, string> = {
  created: 'Siparişiniz alındı. Satış ekibi inceleyip size dönecek.',
  to_drawing: 'Sipariş çizim ekibine gönderildi.',
  to_offer: 'Teklif tablosu açıldı. Satırları doldurup yöneticiye gönderin.',
  held: 'Sipariş beklemeye alındı.',
  unheld: 'Sipariş beklemeden çıkarıldı.',
  ship_date: 'Tahmini yükleme tarihi güncellendi.',
  production: 'Sipariş üretime alındı.',
  shipped: 'Sipariş yüklendi olarak işaretlendi.',
  archived: 'Sipariş arşivlendi.',
  cancelled: 'Sipariş iptal edildi.',
  drawing_started: 'Çizim işini üstlendiniz.',
  drawing_uploaded: 'Çizim yüklendi ve müşterinin onayına gönderildi.',
  drawing_approved: 'Çizimi onayladınız. Teklifiniz hazırlanıyor.',
  revision_requested: 'Revizyon talebiniz çizim ekibine iletildi.',
  offer_accepted: 'Teklifi onayladınız. Siparişiniz üretime alındı.',
  files_added: 'Dosyalar eklendi.',
  note_added: 'Not eklendi.',
  offer_saved: 'Teklif taslak olarak kaydedildi.',
  offer_submit: 'Teklif sistem yöneticisinin onayına gönderildi.',
  offer_approve: 'Fiyat onaylandı; teklif müşterinin panelinde.',
  offer_return: 'Teklif satışa geri gönderildi.',
};

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
  const acts = availableActions({ role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove });
  const can = (a: string) => acts.includes(a);
  const offer = order.offers[0];
  const sla = isCustomer || order.onHold ? null : slaInfo(order.slaDeadline);
  const stage = stageIndex(order.status);
  const editable = !!offer && (can('edit_offer') || can('approve_price'));
  const catalog = can('edit_offer') || can('approve_price')
    ? (await db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true } })).map((g) => g.name)
    : [];

  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p className="small"><Link href="/siparisler">← {isCustomer ? 'Siparişlerim' : 'Siparişler'}</Link></p>
          <h1>{order.title || order.orderNo}</h1>
          <div className="row">
            <span className="mono muted">{order.orderNo}</span>
            <StatusBadge status={order.status} customer={isCustomer} onHold={!isCustomer && order.onHold} />
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
            const skipped = i === 2 && !order.needsDrawing && stage > 2;
            const cls = i < stage ? 'done' : i === stage ? 'current' : '';
            return (
              <div key={label} className={`step ${cls} ${skipped ? 'skipped' : ''}`}>
                <div className="dot">{i < stage ? '✓' : String(i + 1).padStart(2, '0')}</div>
                <div className="lbl">{label}{skipped ? ' (gerekmedi)' : ''}</div>
              </div>
            );
          })}
        </div>
      </div>

      <ActionPanel order={order} user={user} can={can} />

      {editable && offer && (
            <OfferEditor
              orderId={order.id}
              mode={can('approve_price') ? 'admin' : 'sales'}
              currency={offer.currency}
              catalog={catalog}
              statusLabel={offer.status === 'YONETIMDE' ? 'yönetimde' : offer.status === 'GONDERILDI' ? 'müşteride' : 'satışta hazırlanıyor'}
              camEtiket={order.camEtiket ?? order.customer.camEtiket ?? ''}
              sandikEtiket={order.sandikEtiket ?? order.customer.sandikEtiket ?? ''}
              initial={offer.lines.map((l) => ({
                description: l.description, poz: l.poz ?? '', enMm: l.enMm?.toString() ?? '', boyMm: l.boyMm?.toString() ?? '',
                adet: String(l.adet), unit: l.unit, unitPrice: Number(l.unitPrice) ? Number(l.unitPrice).toFixed(2) : '',
              }))}
            />
      )}

      <div className="detail-grid">
        <div>
          {!editable && offer && (!isCustomer || offer.status === 'GONDERILDI') && <OfferView order={order} isCustomer={isCustomer} />}

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
              <tr><td>Çizim</td><td>{order.status === 'YENI' && !isCustomer ? 'Karar bekliyor' : order.needsDrawing ? 'Gerekli' : 'Gerekmiyor'}</td></tr>
              {order.needsDrawing && <tr><td>Revizyon</td><td>{order.revisionCount} tur</td></tr>}
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
              {order.statusHistory.map((h) => (
                <li key={h.id}>
                  <div><b>{isCustomer ? STATUS[h.toStatus as keyof typeof STATUS]?.customer : STATUS[h.toStatus as keyof typeof STATUS]?.label}</b>{h.note ? ` — ${h.note}` : ''}</div>
                  <div className="when">{fmtDateTime(h.changedAt)}{!isCustomer && h.changedBy ? ` · ${h.changedBy.name || h.changedBy.email}` : ''}</div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}

function ActionPanel({ order, user, can }: { order: OrderDetail; user: CurrentUser; can: (a: string) => boolean }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const hidden = <input type="hidden" name="id" value={order.id} />;
  const main: React.ReactNode[] = [];

  if (can('send_to_drawing')) main.push(<form key="d" action={sendToDrawingAction}>{hidden}<button className="btn btn-primary">Çizim Ekibine Gönder</button></form>);
  if (can('start_offer')) main.push(<form key="o" action={startOfferAction}>{hidden}<button className="btn btn-primary">Teklife Gönder (çizim gerekmiyor)</button></form>);
  if (can('start_drawing')) main.push(<form key="sd" action={startDrawingAction}>{hidden}<button className="btn btn-primary">Çizimi üstlen</button></form>);
  if (can('approve_drawing')) main.push(<form key="ad" action={approveDrawingAction}>{hidden}<button className="btn btn-primary">Çizimi onayla</button></form>);
  if (can('accept_offer')) main.push(<form key="ao" action={acceptOfferAction}>{hidden}<ConfirmButtonPrimary message="Teklifi onaylıyor musunuz? Siparişiniz üretime alınacak.">Teklifi onayla ve üretime al</ConfirmButtonPrimary></form>);
  if (can('mark_production')) main.push(<form key="mp" action={markProductionAction}>{hidden}<ConfirmButtonPrimary message="Müşteri teklifi onayladı mı? Sipariş üretime alınacak.">Müşteri onayladı — üretime al</ConfirmButtonPrimary></form>);
  if (can('mark_shipped')) main.push(<form key="ms" action={markShippedAction}>{hidden}<button className="btn btn-primary">Yüklendi olarak işaretle</button></form>);
  if (can('archive')) main.push(<form key="ar" action={archiveAction}>{hidden}<button className="btn">Arşivle</button></form>);
  if (can('hold')) main.push(<form key="h" action={holdAction}>{hidden}<input type="hidden" name="hold" value="1" /><button className="btn">Beklemeye Al</button></form>);
  if (can('unhold')) main.push(<form key="uh" action={holdAction}>{hidden}<input type="hidden" name="hold" value="0" /><button className="btn btn-primary">Beklemeden çıkar</button></form>);

  const turn = whoseTurn(order.status, order.onHold);
  const noActions = main.length === 0 && !can('upload_drawing') && !can('request_revision') && !can('set_ship_date') && !can('edit_offer') && !can('approve_price');

  return (
    <div className="card turn">
      <h2 style={{ marginBottom: 4 }}>{isCustomer ? STATUS[order.status as keyof typeof STATUS]?.next : `Sıra: ${turn}`}</h2>
      {!isCustomer && <p className="muted small">Rolünüz: {ROLE_LABEL[user.appRole]}</p>}
      {isCustomer && order.status === 'ONAY_BEKLIYOR' && !user.canApprove && (
        <div className="alert alert-warn" style={{ marginTop: 8 }}>Çizim onayınızı bekliyor. Hesabınızın onay yetkisi yok; firmanızdaki onay yetkili kullanıcı onaylayabilir. Siz revizyon isteyebilirsiniz.</div>
      )}
      {isCustomer && order.status === 'FIYATLANDI' && !user.canApprove && (
        <div className="alert alert-warn" style={{ marginTop: 8 }}>Teklifiniz hazır. Onaylamak için firmanızdaki onay yetkili kullanıcıya haber verin.</div>
      )}
      {main.length > 0 && <div className="row" style={{ marginTop: 10 }}>{main}</div>}

      {can('upload_drawing') && (
        <form action={uploadDrawingAction} style={{ marginTop: 14 }}>
          {hidden}
          <label htmlFor="drawing-file">{order.status === 'REVIZYON_ISTENDI' ? 'Revize çizimi yükle' : 'Çizimi yükle'} (v{order.drawings.length + 1}) — yüklenince müşterinin onayına gider</label>
          <div className="row">
            <input id="drawing-file" name="file" type="file" required accept=".pdf,.dwg,.dxf,.jpg,.jpeg,.png,.zip" style={{ flex: 1 }} />
            <button className="btn btn-primary">Yükle ve onaya gönder</button>
          </div>
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

      {noActions && <p className="muted small" style={{ marginTop: 6 }}>{isCustomer ? 'Şu an sizden beklenen bir işlem yok.' : 'Bu durumda sizin rolünüz için bir işlem yok.'}</p>}
    </div>
  );
}

function ConfirmButtonPrimary({ message, children }: { message: string; children: React.ReactNode }) {
  return <ConfirmButton message={message} primary>{children}</ConfirmButton>;
}

function OfferView({ order, isCustomer }: { order: OrderDetail; isCustomer: boolean }) {
  const offer = order.offers[0];
  const total = order.price?.amount ?? offer.amount;
  return (
    <div className="card" id="teklif">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{isCustomer ? 'Teklifiniz' : 'Teklif'}</h2>
        {!isCustomer && <span className="badge">{offer.status === 'YONETIMDE' ? 'yönetimde' : offer.status === 'GONDERILDI' ? 'müşteride' : 'satışta'}</span>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Açıklama</th><th>Poz</th><th className="num">En</th><th className="num">Boy</th><th className="num">Adet</th><th className="num">Metraj</th><th className="num">Birim fiyat</th><th className="num">Tutar</th></tr></thead>
          <tbody>
            {offer.lines.map((l, i) => {
              const t = offerLineTotals({ ...l, unitPrice: l.unitPrice.toString() });
              return (
                <tr key={l.id}>
                  <td className="muted">{i + 1}</td><td>{l.description}</td><td>{l.poz ?? ''}</td>
                  <td className="num">{l.enMm ?? ''}</td><td className="num">{l.boyMm ?? ''}</td><td className="num">{l.adet}</td>
                  <td className="num">{l.unit === 'm2' ? `${fmtNum(t.metraj)} m²` : '—'}</td>
                  <td className="num">{fmtNum(l.unitPrice.toString())} / {l.unit === 'm2' ? 'm²' : 'adet'}</td>
                  <td className="num">{fmtNum(t.amount)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr><td colSpan={8}>Toplam</td><td className="num"><b>{fmtMoney(total.toString(), offer.currency)}</b></td></tr></tfoot>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>Fiyatlar KDV hariçtir.</p>
    </div>
  );
}

function Drawings({ order, user }: { order: OrderDetail; user: CurrentUser }) {
  if (!order.needsDrawing && order.drawings.length === 0) return null;
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
              <a className="btn" href={`/dosya/cizim/${d.id}`}>İndir</a>
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

function Files({ order, user, canAdd }: { order: OrderDetail; user: CurrentUser; canAdd: boolean }) {
  const isCustomer = user.appRole === 'MUSTERI';
  const files = order.files.filter((f) => !isCustomer || f.kind === 'CUSTOMER');
  return (
    <div className="card">
      <h2>{isCustomer ? 'Sipariş dosyalarınız' : 'Sipariş dosyaları'}</h2>
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
          <a className="btn" href={`/dosya/siparis/${f.id}`}>İndir</a>
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
