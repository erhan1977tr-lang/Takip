import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

// Yüklenen dosyalar diskte UPLOAD_DIR altında YYYY/MM/<rastgele>.<uzantı> olarak durur.
// Özgün dosya adı yalnızca veritabanında tutulur; diskteki ad tahmin edilemez.

export function uploadRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || './uploads');
}

function safeExt(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ext.length <= 6 ? ext : '';
}

export function cleanFileName(name: string): string {
  const base = path.basename(name || 'dosya').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  return (base || 'dosya').slice(0, 180);
}

export type StoredFile = { storageKey: string; name: string; size: number; mime: string | null };

export async function saveUpload(file: File): Promise<StoredFile> {
  const now = new Date();
  const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const storageKey = `${dir}/${crypto.randomBytes(16).toString('hex')}${safeExt(file.name)}`;
  const full = path.join(uploadRoot(), storageKey);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await pipeline(Readable.fromWeb(file.stream() as unknown as WebReadableStream), fs.createWriteStream(full, { flags: 'wx' }));
  return { storageKey, name: cleanFileName(file.name), size: file.size, mime: file.type || null };
}

/** Depolama anahtarını güvenli bir tam yola çevirir (klasör dışına çıkılamaz). */
export function resolveKey(storageKey: string): string | null {
  const root = uploadRoot();
  const full = path.resolve(root, storageKey);
  return full.startsWith(root + path.sep) ? full : null;
}

export async function removeUpload(storageKey: string): Promise<void> {
  const full = resolveKey(storageKey);
  if (full) await fsp.rm(full, { force: true });
}

/** Formdan gelen dosya alanlarını ayıklar (boş seçimleri atar). */
export function filesFrom(formData: FormData, field: string): File[] {
  return formData.getAll(field).filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0);
}
