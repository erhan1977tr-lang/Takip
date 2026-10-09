// Sipariş mesajlarının (OrderNote) okunmamış sayısı — Paket 9, karar 199. Tek kural, tek okuyucu; liste satırları,
// sipariş sayfası ve sol menüdeki toplam hep buradan gelir (aynı sayı her yerde).
//
//   Sayılan not: kullanıcının GÖREBİLDİĞİ (müşteri iç notu hiç görmez — NOTE_INTERNAL_VIEW yoksa internal=false),
//   BAŞKASININ yazdığı (kendi notu sayılmaz), kullanıcının o siparişteki okunma anından (OrderNoteRead.lastReadAt)
//   SONRA yazılmış not. Okunma kaydı yoksa başlangıç kullanıcının oluşturulma anıdır (yeni kullanıcıya eski mesajlar
//   okunmamış görünmez); her durumda en çok UNREAD_WINDOW_DAYS gün geriye bakılır.
//   Kapsam: yalnızca kullanıcının görebildiği siparişler (orderScope — silinmiş sipariş, başka firmanın siparişi,
//   çizimcinin kapsamı dışındaki sipariş sayılmaz).
//   Okundu: sipariş sayfası açılınca (markNotesRead) okunma anı ileri alınır — hiçbir zaman geri gitmez; sayfa
//   açıldıktan sonra gelen not okunmuş sayılmaz (an, ekranda gösterilen en yeni nottur).
// Bu modül yalnızca okur ve okunma kaydını yazar; not yazmaz, çeviri yapmaz, oturuma dokunmaz.
import { can } from '../auth/permissions.js';
import { orderScope } from '../orders/scope.js';

export const UNREAD_WINDOW_DAYS = 180;
/** Sol menü toplamında en çok bu kadar sipariş taranır (sayaç bir uyarıdır; tam liste değildir) */
export const UNREAD_ORDER_CAP = 2000;
const DAY = 86_400_000;

/** Sayımın en eski anı: kullanıcının oluşturulma anı, ama en çok UNREAD_WINDOW_DAYS gün önce */
export function unreadSince(user, now = new Date()) {
  const floor = now.getTime() - UNREAD_WINDOW_DAYS * DAY;
  const created = user?.createdAt ? new Date(user.createdAt).getTime() : floor;
  return new Date(Math.max(floor, Number.isFinite(created) ? created : floor));
}

/** Kullanıcı iç notları görebiliyor mu (görünürlük kuralı server/notes/view.js ile aynı yetki) */
export const seesInternal = (user) => can(user?.appRole, 'NOTE_INTERNAL_VIEW');

/** Sayaç metni: 1…99, sonrası "99+" */
export const countText = (n) => (n > 99 ? '99+' : String(Math.max(0, Math.trunc(n))));

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/**
 * Tek siparişin okunmamış eşiği (sipariş sayfası): bu andan sonra BAŞKASININ yazdığı, kullanıcının gördüğü not yenidir.
 * Sayfa, rolüne göre süzülmüş notları (iç not müşteriye hiç gelmez) isUnreadNote ile işaretler — sayı, liste sayacıyla
 * (unreadCounts) aynı kuraldır.
 * @param {any} db @param {{ id: string, createdAt?: Date | string | null }} user @param {string} orderId
 * @returns {Promise<Date>}
 */
export async function unreadThreshold(db, user, orderId, { now = new Date() } = {}) {
  const since = unreadSince(user, now);
  const read = await db.orderNoteRead.findUnique({ where: { userId_orderId: { userId: user.id, orderId } }, select: { lastReadAt: true } });
  return read && read.lastReadAt > since ? read.lastReadAt : since;
}

/** @param {{ userId: string, createdAt: Date | string }} note @param {{ id: string }} user @param {Date} threshold */
export const isUnreadNote = (note, user, threshold) => note.userId !== user.id && new Date(note.createdAt).getTime() > threshold.getTime();

