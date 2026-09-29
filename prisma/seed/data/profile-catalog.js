// İlk profil kataloğu — "Comanda Depozit" formu, 25.09.2025 (tanım §6.3, §33).
// Ön yüze gömülmez: Aşama 6'da tabloya seed edilir, sonra yönetici ekranından düzenlenir.
// code: kalıcı ürün kodu (değişmez); name: formdaki ad; görseller yöneticiden yüklenir.

export const PROFILE_CATEGORIES = [
  { code: 'GARNITURI', name: { ro: 'Garnituri', tr: 'Contalar' }, sortOrder: 1 },
  { code: 'PLASTICE', name: { ro: 'Plastice', tr: 'Plastikler' }, sortOrder: 2 },
  { code: 'PROFILE_ALUMINIU', name: { ro: 'Profile aluminiu', tr: 'Alüminyum profiller' }, sortOrder: 3 },
  { code: 'ACCESORII', name: { ro: 'Accesorii', tr: 'Aksesuarlar' }, sortOrder: 4 },
];

const rows = (category, unit, list) => list.map(([code, name], i) => ({ category, unit, code, name, sortOrder: i + 1 }));

export const PROFILE_PRODUCTS = [
  ...rows('GARNITURI', 'CUTII', [
    ['GK15', 'GARNITURA EPDM - GK15'],
    ['AD45', 'GARNITURA EPDM - AD45'],
    ['MC12', 'GARNITURA PT MANA CURENTA - MC12'],
    ['MC16', 'GARNITURA PT MANA CURENTA - MC16'],
  ]),
  ...rows('PLASTICE', 'PUNGI', [
    ['PANA-115-12', 'PANA-115-12'],
    ['PANA-115-16', 'PANA-115-16'],
    ['PANA-90-12', 'PANA-90-12'],
    ['PANA-90-16', 'PANA-90-16'],
    ['PANA-L115', 'PANA-L115'],
    ['PANA-L90', 'PANA-L90'],
  ]),
  ...rows('PROFILE_ALUMINIU', 'BARA', [
    ['MR23-7016', 'MR23 - 7016'],
    ['MR23-ELX', 'MR23 - ELX'],
    ['RM16-7016', 'RM16 - 7016'],
    ['RM16-ELX', 'RM16 - ELX'],
    ['RM12-7016', 'RM12 - 7016'],
    ['RM12-ELX', 'RM12 - ELX'],
    ['FBL115-7016', 'FBL115 - 7016'],
    ['FBL115-ELX', 'FBL115 - ELX'],
    ['FBL90-7016', 'FBL90 - 7016'],
    ['FBL90-ELX', 'FBL90 - ELX'],
  ]),
  ...rows('ACCESORII', 'BUCATI', [
    ['FLANSA-PERETE-ELX', 'Flansa Perete - ELX'],
    ['FLANSA-PERETE-7016', 'Flansa Perete - 7016'],
    ['SPIGOTI', 'SPIGOTI'],
    ['COLT-90-12', 'Colt 90-12 (MAI GROS)'],
    ['COLT-90-16', 'Colt 90-16 (MAI SUBTIRE)'],
    ['CAPACE-PROFILE-7016', 'CAPACE PROFILE - 7016'],
    ['CAPACE-PROFILE-ELX', 'CAPACE PROFILE - ELX'],
  ]),
];
