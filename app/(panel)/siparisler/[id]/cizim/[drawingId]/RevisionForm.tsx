'use client';

import { useEffect, useRef, useState } from 'react';
import { DrawingViewer, type Annotation, type ViewerFile, type ViewerText } from '@/components/DrawingViewer';
import { requestRevisionAction } from '../../actions';

/** Sunucuyla aynı sınırlar (server/orders/revision-note.js); asıl denetim sunucudadır */
const MAX_ITEMS = 20;
const MAX_ITEM = 500;

/**
 * Müşteri "Revizyon iste" (karar 162, Paket B — karar 227):
 *   - Çizim üzerine işaret: İğne, Dikdörtgen, Serbest, Metin (DrawingViewer düzenleme kipi). Konumlar sayfaya oranlıdır
 *     (0–1): yakınlaştırma ve pencere boyutu değişince işaret aynı yerde kalır. Her işarete sağda kısa açıklama yazılabilir.
 *   - "Nota de revizie": NUMARALI maddeler (her madde ayrı alan, "+ Madde ekle"). Açıklamalı işaretler sunucuda nota
 *     "#<işaret no>: …" maddesi olarak eklenir (aynı numarayla bağlı; notla birlikte bir kez çevrilir). En az bir dolu madde
 *     ya da açıklamalı bir işaret zorunludur (sunucu da denetler).
 *   - Gönderim mevcut request_revision işlemidir; işaretler sunucuda bu sürümün dosyalarına göre doğrulanıp talebe bağlanır.
 *   - Taslak (maddeler + işaretler) yalnızca bu tarayıcıda, bu sürüm için oturum belleğinde tutulur: sayfa yenilense de
 *     kaybolmaz; gönderilince silinir. Bellek kullanılamazsa form yine çalışır.
 */
export function RevisionForm({ orderId, drawingId, files, viewer, m }: {
  orderId: string; drawingId: string; files: ViewerFile[]; viewer: ViewerText;
  m: {
    title: string; label: string; intro: string; placeholder: string; item: string; add: string; remove: string; submit: string;
    required: string; cancel: string; backHref: string;
  };
}) {
  const key = `takip:revizyon:${drawingId}`;
  const [items, setItems] = useState<string[]>(['']);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const restored = useRef(false);
  // Taslağı geri yükle (yalnızca ilk açılışta; sunucu çizimi bunu bilmez — istemci belleği)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const d = JSON.parse(raw) as { items?: unknown; annotations?: unknown };
        const ids = new Set(files.map((f) => f.id));
        if (Array.isArray(d.items) && d.items.length) setItems(d.items.slice(0, MAX_ITEMS).map((x) => String(x ?? '').slice(0, MAX_ITEM)));
        if (Array.isArray(d.annotations)) setAnnotations((d.annotations as Annotation[]).filter((a) => a && ids.has(a.fileId)));
      }
    } catch { /* bellek yok / bozuk: boş form */ }
    restored.current = true;
  }, [key, files]);
  useEffect(() => {
    if (!restored.current) return;
    try { sessionStorage.setItem(key, JSON.stringify({ items, annotations })); } catch { /* bellek yok */ }
  }, [key, items, annotations]);
  const empty = !items.some((x) => x.trim()) && !annotations.some((a) => a.text.trim());
  const set = (i: number, v: string) => setItems(items.map((x, j) => (j === i ? v : x)));
  return (
    <form action={requestRevisionAction} onSubmit={() => { try { sessionStorage.removeItem(key); } catch { /* bellek yok */ } }}>
      <input type="hidden" name="id" value={orderId} />
      <input type="hidden" name="drawingId" value={drawingId} />
      <input type="hidden" name="annotations" value={JSON.stringify(annotations)} />
      <DrawingViewer
        files={files} annotations={annotations} editable onChange={setAnnotations} text={viewer}
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
