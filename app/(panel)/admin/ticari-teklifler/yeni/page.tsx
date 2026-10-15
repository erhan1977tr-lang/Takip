import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { localDay } from '@/server/profile/dates.js';
import { suggestNo } from '@/server/commercial/service.js';
import { db } from '@/lib/db';
import { offerNoText } from '@/server/commercial/rules.js';
import { OfferEditor } from '../OfferEditor';
import { editorProps, emptyEditorData, errorText } from '../editor-data';

export const dynamic = 'force-dynamic';

/** Teklif oluştur (karar 277): yalnızca COMMERCIAL_OFFER_MANAGE. Kayıt sipariş / FGO / stok yazmaz. */
export default async function NewCommercialOfferPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requirePermission('COMMERCIAL_OFFER_MANAGE');
  const { t, locale, m } = await getT();
  const sp = await searchParams;
  const actor = await actorOf(admin);
  const props = await editorProps(actor, t, locale);
  const next = await suggestNo(db, actor);
  const error = errorText(t, m.commercial, sp.error, sp.row);
  return (
    <>
      <div className="page-head">
        <h1>{t('commercial.title.new')}</h1>
        <p className="muted">{t('commercial.intro')}</p>
        {next.ok && <p className="small muted" data-next-no>{t('commercial.editor.no')}: {offerNoText(next.no)}</p>}
      </div>
      {error && <div className="alert alert-error" role="alert" data-error={sp.error}>{error}</div>}
      <OfferEditor m={m.commercial} locale={locale} mode="new" noEditable readOnly={false} data={emptyEditorData(localDay(new Date(), getEnv().APP_TIMEZONE))}
        {...props} errorSection={sp.section ?? null} errorRow={sp.row ? Number(sp.row) : null} />
    </>
  );
}
