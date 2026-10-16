// Müşterinin DWG/DXF çizimi için çizimci kararlarının GÜVENLİ GERİ ALINMASI (3.90.0, karar 285) — kurallar tek yerde.
//
// Geri alınabilen üç karar (karar 167 — server/orders/dwg-review.js):
//   READY  "Üretime Hazır"      : kayıt ONAYLANDI, çizim hattı ONAYLANDI (sipariş otomatik üretime geçmiş olabilir)
//   FAULTY "Çizim Hatalı"       : kayıt REVIZYON_ISTENDI, hat DUZELTME_BEKLIYOR (müşteri henüz yanıt vermedi)
//   UPDATE "Çizimi Güncelle"    : kayıt YAPILIYOR, hat YAPILIYOR (çizimci henüz sürüm açmadı) — ya da hatalı kararından
//                                 sonra verilen güncelleme (kayıt REVIZYON_ISTENDI, hat YAPILIYOR → DUZELTME_BEKLIYOR'a döner)
//
// Geri alma bir TERS İŞLEMDİR, hiçbir şey silinmez / üzerine yazılmaz:
//   - kararın kaydı GERI_CEKILDI olur (withdrawnAt + gerekçe), kararı veren / zaman / dosya listesi / hatalı açıklaması durur;
//   - aynı dosyalar için yeni bir karar kaydı (sürüm v+1, BEKLIYOR) açılır → karar yeniden çizimcinin "DXF/DWG" listesinde;
//   - hatalı kararından sonraki güncellemenin geri alınmasında kayıt değişmez, yalnızca hat DUZELTME_BEKLIYOR'a döner;
//   - geçmiş (OrderEvent) ve denetim kaydı (gerekçe, önceki / yeni durum) yazılır; dosyalar ve sürüm geçmişi korunur.
// "Üretime almayı geri al" (3.90.2 — ürün sahibi; 3.90.1'in "yalnızca yönetici / üretime hiç girmemiş" kuralının yerine):
//   - kararı veren çizimci, yönetici ve yönetici yardımcısı (DRAWING_PRODUCTION_UNDO + kararı veren ya da ORDER_CANCEL);
//   - TAKİP'te ayrı bir "üretime başladı" süreci / kaydı YOKTUR: fiilî üretim başlangıcı aranmaz. Sipariş otomatik olarak
//     üretime geçmişse (URETIMDE) karar geri alınınca sipariş "Hazırlanıyor"a döner (çizim kararı yeniden bekleniyor);
//   - tamamlanmış sonraki işlemler korunur — varsa REDDEDİLİR: yüklendi / arşiv / gerçek yükleme tarihi (UNDO_SHIPPED),
//     onaylı yükleme, FGO belgesi / müşteri belgesi kapsamı / bekleyen belge isteği (mali kilit), girilmiş sandık, telafi.
//     Sandık yazanlarla aynı kilit (crates:<gün>) sürüm artışından ÖNCE alınır: denetim ile kayıt arasına sandık giremez.
import { can } from '../auth/permissions.js';
import { isCustomerDrawingRecord } from './dwg-review.js';

/** Geri alınabilen kararlar → iş akışı işlemi */
export const UNDO_ACTIONS = Object.freeze({ READY: 'dwg_ready_undo', FAULTY: 'dwg_faulty_undo', UPDATE: 'dwg_update_undo' });
/** İş akışı işlemi → karar */
export const UNDO_KIND_OF = Object.freeze(Object.fromEntries(Object.entries(UNDO_ACTIONS).map(([k, v]) => [v, k])));
/** Gerekçenin en uzun hâli */
export const UNDO_REASON_MAX = 1000;
/** Geri almayı engelleyen durumların kodları (ekranda ve hata iletisinde aynı metin: order.dwg.undo.block.<kod>) */
export const UNDO_BLOCKS = Object.freeze([
  'UNDO_CLOSED', 'UNDO_ON_HOLD', 'UNDO_SHIPPED', 'UNDO_LATER_DRAWING', 'UNDO_CUSTOMER_ANSWERED',
  'UNDO_LOADED', 'UNDO_DOCUMENTS', 'UNDO_CRATES', 'UNDO_COMPENSATION', 'UNDO_NOT_OWNER',
]);
/** "Üretime almayı geri al" yetkisi (yönetici, yönetici yardımcısı, çizimci — sahiplik ayrıca: ownerBlock) */
export const PRODUCTION_UNDO_PERMISSION = 'DRAWING_PRODUCTION_UNDO';
/** Yüklenmiş / arşivlenmiş sipariş: tamamlanmış sonraki adım — üretime alma kararı geri alınamaz */
export const SHIPPED_STATUSES = Object.freeze(['YUKLENDI', 'ARSIVLENDI']);

