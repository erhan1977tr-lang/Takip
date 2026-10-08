import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { loadOrder } from '@/lib/orders';
import { fmtDateTime } from '@/lib/format';
import { RevisionNote } from '@/components/RevisionNote';
import { DrawingViewer, type Annotation, type ViewerText } from '@/components/DrawingViewer';
import { ConfirmButton } from '@/components/ConfirmButton';
import { authSecret } from '@/lib/env';
import { userCan } from '@/lib/permissions';
import { availableActions, drawingFlags, isViewable } from '@/server/orders/rules.js';
import { cleanAnnotations } from '@/server/orders/annotations.js';
import { reviewToken } from '@/server/orders/review.js';
import { drawingAccess } from '@/server/orders/drawing-access.js';
import { isCustomerDrawingRecord } from '@/server/orders/dwg-review.js';
import { approveDrawingAction, sendDrawingAction } from '../../actions';
import { RevisionForm } from './RevisionForm';

export const dynamic = 'force-dynamic';

// Çizim sürümünü inceleme ekranı (PDF / görsel görüntüleyici) — karar 84:
//   - çizimci: "Kontrol Et" (taslak sürüm; müşteri taslağı hiç göremez). "Müşteriye gönder" YALNIZCA bu ekrandadır:
//     sayfa, bu taslak + bu kullanıcı + bu dosyalar için imzalı bir kontrol kanıtı üretir (server/orders/review.js);
//     send_drawing kanıt olmadan çalışmaz (düğmeyi gizlemek değil, sunucu denetimi).
//   - müşteri: "Aç ve incele" → "Bu çizimi onayla" ya da "Revizyon iste" (?revizyon=1: numaralı maddelerle zorunlu not —
//     karar 162; çizim üzerine işaretleme ve "İşaretler" bölümü müşteri ekranında yok). İkisi de onay yetkisi ister
//     (availableActions); yetkisiz kullanıcı yalnızca inceler.
//   - iç ekip: revizyon talebini (numaralı not + saklanan Türkçe çevirisi, karar 163) ve eski taleplerin çizim üzerindeki
//     işaretlerini görür (?rev=<talep>); müşteri kendi talebini yalnızca özgün dilinde görür
// Sipariş loadOrder ile yüklenir: firma kapsamı ve role göre temizlik sunucuda (başka firmanın siparişi → 404,
// müşteriye taslak sürüm gelmez; geri çekilen sürümün içeriği gelmez). Dosyalar /dosya/cizim/<id> adresinden, aynı kuralla gelir.
export default async function DrawingPage({ params, searchParams }: { params: Promise<{ id: string; drawingId: string }>; searchParams: Promise<{ revizyon?: string; rev?: string }> }) {
  const user = await requirePermission('ORDER_VIEW');
  const { id, drawingId } = await params;
  const sp = await searchParams;
  const { t } = await getT();
  const order = await loadOrder(id, user);
  const d = order.drawings.find((x) => x.id === drawingId);
  // Sürümün içeriğini görebilen açar (tek kural: server/orders/drawing-access.js, karar 146): müşteriye taslak sürüm hiç
  // gelmez; geri çekilen sürümün satırı gelir ama içeriği kapalıdır → bu ekran da "bulunamadı" der. Müşterinin DWG/DXF
  // çiziminin karar kaydı (karar 167) bir çizim sürümü değildir: görüntülenecek dosyası yoktur (dosyalar sipariş dosyalarıdır).
  if (!d || isCustomerDrawingRecord(d) || drawingAccess(user.appRole, d.status) !== 'FULL') notFound();
  const latest = order.drawings[order.drawings.length - 1];
  const acts = availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: order.offers[0]?.status ?? null, ...drawingFlags(order), orderType: order.orderTypeCode,
  });
  const isLatest = latest?.id === d.id;
  const pending = isLatest && d.status === 'ONAY_BEKLIYOR' && order.status === 'HAZIRLANIYOR';
  const revising = sp.revizyon === '1' && acts.includes('request_revision') && pending;
  const deciding = !revising && pending && acts.includes('approve_drawing');
  // Müşteri kullanıcısının onay yetkisi yok: inceler, karar veremez (onay da revizyon da sunucuda reddedilir)
  const noRight = pending && userCan(user, 'DRAWING_APPROVE') && !user.canApprove;
  // Taslak: gönderim koşulları (asıl denetim send_drawing'de) ve kontrol kanıtı
  const sending = isLatest && d.status === 'TASLAK' && acts.includes('send_drawing');
  const clean = d.files.length > 0 && d.files.every((f) => f.scanStatus === 'CLEAN');
  const viewable = d.files.some((f) => isViewable(f.name));
  const review = sending && clean && viewable ? reviewToken({ secret: authSecret(), drawingId: d.id, userId: user.id, files: d.files }) : null;
  const files = d.files.filter((f) => f.scanStatus !== 'INFECTED').map((f) => ({ id: f.id, name: f.name }));
  const revision = d.revisions.find((r) => r.id === sp.rev) ?? d.revisions[d.revisions.length - 1];
  // Eski taleplerin çizim üstü işaretleri yalnızca iç ekibe gösterilir; müşteri ekranında işaret yok (karar 162)
  const internal = userCan(user, 'FILE_INTERNAL_VIEW');
  const annotations = internal && revision ? (cleanAnnotations(revision.annotations, files.map((f) => f.id)) as Annotation[]) : [];
  const back = `/siparisler/${order.id}#cizim`;
  const viewer: ViewerText = {
    tools: { pin: t('order.viewer.pin'), rect: t('order.viewer.rect'), free: t('order.viewer.free'), text: t('order.viewer.text') },
    hint: t('order.viewer.hint'), fit: t('order.viewer.fit'), zoomIn: t('order.viewer.zoomIn'), zoomOut: t('order.viewer.zoomOut'),
    loading: t('order.viewer.loading'), failed: t('order.viewer.failed'), noPreview: t('order.viewer.noPreview'), download: t('common.download'),
    notes: t('order.viewer.notes'), noNotes: revising ? t('order.viewer.noNotesEdit') : t('order.viewer.noNotes'), notePlaceholder: t('order.viewer.notePlaceholder'),
    remove: t('order.viewer.remove'), page: t('order.viewer.page'),
  };
  const status = ({
    TASLAK: ['badge-muted', t('order.drawings.draft')], ONAY_BEKLIYOR: ['badge-warn', t('order.drawings.pending')],
    ONAYLANDI: ['badge-ok', t('order.drawings.approved')], REVIZYON_ISTENDI: ['badge-danger', t('order.drawings.revisionRequested')],
    GERI_CEKILDI: ['badge-muted', t('order.drawings.withdrawn')],
  } as Record<string, string[]>)[d.status];
  return (
    <>
      <div className="page-head">
        <p className="small"><Link href={back}>← {order.orderNo}</Link></p>
        <h1>{revising ? t('order.viewer.titleRevision') : t('order.viewer.title')}</h1>
        <div className="row">
          <span className="badge badge-info">v{d.version}</span>
          {status && <span className={`badge ${status[0]}`}>{status[1]}</span>}
          <span className="mono muted">{order.orderNo}</span>
          {d.status === 'TASLAK' && <span className="muted small">{t('order.viewer.draftInfo')}</span>}
        </div>
      </div>
      {files.length === 0 && <div className="card"><p className="empty">{t('order.upload.draftEmpty')}</p></div>}
      {files.length > 0 && revising && (
        <RevisionForm
          orderId={order.id} drawingId={d.id} files={files} viewer={viewer}
          m={{
            title: t('order.viewer.revisionTitle'), label: t('order.viewer.revisionNote'), intro: t('order.viewer.revisionIntro'),
            placeholder: t('order.customer.revisionPlaceholder'), item: t('order.viewer.revisionItem'), add: t('order.viewer.addItem'),
            remove: t('order.viewer.removeItem'), submit: t('order.steps.request_revision'), required: t('order.viewer.noteRequired'),
            cancel: t('common.cancel'), backHref: `/siparisler/${order.id}/cizim/${d.id}`,
          }}
        />
      )}
      {files.length > 0 && !revising && (
        <>
          {noRight && <div className="alert alert-warn">{t('order.customer.noApproveRight')}</div>}
          <DrawingViewer
            files={files} annotations={annotations} text={viewer}
            side={sending ? (
              <div className="card turn viewer-decide" id="gonder">
                <h2>{t('order.viewer.sendTitle')}</h2>
                <p className="hint">{t('order.viewer.sendHint')}</p>
                {review ? (
                  <form action={sendDrawingAction} className="viewer-actions">
                    <input type="hidden" name="id" value={order.id} />
                    <input type="hidden" name="drawingId" value={d.id} />
                    <input type="hidden" name="review" value={review} />
                    <ConfirmButton primary message={t('order.upload.sendConfirm', { v: d.version, n: d.files.length })}>{t('order.upload.send')}</ConfirmButton>
                    <Link className="btn" href={back}>{t('common.cancel')}</Link>
                  </form>
                ) : (
                  <>
                    <div className="alert alert-warn">{!clean ? t('order.upload.sendBlocked') : t('order.upload.sendNeedsViewable')}</div>
                    <div className="viewer-actions">
                      <button type="button" className="btn btn-primary" disabled>{t('order.upload.send')}</button>
                      <Link className="btn" href={back}>{t('common.cancel')}</Link>
                    </div>
                  </>
                )}
              </div>
            ) : deciding ? (
              <div className="card turn viewer-decide" id="karar">
                <h2>{t('order.viewer.decideTitle')}</h2>
                <p className="hint">{t('order.viewer.decideHint')}</p>
                <div className="viewer-actions">
                  <form action={approveDrawingAction}>
                    <input type="hidden" name="id" value={order.id} />
                    <input type="hidden" name="drawingId" value={d.id} />
                    <ConfirmButton success message={t('order.customer.approveConfirm', { v: d.version })}>{t('order.steps.approve_drawing')}</ConfirmButton>
                  </form>
                  <Link className="btn btn-danger" href={`/siparisler/${order.id}/cizim/${d.id}?revizyon=1`}>{t('order.steps.request_revision')}</Link>
                </div>
              </div>
            ) : undefined}
          />
          {d.revisions.length > 0 && (
            <div className="card viewer-requests">
              <h2>{t('order.viewer.requests')}</h2>
              {d.revisions.map((r) => (
                <div key={r.id} className="note" data-revision={r.id}>
                  <b className="small">{t('order.drawings.revisionRequest')}</b>
                  <RevisionNote r={r} role={user.appRole} t={t} />
                  <div className="meta">
                    {fmtDateTime(r.createdAt)}
                    {internal && r.id !== revision?.id && Array.isArray(r.annotations) && r.annotations.length > 0 && <> · <Link href={`/siparisler/${order.id}/cizim/${d.id}?rev=${r.id}`}>{t('order.viewer.showMarks')}</Link></>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
