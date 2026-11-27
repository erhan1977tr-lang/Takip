// Müşteri: "Fiyat listem" (4.3.0, karar 333) — firmanın KENDİ müşteri fiyat tablosu, salt okunur.
//
// Kaynak: firmaya bağlı müşteri fiyat tablosu (Customer.priceTableId → PriceTable kind CUSTOMER, aktif) — teklif
// hazırlanırken müşteri fiyatlarını dolduran aynı tablo (pricingForCustomer). Yalnızca fiyatı DOLU (> 0) ve katalogda
// aktif olan cam kombinasyonları listelenir; delik / CNC sabit fiyatları ve profil fiyatları bu listede yoktur.
//
// Gizlilik (ürün sahibi: "KESİNLİKLE fabrika satış fiyatları görünmeyecek", "her müşterinin fiyatları ayrı"):
//   - Firma kimliği YALNIZCA oturumdan gelir (çağıran user.customerId verir); istek / adres / form değeri kullanılmaz.
//   - Tablo tek sorguyla, sorgu KOŞULU olarak seçilir: kind = 'CUSTOMER' + aktif + bu firmaya bağlı. Satışçı / fabrika
//     tabloları (kind SALES) bu sorguyla asla okunmaz — firmaya yanlışlıkla SALES tablosu bağlanmış olsa bile liste boş
//     döner. Sonuç ayrıca kind'e göre yeniden denetlenir.
//   - Dönen veride tablo kimliği, tablo adı, cam kimliği, ağırlık, satış fiyatı, maliyet yoktur: yalnızca cam adı /
//     rengi (kullanıcının dilinde), m² fiyatı ve para birimi.
import { glassLabel } from '../catalog/glass.js';

export const PRICE_LIST_MAX_ROWS = 2000;

/**
 * Sorgu koşulu: bu firmaya bağlı, aktif MÜŞTERİ fiyat tablosu. Başka hiçbir tablo türü eşleşmez.
 * @param {string} customerId
 */
export const ownCustomerTableWhere = (customerId) => ({
  kind: 'CUSTOMER',
  isActive: true,
  customers: { some: { id: customerId } },
});

/**
 * Firmanın fiyat listesi.
 * @param {any} db
 * @param {string | null | undefined} customerId  oturumdaki kullanıcının firması
 * @param {'tr' | 'ro'} locale
 * @returns {Promise<{ currency: string | null, rows: { name: string, color: string, label: string, price: number }[] }>}
 */
export async function customerPriceList(db, customerId, locale) {
  const empty = { currency: null, rows: [] };
  if (typeof customerId !== 'string' || !customerId) return empty;
  const table = await db.priceTable.findFirst({
    where: ownCustomerTableWhere(customerId),
    select: {
      kind: true,
      currency: true,
      items: {
        where: { unitPrice: { gt: 0 }, glassProduct: { isActive: true } },
        select: {
          unitPrice: true,
          glassProduct: { select: { nameTr: true, colorTr: true, nameRo: true, colorRo: true, sortOrder: true, isActive: true } },
        },
        take: PRICE_LIST_MAX_ROWS,
      },
    },
  });
  // İkinci kilit: sorgu koşuluna rağmen müşteri tablosu değilse hiçbir şey gösterilmez
  if (!table || table.kind !== 'CUSTOMER') return empty;
  const lang = locale === 'tr' ? 'tr' : 'ro';
  const rows = table.items
    .map((it) => {
      const g = it.glassProduct;
      const price = Number(it.unitPrice);
      if (!g || g.isActive === false || !Number.isFinite(price) || price <= 0) return null;
      const name = lang === 'tr' ? g.nameTr : g.nameRo || g.nameTr;
      const color = (lang === 'tr' ? g.colorTr : g.colorRo || g.colorTr) || '';
      return { name, color, label: glassLabel(g, lang), price, sort: g.sortOrder ?? 0 };
    })
    .filter((r) => r != null)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, lang) || a.color.localeCompare(b.color, lang))
    .map(({ sort: _sort, ...r }) => r);
  return { currency: rows.length ? table.currency : null, rows };
}
