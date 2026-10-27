// Notificări prin e-mail (server/notifications/email.js). Numele operației vine din textele events.<EVENIMENT>.
export default {
  orderNo: 'Nr. comandă',
  customer: 'Firmă',
  action: 'Operație',
  date: 'Data',
  revisionNote: 'Nota de revizie',
  drawingVersion: 'Versiunea desenului',
  offerVersion: 'Versiunea ofertei',
  changeNote: 'Nota clientului',
  changeTranslation: 'Traducere în turcă (automată)',
  shipDate: 'Data estimată de încărcare',
  deliveryDay: 'Data estimată de livrare (ridicare)',
  deliveryNote: 'Data este estimativă: se calculează după zilele lucrătoare ale depozitului și regula orei 12:00, fără a ține cont de stoc.',
  newOrder: 'Comandă nouă',
  open: 'Deschide comanda',
  footer: 'Acest e-mail a fost trimis automat de portalul Takip (GKH Trading Invest SRL). Pentru a deschide linkul trebuie să vă autentificați.',
  // E-mailurile administratorului (Pachetul 1 al panoului de administrare, decizia 218): descrierea evenimentului — fără sume
  description: 'Descriere',
  // Aprobarea producției de către client (4.2.1): e-mailul „oferta a fost trimisă / actualizată” (în limba clientului)
  approval: {
    deadline: 'Termen de aprobare',
    roTime: 'ora României',
    noDeadline: 'Nu a putut fi stabilit — vă rugăm să contactați GKH',
    text: 'Vă rugăm să verificați tipurile de sticlă, dimensiunile, cantitățile și prețurile din ofertă. Aprobarea dvs. este obligatorie pentru intrarea comenzii în producție. Termenul de aprobare este de 2 zile lucrătoare (România) de la transmiterea acestei notificări (termenul de mai sus). Întârzierea aprobării poate afecta data de încărcare planificată. Deschideți comanda pentru a aproba sau pentru a semnala modificări de dimensiuni.',
  },
  admin: {
    priceOverride: 'Vânzările au modificat prețul fabricii',
    // {n}: numărul de rânduri cu preț diferit de tabelul de prețuri al fabricii
    priceOverrideDetail: 'Vânzările au trimis oferta administratorului cu un preț diferit de tabelul de prețuri al fabricii pe {n} rânduri. Detalii în „Decizii importante”.',
    withdrawnDetail: 'Oferta este din nou la vânzări și a ieșit din lista celor care așteaptă aprobarea prețului. Revine când vânzările o retrimit.',
    compensation: {
      free: 'Sticlă de compensare deschisă gratuit',
      custom: 'Preț diferit ales pentru sticla de compensare',
    },
    // {qty}: cantitatea de compensare · {source}: nr. comenzii sursă
    compensationDetail: '{qty} buc. sticlă de compensare · comanda sursă {source}.',
    compensationPending: 'Prețul clientului așteaptă aprobarea administratorului.',
  },
};
