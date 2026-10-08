// Uygulama içi bildirimler (zil) — Aşama 8, karar 107. İKİNCİ bir bildirim sistemi değildir: olayların kaynağı yine
// NotificationOutbox'tır (iş akışı işlemleri aynı veritabanı işleminde yazar); e-posta (email.js) ve uygulama içi bildirim
// aynı olayların iki AYRI kanalıdır. İşçi (scripts/worker.mjs) her turda henüz dağıtılmamış olayları (inAppAt boş)
// alıcılarına Notification satırı olarak yazar.
//
//   Alıcılar e-posta kurallarıyla aynı mantıktadır (rol adına değil yetkiye göre; atanmış çizimci; siparişle ilgilenen
//   satışçı); müşteri için siparişin firmasının etkin kullanıcıları. İşlemi yapan kullanıcıya kendi işlemi bildirilmez
//   (muhasebe işlemi gerektiren olaylar hariç — onlar yapılacak iştir).
//   Gizlilik: metnin değerleri alıcı başına saklanır — firma adını göremeyen role (satış, çizim) MASKELİ yazılır;
//   müşteriye yalnızca kendi siparişinin numarası gider; tutar hiçbir bildirimde yoktur (FGO avans tutarı yalnızca
//   muhasebe yetkisine). Bağlantı yetki değildir: açılan sayfa kendi yetki denetimini yapar.
//   Tekrar engeli: Notification [userId, dedupeKey] benzersizdir; anahtar olayın kimliğidir ("outbox:<id>",
//   "alert:<id>", "advance:<belge>:<tahsilat>"). İşçi yeniden denese / iki işçi birlikte çalışsa da aynı olay aynı
//   kullanıcıya bir kez yazılır. Ses, açılır bildirim ve sekme başlığı istemcidedir (server/notifications/feed.js).
import { can, ROLE_PERMISSIONS } from '../auth/permissions.js';
import { maskName } from '../orders/rules.js';
import { translate } from '../i18n/index.js';
import { orderSalesUsers } from './email.js';
import { DOC_EMAIL } from '../documents/delivery.js';
import { GUEST_ASSIGNED, GUEST_REMOVED } from '../loading/crates.js';

const rolesWith = (pred) => Object.keys(ROLE_PERMISSIONS).filter(pred);
/** Alıcı kümeleri → roller (yetkiden türetilir) */
export const AUDIENCE_ROLES = {
  admin: rolesWith((r) => can(r, 'OFFER_SEND')),
  sales: rolesWith((r) => can(r, 'OFFER_PREPARE') && !can(r, 'OFFER_SEND')),
  accounting: rolesWith((r) => can(r, 'ACCOUNTING_MANAGE')),
  loading: rolesWith((r) => can(r, 'LOADING_CONFIRM')),
};

const orderLink = (o) => `/siparisler/${o.id}`;
/** Siparişin ilgili bölümü (karar 166): bildirime tıklayan doğrudan çizim kararına / teklife / çizimlere iner */
const orderPart = (hash) => (o) => `/siparisler/${o.id}#${hash}`;
/** Kayıt kimliği (cuid): bağlantıya yalnızca bu biçimdeki değer girer */
const isId = (v) => typeof v === 'string' && /^[a-z0-9]{8,40}$/i.test(v);
/**
 * İlgili çizim SÜRÜMÜ (Paket 3): olayın kuyruktaki drawingId'si varsa o sürümün ekranı, yoksa siparişin çizim bölümü.
 * Bağlantı yetki değildir: çizim ekranı kendi kuralını uygular (karar 146 — müşteri geri çekilen sürümü açamaz).
 */
const drawingLink = (hash) => (o, p) => (isId(p?.drawingId) ? `/siparisler/${o.id}/cizim/${p.drawingId}` : `/siparisler/${o.id}#${hash}`);
const dayLink = (hash = '') => (_o, p) => `/yuklemeler?gun=${p.day}${hash}`;

