// ClamAV (clamd) istemcisi — ek paket gerektirmez (node:net). ADR 0010.
// Protokol: https://docs.clamav.net/manual/Usage/Scanning.html#clamd  (z-komutlar: NUL ile biten)
//   zINSTREAM\0  → [4 bayt uzunluk (big-endian)][veri] … [0000]  → "stream: OK" | "stream: <imza> FOUND" | "… ERROR"
import fs from 'node:fs';
import net from 'node:net';

const CHUNK = 64 * 1024;

/**
 * clamd'ye bağlanır, isteği gönderir, cevabı (NUL/yeni satır hariç) döndürür.
 * @param {{ host: string, port: number, timeoutMs?: number }} opts
 * @param {(socket: net.Socket) => Promise<void>} send
 */
function talk({ host, port, timeoutMs = 60_000 }, send) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error('clamd zaman aşımı'), { code: 'ETIMEDOUT' })));
    socket.on('error', (e) => finish(e));
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8').replace(/[\0\n]+$/, '').trim()));
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

/** Tek bir clamd cevabını sonuca çevirir. */
export function parseReply(reply) {
  const text = String(reply || '').trim();
  const m = /^(?:stream|[^:]*): (.*) FOUND$/.exec(text);
  if (m) return { status: 'infected', signature: m[1].trim() };
  if (/: OK$/.test(text)) return { status: 'clean' };
  return { status: 'error', error: text || 'boş cevap' };
}

/**
 * Bir akışı (Buffer parçaları) tarar.
 * @param {AsyncIterable<Buffer> | Iterable<Buffer>} source
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
    return { status: 'error', error: e?.code ? `${e.code}: ${e.message}` : String(e?.message || e) };
  }
}

/** Diskteki bir dosyayı tarar. */
export function scanFile(file, opts) {
  return scanStream(fs.createReadStream(file, { highWaterMark: CHUNK }), opts);
}

/** Tek bir Buffer'ı tarar. */
export function scanBuffer(buf, opts) {
  return scanStream([buf], opts);
}

/** clamd ayakta mı? → true/false */
export async function ping(opts) {
  try {
    return (await talk({ timeoutMs: 5000, ...opts }, (s) => write(s, Buffer.from('zPING\0')))) === 'PONG';
  } catch {
    return false;
  }
}

/** "ClamAV 1.4.1/27412/Tue Sep 29 08:21:03 2026" → { engine, signatures, signaturesDate } */
export async function version(opts) {
  const raw = await talk({ timeoutMs: 5000, ...opts }, (s) => write(s, Buffer.from('zVERSION\0')));
  const [engine, signatures, date] = raw.split('/');
  return { raw, engine: engine?.trim() ?? raw, signatures: signatures ? Number(signatures) : null, signaturesDate: date?.trim() ?? null };
}

/**
 * EICAR test dizisi (zararsız, tüm antivirüslerin "virüs" dediği standart test dosyası). Kaynak kodda parçalı
 * durur ki depo taranırken yanlışlıkla virüs sanılmasın.
 */
export function eicar() {
  return Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''));
}
