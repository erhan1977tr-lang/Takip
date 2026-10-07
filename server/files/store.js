// Yüklenen dosyaların saklanması (ADR 0010, CLAUDE.md "Files").
//   1. Dosya önce UPLOAD_DIR/.gelen altına yazılır; bu sırada SHA-256 özeti ve ilk baytlar alınır.
//   2. İçerik uzantıyla uyuşmuyorsa (ör. .pdf adlı ama PDF olmayan dosya) reddedilir.
//   3. Antivirüs açıksa taranır: virüslü → reddedilir; tarayıcıya ulaşılamazsa yönetici ayarına göre
//      reddedilir ya da "taranmadı" (PENDING) işaretlenip kabul edilir (arka plan işçisi sonra tarar).
//   4. Kalıcı yere taşınır: UPLOAD_DIR/YYYY/MM/<rastgele>.<uzantı>. Özgün ad yalnızca veritabanında durur.
// GO-LIVE saldırı turu NEW-GL-02 (karar 153):
//   - Dosya adı ÖNCE güvenli hale getirilir; içerik denetimi KISALTILMAMIŞ adın uzantısıyla yapılır ve uzun ad kısaltılırken
//     uzantı korunur. Böylece çağıranın ham ada göre yaptığı tür denetimi, içerik denetimi ve saklanan ad aynı uzantıyı görür
//     (kısaltma yeni bir "uzantı" üretemez).
//   - Geçici dosya (.gelen) HER çıkışta silinir: ret, tarama / taşıma hatası ya da beklenmeyen hata (try / finally).
//   - Bir isteğin dosyaları ya hep ya hiç saklanır (storeUploads): biri reddedilir ya da hata verirse öncekiler de silinir.
//   - Silme başarısız olursa işlem bozulmaz; yalnızca aşama + hata kodu bildirilir (yol, dosya adı, hata metni bildirilmez).
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getEnv } from '../env.js';
import { checkContent } from './signature.js';
import { avErrorCode, safeSignature, scanFile } from './clamav.js';

const HEAD_BYTES = 8192;

export function uploadRoot() {
  return path.resolve(getEnv().UPLOAD_DIR);
}

function safeExt(name) {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ext.length <= 6 ? ext : '';
}

/** Saklanan dosya adının en büyük uzunluğu (karakter) */
export const FILE_NAME_MAX = 180;

/** Klasör bölümü atılmış, denetim karakterleri ve yol / kabuk işaretleri "_" yapılmış ad (kısaltılmamış) */
function safeBase(name) {
  const raw = typeof name === 'string' && name ? name : 'dosya';
  return path.basename(raw).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim() || 'dosya';
}