/**
 * Olay → alıcı kümeleri ve bağlantı. customer: siparişin firmasının kullanıcıları · drawer: atanmış çizimci ·
 * orderSales: siparişle ilgilenen satışçı (bilinmiyorsa satış ekibi) · admin / sales / accounting / loading: yetkiye göre.
 * Yalnızca dikkat / işlem gerektiren olaylar; her alan değişikliği bildirim üretmez.
 */
export const INAPP_RULES = {
  // Yeni sipariş: cam → satış + yönetici; profil → yalnızca yönetici (profil satışa uğramaz)
  ORDER_CREATED: { to: (o) => (o.orderTypeCode === 'PROFILE_ORDER' ? ['admin'] : ['sales', 'admin']) },
  // Çizim: atama ve müşteri kararı yalnızca atanmış çizimciye + ilgili satışçıya (yöneticiye değil — karar 84)
  ORDER_SENT_TO_DRAWING: { to: () => ['drawer'] },
  // Müşteriye yeni çizim: bağlantı siparişteki kırmızı "yeni çizim onayınızı bekliyor" bilgilendirmesine (karar 162, 166)
  ORDER_DRAWING_UPLOADED: { to: () => ['customer'], link: orderPart('cizim-onay') },
  // Revizyon: çizimcinin sipariş sayfasındaki "Çizim onayı ve revizyon" bölümüne (numaralı not + çevirisi)
  ORDER_REVISION_REQUESTED: { to: () => ['drawer', 'orderSales'], link: orderPart('cizim') },
  // Onay: onaylanan sürümün ekranına (Paket 3 — "doğru çizim sürümü")
  ORDER_DRAWING_APPROVED: { to: () => ['drawer', 'orderSales'], link: drawingLink('cizim') },
  // Müşterinin DWG/DXF çizimi (karar 167): "hatalı" kararı müşteriye (sipariş sayfasındaki kırmızı bilgilendirmeye);
  // "üretime hazır" ilgili satışçıya; müşterinin yanıtı (düzeltilmiş dosya / fabrika çizimi) çizimciye + ilgili satışçıya
  ORDER_DWG_FAULTY: { to: () => ['customer'], link: orderPart('cizim-hatali') },
  ORDER_DWG_READY: { to: () => ['orderSales'], link: orderPart('cizim') },
  ORDER_DWG_RESUBMITTED: { to: () => ['drawer', 'orderSales'], link: orderPart('cizim') },
  ORDER_DWG_FACTORY_REQUESTED: { to: () => ['drawer', 'orderSales'], link: orderPart('cizim') },
  // Teklif / ticari karar: satış teklifi yöneticiye; yönetici satışa geri gönderdi; teklif müşteride. Yöneticinin teklifi
  // müşteriye göndermesi (ilk gönderim ya da yeni sürüm) yalnızca MÜŞTERİYE bildirilir — satışa ne zil ne e-posta (Paket 4)
  ORDER_OFFER_SUBMITTED: { to: () => ['admin'] },
  ORDER_OFFER_RETURNED: { to: () => ['orderSales'] },
  ORDER_OFFER_SENT: { to: () => ['customer'], link: orderPart('teklif') },
  ORDER_OFFER_UPDATED: { to: () => ['customer'], link: orderPart('teklif') },
  ORDER_PROFILE_OFFER_SENT: { to: () => ['customer'], link: orderPart('teklif') },
  ORDER_PROFILE_APPROVED: { to: () => ['admin'] },
  ORDER_PROFORMA: { to: () => ['customer'] },
  ORDER_INVOICED: { to: () => ['customer'] },
  // Yükleme
  ORDER_SHIP_DATE: { to: () => ['customer'] },
  ORDER_SHIPPED: { to: () => ['customer'] },
  LOADING_NOT_LOADED: { to: () => ['loading', 'orderSales'], link: dayLink('#yuklenmeyen') },
  LOADING_REPLANNED: { to: () => ['customer', 'orderSales'], link: dayLink() },
  // Yükleme düzeltmesi kesilmiş faturayla uyuşmuyor: muhasebe yetkisi olan herkese (düzeltmeyi yapan dahil — yapılacak iş)
  ACCOUNTING_ACTION: { to: () => ['accounting'], includeActor: true, link: dayLink('#faturalama') },
};
export const INAPP_TYPES = Object.keys(INAPP_RULES);

