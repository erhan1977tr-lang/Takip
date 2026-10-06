import type { ReactNode } from 'react';
import { pdfUrl } from '@/server/documents/fgo-pdf.js';

/**
 * FGO'daki mali belgeye (proforma / avans faturası / fatura) dış bağlantı — karar 144 (güvenlik denetimi AUD-7).
 * Bağlantı FGO'nun verdiği DIŞ veridir: yalnızca FGO'nun kendi adresiyse (pdfUrl: https, fgo.ro / *.fgo.ro, kullanıcı
 * bilgisi ve özel port yok) tıklanabilir gösterilir. Değilse bağlantı yerine `fallback` yazılır (verilmezse içerik düz
 * metin olarak) — reddedilen adres sayfaya hiç yazılmaz, oraya gidilemez.
 * Mali belge bağlantısı gösteren her yer bunu kullanır; sayfalarda bağlantı doğrudan bir href özniteliğine yazılmaz (test/fgo-links.test.js denetler).
 *   prefix: bağlantıdan önce, yalnızca bağlantı gösteriliyorsa yazılan ayraç (ör. " · ")
 */
export function FgoDocLink({ link, children, fallback, prefix, className }: {
  link: string | null | undefined;
  children: ReactNode;
  fallback?: ReactNode;
  prefix?: ReactNode;
  className?: string;
}) {
  const href = pdfUrl(link);
  if (!href) return <>{fallback === undefined ? children : fallback}</>;
  return <>{prefix}<a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a></>;
}
