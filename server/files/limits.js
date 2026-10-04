// Yükleme sınırları (güvenlik denetimi SEC-05, karar 119): giriş yapmış bir kullanıcı sunucunun diskini dolduramasın.
// Tek kapı: lib/uploads.ts → storeFiles, dosyalar diske yazılmadan ve antivirüse gitmeden ÖNCE checkUpload'ı çağırır.
// Ek tablo / Redis yok: kota, zaten var olan dosya satırlarından (OrderFile, OrderDraftFile, DrawingFile) hesaplanır.
//
//   Dosya başına        : 100 MB (karar 15) · depo bağlantısı ve teslim belgesi kendi 20 MB sınırını korur (çağıran denetler)
//   İstek başına        : en çok 20 dosya
//   Sipariş başına      : toplam 2 GB / 400 dosya (sipariş dosyaları + çizim dosyaları)
//   Depo bağlantısı     : sipariş başına toplam 200 MB / 40 dosya (giriş gerektirmeyen adres)
//   Müşteri (firma)     : saatte 120 dosya / 1 GB, 24 saatte 3 GB — firmanın bütün kullanıcıları birlikte sayılır
//   İç ekip (kullanıcı) : saatte 400 dosya / 4 GB, 24 saatte 12 GB
//   Disk                : yükleme klasöründe boş alan UPLOAD_MIN_FREE_MB'ın (varsayılan 1024) altına inecekse reddedilir
// Hiçbir dosya otomatik silinmez; sınır yalnızca YENİ yüklemeyi reddeder.
import fsp from 'node:fs/promises';
import { MAX_FILE_BYTES } from '../orders/rules.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const UPLOAD_LIMITS = Object.freeze({
  requestFiles: 20,
  fileBytes: MAX_FILE_BYTES,
  order: Object.freeze({ bytes: 2 * GB, files: 400 }),
  depotOrder: Object.freeze({ bytes: 200 * MB, files: 40 }),
  customer: Object.freeze({ hourFiles: 120, hourBytes: 1 * GB, dayBytes: 3 * GB }),
  staff: Object.freeze({ hourFiles: 400, hourBytes: 4 * GB, dayBytes: 12 * GB }),
});

const sum = (rows) => rows.reduce((n, r) => n + Number(r.size || 0), 0);

/**
 * Saf karar: yükleme kabul edilir mi? Sorun yoksa null. Metinler: files.problem.<code>.
 * @param {object} p
 * @param {{ name: string, size: number }[]} p.files            yüklenmek istenen dosyalar
 * @param {{ size: number }[] | null} [p.order]                 siparişin (ya da depo bağlantısının) var olan dosyaları
 * @param {{ size: number, createdAt: Date | string | number }[] | null} [p.recent]  yükleyenin son 24 saatteki dosyaları
 * @param {'customer' | 'staff' | 'depot'} p.kind
 * @param {number | null} [p.freeBytes]                         yükleme klasöründeki boş alan (bilinmiyorsa null)
 * @param {number} [p.minFreeBytes]
 * @param {number} [p.now]
 * @param {typeof UPLOAD_LIMITS} [p.limits]
 * @returns {{ code: 'too_many' | 'size' | 'rate' | 'order_quota' | 'disk', name: string } | null}
 */
export function uploadVerdict({ files, order = null, recent = null, kind, freeBytes = null, minFreeBytes = 0, now = Date.now(), limits = UPLOAD_LIMITS }) {
  if (!files.length) return null;
  if (files.length > limits.requestFiles) return { code: 'too_many', name: '' };
  const big = files.find((f) => !(Number(f.size) <= limits.fileBytes));
  if (big) return { code: 'size', name: big.name };
  const incoming = sum(files);

  if (recent && kind !== 'depot') {
    const q = kind === 'customer' ? limits.customer : limits.staff;
    const day = recent.filter((r) => now - new Date(r.createdAt).getTime() < DAY_MS);
    const hour = day.filter((r) => now - new Date(r.createdAt).getTime() < HOUR_MS);
    if (hour.length + files.length > q.hourFiles || sum(hour) + incoming > q.hourBytes || sum(day) + incoming > q.dayBytes) return { code: 'rate', name: '' };
  }
  if (order) {
    const q = kind === 'depot' ? limits.depotOrder : limits.order;
    if (order.length + files.length > q.files || sum(order) + incoming > q.bytes) return { code: 'order_quota', name: '' };
  }
  if (freeBytes !== null && minFreeBytes > 0 && freeBytes - incoming < minFreeBytes) return { code: 'disk', name: '' };
  return null;
}

/** Yükleme klasöründeki boş alan (bayt); okunamazsa null — o zaman disk denetimi yapılamaz, yükleme engellenmez. */
export async function freeBytesOf(dir, statfs = fsp.statfs) {
  try {
    const s = await statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

const SIZE = { size: true };
const RECENT = { size: true, createdAt: true };

/**
 * Yükleme öncesi denetim (dosyalar diske yazılmadan önce). Kota var olan dosya satırlarından hesaplanır.
 * @param {any} db
 * @param {{ name: string, size: number }[]} files
 * @param {{ userId: string | null, orderId?: string | null, depot?: boolean }} ctx
 * @param {{ root: string, minFreeMb: number, now?: Date, statfs?: typeof fsp.statfs, limits?: typeof UPLOAD_LIMITS }} opts
 */
export async function checkUpload(db, files, ctx, { root, minFreeMb, now = new Date(), statfs = fsp.statfs, limits = UPLOAD_LIMITS }) {
  if (!files.length) return null;
  // Ucuz denetimler önce: sayı ve boyut için veritabanına gidilmez
  const quick = uploadVerdict({ files, kind: 'staff', limits });
  if (quick) return quick;

  const depot = !!ctx.depot || !ctx.userId;
  const user = !depot ? await db.user.findUnique({ where: { id: ctx.userId }, select: { id: true, customerId: true, type: true } }) : null;
  // İç ekip de bir firmaya (fabrika) bağlıdır: müşteri olup olmadığını kullanıcının türü belirler
  const firmId = user?.type === 'CUSTOMER' ? user.customerId : null;
  const kind = depot ? 'depot' : firmId ? 'customer' : 'staff';

  let recent = null;
  if (user) {
    // Müşteri: firmanın bütün kullanıcıları birlikte; iç ekip: yalnızca kendisi
    const by = firmId ? { uploadedBy: { customerId: firmId, type: 'CUSTOMER' } } : { uploadedById: user.id };
    const where = { ...by, createdAt: { gte: new Date(now.getTime() - DAY_MS) } };
    const [a, b, c] = await Promise.all([
      db.orderFile.findMany({ where, select: RECENT }),
      db.orderDraftFile.findMany({ where, select: RECENT }),
      db.drawingFile.findMany({ where, select: RECENT }),
    ]);
    recent = [...a, ...b, ...c];
  }
  let order = null;
  if (ctx.orderId) {
    order = depot
      ? await db.orderFile.findMany({ where: { orderId: ctx.orderId, source: 'DEPOT_LINK' }, select: SIZE })
      : (await Promise.all([
        db.orderFile.findMany({ where: { orderId: ctx.orderId }, select: SIZE }),
        db.drawingFile.findMany({ where: { drawing: { orderId: ctx.orderId } }, select: SIZE }),
      ])).flat();
  }
  const freeBytes = minFreeMb > 0 ? await freeBytesOf(root, statfs) : null;
  return uploadVerdict({ files, order, recent, kind, freeBytes, minFreeBytes: minFreeMb * MB, now: now.getTime(), limits });
}