/** Mali belge kesildi (karar 111): belge türü → müşteriye giden bildirim tipi ("Proforma este disponibilă." …) */
export const DOC_NOTICE = { PROFORMA: 'DOC_PROFORMA', ADVANCE: 'DOC_ADVANCE', INVOICE: 'DOC_INVOICE' };

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const dmy = (day) => (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10).split('-').reverse().join('.') : '');
const USER = { id: true, appRole: true };

/**
 * Alıcılar: [{ id, appRole, aud }] (kullanıcıya göre tekil; yalnızca etkin kullanıcılar). aud: 'customer' | 'staff'.
 * @param {any} db  @param {string[]} audiences
 * @param {{ id: string, customerId: string, assignedDrawerId?: string | null }} order
 * @param {{ actorId?: string | null }} [o]  actorId: işlemi yapan — kendisine bildirilmez
 */
export async function recipientsOf(db, audiences, order, { actorId = null } = {}) {
  const out = new Map();
  const add = (u, aud) => {
    if (u && u.id !== actorId && !out.has(u.id)) out.set(u.id, { id: u.id, appRole: u.appRole, aud });
  };
  for (const a of audiences) {
    if (a === 'customer') {
      if (!order?.customerId) continue;
      // Yalnızca siparişin firmasının müşteri kullanıcıları: başka firmanın kullanıcısına hiçbir zaman gitmez
      const users = await db.user.findMany({ where: { customerId: order.customerId, appRole: 'MUSTERI', isActive: true }, select: USER });
      for (const u of users) add(u, 'customer');
    } else if (a === 'drawer') {
      if (!order?.assignedDrawerId) continue;
      add(await db.user.findFirst({ where: { id: order.assignedDrawerId, isActive: true }, select: USER }), 'staff');
    } else if (a === 'orderSales') {
      // İlgili satışçı biliniyorsa yalnızca o; bilinmiyorsa satış ekibi (e-posta kuralıyla aynı). Yönetici değil.
      const known = order?.id ? (await orderSalesUsers(db, order.id)).filter((u) => u.isActive && AUDIENCE_ROLES.sales.includes(u.appRole)) : [];
      const users = known.length ? known : await db.user.findMany({ where: { appRole: { in: AUDIENCE_ROLES.sales }, isActive: true }, select: USER });
      for (const u of users) add(u, 'staff');
    } else {
      const users = await db.user.findMany({ where: { appRole: { in: AUDIENCE_ROLES[a] ?? [] }, isActive: true }, select: USER });
      for (const u of users) add(u, 'staff');
    }
  }
  return [...out.values()];
}

/**
 * Bildirimin başlığı ve gövdesi, okuyanın diliyle (type + params'tan; alıcıya özel değerler params'ta zaten süzülmüş).
 *   Sipariş olayları (ORDER_<OLAY>): mevcut olay metinleri (events.<OLAY>.label / .customer) — ayrı metin yazılmaz.
 *   Diğerleri: notifications.types.<TİP>.title (müşteri için .customer). Ayrıntı: notifications.detail.<TİP>.
 * @param {'ro' | 'tr'} locale
 * @param {{ type?: string | null, params?: any, message?: string | null }} n
 * @returns {{ title: string, body: string }}
 */
