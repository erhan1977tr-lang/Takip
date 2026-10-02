import type { Metadata, Viewport } from 'next';
import { getLocale, getT } from '@/lib/i18n';
// Inter (eski TAKİP'in yazı tipi): paketten, kendi sunucumuzdan sunulur — dış adrese istek yok. Yoksa sistem yazı tipi.
import '@fontsource-variable/inter';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: t('common.appTitle'),
    description: t('common.appDescription'),
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Sayfa dili: tarayıcının otomatik çeviri önermemesi ve ekran okuyucular için doğru dil
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