/**
 * Verilen siparişlerdeki okunmamış mesaj sayıları. Kapsam denetimi ÇAĞIRANDADIR (ids, kullanıcının kapsamından geçmiş
 * liste satırlarıdır); ek güvence olarak müşteride sorgu kendi firmasının siparişleriyle, herkeste silinmemiş siparişle
 * sınırlıdır. Sayısı 0 olan sipariş haritada yoktur.
 * @param {any} db
 * @param {{ id: string, appRole: string, customerId?: string | null, createdAt?: Date | string | null }} user
 * @param {string[]} orderIds
 * @param {{ now?: Date }} [o]
 * @returns {Promise<Map<string, number>>}
 */
export async function unreadCounts(db, user, orderIds, { now = new Date() } = {}) {
  const ids = [...new Set((orderIds ?? []).filter(isId))];
  const out = new Map();
  if (!user?.id || !ids.length) return out;
  const since = unreadSince(user, now);
  const internal = seesInternal(user);
  const firm = user.appRole === 'MUSTERI' ? String(user.customerId ?? '__none__') : null;
  const rows = await db.$queryRaw`
    SELECT n."orderId" AS "orderId", COUNT(*)::int AS "count"
    FROM "OrderNote" n
    JOIN "Order" o ON o."id" = n."orderId"
    LEFT JOIN "OrderNoteRead" r ON r."orderId" = n."orderId" AND r."userId" = ${user.id}
    WHERE n."orderId" = ANY(${ids}::text[])
      AND o."removedAt" IS NULL
      AND (${firm}::text IS NULL OR o."customerId" = ${firm})
      AND n."userId" <> ${user.id}
      AND (${internal} OR n."internal" = false)
      AND n."createdAt" > GREATEST(COALESCE(r."lastReadAt", ${since}), ${since})
    GROUP BY n."orderId"`;
  for (const r of rows) if (r.count > 0) out.set(r.orderId, Number(r.count));
  return out;
}

/**
 * Kullanıcının görebildiği bütün siparişlerdeki okunmamış mesaj toplamı (sol menü). Önce okunmamış notu olan
 * siparişler bulunur, sonra yalnızca kullanıcının kapsamındakiler sayılır (orderScope) — kapsam dışı sipariş sayıya
 * hiçbir yoldan girmez.
 * @param {any} db
 * @param {{ id: string, appRole: string, customerId?: string | null, createdAt?: Date | string | null }} user
 * @param {{ now?: Date }} [o]
 * @returns {Promise<{ total: number, orders: number }>}
 */
export async function unreadTotal(db, user, { now = new Date() } = {}) {
  if (!user?.id || !can(user.appRole, 'ORDER_VIEW')) return { total: 0, orders: 0 };
  const since = unreadSince(user, now);
  const internal = seesInternal(user);
  // Müşteri: sorgu baştan kendi firmasının siparişleriyle sınırlıdır (başka firmanın notuna hiç bakılmaz)
  const firm = user.appRole === 'MUSTERI' ? String(user.customerId ?? '__none__') : null;
  const rows = await db.$queryRaw`
    SELECT n."orderId" AS "orderId", COUNT(*)::int AS "count"
    FROM "OrderNote" n
    JOIN "Order" o ON o."id" = n."orderId"
    LEFT JOIN "OrderNoteRead" r ON r."orderId" = n."orderId" AND r."userId" = ${user.id}
    WHERE n."createdAt" > ${since}
      AND n."userId" <> ${user.id}
      AND (${internal} OR n."internal" = false)
      AND (${firm}::text IS NULL OR o."customerId" = ${firm})
      AND o."removedAt" IS NULL
      AND n."createdAt" > COALESCE(r."lastReadAt", ${since})
    GROUP BY n."orderId"
    ORDER BY MAX(n."createdAt") DESC
    LIMIT ${UNREAD_ORDER_CAP}`;
  if (!rows.length) return { total: 0, orders: 0 };
  const counts = new Map(rows.map((r) => [r.orderId, Number(r.count)]));
  const visible = await db.order.findMany({ where: { id: { in: [...counts.keys()] }, ...orderScope(user) }, select: { id: true } });
  let total = 0;
  for (const o of visible) total += counts.get(o.id) ?? 0;
  return { total, orders: visible.length };
}