export function renderInApp(locale, n) {
  const t = (k, p) => translate(locale, k, p);
  const has = (k) => t(k) !== k;
  const p = obj(n.params);
  const customer = p.aud === 'customer';
  const type = n.type ?? '';
  let title = n.message || type;
  const own = `notifications.types.${type}.${customer ? 'customer' : 'title'}`;
  if (type && has(own)) title = t(own);
  else if (type && has(`notifications.types.${type}.title`)) title = t(`notifications.types.${type}.title`);
  else if (type.startsWith('ORDER_')) {
    const ev = type.slice(6);
    const k = customer ? `events.${ev}.customer` : `events.${ev}.label`;
    if (ev === 'CREATED' && !customer) title = t('notify.newOrder');
    else if (has(k)) title = t(k);
    else if (has(`events.${ev}.label`)) title = t(`events.${ev}.label`);
  }
  const detailKey = `notifications.detail.${type}`;
  const detail = type && has(detailKey)
    ? t(detailKey, {
      date: dmy(p.day), from: dmy(p.from), qty: p.qty ?? '', ref: p.ref ?? '—', amount: p.amount ?? '', error: String(p.error ?? '').slice(0, 160),
      crate: p.crate ?? '', guest: p.guest ?? '', guestOrder: p.guestOrder ?? '', user: String(p.user ?? '').slice(0, 200),
    })
    : '';
  const order = p.orderNo ? (customer ? t('notifications.order', { orderNo: p.orderNo }) : String(p.orderNo)) : '';
  return { title, body: [order, customer ? '' : p.firm, detail].filter(Boolean).join(' · ') };
}

/**
 * Bildirim satırlarını yazar (alıcı başına bir satır; aynı anahtar aynı kullanıcıya ikinci kez yazılmaz).
 * firmName: iç ekibe gösterilecek firma adı — görme yetkisi olmayan role maskeli saklanır; müşteriye hiç yazılmaz.
 * @param {any} db
 * @param {{ key: string, type: string, users: { id: string, appRole: string, aud: string }[], orderId?: string | null, orderNo?: string | null,
 *   firmName?: string | null, params?: object, link?: string | null }} n
 * @returns {Promise<number>}  yeni yazılan satır sayısı
 */
export async function createNotifications(db, { key, type, users, orderId = null, orderNo = null, firmName = null, params = {}, link = null }) {
  if (!users.length) return 0;
  const data = users.map((u) => {
    const staff = u.aud !== 'customer';
    const p = {
      ...params, aud: staff ? 'staff' : 'customer', ...(orderNo ? { orderNo } : {}),
      ...(staff && firmName ? { firm: can(u.appRole, 'CUSTOMER_NAME_VIEW') ? firmName : maskName(firmName) } : {}),
    };
    const text = renderInApp('ro', { type, params: p });
    return { userId: u.id, type, params: p, link, orderId, dedupeKey: key, message: [text.title, text.body].filter(Boolean).join(' — ').slice(0, 500) };
  });
  const r = await db.notification.createMany({ data, skipDuplicates: true });
  return r.count;
}

const ORDER = { id: true, orderNo: true, orderTypeCode: true, customerId: true, assignedDrawerId: true, actualShipDate: true, estimatedShipDate: true, removedAt: true, customer: { select: { name: true } } };
const shipDay = (o) => {
  const d = o.actualShipDate ?? o.estimatedShipDate;
  return d ? new Date(d).toISOString().slice(0, 10) : null;
};

/** Bir kuyruk olayını alıcılarına yazar. @returns {Promise<number>} */
async function fanOut(db, row) {
  const rule = INAPP_RULES[row.type];
  const order = row.orderId ? await db.order.findUnique({ where: { id: row.orderId }, select: ORDER }) : null;
  // Silinmiş siparişin (karar 110) kuyrukta kalmış olayı bildirime dönüşmez
  if (!rule || !order || order.removedAt) return 0;
  const payload = obj(row.payload);
  const users = await recipientsOf(db, rule.to(order, payload), order, { actorId: rule.includeActor ? null : payload.actorId ?? null });
  // Metne yalnızca gereken, herkesin görebileceği değerler girer (gün, adet, belge no) — tutar ve not girmez
  const params = {
    ...(payload.day ? { day: String(payload.day) } : row.type === 'ORDER_SHIP_DATE' && shipDay(order) ? { day: shipDay(order) } : {}),
    ...(payload.from && /^\d{4}-/.test(String(payload.from)) ? { from: String(payload.from) } : {}),
    ...(payload.qty != null ? { qty: Number(payload.qty) } : {}),
    ...(payload.ref ? { ref: String(payload.ref) } : {}),
  };
  return createNotifications(db, {
    key: `outbox:${row.id}`, type: row.type, users, orderId: order.id, orderNo: order.orderNo, firmName: order.customer?.name ?? null,
    params, link: rule.link ? rule.link(order, payload) : orderLink(order),
  });
}