/** Adın sonundaki olağan uzantı (nokta + 1–10 harf / rakam); yoksa boş */
function shortExt(base) {
  const dot = base.lastIndexOf('.');
  if (dot < 0 || base.length - dot > 11) return '';
  const ext = base.slice(dot);
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/** Güvenli adı en çok FILE_NAME_MAX karaktere indirir: gövde kısalır, UZANTI korunur; yarım vekil çift bırakılmaz */
function shorten(base) {
  if (base.length <= FILE_NAME_MAX) return base;
  const ext = shortExt(base);
  let stem = base.slice(0, FILE_NAME_MAX - ext.length);
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return stem + ext;
}

/**
 * Saklanacak (gösterilecek) dosya adı: güvenli karakterler, en çok 180 karakter. Uzun adda uzantı korunur —
 * "….constructor.pdf" kısaltılınca ".constructor" ile bitmez (NEW-GL-02).
 * @param {unknown} name
 */
export function cleanFileName(name) {
  return shorten(safeBase(name));
}

/**
 * Temizlik (silme) hatasının varsayılan bildirimi: yalnızca aşama ve hata kodu. Yol, dosya adı ve hata metni YAZILMAZ.
 * @param {{ stage: 'temp' | 'stored', code: string }} f
 */
export function reportCleanupFailure(f) {
  console.error(`Yükleme temizliği başarısız (${f.stage === 'stored' ? 'saklanan dosya' : 'geçici dosya'}): ${f.code}`);
}

/** Hata nesnesinden güvenli kod (ör. EACCES); tanınmıyorsa UNKNOWN — hata metni ve yol hiçbir yere taşınmaz */
const errnoCode = (e) => (typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(e.code) ? e.code : 'UNKNOWN');

/**
 * Temizlik hatalarını toplar; denetim kaydına girecek özeti verir: yalnızca sayı, aşama(lar) ve hata kod(lar)ı.
 * Gelen değerler yeniden süzülür (aşama iki sabit değerden biri, kod güvenli biçimde değilse UNKNOWN): özet hiçbir
 * koşulda yol, dosya adı ya da hata metni taşımaz.
 * @param {(f: CleanupFailure) => void} [log]  her hata için günlük (varsayılan: sabit metin + kod)
 */
export function cleanupCollector(log = reportCleanupFailure) {
  /** @type {Set<'temp' | 'stored'>} */
  const stages = new Set();
  /** @type {Set<string>} */
  const codes = new Set();
  let count = 0;
  return {
    /** @param {CleanupFailure} f */
    report(f) {
      const safe = { stage: /** @type {'temp' | 'stored'} */ (f?.stage === 'stored' ? 'stored' : 'temp'), code: errnoCode(f) };
      count++;
      stages.add(safe.stage);
      if (codes.size < 8) codes.add(safe.code);
      try {
        log(safe);
      } catch {
        // günlük yazılamasa da işlem sürer
      }
    },
    /** @returns {{ count: number, stages: string[], codes: string[] } | null} */
    summary() {
      return count === 0 ? null : { count, stages: [...stages].sort(), codes: [...codes].sort() };
    },
  };
}

/** Dosyayı siler; HİÇBİR ZAMAN hata fırlatmaz. Silinemezse bildirir ve false döner. */
async function removeQuietly(full, stage, report, rm) {
  try {
    await rm(full, { force: true });
    return true;
  } catch (e) {
    try {
      report({ stage, code: errnoCode(e) });
    } catch {
      // bildirimin kendisi de işlemi bozamaz
    }
    return false;
  }
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
 * @typedef {{ stage: 'temp' | 'stored', code: string }} CleanupFailure
 * @typedef {{ av?: AvSettings | null, scan?: typeof scanFile, onCleanupFailure?: (f: CleanupFailure) => void,
 *   io?: { rm?: typeof fsp.rm, rename?: typeof fsp.rename } }} StoreOptions
 * @typedef {{ ok: false, code: 'empty' | 'mismatch' | 'infected' | 'av_unavailable', name: string, signature?: string, error?: string }} StoreRejection
 */

/**
 * Tek dosyayı saklar. Dönüş ne olursa olsun (ret ya da hata) geçici dosya silinir; yalnızca kabul edilen dosya kalıcı yere taşınır.
 * @param {Readable | AsyncIterable<Uint8Array> | ReadableStream} source  dosya içeriği
 * @param {{ name: string }} meta
 * @param {StoreOptions} [opts]  io: testler için (silme / taşıma)
 * @returns {Promise<{ ok: true, file: StoredFile } | StoreRejection>}
 */
export async function storeUpload(source, meta, { av = null, scan = scanFile, onCleanupFailure = reportCleanupFailure, io = {} } = {}) {
  const rm = io.rm ?? fsp.rm;
  const rename = io.rename ?? fsp.rename;
  // 1) Ad: güvenli hale getir → tür kararı KISALTILMAMIŞ adın uzantısıyla → saklanan ad kısaltılır (uzantı korunur)
  const fullName = safeBase(meta?.name);
  const name = shorten(fullName);
  const root = uploadRoot();
  const incoming = path.join(root, '.gelen');
  await fsp.mkdir(incoming, { recursive: true });
  const tmp = path.join(incoming, crypto.randomBytes(16).toString('hex'));
  /** @returns {StoreRejection} */
  const reject = (code, extra = {}) => ({ ok: false, code, name, ...extra });

  let moved = false;
  try {
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
    await pipeline(input, tap, fs.createWriteStream(tmp, { flags: 'wx' }));
    if (size === 0) return reject('empty');

    // 2) İçerik, adın (kısaltılmamış) uzantısıyla uyuşmalı
    const content = checkContent(fullName, Buffer.concat(headParts));
    if (!content.ok) return reject('mismatch');

    /** @type {StoredFile['scanStatus']} */
    let scanStatus = 'SKIPPED';
    let scannedAt = null;
    if (av?.enabled) {
      const r = await scan(tmp, { host: av.host, port: av.port, timeoutMs: av.timeoutMs ?? 120_000 });
      // İmza adı güvenli karakterlere / 200 karaktere indirilir; hata yalnızca sabit koddur (karar 150)
      if (r.status === 'infected') return reject('infected', { signature: safeSignature(r.signature) });
      if (r.status === 'clean') {
        scanStatus = 'CLEAN';
        scannedAt = new Date();
      } else if (av.onUnavailable === 'reject') {
        return reject('av_unavailable', { error: avErrorCode(r.error) });
      } else {
        scanStatus = 'PENDING'; // taranmadı; işçi sonra tarar
      }
    }

    // 3) Kalıcı yere taşı (özet taşımadan önce hesaplanır: taşıdıktan sonra hata verebilecek adım kalmaz)
    const checksum = hash.digest('hex');
    const now = new Date();
    const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const storageKey = `${dir}/${crypto.randomBytes(16).toString('hex')}${safeExt(name)}`;
    const full = path.join(root, storageKey);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await rename(tmp, full);
    moved = true;
    return { ok: true, file: { storageKey, name, size, mime: content.mime, checksum, scanStatus, scanSignature: null, scannedAt } };
  } finally {
    // Ret, tarama / taşıma hatası, kaynak akışın kopması, beklenmeyen hata: geçici dosya kalmaz
    if (!moved) await removeQuietly(tmp, 'temp', onCleanupFailure, rm);
  }
}

/**
 * Saklanmış dosyaları siler (kaydı oluşmayacak yüklemeler). Hiçbir zaman hata fırlatmaz; silinemeyen dosya sayısını döndürür.
 * @param {{ storageKey: string }[]} files
 * @param {{ onCleanupFailure?: (f: CleanupFailure) => void, rm?: typeof fsp.rm }} [opts]
 * @returns {Promise<number>}
 */
export async function discardStored(files, { onCleanupFailure = reportCleanupFailure, rm = fsp.rm } = {}) {
  let failed = 0;
  for (const f of files ?? []) {
    let full = null;
    try {
      full = resolveKey(f.storageKey);
    } catch {
      full = null;
    }
    if (full && !(await removeQuietly(full, 'stored', onCleanupFailure, rm))) failed++;
  }
  return failed;
}

/**
 * Bir isteğin dosyalarını sırayla saklar: ya HEPSİ saklanır ya HİÇBİRİ. Biri reddedilirse ya da saklanırken hata olursa
 * (akış koptu, disk doldu, taşınamadı…) o ana kadar saklananlar da silinir — kaydı olmayan dosya kalıcı yerde kalmaz.
 * @param {{ name: string, stream: () => Readable | AsyncIterable<Uint8Array> | ReadableStream }[]} files
 * @param {StoreOptions & { store?: typeof storeUpload }} [opts]
 * @returns {Promise<{ ok: true, files: StoredFile[] } | { ok: false, problem: StoreRejection }>}
 */
export async function storeUploads(files, { store = storeUpload, ...opts } = {}) {
  const onCleanupFailure = opts.onCleanupFailure ?? reportCleanupFailure;
  const rm = opts.io?.rm ?? fsp.rm;
  /** @type {StoredFile[]} */
  const stored = [];
  try {
    for (const f of files) {
      const r = await store(f.stream(), { name: f.name }, opts);
      if (!r.ok) {
        await discardStored(stored, { onCleanupFailure, rm });
        return { ok: false, problem: r };
      }
      stored.push(r.file);
    }
  } catch (e) {
    await discardStored(stored, { onCleanupFailure, rm });
    throw e;
  }
  return { ok: true, files: stored };
}
