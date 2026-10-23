import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { customerLabel } from '@/lib/orders';
import { salesView } from '@/lib/loading';
import { parseDateOnly } from '@/server/orders/rules.js';
import { transportList } from '@/server/loading/transport.js';
import { transportListPdf } from '@/server/pdf/transport-list.js';
import { downloadHeaders, exportName } from '@/lib/exports';

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
  // Satışçı bölümleri (karar 300): satış kendi bölümünü ve ekip görüntülemesinde (karar 301) aynı geçerli varsayılan
  // çizimciye bağlı ekip arkadaşlarının bölümlerini alır (sunucuda süzülür); yönetici / denetimci tamamını
  const sales = user.appRole === 'SATIS';
  const team = sales ? salesView(user).in : undefined;
  const names = new Map((await db.user.findMany({ where: { appRole: 'SATIS', type: 'INTERNAL', ...(team ? { id: { in: team } } : {}) }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
  const list = await transportList(db, day, {
    label: (name: string) => customerLabel(user, name),
    salesUserId: team,
    teamName: (id: string | null) => (id ? names.get(id) ?? '—' : t('loading.transport.noTeam')),
  });
  const pdf = transportListPdf({
    day, list,
    text: {
      title: t('loading.transport.title'), day: t('loading.transport.day'), colNo: t('loading.transport.colNo'),
      colDims: t('loading.transport.colDims'), colKg: t('loading.transport.colKg'), colNote: t('loading.transport.colNote'),
      subtotal: t('loading.transport.subtotal', { n: '{n}' }), crateCount: t('loading.transport.crateCount'), totalKg: t('loading.transport.totalKg'),
      missing: t('loading.transport.missing'), noPrice: t('loading.transport.noPrice'), empty: t('loading.transport.empty'),
      guest: t('loading.transport.guest'), waiting: t('loading.transport.waiting'),
      teamSubtotal: t('loading.transport.teamSubtotal', { name: '{name}', n: '{n}', kg: '{kg}' }), grandTotal: t('loading.transport.grandTotal'),
    },
  });
  // Dosya adı panel dilinde (Paket 7): "Nakliye-Listesi-2026-10-08.pdf" / "Lista-Transport-2026-10-08.pdf"
  return new Response(new Uint8Array(pdf), { headers: downloadHeaders(exportName(t, 'transportList', [day], 'pdf'), 'pdf') });
}