/**
 * Mali belge kesildi → müşterinin kullanıcılarına "belge hazır" bildirimi (bağlantı: Documente financiare). Kaynak, belge
 * kaydıyla birlikte yazılan e-posta işidir (FGO_DOC_EMAIL) — ayrı bir olay yazılmaz; e-posta ile bildirim iki ayrı
 * kanaldır (e-posta adresi olmasa da bildirim gider). Anahtar belgenin kimliğidir: belge başına bir bildirim.
 *   - Elle "e-postayı yeniden gönder" bildirim üretmez (iş inAppAt dolu yazılır; burada da atlanır).
 *   - Profil siparişinde aynı olay zaten bildirilir (ORDER_PROFORMA / ORDER_INVOICED) — ikincisi yazılmaz.
 *   - Kesilemeyen belgenin kaydı (ve işi) olmadığından bildirimi de olmaz.
 */
async function fanOutDocument(db, row) {
  const p = obj(row.payload);
  if (p.manual || !p.docId) return 0;
  const doc = await db.fgoDocument.findUnique({
    where: { id: String(p.docId) },
    select: {
      id: true, kind: true, series: true, number: true,
      order: { select: { id: true, orderNo: true, orderTypeCode: true, customerId: true, removedAt: true } },
      batch: { select: { customerId: true, orders: { select: { orderNo: true }, orderBy: { orderNo: 'asc' } } } },
    },
  });
  const type = doc ? DOC_NOTICE[doc.kind] : null;
  if (!doc || !type || doc.order?.orderTypeCode === 'PROFILE_ORDER' || doc.order?.removedAt) return 0;
  const customerId = doc.order?.customerId ?? doc.batch?.customerId ?? null;
  if (!customerId) return 0;
  // Yalnızca belgenin sahibi firmanın müşteri kullanıcıları
  const users = await recipientsOf(db, ['customer'], { customerId });
  const nos = doc.order ? [doc.order.orderNo] : (doc.batch?.orders ?? []).map((o) => o.orderNo);
  return createNotifications(db, {
    key: `doc:${doc.id}`, type, users, orderId: doc.order?.id ?? null, orderNo: nos.join(', ') || null,
    params: { ref: `${doc.series}${doc.number}` }, link: `/belgeler#doc-${doc.id}`,
  });
}

/**
 * "Özel durum" (karar 124): misafir yükün sandığı seçildi / değişti / kaldırıldı → İKİ firmanın müşteri kullanıcılarına.
 *   Sipariş sahibi firma (PLACED / CANCELLED): kendi sipariş numarası, sandık numarası, yükleme günü. Ev sahibi firmanın
 *     adı ve hiçbir verisi yazılmaz.
 *   Sandığın firması (HOSTED / UNHOSTED): misafir firmanın adı, sipariş numarası, sandık numarası, yükleme günü — yalnızca
 *     bu dört işletme bilgisi. Bildirim misafir siparişe bağlanmaz (orderId yok, bağlantı kendi yükleme günü): fiyat,
 *     teklif, belge, dosya ya da başka ticari veri ev sahibine hiçbir yoldan gitmez.
 * İç ekibe ayrıca bildirim yazılmaz (Yüklemeler ekranındaki uyarı). Anahtar olayın kimliğidir: sayfa yenileme / işçinin
 * yeniden denemesi ikinci bildirim üretmez; sandık her gerçek değişiklikte bir kez bildirilir.
 */
