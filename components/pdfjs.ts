/**
 * pdf.js yükleyicisi — çizim görüntüleyici (DrawingViewer) ve ortak dosya önizlemesi (FilePreview) kullanır (karar 283).
 * Yalnızca tarayıcıda, ilk PDF açılınca yüklenir. Çalışan iş parçacığı ayrı dosya istemesin diye ana iş parçacığında
 * çalışır. Yazı tipi gömülmemiş PDF'ler ve CJK metinler için pdf.js'in kendi varlıkları (standart yazı tipleri, cMap'ler)
 * uygulamanın kendi adresinden gelir: app/pdfjs/[kind]/[file] — dış sunucuya (CDN) istek atılmaz.
 * useSystemFonts kapalı: gömülü olmayan yazı tipleri cihazdaki yazı tipine göre değil, hep pdf.js'in kendi standart
 * yazı tipleriyle çizilir — çizim her cihazda (müşterinin telefonu dahil) aynı görünür.
 * PDF içindeki görsellerin çözücüleri (JPEG, JPEG 2000, JBIG2) pdf.js paketinin içindedir.
 */
export const PDF_ASSETS = { standardFontDataUrl: '/pdfjs/standard_fonts/', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, useSystemFonts: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsPromise: Promise<any> | null = null;
export function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.mjs')]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
    return lib;
  })();
  return pdfjsPromise;
}
