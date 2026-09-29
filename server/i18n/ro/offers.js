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
      amount: 'Valoare',
    },
  },
  // Grupate după starea ultimei oferte (HAZIRLANIYOR · YONETIMDE · GONDERILDI)
  groups: {
    sales: { title: 'În pregătire la vânzări', empty: 'Nu există oferte în pregătire.' },
    admin: { title: 'La aprobarea administratorului', empty: 'Nicio ofertă nu așteaptă aprobarea.' },
    customer: { title: 'La client', empty: 'Nu există oferte active trimise clienților.' },
  },
};
