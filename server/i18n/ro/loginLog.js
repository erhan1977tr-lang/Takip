// Setări → Jurnal de autentificare (Paket A, karar 223) — doar administratorul
export default {
  title: 'Jurnal de autentificare',
  intro: 'Autentificări reușite și eșuate: utilizator, rol, dată / oră, IP. Înregistrările se păstrează {days} de zile, apoi se șterg automat. Parola, codul și adresa de e-mail încercată nu se înregistrează.',
  listTitle: 'Înregistrări de autentificare — pagina {page}',
  empty: 'Nicio înregistrare pentru acest filtru.',
  unknown: 'Cont necunoscut',
  success: 'Reușită',
  failure: 'Eșuată',
  locked: 'blocare pornită',
  prev: '‹ Anterior',
  next: 'Următor ›',
  kind: {
    LOGIN: 'Autentificare (parolă)',
    CODE: 'Cod de verificare',
    SETUP: 'Prima autentificare (parolă setată)',
  },
  col: { time: 'Dată / oră', user: 'Utilizator', role: 'Rol', kind: 'Tip', result: 'Rezultat', ip: 'IP' },
  filter: {
    user: 'Utilizator', role: 'Rol', result: 'Rezultat', kind: 'Tip', from: 'De la', to: 'Până la', ip: 'Adresă IP',
    all: 'Toate', apply: 'Filtrează', clear: 'Șterge filtrele',
  },
};
