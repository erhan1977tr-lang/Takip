// Sentetik DXF (ASCII) üretici — CAD önizleme testleri (karar 283). Gerçek müşteri dosyası kullanılmaz; her nesne
// koordinatı bilinen, elle hesaplanabilir değerlerdir. Gerçek DWG örnekleri yalnızca sunucu kurulum testinde, LibreDWG'nin
// sabit sürümlü kaynak paketinin kendi test dosyalarından kullanılır (deploy/test/cad-preview.sh).

/** @param {[number, string | number][]} pairs */
const lines = (pairs) => pairs.map(([c, v]) => `${String(c).padStart(3)}\n${v}`).join('\n');

/**
 * @param {{ version?: string, insunits?: number, layers?: { name: string, color: number, frozen?: boolean }[],
 *   blocks?: { name: string, base?: number[], entities: [number, string | number][][] }[], entities?: [number, string | number][][] }} o
 */
export function dxf({ version = 'AC1015', insunits = 4, layers = [], blocks = [], entities = [] } = {}) {
  const out = [];
  out.push(lines([[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, version], [9, '$INSUNITS'], [70, insunits], [0, 'ENDSEC']]));
  out.push(lines([[0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER']]));
  for (const l of layers) out.push(lines([[0, 'LAYER'], [2, l.name], [70, l.frozen ? 1 : 0], [62, l.color], [6, 'CONTINUOUS']]));
  out.push(lines([[0, 'ENDTAB'], [0, 'ENDSEC']]));
  out.push(lines([[0, 'SECTION'], [2, 'BLOCKS']]));
  for (const b of blocks) {
    const [bx, by] = b.base ?? [0, 0];
    out.push(lines([[0, 'BLOCK'], [8, '0'], [2, b.name], [70, 0], [10, bx], [20, by], [30, 0]]));
    for (const e of b.entities) out.push(lines(e));
    out.push(lines([[0, 'ENDBLK'], [8, '0']]));
  }
  out.push(lines([[0, 'ENDSEC']]));
  out.push(lines([[0, 'SECTION'], [2, 'ENTITIES']]));
  for (const e of entities) out.push(lines(e));
  out.push(lines([[0, 'ENDSEC'], [0, 'EOF']]));
  return `${out.join('\n')}\n`;
}

export const line = (x1, y1, x2, y2, layer = '0', color) => [[0, 'LINE'], [8, layer], ...(color ? [[62, color]] : []), [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]];
export const circle = (x, y, r, layer = '0') => [[0, 'CIRCLE'], [8, layer], [10, x], [20, y], [30, 0], [40, r]];
export const arc = (x, y, r, a0, a1, layer = '0') => [[0, 'ARC'], [8, layer], [10, x], [20, y], [30, 0], [40, r], [50, a0], [51, a1]];
export const text = (x, y, h, s, layer = '0') => [[0, 'TEXT'], [8, layer], [10, x], [20, y], [30, 0], [40, h], [1, s]];
export const mtext = (x, y, h, s, layer = '0') => [[0, 'MTEXT'], [8, layer], [10, x], [20, y], [30, 0], [40, h], [71, 1], [1, s]];
export const insert = (name, x, y, { sx = 1, sy = 1, rot = 0, layer = '0' } = {}) => [[0, 'INSERT'], [8, layer], [2, name], [10, x], [20, y], [30, 0], [41, sx], [42, sy], [50, rot]];
/** Kapalı LWPOLYLINE; bulges[i] = i. köşeden sonraki kenarın şişkinliği */
export const lwpoly = (pts, { closed = false, bulges = [], layer = '0' } = {}) => [
  [0, 'LWPOLYLINE'], [8, layer], [90, pts.length], [70, closed ? 1 : 0],
  ...pts.flatMap(([x, y], i) => [[10, x], [20, y], ...(bulges[i] ? [[42, bulges[i]]] : [])]),
];
export const dimension = (block, layer = '0') => [[0, 'DIMENSION'], [8, layer], [2, block], [10, 0], [20, 0], [30, 0], [70, 0]];
export const raw = (type, layer = '0') => [[0, type], [8, layer], [10, 0], [20, 0], [30, 0]];
export const paperLine = (x1, y1, x2, y2) => [[0, 'LINE'], [67, 1], [8, '0'], [10, x1], [20, y1], [11, x2], [21, y2]];
