// Cam siparişi Finans / FGO bölümü (yönetici)
export default {
  title: "Financiar / FGO",
  none: "Nu există încă documente FGO.",
  rate: "Curs document: {rate} RON / EUR ({date})",
  paidManual: "Plată primită (manual): {amount} · {date}",
  wait: {
    cancelled: "Comandă anulată.",
    done: "Factura a fost emisă; fluxul de documente este complet.",
    pending: "Documentul se emite (în cel mult un minut).",
    no_offer: "Nu există ofertă trimisă clientului; documentul nu poate fi emis.",
    wait_loading: "Factura de avans a fost emisă. După încărcare (la 2 zile după ziua de încărcare) se emite factura.",
    paid_no_advance: "Factura nu poate fi emisă: proforma este plătită, dar nu există factura de avans corespunzătoare. Stornarea nu se face automat în factura finală; mai întâi este necesară o operațiune contabilă (clarificați cu contabilul).",
    wait_payment: "Se așteaptă plata proformei. Dacă încasarea apare în FGO (Contabilitate → Actualizează din FGO) sau introduceți plata mai jos, se poate emite factura de avans.",
  },
  failed: "Nu s-a putut emite în FGO: {error}",
  retry: "Ultima încercare a eșuat ({error}); se reîncearcă.",
  mail: "E-mail către client",
  mailSent: "trimis {date}",
  mailFailed: "netrimis: {error}",
  mailPending: "în așteptare",
  paidLabel: "Suma încasată (RON, cu TVA)",
  button: {
    proforma: "Trimite proformă",
    advance: "Trimite factură de avans",
    invoice: "Trimite factură",
    mark_paid: "Plată primită",
  },
  confirm: {
    proforma: "Emiteți proforma în FGO și o trimiteți clientului pe e-mail?",
    advance: "Emiteți în FGO factura de avans pentru suma încasată și o trimiteți clientului?",
    invoice: "Emiteți factura în FGO și o trimiteți clientului? (Dacă există factură de avans, suma acesteia se scade.)",
  },
  ok: {
    requested: "Cererea a fost primită; documentul se emite în FGO și se trimite clientului.",
    paid: "Plata a fost înregistrată.",
  },
  errors: {
    FGO_DISABLED: "Conexiunea FGO este inactivă sau incompletă (Administrator → Integrări).",
    FGO_DAILY_LIMIT: "Limita zilnică de documente FGO a fost atinsă (Integrări → limită zilnică).",
    BAD_AMOUNT: "Sumă invalidă.",
    NOT_ALLOWED: "Documentul nu poate fi emis acum (există deja sau nu este rândul lui).",
  },
};