/**
 * Geri alma gerekçesi: zorunlu, tek metin (satırlar korunur), en çok UNDO_REASON_MAX karakter.
 * @param {unknown} v
 * @returns {{ ok: true, text: string } | { ok: false, code: 'UNDO_REASON' | 'UNDO_REASON_LONG' }}
 */
export function undoReason(v) {
  const text = String(v ?? '').normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { ok: false, code: 'UNDO_REASON' };
  if (text.length > UNDO_REASON_MAX) return { ok: false, code: 'UNDO_REASON_LONG' };
  return { ok: true, text };
}

/**
 * Siparişte geri alınabilecek (ya da neden alınamayacağı gösterilecek) DWG kararı — SAF kural (veritabanı yok).
 * Yalnızca SON müşteri çizimi kaydının kararı geri alınır; araya fabrika sürümü girdiyse (taslak dahil) güncelleme geri
 * alınamaz. Müşteri yanıt verdiyse (düzeltilmiş dosya → yeni kayıt; fabrikadan çizim istedi → hat GEREKLI) hatalı kararı
 * geri alınamaz.
 * @param {{ status: string, onHold?: boolean, removedAt?: Date | string | null, actualShipDate?: Date | string | null, drawingTrack?: string | null,
 *   drawings?: { id: string, source?: string | null, status: string, version: number, decidedById?: string | null }[] }} o
 *   drawings: eskiden yeniye
 * @returns {null | { kind: 'READY' | 'FAULTY' | 'UPDATE', variant: 'RECORD' | 'AFTER_FAULTY', record: any,
 *   production: boolean, restoreTrack: string, restoreStatus: string, block: string | null }}
 *   production: sipariş üretimde (URETIMDE) — geri alınınca HAZIRLANIYOR'a döner
 */
export function dwgUndoState(o) {
  const ds = o?.drawings ?? [];
  let idx = -1;
  for (let i = ds.length - 1; i >= 0; i--) if (isCustomerDrawingRecord(ds[i])) { idx = i; break; }
  if (idx < 0) return null;
  const record = ds[idx];
  const later = ds.length - 1 - idx;
  const track = o.drawingTrack ?? null;
  /** @type {'READY' | 'FAULTY' | 'UPDATE' | null} */
  let kind = null;
  /** @type {'RECORD' | 'AFTER_FAULTY'} */
  let variant = 'RECORD';
  /** @type {string | null} */
  let block = null;
  if (later > 0) {
    // Güncelleme kararından sonra fabrika sürümü açıldı (taslak / gönderilmiş / onaylı): güncelleme artık geri alınmaz
    if (record.status === 'YAPILIYOR') return state('UPDATE', 'RECORD', 'UNDO_LATER_DRAWING');
    return null;
  }
  if (record.status === 'ONAYLANDI' && track === 'ONAYLANDI') kind = 'READY';
  else if (record.status === 'REVIZYON_ISTENDI' && track === 'DUZELTME_BEKLIYOR') kind = 'FAULTY';
  else if (record.status === 'REVIZYON_ISTENDI' && track === 'YAPILIYOR') { kind = 'UPDATE'; variant = 'AFTER_FAULTY'; }
  else if (record.status === 'YAPILIYOR' && track === 'YAPILIYOR') kind = 'UPDATE';
  // Müşteri hatalı kararına "fabrika çizsin" diye yanıt verdi (dwg_request_drawing): karar müşterinin yanıtıyla kapandı
  else if (record.status === 'REVIZYON_ISTENDI' && track === 'GEREKLI') { kind = 'FAULTY'; block = 'UNDO_CUSTOMER_ANSWERED'; }
  else return null;
  return state(kind, variant, block);

  /** @param {'READY' | 'FAULTY' | 'UPDATE'} k @param {'RECORD' | 'AFTER_FAULTY'} v @param {string | null} b */
  function state(k, v, b) {
    const production = k === 'READY' && o.status === 'URETIMDE';
    let bl = b;
    if (!bl) {
      if (o.removedAt || o.status === 'IPTAL') bl = 'UNDO_CLOSED';
      // Yüklendi / arşiv ya da gerçek yükleme tarihi: tamamlanmış sonraki adım → üretime alma kararı geri alınamaz
      else if (k === 'READY' && (SHIPPED_STATUSES.includes(o.status) || o.actualShipDate)) bl = 'UNDO_SHIPPED';
      else if (o.onHold) bl = 'UNDO_ON_HOLD';
      else if (o.status !== 'HAZIRLANIYOR' && !production) bl = 'UNDO_CLOSED';
    }
    return {
      kind: k, variant: v, record, production, block: bl,
      restoreTrack: v === 'AFTER_FAULTY' ? 'DUZELTME_BEKLIYOR' : 'GEREKLI', restoreStatus: 'HAZIRLANIYOR',
    };
  }
}

