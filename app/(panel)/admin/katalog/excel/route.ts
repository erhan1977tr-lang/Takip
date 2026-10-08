import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { sheetFromRows, writeReportXlsx } from '@/server/files/xlsx-report.js';
import { catalogSheetRows } from '@/server/catalog/glass.js';

export const dynamic = 'force-dynamic';

// Cam kataloğu Excel olarak: aynı dosya düzenlenip "Excel'den yükle" ile geri yüklenebilir (başlık metinleri ve sütun sırası
// aynı; ortak rapor düzeni — server/files/xlsx-report.js). Dosya adı panel dilinde.
export async function GET() {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'CATALOG_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const glasses = await db.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] });
  const buf = writeReportXlsx({
    sheets: [sheetFromRows({
      name: 'Cam kataloğu', rows: catalogSheetRows(glasses), headerIndex: 3, subtitle: exportSubtitle(t), landscape: true,
      widths: [36, 20, 40, 20, 36, 20, 16, 8], types: ['wrap', 'text', 'wrap', 'text', 'wrap', 'text', 'dec2', 'text'],
    })],
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(exportName(t, 'glassCatalog', [day], 'xlsx'), 'xlsx') });
}
