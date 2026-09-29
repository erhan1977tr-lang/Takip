import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { XLSX_MIME, writeXlsx } from '@/server/files/xlsx.js';
import { priceSheetRows } from '@/server/pricing/tables.js';

export const dynamic = 'force-dynamic';

// Fiyat tablosu Excel olarak (ürün sahibinin fiyat listesi düzeni): doldurulup "Excel'den yükle" ile geri yüklenir.
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
  const buf = writeXlsx({ sheetName: 'Fiyatlar', rows: priceSheetRows(table, glasses, prices), bold: [0, 6], widths: [44, 24, 14] });
  const safe = table.name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'fiyat-listesi';
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="${safe}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
