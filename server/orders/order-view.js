// Sipariş verisinin role göre KİŞİ KİMLİĞİ ve OLAY GEÇMİŞİ görünümü (güvenlik denetimi 3.50.9 AUD-1, AUD-2; karar 139).
// TEK kural budur: lib/orders.ts → sanitizeOrder, veri veritabanından gelir gelmez bunu uygular. Sayfa ve istemci
// bileşenleri yalnızca bu işlevden geçmiş nesneyi görür — "ekranda gösterilmiyor" yeterli değildir.
//
// Kimlik (AUD-2): firma adını göremeyen roller (satış, çizim — CUSTOMER_NAME_VIEW yok) müşteri tarafındaki KİŞİLERİ de
// tanıyamaz: not yazarı, olayı yapan, çizimi onaylayan / revizyon isteyen, siparişi açan, dosyayı yükleyen müşteri
// kullanıcısının adı ve e-posta adresi (adresin alan adı firmayı ele verir) hiçbir alanda dönmez; yerine yalnızca rol
// ("Müşteri") kalır. Ad yokken e-postaya düşülmez. İç ekibin kişileri olduğu gibi kalır.
//
// Olay geçmişi (AUD-1): her olayın satırını ve notunu kimin görebileceği olay koduna göre aşağıdaki tabloda yazılıdır;
// tabloda olmayan (eski / bilinmeyen) olay yalnızca muhasebe yetkisine (yönetici) gider. Kural OKURKEN uygulanır: daha
// önce yazılmış satırlar (ör. alıcı e-postası ya da satış tutarı taşıyan eski notlar) yayından hemen sonra korunur;
// geçmiş kayıtlar değiştirilmez.
import { can } from '../auth/permissions.js';
import { EVENTS } from './rules.js';

/** Maskelenmiş müşteri kişisi: kimlik yok, yalnızca rol (ekranda "Müşteri") */
const MASKED_PERSON = Object.freeze({ name: null, email: '', appRole: 'MUSTERI', type: 'CUSTOMER' });

/**
 * Kişi müşteri tarafından mı? Rol / tür bilgisi taşımayan nesne müşteri sayılır (bilinmiyorsa maskelenir).
 * @param {{ appRole?: string | null, type?: string | null } | null | undefined} u
 */
export function isCustomerPerson(u) {
  if (!u) return false;
  if (u.type === 'CUSTOMER' || u.appRole === 'MUSTERI') return true;
  if (u.type === 'INTERNAL' || (u.appRole && u.appRole !== 'MUSTERI')) return false;
  return true;
}

/**
 * Bir kişi nesnesinin (ilişkiden gelen { name, email, appRole, type … }) görenin rolüne göre hâli.
 * @template {Record<string, unknown>} U
 * @param {string | null | undefined} role
 * @param {U | null | undefined} u
 * @returns {U | null | undefined}
 */
export function personView(role, u) {
  if (!u || can(role, 'CUSTOMER_NAME_VIEW') || !isCustomerPerson(u)) return u;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(u)) out[k] = null;
  return /** @type {U} */ ({ ...out, ...MASKED_PERSON });
}

// ---------- olay geçmişi ----------
const ALL = null; // siparişi gören her iç rol
const ACCOUNTING = 'ACCOUNTING_MANAGE';
const OPEN = { row: ALL, note: ALL };
/** Teklif fiyatlandırma hattının notu: satış tutarı (eski kayıtlar) ya da fiyat yazışması taşıyabilir → hazırlanan teklifi gören roller (satış, yönetici) */
const PRICING = { row: ALL, note: 'OFFER_DRAFT_VIEW' };
/** Mali belgenin varlığı müşteri fiyatını görenlere (yönetici, denetimci); notu (belge no, alıcı e-postası) yalnızca muhasebeye */
const FGO_FACT = { row: 'PRICE_FINAL_VIEW', note: ACCOUNTING };
/** Muhasebe işleri ve dış servis hata metni: yalnızca muhasebe (yönetici) */
const ACCOUNTING_ONLY = { row: ACCOUNTING, note: ACCOUNTING };

/**
 * İç ekip için olay politikası: row = satırı, note = notu görmek için gereken yetki (null: siparişi gören her iç rol).
 * Müşteri görünümü ayrıdır: server/orders/rules.js → EVENTS (customer / note).
 * @type {Record<string, { row: string | null, note: string | null }>}
 */
