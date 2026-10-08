'use client';

import { useState } from 'react';
import { DrawingViewer, type ViewerFile, type ViewerText } from '@/components/DrawingViewer';
import { requestRevisionAction } from '../../actions';

/** Sunucuyla aynı sınırlar (server/orders/revision-note.js); asıl denetim sunucudadır */
const MAX_ITEMS = 20;
const MAX_ITEM = 500;

/**
 * Müşteri "Revizyon iste" (karar 162): değişiklikleri "Nota de revizie" altında NUMARALI maddeler hâlinde yazar — her
 * madde ayrı bir alan, "+ Madde ekle" ile yenisi açılır. En az bir dolu madde zorunludur (sunucu da reddeder).
 * Çizim üzerine işaretleme ve "İşaretler" (Marcaje) bölümü müşteri ekranında yoktur: çizim yalnızca incelenir.
 * Gönderim mevcut request_revision işlemidir; maddeler sunucuda tek numaralı metne çevrilir ve bir kez çevrilip saklanır.
 */
export function RevisionForm({ orderId, drawingId, files, viewer, m }: {
  orderId: string; drawingId: string; files: ViewerFile[]; viewer: ViewerText;
  m: {
    title: string; label: string; intro: string; placeholder: string; item: string; add: string; remove: string; submit: string;
    required: string; cancel: string; backHref: string;
  };
}) {
  const [items, setItems] = useState<string[]>(['']);
  const empty = !items.some((x) => x.trim());
  const set = (i: number, v: string) => setItems(items.map((x, j) => (j === i ? v : x)));
  return (
    <form action={requestRevisionAction}>
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="drawingId" value={drawingId} />
      <DrawingViewer
        files={files} annotations={[]} text={viewer}
        side={(
          <div className="card turn viewer-decide">
            <h2>{m.title}</h2>
            <label id="rev-label">{m.label} *</label>
            <p className="hint" id="rev-intro">{m.intro}</p>
            <ol className="revision-items" aria-labelledby="rev-label" aria-describedby="rev-intro rev-required">
              {items.map((v, i) => (
                <li key={i} className="revision-item">
                  <span className="badge badge-info" aria-hidden="true">{i + 1}</span>
                  <textarea
                    name="item" rows={2} maxLength={MAX_ITEM} value={v} placeholder={i === 0 ? m.placeholder : ''}
                    aria-label={m.item.replace('{n}', String(i + 1))} autoFocus={i > 0 && i === items.length - 1}
                    onChange={(e) => set(i, e.target.value)}
                  />
                  {items.length > 1 && (
                    <button type="button" className="btn btn-link danger" aria-label={m.remove.replace('{n}', String(i + 1))}
                      onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
                  )}
                </li>
              ))}
            </ol>
            {items.length < MAX_ITEMS && (
              <button type="button" className="btn btn-link" onClick={() => setItems([...items, ''])}>{m.add}</button>
            )}
            <p id="rev-required" className="hint">{empty ? m.required : ' '}</p>
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
