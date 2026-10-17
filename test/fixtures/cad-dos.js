// Güvenlik denetimi 3.93.2 Y-2'de kullanılan zararlı DXF örnekleri (karar 289) — küçük, sentetik, müşteri verisi yok.
const dxf = (pairs) => pairs.map(String).join('\n') + '\n';
const entities = (body) => dxf(['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF']);

/** ~100 baytlık ARC: başlangıç açısı çok büyük → eski kodda `while (a1 <= a0) a1 += TAU` sonsuz döngü */
export const hugeArc = (a0 = '1e17', a1 = '0') =>
  entities(['0', 'ARC', '8', '0', '10', '0', '20', '0', '30', '0', '40', '1', '50', a0, '51', a1]);

/** ELLIPSE: bitiş parametresi başlangıçtan çok küçük */
export const hugeEllipse = () =>
  entities(['0', 'ELLIPSE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0', '40', '0.5', '41', '1e17', '42', '0']);

/** HATCH: yay kenarı (tür 2) ve elips yay kenarı (tür 3) çok büyük açıyla */
export const hugeHatch = (edge = 2) =>
  entities([
    '0', 'HATCH', '8', '0', '10', '0', '20', '0', '30', '0', '2', 'SOLID', '70', '1', '71', '0', '91', '1',
    '92', '1', '93', '1', '72', String(edge),
    ...(edge === 2
      ? ['10', '0', '20', '0', '40', '1', '50', '1e17', '51', '0', '73', '1']
      : ['10', '0', '20', '0', '11', '1', '21', '0', '40', '0.5', '50', '1e17', '51', '0', '73', '1']),
    '97', '0', '75', '0', '76', '1', '98', '0',
  ]);

/** İç içe blok bombası: her blok bir sonrakini FAN kez ekler, en içteki boş (çıktı üretmez) → FAN^DERİNLİK genişletme */
export function blockBomb(depth = 16, fan = 10) {
  const L = ['0', 'SECTION', '2', 'BLOCKS'];
  for (let d = 0; d <= depth; d++) {
    L.push('0', 'BLOCK', '8', '0', '2', `B${d}`, '70', '0', '10', '0', '20', '0', '30', '0');
    if (d < depth) for (let k = 0; k < fan; k++) L.push('0', 'INSERT', '8', '0', '2', `B${d + 1}`, '10', String(k), '20', '0', '30', '0');
    L.push('0', 'ENDBLK', '8', '0');
  }
  L.push('0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', '0', '2', 'B0', '10', '0', '20', '0', '30', '0', '0', 'ENDSEC', '0', 'EOF');
  return dxf(L);
}

/** Döngüsel blok başvurusu: A → B → A */
export const blockCycle = () =>
  dxf([
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', 'A', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '1', '31', '0',
    '0', 'INSERT', '8', '0', '2', 'B', '10', '0', '20', '0', '30', '0',
    '0', 'ENDBLK', '8', '0',
    '0', 'BLOCK', '8', '0', '2', 'B', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'INSERT', '8', '0', '2', 'A', '10', '0', '20', '0', '30', '0',
    '0', 'ENDBLK', '8', '0',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', '0', '2', 'A', '10', '0', '20', '0', '30', '0', '0', 'ENDSEC', '0', 'EOF',
  ]);
