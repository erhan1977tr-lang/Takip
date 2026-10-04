// Firma kaydının role göre görünümü (ADR 0003; güvenlik denetimi SEC-07, karar 120). TEK kural budur: sipariş
// sayfaları, listeler ve oturum kullanıcısının kendi firması aynı işlevden geçer (lib/orders.ts, lib/auth/session.ts).
// Alanlar sunucuda, veri veritabanından gelir gelmez boşaltılır — "ekranda gösterilmiyor" yeterli değildir: yetkisiz
// role giden hiçbir nesnede (sayfa verisi, RSC yükü, dışa aktarım) bu alanlar bulunmaz.
//
//   Firmaları yöneten (CUSTOMER_MANAGE — yönetici): kaydın tamamı.
//   Diğer HERKES (müşterinin kendi kaydı ve denetimci dahil): INTERNAL alanlar boş — ticari / iç bilgiler:
//     müşteriye özel kur yüzdesi (karar 99: müşteriye hiçbir zaman gösterilmez), fiyat tablosu bağlantıları, iç grup adı.
//   Firma adını göremeyen roller (satış, çizim — CUSTOMER_NAME_VIEW yok): ayrıca ad maskelenir (GLA**********) ve
//     PRIVATE alanlar boş — iletişim, fatura ve kur politikası bilgileri.
import { can } from '../auth/permissions.js';
import { maskName } from './rules.js';

/** Yalnızca firmaları yöneten rolün gördüğü alanlar */
export const INTERNAL_CUSTOMER_FIELDS = ['fxMarkupPercent', 'priceTableId', 'profilePriceTableId', 'groupName'];
/** Firma adını göremeyen rollere (satış, çizim) gitmeyen alanlar */
export const PRIVATE_CUSTOMER_FIELDS = [
  'contactPerson', 'email', 'billingEmail', 'phone', 'address', 'taxId', 'regCom', 'country', 'county', 'city', 'fxPolicy',
];

/**
 * @template {{ name: string }} C
 * @param {string | null | undefined} role
 * @param {C} c
 * @returns {C}
 */
export function customerView(role, c) {
  if (can(role, 'CUSTOMER_MANAGE')) return c;
  /** @type {Record<string, unknown>} */
  const out = { ...c };
  for (const f of INTERNAL_CUSTOMER_FIELDS) if (f in out) out[f] = null;
  if (!can(role, 'CUSTOMER_NAME_VIEW')) {
    out.name = maskName(c.name);
    for (const f of PRIVATE_CUSTOMER_FIELDS) if (f in out) out[f] = null;
  }
  return /** @type {C} */ (out);
}