async function fanOutGuest(db, row) {
  const p = obj(row.payload);
  const order = row.orderId ? await db.order.findUnique({ where: { id: row.orderId }, select: ORDER }) : null;
  const day = typeof p.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.day) ? p.day : null;
  const crate = Number(p.crateNo);
  if (!order || order.removedAt || !p.hostId || !day || !Number.isInteger(crate)) return 0;
  const removed = row.type === GUEST_REMOVED;
  const link = `/yuklemeler?gun=${day}`;
  const key = `outbox:${row.id}`;
  const owners = await recipientsOf(db, ['customer'], order);
  const hosts = String(p.hostId) === order.customerId ? [] : await recipientsOf(db, ['customer'], { customerId: String(p.hostId) });
  const a = await createNotifications(db, { key, type: removed ? 'GUEST_CRATE_CANCELLED' : 'GUEST_CRATE_PLACED', users: owners, orderId: order.id, orderNo: order.orderNo, params: { day, crate }, link });
  const b = await createNotifications(db, {
    key, type: removed ? 'GUEST_CRATE_UNHOSTED' : 'GUEST_CRATE_HOSTED', users: hosts, params: { day, crate, guest: order.customer?.name ?? '', guestOrder: order.orderNo }, link,
  });
  return a + b;
}

/** Bir kuyruk olayını dağıtır ve işaretler (dispatchInApp ve dispatchInAppFor ortak). @returns {Promise<number>} yeni bildirim */
async function dispatchRow(db, row, { now, log }) {
  let created = 0;
  try {
    if (row.type === DOC_EMAIL) created += await fanOutDocument(db, row);
    else if (row.type === GUEST_ASSIGNED || row.type === GUEST_REMOVED) created += await fanOutGuest(db, row);
    else if (INAPP_RULES[row.type]) created += await fanOut(db, row);
    await db.notificationOutbox.updateMany({ where: { id: row.id, inAppAt: null }, data: { inAppAt: now } });
  } catch (e) {
    log('uygulama içi bildirim dağıtılamadı', row.type, row.orderId, String(e?.message ?? e).slice(0, 200));
    // Bir günden eski, dağıtılamayan olay kuyruğu tıkamasın
    if (now.getTime() - new Date(row.createdAt).getTime() > 86_400_000) {
      await db.notificationOutbox.updateMany({ where: { id: row.id, inAppAt: null }, data: { inAppAt: now } }).catch(() => {});
    }
  }
  return created;
}

/**
 * Kuyruktaki, henüz dağıtılmamış olayları uygulama içi bildirime çevirir (işçi her turda çağırır; e-posta ayarından
 * bağımsızdır). Dağıtılan olay inAppAt ile işaretlenir; işaretlenemeden yarıda kalırsa sonraki turda yeniden denenir —
 * benzersiz anahtar sayesinde aynı bildirim ikinci kez yazılmaz.
 * @param {any} db
 * @param {{ now?: Date, limit?: number, log?: Function }} [o]
 * @returns {Promise<{ events: number, created: number }>}
 */
export async function dispatchInApp(db, { now = new Date(), limit = 200, log = () => {} } = {}) {
  const rows = await db.notificationOutbox.findMany({ where: { inAppAt: null }, orderBy: { createdAt: 'asc' }, take: limit });
  let created = 0;
  for (const row of rows) created += await dispatchRow(db, row, { now, log });
  return { events: rows.length, created };
}

/**
 * Bir iş akışı işleminin AZ ÖNCE yazdığı kuyruk olaylarını hemen dağıtır (Paket 3 — bildirim gecikmesi): uygulama,
 * işlem kaydedildikten sonra çağırır (lib/notifications.ts → deliverInAppNow), işçinin turunu (60 sn + tarama / FGO işleri) beklemez. Aynı
 * dağıtıcıdır — ikinci bir bildirim sistemi değildir: yalnızca verilen, henüz dağıtılmamış (inAppAt boş) olaylar işlenir;
 * işçi de aynı olayı alırsa benzersiz anahtar ikinci bildirimi engeller. Hata işlemi etkilemez (işçi yeniden dener).
 * @param {any} db
 * @param {string[]} ids  kuyruk olaylarının kimlikleri
 * @param {{ now?: Date, log?: Function }} [o]
 * @returns {Promise<{ events: number, created: number }>}
 */
