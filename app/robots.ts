import type { MetadataRoute } from 'next';

// Özel iş portalı: arama motorları hiçbir sayfayı taramasın. Sayfalarda ayrıca noindex etiketi var,
// Tek istisna herkese açık gizlilik politikası (/privacy): Google OAuth doğrulaması sayfayı okuyabilsin.
// sunucuda Caddy de her yanıta X-Robots-Tag ekler (dosyalar ve /surum dahil).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/privacy', disallow: '/' } };
}
