import { LOCALES } from '@/server/i18n/index.js';
import type { Locale } from '@/lib/i18n';

/**
 * Giriş ekranındaki RO | TR düğmeleri. Bağlantı olduğu için JavaScript gerekmez; /dil çerezi yazıp geri döner.
 * next: dönülecek sayfa (sorgu dizesiyle birlikte).
 */
export function LanguageSwitch({ locale, next, title }: { locale: Locale; next: string; title: string }) {
  return (
    <nav className="lang-switch" aria-label={title}>
      {LOCALES.map((l) => (
        <a
          key={l}
          href={`/dil?l=${l}&next=${encodeURIComponent(next)}`}
          className={l === locale ? 'active' : undefined}
          aria-current={l === locale ? 'true' : undefined}
          hrefLang={l}
          lang={l}
        >
          {l.toUpperCase()}
        </a>
      ))}
    </nav>
  );
}
