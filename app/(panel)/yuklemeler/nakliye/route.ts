import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { customerLabel } from '@/lib/orders';
import { parseDateOnly } from '@/server/orders/rules.js';
import { transportList } from '@/server/loading/transport.js';
import { transportListPdf } from '@/server/pdf/transport-list.js';

export const dynamic = 'force-dynamic';

// GET /yuklemeler/nakliye?gun=YYYY-MM-DD — seçilen yükleme gününün nakliye listesi (PDF). Yönetici, satış ve
// denetimci (TRANSPORT_LIST_VIEW); müşteri erişemez. Veri: Crate + o günün CAM siparişleri (server/loading/transport.js).
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'TRANSPORT_LIST_VIEW')) return new Response(t('common.fileNotFound'), { status: 403 });
  const day = new URL(req.url).searchParams.get('gun') ?? '';
  if (!parseDateOnly(day)) return new Response(t('loading.transport.badDay'), { status: 400 });
  // Misafir yükün firma adı görene göre (satışa maskeli — karar 7); ağırlık ve gruplar değişmez
  const list = await transportList(db, day, { label: (name: string) => customerLabel(user, name) });
  const pdf = transportListPdf({
    day, list, company: 'GKH Trading',
    text: {
      title: t('loading.transport.title'), day: t('loading.transport.day'), colNo: t('loading.transport.colNo'),
      colDims: t('loading.transport.colDims'), colKg: t('loading.transport.colKg'), colNote: t('loading.transport.colNote'),
      subtotal: t('loading.transport.subtotal', { n: '{n}' }), crateCount: t('loading.transport.crateCount'), totalKg: t('loading.transport.totalKg'),
      missing: t('loading.transport.missing'), noPrice: t('loading.transport.noPrice'), empty: t('loading.transport.empty'),
      guest: t('loading.transport.guest'), waiting: t('loading.transport.waiting'),
    },
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="nakliye-${day}.pdf"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
