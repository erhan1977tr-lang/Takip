// ---------------------------------------------------------------------------------------------------------------------
// Korkuluk hesaplayıcısının KESİN teknik kuralları (ürün sahibinin kararı, 09.10.2026 — karar 203). Paket 5'in genel
// yapılandırma modeline (sistem + kalem + koşul + tüketim + paket içeriği) varsayılan olarak yazılır; hesap aynı kuralla
// (server/profile/calculator.js) yapılır. Yazım bir kezdir ve yöneticinin kaydına dokunmaz (server/profile/calc-defaults.js).
//   Müşteri iki AYRI seçim yapar: korkuluk profili (FBL90 / FBL115) ve küpeşte (yok / MR23 / RM29); ikisinin ürünleri birlikte
//   hesaplanır. Cam: 6+6 (12,76 mm) / 8+8 (16,76 mm). Renk: 7016 MAT (RAL7016) / Eloxat (ELOXAT).
//   Profiller 6 m'lik boydur: boy = yukarı yuvarla(metre / 6) — FBL90, FBL115, MR23, RM12, RM16 (katalogda "-7016" / "-ELX").
//   FBL aksesuar poşeti: her FBL boyu için 1 poşet "L" pana + 1 poşet cam kalınlığına göre pana (ürün sahibinin kararı:
//   "L90/90-12" = PANA-L90 + PANA-90-12) → poşetin "paket içeriği" bir boya (6 m) yeter: poşet = yukarı yuvarla(metre / 6).
//   MR23 contası: 1 m korkuluk = 1 m conta; MC12 27 m / kutu (6+6), MC16 43 m / kutu (8+8). RM29: 6+6 → RM12, 8+8 → RM16,
//   conta yok. GK15 / AD45 için sistem ilişkisi tanımlanmadı: bu hesaplayıcıya eklenmez.
// ---------------------------------------------------------------------------------------------------------------------

/** Varsayılan cam kalınlıkları: mm (benzersiz) + müşteriye görünen ad */
export const RAILING_THICKNESSES = Object.freeze([
  Object.freeze({ key: 'G12', mm: '12.76', label: '6+6' }),
  Object.freeze({ key: 'G16', mm: '16.76', label: '8+8' }),
]);

/** 6 m'lik profil boyu ve FBL poşetleri: paket içeriği (yalnızca boşsa yazılır) + beklenen satış birimi */
export const RAILING_PACKS = Object.freeze([
  ...['FBL90-7016', 'FBL90-ELX', 'FBL115-7016', 'FBL115-ELX', 'MR23-7016', 'MR23-ELX', 'RM12-7016', 'RM12-ELX', 'RM16-7016', 'RM16-ELX']
    .map((code) => Object.freeze({ code, content: '6', measure: 'M', unit: 'BARA' })),
  ...['PANA-L90', 'PANA-L115', 'PANA-90-12', 'PANA-90-16', 'PANA-115-12', 'PANA-115-16']
    .map((code) => Object.freeze({ code, content: '6', measure: 'M', unit: 'PUNGI' })),
  // Contalar: kutu içeriği ayrıca PACK_CONTENTS'ten de yazılır; burada yalnızca birim denetimi için
  Object.freeze({ code: 'MC12', content: '27', measure: 'M', unit: 'CUTII' }),
  Object.freeze({ code: 'MC16', content: '43', measure: 'M', unit: 'CUTII' }),
]);

const colorRows = (slot, base) => [
  { slot, product: `${base}-7016`, color: 'RAL7016', thickness: null, perMeter: '1' },
  { slot, product: `${base}-ELX`, color: 'ELOXAT', thickness: null, perMeter: '1' },
];
const fbl = (n) => Object.freeze({
  code: `FBL${n}`, kind: 'PROFILE', nameTr: `FBL ${n}`, nameRo: `FBL ${n}`,
  items: [
    ...colorRows('Profil', `FBL${n}`),
    { slot: 'Poşet L', product: `PANA-L${n}`, color: null, thickness: null, perMeter: '1' },
    { slot: 'Poşet pană', product: `PANA-${n}-12`, color: null, thickness: 'G12', perMeter: '1' },
    { slot: 'Poşet pană', product: `PANA-${n}-16`, color: null, thickness: 'G16', perMeter: '1' },
  ],
});

/** Varsayılan sistemler (kod benzersiz; aynı kodlu sistem varsa ona dokunulmaz — yalnızca türü boşsa yazılır) */
export const RAILING_SYSTEMS = Object.freeze([
  fbl(90),
  fbl(115),
  Object.freeze({
    code: 'MR23', kind: 'HANDRAIL', nameTr: 'MR23', nameRo: 'MR23',
    items: [
      ...colorRows('Profil', 'MR23'),
      { slot: 'Conta', product: 'MC12', color: null, thickness: 'G12', perMeter: '1' },
      { slot: 'Conta', product: 'MC16', color: null, thickness: 'G16', perMeter: '1' },
    ],
  }),
  Object.freeze({
    code: 'RM29', kind: 'HANDRAIL', nameTr: 'RM29', nameRo: 'RM29',
    items: [
      { slot: 'Profil', product: 'RM12-7016', color: 'RAL7016', thickness: 'G12', perMeter: '1' },
      { slot: 'Profil', product: 'RM12-ELX', color: 'ELOXAT', thickness: 'G12', perMeter: '1' },
      { slot: 'Profil', product: 'RM16-7016', color: 'RAL7016', thickness: 'G16', perMeter: '1' },
      { slot: 'Profil', product: 'RM16-ELX', color: 'ELOXAT', thickness: 'G16', perMeter: '1' },
    ],
  }),
]);

/** Varsayılanların gerektirdiği ürün kodları (katalogda yoksa varsayılan yazılmaz, eksik kod açıkça bildirilir) */
export const RAILING_CODES = Object.freeze([...new Set(RAILING_SYSTEMS.flatMap((s) => s.items.map((i) => i.product)))]);
