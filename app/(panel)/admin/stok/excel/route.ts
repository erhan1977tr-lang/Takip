import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { sheetFromRows, writeReportXlsx } from '@/server/files/xlsx-report.js';
import { STOCK_HEADERS, stockLevels } from '@/server/profile/stock.js';

export const dynamic = 'force-dynamic';

// Stok Excel'i: "Adet" sütunu boş gelir; doldurulup "Excel'den stok" ile yüklenir (giriş ya da sayım). Başlıklar ve sütun sırası
// aynı; ortak rapor düzeni (server/files/xlsx-report.js). Dosya adı panel dilinde.
export async function GET() {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'STOCK_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const [products, levels] = await Promise.all([
    db.profileProduct.findMany({ orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] }),
    stockLevels(db),
  ]);
  const rows = [['PROFİL STOĞU'], [], STOCK_HEADERS, ...products.map((p) => [p.code, p.nameRo, p.unitCode, levels.get(p.id) ?? 0, ''])];
  const buf = writeReportXlsx({
    sheets: [sheetFromRows({ name: 'Stok', rows, headerIndex: 2, subtitle: exportSubtitle(t), widths: [22, 48, 10, 10, 10], types: ['text', 'wrap', 'text', 'int', 'int'] })],
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(exportName(t, 'profileStock', [day], 'xlsx'), 'xlsx') });
}
