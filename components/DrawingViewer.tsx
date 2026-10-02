'use client';

import { useEffect, useRef, useState } from 'react';

// Çizim görüntüleyici (sipariş → cizim/[drawingId]): PDF (pdf.js, tarayıcıda) ve görseller sayfa sayfa gösterilir; üstüne
// işaret konur: İğne, Dikdörtgen, Serbest, Metin. Konumlar sayfaya oranlıdır (0–1). editable: müşteri "Revizyon iste"
// ekranında işaret koyar (kayıt: DrawingRevision.annotations, sunucuda doğrulanır — server/orders/annotations.js);
// değilse yalnızca gösterir (çizimci ve iç ekip revizyon talebini çizim üzerinde görür). Dosyalar /dosya/cizim/<id>
// adresinden gelir: yetki ve firma kapsamı orada, sunucuda denetlenir. Çizim dosyası hiç değişmez.

export type Annotation = { fileId: string; page: number; type: 'pin' | 'rect' | 'free' | 'text'; x: number; y: number; w?: number; h?: number; points?: number[][]; text: string };
export type ViewerFile = { id: string; name: string };
export type ViewerText = {
  tools: { pin: string; rect: string; free: string; text: string };
  hint: string; fit: string; zoomIn: string; zoomOut: string; loading: string; failed: string; noPreview: string; download: string;
  notes: string; noNotes: string; notePlaceholder: string; remove: string; page: string;
};

type Tool = Annotation['type'];
const kindOf = (name: string) => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ext === 'pdf' ? 'pdf' : ['png', 'jpg', 'jpeg'].includes(ext) ? 'image' : 'other';
};
const pct = (v: number) => `${v * 100}%`;

/**
 * pdf.js (yalnızca tarayıcıda, ilk PDF açılınca yüklenir). Çalışan iş parçacığı ayrı dosya istemesin diye ana iş
 * parçacığında çalışır. Yazı tipi gömülmemiş PDF'ler ve CJK metinler için pdf.js'in kendi varlıkları (standart yazı
 * tipleri, cMap'ler) uygulamanın kendi adresinden gelir: app/pdfjs/[kind]/[file] — dış sunucuya (CDN) istek atılmaz.
 * useSystemFonts kapalı: gömülü olmayan yazı tipleri cihazdaki yazı tipine göre değil, hep pdf.js'in kendi standart
 * yazı tipleriyle çizilir — çizim her cihazda (müşterinin telefonu dahil) aynı görünür.
 * PDF içindeki görsellerin çözücüleri (JPEG, JPEG 2000, JBIG2) pdf.js paketinin içindedir.
 */
const PDF_ASSETS = { standardFontDataUrl: '/pdfjs/standard_fonts/', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, useSystemFonts: false };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.mjs')]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
    return lib;
  })();
  return pdfjsPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PdfPage({ doc, n, children }: { doc: any; n: number; children: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task: any = null;
    (async () => {
      const page = await doc.getPage(n);
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      // Net görünsün diye geniş çizilir (en fazla ~2400 px), ekranda kapsayıcıya sığdırılır
      const viewport = page.getViewport({ scale: Math.min(3, 2400 / base.width) });
      const c = canvas.current;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: c.getContext('2d'), viewport });
      await task.promise.catch(() => {});
    })();
    return () => { cancelled = true; task?.cancel?.(); };
  }, [doc, n]);
  return <div className="viewer-page"><canvas ref={canvas} />{children}</div>;
}

