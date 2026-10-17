'use client';

// Ortak dosya önizlemesi (karar 283): "Önizle" düğmesi + tek pencere. Metinler panel düzeninde bir kez verilir
// (PreviewProvider); görüntüleyici (pdf.js, resim, CAD çizici) ancak düğmeye basılınca yüklenir.
// Erişim burada DEĞİL, sunucuda denetlenir: düğme yalnızca indirme adresine "?onizle=…" ekler; aynı sorgu, aynı kural.
import dynamic from 'next/dynamic';
import { createContext, useContext, useState } from 'react';

export type PreviewFamily = 'pdf' | 'image' | 'cad';
type TextKey = 'button' | 'buttonTitle' | 'close' | 'download' | 'loading' | 'converting' | 'zoomIn' | 'zoomOut' | 'fit' | 'prev' | 'next'
  | 'page' | 'layers' | 'layersAll' | 'layersNone' | 'layerOffInFile' | 'units' | 'unitsUnknown' | 'version' | 'converted' | 'hint'
  | 'warnTitle' | 'warnUnsupported' | 'warnPartial' | 'warnPaper' | 'warnConverter' | 'warnHint' | 'empty' | 'errorTitle';
/** server/i18n/{tr,ro}/files.js → preview (+ common.download); panel düzeni bir kez verir */
export type PreviewText = { [K in TextKey]: string } & { errors: Record<string, string> };

const Ctx = createContext<PreviewText | null>(null);

export function PreviewProvider({ text, children }: { text: PreviewText; children: React.ReactNode }) {
  return <Ctx.Provider value={text}>{children}</Ctx.Provider>;
}

/** "{x}" yer tutucularını doldurur */
export function fill(s: string | undefined, params: Record<string, string | number> = {}) {
  return (s ?? '').replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

const Viewer = dynamic(() => import('./FilePreviewViewer'), { ssr: false });

/**
 * @param href dosyanın İNDİRME adresi (/dosya/<tür>/<kimlik>) — önizleme aynı adresi "?onizle=1|cad" ile ister
 * @param family dosya adının uzantısından (server/files/preview.js → previewFamily); içerik sunucuda yeniden denetlenir
 */
export function PreviewButton({ href, name, family }: { href: string; name: string; family: PreviewFamily }) {
  const text = useContext(Ctx);
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <>
      <button type="button" className="btn" data-preview={family} title={fill(text.buttonTitle, { name })} onClick={() => setOpen(true)}>
        {text.button}
      </button>
      {open && <Viewer href={href} name={name} family={family} text={text} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Fotoğraf küçük resmi (DÜZELTME 10 M4): görsel KIRPILMADAN (en-boy oranı korunur) gösterilir; tıklanınca aynı önizleme
 * penceresi (yakınlaştırma + kaydırma, fare ve dokunmatik) açılır. Küçük resmin kaynağı ve önizleme isteği dosyanın kendi
 * yetkili adresidir (/dosya/…); erişim sunucuda denetlenir. Metinler yoksa (sağlayıcı dışında) bağlantı olarak yeni sekmede açar.
 */
export function PhotoThumb({ href, name, alt, label }: { href: string; name: string; alt: string; label: string }) {
  const text = useContext(Ctx);
  const [open, setOpen] = useState(false);
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={`${href}?ac=1`} alt={alt} loading="lazy" />;
  if (!text) return <a className="photo-thumb" href={`${href}?ac=1`} target="_blank" rel="noopener noreferrer" aria-label={label}>{img}</a>;
  return (
    <>
      <button type="button" className="photo-thumb" aria-label={label} data-photo-open onClick={() => setOpen(true)}>{img}</button>
      {open && <Viewer href={href} name={name} family="image" text={text} onClose={() => setOpen(false)} />}
    </>
  );
}