export const STAFF_EVENT_POLICY = {
  // olağan iş akışı, çizim, lojistik, telafi, silme / geri yükleme
  CREATED: OPEN, SENT_TO_DRAWING: OPEN, NO_DRAWING: OPEN, DRAWING_STARTED: OPEN, DRAWING_DRAFT: OPEN, DRAWING_UPLOADED: OPEN,
  DRAWING_WITHDRAWN: OPEN, REVISION_REQUESTED: OPEN, DRAWING_APPROVED: OPEN, UNDO_DRAWING: OPEN, UNDO_NO_DRAWING: OPEN,
  OFFER_SENT: OPEN, OFFER_CHECKED: OPEN, PRODUCTION: OPEN, SHIPPED: OPEN, ARCHIVED: OPEN, CANCELLED: OPEN, HOLD: OPEN, UNHOLD: OPEN,
  CRATES: OPEN, SHIP_DATE: OPEN, REMOVED: OPEN, RESTORED: OPEN,
  GUEST_HOST: OPEN, GUEST_HOST_REMOVED: OPEN, GUEST_CRATE: OPEN, GUEST_CRATE_REMOVED: OPEN,
  LOADING_CONFIRMED: OPEN, LOADING_PARTIAL: OPEN, LOADING_NOT_LOADED: OPEN, LOADING_CORRECTED: OPEN, REPLAN_NOT_LOADED: OPEN, REPLAN_CANCELLED: OPEN,
  COMPENSATION: OPEN, COMPENSATION_ADDED: OPEN, COMPENSATION_PENDING: OPEN, COMPENSATION_REJECTED: OPEN,
  // profil siparişi (satış ve çizim zaten göremez: yönetici, denetimci)
  PROFILE_OFFER_SENT: OPEN, PROFILE_APPROVED: OPEN, PICKUP_UPDATED: OPEN, PICKUP_MOVED: OPEN, PROFORMA: OPEN, PAID: OPEN,
  WAREHOUSE_SENT: OPEN, WAREHOUSE_RESENT: OPEN, WAREHOUSE_EMAILED: OPEN, DELIVERED: OPEN, INVOICED: OPEN,
  WAREHOUSE_EMAIL_FAILED: { row: ALL, note: 'OFFER_SEND' }, // SMTP hata metni
  // teklif fiyatlandırması: çizim ve denetimci satış tutarını görmez (eski OFFER_SUBMITTED notu tutar taşır)
  OFFER_SUBMITTED: PRICING, OFFER_RETURNED: PRICING, OFFER_REVISED: PRICING, OFFER_UPDATED: PRICING,
  // FGO / muhasebe
  FGO_DOC_ISSUED: FGO_FACT, FGO_DOC_EMAILED: FGO_FACT, FGO_DOC_DELETED: FGO_FACT,
  FGO_DOC_REQUESTED: ACCOUNTING_ONLY, FGO_FAILED: ACCOUNTING_ONLY, FGO_RETRY: ACCOUNTING_ONLY, COST_CORRECTED: ACCOUNTING_ONLY,
  GLASS_PAID: ACCOUNTING_ONLY, // eski (artık yazılmıyor): ödeme tutarı
};
/** Tabloda olmayan olay: yalnızca muhasebe (yönetici) — yeni bir olay kodu tabloya eklenmeden kimseye açılmaz */
export const UNKNOWN_EVENT_POLICY = ACCOUNTING_ONLY;

const EMAIL = /[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[^\s@<>()[\]{},;:"']+/g;

/** Müşteri görünümü: iç bilgi göremeyen rol (müşteri; tanımsız rol da en kısıtlı görünümü alır) */
const customerView = (role) => !can(role, 'NOTE_INTERNAL_VIEW');
const allowed = (role, perm) => perm === null || can(role, perm);

/**
 * Olay geçmişinin görenin rolüne göre hâli (satırlar, notlar, işlemi yapan kişi).
 *   Müşteri: yalnızca EVENTS'te müşteriye açık olaylar; not yalnızca notu açık olaylarda; işlemi yapan hiç dönmez.
 *   İç ekip : STAFF_EVENT_POLICY; işlemi yapan personView'dan geçer; firma adını göremeyen rolde notlardaki e-posta
 *             adresleri de silinir (serbest metin notlarına karşı ek kat).
 * @template {{ event: string, note?: string | null, user?: Record<string, unknown> | null }} E
 * @param {string | null | undefined} role
 * @param {E[]} events
 * @returns {E[]}
 */
export function eventsFor(role, events) {
  if (customerView(role)) {
    return events
      .filter((e) => /** @type {Record<string, { customer?: boolean }>} */ (EVENTS)[e.event]?.customer === true)
      .map((e) => ({ ...e, note: /** @type {Record<string, { note?: boolean }>} */ (EVENTS)[e.event]?.note ? e.note : null, ...('user' in e ? { user: null } : {}) }));
  }
  const masked = !can(role, 'CUSTOMER_NAME_VIEW');
  const out = [];
  for (const e of events) {
    const p = STAFF_EVENT_POLICY[e.event] ?? UNKNOWN_EVENT_POLICY;
    if (!allowed(role, p.row)) continue;
    let note = allowed(role, p.note) ? e.note ?? null : null;
    if (note && masked) note = note.replace(EMAIL, '***');
    out.push({ ...e, note, ...('user' in e ? { user: personView(role, e.user ?? null) } : {}) });
  }
  return out;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @param {(u: any) => any} fn
 */
function mapKeys(obj, keys, fn) {
  const out = { ...obj };
  for (const k of keys) if (k in out) out[k] = fn(out[k]);
  return out;
}

/**
 * Sipariş nesnesindeki bütün kişi kimlikleri ve olay geçmişi (lib/orders.ts → sanitizeOrder çağırır).
 *   createdBy · files[].uploadedBy · drawings[].uploadedBy / sentBy / decidedBy · notes[].user · events (+ user)
 * @template {Record<string, any>} O
 * @param {string | null | undefined} role
 * @param {O} order
 * @returns {O}
 */
export function orderPeopleView(role, order) {
  const person = (u) => personView(role, u);
  /** @type {Record<string, any>} */
  let o = mapKeys(order, ['createdBy'], person);
  if (Array.isArray(o.files)) o.files = o.files.map((f) => mapKeys(f, ['uploadedBy'], person));
  if (Array.isArray(o.drawings)) o.drawings = o.drawings.map((d) => mapKeys(d, ['uploadedBy', 'sentBy', 'decidedBy'], person));
  if (Array.isArray(o.notes)) o.notes = o.notes.map((n) => mapKeys(n, ['user'], person));
  if (Array.isArray(o.events)) o = { ...o, events: eventsFor(role, o.events) };
  return /** @type {O} */ (o);
}
