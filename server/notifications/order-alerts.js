// Kullanıcı başına okunmamış SİPARİŞ UYARILARI (Paket A, karar 224 — karar 205'in "mesaj görülünce okunur" kuralının yerine).
//
// Uyarı = kullanıcının, bir siparişe bağlı okunmamış uygulama içi bildirimi (Notification, türü ORDER_…): yeni mesaj,
// çizim müşteri onayına gönderildi, revizyon istendi, çizim onaylandı, teklif gönderildi / güncellendi, yeni sipariş …
// Bu bildirimler zaten yalnızca ilgili ve yetkili kullanıcılara, işlemi yapan hariç, kullanıcı başına bir kez (veritabanı
// tekilliği) ve alıcıya göre süzülmüş içerikle yazılır (server/notifications/inapp.js). Bu modül ikinci bir bildirim
// tablosu ya da kuralı KURMAZ; yalnızca o satırları sipariş bazında sayar ve okundu yapar.
//
// Okundu: kullanıcı sipariş sayfasını AÇINCA (karar 224) — sayfa çizildikten sonra istemci bileşeni (components/OrderSeen.tsx)
// sunucu işlemini çağırır; sayfa çizimi / GET isteği hiçbir şey yazmaz. Yalnızca O KULLANICININ, O SİPARİŞE ait ve sayfanın
// çizildiği ANA KADAR yazılmış uyarıları okunur (sonra gelen uyarı okunmamış kalır); başka kullanıcıların uyarılarına ve
// başka siparişlere dokunulmaz. Aynı anda siparişin mesajlarının okunma anı da (OrderNoteRead) ileri alınır — mesajlar
// sayfada artık doğrudan açık gösterildiği için (karar 225) sayfa açılınca görülmüş sayılır.
// Müşteri panelinin "Bir mesajınız var" göstergesi (Paket B) aynı sayımı kullanacaktır (orderAlertCounts / orderAlertTotal).
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
 * Sipariş sayfası açıldı: kullanıcının o siparişteki uyarılarını (sayfanın çizildiği ana kadar) okundu yapar ve mesajların
 * okunma anını ileri alır. Kapsam dışı / bilinmeyen sipariş → NOT_FOUND (hiçbir şey yazılmaz).
 * @param {any} db
 * @param {{ user: { id: string, appRole: string, customerId?: string | null, createdAt?: Date | string | null }, orderId: string, upTo?: string | Date | null, now?: Date }} p
 * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function markOrderSeen(db, { user, orderId, upTo = null, now = new Date() }) {
  const notes = await markNotesRead(db, { user, orderId, upTo: upTo ? new Date(upTo).toISOString() : null, now });
  if (!notes.ok) return notes;
  const asked = upTo ? new Date(upTo) : now;
  const at = new Date(Math.min(now.getTime(), Number.isFinite(asked.getTime()) ? asked.getTime() : now.getTime()));
  const r = await db.notification.updateMany({
    where: { userId: user.id, orderId, isRead: false, type: { startsWith: ORDER_ALERT_PREFIX }, createdAt: { lte: at } },
    data: { isRead: true, readAt: now },
  });
  return { ok: true, changed: notes.changed || r.count > 0 };
}
