// Antivirüs ayarları (yönetici → Entegrasyonlar) ve arka planda bekleyen dosyaların taranması (ADR 0010).
import { getEnv } from '../env.js';
import { outboxEvent } from '../domain/outbox.js';
import { enqueueOutbox, writeAudit } from '../orders/journal.js';
import { ping, scanFile, version } from './clamav.js';
import { quarantine, resolveKey } from './store.js';

export const AV_KEY = 'antivirus';
const ENTITY = { orderFile: 'OrderFile', drawing: 'Drawing', drawingFile: 'DrawingFile', orderDraftFile: 'OrderDraftFile' };
export const AV_STATUS_KEY = 'antivirus.status';

/**
 * Geçerli ayarlar. Veritabanında kayıt yoksa ortamdan: CLAMAV_HOST tanımlıysa açık.
 * @returns {Promise<{ enabled: boolean, host: string, port: number, onUnavailable: 'accept' | 'reject', timeoutMs: number, fromDb: boolean }>}
 */
export async function getAvSettings(db, env = getEnv()) {
  const row = await db.integrationSetting.findUnique({ where: { key: AV_KEY } });
  const v = (row?.value && typeof row.value === 'object' ? row.value : {});
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : !!env.CLAMAV_HOST,
    host: (typeof v.host === 'string' && v.host) || env.CLAMAV_HOST || 'clamav',
    port: Number(v.port) || env.CLAMAV_PORT || 3310,
    // Ürün sahibinin kararı: tarayıcıya ulaşılamazsa dosya kabul edilir, "taranmadı" işaretlenir, sonra taranır
    onUnavailable: v.onUnavailable === 'reject' ? 'reject' : 'accept',
    timeoutMs: 120_000,
    fromDb: !!row,
  };
}

/**
 * Ayarları kaydeder ve denetim kaydına yazar (önce/sonra).
 * @param {{ enabled: boolean, host: string, port: number, onUnavailable: 'accept' | 'reject' }} value
 * @param {{ id: string, role: string, ip?: string | null }} actor
 */
export async function saveAvSettings(db, value, actor) {
  const clean = {
    enabled: !!value.enabled,
    host: String(value.host || '').trim().slice(0, 200) || 'clamav',
    port: Math.min(65535, Math.max(1, Math.trunc(Number(value.port) || 3310))),
    onUnavailable: value.onUnavailable === 'reject' ? 'reject' : 'accept',
  };
  return db.$transaction(async (tx) => {
    const before = await tx.integrationSetting.findUnique({ where: { key: AV_KEY } });
    await tx.integrationSetting.upsert({
      where: { key: AV_KEY },
      create: { key: AV_KEY, value: clean, updatedById: actor.id },
      update: { value: clean, updatedById: actor.id },
    });
    await writeAudit(tx, {
      action: 'SETTINGS_UPDATE', entityType: 'IntegrationSetting', entityId: AV_KEY, userId: actor.id,
      details: { before: before?.value ?? null, after: clean },
    }, actor);
    return clean;
  });
}

/**
 * Bağlantı durumu: ulaşılıyor mu, motor ve imza veritabanı sürümü.
 * @returns {Promise<{ reachable: boolean, raw?: string, engine?: string, signatures?: number | null, signaturesDate?: string | null, error?: string }>}
 */
export async function avHealth(settings) {
  const opts = { host: settings.host, port: settings.port };
  if (!(await ping(opts))) return { reachable: false };
  try {
    return { reachable: true, ...(await version(opts)) };
  } catch (e) {
    return { reachable: true, error: String(e?.message || e) };
  }
}

/**
 * Taranmamış (PENDING) dosyaları tarar. Tarayıcıya ulaşılamazsa durur (sonraki turda yeniden denenir).
 * Virüslü dosya karantinaya alınır, INFECTED işaretlenir, denetim kaydı ve bildirim kuyruğuna yazılır.
 * @returns {Promise<{ scanned: number, clean: number, infected: number, missing: number, stopped: string | null }>}
 */
export async function scanPending(db, settings, { limit = 25, scan = scanFile, log = () => {} } = {}) {
  const out = { scanned: 0, clean: 0, infected: 0, missing: 0, stopped: null };
  if (!settings.enabled) return { ...out, stopped: 'disabled' };
  const files = await db.orderFile.findMany({ where: { scanStatus: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: limit });
  // Çizim sürümlerinin dosyaları; eski düzende sürümün kendi dosyası (taşıma adımından önce kalmış olabilir)
  const drawingFiles = await db.drawingFile.findMany({ where: { scanStatus: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: limit, include: { drawing: { select: { orderId: true, version: true } } } });
  const drawings = await db.drawing.findMany({ where: { scanStatus: 'PENDING', fileUrl: { not: null } }, orderBy: { createdAt: 'asc' }, take: limit });
  // Taslak siparişin dosyaları da taranır (gönderilince tarama sonucuyla siparişe geçer)
  const draftFiles = await db.orderDraftFile.findMany({ where: { scanStatus: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: limit });
  const items = [
    ...files.map((f) => ({ model: 'orderFile', id: f.id, orderId: f.orderId, key: f.storageKey, name: f.name })),
    ...drawingFiles.map((f) => ({ model: 'drawingFile', id: f.id, orderId: f.drawing.orderId, key: f.storageKey, name: `v${f.drawing.version} · ${f.name}` })),
    ...drawings.map((d) => ({ model: 'drawing', id: d.id, orderId: d.orderId, key: d.fileUrl, name: d.fileName || `v${d.version}` })),
    ...draftFiles.map((f) => ({ model: 'orderDraftFile', id: f.id, orderId: null, key: f.storageKey, name: f.name })),
  ];
  for (const it of items) {
    const full = resolveKey(it.key);
    if (!full) continue;
    const r = await scan(full, { host: settings.host, port: settings.port, timeoutMs: settings.timeoutMs });
    if (r.status === 'error') {
      // Dosya diskte yoksa bir daha denenmez; başka hata (clamd kapalı) → dur, sonra yeniden dene
      if (/ENOENT/.test(r.error)) {
        await db[it.model].update({ where: { id: it.id }, data: { scanStatus: 'SKIPPED', scannedAt: new Date() } });
        out.missing++;
        continue;
      }
      out.stopped = r.error;
      log(`tarama durdu: ${r.error}`);
      break;
    }
    out.scanned++;
    if (r.status === 'clean') {
      await db[it.model].update({ where: { id: it.id }, data: { scanStatus: 'CLEAN', scannedAt: new Date() } });
      out.clean++;
      continue;
    }
    out.infected++;
    await quarantine(it.key);
    await db.$transaction(async (tx) => {
      await tx[it.model].update({ where: { id: it.id }, data: { scanStatus: 'INFECTED', scanSignature: r.signature, scannedAt: new Date() } });
      await writeAudit(tx, {
        action: 'FILE_INFECTED', entityType: ENTITY[it.model], entityId: it.id,
        details: { orderId: it.orderId, name: it.name, signature: r.signature, when: 'arka plan taraması' },
      });
      await enqueueOutbox(tx, outboxEvent('FILE_INFECTED', { orderId: it.orderId, payload: { name: it.name, signature: r.signature } }));
    });
    log(`virüs: ${it.name} (${r.signature}) karantinaya alındı`);
  }
  return out;
}
