import type { T, MsgKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { trimPercent } from '@/server/fx/resolve.js';

/** Çözülmüş ya da belgeyle saklanmış kur (server/fx/resolve.js → FxResult ile aynı alanlar) */
export type FxView = {
  policy: string; currency: string; baseRate: string; markupPercent: string | null; finalRate: string;
  source: string; sourceDate: string | Date | null; manual: boolean;
};

const rateText = (v: string) => v.replace('.', ',');

/** Politikanın adı: "Curs BNR + 2%" */
export function fxPolicyLabel(t: T, policy: string | null | undefined, percent: string | null | undefined) {
  if (policy === 'BNR_PLUS_PERCENT' && percent != null) return t('fx.policyWithPercent', { percent: trimPercent(percent).replace('.', ',') });
  const known = ['BT_UNIT_SELL', 'BNR', 'BNR_PLUS_PERCENT'].includes(policy ?? '');
  return known ? t(`fx.policy.${policy}` as MsgKey) : t('fx.unknownPolicy');
}

/**
 * Kurun nereden geldiği: politika, taban kur, yüzde, uygulanan kur, kaynak ve günü. Elle kur ELLE / MANUAL diye işaretlenir.
 * Yalnızca yöneticiye gösterilir (çağıran sayfa yetkiyi denetler).
 */
export function FxInfo({ fx, t }: { fx: FxView; t: T }) {
  const bnr = !fx.manual && (fx.policy === 'BNR' || fx.policy === 'BNR_PLUS_PERCENT');
  const baseKey = fx.source === 'MANUAL' ? 'MANUAL' : bnr ? 'BNR' : 'BT';
  const knownSource = ['BNR', 'MANUAL', 'MANUAL_DAY'].includes(fx.source);
  const money = (v: string) => t('fx.rate', { rate: rateText(v), currency: fx.currency });
  return (
    <table className="kv fx-info">
      <tbody>
        <tr>
          <td>{t('fx.policyLabel')}</td>
          <td>{fxPolicyLabel(t, fx.policy, fx.manual ? null : fx.markupPercent)} {fx.manual && <Badge tone="warn">{t('fx.manualBadge')}</Badge>}</td>
        </tr>
        <tr><td>{t(`fx.row.base.${baseKey}` as MsgKey)}</td><td className="mono">{rateText(fx.baseRate)}</td></tr>
        {bnr && fx.markupPercent != null && <tr><td>{t('fx.row.percent')}</td><td className="mono">{trimPercent(fx.markupPercent).replace('.', ',')}%</td></tr>}
        <tr><td>{t('fx.row.final')}</td><td className="mono"><b>{money(fx.finalRate)}</b></td></tr>
        <tr><td>{t('fx.row.source')}</td><td>{knownSource ? t(`fx.source.${fx.source}` as MsgKey) : fx.source}</td></tr>
        <tr><td>{t('fx.row.sourceDate')}</td><td>{fmtDate(fx.sourceDate)}</td></tr>
      </tbody>
    </table>
  );
}

/** Kur çözülemediğinde: neden ve ne yapılacağı (BT XML kuru asla yerine gösterilmez) */
export function FxUnavailableNote({ code, error, t }: { code: string; error: string; t: T }) {
  const known = ['BT_MANUAL_REQUIRED', 'BNR_UNAVAILABLE'].includes(code);
  return (
    <div className="alert alert-warn fx-unavailable">
      {known ? t(`fx.unavailable.${code}` as MsgKey) : t('fx.unavailable.OTHER', { error })}
      {code === 'BNR_UNAVAILABLE' && <span className="muted small"> ({error})</span>}
    </div>
  );
}
