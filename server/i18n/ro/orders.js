// Lista de comenzi (/siparisler): vederea clientului și a echipei interne. Calendarul de încărcări folosește și units.
export default {
  // Unități numărate, acordate după număr (one: 1 · few: 0 și 2–19 · other: 20+ → cu „de”). Alegere: Intl.PluralRules.
  units: {
    order: { one: 'comandă', few: 'comenzi', other: 'de comenzi' },
    drawing: { one: 'desen', few: 'desene', other: 'de desene' },
    round: { one: 'rundă', few: 'runde', other: 'de runde' },
    customer: { one: 'client', few: 'clienți', other: 'de clienți' },
    crate: { one: 'ladă', few: 'lăzi', other: 'de lăzi' },
  },
  cols: {
    order: 'Comandă',
    customer: 'Client',
    status: 'Stare',
    drawing: 'Desen',
    offer: 'Ofertă',
    revision: 'Revizie',
    sla: 'SLA',
    ship: 'Încărcare estimată',
    next: 'Pasul următor',
  },
  tabs: {
    active: 'Active',
    work: 'Sarcinile mele',
    all: 'Toate comenzile active',
    archive: 'Încărcate și arhivă',
  },
  customer: {
    title: '{name} — Comenzile mele',
    intro: 'Încărcați datele comenzii și fișierul tehnic; urmăriți aici întregul proces.',
    newOrder: '+ Comandă nouă',
    totalActive: 'Total active',
    searchPlaceholder: 'Caută comanda — denumire, nr. comandă sau numărul dvs.',
    noDate: 'Dată nestabilită',
    empty: {
      search: 'Nicio comandă nu corespunde căutării.',
      archive: 'Nu există comenzi în arhivă.',
      none: 'Nu aveți încă nicio comandă activă. {link}',
      firstOrder: 'Creați prima comandă →',
    },
  },
  internal: {
    titles: {
      drawing: 'Panou desen',
      admin: 'Comenzi',
      sales: 'Panou vânzări',
      inspector: 'Toate comenzile (inspecție)',
    },
    searchPlaceholder: 'Caută nr. comandă / titlu',
    shipGroup: 'Încărcare: {date}',
    // „v2 · 1 rundă”: versiunea desenului · numărul de runde de revizie
    revisions: 'v{v} · {rounds}',
    sections: {
      newOrders: { title: 'Comenzi noi — așteaptă decizia', empty: 'Nicio comandă nu așteaptă decizia.' },
      offersToPrepare: { title: 'Oferte de pregătit', empty: 'Nu există oferte de pregătit.' },
      priceApproval: { title: 'Oferte care așteaptă aprobarea prețului', empty: 'Nicio ofertă nu așteaptă aprobarea.' },
      offerCheck: { title: 'Verificare ofertă — desen revizuit primit după trimitere', empty: 'Nicio ofertă nu așteaptă verificarea.' },
      drawingJobs: { title: 'Lucrări de desen', empty: 'Nu există lucrări de desen în așteptare.' },
      atCustomer: { title: 'La aprobarea clientului', empty: 'Niciun desen nu este la aprobarea clientului.' },
      sla: { title: 'Risc SLA / întârziate', empty: 'Nu există comenzi întârziate.' },
      active: 'Comenzi active',
      archive: 'Încărcate și arhivă',
      none: 'Nu există comenzi.',
    },
  },
};
