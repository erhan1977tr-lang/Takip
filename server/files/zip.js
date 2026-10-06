// Küçük ZIP okuyucu/yazıcı (Excel .xlsx dosyaları için). Dışa bağımlılık yok; node:zlib kullanır.
// Okuma: merkezi dizinden girişler; "stored" (0) ve "deflate" (8) desteklenir.
//
// Güvenlik (denetim 3.50.9 AUD-3, karar 140) — zip bombasına karşı sınır BEYAN EDİLEN boyut değil, GERÇEKTEN açılan bayttır:
//   · bir giriş en çok beyan ettiği kadar açılır (zlib maxOutputLength = beyan); açılan boyut beyanla birebir aynı olmalıdır
//     (beyanı 0 olan ama içi dolu giriş 1 baytta durur ve reddedilir);
//   · giriş başına ve toplamda açılan bayt sınırı (ZIP_LIMITS) açmadan önce beyana, açtıktan sonra gerçeğe uygulanır;
//   · yalnızca istenen girişler açılır (openZip → read); okunmayan giriş (resim, öbür sayfalar) hiç açılmaz;
//   · dizin baştan doğrulanır: giriş sayısı, sınır dışı / üst üste binen veri (aynı veriyi gösteren girişler), yinelenen ad,
//     şifreli giriş, ZIP64 / çok parçalı arşiv reddedilir. Hatalar her zaman ZipError'dur (RangeError sızmaz).
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** @param {Buffer} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {}

/**
 * Varsayılan sınırlar (bayt sınırları AÇILMIŞ gerçek boyuttur).
 *   maxEntries: dizindeki giriş sayısı · maxEntry: tek girişin açılmış boyutu · maxTotal: açılan girişlerin toplamı
 */
export const ZIP_LIMITS = Object.freeze({ maxEntries: 2000, maxEntry: 16 * 1024 * 1024, maxTotal: 32 * 1024 * 1024 });

const SIG_EOCD = 0x06054b50, SIG_CENTRAL = 0x02014b50, SIG_LOCAL = 0x04034b50;

/**
 * ZIP dizinini okur ve doğrular; içerik yalnızca read(ad) ile, sınırlar içinde açılır.
 * @param {Buffer} buf
 * @param {{ maxTotal?: number, maxEntries?: number, maxEntry?: number }} [limits]
 * @returns {{ names: () => string[], has: (name: string) => boolean, read: (name: string) => Buffer | null, inflated: () => number }}
 */
export function openZip(buf, { maxTotal = ZIP_LIMITS.maxTotal, maxEntries = ZIP_LIMITS.maxEntries, maxEntry = ZIP_LIMITS.maxEntry } = {}) {
  if (!Buffer.isBuffer(buf)) throw new ZipError('ZIP değil');
  // Merkezi dizin sonu kaydı (EOCD): sondan geriye aranır (yorum en fazla 65535 bayt)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('ZIP değil');
  const count = buf.readUInt16LE(eocd + 10);
  const cdStart = buf.readUInt32LE(eocd + 16);
  // Çok parçalı arşiv ve ZIP64 (sayılar 0xFFFF / 0xFFFFFFFF ile taşar) desteklenmez
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count) throw new ZipError('desteklenmeyen arşiv');
  if (count === 0xffff || cdStart === 0xffffffff) throw new ZipError('desteklenmeyen arşiv (ZIP64)');
  if (count > maxEntries) throw new ZipError('çok fazla giriş');
  if (cdStart > eocd) throw new ZipError('bozuk merkezi dizin');

  /** @type {Map<string, { method: number, csize: number, usize: number, start: number }>} */
  const index = new Map();
  /** @type {{ from: number, to: number }[]} */
  const spans = [];
  let p = cdStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bozuk merkezi dizin');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen + elen + clen > eocd) throw new ZipError('bozuk merkezi dizin');
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (flags & 0x0001) throw new ZipError('şifreli giriş');
    // Yerel başlık ve veri merkezi dizinden önce, dosyanın içinde olmalı
    if (local + 30 > cdStart || buf.readUInt32LE(local) !== SIG_LOCAL) throw new ZipError('bozuk giriş');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > cdStart) throw new ZipError('bozuk giriş');
    spans.push({ from: local, to: start + csize });
    if (name.endsWith('/')) continue;
    if (index.has(name)) throw new ZipError('yinelenen giriş');
    index.set(name, { method, csize, usize, start });
  }
  // Üst üste binen veri: aynı sıkıştırılmış veriyi gösteren birden çok giriş (küçük dosyadan çok büyük çıktı) reddedilir
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to) throw new ZipError('üst üste binen girişler');

  /** @type {Map<string, Buffer>} */
  const cache = new Map();
  let total = 0;
  /** @param {string} name */
  const read = (name) => {
    const hit = cache.get(name);
    if (hit) return hit;
    const e = index.get(name);
    if (!e) return null;
    // 1) Beyana göre (açmadan): tek giriş ve toplam sınırı
    if (e.usize > maxEntry) throw new ZipError('giriş çok büyük');
    if (total + e.usize > maxTotal) throw new ZipError('açılmış boyut çok büyük');
    const data = buf.subarray(e.start, e.start + e.csize);
    let content;
    if (e.method === 0) content = Buffer.from(data);
    else if (e.method === 8) {
      if (e.csize === 0 && e.usize === 0) content = Buffer.alloc(0);
      else {
        try {
          // 2) Açarken: çıktı beyanı aşarsa zlib durur (en çok bir parça fazlası ayrılır) — beyan 0 ise 1 baytta
          content = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) });
        } catch {
          throw new ZipError('açılamadı');
        }
      }
    } else throw new ZipError(`desteklenmeyen sıkıştırma: ${e.method}`);
    // 3) Açtıktan sonra: gerçek boyut beyanla aynı olmalı; toplam GERÇEK baytla sayılır
    if (content.length !== e.usize) throw new ZipError('bozuk giriş (boyut uyuşmuyor)');
    total += content.length;
    cache.set(name, content);
    return content;
  };
  return { names: () => [...index.keys()], has: (name) => index.has(name), read, inflated: () => total };
}

/**
 * ZIP içindeki BÜTÜN dosyaları okur (sınırlar openZip ile aynı; toplam sınır bütün girişlere uygulanır).
 * @param {Buffer} buf
 * @param {{ maxTotal?: number, maxEntries?: number, maxEntry?: number }} [limits]
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf, limits) {
  const zip = openZip(buf, limits);
  const out = new Map();
  for (const name of zip.names()) out.set(name, /** @type {Buffer} */ (zip.read(name)));
  return out;
}

/**
 * ZIP oluşturur (deflate).
 * @param {{ name: string, data: Buffer | string }[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 adlar
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
