// Müşteri: "Fiyat listem" (server/pricing/customer-price-list.js, app/(panel)/fiyat-listem — karar 333).
// Yalnızca firmanın kendi müşteri fiyatları; fabrika / satış fiyatları burada asla yer almaz.
export default {
  title: 'Fiyat listem',
  intro: 'Firmanıza özel cam fiyatları. Yalnızca fiyatı belirlenmiş cam kombinasyonları listelenir.',
  empty: 'Firmanız için henüz tanımlanmış bir fiyat listesi yok. Fiyat için satış ekibimizle iletişime geçebilirsiniz.',
  search: 'Cam ara…',
  noMatch: 'Aramanıza uyan cam yok.',
  cols: {
    glass: 'Cam',
    price: 'Fiyat ({cur} / m²)',
  },
  note: 'Fiyatlar m² başınadır ve KDV (TVA) hariçtir. Siparişinizin kesin fiyatı size gönderilen teklifte yer alır.',
};
