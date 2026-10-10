'use client';

import { useEffect, useRef, useState } from 'react';
import { DrawingViewer, markNo, type Annotation, type ViewerFile, type ViewerText } from '@/components/DrawingViewer';
import { requestRevisionAction } from '../../actions';

/** Sunucuyla aynı sınırlar (server/orders/revision-note.js); asıl denetim sunucudadır */
const MAX_ITEMS = 20;
const MAX_ITEM = 500;

/**
 * Müşteri "Revizyon iste" (karar 162, Paket B — karar 227):
 *   - Çizim üzerine işaret: İğne, Dikdörtgen, Serbest, Metin (DrawingViewer düzenleme kipi). Konumlar sayfaya oranlıdır
 *     (0–1): yakınlaştırma ve pencere boyutu değişince işaret aynı yerde kalır.
 *   - Ayrı "İşaretler" bölümü yoktur (P5 — karar 244): her işaretin açıklaması "Nota de revizie" içinde, işaretin KALICI
 *     numarasıyla ("#3") ayrı bir maddedir. Açıklama işaretin kendi kaydındadır — işaret silinince açıklaması da gider;
 *     başka işaret silinse / taslak yeniden açılsa numara değişmez, açıklama yanlış işarete bağlanamaz.
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
    marks: string; marksHint: string; markLabel: string; markPlaceholder: string; markRemove: string; tools: Record<Annotation['type'], string>; page: string;
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
        // Başka sürümün işareti alınmaz (anahtar sürüme özel; dosya kimlikleri de denetlenir). Numarasız eski taslak işaretine
        // sırayla kalıcı numara verilir.
        if (Array.isArray(d.annotations)) {
          const list = (d.annotations as Annotation[]).filter((a) => a && typeof a === 'object' && ids.has(a.fileId));
          setAnnotations(list.map((a, i) => ({ ...a, id: a.id ?? `m${markNo(a, i)}`, no: markNo(a, i) })));
        }
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
        files={files} annotations={annotations} editable onChange={setAnnotations} text={viewer} notesPanel={false}
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
            {/* İşaretlere bağlı açıklamalar — "Nota de revizie"nin parçası (P5 — karar 244): işaretin kalıcı numarası "#n" */}
            <div className="revision-marks" data-revision-marks>
              <p className="small"><strong>{m.marks}</strong> <span className="badge">{annotations.length}</span></p>
              {annotations.length === 0 && <p className="hint">{m.marksHint}</p>}
              <ol className="revision-items">
                {annotations.map((a, i) => {
                  const no = markNo(a, i);
                  return (
                    <li key={a.id ?? i} className="revision-item" data-mark-no={no}>
                      <span className="badge badge-info" aria-hidden="true">#{no}</span>
                      <span className="small muted">{m.tools[a.type]}{files.length > 1 ? ` · ${files.find((f) => f.id === a.fileId)?.name ?? ''}` : ''}{a.page > 1 ? ` · ${m.page} ${a.page}` : ''}</span>
                      <input
                        value={a.text} maxLength={MAX_ITEM} placeholder={m.markPlaceholder} aria-label={m.markLabel.replace('{n}', String(no))}
                        autoFocus={i === annotations.length - 1 && !a.text}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                        onChange={(e) => setAnnotations(annotations.map((x) => (x === a ? { ...x, text: e.target.value } : x)))}
                      />
                      <button type="button" className="btn btn-link danger" aria-label={m.markRemove.replace('{n}', String(no))}
                        onClick={() => setAnnotations(annotations.filter((x) => x !== a))}>✕</button>
                    </li>
                  );
                })}
              </ol>
            </div>
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
