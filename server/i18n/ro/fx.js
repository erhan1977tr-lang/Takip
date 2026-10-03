// Politica de curs valutar a clientului (Etapa 7D-1): formularul clientului și secțiunea Financiar / FGO
export default {
  title: "Politica curs valutar",
  intro: "Cursul cu care se emit în RON documentele FGO (proformă / factură) pentru ofertele în EUR ale acestui client — comenzi de sticlă și de profile. Documentele deja emise nu se schimbă.",
  policyLabel: "Politică",
  policy: {
    BT_UNIT_SELL: "Curs vânzare BT – în unitățile BT",
    BNR: "Curs BNR",
    BNR_PLUS_PERCENT: "Curs BNR + %",
  },
  policyWithPercent: "Curs BNR + {percent}%",
  percent: "Procent adăugat la cursul BNR (%)",
  percentHint: "Ex.: 2 = 2%. Între 0 și {max}, cel mult 3 zecimale.",
  todayTitle: "Cursul de azi pentru acest client",
  docTitle: "Cursul documentului",
  row: {
    base: { BNR: "Curs BNR", BT: "Curs BT (în unitățile BT)", MANUAL: "Curs introdus manual" },
    percent: "Procent",
    final: "Curs aplicat",
    source: "Sursa",
    sourceDate: "Data cursului",
  },
  rate: "{rate} RON / {currency}",
  source: {
    BNR: "BNR",
    MANUAL: "MANUAL — introdus de administrator pentru acest document",
    MANUAL_DAY: "MANUAL — cursul BT al zilei (Integrări)",
  },
  manualBadge: "MANUAL",
  btAutoNote: "Preluarea automată a cursului BT „În unitățile BT → Vânzare” nu este disponibilă. Se folosește cursul BT al zilei introdus manual în Integrări; cursul din fișierul XML al BT nu se folosește pentru această politică.",
  unavailable: {
    BT_MANUAL_REQUIRED: "Cursul BT „În unitățile BT → Vânzare” nu poate fi preluat automat și cursul de azi nu a fost introdus. Introduceți-l în Integrări → Cursul BT al zilei (manual) sau completați cursul manual la emiterea documentului. Cursul din fișierul XML al BT nu se folosește.",
    BNR_UNAVAILABLE: "Cursul BNR nu a putut fi preluat acum. Documentul așteaptă și se reîncearcă; la emitere puteți completa cursul manual.",
    OTHER: "Cursul nu a putut fi stabilit: {error}",
  },
  integrationsLink: "Integrări → Cursul BT al zilei",
  manualLabel: "Curs manual (opțional)",
  manualHint: "Dacă îl completați, documentul se emite cu acest curs în locul politicii clientului și rămâne marcat MANUAL.",
  unknownPolicy: "—",
  errors: {
    BAD_POLICY: "Politica de curs valutar nu este validă.",
    BAD_PERCENT: "Procentul pentru „Curs BNR + %” trebuie să fie un număr între 0 și 20, cu cel mult 3 zecimale (ex.: 2 sau 2,5).",
  },
};
