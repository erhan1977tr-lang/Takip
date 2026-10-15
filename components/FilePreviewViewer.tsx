'use client';

// Önizleme penceresi (karar 283) — components/FilePreview.tsx düğmeye basılınca yükler.
// PDF: pdf.js, sayfalar görünür oldukça çizilir (büyük PDF'te bellek / işlemci korunur), sayfa geçişi, yakınlaştırma.
// Resim: yakınlaştır / kaydır / sığdır (fare tekerleği, sürükleme, iki parmak).
// DWG / DXF: sunucunun ürettiği geometri (server/cad) tuvale çizilir; katmanlar, sığdır, uyarılar. Ölçü / birim yalnızca
// dosyada yazan bilgidir — uydurulmaz; gösterilemeyen nesneler gizlenmez, uyarıda listelenir.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PDF_ASSETS, loadPdfjs } from './pdfjs';
import { fill, type PreviewFamily, type PreviewText } from './FilePreview';

type Fail = { code: string };

/** Sunucu yanıtı → sabit hata kodu (yanıt metni gösterilmez) */
async function failOf(res: Response): Promise<Fail> {
  if (res.status === 401) return { code: 'LOGIN' };
  if (res.status === 403) return { code: 'INFECTED' };
  if (res.status === 404) return { code: 'NOT_FOUND' };
  try {
    const j = await res.json();
    if (j && typeof j.code === 'string' && /^[A-Z_]{2,30}$/.test(j.code)) return { code: j.code };
  } catch { /* gövde JSON değil */ }
  return { code: 'INVALID' };
}

async function fetchPreview(url: string, signal: AbortSignal): Promise<Response | Fail> {
  try {
    const res = await fetch(url, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (!res.ok) return failOf(res);
    return res;
  } catch {
    return { code: signal.aborted ? 'ABORTED' : 'NETWORK' };
  }
}

const isFail = (v: unknown): v is Fail => !!v && typeof v === 'object' && 'code' in v && !(v instanceof Response);

// ---------------------------------------------------------------------------------------------------------------------
// Yakınlaştırma / kaydırma (resim ve CAD ortak): ekran = t + s · içerik (CAD'de y ters çevrilir)
// ---------------------------------------------------------------------------------------------------------------------

type View = { s: number; tx: number; ty: number };

function usePanZoom(el: HTMLDivElement | null, { min, max }: { min: number; max: number }) {
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const zoomAt = useCallback((f: number, cx: number, cy: number) => {
    setView((v) => {
      const s = Math.min(max, Math.max(min, v.s * f));
      const k = s / v.s;
      return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }, [min, max]);
  useEffect(() => {
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.004), p.x, p.y);
    };
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      if (pts.size === 1) {
        setView((v) => ({ ...v, tx: v.tx + p.x - prev.x, ty: v.ty + p.y - prev.y }));
        pts.set(e.pointerId, p);
        return;
      }
      pts.set(e.pointerId, p);
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && d > 0) zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = d;
    };
    const onUp = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [el, zoomAt]);
  const zoomCenter = useCallback((f: number) => {
    if (el) zoomAt(f, el.clientWidth / 2, el.clientHeight / 2);
  }, [el, zoomAt]);
  return { view, setView, zoomCenter };
}

/**
 * Kapsayıcının boyutu. Öğenin kendisi izlenir (geri çağırmalı ref ile): öğe sonradan (veri gelince) oluşsa da ölçülür.
 */
function useSize(el: HTMLElement | null) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [el]);
  return size;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pencere
// ---------------------------------------------------------------------------------------------------------------------

export default function FilePreviewViewer({ href, name, family, text, onClose }: {
  href: string; name: string; family: PreviewFamily; text: PreviewText; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tools, setTools] = useState<React.ReactNode>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);
  return (
    <dialog ref={dialog} className="modal preview-modal" aria-label={name} onClose={onClose} onCancel={onClose} data-preview-modal={family}>
      <div className="preview-head">
        <div className="preview-name" title={name}>{name}</div>
        <div className="preview-tools">{tools}</div>
        <div className="preview-actions">
          <a className="btn" href={href} data-preview-download>{text.download}</a>
          <button type="button" className="btn" onClick={() => dialog.current?.close()} data-preview-close>{text.close}</button>
        </div>
      </div>
      <div className="preview-body">
        {family === 'pdf' && <PdfView href={href} text={text} setTools={setTools} />}
        {family === 'image' && <ImageView href={href} name={name} text={text} setTools={setTools} />}
        {family === 'cad' && <CadView href={href} name={name} text={text} setTools={setTools} />}
      </div>
    </dialog>
  );
}

