// ClamAV (clamd) istemcisi — ek paket gerektirmez (node:net). ADR 0010.
// Protokol: https://docs.clamav.net/manual/Usage/Scanning.html#clamd  (z-komutlar: NUL ile biten)
//   zINSTREAM\0  → [4 bayt uzunluk (big-endian)][veri] … [0000]  → "stream: OK" | "stream: <imza> FOUND" | "… ERROR"
//
// Karşı tarafa GÜVENİLMEZ (karar 150; güvenlik denetimi 3.50.9 AUD-12). Tarayıcı güvenilmeyen dosyaları ayrıştırır; ele
// geçirilirse ya da bağlantının öbür ucunda başka bir servis varsa yanıtı düşmanca olabilir. Bu yüzden:
//   - Yanıt en çok REPLY_MAX_BYTES bayt okunur (clamd'nin yanıtı tek kısa satırdır); aşılırsa bağlantı HEMEN kesilir —
//     yanıt belleğe sınırsız alınmaz.
//   - İki ayrı süre sınırı: hareketsizlik (timeoutMs — hiç veri akmıyorsa) ve MUTLAK süre (deadlineMs, en çok
//     SCAN_DEADLINE_MS = 5 dakika — bağlantının tamamı için). Mutlak süre hiçbir şeyle uzamaz: karşı taraf düzenli bayt
//     göndererek hareketsizlik sayacını sıfırlasa da tarama 5 dakikada biter.
//   - Yanıtın biçimi doğrulanır. TEMİZ yalnızca tam olarak "stream: OK" yanıtıdır; "stream: … FOUND" her zaman VİRÜS
//     kararıdır (imza adı güvenli karakterlere ve 200 karaktere indirilir); geri kalan her şey HATADIR — tanınmayan ya da
//     bozuk yanıt hiçbir zaman "temiz" sayılmaz.
//   - Ham metin bu dosyanın dışına çıkmaz: uzak yanıt, ağ hatası metni (ECONNREFUSED …), dosya yolu üst katmanlara
//     verilmez. Hata her zaman AV_ERRORS içindeki sabit kodlardan biridir; ekran bu kodu sabit metne çevirir.
import fs from 'node:fs';
import net from 'node:net';

const CHUNK = 64 * 1024;
/** Tarayıcıdan okunacak en büyük yanıt (bayt) */
export const REPLY_MAX_BYTES = 4096;
/** Bir taramanın (bağlantının tamamının) MUTLAK süre sınırı — hiçbir çağıran bunu aşamaz */
export const SCAN_DEADLINE_MS = 5 * 60_000;
/** PING / VERSION için süre sınırı (hareketsizlik ve mutlak) */
const QUICK_MS = 5000;
/** Saklanan / gösterilen imza adının en büyük uzunluğu */
export const SIGNATURE_MAX = 200;
/**
 * Tarama hatasının sabit kodları (üst katmanlara yalnızca bunlar çıkar):
 *   unreachable        tarayıcıya bağlanılamadı / bağlantı koptu
 *   timeout            hareketsizlik ya da mutlak süre doldu
 *   response-too-large yanıt REPLY_MAX_BYTES'ı aştı
 *   invalid-response   yanıt clamd yanıtı biçiminde değil (başka bir servis, bozuk yanıt)
 *   scanner-error      clamd hata bildirdi ("… ERROR") ya da tanınmayan bir hata
 *   file-not-found     taranacak dosya diskte yok
 *   file-error         taranacak dosya okunamadı
 */
export const AV_ERRORS = Object.freeze(['unreachable', 'timeout', 'response-too-large', 'invalid-response', 'scanner-error', 'file-not-found', 'file-error']);

class ClamError extends Error {
  /** @param {string} code  AV_ERRORS içinden */
  constructor(code) {
    super(code);
    this.name = 'ClamError';
    this.code = code;
  }
}

const FILE_ERRNO = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'ELOOP', 'ENAMETOOLONG']);

/**
 * Her hatayı / hata metnini sabit koda çevirir. Bilinen kod aynen döner; ham metin (ör. "ECONNREFUSED: connect …") hiçbir
 * zaman geri verilmez.
 * @param {unknown} e  Error, kod ya da başka bir değer
 * @returns {string}  AV_ERRORS içinden
 */
