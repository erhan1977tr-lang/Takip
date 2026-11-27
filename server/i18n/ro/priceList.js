// Client: „Lista mea de prețuri” (server/pricing/customer-price-list.js, app/(panel)/fiyat-listem — karar 333).
export default {
  title: 'Lista mea de prețuri',
  intro: 'Prețurile de sticlă stabilite pentru firma dumneavoastră. Sunt afișate doar combinațiile de sticlă care au preț.',
  empty: 'Pentru firma dumneavoastră nu există încă o listă de prețuri. Pentru prețuri, contactați echipa noastră de vânzări.',
  search: 'Caută sticla…',
  noMatch: 'Nicio sticlă nu corespunde căutării.',
  cols: {
    glass: 'Sticlă',
    price: 'Preț ({cur} / m²)',
  },
  note: 'Prețurile sunt pe m² și nu includ TVA. Prețul final al comenzii este cel din oferta trimisă.',
};
