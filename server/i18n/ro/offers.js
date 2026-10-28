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
    introSales: 'Ofertele pentru care clientul a cerut revizuire, ofertele care așteaptă prețul dvs. și comenzile al căror tabel de ofertă nu a fost încă deschis.',
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
  // Lista vânzărilor „Oferte în așteptarea revizuirii cerute de client” (4.2.10, decizia 306)
  revision: {
    cols: {
      requested: 'Data cererii',
      note: 'Nota clientului',
      version: 'Versiune',
      draft: 'Revizie',
    },
    versionOf: 'Versiunea {n}',
    stage: {
      SALES: 'Ciornă la vânzări',
      NO_DRAFT: 'Ciorna nu a fost deschisă',
    },
    open: 'Deschide și editează',
  },
  // Grupate după starea ultimei oferte (HAZIRLANIYOR · YONETIMDE · GONDERILDI)
  groups: {
    sales: { title: 'În pregătire la vânzări', empty: 'Nu există oferte în pregătire.' },
    admin: { title: 'La aprobarea administratorului', empty: 'Nicio ofertă nu așteaptă aprobarea.' },
    customer: { title: 'La client', empty: 'Nu există oferte active trimise clienților.' },
    // Satışın sayfası (karar 155; 4.2.10 — karar 306): bu üç liste
    customerRevision: { title: 'Oferte în așteptarea revizuirii cerute de client', empty: 'Nicio ofertă nu așteaptă revizuirea cerută de client.' },
    awaitingPrice: { title: 'Așteaptă prețul meu', empty: 'Nicio ofertă nu așteaptă prețul dvs.' },
    notOpened: { title: 'Comenzi fără tabel de ofertă deschis', empty: 'Nu există comenzi fără tabel de ofertă deschis.' },
  },
  // Pagina principală a clientului → „Ofertele mele” (decizia 164): interval de date, listă și raport PDF
  report: {
    title: 'Ofertele mele',
    intro: 'Alegeți intervalul: „Afișează” listează ofertele de sticlă trimise firmei dvs. în acest interval (ultima ofertă a fiecărei comenzi), grupate după ziua de încărcare; „Descarcă PDF” descarcă aceeași listă cu fiecare comandă în detaliu.',
    from: 'Data de început',
    to: 'Data de sfârșit',
    show: 'Afișează',
    pdf: 'Descarcă PDF',
    empty: 'Nu există oferte în acest interval.',
    cols: { order: 'Comanda', date: 'Data ofertei', m2: 'm²', pieces: 'Bucăți sticlă', amount: 'Valoarea ofertei' },
    total: 'Total',
    count: 'Comenzi: {n}',
    pieces: '{n} buc.',
    more: 'Lista arată primele {n} oferte; PDF-ul le conține pe toate.',
    pdfTitle: 'OFERTELE MELE',
    generated: 'Generat: {date}',
    version: 'versiunea {n}',
    subtotal: 'Total ofertă',
    // Grupuri după ziua de încărcare (Paket B — decizia 226)
    loadingDate: 'Termen',
    noDate: 'Data de încărcare nu este încă stabilită',
    partial: 'Încărcare parțială — partea comenzii din această încărcare',
    partialBadge: 'Parțial',
    continued: 'continuare',
    groupTotal: 'Total încărcare',
    groupShow: 'Afișează',
    groupHide: 'Ascunde',
    um: 'U.M.',
    grandTotal: 'Total general',
    // Rădăcina numelui fișierului PDF (limba panoului): ofertele-mele-2026-10-01_2026-10-31.pdf
    errors: {
      BAD_DATE: 'Alegeți o dată de început și o dată de sfârșit valide.',
      ORDER: 'Data de început nu poate fi după data de sfârșit.',
      TOO_LONG: 'Intervalul poate avea cel mult 400 de zile.',
      TOO_MANY: 'Sunt prea multe oferte în acest interval; restrângeți intervalul.',
    },
  },
};