export function DrawingViewer({ files, annotations, editable = false, onChange, text, side }: {
  files: ViewerFile[]; annotations: Annotation[]; editable?: boolean; onChange?: (a: Annotation[]) => void; text: ViewerText;
  /** Sağ sütunun üstünde gösterilen bölüm (karar / gönderim / revizyon notu) */
  side?: React.ReactNode;
}) {
  const [fileId, setFileId] = useState(files.find((f) => kindOf(f.name) !== 'other')?.id ?? files[0]?.id ?? '');
  const [tool, setTool] = useState<Tool>('pin');
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(''); // açılamayan dosyanın adresi
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [doc, setDoc] = useState<any>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  // Sürüklenen işaretin güncel hâli: art arda gelen işaretçi olayları (hızlı çizim) bir önceki çizimi beklemeden
  // buradan okur — serbest çizimde nokta kaybolmaz. setDraft yalnızca ekrana çizmek içindir.
  const live = useRef<Annotation | null>(null);
  const show = (d: Annotation | null) => { live.current = d; setDraft(d); };
  const [focus, setFocus] = useState(-1);
  const file = files.find((f) => f.id === fileId);
  const kind = file ? kindOf(file.name) : 'other';
  const url = file ? `/dosya/cizim/${file.id}?ac=1` : '';
  const error = !!url && failed === url;

  useEffect(() => {
    setDoc(null);
    if (kind !== 'pdf') return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let loaded: any = null;
    loadPdfjs()
      .then((lib) => lib.getDocument({ url, isEvalSupported: false, ...PDF_ASSETS }).promise)
      .then((d) => { loaded = d; if (cancelled) d.destroy?.(); else setDoc(d); })
      .catch(() => { if (!cancelled) setFailed(url); });
    return () => { cancelled = true; loaded?.destroy?.(); };
  }, [url, kind]);

  const set = (next: Annotation[]) => onChange?.(next);
  const add = (a: Annotation) => { set([...annotations, a]); setFocus(annotations.length); };
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  /** Sayfanın üstündeki işaret katmanı (işaretler + düzenlemede fare / dokunma) */
  const layer = (page: number) => {
    const here = annotations.map((a, i) => ({ a, i })).filter(({ a }) => a.fileId === fileId && a.page === page);
    const drawing = editable && (tool === 'rect' || tool === 'free');
    const handlers = !editable ? {} : drawing ? {
      onPointerDown: (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const p = at(e);
        show({ fileId, page, type: tool, x: p.x, y: p.y, w: 0, h: 0, points: [[p.x, p.y]], text: '' });
      },
      onPointerMove: (e: React.PointerEvent) => {
        const d = live.current;
        if (!d || d.page !== page) return;
        const p = at(e);
        if (d.type === 'rect') show({ ...d, w: p.x - (d.points?.[0]?.[0] ?? p.x), h: p.y - (d.points?.[0]?.[1] ?? p.y) });
        else {
          const last = d.points![d.points!.length - 1];
          if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.004 && d.points!.length < 400) show({ ...d, points: [...d.points!, [p.x, p.y]] });
        }
      },
      onPointerUp: () => {
        const d = live.current;
        if (!d) return;
        show(null);
        if (d.type === 'rect') {
          const [sx, sy] = d.points![0];
          const w = Math.abs(d.w ?? 0), h = Math.abs(d.h ?? 0);
          if (w > 0.01 && h > 0.01) add({ fileId, page, type: 'rect', x: Math.min(sx, sx + (d.w ?? 0)), y: Math.min(sy, sy + (d.h ?? 0)), w, h, text: '' });
        } else if ((d.points?.length ?? 0) > 1) add({ fileId, page, type: 'free', x: d.points![0][0], y: d.points![0][1], points: d.points, text: '' });
      },
      // Sürükleme yarıda kesilirse (dokunma iptali, pencere değişimi) yarım işaret bırakılmaz
      onPointerCancel: () => show(null),
    } : {
      onClick: (e: React.MouseEvent) => { const p = at(e); add({ fileId, page, type: tool, x: p.x, y: p.y, text: '' }); },
    };
    const shape = (a: Annotation, n: number | null, key: string) => {
      if (a.type === 'pin') return <span key={key} className="ann ann-pin" style={{ left: pct(a.x), top: pct(a.y) }}>{n}</span>;
      if (a.type === 'text') return <span key={key} className="ann ann-text" style={{ left: pct(a.x), top: pct(a.y) }}>{a.text || n}</span>;
      if (a.type === 'rect') {
        const x = (a.w ?? 0) < 0 ? a.x + (a.w ?? 0) : a.x, y = (a.h ?? 0) < 0 ? a.y + (a.h ?? 0) : a.y;
        return <span key={key} className="ann ann-rect" style={{ left: pct(x), top: pct(y), width: pct(Math.abs(a.w ?? 0)), height: pct(Math.abs(a.h ?? 0)) }}>{n != null && <b>{n}</b>}</span>;
      }
      return (
        <span key={key}>
          <svg className="ann-free" viewBox="0 0 1 1" preserveAspectRatio="none">
            <polyline points={(a.points ?? []).map((p) => p.join(',')).join(' ')} vectorEffect="non-scaling-stroke" />
          </svg>
          {n != null && <span className="ann ann-no" style={{ left: pct(a.x), top: pct(a.y) }}>{n}</span>}
        </span>
      );
    };
    return (
      <div className={`viewer-layer${editable ? ' editable' : ''}${drawing ? ' drawing' : ''}`} {...handlers}>
        {here.map(({ a, i }) => shape(a, i + 1, `a${i}`))}
        {draft && draft.page === page && shape(draft.type === 'rect' ? { ...draft, x: draft.points![0][0], y: draft.points![0][1] } : draft, null, 'draft')}
      </div>
    );
  };

  return (
    <div className="viewer">
      <div className="viewer-main card">
        <div className="viewer-bar">
          {files.length > 1 && (
            <select value={fileId} onChange={(e) => setFileId(e.target.value)} aria-label={text.page}>
              {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          {editable && kind !== 'other' && !error && (
            <span className="viewer-tools">
              {(['pin', 'rect', 'free', 'text'] as Tool[]).map((k) => (
                <button key={k} type="button" className={`btn${tool === k ? ' btn-primary' : ''}`} aria-pressed={tool === k} onClick={() => setTool(k)}>{text.tools[k]}</button>
              ))}
            </span>
          )}
          <span className="viewer-zoom">
            <button type="button" className="btn btn-link" aria-label={text.zoomOut} onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}>−</button>
            <span className="small muted">%{Math.round(zoom * 100)}</span>
            <button type="button" className="btn btn-link" aria-label={text.zoomIn} onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}>+</button>
            <button type="button" className="btn btn-link" onClick={() => setZoom(1)}>{text.fit}</button>
          </span>
        </div>
        {editable && kind !== 'other' && <p className="hint viewer-hint">{text.hint}</p>}
        <div className="viewer-scroll">
          <div style={{ width: pct(zoom) }}>
            {kind === 'other' && <p className="muted">{text.noPreview} <a href={`/dosya/cizim/${fileId}`}>{text.download}</a></p>}
            {kind === 'pdf' && !doc && !error && <p className="muted">{text.loading}</p>}
            {error && <p className="muted">{text.failed} <a href={`/dosya/cizim/${fileId}`}>{text.download}</a></p>}
            {kind === 'image' && !error && (
              <div className="viewer-page">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img key={url} src={url} alt={file?.name ?? ''} onError={() => setFailed(url)} />
                {layer(1)}
              </div>
            )}
            {kind === 'pdf' && doc && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={`${fileId}-${i}`} doc={doc} n={i + 1}>{layer(i + 1)}</PdfPage>)}
          </div>
        </div>
      </div>
      <div className="viewer-aside">
        {side}
        <div className="viewer-side card">
          <h2>{text.notes} <span className="badge">{annotations.length}</span></h2>
          {annotations.length === 0 && <p className="muted">{text.noNotes}</p>}
          {annotations.map((a, i) => (
            <div key={i} className="viewer-note">
              <span className="badge badge-info">{i + 1}</span>
              <span className="small muted">{text.tools[a.type]}{files.length > 1 ? ` · ${files.find((f) => f.id === a.fileId)?.name ?? ''}` : ''}{a.page > 1 ? ` · ${text.page} ${a.page}` : ''}</span>
              {editable ? (
                <>
                  <input value={a.text} maxLength={500} placeholder={text.notePlaceholder} aria-label={`${text.notes} ${i + 1}`} autoFocus={focus === i}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                    onChange={(e) => set(annotations.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  <button type="button" className="btn btn-link danger" aria-label={`${text.remove} ${i + 1}`} onClick={() => set(annotations.filter((_, j) => j !== i))}>✕</button>
                </>
              ) : <span>{a.text || '—'}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
