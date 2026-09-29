// Calendarul de încărcări (/yuklemeler). Numele lunilor și ale zilelor vin din lib/format.ts (fmtMonth, weekdayNames).
export default {
  title: 'Încărcări',
  titleCustomer: 'Calendarul meu de încărcări',
  intro: 'Lucrări grupate după ziua de încărcare. Comenzile puse în așteptare nu apar în această listă.',
  introCustomer: 'Ziua în care se încarcă fiecare dintre comenzile dvs. Faceți clic pe o zi pentru a vedea comenzile din ziua respectivă.',
  tabs: {
    calendar: 'Calendar',
    list: 'Listă',
  },
  nav: {
    prev: '‹ Luna anterioară',
    next: 'Luna următoare ›',
    thisMonth: 'Luna aceasta',
    goToDay: 'Mergi la ziua',
    go: 'Mergi',
  },
  // {orders}: „12 comenzi” (numărul îngroșat)
  monthTotal: 'Total lunar: {orders} · {m2} m² · {kg} kg sticlă',
  today: 'azi',
  list: {
    empty: 'Nu există încărcări luna aceasta.',
    cols: {
      day: 'Ziua încărcării',
      orders: 'Comenzi',
      orderList: 'Numere de comandă',
      customers: 'Clienți',
      metraj: 'Metraj',
      glass: 'Sticlă',
      crates: 'Lăzi',
      gross: 'Brut',
    },
  },
  day: {
    title: 'Încărcare: {date}',
    empty: 'Nu există încărcări pentru această zi.',
    stats: {
      orders: 'Comenzi',
      metraj: 'Metraj total',
      glass: 'Bucăți sticlă',
      gross: 'Greutate brută',
      crates: 'Lăzi',
    },
    // {crates}: „2 lăzi”
    estimate: 'Estimare pentru planificare: brut = sticlă {netKg} kg + {crates} × {tare} kg tara (greutatea sticlei per client se împarte la maximum {max} kg pe ladă, cu rotunjire în sus).',
    note: 'Dacă echipa de vânzări a introdus în comandă dimensiunile și greutățile lăzilor, pentru acea comandă se folosesc datele REALE, care au prioritate față de estimare. Greutatea sticlei se calculează din grosimea sticlei din ofertă (2,5 kg/m² pentru fiecare mm).',
    cols: {
      order: 'Comandă',
      customerOrder: 'Client / comandă',
      orders: 'Comenzi',
      glass: 'Sticlă',
      cnc: 'CNC',
      holes: 'Găuri',
      metraj: 'Metraj',
      net: 'Greutate netă',
      crates: 'Lăzi',
      gross: 'Greutate brută',
      amount: 'Valoare ofertă',
    },
    real: 'real',
    estimated: 'estimat',
  },
};