function Status({ text, code, loading }: { text: PreviewText; code?: string; loading?: string }) {
  if (code) {
    return (
      <div className="preview-status" role="alert" data-preview-error={code}>
        <div className="alert alert-error">
          <strong>{text.errorTitle}</strong>
          <div>{text.errors[code] ?? text.errors.INVALID}</div>
        </div>
      </div>
    );
  }
  return <div className="preview-status muted" role="status" data-preview-loading>{loading ?? text.loading}</div>;
}

function ZoomTools({ text, onOut, onIn, onFit, pct }: { text: PreviewText; onOut: () => void; onIn: () => void; onFit: () => void; pct?: number }) {
  return (
    <span className="preview-zoom">
      <button type="button" className="btn" onClick={onOut} aria-label={text.zoomOut} title={text.zoomOut}>−</button>
      {pct !== undefined && <span className="preview-pct">{Math.round(pct)}%</span>}
      <button type="button" className="btn" onClick={onIn} aria-label={text.zoomIn} title={text.zoomIn}>+</button>
      <button type="button" className="btn" onClick={onFit} data-preview-fit>{text.fit}</button>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------------------------------

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPageObj>; destroy: () => void };
type PdfPageObj = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void>; cancel: () => void };
};

function PdfView({ href, text, setTools }: { href: string; text: PreviewText; setTools: (n: React.ReactNode) => void }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [fail, setFail] = useState<string>('');
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState(1.414);
  const [current, setCurrent] = useState(1);
  const scroll = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useCallback((n: HTMLDivElement | null) => { scroll.current = n; setScrollEl(n); }, []);
  const { w } = useSize(scrollEl);

  useEffect(() => {
    const ac = new AbortController();
    let loaded: PdfDoc | null = null;
    (async () => {
      const res = await fetchPreview(`${href}?onizle=1`, ac.signal);
      if (isFail(res)) { if (res.code !== 'ABORTED') setFail(res.code); return; }
      const data = new Uint8Array(await res.arrayBuffer());
      const lib = await loadPdfjs();
      const d: PdfDoc = await lib.getDocument({ data, isEvalSupported: false, ...PDF_ASSETS }).promise;
      loaded = d;
      if (ac.signal.aborted) { d.destroy(); return; }
      const first = await d.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      if (vp.width > 0) setAspect(vp.height / vp.width);
      setDoc(d);
    })().catch(() => { if (!ac.signal.aborted) setFail('RENDER'); });
    return () => { ac.abort(); loaded?.destroy(); };
  }, [href]);

  const pageWidth = Math.max(120, (w - 24) * zoom);
  const goto = (n: number) => {
    const el = scroll.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && scroll.current) scroll.current.scrollTo({ top: el.offsetTop - 8 });
  };
  const total = doc?.numPages ?? 0;

  useEffect(() => {
    if (!doc) { setTools(null); return; }
    setTools(
      <>
        <span className="preview-pages">
          <button type="button" className="btn" disabled={current <= 1} onClick={() => goto(current - 1)} aria-label={text.prev} title={text.prev}>‹</button>
          <span data-preview-page>{fill(text.page, { n: current, total })}</span>
          <button type="button" className="btn" disabled={current >= total} onClick={() => goto(current + 1)} aria-label={text.next} title={text.next}>›</button>
        </span>
        <ZoomTools text={text} pct={zoom * 100} onOut={() => setZoom((z) => Math.max(0.25, z / 1.25))} onIn={() => setZoom((z) => Math.min(5, z * 1.25))} onFit={() => setZoom(1)} />
      </>,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, current, total, zoom, text, setTools]);
  useEffect(() => () => setTools(null), [setTools]);

  const onScroll = () => {
    const el = scroll.current;
    if (!el || !total) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    let n = 1;
    for (const p of el.querySelectorAll<HTMLElement>('[data-page]')) {
      if (p.offsetTop <= mid) n = Number(p.dataset.page);
      else break;
    }
    if (n !== current) setCurrent(n);
  };

  if (fail) return <Status text={text} code={fail} />;
  return (
    <div className="preview-scroll" ref={scrollRef} onScroll={onScroll} data-preview-pdf={total || undefined}>
      {!doc && <Status text={text} />}
      {doc && w > 0 && Array.from({ length: total }, (_, i) => (
        <PdfPreviewPage key={i + 1} doc={doc} n={i + 1} width={pageWidth} aspect={aspect} root={scrollEl} />
      ))}
    </div>
  );
}

