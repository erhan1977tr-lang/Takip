// Comandă nouă (/siparisler/yeni). form: partea trimisă componentei client (NewOrderForm) · errors: mesajele acțiunii de server.
export default {
  title: 'Comandă nouă',
  back: '← Comenzile mele',
  // Alegerea tipului de comandă (când sunt active mai multe tipuri)
  selector: {
    title: 'Ce doriți să comandați?',
    intro: 'Alegeți tipul comenzii.',
    choose: 'Alege',
    desc: {
      GLASS_ORDER: 'Sticlă pe măsură: fișier tehnic, aprobarea desenului și ofertă.',
      PROFILE_ORDER: 'Din depozit: garnituri, plastice, profile aluminiu și accesorii.',
    },
  },
  form: {
    info: {
      title: 'Datele comenzii',
      shipNote: 'Comenzile se încarcă săptămânal. Data estimată de încărcare a acestei comenzi va fi {date}; echipa de vânzări o actualizează dacă este necesar.',
      name: 'Denumirea comenzii',
      namePlaceholder: 'ex. Sticlă pentru cabină de duș',
      number: 'Numărul dvs. de comandă',
      numberHint: 'Număr propus (următorul după ultima dvs. comandă) — îl puteți modifica. Cod comandă: {code}',
    },
    files: {
      title: 'Fișierele comenzii (obligatoriu)',
      selected: 'Fișiere selectate: {n}',
      pick: 'Faceți clic pentru a selecta fișierele',
      limits: 'PDF · DWG · DXF · STEP · STP · IGS · IGES · XLS · XLSX · DOC · DOCX · ZIP · JPG · PNG — maximum 100 MB per fișier, 250 MB în total',
    },
    glass: {
      title: 'Combinația de sticlă dorită (obligatoriu)',
      intro: 'Selectați din catalog sticla dorită. Dimensiunile și prețul vor fi completate de echipa de vânzări.',
      catalogEmpty: 'Catalogul de sticlă este încă gol. Vă rugăm să contactați administratorul.',
      glass: 'Sticlă',
      pick: '— selectați din catalog —',
      qty: 'Bucăți',
      remove: 'Elimină',
      add: '+ Adaugă sticlă',
    },
    submit: {
      needFile: 'Pentru a trimite comanda, încărcați cel puțin un fișier.',
      needGlass: 'Selectați o combinație de sticlă.',
      sending: 'Se trimite…',
      send: 'Trimite comanda',
    },
  },
  errors: {
    noFirm: 'Contul dvs. nu este asociat unei firme client. Contactați administratorul.',
    titleRequired: 'Denumirea comenzii este obligatorie.',
    badNumber: 'Numărul comenzii trebuie să fie un număr întreg pozitiv.',
    noFiles: 'Încărcați cel puțin un fișier al comenzii.',
    tooManyFiles: 'Puteți încărca cel mult 20 de fișiere odată.',
    noGlass: 'Selectați cel puțin o combinație de sticlă.',
    glassGone: 'Una dintre sticlele selectate nu mai există în catalog; reîncărcați pagina și selectați din nou.',
    badQty: 'Numărul de bucăți de sticlă trebuie să fie un număr întreg pozitiv.',
    duplicate: 'Există deja o comandă cu numărul {orderNo}; introduceți un alt număr.',
    saveFailed: 'Comanda nu a putut fi salvată; vă rugăm să încercați din nou.',
  },
};
