// Çizim sürümünün İÇERİĞİNE erişim — TEK kural (karar 146; güvenlik denetimi 3.50.9 AUD-8).
//
// Çizimci müşteriye gönderdiği sürümü, müşteri karar vermeden gerekçeyle geri çekebilir (karar 30). Geri çekme, yanlış
// gönderilen dosyayı (ör. başka firmanın çizimi) geri almanın tek yoludur; bu yüzden geri çekilen sürümün içeriği
// müşteriye kapanır. Müşteri sürümün SATIRINI görmeye devam eder: sürüm no, "geri çekildi" durumu, tarihler ve geri
// çekme gerekçesi. Dosyaları (ve müşteriye yazılmış sürüm notu) artık gelmez; dosya adresi ve görüntüleyici "bulunamadı"
// döner.
//
// Kural rol + sürüm durumuna bakar ve üç yerde AYNI işlevlerle uygulanır — başka yerde durum karşılaştırması yazılmaz:
//   - sipariş verisi          : lib/orders.ts → sanitizeOrder            → drawingsView
//   - dosya adresi            : app/dosya/[kind]/[id]/route.ts           → findDrawingFile (drawingFileWhere)
//   - çizim görüntüleyicisi   : app/(panel)/siparisler/[id]/cizim/…      → drawingAccess
//
//   İç dosyaları gören roller (FILE_INTERNAL_VIEW: yönetici, satış, çizim, denetimci): her sürüm, her dosya (değişmedi).
//   Öteki roller (bugün yalnızca müşteri):
//     TASLAK                                   → NONE : sürüm hiç gelmez (değişmedi)
//     GERI_CEKILDI                             → ROW  : satır gelir, içerik gelmez
//     ONAY_BEKLIYOR, ONAYLANDI, REVIZYON_ISTENDI
//     (+ eski kayıtlardaki BEKLIYOR, YAPILIYOR) → FULL : değişmedi
//     tanınmayan durum                          → NONE : yeni bir durum eklenirse karar verilene kadar kapalıdır
//       (test/drawing-access.test.js şemadaki her durumun burada sınıflandırıldığını denetler)
import { can } from '../auth/permissions.js';

/** Öteki roller için içeriği AÇIK olan sürüm durumları (izin listesi) */
export const CUSTOMER_OPEN_STATUSES = Object.freeze(['BEKLIYOR', 'YAPILIYOR', 'ONAY_BEKLIYOR', 'ONAYLANDI', 'REVIZYON_ISTENDI']);
/** Öteki roller için yalnızca SATIRI gelen sürüm durumları (içerik kapalı) */
export const CUSTOMER_ROW_ONLY_STATUSES = Object.freeze(['GERI_CEKILDI']);
/** Öteki rollere hiç gelmeyen sürüm durumları */
export const CUSTOMER_HIDDEN_STATUSES = Object.freeze(['TASLAK']);

/** Rol, bütün sürümleri ve dosyaları görür mü (iç ekip + denetimci) */
const seesAll = (role) => can(role, 'FILE_INTERNAL_VIEW');

/**
 * Bu rol, bu durumdaki çizim sürümünün neyini görür?
 * @param {string | null | undefined} role
 * @param {string | null | undefined} status
 * @returns {'FULL' | 'ROW' | 'NONE'} FULL: satır + içerik · ROW: yalnızca satır · NONE: hiçbir şey
 */
export function drawingAccess(role, status) {
  if (seesAll(role)) return 'FULL';
  if (CUSTOMER_OPEN_STATUSES.includes(/** @type {string} */ (status))) return 'FULL';
  if (CUSTOMER_ROW_ONLY_STATUSES.includes(/** @type {string} */ (status))) return 'ROW';
  return 'NONE';
}

/**
 * Dosyası verilebilecek sürümlerin sorgu koşulu (Drawing üzerinde): drawingAccess(...) === 'FULL' ile aynı küme.
 * @param {string | null | undefined} role
 * @returns {{} | { status: { in: string[] } }}
 */
export function drawingFileWhere(role) {
  return seesAll(role) ? {} : { status: { in: [...CUSTOMER_OPEN_STATUSES] } };
}

/**
 * İçeriği kapalı sürümün satırında boşaltılan alanlar: dosyalar, müşteri notu ve onun çevirisi (karar 168), eski
 * tek-dosya alanları, müşteri çizimi kaydının dosya listesi (karar 167)
 */
const NO_CONTENT = Object.freeze({
  noteCustomer: null, fileUrl: null, fileName: null, fileSize: null, mime: null, checksum: null, scanSignature: null,
  translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null, sourceFiles: null,
});

/**
 * Sürüm listesinin role göre görünümü: görülmeyen sürümler çıkar; yalnızca satırı görülen sürümün içeriği boşaltılır
 * (dosya listesi boş, müşteri notu ve eski dosya alanları null). Durum, sürüm no, tarihler ve geri çekme gerekçesi kalır.
 * Girdi değiştirilmez.
 * @template {{ status: string }} T
 * @param {string | null | undefined} role
 * @param {T[]} drawings
 * @returns {T[]}
 */
export function drawingsView(role, drawings) {
  const out = [];
  for (const d of drawings) {
    const access = drawingAccess(role, d.status);
    if (access === 'NONE') continue;
    out.push(access === 'FULL' ? d : /** @type {T} */ ({ ...d, ...NO_CONTENT, files: [] }));
  }
  return out;
}

/**
 * /dosya/cizim/<kimlik> için dosya: kimlik bir DrawingFile kimliğidir; eski bağlantılarda sürüm (Drawing) kimliği
 * (→ sürümün ilk dosyası ya da eski tek-dosya alanı). İki yol da aynı koşulu kullanır: sipariş kapsamı (firma) + bu rolün
 * içeriğini görebildiği sürüm. Bulunamayan ve görülemeyen dosya ayırt edilmez (null → çağıran "bulunamadı" der).
 * @param {any} db
 * @param {{ id: string, scope: object, role: string | null | undefined }} p  scope: orderScope(user)
 * @returns {Promise<{ storageKey: string, name: string, mime: string | null, scanStatus: string, orderId: string } | null>}
 */
export async function findDrawingFile(db, { id, scope, role }) {
  const drawing = { order: scope, ...drawingFileWhere(role) };
  const f = await db.drawingFile.findFirst({ where: { id, drawing }, include: { drawing: { select: { orderId: true } } } });
  if (f) return { storageKey: f.storageKey, name: f.name, mime: f.mime, scanStatus: f.scanStatus, orderId: f.drawing.orderId };
  // Eski bağlantılar: /dosya/cizim/<sürüm kimliği>
  const d = await db.drawing.findFirst({ where: { id, ...drawing }, include: { files: { orderBy: { createdAt: 'asc' }, take: 1 } } });
  if (!d) return null;
  const first = d.files[0];
  if (first) return { storageKey: first.storageKey, name: first.name, mime: first.mime, scanStatus: first.scanStatus, orderId: d.orderId };
  if (d.fileUrl) return { storageKey: d.fileUrl, name: d.fileName || `cizim-v${d.version}`, mime: d.mime, scanStatus: d.scanStatus, orderId: d.orderId };
  return null;
}
