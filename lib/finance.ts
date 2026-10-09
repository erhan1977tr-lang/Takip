// Sipariş finansı ekranları için ortak biçimleme (Paket 10). Hesap yok: eşleşmeler server/finance/service.js → advanceRisk /
// recordManualPayment'tan gelir; burada yalnızca okunacak satıra çevrilir (sunucuda — tutar biçimi ve dil sunucuda).
import type { MsgKey, T } from '@/lib/i18n';
import { fmtDate, fmtMoney } from '@/lib/format';

/** Aynı müşteride aynı tutar eşleşmesi (server/finance/service.js → matchView) */
export type MatchView = { key: string; kind: string; ron: number; amount: number | null; currency: string; at: string; ref: string | null; orderNo: string | null };

const KINDS = ['PAYMENT', 'ADVANCE', 'ADVANCE_PENDING'];

/** Eşleşmeler → "Elle ödeme · ref · sipariş · tarih · tutar" satırları */
export function matchLines(t: T, matches: MatchView[]): string[] {
  return matches.map((x) => t('finance.dup.line', {
    kind: t(`finance.dup.kind.${KINDS.includes(x.kind) ? x.kind : 'PAYMENT'}` as MsgKey),
    ref: x.ref ?? '—',
    orderNo: x.orderNo ?? '—',
    date: fmtDate(x.at),
    amount: x.kind === 'PAYMENT' && x.amount != null && x.currency !== 'RON' ? `${fmtMoney(x.amount, x.currency)} (${fmtMoney(x.ron, 'RON')})` : fmtMoney(x.ron, 'RON'),
  }));
}

/** Eşleşme kutusunun metinleri (sunucu ve istemci bileşeni aynı kutuyu çizer) */
export const dupTexts = (t: T) => ({ title: t('finance.dup.title'), lead: t('finance.dup.lead'), ack: t('finance.dup.ack') });
