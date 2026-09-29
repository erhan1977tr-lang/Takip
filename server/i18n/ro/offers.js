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
  },
};
