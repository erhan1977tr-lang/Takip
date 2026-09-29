'use client';

import { useEffect, useState } from 'react';
import trMsg from '@/server/i18n/tr/errorView.js';
import roMsg from '@/server/i18n/ro/errorView.js';
import { interpolate } from '@/server/i18n/interpolate.js';

// Uygulama güncellenince açık kalan eski sayfa, artık var olmayan dosyaları ister.
const STALE = /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module/i;

/** Sayfanın dili: kök düzenin <html lang>'ı, yoksa dil çerezi, yoksa Romence. */
function pageLocale(): 'ro' | 'tr' {
  const lang = document.documentElement.lang;
  if (lang === 'tr' || lang === 'ro') return lang;
  return /(?:^|;\s*)takip_lang=tr(?:;|$)/.test(document.cookie) ? 'tr' : 'ro';
}

/** Hata ekranı: yenile düğmesi, güncelleme sonrası eski sayfaysa bir kez kendiliğinden yeniler. */
export function ErrorView({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const stale = STALE.test(`${error.name} ${error.message}`);
  const [locale, setLocale] = useState<'ro' | 'tr'>('ro');
  const m = locale === 'tr' ? trMsg : roMsg;
  useEffect(() => {
    setLocale(pageLocale());
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
      <h1>{stale ? m.staleTitle : m.title}</h1>
      <p className="muted">{stale ? m.staleText : m.text}</p>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{m.reload}</button>
        {reset && !stale && <button type="button" className="btn" onClick={() => reset()}>{m.retry}</button>}
        <a className="btn" href="/siparisler">{m.home}</a>
      </div>
      <p className="hint" style={{ marginTop: 12 }}>{error.digest ? interpolate(m.code, { code: error.digest }) : `${error.name}: ${error.message}`}</p>
    </div>
  );
}
