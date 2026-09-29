import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { XLSX_MIME, writeXlsx } from '@/server/files/xlsx.js';
import { catalogSheetRows } from '@/server/catalog/glass.js';

export const dynamic = 'force-dynamic';

// Cam kataloğu Excel olarak: aynı dosya düzenlenip "Excel'den yükle" ile geri yüklenebilir.
export async function GET() {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'CATALOG_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const glasses = await db.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] });
  const buf = writeXlsx({ sheetName: 'Cam kataloğu', rows: catalogSheetRows(glasses), bold: [0, 3], widths: [36, 20, 40, 20, 36, 20, 16, 8] });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="cam-katalogu-${day}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
