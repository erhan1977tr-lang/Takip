// Lista de oferte (/teklifler): vederea clientului și a echipei interne.
export default {
  customer: {
    title: 'Ofertele mele',
    intro: 'Ofertele pregătite pentru comenzile dvs. Pentru detalii, deschideți comanda.',
    empty: 'Încă nu vi s-a trimis nicio ofertă.',
    cols: {
      order: 'Comandă',
      status: 'Stare comandă',
      date: 'Data ofertei',
      amount: 'Valoare',
    },
    view: 'Vezi oferta',
  },
  // Inspector: doar ofertele trimise clienților
  inspector: {
    title: 'Oferte trimise clienților',
    intro: 'Ofertele trimise clienților, cu valoarea văzută de client. Ofertele în pregătire nu apar aici.',
    empty: 'Nu există oferte trimise clienților.',
    customer: 'Client',
  },
  internal: {
    title: 'Oferte',
    intro: 'Oferte în pregătire, în așteptarea aprobării administratorului și trimise clienților.',
    introSales: 'Ofertele care așteaptă prețul dvs. și comenzile al căror tabel de ofertă nu a fost încă deschis.',
    cols: {
      offer: 'Ofertă',
      customer: 'Client',
      orderStatus: 'Comandă',
      offerStatus: 'Ofertă',
      lines: 'Rânduri',
      ship: 'Livrare',
      amount: 'Valoare vânzare',
      offerAmount: 'Valoare client',
    },
  },
  // Grupate după starea ultimei oferte (HAZIRLANIYOR · YONETIMDE · GONDERILDI)
  groups: {
    sales: { title: 'În pregătire la vânzări', empty: 'Nu există oferte în pregătire.' },
    admin: { title: 'La aprobarea administratorului', empty: 'Nicio ofertă nu așteaptă aprobarea.' },
    customer: { title: 'La client', empty: 'Nu există oferte active trimise clienților.' },
    // Satışın sayfası (karar 155): yalnızca bu iki liste
    awaitingPrice: { title: 'Așteaptă prețul meu', empty: 'Nicio ofertă nu așteaptă prețul dvs.' },
    notOpened: { title: 'Comenzi fără tabel de ofertă deschis', empty: 'Nu există comenzi fără tabel de ofertă deschis.' },
  },
};
