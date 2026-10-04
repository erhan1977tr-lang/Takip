import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { customerDocument } from '@/server/documents/customer.js';
import { pdfAccess } from '@/server/documents/pdf-access.js';

export const dynamic = 'force-dynamic';

// GET /belgeler/<belge>/pdf — mali belgenin PDF'i (karar 111).
//   Müşteri (ACCOUNT_SETTINGS — müşteri hesabı): yalnızca KENDİ firmasının belgesi — sahiplik burada, sunucuda yeniden denetlenir;
//   başka firmanın belge kimliği "bulunamadı" döner (listede gizlemek yetmez). Muhasebe yetkisi: her belge.
//   PDF sunucu tarafında alınır (kayıtlı bağlantıdan; gerekirse FGO'dan yenilenir) ve buradan verilir: tarayıcıya FGO
//   anahtarı, hash ya da API parametresi gitmez. FGO sunucudan indirmeye izin vermezse, sahipliği doğrulanmış okuyan
//   belgenin kendi FGO PDF bağlantısına yönlendirilir — yalnızca FGO'nun kendi adresine (fgo.ro; https olması yetmez).
//   Kötüye kullanıma karşı (SEC-09): kullanıcı başına istek sınırı (5 dk'da 30) ve kısa önbellek — aynı belge 5 dk
//   içinde yeniden açılınca FGO'ya gidilmez (server/documents/pdf-access.js). Sahiplik her istekte yeniden denetlenir.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  const { id } = await ctx.params;
  const select = { id: true, series: true, number: true, link: true, kind: true } as const;
  const doc = userCan(user, 'ACCOUNT_SETTINGS')
    ? await customerDocument(db, { docId: id, customerId: user.customerId })
    : userCan(user, 'ACCOUNTING_MANAGE') ? await db.fgoDocument.findUnique({ where: { id }, select }) : null;
  if (!doc) return new Response(t('documents.pdf.notFound'), { status: 404 });
  // Sahiplik doğrulandıktan sonra: kullanıcı başına istek sınırı (önbellekten verilen yanıt da sayılır)
  const rate = pdfAccess.allow(user.id);
  if (!rate.ok) {
    return new Response(t('documents.pdf.tooMany'), { status: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(rate.retryAfterSec) } });
  }
  const pdf = await pdfAccess.get(db, doc);
  await audit('FINANCE_DOC_VIEW', 'FgoDocument', doc.id, user.id, { ref: `${doc.series}${doc.number}`, served: pdf.ok, cached: pdf.cached });
  if (!pdf.ok) {
    // pdf.link yalnızca FGO'nun kendi adresi olabilir (pdfUrl ile doğrulanmış); değilse yönlendirme yok
    if (pdf.link) return new Response(null, { status: 302, headers: { Location: pdf.link, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    return new Response(t('documents.pdf.unavailable'), { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.series}${doc.number}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
