import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { sheetFromRows, writeReportXlsx } from '@/server/files/xlsx-report.js';
import { productSheetRows } from '@/server/profile/catalog.js';

export const dynamic = 'force-dynamic';

// Profil kataloğu Excel olarak: aynı dosya düzenlenip "Excel'den yükle" ile geri yüklenebilir (başlık metinleri ve sütun sırası
// aynı; ortak rapor düzeni — server/files/xlsx-report.js). Dosya adı panel dilinde.
export async function GET() {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'CATALOG_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const products = await db.profileProduct.findMany({
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { code: 'asc' }], include: { category: { select: { code: true } } },
  });
  const buf = writeReportXlsx({
    sheets: [sheetFromRows({
      name: 'Profil kataloğu', rows: productSheetRows(products), headerIndex: 3, subtitle: exportSubtitle(t), landscape: true,
      widths: [20, 22, 48, 48, 10, 18, 8], types: ['text', 'text', 'wrap', 'wrap', 'text', 'dec2', 'text'],
    })],
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(exportName(t, 'profileCatalog', [day], 'xlsx'), 'xlsx') });
}
