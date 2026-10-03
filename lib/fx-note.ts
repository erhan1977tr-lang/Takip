import type { MsgKey, T } from '@/lib/i18n';
import { offerNotePolicy } from '@/server/fx/resolve.js';

/**
 * EUR tekliflerde müşteriye görünen kur notu (teklif ekranı, teklif PDF / Excel, profil sipariş formu): müşterinin kur
 * politikasına göre (karar 99). Müşteriye özel yüzde hiçbir zaman yazılmaz — "BNR + %" yalnızca "sözleşme kuru"dur.
 */
export function fxOfferNote(t: T, policy: string | null | undefined): string {
  return t(`fx.offerNote.${offerNotePolicy(policy)}` as MsgKey);
}
