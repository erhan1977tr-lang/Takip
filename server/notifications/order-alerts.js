// Kullanıcı başına okunmamış SİPARİŞ UYARILARI (Paket A, karar 224 — karar 205'in "mesaj görülünce okunur" kuralının yerine).
//
// Uyarı = kullanıcının, bir siparişe bağlı okunmamış uygulama içi bildirimi (Notification, türü ORDER_…): yeni mesaj,
// çizim müşteri onayına gönderildi, revizyon istendi, çizim onaylandı, teklif gönderildi / güncellendi, yeni sipariş …
// Bu bildirimler zaten yalnızca ilgili ve yetkili kullanıcılara, işlemi yapan hariç, kullanıcı başına bir kez (veritabanı
// tekilliği) ve alıcıya göre süzülmüş içerikle yazılır (server/notifications/inapp.js). Bu modül ikinci bir bildirim
// tablosu ya da kuralı KURMAZ; yalnızca o satırları sipariş bazında sayar ve okundu yapar.
//
// Okundu (Paket B — karar 228, karar 224'ün "sipariş açılınca hepsi okunur" kuralını DARALTIR): uyarı, gösterildiği
// bölüm ekranda GERÇEKTEN göründüğünde okunur (markSectionsSeen; istemci: components/OrderSeen.tsx — görünür sekme, bölüm
// ekranda yeterince göründü, kısa bekleme). Mesaj, kendisi ekranda göründüğünde okunur. Sayfa çizimi / GET isteği hiçbir
// şey yazmaz. Yalnızca O KULLANICININ, O SİPARİŞE ait ve sayfanın çizildiği (mesajda: mesajın) ANA KADAR yazılmış uyarıları
// okunur; başka kullanıcıların uyarılarına ve başka siparişlere dokunulmaz.
// Müşteri panelinin "Bir mesajınız var" göstergesi aynı sayımı kullanır (orderAlertCounts).
import { can } from '../auth/permissions.js';
import { orderScope } from '../orders/scope.js';
import { NOTE_EVENT, markNotesRead } from '../notes/unread.js';

/** Sipariş uyarısı sayılan bildirim türleri: siparişe bağlı ORDER_… olayları (mali / tedarik / güvenlik bildirimleri değil) */
export const ORDER_ALERT_PREFIX = 'ORDER_';
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/**
 * Verilen siparişlerdeki okunmamış uyarı sayıları (kullanıcının kendi bildirimleri). Kapsam: çağıranın listesi zaten
 * kullanıcının kapsamından geçmiştir; ek güvence olarak yalnızca kapsamdaki siparişler sayılır.
 * @param {any} db @param {{ id: string, appRole: string, customerId?: string | null }} user @param {string[]} orderIds
 * @param {{ messages?: boolean }} [o]  messages=false: yeni mesaj uyarıları sayılmaz (liste mesajı ayrı sayaçla gösterir)
 * @returns {Promise<Map<string, number>>}
 */
export async function orderAlertCounts(db, user, orderIds, { messages = true } = {}) {
  const ids = [...new Set((orderIds ?? []).filter(isId))];
  const out = new Map();
  if (!user?.id || !ids.length || !can(user.appRole, 'ORDER_VIEW')) return out;
  const visible = await db.order.findMany({ where: { id: { in: ids }, ...orderScope(user) }, select: { id: true } });
  if (!visible.length) return out;
  const rows = await db.notification.groupBy({
    by: ['orderId'],
    where: {
      userId: user.id, isRead: false, orderId: { in: visible.map((o) => o.id) },
      type: messages ? { startsWith: ORDER_ALERT_PREFIX } : { startsWith: ORDER_ALERT_PREFIX, not: NOTE_EVENT },
    },
    _count: { _all: true },
  });
  for (const r of rows) if (r.orderId && r._count._all > 0) out.set(r.orderId, r._count._all);
  return out;
}

/**
 * Kullanıcının bütün siparişlerindeki okunmamış uyarılar (müşteri paneli göstergesi — Paket B): toplam ve sipariş sayısı.
 * @param {any} db @param {{ id: string, appRole: string, customerId?: string | null }} user
 */
export async function orderAlertTotal(db, user) {
  if (!user?.id || !can(user.appRole, 'ORDER_VIEW')) return { total: 0, orders: 0 };
  const rows = await db.notification.groupBy({
    by: ['orderId'],
    where: { userId: user.id, isRead: false, orderId: { not: null }, type: { startsWith: ORDER_ALERT_PREFIX } },
    _count: { _all: true },
  });
  if (!rows.length) return { total: 0, orders: 0 };
  const counts = new Map(rows.map((r) => [r.orderId, r._count._all]));
  const visible = await db.order.findMany({ where: { id: { in: [...counts.keys()] }, ...orderScope(user) }, select: { id: true } });
  let total = 0;
  for (const o of visible) total += counts.get(o.id) ?? 0;
  return { total, orders: visible.length };
}