/** Tek sayfa: görünür alana yaklaşınca çizilir, çok uzaklaşınca tuval boşaltılır */
function PdfPreviewPage({ doc, n, width, aspect, root }: { doc: PdfDoc; n: number; width: number; aspect: number; root: HTMLDivElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(aspect);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root, rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (!near) { c.width = 0; c.height = 0; setDrawn(false); return; }
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const timer = setTimeout(async () => {
      try {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        if (base.width > 0) setRatio(base.height / base.width);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const px = Math.min(4096, width * dpr);
        const vp = page.getViewport({ scale: px / base.width });
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const r = page.render({ canvasContext: ctx, viewport: vp });
        task = r;
        await r.promise;
        if (!cancelled) setDrawn(true);
      } catch { /* sayfa iptal edildi / çizilemedi */ }
    }, 60);
    return () => { cancelled = true; clearTimeout(timer); task?.cancel(); };
  }, [near, width, doc, n]);
  return (
    <div ref={box} className="preview-page" data-page={n} data-drawn={drawn ? '1' : undefined} style={{ width, height: Math.round(width * ratio) }}>
      <canvas ref={canvas} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Resim
// ---------------------------------------------------------------------------------------------------------------------

function ImageView({ href, name, text, setTools }: { href: string; name: string; text: PreviewText; setTools: (n: React.ReactNode) => void }) {
  const [src, setSrc] = useState('');
  const [fail, setFail] = useState('');
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const size = useSize(stage);
  const { view, setView, zoomCenter } = usePanZoom(stage, { min: 0.02, max: 20 });

  useEffect(() => {
    const ac = new AbortController();
    let url = '';
    (async () => {
      const res = await fetchPreview(`${href}?onizle=1`, ac.signal);
      if (isFail(res)) { if (res.code !== 'ABORTED') setFail(res.code); return; }
      const blob = await res.blob();
      if (ac.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setSrc(url);
    })().catch(() => { if (!ac.signal.aborted) setFail('NETWORK'); });
    return () => { ac.abort(); if (url) URL.revokeObjectURL(url); };
  }, [href]);

  const fit = useCallback(() => {
    if (!nat || !size.w || !size.h) return;
    const s = Math.min(size.w / nat.w, size.h / nat.h, 1) * 0.97;
    setView({ s, tx: (size.w - nat.w * s) / 2, ty: (size.h - nat.h * s) / 2 });
  }, [nat, size.w, size.h, setView]);
  useEffect(() => { fit(); }, [fit]);

  useEffect(() => {
    if (!nat) { setTools(null); return; }
    setTools(<ZoomTools text={text} pct={view.s * 100} onOut={() => zoomCenter(1 / 1.25)} onIn={() => zoomCenter(1.25)} onFit={fit} />);
  }, [nat, view.s, text, zoomCenter, fit, setTools]);
  useEffect(() => () => setTools(null), [setTools]);

  if (fail) return <Status text={text} code={fail} />;
  return (
    <div className="preview-stage" ref={setStage} data-preview-image={nat ? `${nat.w}x${nat.h}` : undefined}>
      {!nat && <Status text={text} />}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src} alt={name} draggable={false}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFail('RENDER')}
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`, visibility: nat ? 'visible' : 'hidden' }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// DWG / DXF
// ---------------------------------------------------------------------------------------------------------------------

type CadPath = [number, string | null, number, number[][]];
type CadText = [number, string | null, number, number, number, number, string, string, string, number];
type CadPoint = [number, string | null, number, number];
type CadData = {
  version: string | null; units: string | null; extents: number[] | null;
  layers: { name: string; color: string; on: boolean }[];
  paths: CadPath[]; texts: CadText[]; points: CadPoint[];
  notes: { unsupported: Record<string, number>; partial: Record<string, number>; paperSpace: number; dropped?: Record<string, number>; converterErrors?: number };
};
type CadResult = { ok: true; converted: boolean; warning: boolean; data: CadData };

const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
/**
 * Dosyadaki renk (yalnızca "#rrggbb" kabul edilir). Çizim CAD alışkanlığıyla koyu zemine çizilir: siyaha çok yakın
 * renkler (AutoCAD'in "beyaz / siyah" 7 numarası gibi) zeminde kaybolmasın diye beyaz gösterilir.
 */
const colorOf = (c: string | null | undefined, fallback: string) => {
  const v = c && SAFE_COLOR.test(c) ? c : SAFE_COLOR.test(fallback) ? fallback : '#ffffff';
  const n = parseInt(v.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum < 0.12 ? '#ffffff' : v;
};

/** Katman + renk başına önceden kurulmuş yollar (dünya koordinatı, kaydırılmış başlangıç) */
function buildPaths(d: CadData, ox: number, oy: number) {
  const groups = new Map<string, { layer: number; color: string; stroke: Path2D; fill: Path2D; hasFill: boolean }>();
  for (const [layer, color, flags, rings] of d.paths) {
    const col = colorOf(color, d.layers[layer]?.color ?? '#ffffff');
    const key = `${layer}|${col}`;
    let g = groups.get(key);
    if (!g) {
      g = { layer, color: col, stroke: new Path2D(), fill: new Path2D(), hasFill: false };
      groups.set(key, g);
    }
    for (const r of rings) {
      const fillIt = (flags & 2) !== 0;
      // Dolgulu halka hem dolgu hem çevre çizgisi olarak çizilir; diğerleri yalnızca çizgi
      for (const p of fillIt ? [g.fill, g.stroke] : [g.stroke]) {
        p.moveTo(r[0] - ox, r[1] - oy);
        for (let k = 2; k < r.length; k += 2) p.lineTo(r[k] - ox, r[k + 1] - oy);
        if (flags & 1 || fillIt) p.closePath();
      }
      if (fillIt) g.hasFill = true;
    }
  }
  return [...groups.values()];
}

function CadView({ href, name, text, setTools }: { href: string; name: string; text: PreviewText; setTools: (n: React.ReactNode) => void }) {
  const [res, setRes] = useState<CadResult | null>(null);
  const [fail, setFail] = useState('');
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useSize(stage);
  const { view, setView, zoomCenter } = usePanZoom(stage, { min: 1e-9, max: 1e9 });
  const loadingText = /\.dwg$/i.test(name.trim()) ? text.converting : text.loading;

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      const r = await fetchPreview(`${href}?onizle=cad`, ac.signal);
      if (isFail(r)) { if (r.code !== 'ABORTED') setFail(r.code); return; }
      const j = (await r.json()) as CadResult;
      if (ac.signal.aborted) return;
      if (!j || j.ok !== true || !j.data || !Array.isArray(j.data.paths)) { setFail('INVALID'); return; }
      setHidden(new Set(j.data.layers.map((l, i) => (l.on ? -1 : i)).filter((i) => i >= 0)));
      setRes(j);
    })().catch(() => { if (!ac.signal.aborted) setFail('NETWORK'); });
    return () => ac.abort();
  }, [href]);

  const data = res?.data ?? null;
  const ext = data?.extents && data.extents.length === 4 && data.extents.every(Number.isFinite) ? data.extents : null;
  const origin = useMemo(() => (ext ? [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2] : [0, 0]), [ext]);
  const groups = useMemo(() => (data ? buildPaths(data, origin[0], origin[1]) : []), [data, origin]);

  const fit = useCallback(() => {
    if (!ext || !size.w || !size.h) return;
    const w = Math.max(ext[2] - ext[0], 1e-9);
    const h = Math.max(ext[3] - ext[1], 1e-9);
    const s = Math.min(size.w / w, size.h / h) * 0.94;
    setView({ s, tx: size.w / 2, ty: size.h / 2 });
  }, [ext, size.w, size.h, setView]);
  useEffect(() => { fit(); }, [fit]);

  // Çizim: dünya → ekran = (t + s·(x − ox), t − s·(y − oy)); çizgi kalınlığı ekranda 1 piksel
  useEffect(() => {
    const c = canvas.current;
    if (!c || !data || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const raf = requestAnimationFrame(() => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const { s, tx, ty } = view;
      ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * tx, dpr * ty);
      ctx.lineWidth = 1 / s;
      ctx.lineJoin = 'round';
      for (const g of groups) {
        if (hidden.has(g.layer)) continue;
        if (g.hasFill) {
          ctx.fillStyle = g.color;
          ctx.fill(g.fill, 'evenodd');
        }
        ctx.strokeStyle = g.color;
        ctx.stroke(g.stroke);
      }
      const ox = origin[0];
      const oy = origin[1];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [layer, color, x, y] of data.points) {
        if (hidden.has(layer)) continue;
        ctx.fillStyle = colorOf(color, data.layers[layer]?.color ?? '#ffffff');
        ctx.fillRect(tx + s * (x - ox) - 1.5, ty - s * (y - oy) - 1.5, 3, 3);
      }
      ctx.textBaseline = 'alphabetic';
      for (const [layer, color, x, y, h, rot, str, ha, va, wf] of data.texts) {
        if (hidden.has(layer)) continue;
        const px = h * s;
        if (px < 2.5) continue;
        const sx = tx + s * (x - ox);
        const sy = ty - s * (y - oy);
        if (sx < -4000 || sx > size.w + 4000 || sy < -4000 || sy > size.h + 4000) continue;
        const lines = str.split('\n');
        const lh = px * 1.66;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(-rot);
        ctx.scale(wf > 0 ? wf : 1, 1);
        ctx.fillStyle = colorOf(color, data.layers[layer]?.color ?? '#ffffff');
        ctx.font = `${px}px sans-serif`;
        ctx.textAlign = ha === 'c' ? 'center' : ha === 'r' ? 'right' : 'left';
        const block = (lines.length - 1) * lh;
        const y0 = va === 't' ? px : va === 'm' ? px / 2 - block / 2 : va === 'B' ? -px * 0.2 - block : -block;
        lines.forEach((ln, i) => ctx.fillText(ln, 0, y0 + i * lh));
        ctx.restore();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [data, groups, hidden, view, size.w, size.h, origin]);

  useEffect(() => {
    if (!ext) { setTools(null); return; }
    setTools(<ZoomTools text={text} onOut={() => zoomCenter(1 / 1.25)} onIn={() => zoomCenter(1.25)} onFit={fit} />);
  }, [ext, text, zoomCenter, fit, setTools]);
  useEffect(() => () => setTools(null), [setTools]);

  if (fail) return <Status text={text} code={fail} />;
  if (!res || !data) return <Status text={text} loading={loadingText} />;

  const n = data.notes;
  const list = (o: Record<string, number> | undefined) => Object.entries(o ?? {}).map(([k, v]) => `${k} × ${v}`).join(', ');
  const unsupported = list(n.unsupported);
  const partial = list(n.partial);
  const warn = !!unsupported || !!partial || n.paperSpace > 0 || (n.converterErrors ?? 0) > 0 || res.warning;
  const toggle = (i: number) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  return (
    <div className="preview-cad" data-preview-cad={data.paths.length + data.texts.length + data.points.length}>
      <div className="preview-cad-main">
        {warn && (
          <div className="alert alert-warn preview-warn" data-preview-warn>
            <strong>{text.warnTitle}</strong>
            <ul className="plain-list">
              {unsupported && <li data-warn="unsupported">{fill(text.warnUnsupported, { list: unsupported })}</li>}
              {partial && <li data-warn="partial">{fill(text.warnPartial, { list: partial })}</li>}
              {n.paperSpace > 0 && <li data-warn="paper">{fill(text.warnPaper, { n: n.paperSpace })}</li>}
              {((n.converterErrors ?? 0) > 0 || res.warning) && <li data-warn="converter">{text.warnConverter}</li>}
            </ul>
            <div className="small">{text.warnHint}</div>
          </div>
        )}
        <div className="preview-stage preview-cad-stage" ref={setStage}>
          {!ext && <div className="preview-status muted" data-preview-empty>{text.empty}</div>}
          <canvas ref={canvas} />
        </div>
      </div>
      <aside className="preview-side">
        <div className="small muted">
          <div data-preview-units>{data.units ? fill(text.units, { u: data.units }) : text.unitsUnknown}</div>
          {data.version && <div>{fill(text.version, { v: data.version })}</div>}
          {res.converted && <div data-preview-converted>{text.converted}</div>}
          <div>{text.hint}</div>
        </div>
        {data.layers.length > 0 && (
          <details className="preview-layers" open>
            <summary>{text.layers} ({data.layers.length})</summary>
            <div className="row" style={{ gap: 6, margin: '6px 0' }}>
              <button type="button" className="btn" onClick={() => setHidden(new Set())}>{text.layersAll}</button>
              <button type="button" className="btn" onClick={() => setHidden(new Set(data.layers.map((_, i) => i)))}>{text.layersNone}</button>
            </div>
            <ul className="plain-list">
              {data.layers.map((l, i) => (
                <li key={i}>
                  <label className="preview-layer">
                    <input type="checkbox" checked={!hidden.has(i)} onChange={() => toggle(i)} data-layer={l.name} />
                    <span className="preview-swatch" style={{ background: colorOf(l.color, '#ffffff') }} aria-hidden />
                    <span className="preview-layer-name">{l.name}</span>
                    {!l.on && <span className="small muted"> · {text.layerOffInFile}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>
    </div>
  );
}