/**
 * "Üretime almayı geri al" için tamamlanmış sonraki işlemler (onaylı yükleme, mali belge / belge isteği, sandık, telafi)
 * → engel kodu ya da null. Fiilî üretim başlangıcı aranmaz (TAKİP'te böyle bir kayıt yoktur). Eksik / okunamayan değer
 * engeldir (güvenli taraf).
 * @param {{ lock: { code: string }[], crates: number, compensations: number }} f
 */
export function productionBlock(f) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : Infinity);
  if (!Array.isArray(f?.lock)) return 'UNDO_DOCUMENTS';
  if (f.lock.some((r) => r?.code === 'CONFIRMED_LOADING')) return 'UNDO_LOADED';
  if (f.lock.length) return 'UNDO_DOCUMENTS';
  if (n(f.crates) > 0) return 'UNDO_CRATES';
  if (n(f.compensations) > 0) return 'UNDO_COMPENSATION';
  return null;
}

/**
 * Kararı geri almaya bu kullanıcı yetkili mi?
 * Üç karar için aynı kural (3.90.2): kararı veren çizimci (kayıt: decidedById; hatalı sonrası güncelleme: son DWG_UPDATE
 * olayının kullanıcısı) ya da yönetici / yönetici yardımcısı (ORDER_CANCEL). READY ayrıca DRAWING_PRODUCTION_UNDO ister
 * (yönetici, yardımcı, çizimci — dwgUndoCheck / availableActions).
 * @param {{ kind: string }} st @param {{ id?: string | null, role: string }} actor @param {string | null} owner
 * @returns {string | null} engel kodu
 */
export function ownerBlock(st, actor, owner) {
  const admin = can(actor.role, 'ORDER_CANCEL');
  if (admin) return null;
  return actor.id && owner && actor.id === owner ? null : 'UNDO_NOT_OWNER';
}

/**
 * "Üretime almayı geri al"ın sandık kilidi: sandık yazanlarla (server/loading/crates.js — saveDayCrates, guest crate,
 * setGuestHost) AYNI anahtar, siparişin yükleme günü. Sipariş satırı kilidinden (sürüm artışı) ÖNCE alınır — sandık
 * yazanlarla aynı sıra. Yükleme günü yoksa siparişe sandık bağlanamaz (dayOrders), kilit gerekmez.
 * @param {{ actualShipDate?: Date | null, estimatedShipDate?: Date | null }} order @param {(d: Date) => string} dayKey
 */
export const crateLockKeys = (order, dayKey) => {
  const d = order.actualShipDate ?? order.estimatedShipDate;
  return d ? [`crates:${dayKey(d)}`] : [];
};

/**
 * Sayfa ve işlem için TEK denetim: geri alınabilecek karar, sahibi ve (varsa) engeli. Veritabanından yalnızca okur.
 * Mali kilit için priceLock (server/orders/financial-lock.js — teklif güncellemesiyle aynı kural) çağırana verilir
 * (döngüsel içe aktarmayı önlemek için).
 * @param {any} db  PrismaClient ya da işlem (tx)
 * @param {any} order  INCLUDE ile yüklenmiş sipariş (drawings eskiden yeniye)
 * @param {{ id?: string | null, role: string }} actor
 * @param {{ priceLock: (db: any, orderId: string) => Promise<{ code: string }[]> }} deps
 */
export async function dwgUndoCheck(db, order, actor, { priceLock }) {
  const st = dwgUndoState(order);
  if (!st) return null;
  if (!can(actor.role, 'DRAWING_WORK')) return null;
  // "Üretime almayı geri al" yetkisi olmayana hiç gösterilmez (sunucu ayrıca reddeder)
  if (st.kind === 'READY' && !can(actor.role, PRODUCTION_UNDO_PERMISSION)) return null;
  if (st.block) return { ...st, owner: null };
  let owner = st.record.decidedById ?? null;
  if (st.variant === 'AFTER_FAULTY') {
    const ev = await db.orderEvent.findFirst({ where: { orderId: order.id, event: 'DWG_UPDATE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { userId: true } });
    owner = ev?.userId ?? null;
  }
  let block = ownerBlock(st, actor, owner);
  if (!block && st.kind === 'READY') {
    const lock = await priceLock(db, order.id);
    const crates = await db.crateOrder.count({ where: { orderId: order.id } });
    const compensations = await db.compensation.count({ where: { OR: [{ sourceOrderId: order.id }, { destOrderId: order.id }] } });
    block = productionBlock({ lock, crates, compensations });
  }
  return { ...st, owner, block };
}
