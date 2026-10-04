'use client';

import { useState } from 'react';
import { setLanguageAction } from '@/app/(panel)/actions';

/**
 * Panelin sağ üstündeki dil seçimi. Değişince sunucu işlemi dil çerezini yazar ve kullanıcının dilini kaydeder
 * (kayıt değiştiren istek GET ile yapılmaz — SEC-15), ardından aynı sayfa yeni dilde açılır.
 */
export function LanguageSelect({ locale, names, title }: { locale: 'ro' | 'tr'; names: { ro: string; tr: string }; title: string }) {
  // Seçimden sonra sayfa yeniden yüklenene kadar kapalı kalır (yarım kalan ikinci seçim olmasın)
  const [busy, setBusy] = useState(false);
  return (
    <select
      className="lang-select"
      aria-label={title}
      title={title}
      value={locale}
      disabled={busy}
      onChange={async (e) => {
        const next = e.target.value;
        setBusy(true);
        try {
          await setLanguageAction(next);
          window.location.reload();
        } catch {
          setBusy(false);
        }
      }}
    >
      <option value="ro" lang="ro">{names.ro}</option>
      <option value="tr" lang="tr">{names.tr}</option>
    </select>
  );
}
