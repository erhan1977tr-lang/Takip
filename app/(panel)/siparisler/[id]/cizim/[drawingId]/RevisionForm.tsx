'use client';

import { useState } from 'react';
import { DrawingViewer, type Annotation, type ViewerFile, type ViewerText } from '@/components/DrawingViewer';
import { requestRevisionAction } from '../../actions';

/**
 * Müşteri "Revizyon iste": çizim üzerine işaret koyar (isteğe bağlı) ve revizyon notunu yazar (ZORUNLU; sunucu da
 * notsuz talebi reddeder). Gönderim mevcut request_revision işlemidir; işaretler talebe eklenir.
 */
export function RevisionForm({ orderId, drawingId, files, viewer, m }: {
  orderId: string; drawingId: string; files: ViewerFile[]; viewer: ViewerText;
  m: { label: string; placeholder: string; submit: string; required: string; cancel: string; backHref: string };
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [comment, setComment] = useState('');
  return (
    <form action={requestRevisionAction}>
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="drawingId" value={drawingId} />
      <input type="hidden" name="annotations" value={JSON.stringify(annotations)} />
      <DrawingViewer files={files} annotations={annotations} editable onChange={setAnnotations} text={viewer} />
      <div className="card turn" style={{ marginTop: 16 }}>
        <label htmlFor="rev-comment">{m.label} *</label>
        <textarea id="rev-comment" name="comment" rows={3} required maxLength={2000} placeholder={m.placeholder} value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span className="muted small">{comment.trim() ? '' : m.required}</span>
          <span className="row" style={{ gap: 8 }}>
            <a className="btn" href={m.backHref}>{m.cancel}</a>
            <button className="btn btn-danger" disabled={!comment.trim()}>{m.submit}</button>
          </span>
        </div>
      </div>
    </form>
  );
}
