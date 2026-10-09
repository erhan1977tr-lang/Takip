import type { MsgKey, T } from '@/lib/i18n';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { ConfirmButton } from '@/components/ConfirmButton';

type Uncertain = { at?: string; kind?: string; error?: string; idExtern?: string; series?: string; expectedGross?: number };
type Job = { id: string; payload: unknown };
const UNC_ERRORS = ['NOT_UNCERTAIN', 'CONFIRM', 'BAD_NUMBER', 'SERIES', 'EXISTS_IN_TAKIP', 'FGO_DISABLED', 'NO_KEY', 'NOT_IN_FGO', 'UNVERIFIED', 'TOTAL_MISMATCH', 'FORBIDDEN', 'NOT_ALLOWED'];
const KINDS = ['PROFORMA', 'ADVANCE', 'INVOICE', 'FGO_PROFORMA', 'FGO_INVOICE'];
const num = (v: string | undefined) => (v != null && /^-?\d{1,12}(\.\d{1,4})?$/.test(v) ? Number(v) : null);

/**
 * Sonucu belirsiz FGO belgesi (Paket 10, karar 209): iş bekletildi, yönetici FGO'ya bakıp karar verir. İki yol:
 *   "FGO'da belge VAR" → seri + numara; FGO'dan doğrulanır, toplamı tutarsa kaydedilir (yeni belge kesilmez)
 *   "FGO'da belge YOK" → açık onayla aynı işi aynı IdExtern ile yeniden gönder ya da vazgeç
 * Sipariş sayfası ve müşteri proforması sayfası aynı kutuyu kullanır (form alanları ve sunucu işlemi çağırandan).
 */
export function UncertainReview({ jobs, t, action, hidden, sp }: {
  jobs: Job[]; t: T; action: (fd: FormData) => Promise<void>; hidden: React.ReactNode; sp: Record<string, string | undefined>;
}) {
  if (!jobs.length && !sp.uncOk && !sp.uncError) return null;
  const err = sp.uncError && UNC_ERRORS.includes(sp.uncError) ? sp.uncError : sp.uncError ? 'NOT_ALLOWED' : null;
  return (
    <div className="fx-block" id="belirsiz" data-uncertain>
      <h3>{t('finance.uncertain.title')}</h3>
      {sp.uncOk && ['RECORD', 'RETRY', 'ABANDON'].includes(sp.uncOk) && <div className="alert alert-ok">{t(`finance.uncertain.ok.${sp.uncOk}` as MsgKey)}</div>}
      {err && (
        <div className="alert alert-error" data-uncertain-error={err}>
          {t(`finance.uncertain.errors.${err}` as MsgKey, { fgo: fmtMoney(num(sp.fgoTotal) ?? 0, 'RON'), expected: fmtMoney(num(sp.expected) ?? 0, 'RON') })}
        </div>
      )}
      {jobs.map((j) => {
        const u = ((j.payload as { uncertain?: Uncertain } | null)?.uncertain ?? {}) as Uncertain;
        const kind = KINDS.includes(u.kind ?? '') ? u.kind! : 'INVOICE';
        return (
          <div key={j.id} className="uncertain-job" data-uncertain-job={j.id}>
            <p style={{ marginTop: 0 }}>
              {t('finance.uncertain.lead', { kind: t(`finance.uncertain.kinds.${kind}` as MsgKey), error: u.error ?? '—', ref: u.idExtern ?? '—' })}
            </p>
            <p className="small muted">
              {t('finance.uncertain.expected', { amount: fmtMoney(u.expectedGross ?? 0, 'RON'), series: u.series ?? '—' })} · {t('finance.uncertain.at', { date: fmtDateTime(u.at) })}
            </p>
            <div className="grid-2">
              <form action={action} data-uncertain-record>
                {hidden}
                <input type="hidden" name="jobId" value={j.id} />
                <input type="hidden" name="do" value="RECORD" />
                <h4>{t('finance.uncertain.recordTitle')}</h4>
                <div className="row">
                  <label htmlFor={`unc-s-${j.id}`} style={{ margin: 0 }}>{t('finance.uncertain.series')}</label>
                  <input id={`unc-s-${j.id}`} name="series" required maxLength={12} defaultValue={u.series ?? ''} style={{ width: 90 }} />
                  <label htmlFor={`unc-n-${j.id}`} style={{ margin: 0 }}>{t('finance.uncertain.number')}</label>
                  <input id={`unc-n-${j.id}`} name="number" required maxLength={20} style={{ width: 120 }} />
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <ConfirmButton primary message={t('finance.uncertain.recordConfirm')}>{t('finance.uncertain.record')}</ConfirmButton>
                </div>
              </form>
              <form action={action} data-uncertain-absent>
                {hidden}
                <input type="hidden" name="jobId" value={j.id} />
                <h4>{t('finance.uncertain.absentTitle')}</h4>
                <label className="check small"><input type="checkbox" name="confirm" value="1" required /> {t('finance.uncertain.confirm')}</label>
                <div className="row" style={{ marginTop: 8 }}>
                  <ConfirmButton outline name="do" value="RETRY" message={t('finance.uncertain.retryConfirm')}>{t('finance.uncertain.retry')}</ConfirmButton>
                  <ConfirmButton outline danger name="do" value="ABANDON" message={t('finance.uncertain.abandonConfirm')}>{t('finance.uncertain.abandon')}</ConfirmButton>
                </div>
              </form>
            </div>
          </div>
        );
      })}
    </div>
  );
}
