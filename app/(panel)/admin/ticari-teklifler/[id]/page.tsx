import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { loadOffer } from '@/server/commercial/service.js';
import { offerNoText } from '@/server/commercial/rules.js';
import { OfferEditor } from '../OfferEditor';
import { editorData, editorProps, errorText } from '../editor-data';
import { STATUS_TONE } from '../labels';
import { reviseOfferAction, statusOfferAction } from '../actions';

export const dynamic = 'force-dynamic';

const OK = ['created', 'saved', 'issued', 'revised', 'status'] as const;

/**
 * Ticari teklif (karar 277): taslak düzenlenir; kesinleşen sürüm değişmez (yeni sürümle değiştirilir). Kabul / ret yalnızca
 * kayıttır — sipariş oluşturmaz. Maliyet / kâr / marj yalnızca bu ekranda ve iç Excel'de; müşteri PDF'inde yoktur.
 */
export default async function CommercialOfferPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requirePermission('COMMERCIAL_OFFER_MANAGE');
  const { t, locale, m } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const actor = await actorOf(admin);
  const res = await loadOffer(db, id, actor);
  if (!res.ok) notFound();
  const { offer, history } = res;
  const current = offer.versions.find((v) => v.version === offer.currentVersion) ?? offer.versions[0];
  const editable = offer.status === 'TASLAK' && !current.issuedAt;
  const everIssued = offer.versions.some((v) => v.issuedAt);
  const props = await editorProps(actor, t, locale);
  const error = errorText(t, m.commercial, sp.error, sp.row);
  const ok = OK.find((x) => x === sp.ok);
  const base = `/admin/ticari-teklifler/${offer.id}`;
  const canRevise = ['HAZIR', 'RED'].includes(offer.status);
  const canOutcome = offer.status === 'HAZIR';
  const canCancel = ['TASLAK', 'HAZIR'].includes(offer.status);

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('commercial.title.edit', { no: offerNoText(offer.no) })} <Badge tone={STATUS_TONE[offer.status]}>{t(`commercial.status.${offer.status}` as MsgKey)}</Badge></h1>
          <p className="muted">{offer.firmName} · {t('commercial.versions.version')} {offer.currentVersion}</p>
        </div>
        <div className="row">
          <a className="btn" href={`${base}/pdf`} data-pdf>{t('commercial.actions.pdf')}</a>
          <a className="btn" href={`${base}/excel`} data-excel>{t('commercial.actions.excel')}</a>
          <Link className="btn btn-link" href="/admin/ticari-teklifler">{t('commercial.title.list')}</Link>
        </div>
      </div>
      {ok && <div className="alert alert-ok" role="status">{t(`commercial.ok.${ok}` as MsgKey)}</div>}
      {error && <div className="alert alert-error" role="alert" data-error={sp.error}>{error}</div>}
      {offer.statusNote && <div className="alert alert-info">{offer.statusNote}</div>}

      {(canRevise || canOutcome || canCancel) && (
        <div className="card" id="islemler">
          <h2>{t('commercial.actions.title')}</h2>
          {!current.issuedAt && <p className="hint">{t('commercial.actions.draftPdf')}</p>}
          <div className="row">
            {canRevise && (
              <form action={reviseOfferAction}>
                <input type="hidden" name="offerId" value={offer.id} />
                <input type="hidden" name="editVersion" value={offer.editVersion} />
                <button className="btn" type="submit" data-revise>{t('commercial.actions.revise')}</button>
              </form>
            )}
          </div>
          {canOutcome && (
            <>
              <p className="hint">{t('commercial.actions.noOrder')}</p>
              <div className="row">
                {(['KABUL', 'RED'] as const).map((st) => (
                  <form key={st} action={statusOfferAction}>
                    <input type="hidden" name="offerId" value={offer.id} />
                    <input type="hidden" name="editVersion" value={offer.editVersion} />
                    <input type="hidden" name="status" value={st} />
                    <ConfirmButton success={st === 'KABUL'} outline={st === 'RED'} message={t(st === 'KABUL' ? 'commercial.actions.accept' : 'commercial.actions.reject')}>
                      {t(st === 'KABUL' ? 'commercial.actions.accept' : 'commercial.actions.reject')}
                    </ConfirmButton>
                  </form>
                ))}
              </div>
            </>
          )}
          {canCancel && (
            <form action={statusOfferAction} className="approve-box" id="iptal">
              <input type="hidden" name="offerId" value={offer.id} />
              <input type="hidden" name="editVersion" value={offer.editVersion} />
              <input type="hidden" name="status" value="IPTAL" />
              <label htmlFor="co-cancel-note">{t('commercial.actions.reason')}</label>
              <input id="co-cancel-note" name="note" required maxLength={1000} />
              <div className="row" style={{ marginTop: 8 }}>
                <ConfirmButton outline danger message={t('commercial.actions.cancel')}>{t('commercial.actions.cancel')}</ConfirmButton>
              </div>
            </form>
          )}
        </div>
      )}

      <OfferEditor key={`${offer.id}:${offer.editVersion}`} m={m.commercial} locale={locale} mode="edit" offerId={offer.id} editVersion={offer.editVersion}
        version={current.version} noEditable={editable && !everIssued} readOnly={!editable} data={editorData(offer.no, current.data)}
        {...props} errorSection={sp.section ?? null} errorRow={sp.row ? Number(sp.row) : null} />

      <div className="card card-flush" id="surumler">
        <div className="card-head"><h2>{t('commercial.versions.title')}</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('commercial.versions.version')}</th><th>{t('commercial.versions.created')}</th><th>{t('commercial.versions.issued')}</th>
                <th className="num">{t('commercial.versions.total')}</th><th className="num">{t('commercial.versions.cost')}</th><th />
              </tr>
            </thead>
            <tbody>
              {offer.versions.map((v) => (
                <tr key={v.id} data-version={v.version}>
                  <td>
                    {v.version}
                    {v.version === offer.currentVersion && <> <Badge tone="info">{t('commercial.versions.current')}</Badge></>}
                    {!v.issuedAt && <> <Badge tone="muted">{t('commercial.versions.draft')}</Badge></>}
                  </td>
                  <td className="nowrap small">{fmtDateTime(v.createdAt)} · {v.createdBy?.name ?? ''}</td>
                  <td className="nowrap small">{v.issuedAt ? `${fmtDateTime(v.issuedAt)} · ${v.issuedBy?.name ?? ''}` : '—'}</td>
                  <td className="num nowrap">{fmtMoney(v.total.toString())}</td>
                  <td className="num nowrap">{fmtMoney(v.cost.toString())}</td>
                  <td className="nowrap">
                    <a href={`${base}/pdf?v=${v.version}`}>{t('commercial.actions.pdf')}</a>{' · '}
                    <a href={`${base}/excel?v=${v.version}`}>{t('commercial.actions.excel')}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-flush" id="gecmis">
        <div className="card-head"><h2>{t('commercial.history.title')}</h2></div>
        <div className="table-wrap">
          <table>
            <tbody>
              {history.map((h) => {
                const d = (h.details ?? {}) as Record<string, unknown>;
                const label = Object.hasOwn(m.commercial.history, h.action) ? t(`commercial.history.${h.action}` as MsgKey) : h.action;
                const extra = [
                  d.version != null ? `${t('commercial.versions.version')} ${String(d.version)}` : null,
                  typeof d.to === 'string' && Object.hasOwn(m.commercial.status, d.to) ? t(`commercial.status.${d.to}` as MsgKey) : null,
                  typeof d.note === 'string' && d.note ? d.note : null,
                ].filter(Boolean).join(' · ');
                return (
                  <tr key={h.id} data-history={h.action}>
                    <td className="nowrap small">{fmtDateTime(h.createdAt)}</td>
                    <td>{label}{extra && <span className="muted small"> — {extra}</span>}</td>
                    <td className="small">{h.user?.name ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
