import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { actorOf } from '@/lib/actor';
import { downloadHeaders, exportName } from '@/lib/exports';
import ro from '@/server/i18n/ro/index.js';
import { offerVersion } from '@/server/commercial/service.js';
import { GKH_CONTACT, customerView, offerNoText } from '@/server/commercial/rules.js';
import { commercialOfferPdf } from '@/server/pdf/commercial-offer.js';

export const dynamic = 'force-dynamic';

// Ticari teklifin MÜŞTERİ PDF'i (karar 277): her zaman Romence; veri YALNIZCA customerView'dan (maliyet, kâr, marj, nakliye /
// gümrük, iç not yok). Yalnızca COMMERCIAL_OFFER_MANAGE; diğer herkese 404 (varlığı da belli olmaz). ?v=<sürüm>
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'COMMERCIAL_OFFER_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const { id } = await ctx.params;
  const v = new URL(req.url).searchParams.get('v');
  const r = await offerVersion(db, { id, version: v }, await actorOf(user));
  if (!r.ok) return new Response(t('common.fileNotFound'), { status: 404 });
  const view = customerView({ no: r.no, version: r.version, data: r.data, draft: r.draft });
  const buf = commercialOfferPdf(view, ro.commercial.pdf, GKH_CONTACT);
  await audit('COMMERCIAL_OFFER_EXPORT', 'CommercialOffer', r.offerId, user.id, { no: offerNoText(r.no), version: r.version, kind: 'PDF', draft: r.draft });
  const name = exportName(t, 'commercialOffer', [offerNoText(r.no), r.version > 1 ? `v${r.version}` : null], 'pdf');
  return new Response(new Uint8Array(buf), { headers: downloadHeaders(name, 'pdf', { inline: true }) });
}