/**
 * Siparişteki mesajları "okundu" işaretler: okunma anı, ekranda gösterilen en yeni notun anına (upTo) ilerler —
 * şimdiden ileri olamaz ve hiçbir zaman geri gitmez (iki sekme aynı anda yazsa da büyük olan kalır). Sipariş kullanıcının
 * kapsamında değilse hiçbir şey yazılmaz. Aynı siparişin bu ana kadarki "yeni mesaj" bildirimleri (zil) de okunur.
 * Oturuma dokunmaz (etkinlik sayılmaz — karar 135).
 * @param {any} db
 * @param {{ user: { id: string, appRole: string, customerId?: string | null }, orderId: string, upTo?: string | Date | null, now?: Date }} o
 * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function markNotesRead(db, { user, orderId, upTo = null, now = new Date() }) {
  if (!user?.id || !isId(orderId) || !can(user.appRole, 'ORDER_VIEW')) return { ok: false, code: 'NOT_FOUND' };
  const order = await db.order.findFirst({ where: { id: orderId, ...orderScope(user) }, select: { id: true } });
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  const asked = upTo ? new Date(upTo) : now;
  const at = new Date(Math.min(now.getTime(), Number.isFinite(asked.getTime()) ? asked.getTime() : now.getTime()));
  // Tek ifade: kayıt yoksa yazılır, varsa yalnızca İLERİ alınır (GREATEST) — eşzamanlı isteklerde geri gitmez
  const changed = await db.$executeRaw`
    INSERT INTO "OrderNoteRead" ("userId", "orderId", "lastReadAt") VALUES (${user.id}, ${order.id}, ${at})
    ON CONFLICT ("userId", "orderId") DO UPDATE SET "lastReadAt" = EXCLUDED."lastReadAt"
    WHERE "OrderNoteRead"."lastReadAt" < EXCLUDED."lastReadAt"`;
  const bell = await readNoteNotifications(db, { userId: user.id, orderId: order.id, at, now });
  return { ok: true, changed: changed > 0 || bell > 0 };
}

/** Yeni mesaj olayının adı (kuyruk ve zil) */
export const NOTE_EVENT = 'ORDER_NOTE_ADDED';

/**
 * Siparişin "yeni mesaj" bildirimlerinden, notu okunma anına (at) kadar yazılmış olanları okundu yapar — sayfa açıldıktan
 * sonra gelen mesajın bildirimi okunmamış kalır (sayaçla zil aynı şeyi söyler). Bildirim → kuyruk olayı (outbox:<id>)
 * → noteId → notun anı. Yalnızca kullanıcının kendi bildirimleri.
 * @returns {Promise<number>} okundu yapılan bildirim sayısı
 */
async function readNoteNotifications(db, { userId, orderId, at, now }) {
  const open = await db.notification.findMany({ where: { userId, orderId, type: NOTE_EVENT, isRead: false }, select: { id: true, dedupeKey: true }, take: 200 });
  if (!open.length) return 0;
  const outboxIds = open.map((n) => (n.dedupeKey ?? '').replace(/^outbox:/, '')).filter(isId);
  const events = outboxIds.length ? await db.notificationOutbox.findMany({ where: { id: { in: outboxIds } }, select: { id: true, payload: true } }) : [];
  const noteOf = new Map(events.map((e) => [e.id, typeof e.payload?.noteId === 'string' ? e.payload.noteId : null]));
  const noteIds = [...new Set([...noteOf.values()].filter(isId))];
  const seen = new Set((noteIds.length ? await db.orderNote.findMany({ where: { id: { in: noteIds }, orderId, createdAt: { lte: at } }, select: { id: true } }) : []).map((n) => n.id));
  const ids = open.filter((n) => seen.has(noteOf.get((n.dedupeKey ?? '').replace(/^outbox:/, '')) ?? '')).map((n) => n.id);
  if (!ids.length) return 0;
  const r = await db.notification.updateMany({ where: { id: { in: ids }, userId, isRead: false }, data: { isRead: true, readAt: now } });
  return r.count;
}
