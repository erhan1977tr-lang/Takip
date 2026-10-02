'use client';

import { useState } from 'react';
import { DrawingViewer, type Annotation, type ViewerFile, type ViewerText } from '@/components/DrawingViewer';
import { requestRevisionAction } from '../../actions';

/**
 * Müşteri "Revizyon iste": çizim üzerine işaret koyar (isteğe bağlı: İğne, Dikdörtgen, Serbest, Metin) ve revizyon
 * notunu yazar (ZORUNLU; sunucu da notsuz talebi reddeder). Gönderim mevcut request_revision işlemidir; işaretler
 * talebe eklenir. Not ve gönder düğmesi çizimin yanında (sağ sütun), işaret listesinin üstündedir.
 */
export function RevisionForm({ orderId, drawingId, files, viewer, m }: {
  orderId: string; drawingId: string; files: ViewerFile[]; viewer: ViewerText;
  m: { title: string; label: string; placeholder: string; submit: string; required: string; cancel: string; backHref: string };
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [comment, setComment] = useState('');
  const empty = !comment.trim();
  return (
    <form action={requestRevisionAction}>
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="drawingId" value={drawingId} />
      <input type="hidden" name="annotations" value={JSON.stringify(annotations)} />
      <DrawingViewer
        files={files} annotations={annotations} editable onChange={setAnnotations} text={viewer}
        side={(
          <div className="card turn viewer-decide">
            <h2>{m.title}</h2>
            <label htmlFor="rev-comment">{m.label} *</label>
            <textarea id="rev-comment" name="comment" rows={5} required maxLength={2000} placeholder={m.placeholder} value={comment} onChange={(e) => setComment(e.target.value)} aria-describedby="rev-required" />
            <p id="rev-required" className="hint">{empty ? m.required : ' '}</p>
            <div className="viewer-actions">
              <button className="btn btn-danger" disabled={empty}>{m.submit}</button>
              <a className="btn" href={m.backHref}>{m.cancel}</a>
            </div>
          </div>
        )}
      />
    </form>
  );
}