export async function dispatchInAppFor(db, ids, { now = new Date(), log = () => {} } = {}) {
  const list = [...new Set((ids ?? []).filter((x) => typeof x === 'string' && x))].slice(0, 50);
  if (!list.length) return { events: 0, created: 0 };
  const rows = await db.notificationOutbox.findMany({ where: { id: { in: list }, inAppAt: null }, orderBy: { createdAt: 'asc' } });
  let created = 0;
  for (const row of rows) created += await dispatchRow(db, row, { now, log });
  return { events: rows.length, created };
}

/**
 * İşçiden / eşitlemeden doğan olaylar için doğrudan bildirim (kuyruk olayı olmayan: FGO'da belge kesilemedi, proformaya
 * tahsilat geldi → avans faturası gerekli). Alıcı yalnızca yetkiye göre iç ekip kümesi; anahtar olayın kimliğidir.
 * @param {any} db
 * @param {{ audience: 'accounting' | 'admin' | 'loading', key: string, type: string, orderId?: string | null, firmName?: string | null, params?: object, link: string, actorId?: string | null }} n
 *   actorId: işlemi yapan kullanıcı — verilirse kendisine bildirilmez (kuyruk olaylarındaki kuralın aynısı)
 * @returns {Promise<number>}
 */
export async function notifyStaff(db, { audience, key, type, orderId = null, firmName = null, params = {}, link, actorId = null }) {
  const order = orderId ? await db.order.findUnique({ where: { id: orderId }, select: ORDER }) : null;
  const users = await recipientsOf(db, [audience], order, { actorId });
  return createNotifications(db, { key, type, users, orderId: order?.id ?? null, orderNo: order?.orderNo ?? null, firmName: order?.customer?.name ?? firmName, params, link });
}

/** FGO'da belge kesilemedi (yönetici uyarısıyla aynı olay): muhasebe yetkisine. Hata bildirimi hiçbir işlemi düşürmez. */
export function notifyFgoFailed(db, { key, orderId = null, firmName = null, customerId = null, error }) {
  return notifyStaff(db, {
    audience: 'accounting', key, type: 'FGO_FAILED', orderId, firmName, params: { error: String(error ?? '').slice(0, 200) },
    link: orderId ? `/siparisler/${orderId}#finans` : `/admin/muhasebe/cam/proforma${customerId ? `?musteri=${customerId}` : ''}#partiler`,
  }).catch(() => 0);
}

/**
 * FGO eşitlemesi proformada avansı kesilmemiş tahsilat gördü: "avans faturası gerekli". Anahtar belge + tahsilat
 * tutarıdır — saatlik eşitleme aynı tahsilatı yeniden görse de bildirim bir kez yazılır; tahsilat artarsa yeni bildirim.
 * @param {any} db
 * @param {{ doc: { id: string, series: string, number: string, orderId?: string | null }, paid: number, required: number, firmName?: string | null, customerId?: string | null }} p
 */
export function notifyAdvanceRequired(db, { doc, paid, required, firmName = null, customerId = null }) {
  return notifyStaff(db, {
    audience: 'accounting', key: `advance:${doc.id}:${Number(paid).toFixed(2)}`, type: 'ADVANCE_REQUIRED', orderId: doc.orderId ?? null, firmName,
    params: { ref: `${doc.series}${doc.number}`, amount: Number(required).toFixed(2).replace('.', ',') },
    link: doc.orderId ? `/siparisler/${doc.orderId}#finans` : `/admin/muhasebe/cam/proforma${customerId ? `?musteri=${customerId}` : ''}#partiler`,
  }).catch(() => 0);
}