/**
 * Uyarının sayfada GÖSTERİLDİĞİ bölüm (Paket B — karar 228, karar 224'ü daraltır): uyarı, kullanıcı o bölümü gerçekten
 * gördüğünde okunur — sayfayı açmak tek başına bütün uyarıları okunmuş yapmaz.
 *   cizim    : çizim bilgilendirmesi / çizim kartı / çizim görüntüleyici (yeni çizim, revizyon, onay, DWG/DXF kararları)
 *   teklif   : teklif kartı (#teklif)
 *   kararlar : "Önemli kararlar" (#kararlar)
 *   teslim   : profil teslim bölümü (#teslim)
 *   notlar   : mesajlar — her mesaj ekranda göründüğünde, o mesajın anına kadar (markNotesRead)
 *   durum    : sayfa başlığı (durum / adım) — yukarıdakilerin dışındaki bütün ORDER_… uyarıları (yeni sipariş, üretim,
 *              yükleme günü, yüklendi, proforma, fatura …) ve sayfada bölümü bulunmayan uyarılar (istemci katlar)
 */
export const ALERT_SECTIONS = {
  cizim: ['ORDER_SENT_TO_DRAWING', 'ORDER_DRAWING_UPLOADED', 'ORDER_REVISION_REQUESTED', 'ORDER_DRAWING_APPROVED', 'ORDER_DWG_FAULTY', 'ORDER_DWG_READY', 'ORDER_DWG_RESUBMITTED', 'ORDER_DWG_FACTORY_REQUESTED'],
  teklif: ['ORDER_OFFER_SUBMITTED', 'ORDER_OFFER_WITHDRAWN', 'ORDER_OFFER_RETURNED', 'ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED', 'ORDER_PROFILE_OFFER_SENT'],
  kararlar: ['ORDER_PRICE_OVERRIDE'],
  teslim: ['ORDER_DELIVERY_DATE_CHANGED', 'ORDER_PICKUP_MOVED'],
  notlar: [NOTE_EVENT],
};
export const SECTION_KEYS = [...Object.keys(ALERT_SECTIONS), 'durum'];
const GROUPED = Object.values(ALERT_SECTIONS).flat();
/** Uyarı türünün bölümü (bilinmeyen ORDER_… türü → durum) */
export const sectionOf = (type) => Object.keys(ALERT_SECTIONS).find((k) => ALERT_SECTIONS[k].includes(type)) ?? 'durum';

/**
 * Bölüm(ler) GÖRÜLDÜ: kullanıcının o siparişteki, o bölümlere ait uyarılarını (upTo anına kadar yazılmış) okundu yapar.
 * Yalnızca bu kullanıcının kendi kayıtları; başka kullanıcıya ve başka siparişe dokunulmaz. Kapsam dışı / bilinmeyen
 * sipariş → NOT_FOUND (hiçbir şey yazılmaz). Bilinmeyen bölüm adı yok sayılır; hiç bölüm yoksa hiçbir şey yazılmaz.
 *   notlar: mesajların okunma anı upTo'ya (görülen mesajın anı) ilerler ve o ana kadarki mesaj bildirimleri okunur.
 * @param {any} db
 * @param {{ user: { id: string, appRole: string, customerId?: string | null, createdAt?: Date | string | null }, orderId: string,
 *   sections: string[], upTo?: string | Date | null, now?: Date }} p
 * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function markSectionsSeen(db, { user, orderId, sections, upTo = null, now = new Date() }) {
  const want = [...new Set((Array.isArray(sections) ? sections : []).filter((x) => SECTION_KEYS.includes(x)))];
  if (!user?.id || !isId(orderId) || !can(user.appRole, 'ORDER_VIEW')) return { ok: false, code: 'NOT_FOUND' };
  const order = await db.order.findFirst({ where: { id: orderId, ...orderScope(user) }, select: { id: true } });
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  if (!want.length) return { ok: true, changed: false };
  const asked = upTo ? new Date(upTo) : now;
  const at = new Date(Math.min(now.getTime(), Number.isFinite(asked.getTime()) ? asked.getTime() : now.getTime()));
  let changed = false;
  if (want.includes('notlar')) {
    const notes = await markNotesRead(db, { user, orderId: order.id, upTo: at.toISOString(), now });
    changed = notes.ok && notes.changed;
  }
  // notlar: markNotesRead mesaj bildirimini mesajın anıyla eşler; kuyruk eşlemesi olmayan (eski) mesaj bildirimleri de
  // görülen mesajın anından ÖNCE yazılmışsa okunur — sonraki (görülmemiş) mesajın bildirimi her zaman ondan sonra yazılır
  const types = want.filter((k) => k !== 'durum').flatMap((k) => ALERT_SECTIONS[k]);
  const or = [];
  if (types.length) or.push({ type: { in: types } });
  if (want.includes('durum')) or.push({ AND: [{ type: { startsWith: ORDER_ALERT_PREFIX } }, { type: { notIn: GROUPED } }] });
  if (or.length) {
    const r = await db.notification.updateMany({
      where: { userId: user.id, orderId: order.id, isRead: false, createdAt: { lte: at }, OR: or },
      data: { isRead: true, readAt: now },
    });
    changed = changed || r.count > 0;
  }
  return { ok: true, changed };
}

/**
 * Bütün bölümler görüldü (karar 224'ün eski davranışı — yalnızca testler ve geriye dönük çağrılar için; sipariş sayfası
 * artık bölüm bazında işaretler: components/OrderSeen.tsx → markSectionsSeen).
 */
export async function markOrderSeen(db, { user, orderId, upTo = null, now = new Date() }) {
  return markSectionsSeen(db, { user, orderId, sections: SECTION_KEYS, upTo, now });
}
