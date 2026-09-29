'use client';

/** Panelin sağ üstündeki dil seçimi. Değişince /dil çerezi yazar ve aynı sayfayı yeni dilde açar. */
export function LanguageSelect({ locale, names, title }: { locale: 'ro' | 'tr'; names: { ro: string; tr: string }; title: string }) {
  return (
    <select
      className="lang-select"
      aria-label={title}
      title={title}
      value={locale}
      onChange={(e) => {
        const next = window.location.pathname + window.location.search;
        window.location.assign(`/dil?l=${e.target.value}&next=${encodeURIComponent(next)}`);
      }}
    >
      <option value="ro" lang="ro">{names.ro}</option>
      <option value="tr" lang="tr">{names.tr}</option>
    </select>
  );
}
