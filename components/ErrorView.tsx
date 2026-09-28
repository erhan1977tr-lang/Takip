'use client';

import { useEffect } from 'react';

// Uygulama güncellenince açık kalan eski sayfa, artık var olmayan dosyaları ister.
const STALE = /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module/i;

/** Hata ekranı: yenile düğmesi, güncelleme sonrası eski sayfaysa bir kez kendiliğinden yeniler. */
export function ErrorView({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const stale = STALE.test(`${error.name} ${error.message}`);
  useEffect(() => {
    console.error(error);
    if (!stale) return;
    try {
      const key = 'takip-reload-at';
      if (Date.now() - Number(sessionStorage.getItem(key) || 0) > 30_000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
    } catch {
      // tarayıcı depolaması kapalıysa kullanıcı düğmeyle yeniler
    }
  }, [error, stale]);

  return (
    <div className="error-view">
      <h1>{stale ? 'Uygulama güncellendi' : 'Bir hata oluştu'}</h1>
      <p className="muted">
        {stale
          ? 'Sayfanın yeni sürümü yükleniyor. Birkaç saniye içinde açılmazsa sayfayı yenileyin.'
          : 'Sayfayı yenileyip tekrar deneyin. Sorun sürerse bu ekranın görüntüsünü gönderin.'}
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Sayfayı yenile</button>
        {reset && !stale && <button type="button" className="btn" onClick={() => reset()}>Tekrar dene</button>}
        <a className="btn" href="/siparisler">Ana sayfa</a>
      </div>
      <p className="hint" style={{ marginTop: 12 }}>{error.digest ? `Hata kodu: ${error.digest}` : `${error.name}: ${error.message}`}</p>
    </div>
  );
}
