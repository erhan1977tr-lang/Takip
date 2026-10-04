// Clientul: „Documente financiare” (server/documents/customer.js, app/(panel)/belgeler). Doar documentele emise cu
// succes în FGO; fără contabilitate, fără date interne.
export default {
  title: 'Documente financiare',
  intro: 'Proformele și facturile emise pentru comenzile dvs. Starea plății este cea înregistrată în sistemul de facturare.',
  empty: 'Încă nu există documente emise.',
  cols: {
    kind: 'Tip document',
    number: 'Număr document',
    date: 'Data emiterii',
    orders: 'Comanda / Comenzi',
    total: 'Total',
    currency: 'Monedă',
    payment: 'Status plată',
  },
  kind: {
    PROFORMA: 'Proformă',
    ADVANCE: 'Factură de avans',
    INVOICE: 'Factură',
  },
  payment: {
    UNPAID: 'Neplătit',
    PARTIAL: 'Plătit parțial',
    PAID: 'Plătit',
    UNKNOWN: 'În verificare',
    REPLACED: 'Facturată',
  },
  viewPdf: 'Vezi PDF',
  totalNote: 'Totalurile includ TVA.',
  pdf: {
    notFound: 'Documentul nu a fost găsit.',
    unavailable: 'Documentul nu este disponibil momentan. Vă rugăm să încercați din nou mai târziu.',
    tooMany: 'Prea multe solicitări de documente într-un timp scurt. Vă rugăm să încercați din nou peste câteva minute.',
  },
};
