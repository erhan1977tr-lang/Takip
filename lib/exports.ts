// Dışa aktarma yardımcıları (Paket 7, karar 190–191): bütün Excel / PDF indirmeleri dosya adını, başlık altı satırını ve
// indirme başlıklarını buradan alır — dosya adı seçili panel dilinde ve güvenli karakterlerle (server/files/export-name.js).
import type { T } from './i18n';
import { fmtDateTime } from './format';
import { BRAND } from '../server/branding/index.js';
import { XLSX_MIME } from '../server/files/xlsx.js';
import { contentDisposition, exportFileName } from '../server/files/export-name.js';

export type ExportName = 'loadingSummary' | 'firmLoading' | 'transportList' | 'offer' | 'offerReport' | 'priceTable' | 'glassCatalog' | 'profileCatalog' | 'profileStock';

/** Başlığın altındaki satır: "GKH Trading Invest SRL · <ek> · Oluşturma: 08.10.2026 14:30" */
export function exportSubtitle(t: T, extra?: string | null): string {
  return [BRAND.company, extra, t('exports.generated', { date: fmtDateTime(new Date()) })].filter(Boolean).join(' · ');
}

/** Dosya adı: sözlükteki ad (panel dili) + belgeye özgü parçalar: "Yukleme-Ozeti-2026-10-08.xlsx" */
export function exportName(t: T, name: ExportName, parts: (string | number | null | undefined)[], ext: 'xlsx' | 'pdf'): string {
  return exportFileName(t(`exports.names.${name}`), parts, ext);
}

/** İndirme yanıtının başlıkları (tür, dosya adı, önbelleksiz) */
export function downloadHeaders(name: string, ext: 'xlsx' | 'pdf', { inline = false }: { inline?: boolean } = {}): Record<string, string> {
  return {
    'Content-Type': ext === 'xlsx' ? XLSX_MIME : 'application/pdf',
    'Content-Disposition': contentDisposition(name, { inline }),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
