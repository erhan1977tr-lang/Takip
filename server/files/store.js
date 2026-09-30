// Yüklenen dosyaların saklanması (ADR 0010, CLAUDE.md "Files").
//   1. Dosya önce UPLOAD_DIR/.gelen altına yazılır; bu sırada SHA-256 özeti ve ilk baytlar alınır.
//   2. İçerik uzantıyla uyuşmuyorsa (ör. .pdf adlı ama PDF olmayan dosya) reddedilir.
//   3. Antivirüs açıksa taranır: virüslü → reddedilir; tarayıcıya ulaşılamazsa yönetici ayarına göre
//      reddedilir ya da "taranmadı" (PENDING) işaretlenip kabul edilir (arka plan işçisi sonra tarar).
//   4. Kalıcı yere taşınır: UPLOAD_DIR/YYYY/MM/<rastgele>.<uzantı>. Özgün ad yalnızca veritabanında durur.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getEnv } from '../env.js';
import { checkContent } from './signature.js';
import { scanFile } from './clamav.js';

const HEAD_BYTES = 8192;

export function uploadRoot() {
  return path.resolve(getEnv().UPLOAD_DIR);
}

function safeExt(name) {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ext.length <= 6 ? ext : '';
}

export function cleanFileName(name) {
  const base = path.basename(name || 'dosya').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  return (base || 'dosya').slice(0, 180);
}

/** Depolama anahtarını güvenli bir tam yola çevirir (klasör dışına çıkılamaz). */
export function resolveKey(storageKey) {
  const root = uploadRoot();
  const full = path.resolve(root, storageKey);
  return full.startsWith(root + path.sep) ? full : null;
}

export async function removeUpload(storageKey) {
  const full = resolveKey(storageKey);
  if (full) await fsp.rm(full, { force: true });
}

/** Virüslü çıkan dosyayı karantinaya taşır (UPLOAD_DIR/.karantina); indirilemez. */
export async function quarantine(storageKey) {
  const full = resolveKey(storageKey);
  if (!full) return;
  const dir = path.join(uploadRoot(), '.karantina');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rename(full, path.join(dir, storageKey.replace(/[\\/]/g, '_'))).catch(() => fsp.rm(full, { force: true }));
}

/**
 * Sistemin ürettiği bir dosyayı (ör. Comanda Depozit PDF'i) kalıcı yere yazar. Kullanıcı yüklemesi değildir: taranmaz (SKIPPED).
 * @param {Buffer} buf
 * @param {{ name: string, mime: string }} meta
 */
export async function storeGenerated(buf, meta) {
  const name = cleanFileName(meta.name);
  const now = new Date();
  const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomBytes(16).toString('hex')}${safeExt(name)}`;
  const full = path.join(uploadRoot(), storageKey);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buf, { flag: 'wx' });
  return {
    storageKey, name, size: buf.length, mime: meta.mime, checksum: crypto.createHash('sha256').update(buf).digest('hex'),
    scanStatus: /** @type {const} */ ('SKIPPED'), scanSignature: null, scannedAt: null,
  };
}

/**
 * @typedef {{ storageKey: string, name: string, size: number, mime: string, checksum: string,
 *   scanStatus: 'CLEAN' | 'PENDING' | 'SKIPPED', scanSignature: null, scannedAt: Date | null }} StoredFile
 * @typedef {{ enabled: boolean, host: string, port: number, onUnavailable: 'accept' | 'reject', timeoutMs?: number }} AvSettings
 */

/**
 * @param {Readable | AsyncIterable<Uint8Array> | ReadableStream} source  dosya içeriği
 * @param {{ name: string }} meta
 * @param {{ av?: AvSettings | null, scan?: typeof scanFile }} [opts]
 * @returns {Promise<{ ok: true, file: StoredFile } | { ok: false, code: 'empty' | 'mismatch' | 'infected' | 'av_unavailable', name: string, signature?: string, error?: string }>}
 */
export async function storeUpload(source, meta, { av = null, scan = scanFile } = {}) {
  const name = cleanFileName(meta.name);
  const root = uploadRoot();
  const incoming = path.join(root, '.gelen');
  await fsp.mkdir(incoming, { recursive: true });
  const tmp = path.join(incoming, crypto.randomBytes(16).toString('hex'));

  const hash = crypto.createHash('sha256');
  const headParts = [];
  let headLen = 0;
  let size = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      if (headLen < HEAD_BYTES) {
        headParts.push(chunk.subarray(0, HEAD_BYTES - headLen));
        headLen += Math.min(chunk.length, HEAD_BYTES - headLen);
      }
      cb(null, chunk);
    },
  });
  const input = typeof source?.getReader === 'function' ? Readable.fromWeb(source) : Readable.from(source);
  try {
    await pipeline(input, tap, fs.createWriteStream(tmp, { flags: 'wx' }));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  const fail = async (code, extra = {}) => {
    await fsp.rm(tmp, { force: true });
    return { ok: false, code, name, ...extra };
  };
  if (size === 0) return fail('empty');

  const content = checkContent(name, Buffer.concat(headParts));
  if (!content.ok) return fail('mismatch');

  /** @type {StoredFile['scanStatus']} */
  let scanStatus = 'SKIPPED';
  let scannedAt = null;
  if (av?.enabled) {
    const r = await scan(tmp, { host: av.host, port: av.port, timeoutMs: av.timeoutMs ?? 120_000 });
    if (r.status === 'infected') return fail('infected', { signature: r.signature });
    if (r.status === 'clean') {
      scanStatus = 'CLEAN';
      scannedAt = new Date();
    } else if (av.onUnavailable === 'reject') {
      return fail('av_unavailable', { error: r.error });
    } else {
      scanStatus = 'PENDING'; // taranmadı; işçi sonra tarar
    }
  }

  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const storageKey = `${dir}/${crypto.randomBytes(16).toString('hex')}${safeExt(name)}`;
  const full = path.join(root, storageKey);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.rename(tmp, full);
  return {
    ok: true,
    file: { storageKey, name, size, mime: content.mime, checksum: hash.digest('hex'), scanStatus, scanSignature: null, scannedAt },
  };
}
