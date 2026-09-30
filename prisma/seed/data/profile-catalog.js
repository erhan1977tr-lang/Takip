// İlk profil kataloğu — ürün sahibinin "Comanda Depozit" formu (Comanda_Depozit.xls, 30.09.2026; tanım §6.3, §33).
// Ön yüze gömülmez: seed ile tabloya yazılır (prisma/seed/steps/profile-catalog.mjs), sonra yönetici ekranından düzenlenir.
// code: kalıcı ürün kodu (değişmez) · name: formdaki ad · image: prisma/seed/data/profile-images/ altındaki başlangıç görseli.
// Liste fiyatları boştur; yönetici Profil Kataloğu'ndan (ya da Excel ile) girer.

export const PROFILE_CATEGORIES = [
  { code: 'GARNITURI', name: { ro: 'Garnituri', tr: 'Contalar' }, sortOrder: 1 },
  { code: 'PLASTICE', name: { ro: 'Plastice', tr: 'Plastikler' }, sortOrder: 2 },
  { code: 'PROFILE_ALUMINIU', name: { ro: 'Profile aluminiu', tr: 'Alüminyum profiller' }, sortOrder: 3 },
  { code: 'ACCESORII', name: { ro: 'Accesorii', tr: 'Aksesuarlar' }, sortOrder: 4 },
];

const rows = (category, unit, list) => list.map(([code, name, image], i) => ({ category, unit, code, name, image: image ?? null, sortOrder: (i + 1) * 10 }));

export const PROFILE_PRODUCTS = [
  ...rows('GARNITURI', 'CUTII', [
    ['GK15', 'GARNITURA EPDM - GK15 (137 ml.)', 'gk15.jpg'],
    ['AD45', 'GARNITURA EPDM - AD45 (24 ml.)', 'ad45.jpg'],
    ['MC12', 'GARNITURA PT MANA CURENTA - MC12 (27 ml.)', 'mc12.jpg'],
    ['MC16', 'GARNITURA PT MANA CURENTA - MC16 (43 ml.)', 'mc16.jpg'],
  ]),
  ...rows('PLASTICE', 'PUNGI', [
    ['PANA-115-12', 'PANA-115-12', 'pana.jpg'],
    ['PANA-115-16', 'PANA-115-16', 'pana.jpg'],
    ['PANA-90-12', 'PANA-90-12', 'pana.jpg'],
    ['PANA-90-16', 'PANA-90-16', 'pana.jpg'],
    ['PANA-L115', 'PANA-L115', 'pana-l.jpg'],
    ['PANA-L90', 'PANA-L90', 'pana-l.jpg'],
  ]),
  ...rows('PROFILE_ALUMINIU', 'BARA', [
    ['MR23-7016', 'MR23 - 7016 (CEL MAI LAT, CU GARNITURA)', 'mr23.jpg'],
    ['MR23-ELX', 'MR23 - ELX (CEL MAI LAT, CU GARNITURA)', 'mr23.jpg'],
    ['RM16-7016', 'RM16 - 7016 (MEDIE, FARA GARNITURA)', 'rm.jpg'],
    ['RM16-ELX', 'RM16 - ELX (MEDIE, FARA GARNITURA)', 'rm.jpg'],
    ['RM12-7016', 'RM12 - 7016 (CEL MAI INGUST, FARA GARNITURA)', 'rm.jpg'],
    ['RM12-ELX', 'RM12 - ELX (CEL MAI INGUST, FARA GARNITURA)', 'rm.jpg'],
    ['FBL115-7016', 'FBL115 - 7016', 'fbl.jpg'],
    ['FBL115-ELX', 'FBL115 - ELX', 'fbl.jpg'],
    ['FBL90-7016', 'FBL90 - 7016', 'fbl.jpg'],
    ['FBL90-ELX', 'FBL90 - ELX', 'fbl.jpg'],
  ]),
  ...rows('ACCESORII', 'BUCATI', [
    ['FLANSA-PERETE-ELX', 'Flansa Perete - ELX', 'flansa.jpg'],
    ['FLANSA-PERETE-7016', 'Flansa Perete - 7016', 'flansa.jpg'],
    ['SPIGOTI', 'SPIGOTI', 'spigoti.jpg'],
    ['COLT-90-12', 'Colt 90-12 (MAI GROS)', 'colt.jpg'],
    ['COLT-90-16', 'Colt 90-16 (MAI SUBTIRE)', 'colt.jpg'],
    ['CAPACE-PROFILE-7016', 'CAPACE PROFILE - 7016'],
    ['CAPACE-PROFILE-ELX', 'CAPACE PROFILE - ELX'],
  ]),
];
