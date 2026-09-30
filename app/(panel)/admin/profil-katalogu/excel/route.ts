import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { XLSX_MIME, writeXlsx } from '@/server/files/xlsx.js';
import { productSheetRows } from '@/server/profile/catalog.js';

export const dynamic = 'force-dynamic';

// Profil kataloğu Excel olarak: aynı dosya düzenlenip "Excel'den yükle" ile geri yüklenebilir.
export async function GET() {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'CATALOG_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const products = await db.profileProduct.findMany({
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { code: 'asc' }], include: { category: { select: { code: true } } },
  });
  const buf = writeXlsx({ sheetName: 'Profil kataloğu', rows: productSheetRows(products), bold: [0, 3], widths: [20, 22, 48, 48, 10, 18, 8] });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), {
    headers: { 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="profil-katalogu-${day}.xlsx"`, 'Cache-Control': 'no-store' },
  });
}
