import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type MsgKey } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { actorOf } from '@/lib/actor';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { writeReportXlsx } from '@/server/files/xlsx-report.js';
import { offerVersion } from '@/server/commercial/service.js';
import { offerNoText } from '@/server/commercial/rules.js';
import { internalSheets } from '@/server/commercial/export.js';

export const dynamic = 'force-dynamic';

// Ticari teklifin İÇ Excel'i (karar 277): satış + iç maliyet + kâr + marj — yalnızca COMMERCIAL_OFFER_MANAGE; diğer herkese
// 404. Panel dilinde. ?v=<sürüm>
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { t, locale } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'COMMERCIAL_OFFER_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const { id } = await ctx.params;
  const v = new URL(req.url).searchParams.get('v');
  const r = await offerVersion(db, { id, version: v }, await actorOf(user));
  if (!r.ok) return new Response(t('common.fileNotFound'), { status: 404 });
  const tt = (key: string, params?: Record<string, unknown>) => t(key as MsgKey, params as Record<string, string | number>);
  const sheets = internalSheets({ no: r.no, version: r.version, status: r.status, draft: r.draft, data: r.data }, tt, {
    statusText: t(`commercial.status.${r.status}` as MsgKey), locale, subtitle: exportSubtitle(t),
  });
  const buf = writeReportXlsx({ sheets });
  await audit('COMMERCIAL_OFFER_EXPORT', 'CommercialOffer', r.offerId, user.id, { no: offerNoText(r.no), version: r.version, kind: 'XLSX', draft: r.draft });
  const name = exportName(t, 'commercialOfferInternal', [offerNoText(r.no), `v${r.version}`], 'xlsx');
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(name, 'xlsx') });
}
