// DXF (ASCII) → önizleme geometrisi. Bağımlılıksız, saf; yalnızca CAD önizleme hizmetinin alt sürecinde çalışır
// (server/cad/service.mjs → dxf-cli.mjs), uygulama sürecinde ÇALIŞMAZ. Çizimi değiştirmez, hesap / ölçü üretmez: DXF'teki
// geometriyi düzlem (XY) görünüşüne çevirir — çizgiler, yaylar, çoklu çizgiler, elips / spline, bloklar (INSERT, dizi),
// ölçülendirmeler (ölçünün kendi bloğu), yazılar, katı dolgular. Gösterilemeyen öğeler SESSİZCE atılmaz: tür ve adetleriyle
// `notes` içinde döner (notes.unsupported: hiç çizilmeyen; notes.partial: kısmen çizilen; notes.paperSpace: kağıt alanı).
//
// Kaynak sınırları (CAD_LIMITS): metin boyutu, çıktı öğe / köşe / yazı sayısı, blok iç içeliği, dizi hücresi ve blok
// genişletme iş bütçesi; açılar sweepOf ile kapalı biçimde hesaplanır (döngü yok). Sınır
// aşılırsa CadError('TOO_COMPLEX') — çizim kırpılıp eksik gösterilmez. Bozuk girdi CadError('INVALID'); ikili DXF
// CadError('BINARY_DXF'); DXF olmayan girdi CadError('NOT_DXF').
import { aciColor, trueColor } from './aci.js';

export const CAD_LIMITS = Object.freeze({
  bytes: 80_000_000,
  primitives: 600_000,
  vertices: 4_000_000,
  texts: 100_000,
  insertDepth: 16,
  arrayCells: 10_000,
  textChars: 2_000,
  blockEntities: 3_000_000,
  // Blok genişletme iş bütçesi (karar 289): blok içinde ziyaret edilen öğe sayısı. Çıktı üretmeyen iç içe bloklar
  // (FAN^DERİNLİK) çıktı sınırlarına hiç takılmadığı için ayrıca sayılır.
  work: 5_000_000,
});

export class CadError extends Error {
  /** @param {'BINARY_DXF' | 'NOT_DXF' | 'INVALID' | 'TOO_COMPLEX' | 'TOO_LARGE'} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const UNITS = { 0: null, 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil', 10: 'yd', 14: 'dm' };
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
/** Bu türler çizilmez ama "eksik" de sayılmaz: görüntüde karşılığı yoktur */
/**
 * Yay açıklığı (karar 289): eski `while (a1 <= a0) a1 += TAU` ile AYNI sonuç, döngüsüz. Çok büyük açılarda (1e17)
 * eski döngü sonlanmıyordu; sonlu olmayan değer → INVALID.
 */
export function sweepOf(a0, a1) {
  if (!Number.isFinite(a0) || !Number.isFinite(a1)) throw new CadError('INVALID');
  const d = a1 - a0;
  if (!Number.isFinite(d)) throw new CadError('INVALID');
  if (d > 0) return d;
  const r = -d % TAU;
  return r === 0 ? TAU : TAU - r;
}
const SILENT = new Set(['VIEWPORT', 'SEQEND', 'ENDBLK', 'ATTDEF']);
const UNSUPPORTED_TEXT = new Set(['MULTILEADER', 'MLEADER']);

// ---------------------------------------------------------------------------------------------------------------------
// Okuyucu: (grup kodu, değer) çiftleri; satır satır, girdiyi kopyalamadan
// ---------------------------------------------------------------------------------------------------------------------

class Reader {
  /** @param {string} s */
  constructor(s) {
    this.s = s;
    this.i = 0;
    /** @type {[number, string] | null} */
    this.back = null;
  }

  /** @returns {[number, string] | null} */
  read() {
    if (this.back) {
      const p = this.back;
      this.back = null;
      return p;
    }
    const s = this.s;
    if (this.i >= s.length) return null;
    let e = s.indexOf('\n', this.i);
    if (e < 0) e = s.length;
    const codeLine = s.slice(this.i, e);
    this.i = e + 1;
    if (this.i > s.length) throw new CadError('INVALID');
    let e2 = s.indexOf('\n', this.i);
    if (e2 < 0) e2 = s.length;
    let val = s.slice(this.i, e2);
    this.i = e2 + 1;
    if (val.endsWith('\r')) val = val.slice(0, -1);
    const t = codeLine.trim();
    if (!/^-?\d{1,4}$/.test(t)) throw new CadError('INVALID');
    return [Number(t), val];
  }