export function avErrorCode(e) {
  if (typeof e === 'string') return AV_ERRORS.includes(e) ? e : 'scanner-error';
  if (e instanceof ClamError) return e.code;
  const errno = String(/** @type {any} */ (e)?.code ?? '');
  if (errno === 'ENOENT') return 'file-not-found';
  if (errno === 'ETIMEDOUT') return 'timeout';
  if (FILE_ERRNO.has(errno)) return 'file-error';
  return 'unreachable';
}

/**
 * İmza adı: yalnızca güvenli, yazdırılabilir karakterler; en çok SIGNATURE_MAX. Öteki her karakter "?" olur.
 * @param {unknown} value
 * @returns {string}
 */
export function safeSignature(value) {
  const s = String(value ?? '').replace(/[^A-Za-z0-9._:+/(){}[\] -]/g, '?').replace(/ {2,}/g, ' ').trim().slice(0, SIGNATURE_MAX).trim();
  return s || 'UNKNOWN';
}

/**
 * Geçerli mutlak süre: verilen değer SCAN_DEADLINE_MS'i (5 dakika) AŞAMAZ; verilmemişse / geçersizse 5 dakikadır.
 * @param {unknown} ms
 * @returns {number}
 */
export function deadlineOf(ms) {
  return Math.min(Math.max(1, Number(ms) || SCAN_DEADLINE_MS), SCAN_DEADLINE_MS);
}

/** Yanıt metni: sondaki NUL / satır sonu ayırıcıları atılır (baytlar bire bir karaktere çevrilir) */
const lineOf = (reply) => (Buffer.isBuffer(reply) ? reply.toString('latin1') : String(reply ?? '')).replace(/[\0\r\n]+$/, '');

/**
 * clamd'ye bağlanır, isteği gönderir, yanıtın ham baytlarını (en çok REPLY_MAX_BYTES) döndürür.
 * @param {{ host: string, port: number, timeoutMs?: number, deadlineMs?: number }} opts
 *   timeoutMs: hareketsizlik sınırı · deadlineMs: mutlak sınır (SCAN_DEADLINE_MS'ten büyük olamaz)
 * @param {(socket: net.Socket) => Promise<void>} send
 * @returns {Promise<Buffer>}
 */
function talk({ host, port, timeoutMs = 60_000, deadlineMs = SCAN_DEADLINE_MS }, send) {
  const hardMs = deadlineOf(deadlineMs);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let size = 0;
    let settled = false;
    let hard = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    // Mutlak süre: veri akışından bağımsızdır, hiçbir olayla yeniden başlamaz
    hard = setTimeout(() => finish(new ClamError('timeout')), hardMs);
    // Hareketsizlik: her okuma / yazma ile yeniden başlar
    socket.setTimeout(timeoutMs, () => finish(new ClamError('timeout')));
    socket.on('error', (e) => finish(e));
    socket.on('data', (d) => {
      size += d.length;
      // Sınır aşıldı: parça saklanmaz, bağlantı kesilir (finish → destroy)
      if (size > REPLY_MAX_BYTES) return finish(new ClamError('response-too-large'));
      chunks.push(d);
    });
    socket.on('end', () => finish(null, Buffer.concat(chunks)));
    socket.on('connect', () => {
      send(socket).catch((e) => finish(e));
    });
  });
}

