import type { T, MsgKey } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';

/** Yükleme düzeltmesinin bir siparişteki finansal etkisi (server/glass/invoice-batch.js → orderImpacts) */
export type Impact = {
  code: string; orderId: string; orderNo: string; ref: string | null; currency: string | null;
  invoiced: { pieces: number; amount: number } | null; effective: { pieces: number; amount: number }; diff: number;
  invoicePaid: boolean; advanceDeducted: boolean;
};
export const ACTION_CODES = ['UNDER_INVOICED', 'OVER_INVOICED'];

/**
 * Finansal etki satırı (karar 105): durum + (fatura varsa) faturadaki ve fiilen yüklenen kapsam. Kesilmiş fatura fiili
 * yüklemeyle uyuşmuyorsa "MUHASEBE İŞLEMİ GEREKLİ" uyarısı — hiçbir belge otomatik kesilmez. Tutarlar yalnızca yöneticiye
 * (çağıran `money` ile belirler).
 */
export function ImpactNote({ x, t, money }: { x: Impact; t: T; money: boolean }) {
  const action = ACTION_CODES.includes(x.code);
  const body = (
    <>
      <b className="mono">{x.orderNo}</b> — {t(`accounting.impact.code.${x.code}` as MsgKey, { ref: x.ref ?? '—' })}
      {money && x.invoiced && x.code !== 'QUEUED_BILLING' && x.code !== 'FAILED_BILLING' && (
        <div className="small">
          {t('accounting.impact.detail', {
            invPieces: x.invoiced.pieces, invAmount: fmtNum(x.invoiced.amount), effPieces: x.effective.pieces, effAmount: fmtNum(x.effective.amount),
            diff: `${x.diff > 0 ? '+' : ''}${fmtNum(x.diff)}`, cur: x.currency ?? '',
          })}
          {action && x.invoicePaid && <> · {t('accounting.impact.paid')}</>}
          {action && x.advanceDeducted && <> · {t('accounting.impact.advance')}</>}
        </div>
      )}
    </>
  );
  if (!action) return <p className="small impact-line" data-impact={x.code}>{body}</p>;
  return (
    <div className="alert alert-error impact-line" data-impact={x.code}>
      <b>{t('accounting.impact.required')}</b> · {body}
      <div className="small">{t('accounting.impact.requiredNote')}</div>
    </div>
  );
}
