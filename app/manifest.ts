import type { MetadataRoute } from 'next';

// "Ana ekrana ekle" (4.2.33, karar 331): simge, ad ve tam ekran açılış. Sayfalar önbelleğe alınmaz (server/push/sw.js).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GKH TAKİP',
    short_name: 'TAKİP',
    description: 'GKH TAKİP',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