function write(socket, buf) {
  return new Promise((resolve, reject) => {
    socket.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Tek bir clamd INSTREAM yanıtını sonuca çevirir. Kural bilerek dardır:
 *   "stream: OK" (tam olarak)  → temiz
 *   "stream: <imza> FOUND"      → virüs (imza adı temizlenir; içinde ne olursa olsun karar VİRÜS kalır)
 *   "… ERROR"                   → hata: scanner-error
 *   geri kalan her şey          → hata: invalid-response (hiçbir zaman "temiz" değil)
 * @param {Buffer | string} reply
 * @returns {{ status: 'clean' } | { status: 'infected', signature: string } | { status: 'error', error: string }}
 */
export function parseReply(reply) {
  const text = lineOf(reply);
  if (text === 'stream: OK') return { status: 'clean' };
  const m = /^stream: ([\s\S]+) FOUND$/.exec(text);
  if (m) return { status: 'infected', signature: safeSignature(m[1]) };
  if (/^[\x20-\x7E]{1,300} ERROR$/.test(text)) return { status: 'error', error: 'scanner-error' };
  return { status: 'error', error: 'invalid-response' };
}

/**
 * Bir akışı (Buffer parçaları) tarar. Hata her zaman sabit koddur (AV_ERRORS).
 * @param {AsyncIterable<Buffer> | Iterable<Buffer>} source
 * @param {{ host: string, port: number, timeoutMs?: number, deadlineMs?: number }} opts
 * @returns {Promise<{ status: 'clean' } | { status: 'infected', signature: string } | { status: 'error', error: string }>}
 */
export async function scanStream(source, opts) {
  try {
    const reply = await talk(opts, async (socket) => {
      await write(socket, Buffer.from('zINSTREAM\0'));
      for await (const part of source) {
        for (let i = 0; i < part.length; i += CHUNK) {
          const piece = part.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(piece.length);
          await write(socket, Buffer.concat([len, piece]));
        }
      }
      await write(socket, Buffer.alloc(4)); // bitiş
    });
    return parseReply(reply);
  } catch (e) {
    return { status: 'error', error: avErrorCode(e) };
  }
}

/**
 * Diskteki bir dosyayı tarar. Dosya ÖNCE açılır: yoksa / açılamıyorsa tarayıcıya hiç bağlanılmaz ve sonuç sabit koddur
 * (file-not-found / file-error) — açma hatası sahipsiz bir akış olayı olarak süreci düşüremez. Dosya her durumda kapatılır
 * (tarayıcıya ulaşılamasa da açık dosya kalmaz).
 * @param {string} file
 * @param {{ host: string, port: number, timeoutMs?: number, deadlineMs?: number }} opts
 */
export async function scanFile(file, opts) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (e) {
    return { status: 'error', error: /** @type {any} */ (e)?.code === 'ENOENT' ? 'file-not-found' : 'file-error' };
  }
  try {
    if (!(await handle.stat()).isFile()) return { status: 'error', error: 'file-error' };
    return await scanStream(handle.createReadStream({ highWaterMark: CHUNK, autoClose: false }), opts);
  } catch {
    return { status: 'error', error: 'file-error' };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Tek bir Buffer'ı tarar. */
export function scanBuffer(buf, opts) {
  return scanStream([buf], opts);
}

/** clamd ayakta mı? → true/false (yalnızca tam olarak "PONG" yanıtı) */
export async function ping(opts) {
  try {
    return lineOf(await talk({ timeoutMs: QUICK_MS, deadlineMs: QUICK_MS, ...opts }, (s) => write(s, Buffer.from('zPING\0')))) === 'PONG';
  } catch {
    return false;
  }
}

// "ClamAV 1.4.1/27412/Tue Sep 29 08:21:03 2026": sürüm / imza sayısı / tarih — her parça dar bir kalıba uymalıdır
const VERSION_RE = /^ClamAV ([0-9][0-9A-Za-z.+-]{0,40})(?:\/(\d{1,12})(?:\/([A-Za-z0-9: ]{1,40}))?)?$/;

/**
 * "ClamAV 1.4.1/27412/Tue Sep 29 08:21:03 2026" → { engine, signatures, signaturesDate }. Kalıba uymayan yanıt hatadır
 * (invalid-response): ekranda gösterilen sürüm bilgisi hiçbir zaman serbest uzak metin değildir. Yanıtın ham hâli
 * döndürülmez — yalnızca kalıptan çıkan parçalar.
 * @returns {Promise<{ engine: string, signatures: number | null, signaturesDate: string | null }>}
 */
export async function version(opts) {
  const m = VERSION_RE.exec(lineOf(await talk({ timeoutMs: QUICK_MS, deadlineMs: QUICK_MS, ...opts }, (s) => write(s, Buffer.from('zVERSION\0')))));
  if (!m) throw new ClamError('invalid-response');
  return { engine: `ClamAV ${m[1]}`, signatures: m[2] ? Number(m[2]) : null, signaturesDate: m[3]?.trim() || null };
}

/**
 * EICAR test dizisi (zararsız, tüm antivirüslerin "virüs" dediği standart test dosyası). Kaynak kodda parçalı
 * durur ki depo taranırken yanlışlıkla virüs sanılmasın.
 */
export function eicar() {
  return Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''));
}
