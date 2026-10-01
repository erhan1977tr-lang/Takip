import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { loadOrder } from '@/lib/orders';
import { fmtDateTime } from '@/lib/format';
import { DrawingViewer, type Annotation, type ViewerText } from '@/components/DrawingViewer';
import { availableActions, drawingFlags } from '@/server/orders/rules.js';
import { cleanAnnotations } from '@/server/orders/annotations.js';
import { RevisionForm } from './RevisionForm';

export const dynamic = 'force-dynamic';

// Çizim sürümünü inceleme ekranı (PDF / görsel görüntüleyici):
//   - çizimci: müşteriye göndermeden önce "Kontrol Et" (taslak sürüm; müşteri taslağı hiç göremez)
//   - müşteri: "Aç ve incele"; ?revizyon=1 → çizim üzerine işaret koyup zorunlu notla revizyon ister
//   - çizimci / iç ekip / müşteri: revizyon talebini çizim üzerindeki işaretleriyle görür (?rev=<talep>)
// Sipariş loadOrder ile yüklenir: firma kapsamı ve role göre temizlik sunucuda (başka firmanın siparişi → 404,
// müşteriye taslak sürüm gelmez). Dosyalar /dosya/cizim/<id> adresinden, aynı denetimle gelir.
export default async function DrawingPage({ params, searchParams }: { params: Promise<{ id: string; drawingId: string }>; searchParams: Promise<{ revizyon?: string; rev?: string }> }) {
  const user = await requirePermission('ORDER_VIEW');
  const { id, drawingId } = await params;
  const sp = await searchParams;
  const { t } = await getT();
  const order = await loadOrder(id, user);
  const d = order.drawings.find((x) => x.id === drawingId);
  if (!d) notFound();
  const latest = order.drawings[order.drawings.length - 1];
  const acts = availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: order.offers[0]?.status ?? null, ...drawingFlags(order),
  });
  const revising = sp.revizyon === '1' && acts.includes('request_revision') && latest?.id === d.id && d.status === 'ONAY_BEKLIYOR';
  const files = d.files.filter((f) => f.scanStatus !== 'INFECTED').map((f) => ({ id: f.id, name: f.name }));
  const revision = d.revisions.find((r) => r.id === sp.rev) ?? d.revisions[d.revisions.length - 1];
  const annotations = revision ? (cleanAnnotations(revision.annotations, files.map((f) => f.id)) as Annotation[]) : [];
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
      {files.length === 0 && <div className="card"><p className="muted">{t('order.upload.draftEmpty')}</p></div>}
      {files.length > 0 && revising && (
        <RevisionForm
          orderId={order.id} drawingId={d.id} files={files} viewer={viewer}
          m={{ label: t('order.customer.revisionLabel'), placeholder: t('order.customer.revisionPlaceholder'), submit: t('order.steps.request_revision'),
            required: t('order.viewer.noteRequired'), cancel: t('common.cancel'), backHref: back }}
        />
      )}
      {files.length > 0 && !revising && (
        <>
          <DrawingViewer files={files} annotations={annotations} text={viewer} />
          {d.revisions.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2>{t('order.viewer.requests')}</h2>
              {d.revisions.map((r) => (
                <div key={r.id} className="note">
                  <b className="small">{t('order.drawings.revisionRequest')}</b> {r.comment}
                  <div className="meta">
                    {fmtDateTime(r.createdAt)}
                    {r.id !== revision?.id && Array.isArray(r.annotations) && r.annotations.length > 0 && <> · <Link href={`/siparisler/${order.id}/cizim/${d.id}?rev=${r.id}`}>{t('order.viewer.showMarks')}</Link></>}
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
