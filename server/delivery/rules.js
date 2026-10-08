// Profil teslimatının belgeleri (Paket 8, karar 195–196) — saf kurallar: teslimat fotoğrafları ve teslimat raporu.
//   - Kim: depo bağlantısı (e-postadaki tek kullanımlık adres) ya da yönetici (OFFER_SEND). Yeni rol yok (karar 8, 10).
//   - Ne zaman: sipariş depoya iletildikten sonra (DEPODA, TESLIM_EDILDI, FATURALANDI); iptal / silinmiş siparişte hayır.
//   - Fotoğraf: JPG / JPEG / PNG, en çok 20 MB (depo bağlantısının mevcut sınırı); içerik, antivirüs ve kota mevcut yükleme
//     yolundan geçer (lib/uploads.ts → storeFiles). Her fotoğraf ayrı istektir: biri reddedilirse ötekiler kalır.
//   - Görünürlük: siparişin müşterisi ve siparişi gören iç ekip (karar 195 — ürün sahibinin kararı). Satış / çizim profil
//     siparişini zaten göremez (server/orders/scope.js).
import { can } from '../auth/permissions.js';

export const PHOTO_EXT = Object.freeze(['jpg', 'jpeg', 'png']);
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
/** Fotoğraf ve rapor bu adımlarda eklenir */
export const DELIVERY_DOC_STAGES = Object.freeze(['DEPODA', 'TESLIM_EDILDI', 'FATURALANDI']);
export const REPORT_NOTE_MAX = 1000;
/** Teslimat raporuna gömülecek fotoğraf sınırları (PDF bellek ve süre sınırı) — aşan fotoğraf güvenli bağlantıyla listelenir */
export const REPORT_EMBED = Object.freeze({ photos: 24, totalBytes: 40 * 1024 * 1024, jpegBytes: 12 * 1024 * 1024, pngBytes: 4 * 1024 * 1024, pngPixels: 9_000_000 });

/** Uzantı (noktadan sonrası, küçük harf); noktasız ad uzantısızdır */
const extOf = (name) => {
  const s = String(name ?? '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i + 1).toLowerCase() : '';
};

/**
 * Yüklenecek fotoğrafın sorunu ya da null: 'type' (uzantı) | 'size' (20 MB üstü) | 'empty'.
 * İçerik (gerçekten JPEG / PNG mi) ayrıca yükleme yolunda denetlenir (server/files/signature.js).
 * @param {{ name: string, size: number }} f
 */
export function photoProblem(f) {
  if (!f || !f.name) return 'empty';
  if (!PHOTO_EXT.includes(extOf(f.name))) return 'type';
  if (!(Number(f.size) > 0)) return 'empty';
  if (Number(f.size) > PHOTO_MAX_BYTES) return 'size';
  return null;
}

/** Sipariş teslimat belgesi alabilir mi (adım ve durum) */
export function takesDeliveryDocs({ stage, status, removedAt = null }) {
  return !removedAt && status !== 'IPTAL' && DELIVERY_DOC_STAGES.includes(stage);
}

/**
 * Teslimat belgesini (fotoğraf, rapor) ekleyebilen: depo bağlantısı ya da yönetici. Denetimci, satış, çizim, müşteri hayır.
 * @param {{ role?: string | null, depot?: boolean }} actor
 */
export const canManageDelivery = (actor) => !!actor && (actor.depot === true || (!!actor.role && can(actor.role, 'OFFER_SEND')));

/**
 * Rapor açıklaması: boşluklar sadeleştirilir (satır sonları korunur), en çok REPORT_NOTE_MAX karakter; boşsa null.
 * @param {unknown} v
 */
export function reportNote(v) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, REPORT_NOTE_MAX) : null;
}

/**
 * Raporun kopyası (oluşturulduğu an): sipariş, firma, adım, teslim günü, kalemler, fotoğraflar, açıklama. Virüslü fotoğraf
 * kopyaya girmez. Saf: veritabanı kayıtlarından üretilir.
 * @param {{ order: { orderNo: string, title?: string | null, status: string, customer: { name: string } },
 *   profile: { stage: string, pickupDate?: Date | null, deliveredAt?: Date | null, deliveredVia?: string | null },
 *   items: { code: string, nameTr: string, nameRo: string, unitCode: string, qty: number }[],
 *   photos: { id: string, via: string, createdAt: Date, file: { name: string, size: number, scanStatus: string, uploadedBy?: { name: string | null } | null } }[],
 *   note: string | null, via: string, createdBy: string | null, now: Date }} p
 */
export function reportSnapshot({ order, profile, items, photos, note, via, createdBy, now }) {
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return {
    orderNo: order.orderNo,
    title: order.title ?? null,
    firm: order.customer.name,
    stage: profile.stage,
    pickupDay: day(profile.pickupDate),
    deliveredAt: profile.deliveredAt ? new Date(profile.deliveredAt).toISOString() : null,
    deliveredVia: profile.deliveredVia ?? null,
    items: items.map((i) => ({ code: i.code, nameTr: i.nameTr, nameRo: i.nameRo, unitCode: i.unitCode, qty: i.qty })),
    photos: photos
      .filter((p) => p.file.scanStatus !== 'INFECTED')
      .map((p) => ({ id: p.id, name: p.file.name, size: p.file.size, at: new Date(p.createdAt).toISOString(), via: p.via, by: p.via === 'ADMIN' ? p.file.uploadedBy?.name ?? null : null })),
    note,
    createdAt: now.toISOString(),
    createdVia: via,
    createdBy,
  };
}

/** Kopyanın ayırt edici içeriği (art arda aynı rapor iki kez oluşmasın): adım, günler, kalemler, fotoğraflar, açıklama */
export function reportContentKey(s) {
  return JSON.stringify([s.stage, s.pickupDay, s.deliveredAt, s.items.map((i) => [i.code, i.qty]), s.photos.map((p) => p.id), s.note]);
}

/**
 * Hangi fotoğraflar rapor PDF'ine gömülür (sırayla, sınırlar içinde): temiz / taranmamış (SKIPPED) JPEG ve PNG; bekleyen
 * (PENDING) ve virüslü fotoğraf gömülmez (bağlantıyla listelenir).
 * @param {{ id: string, name: string, size: number, scanStatus: string }[]} photos
 * @returns {Set<string>}
 */
export function photosToEmbed(photos) {
  const out = new Set();
  let total = 0;
  for (const p of photos) {
    if (out.size >= REPORT_EMBED.photos) break;
    if (!['CLEAN', 'SKIPPED'].includes(p.scanStatus)) continue;
    const ext = extOf(p.name);
    const limit = ext === 'png' ? REPORT_EMBED.pngBytes : REPORT_EMBED.jpegBytes;
    if (!(p.size <= limit) || total + p.size > REPORT_EMBED.totalBytes) continue;
    out.add(p.id);
    total += p.size;
  }
  return out;
}
