import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { sheetFromRows, writeReportXlsx } from '@/server/files/xlsx-report.js';
import { priceSheetRows } from '@/server/pricing/tables.js';

export const dynamic = 'force-dynamic';

// Fiyat tablosu Excel olarak (ürün sahibinin fiyat listesi düzeni): doldurulup "Excel'den yükle" ile geri yüklenir (para birimi,
// delik / CNC fiyatı satırları ve başlıklar aynı; ortak rapor düzeni — server/files/xlsx-report.js). Dosya adı panel dilinde,
// tablonun adıyla.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'PRICE_TABLE_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const id = new URL(req.url).searchParams.get('tablo') ?? '';
  const table = await db.priceTable.findUnique({ where: { id }, include: { items: true } });
  if (!table) return new Response(t('common.fileNotFound'), { status: 404 });
  const glasses = await db.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] });
  const prices = new Map(table.items.map((i) => [i.glassProductId, Number(i.unitPrice)]));
  const buf = writeReportXlsx({
    sheets: [sheetFromRows({
      name: 'Fiyatlar', rows: priceSheetRows(table, glasses, prices), headerIndex: 6, subtitle: exportSubtitle(t),
      widths: [44, 24, 16], types: ['wrap', 'text', 'dec2'],
    })],
  });
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(exportName(t, 'priceTable', [table.name], 'xlsx'), 'xlsx') });
}