  unread(p) {
    this.back = p;
  }
}

/** Bir kayıt: tür + grup kodları ve değerleri (paralel diziler) */
function readRecord(rd, type) {
  const codes = [];
  const vals = [];
  for (;;) {
    const p = rd.read();
    if (!p) break;
    if (p[0] === 0) {
      rd.unread(p);
      break;
    }
    codes.push(p[0]);
    vals.push(p[1]);
  }
  return { type, codes, vals, children: /** @type {any[]} */ ([]) };
}

/**
 * Bölümdeki kayıtları sırayla verir; POLYLINE + VERTEX + SEQEND ve INSERT (66=1) + ATTRIB + SEQEND tek kayıtta toplanır.
 * Bölüm sonunda (ENDSEC) durur.
 */
function* records(rd) {
  /** @type {any} */
  let open = null;
  for (;;) {
    const p = rd.read();
    if (!p) break;
    if (p[0] !== 0) continue;
    const type = p[1].trim().toUpperCase();
    if (type === 'ENDSEC' || type === 'EOF') {
      if (open) yield open;
      if (type === 'EOF') rd.unread(p);
      return;
    }
    const r = readRecord(rd, type);
    if (open) {
      if ((type === 'VERTEX' && open.type === 'POLYLINE') || (type === 'ATTRIB' && open.type === 'INSERT')) {
        open.children.push(r);
        continue;
      }
      if (type === 'SEQEND') {
        yield open;
        open = null;
        continue;
      }
      yield open;
      open = null;
    }
    if (type === 'POLYLINE' || (type === 'INSERT' && str(r, 66) === '1')) open = r;
    else yield r;
  }
  if (open) yield open;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kayıt değerleri
// ---------------------------------------------------------------------------------------------------------------------

function str(r, code, def = null) {
  const i = r.codes.indexOf(code);
  return i < 0 ? def : r.vals[i];
}
function num(r, code, def = 0) {
  const i = r.codes.indexOf(code);
  if (i < 0) return def;
  const v = Number(r.vals[i].trim());
  if (!Number.isFinite(v)) throw new CadError('INVALID');
  return v;
}
function int(r, code, def = 0) {
  return Math.trunc(num(r, code, def));
}
function numAt(r, i) {
  const v = Number(r.vals[i].trim());
  if (!Number.isFinite(v)) throw new CadError('INVALID');
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dönüşüm: 2B afin matris [a, b, c, d, e, f] — x' = a·x + c·y + e, y' = b·x + d·y + f
// ---------------------------------------------------------------------------------------------------------------------

const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const scale = (x, y) => [x, 0, 0, y, 0, 0];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null;
};

/** Yükseklik yönü (210/220/230) */
function extrusion(r) {
  return norm([num(r, 210, 0), num(r, 220, 0), num(r, 230, 1)]) ?? [0, 0, 1];
}

/**
 * Nesne koordinat sistemi (OCS) → dünya koordinatlarının XY izdüşümü (rastgele eksen algoritması). z: yükseklik.
 * @returns {number[]} afin matris
 */
function ocs(n, z = 0) {
  const wy = [0, 1, 0];
  const wz = [0, 0, 1];
  const ax = norm(Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64 ? cross(wy, n) : cross(wz, n)) ?? [1, 0, 0];
  const ay = norm(cross(n, ax)) ?? [0, 1, 0];
  return [ax[0], ax[1], ay[0], ay[1], z * n[0], z * n[1]];
}

// ---------------------------------------------------------------------------------------------------------------------
// Çıktı
// ---------------------------------------------------------------------------------------------------------------------

const r4 = (v) => Math.round(v * 1e4) / 1e4;

class Out {
  constructor(layerTable) {
    /** @type {Map<string, number>} */
    this.index = new Map();
    /** @type {{ name: string, color: string, on: boolean }[]} */
    this.layers = [];
    this.layerTable = layerTable;
    /** [katman, renk|null, bayrak (1 kapalı, 2 dolgu), halkalar] */
    this.paths = [];
    /** [katman, renk|null, x, y, yükseklik, açı, metin, yatay, dikey, genişlik] */
    this.texts = [];
    /** [katman, renk|null, x, y] */
    this.points = [];
    this.vertices = 0;
    /** blok genişletmede ziyaret edilen öğe sayısı (CAD_LIMITS.work) */
    this.work = 0;
    this.box = [Infinity, Infinity, -Infinity, -Infinity];
    this.notes = { unsupported: /** @type {Record<string, number>} */ ({}), partial: /** @type {Record<string, number>} */ ({}), paperSpace: 0 };
  }

  layer(name) {
    const key = name || '0';
    let i = this.index.get(key);
    if (i === undefined) {
      const t = this.layerTable.get(key.toUpperCase());
      i = this.layers.length;
      this.layers.push({ name: key, color: t?.color ?? '#ffffff', on: t ? t.on : true });
      this.index.set(key, i);
    }
    return i;
  }

  budget() {
    if (this.paths.length + this.texts.length + this.points.length > CAD_LIMITS.primitives || this.vertices > CAD_LIMITS.vertices) {
      throw new CadError('TOO_COMPLEX');
    }
  }

  grow(x, y) {
    if (x < this.box[0]) this.box[0] = x;
    if (y < this.box[1]) this.box[1] = y;
    if (x > this.box[2]) this.box[2] = x;
    if (y > this.box[3]) this.box[3] = y;
  }

  /** @param {number[][]} rings dünya koordinatlı halkalar [x0, y0, x1, y1, …] */
  path(ctx, rings, { closed = false, fill = false } = {}) {
    const out = [];
    for (const ring of rings) {
      if (ring.length < 4) continue;
      const q = new Array(ring.length);
      for (let k = 0; k < ring.length; k += 2) {
        const x = ring[k];
        const y = ring[k + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CadError('INVALID');
        this.grow(x, y);
        q[k] = r4(x);
        q[k + 1] = r4(y);
      }
      this.vertices += q.length / 2;
      out.push(q);
    }
    if (!out.length) return;
    this.paths.push([this.layer(ctx.layer), ctx.color, (closed ? 1 : 0) | (fill ? 2 : 0), out]);
    this.budget();
  }

  text(ctx, x, y, h, rot, s, ha, va, wf) {
    if (!s || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (this.texts.length >= CAD_LIMITS.texts) throw new CadError('TOO_COMPLEX');
    this.grow(x, y);
    this.texts.push([this.layer(ctx.layer), ctx.color, r4(x), r4(y), r4(h), Math.round(rot * 1e4) / 1e4, s.slice(0, CAD_LIMITS.textChars), ha, va, Math.round(wf * 100) / 100]);
    this.budget();
  }

  point(ctx, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.grow(x, y);
    this.points.push([this.layer(ctx.layer), ctx.color, r4(x), r4(y)]);
    this.budget();
  }

  note(kind, type) {
    this.notes[kind][type] = (this.notes[kind][type] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Eğriler
// ---------------------------------------------------------------------------------------------------------------------

/** Yay → noktalar (yerel koordinatta), sonra m ile dünya */
function arcPoints(m, cx, cy, r, a0, sweep, out) {
  const n = Math.max(2, Math.min(720, Math.ceil((Math.abs(sweep) / TAU) * 96)));
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    const [x, y] = apply(m, cx + r * Math.cos(a), cy + r * Math.sin(a));
    out.push(x, y);
  }
}

/** Şişkinlikli (bulge) kenar: P1 → P2 (P1 hariç noktalar eklenir) */
function bulgePoints(m, x1, y1, x2, y2, b, out) {
  if (!b || Math.abs(b) < 1e-12) {
    const [x, y] = apply(m, x2, y2);
    out.push(x, y);
    return;
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return;
  const theta = 4 * Math.atan(b);
  const r = chord / (2 * Math.sin(theta / 2));
  const h = r * Math.cos(theta / 2);
  const cx = (x1 + x2) / 2 - (h * dy) / chord;
  const cy = (y1 + y2) / 2 + (h * dx) / chord;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const tmp = [];
  arcPoints(m, cx, cy, Math.abs(r), a1, theta, tmp);
  for (let k = 2; k < tmp.length; k++) out.push(tmp[k]);
}

/** NURBS noktası (de Boor); kontrol noktaları [x, y, z, w] */
function deBoor(deg, knots, ctrl, u, span) {
  const d = [];
  for (let j = 0; j <= deg; j++) {
    const p = ctrl[j + span - deg];
    d.push([p[0] * p[3], p[1] * p[3], p[2] * p[3], p[3]]);
  }
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const i = j + span - deg;
      const den = knots[i + deg - r + 1] - knots[i];
      const a = den === 0 ? 0 : (u - knots[i]) / den;
      for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
  }
  const w = d[deg][3] || 1;
  return [d[deg][0] / w, d[deg][1] / w, d[deg][2] / w];
}

/**
 * Spline örnekleri (dünya / blok koordinatı, 3B). Düğüm sayısı tutarsızsa null.
 * @returns {number[][] | null}
 */
function nurbsSamples(deg, knots, ctrl) {
  const n = ctrl.length;
  if (deg < 1 || n < deg + 1 || knots.length !== n + deg + 1) return null;
  for (let i = 1; i < knots.length; i++) if (knots[i] < knots[i - 1]) return null;
  const u0 = knots[deg];
  const u1 = knots[n];
  if (!(u1 > u0)) return null;
  const steps = Math.max(16, Math.min(2000, n * 12));
  const pts = [];
  let span = deg;
  for (let k = 0; k <= steps; k++) {
    const u = k === steps ? u1 : u0 + ((u1 - u0) * k) / steps;
    while (span < n - 1 && u >= knots[span + 1]) span++;
    pts.push(deBoor(deg, knots, ctrl, u, span));
  }
  return pts;
}

/**
 * Yalnızca uydurma noktaları olan spline (LibreDWG çıktısında kontrol noktası / düğüm yazılmaz): noktalardan geçen doğal
 * kübik eğri (kiriş uzunluğu parametresi). AutoCAD'in kendi eğrisiyle birebir aynı değildir — çağıran "yaklaşık" not düşer.
 * @param {number[][]} fit @returns {number[][]}
 */
function fitSamples(fit) {
  const n = fit.length;
  if (n < 3) return fit.map((p) => [p[0], p[1]]);
  const t = [0];
  for (let i = 1; i < n; i++) t.push(t[i - 1] + Math.max(1e-12, Math.hypot(fit[i][0] - fit[i - 1][0], fit[i][1] - fit[i - 1][1])));
  /** doğal kübik spline ikinci türevleri (Thomas algoritması) */
  const second = (vals) => {
    const m = new Array(n).fill(0);
    const c = new Array(n).fill(0);
    const d = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const h0 = t[i] - t[i - 1];
      const h1 = t[i + 1] - t[i];
      const a = h0;
      const b = 2 * (h0 + h1);
      const rhs = 6 * ((vals[i + 1] - vals[i]) / h1 - (vals[i] - vals[i - 1]) / h0);
      const den = b - a * c[i - 1];
      c[i] = h1 / den;
      d[i] = (rhs - a * d[i - 1]) / den;
    }
    for (let i = n - 2; i >= 1; i--) m[i] = d[i] - c[i] * m[i + 1];
    return m;
  };
  const xs = fit.map((p) => p[0]);
  const ys = fit.map((p) => p[1]);
  const mx = second(xs);
  const my = second(ys);
  const per = Math.max(4, Math.min(64, Math.ceil(2000 / n)));
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const h = t[i + 1] - t[i];
    for (let k = 0; k < per; k++) {
      const s = (k / per) * h;
      const a = (h - s) / h;
      const b = s / h;
      const f = (v, m) => a * v[i] + b * v[i + 1] + (((a * a * a - a) * m[i] + (b * b * b - b) * m[i + 1]) * h * h) / 6;
      out.push([f(xs, mx), f(ys, my)]);
    }
  }
  out.push([xs[n - 1], ys[n - 1]]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Yazı
// ---------------------------------------------------------------------------------------------------------------------

/** %%c, %%d, %%p, %%nnn ve \U+XXXX kaçışları */
function textCodes(s) {
  return s
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%%/g, '%')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** MTEXT biçim kodlarını ayıklar: \P satır sonu, {…} grupları, \f…; \H…; gibi parametreler, \S yığın */
export function mtextPlain(raw) {
  const s = textCodes(String(raw ?? ''));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) break;
    if (n === 'P' || n === 'n') {
      out += '\n';
      i++;
    } else if (n === '~') {
      out += ' ';
      i++;
    } else if (n === '\\' || n === '{' || n === '}') {
      out += n;
      i++;
    } else if (n === 'S') {
      const end = s.indexOf(';', i + 2);
      const body = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
      out += body.replace(/[\^#]/g, '/');
      i = end < 0 ? s.length : end;
    } else if ('fFHWQTACcpa'.includes(n)) {
      const end = s.indexOf(';', i + 2);
      i = end < 0 ? s.length : end;
    } else if ('LlOoKkXN'.includes(n)) {
      i++;
    } else {
      out += n;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ana dönüştürücü
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @param {string} text DXF (ASCII)
 * @returns {{ version: string | null, units: string | null, extents: number[] | null, layers: { name: string, color: string, on: boolean }[],
 *   paths: any[], texts: any[], points: any[],
 *   notes: { unsupported: Record<string, number>, partial: Record<string, number>, paperSpace: number, dropped?: Record<string, number>, converterErrors?: number },
 *   stats: { paths: number, texts: number, points: number, vertices: number }, seenTypes: string[] }}
 */
export function dxfToPreview(text) {
  if (typeof text !== 'string') throw new CadError('INVALID');
  if (text.length > CAD_LIMITS.bytes) throw new CadError('TOO_LARGE');
  if (text.startsWith('AutoCAD Binary DXF')) throw new CadError('BINARY_DXF');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // İlk çift (açıklama satırlarından sonra) "0 / SECTION" olmalı
  try {
    const probe = new Reader(text);
    let p = probe.read();
    while (p && p[0] === 999) p = probe.read();
    if (!p || p[0] !== 0 || p[1].trim() !== 'SECTION') throw new CadError('NOT_DXF');
  } catch {
    throw new CadError('NOT_DXF');
  }
  const rd = new Reader(text);
  const header = { version: /** @type {string | null} */ (null), insunits: 0 };
  /** @type {Map<string, { color: string, on: boolean }>} */
  const layerTable = new Map();
  /** @type {Map<string, { base: number[], entities: any[], ambiguous?: boolean }>} */
  const blocks = new Map();
  let blockEntities = 0;
  /** DXF'te bulunan nesne türleri (dönüştürücünün düşürdüğü türleri ayırmak için — mergeConverterReport) */
  const seen = new Set();
  /** @type {Out | null} */
  let out = null;
  const getOut = () => (out ??= new Out(layerTable));
  let sawSection = false;

  for (;;) {
    const p = rd.read();
    if (!p) break;
    if (p[0] !== 0) continue;
    const t = p[1].trim();
    if (t === 'EOF') break;
    if (t !== 'SECTION') continue;
    sawSection = true;
    const nameP = rd.read();
    const name = nameP && nameP[0] === 2 ? nameP[1].trim().toUpperCase() : '';
    if (name === 'HEADER') readHeader(rd, header);
    else if (name === 'TABLES') {
      for (const r of records(rd)) {
        if (r.type !== 'LAYER') continue;
        const lname = (str(r, 2) ?? '0').trim();
        const ci = int(r, 62, 7);
        const tc = trueColor(str(r, 420) === null ? NaN : Number(str(r, 420)));
        const flags = int(r, 70, 0);
        layerTable.set(lname.toUpperCase(), { color: tc ?? aciColor(ci) ?? '#ffffff', on: ci >= 0 && (flags & 1) === 0 });
      }
    } else if (name === 'BLOCKS') {
      /** @type {{ name: string, base: number[], entities: any[] } | null} */
      let cur = null;
      for (const r of records(rd)) {
        if (r.type === 'BLOCK') {
          cur = { name: (str(r, 2) ?? str(r, 3) ?? '').trim(), base: [num(r, 10, 0), num(r, 20, 0), num(r, 30, 0)], entities: [] };
          continue;
        }
        if (r.type === 'ENDBLK') {
          if (cur && cur.name) {
            const key = cur.name.toUpperCase();
            // Aynı adla birden çok blok (ör. LibreDWG'nin R2.x ölçülendirmelerinde hepsi "*D"): hangisinin kastedildiği
            // bilinemez — tahmin edilmez, bu ada yapılan başvurular "çizilmeyen" sayılır
            if (blocks.has(key)) blocks.set(key, { ...cur, ambiguous: true });
            else blocks.set(key, cur);
          }
          cur = null;
          continue;
        }
        if (cur) {
          if (++blockEntities > CAD_LIMITS.blockEntities) throw new CadError('TOO_COMPLEX');
          seen.add(r.type);
          cur.entities.push(r);
        }
      }
    } else if (name === 'ENTITIES') {
      const o = getOut();
      for (const r of records(rd)) {
        seen.add(r.type);
        if (int(r, 67, 0) === 1) {
          o.notes.paperSpace++;
          continue;
        }
        drawEntity(o, r, ID, { layer: null, color: null }, blocks, [], false);
      }
    } else {
      // diğer bölümler (CLASSES, OBJECTS, THUMBNAILIMAGE) atlanır
      for (const _ of records(rd)) { /* atla */ }
    }
  }
  if (!sawSection) throw new CadError('NOT_DXF');
  const o = getOut();
  const ext = Number.isFinite(o.box[0]) ? o.box.map(r4) : null;
  return {
    version: header.version,
    units: UNITS[/** @type {keyof typeof UNITS} */ (header.insunits)] ?? null,
    extents: ext,
    layers: o.layers,
    paths: o.paths,
    texts: o.texts,
    points: o.points,
    notes: o.notes,
    stats: { paths: o.paths.length, texts: o.texts.length, points: o.points.length, vertices: o.vertices },
    seenTypes: [...seen].filter((s) => typeof s === 'string' && TYPE_RE.test(s)).sort(),
  };
}

const TYPE_RE = /^[A-Z0-9_]{1,40}$/;

/**
 * LibreDWG (dwg2dxf) hata çıktısının özeti — sürümü sabit (0.14) aracın ileti biçimine dayanır; yalnızca tür adı, nesne
 * numarası ve hata satırı SAYISI alınır, başka metin dışarı çıkmaz.
 * - `dropped`: DXF'e yazılmayan çizim nesnesi türleri ("… Class entity <no> <TÜR> (…) <nesne>/…") → farklı nesne sayısı
 * - `errors`: "ERROR:" satırları (yalnızca küçük önizleme resmine ait olanlar sayılmaz — çizimi etkilemez). Araç bu
 *   durumlarda da 0 ile çıkar; sıfırdan büyükse önizleme "eksik ya da hatalı olabilir" uyarısıyla gösterilir.
 * @param {string} stderr @returns {{ dropped: Record<string, number>, errors: number }}
 */
export function converterReport(stderr) {
  /** @type {Map<string, Set<string>>} */
  const found = new Map();
  let errors = 0;
  if (typeof stderr !== 'string') return { dropped: {}, errors: 0 };
  const re = /\b(?:Unstable|Unhandled|Debugging|Unknown|Unsupported) Class entity \d+ ([A-Z0-9_]{1,40})\b[^\n]*?(?:\s(\d+)\/[0-9A-Fa-f]+)?\s*$/gm;
  for (const m of stderr.matchAll(re)) {
    if (!found.has(m[1]) && found.size >= 200) continue;
    const set = found.get(m[1]) ?? new Set();
    set.add(m[2] ?? '?');
    found.set(m[1], set);
  }
  for (const line of stderr.split('\n')) {
    if (!/^\s*ERROR:/.test(line)) continue;
    if (/Preview/i.test(line)) continue;
    errors++;
  }
  /** @type {Record<string, number>} */
  const dropped = {};
  for (const [k, v] of found) dropped[k] = v.size;
  return { dropped, errors };
}

/**
 * Dönüştürücünün bildirdiği ama DXF'te hiç bulunmayan türler önizlemede "çizilmeyen" olarak işaretlenir (sessizce eksik
 * çizim gösterilmez); DXF'te bulunan tür önizleyicinin kendi kuralıyla zaten değerlendirilmiştir. Hata satırı sayısı
 * `notes.converterErrors` olarak eklenir.
 * @param {ReturnType<typeof dxfToPreview>} data @param {{ dropped?: Record<string, number>, errors?: number }} report
 */
export function mergeConverterReport(data, report) {
  const seen = new Set(data.seenTypes ?? []);
  /** @type {Record<string, number>} */
  const dropped = {};
  for (const [type, n] of Object.entries(report?.dropped ?? {})) {
    if (!TYPE_RE.test(type) || seen.has(type) || !(Number(n) > 0)) continue;
    dropped[type] = Math.min(Math.trunc(Number(n)), 1_000_000);
    data.notes.unsupported[type] = (data.notes.unsupported[type] ?? 0) + dropped[type];
  }
  data.notes.dropped = dropped;
  const errors = Number(report?.errors);
  data.notes.converterErrors = Number.isFinite(errors) && errors > 0 ? Math.min(Math.trunc(errors), 1_000_000) : 0;
  return data;
}

function readHeader(rd, header) {
  let variable = null;
  for (;;) {
    const p = rd.read();
    if (!p) return;
    if (p[0] === 0 && p[1].trim() === 'ENDSEC') return;
    if (p[0] === 9) variable = p[1].trim();
    else if (variable === '$ACADVER' && p[0] === 1) header.version = p[1].trim().slice(0, 12);
    else if (variable === '$INSUNITS' && p[0] === 70) header.insunits = Number(p[1].trim()) || 0;
  }
}

/** Varlığın etkin katmanı ve rengi (katman 0 ve ByBlock blok içinde eklemeden alınır) */
function entityCtx(r, parent, inBlock) {
  const own = (str(r, 8) ?? '0').trim() || '0';
  const layer = inBlock && own === '0' && parent.layer ? parent.layer : own;
  const tc = str(r, 420);
  let color = tc !== null ? trueColor(Number(tc)) : null;
  if (!color) {
    const ci = int(r, 62, 256);
    if (ci === 0) color = parent.color;
    else if (ci !== 256) color = aciColor(ci);
  }
  return { layer, color };
}

/**
 * Bir varlığı çizer.
 * @param {Out} o
 * @param {any} r kayıt
 * @param {number[]} m blok dönüşümü (blok koordinatı → dünya XY)
 * @param {{ layer: string | null, color: string | null }} parent
 * @param {Map<string, any>} blocks
 * @param {string[]} stack açık blok adları (döngü / derinlik)
 * @param {boolean} inBlock
 */
function drawEntity(o, r, m, parent, blocks, stack, inBlock) {
  if (int(r, 60, 0) === 1) return; // görünmez
  const type = r.type;
  if (SILENT.has(type)) {
    if (type === 'ATTDEF' && !inBlock) drawText(o, r, m, entityCtx(r, parent, inBlock), false);
    return;
  }
  const ctx = entityCtx(r, parent, inBlock);
  switch (type) {
    case 'LINE': {
      const [x1, y1] = apply(m, num(r, 10), num(r, 20));
      const [x2, y2] = apply(m, num(r, 11), num(r, 21));
      o.path(ctx, [[x1, y1, x2, y2]]);
      return;
    }
    case 'POINT': {
      const [x, y] = apply(m, num(r, 10), num(r, 20));
      o.point(ctx, x, y);
      return;
    }
    case 'CIRCLE':
    case 'ARC': {
      const mm = mul(m, ocs(extrusion(r), num(r, 30, 0)));
      const rad = num(r, 40);
      if (!(rad > 0)) return;
      const pts = [];
      if (type === 'CIRCLE') arcPoints(mm, num(r, 10), num(r, 20), rad, 0, TAU, pts);
      else {
        const a0 = num(r, 50) * DEG;
        arcPoints(mm, num(r, 10), num(r, 20), rad, a0, sweepOf(a0, num(r, 51) * DEG), pts);
      }
      o.path(ctx, [pts], { closed: type === 'CIRCLE' });
      return;
    }
    case 'ELLIPSE': {
      const n = extrusion(r);
      const c = [num(r, 10), num(r, 20), num(r, 30, 0)];
      const maj = [num(r, 11), num(r, 21), num(r, 31, 0)];
      const ratio = num(r, 40, 1);
      const minor = cross(n, maj).map((v) => v * ratio);
      const t0 = num(r, 41, 0);
      const t1 = t0 + sweepOf(t0, num(r, 42, TAU));
      const steps = Math.max(8, Math.min(720, Math.ceil(((t1 - t0) / TAU) * 128)));
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const t = t0 + ((t1 - t0) * k) / steps;
        const x = c[0] + maj[0] * Math.cos(t) + minor[0] * Math.sin(t);
        const y = c[1] + maj[1] * Math.cos(t) + minor[1] * Math.sin(t);
        const [wx, wy] = apply(m, x, y);
        pts.push(wx, wy);
      }
      o.path(ctx, [pts], { closed: Math.abs(t1 - t0 - TAU) < 1e-9 });
      return;
    }
    case 'LWPOLYLINE': {
      const mm = mul(m, ocs(extrusion(r), num(r, 38, 0)));
      const verts = [];
      for (let i = 0; i < r.codes.length; i++) {
        const c = r.codes[i];
        if (c === 10) verts.push({ x: numAt(r, i), y: 0, b: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].y = numAt(r, i);
        else if (c === 42 && verts.length) verts[verts.length - 1].b = numAt(r, i);
      }
      polyline(o, ctx, mm, verts, (int(r, 70, 0) & 1) === 1);
      return;
    }
    case 'POLYLINE': {
      drawPolyline(o, r, m, ctx);
      return;
    }
    case 'SPLINE':
    case 'HELIX': {
      const deg = int(r, 71, 3);
      const knots = [];
      const weights = [];
      const ctrl = [];
      const fit = [];
      for (let i = 0; i < r.codes.length; i++) {
        const c = r.codes[i];
        if (c === 40) knots.push(numAt(r, i));
        else if (c === 41) weights.push(numAt(r, i));
        else if (c === 10) ctrl.push([numAt(r, i), 0, 0]);
        else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = numAt(r, i);
        else if (c === 30 && ctrl.length) ctrl[ctrl.length - 1][2] = numAt(r, i);
        else if (c === 11) fit.push([numAt(r, i), 0]);
        else if (c === 21 && fit.length) fit[fit.length - 1][1] = numAt(r, i);
      }
      const w = ctrl.map((p, i) => [p[0], p[1], p[2], weights.length === ctrl.length ? weights[i] : 1]);
      const s = ctrl.length ? nurbsSamples(deg, knots, w) : null;
      const pts = [];
      if (s) for (const p of s) pts.push(...apply(m, p[0], p[1]));
      else if (fit.length >= 2) {
        for (const p of fitSamples(fit)) pts.push(...apply(m, p[0], p[1]));
        o.note('partial', type);
      } else if (ctrl.length >= 2) {
        for (const p of ctrl) pts.push(...apply(m, p[0], p[1]));
        o.note('partial', type);
      } else {
        o.note('unsupported', type);
        return;
      }
      o.path(ctx, [pts], { closed: (int(r, 70, 0) & 1) === 1 && !!s });
      return;
    }
    case 'TEXT':
    case 'ATTRIB':
      if (type === 'ATTRIB' && (int(r, 70, 0) & 1) === 1) return;
      drawText(o, r, m, ctx, false);
      return;
    case 'MTEXT':
      drawText(o, r, m, ctx, true);
      return;
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      const mm = type === '3DFACE' ? m : mul(m, ocs(extrusion(r), num(r, 30, 0)));
      const p = [10, 11, 12, 13].map((c) => apply(mm, num(r, c), num(r, c + 10)));
      if (type === '3DFACE') {
        const flags = int(r, 70, 0);
        const order = [0, 1, 2, 3];
        for (let k = 0; k < 4; k++) {
          if (flags & (1 << k)) continue;
          const a = p[order[k]];
          const b = p[order[(k + 1) % 4]];
          o.path(ctx, [[a[0], a[1], b[0], b[1]]]);
        }
      } else {
        o.path(ctx, [[p[0][0], p[0][1], p[1][0], p[1][1], p[3][0], p[3][1], p[2][0], p[2][1]]], { closed: true, fill: true });
      }
      return;
    }
    case 'LEADER': {
      const pts = [];
      for (let i = 0; i < r.codes.length; i++) {
        if (r.codes[i] === 10) pts.push(numAt(r, i), 0);
        else if (r.codes[i] === 20 && pts.length) pts[pts.length - 1] = numAt(r, i);
      }
      const w = [];
      for (let k = 0; k + 1 < pts.length; k += 2) w.push(...apply(m, pts[k], pts[k + 1]));
      if (w.length >= 4) o.path(ctx, [w]);
      if (int(r, 71, 1) === 1) o.note('partial', 'LEADER');
      return;
    }
    case 'HATCH':
      drawHatch(o, r, m, ctx);
      return;
    case 'INSERT':
    case 'ACAD_TABLE': {
      drawInsert(o, r, m, ctx, parent, blocks, stack);
      return;
    }
    default:
      if (type.includes('DIMENSION') && str(r, 2)) {
        const name = str(r, 2).trim().toUpperCase();
        const b = blocks.get(name);
        if (!b || b.ambiguous) {
          o.note('unsupported', type);
          return;
        }
        expandBlock(o, b, m, ctx, blocks, stack, name);
        return;
      }
      o.note('unsupported', UNSUPPORTED_TEXT.has(type) ? 'MULTILEADER' : type.slice(0, 40));
  }
}

function polyline(o, ctx, m, verts, closed) {
  if (verts.length < 2) return;
  const pts = [...apply(m, verts[0].x, verts[0].y)];
  const n = verts.length;
  for (let k = 1; k < (closed ? n + 1 : n); k++) {
    const a = verts[k - 1];
    const b = verts[k % n];
    bulgePoints(m, a.x, a.y, b.x, b.y, a.b, pts);
  }
  o.path(ctx, [pts], { closed });
}

function drawPolyline(o, r, m, ctx) {
  const flags = int(r, 70, 0);
  const vs = r.children.map((v) => ({ x: num(v, 10), y: num(v, 20), z: num(v, 30, 0), b: num(v, 42, 0), f: int(v, 70, 0), v }));
  if (flags & 64) {
    // Çok yüzlü ağ: köşe kayıtları (bayrak 64 + 128), yüz kayıtları (yalnızca 128; 71–74 köşe sırası, eksi = görünmez kenar)
    const points = vs.filter((p) => (p.f & 64) !== 0);
    for (const face of vs.filter((p) => (p.f & 64) === 0 && (p.f & 128) !== 0)) {
      const idx = [71, 72, 73, 74].map((c) => int(face.v, c, 0)).filter((i) => i !== 0);
      for (let k = 0; k < idx.length; k++) {
        if (idx[k] < 0) continue;
        const a = points[Math.abs(idx[k]) - 1];
        const b = points[Math.abs(idx[(k + 1) % idx.length]) - 1];
        if (!a || !b) continue;
        const [x1, y1] = apply(m, a.x, a.y);
        const [x2, y2] = apply(m, b.x, b.y);
        o.path(ctx, [[x1, y1, x2, y2]]);
      }
    }
    return;
  }
  if (flags & 16) {
    // Çokgen ağ: M × N köşe ızgarası
    const M = int(r, 71, 0);
    const N = int(r, 72, 0);
    if (M < 1 || N < 1 || M * N > vs.length) return;
    const at = (i, j) => apply(m, vs[i * N + j].x, vs[i * N + j].y);
    for (let i = 0; i < M; i++) {
      const row = [];
      for (let j = 0; j < N; j++) row.push(...at(i, j));
      o.path(ctx, [row], { closed: (flags & 32) !== 0 });
    }
    for (let j = 0; j < N; j++) {
      const col = [];
      for (let i = 0; i < M; i++) col.push(...at(i, j));
      o.path(ctx, [col], { closed: (flags & 1) !== 0 });
    }
    return;
  }
  // Eğri / spline uydurulmuş çoklu çizgide çerçeve denetim noktaları (bayrak 16) çizilmez
  const list = vs.filter((p) => (p.f & 16) === 0);
  const closed = (flags & 1) === 1;
  if (flags & 8) {
    const pts = [];
    for (const p of list) pts.push(...apply(m, p.x, p.y));
    if (closed && list.length) pts.push(...apply(m, list[0].x, list[0].y));
    o.path(ctx, [pts], { closed });
    return;
  }
  const mm = mul(m, ocs(extrusion(r), num(r, 30, 0)));
  polyline(o, ctx, mm, list.map((p) => ({ x: p.x, y: p.y, b: p.b })), closed);
}

function drawText(o, r, m, ctx, isM) {
  let raw;
  if (isM) {
    const parts = [];
    for (let i = 0; i < r.codes.length; i++) if (r.codes[i] === 3) parts.push(r.vals[i]);
    const last = str(r, 1);
    if (last !== null) parts.push(last);
    raw = mtextPlain(parts.join(''));
  } else raw = textCodes(str(r, 1) ?? '');
  const s = raw.replace(/\r/g, '').trim();
  if (!s) return;
  let h = num(r, 40, 0);
  if (!(h > 0)) return;
  let x;
  let y;
  let rot;
  let ha = 'l';
  let va = 'b';
  let wf = 1;
  let mm = m;
  if (isM) {
    [x, y] = [num(r, 10), num(r, 20)];
    const dx = str(r, 11) !== null ? num(r, 11) : null;
    rot = dx !== null ? Math.atan2(num(r, 21), dx) : num(r, 50, 0);
    const at = int(r, 71, 1);
    ha = ['l', 'c', 'r'][(at - 1) % 3] ?? 'l';
    va = ['t', 'm', 'b'][Math.floor((at - 1) / 3)] ?? 't';
  } else {
    mm = mul(m, ocs(extrusion(r), num(r, 30, 0)));
    const h72 = int(r, 72, 0);
    const v73 = int(r, 73, 0);
    rot = num(r, 50, 0) * DEG;
    wf = num(r, 41, 1) || 1;
    const p1 = [num(r, 10), num(r, 20)];
    const p2 = str(r, 11) !== null ? [num(r, 11), num(r, 21)] : p1;
    if (h72 === 3 || h72 === 5) {
      [x, y] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      if (p2 !== p1 && (p2[0] !== p1[0] || p2[1] !== p1[1])) rot = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
      ha = 'c';
      va = 'b';
    } else if (h72 === 0 && v73 === 0) {
      [x, y] = p1;
    } else {
      [x, y] = p2;
      ha = h72 === 1 || h72 === 4 ? 'c' : h72 === 2 ? 'r' : 'l';
      va = h72 === 4 ? 'm' : v73 === 1 ? 'B' : v73 === 2 ? 'm' : v73 === 3 ? 't' : 'b';
    }
  }
  // Konum, yön ve yükseklik dönüşümle birlikte
  const [wx, wy] = apply(mm, x, y);
  const ux = apply(mm, x + Math.cos(rot), y + Math.sin(rot));
  const uy = apply(mm, x - Math.sin(rot), y + Math.cos(rot));
  const xl = Math.hypot(ux[0] - wx, ux[1] - wy);
  const yl = Math.hypot(uy[0] - wx, uy[1] - wy);
  if (!(yl > 0) || !(xl > 0)) return;
  const angle = Math.atan2(ux[1] - wy, ux[0] - wx);
  h *= yl;
  wf *= xl / yl;
  o.text(ctx, wx, wy, h, angle, s, ha, va, wf);
}

function drawInsert(o, r, m, ctx, parent, blocks, stack) {
  const name = (str(r, 2) ?? '').trim().toUpperCase();
  // Ekli öznitelikler (ATTRIB) bloğun değil, eklemenin bulunduğu koordinatta durur
  for (const a of r.children) drawEntity(o, a, m, parent, blocks, stack, stack.length > 0);
  if (name.startsWith('*MODEL_SPACE') || name.startsWith('*PAPER_SPACE')) return;
  const b = blocks.get(name);
  if (!b || b.ambiguous) {
    o.note('unsupported', r.type === 'ACAD_TABLE' ? 'ACAD_TABLE' : 'INSERT');
    return;
  }
  const base = mul(m, ocs(extrusion(r), num(r, 30, 0)));
  const ins = [num(r, 10), num(r, 20)];
  const sx = num(r, 41, 1);
  const sy = num(r, 42, sx === 0 ? 1 : 1);
  const rot = num(r, 50, 0) * DEG;
  const cols = Math.max(1, int(r, 70, 1));
  const rows = Math.max(1, int(r, 71, 1));
  if (cols * rows > CAD_LIMITS.arrayCells) throw new CadError('TOO_COMPLEX');
  const cs = num(r, 44, 0);
  const rs = num(r, 45, 0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const t = mul(mul(mul(mul(base, translate(ins[0], ins[1])), rotate(rot)), translate(j * cs, i * rs)), mul(scale(sx || 1, sy || 1), translate(-b.base[0], -b.base[1])));
      expandBlock(o, b, t, ctx, blocks, stack, name);
    }
  }
}

function expandBlock(o, b, m, ctx, blocks, stack, name) {
  if (stack.includes(name)) {
    o.note('unsupported', 'BLOCK_CYCLE');
    return;
  }
  if (stack.length >= CAD_LIMITS.insertDepth) throw new CadError('TOO_COMPLEX');
  o.work += b.entities.length + 1;
  if (o.work > CAD_LIMITS.work) throw new CadError('TOO_COMPLEX');
  const next = [...stack, name];
  for (const e of b.entities) {
    if (int(e, 67, 0) === 1) continue;
    drawEntity(o, e, m, ctx, blocks, next, true);
  }
}

/** HATCH: sınır halkaları; katı dolgu (70=1) doldurulur, desenli taramanın deseni çizilmez (notes.partial.HATCH) */
function drawHatch(o, r, m, ctx) {
  const mm = mul(m, ocs(extrusion(r), num(r, 30, 0)));
  const solid = int(r, 70, 0) === 1;
  const rings = [];
  let i = r.codes.indexOf(91);
  if (i < 0) {
    o.note('unsupported', 'HATCH');
    return;
  }
  const loops = Math.max(0, Math.trunc(numAt(r, i)));
  i++;
  const at = (code) => {
    while (i < r.codes.length && r.codes[i] !== code) i++;
    if (i >= r.codes.length) throw new CadError('INVALID');
    return numAt(r, i++);
  };
  try {
    for (let L = 0; L < loops; L++) {
      const kind = Math.trunc(at(92));
      const pts = [];
      if (kind & 2) {
        // çoklu çizgi sınırı
        const hasBulge = Math.trunc(at(72));
        Math.trunc(at(73));
        const n = Math.trunc(at(93));
        const verts = [];
        for (let k = 0; k < n; k++) {
          const x = at(10);
          const y = at(20);
          let b = 0;
          if (hasBulge && r.codes[i] === 42) b = numAt(r, i++);
          verts.push({ x, y, b });
        }
        if (verts.length >= 2) {
          pts.push(...apply(mm, verts[0].x, verts[0].y));
          for (let k = 1; k <= verts.length; k++) {
            const a = verts[k - 1];
            const bb = verts[k % verts.length];
            bulgePoints(mm, a.x, a.y, bb.x, bb.y, a.b, pts);
          }
        }
      } else {
        const n = Math.trunc(at(93));
        for (let k = 0; k < n; k++) {
          const et = Math.trunc(at(72));
          if (et === 1) {
            const x1 = at(10);
            const y1 = at(20);
            const x2 = at(11);
            const y2 = at(21);
            const a = apply(mm, x1, y1);
            const b = apply(mm, x2, y2);
            if (!pts.length) pts.push(...a);
            pts.push(...b);
          } else if (et === 2) {
            const cx = at(10);
            const cy = at(20);
            const rad = at(40);
            const a0 = at(50) * DEG;
            const a1 = a0 + sweepOf(a0, at(51) * DEG);
            const ccw = Math.trunc(at(73)) !== 0;
            // Saat yönündeki kenarın açıları DXF'te eksi yönde saklanır: nokta açısı = −t
            const tmp = [];
            arcPoints(mm, cx, cy, rad, ccw ? a0 : -a0, ccw ? a1 - a0 : -(a1 - a0), tmp);
            pts.push(...(pts.length ? tmp.slice(2) : tmp));
          } else if (et === 3) {
            const cx = at(10);
            const cy = at(20);
            const mx = at(11);
            const my = at(21);
            const ratio = at(40);
            const a0 = at(50) * DEG;
            const a1 = a0 + sweepOf(a0, at(51) * DEG);
            const ccw = Math.trunc(at(73)) !== 0;
            const steps = Math.max(8, Math.min(720, Math.ceil(((a1 - a0) / TAU) * 128)));
            const tmp = [];
            for (let s = 0; s <= steps; s++) {
              let t = a0 + ((a1 - a0) * s) / steps;
              if (!ccw) t = -t;
              const x = cx + mx * Math.cos(t) - my * ratio * Math.sin(t);
              const y = cy + my * Math.cos(t) + mx * ratio * Math.sin(t);
              tmp.push(...apply(mm, x, y));
            }
            pts.push(...(pts.length ? tmp.slice(2) : tmp));
          } else if (et === 4) {
            const deg = Math.trunc(at(94));
            Math.trunc(at(73));
            Math.trunc(at(74));
            const nk = Math.trunc(at(95));
            const nc = Math.trunc(at(96));
            const knots = [];
            for (let q = 0; q < nk; q++) knots.push(at(40));
            const ctrl = [];
            for (let q = 0; q < nc; q++) {
              const x = at(10);
              const y = at(20);
              const w = r.codes[i] === 42 ? numAt(r, i++) : 1;
              ctrl.push([x, y, 0, w]);
            }
            const s = nurbsSamples(deg, knots, ctrl);
            const tmp = [];
            if (s) for (const p of s) tmp.push(...apply(mm, p[0], p[1]));
            else {
              for (const p of ctrl) tmp.push(...apply(mm, p[0], p[1]));
              o.note('partial', 'HATCH');
            }
            pts.push(...(pts.length ? tmp.slice(2) : tmp));
            if (r.codes[i] === 97) {
              const nf = Math.trunc(numAt(r, i++));
              for (let q = 0; q < nf; q++) { at(11); at(21); }
            }
          } else throw new CadError('INVALID');
        }
      }
      if (pts.length >= 6) rings.push(pts);
      // kaynak sınır nesneleri (97 + 330) atlanır: sonraki halka 92 ile başlar
    }
  } catch (e) {
    if (e instanceof CadError && e.code === 'INVALID') {
      o.note('unsupported', 'HATCH');
      return;
    }
    throw e;
  }
  if (!rings.length) {
    o.note('unsupported', 'HATCH');
    return;
  }
  if (!solid) o.note('partial', 'HATCH');
  o.path(ctx, rings, { closed: true, fill: solid });
}
