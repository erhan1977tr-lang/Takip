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
