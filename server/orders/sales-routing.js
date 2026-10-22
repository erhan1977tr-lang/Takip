// Cam siparişi sorumluluğu ve yönlendirme (4.3.0, karar 300) — satışçı–çizimci bazlı sipariş sorumluluğu.
//
//   - Her cam siparişinin TEK sorumlu satışçısı vardır (Order.salesUserId). Satışçı yalnızca kendi siparişlerini, çizimci
//     yalnızca kendisine atanmış siparişleri görür (server/orders/scope.js). Atama yoksa sipariş yalnızca yöneticidedir:
//     hiçbir satışçıya / çizimciye erişim, görev ya da bildirim açılmaz.
//   - Satışçının varsayılan çizimcisi (User.defaultDrawerId) atama anında siparişin assignedDrawerId alanına KOPYALANIR;
//     eşleşmenin sonradan değişmesi eski siparişleri değiştirmez.
//   - Yönlendirme kuralı yalnızca eklenir (GlassRoutingRule): MANUAL = yeni siparişi yönetici atar; AUTO = belirlenen
//     andan (Europe/Bucharest) itibaren yeni siparişler hedef satışçıya. Geçerli kural siparişin oluşturulduğu anda
//     bakılır; kural değişikliği geçmiş atamaları ve önceden oluşmuş atamasız siparişleri DEĞİŞTİRMEZ.
//   - Yönlendirme ve atama, geçmiş veri açık hedef hesapla bağlanmadan (scripts/sales-link.mjs → bağlama işareti) açılmaz:
//     kişi bazlı erişim ayrımı eski siparişler sahiplenilmeden etkin olursa satış ekibi kendi işini göremez.
//   - Başka satışçıya yönlendirme (REASSIGN) yalnızca teklif İLK KEZ yöneticiye gönderilmeden ve çizim / yükleme / maliyet
//     gibi bağlı süreç başlamadan (reassignBlocks). Geri çekme bu sınırı sıfırlamaz. İşlem atomiktir: eski ekibin erişimi
//     kapanır, yeni satışçı ve onun çizimcisi atanır; eski satışçının taslak fiyatları yeni hesapta kullanılmaz (denetim
//     kaydında saklanır). Önceki ekibin gizli notu / dosyası varsa yönlendirme yapılmaz (diğer ekibe açılmasın).
//
// Saf kurallar (tarayıcı + test) dosyanın başında; veritabanı işlevleri sonda.

import { can } from '../auth/permissions.js';
import { writeAudit } from './journal.js';

export const ROUTING_MODES = ['MANUAL', 'AUTO'];
export const ROUTING_TIMEZONE = 'Europe/Bucharest';
/** Bağlama işareti (geçmiş verinin açık hedef hesapla bağlandığı) — IntegrationSetting anahtarı */
export const LINK_SETTING = 'sales-routing';
/** Kuralın başlangıcı en çok bu kadar geride olabilir (formun gönderilmesi sürer); daha eskisi geçmişi yeniden yazmak olurdu */
export const RULE_PAST_SLACK_MS = 5 * 60_000;
/** En çok bir yıl sonrası */
export const RULE_FUTURE_MAX_MS = 400 * 86_400_000;


/** Verilen anın `timeZone`'daki yerel tarih-saati: { day: 'YYYY-MM-DD', time: 'HH:mm' } */
export function localParts(at, timeZone = ROUTING_TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t) => p.find((x) => x.type === t)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/**
 * Yerel tarih-saat ("YYYY-MM-DDTHH:mm", `timeZone`) → UTC an. Yaz saatine geçişte olmayan saat (ör. 03:30) → null;
 * kışa geçişte iki kez yaşanan saat → ilki. Biçim / değer hatası → null.
 */
export function zonedToUtc(local, timeZone = ROUTING_TIMEZONE) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const want = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const asWall = (t) => { const p = localParts(new Date(t), timeZone); return Date.parse(`${p.day}T${p.time}:00Z`); };
  // İki aday: duvar saatinden yerel farkı çıkarılmış an (iki olası fark) — ilk tutan (erken olan) seçilir
  const candidates = [];
  for (const probe of [wall - 12 * 3_600_000, wall + 12 * 3_600_000]) candidates.push(wall - (asWall(probe) - probe));
  for (const c of [...new Set(candidates)].sort((a, b) => a - b)) {
    const p = localParts(new Date(c), timeZone);
    if (`${p.day} ${p.time}` === want) return new Date(c);
  }
  return null;
}

/**
 * Yönlendirme kuralı formu.
 * @param {{ mode?: unknown, targetUserId?: unknown, startsAt?: unknown, note?: unknown }} input  startsAt: yerel "YYYY-MM-DDTHH:mm" ya da boş (= şimdi)
 * @param {{ now: Date, timeZone?: string }} o
 * @returns {{ ok: true, rule: { mode: string, targetUserId: string | null, startsAt: Date, note: string | null } } | { ok: false, code: string }}
 */
export function parseRoutingRule(input, { now, timeZone = ROUTING_TIMEZONE }) {
  const mode = String(input?.mode ?? '');
  if (!ROUTING_MODES.includes(mode)) return { ok: false, code: 'MODE' };
  const target = typeof input?.targetUserId === 'string' && /^[a-z0-9]{8,40}$/.test(input.targetUserId) ? input.targetUserId : null;
  if (mode === 'AUTO' && !target) return { ok: false, code: 'TARGET' };
  const raw = String(input?.startsAt ?? '').trim();
  const startsAt = raw ? zonedToUtc(raw, timeZone) : new Date(now.getTime());
  if (!startsAt) return { ok: false, code: 'TIME' };
  if (startsAt.getTime() < now.getTime() - RULE_PAST_SLACK_MS) return { ok: false, code: 'PAST' };
  if (startsAt.getTime() > now.getTime() + RULE_FUTURE_MAX_MS) return { ok: false, code: 'FAR' };
  const note = String(input?.note ?? '').trim().slice(0, 500) || null;
  return { ok: true, rule: { mode, targetUserId: mode === 'AUTO' ? target : null, startsAt, note } };
}

/**
 * Bir anda geçerli kural: başlangıcı o andan önce (ya da o an) olan kuralların en geç başlayanı (eşitlikte en son yazılan).
 * @template {{ startsAt: Date | string, createdAt?: Date | string }} R
 * @param {R[]} rules  @param {Date} at
 * @returns {R | null}
 */
export function ruleAt(rules, at) {
  const t = at.getTime();
  let best = null;
  for (const r of rules ?? []) {
    const s = new Date(r.startsAt).getTime();
    if (s > t) continue;
    if (!best) { best = r; continue; }
    const bs = new Date(best.startsAt).getTime();
    if (s > bs || (s === bs && new Date(r.createdAt ?? 0).getTime() > new Date(best.createdAt ?? 0).getTime())) best = r;
  }
  return best;
}

/** Sipariş sahibi olabilecek kullanıcı: etkin, silinmemiş iç ekip satışçısı */
export const validSales = (u) => !!u && u.type === 'INTERNAL' && u.appRole === 'SATIS' && u.isActive !== false && !u.deletedAt;
/** Varsayılan çizimci olabilecek kullanıcı: etkin, silinmemiş iç ekip çizimcisi */
export const validDrawer = (u) => !!u && u.type !== 'CUSTOMER' && u.appRole === 'CIZIM' && u.isActive !== false && !u.deletedAt;

/** Durumu kapanmış sipariş başka satışçıya yönlendirilmez */
const CLOSED = ['YUKLENDI', 'ARSIVLENDI', 'IPTAL'];

/**
 * Başka satışçıya yönlendirmenin engelleri (saf). Sınır: teklif İLK KEZ yöneticiye gönderilmeden ve çizim çalışması,
 * yükleme, maliyet / belge gibi bağlı süreç başlamadan. Geri çekme sınırı sıfırlamaz (gönderim olayı kalıcıdır).
 * @param {{ status: string, removed?: boolean, orderType: string, drawingTrack: string, submittedEver: boolean,
 *   drawings: number, pdfImports: number, crates: number, loaded: number, documents: number, payments: number,
 *   compensations: boolean, staffNotes: number, staffFiles: number }} f
 * @returns {string[]} engel kodları (boş = yönlendirilebilir)
 */
export function reassignBlocks(f) {
  const out = [];
  if (f.orderType !== 'GLASS_ORDER') out.push('NOT_GLASS');
  if (f.removed || CLOSED.includes(f.status)) out.push('CLOSED');
  if (f.submittedEver) out.push('SUBMITTED');
  if (f.drawings > 0 || !['YOK', 'GEREKLI'].includes(f.drawingTrack)) out.push('DRAWING');
  if (f.pdfImports > 0) out.push('PDF_IMPORT');
  if (f.crates > 0) out.push('CRATES');
  if (f.loaded > 0) out.push('LOADED');
  if (f.documents > 0 || f.payments > 0) out.push('DOCUMENTS');
  if (f.compensations) out.push('COMPENSATION');
  if (f.staffNotes > 0) out.push('INTERNAL_NOTES');
  if (f.staffFiles > 0) out.push('INTERNAL_FILES');
  return out;
}

// ---------------- Veritabanı ----------------

const ROUTING_LOCK = 'glass-routing';
const USER_FIELDS = { id: true, type: true, appRole: true, isActive: true, deletedAt: true, name: true, email: true, defaultDrawerId: true };

/** Geçmiş veri bağlandı mı (yönlendirme / atama bunun ardından açılır) */
export async function routingLinked(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: LINK_SETTING } });
  return !!(row?.value && typeof row.value === 'object' && row.value.linkedAt);
}

/** Satışçının şu anki varsayılan çizimcisi (geçerliyse) */
export async function drawerOf(tx, salesUserId) {
  if (!salesUserId) return null;
  const u = await tx.user.findUnique({ where: { id: salesUserId }, select: { defaultDrawer: { select: USER_FIELDS } } });
  return validDrawer(u?.defaultDrawer) ? u.defaultDrawer.id : null;
}

/**
 * Yeni cam siparişinin sorumlusu — sipariş oluşturma işleminin İÇİNDE çağrılır (kural okuması paylaşımlı kilitle:
 * kural değişikliği bitene kadar bekler; iki sipariş aynı anda kuralı okuyabilir).
 * @returns {Promise<{ salesUserId: string, assignedDrawerId: string | null, salesAssignedVia: 'AUTO', routingRuleId: string, salesAssignedAt: Date } | null>}
 *   null → atama bekler (MANUAL kip, kural yok, bağlama yapılmamış ya da hedef geçersiz — sonuncusunda yönetici uyarısı)
 */
export async function routeNewOrder(tx, { now, orderNo = null }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${ROUTING_LOCK}, 0))`;
  if (!(await routingLinked(tx))) return null;
  const rules = await tx.glassRoutingRule.findMany({ where: { startsAt: { lte: now } }, orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }], take: 1 });
  const rule = ruleAt(rules, now);
  if (!rule || rule.mode !== 'AUTO') return null;
  const target = rule.targetUserId ? await tx.user.findUnique({ where: { id: rule.targetUserId }, select: USER_FIELDS }) : null;
  if (!validSales(target)) {
    // Sessiz atama yok: sipariş atama bekler, yönetici "Önemli kararlar"da görür (kural başına tek uyarı)
    await tx.adminAlert.upsert({
      where: { dedupeKey: `routing-invalid:${rule.id}` },
      update: {},
      create: { type: 'ROUTING_TARGET_INVALID', details: { ruleId: rule.id, orderNo }, dedupeKey: `routing-invalid:${rule.id}` },
    });
    return null;
  }
  return { salesUserId: target.id, assignedDrawerId: await drawerOf(tx, target.id), salesAssignedVia: 'AUTO', routingRuleId: rule.id, salesAssignedAt: now };
}

const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });

/**
 * Yönlendirme kuralı yazar (yalnızca ekler). Yetki: SETTINGS_MANAGE (yalnızca yönetici) — ilk deyim, veritabanına
 * gitmeden. Geçmiş veri bağlanmadan yazılmaz. Kural yalnızca İLERİYE etkilidir: var olan siparişlere dokunulmaz.
 * @param {any} db  @param {{ input: object, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 */
export async function saveRoutingRule(db, { input, actor, now = new Date() }) {
  if (!actor?.id || !can(actor.role, 'SETTINGS_MANAGE')) return FORBIDDEN;
  const parsed = parseRoutingRule(input, { now });
  if (!parsed.ok) return parsed;
  const { rule } = parsed;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ROUTING_LOCK}, 0))`;
    if (!(await routingLinked(tx))) return { ok: false, code: 'NOT_LINKED' };
    if (rule.targetUserId) {
      const target = await tx.user.findUnique({ where: { id: rule.targetUserId }, select: USER_FIELDS });
      if (!validSales(target)) return { ok: false, code: 'TARGET' };
    }
    const row = await tx.glassRoutingRule.create({ data: { ...rule, createdById: actor.id } });
    await writeAudit(tx, {
      action: 'ROUTING_RULE_CREATED', entityType: 'GlassRoutingRule', entityId: row.id, userId: actor.id,
      details: { mode: row.mode, targetUserId: row.targetUserId, startsAt: row.startsAt.toISOString(), note: row.note },
    }, actor);
    return { ok: true, id: row.id };
  });
}

/**
 * Satışçının varsayılan çizimcisi (karar 300). Yetki: USER_MANAGE (yönetici) — ilk deyim. Yalnızca sonraki atamaları
 * etkiler: var olan siparişlerin assignedDrawerId alanı DEĞİŞMEZ. drawerId boş = eşleşme kaldırılır.
 * @param {any} db  @param {{ salesUserId: string, drawerId: string | null, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, changed: boolean } | { ok: false, code: 'FORBIDDEN' | 'SALES' | 'DRAWER' }>}
 */
export async function setDefaultDrawer(db, { salesUserId, drawerId, actor }) {
  if (!actor?.id || !can(actor.role, 'USER_MANAGE')) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    const sales = typeof salesUserId === 'string' && salesUserId ? await tx.user.findUnique({ where: { id: salesUserId }, select: USER_FIELDS }) : null;
    if (!validSales(sales)) return { ok: false, code: 'SALES' };
    const drawer = drawerId ? await tx.user.findUnique({ where: { id: drawerId }, select: USER_FIELDS }) : null;
    if (drawerId && !validDrawer(drawer)) return { ok: false, code: 'DRAWER' };
    const next = drawer?.id ?? null;
    if ((sales.defaultDrawerId ?? null) === next) return { ok: true, changed: false };
    // Koşullu yazım: arada başka biri değiştirdiyse üzerine yazılmaz
    const r = await tx.user.updateMany({ where: { id: sales.id, defaultDrawerId: sales.defaultDrawerId ?? null }, data: { defaultDrawerId: next } });
    if (r.count !== 1) return { ok: false, code: 'SALES' };
    await writeAudit(tx, {
      action: 'SALES_DEFAULT_DRAWER', entityType: 'User', entityId: sales.id, userId: actor.id,
      details: { before: sales.defaultDrawerId ?? null, after: next },
    }, actor);
    return { ok: true, changed: true };
  });
}

/** Yönetici ekranı: kurallar (yeniden eskiye) ve şu anki kural */
export async function routingState(db, now = new Date()) {
  const [rules, linked] = await Promise.all([
    db.glassRoutingRule.findMany({ orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }], take: 50, include: { targetUser: { select: { id: true, name: true, email: true, isActive: true } }, createdBy: { select: { name: true, email: true } } } }),
    routingLinked(db),
  ]);
  return { rules, linked, current: ruleAt(rules, now), upcoming: rules.filter((r) => r.startsAt > now) };
}

/**
 * Başka satışçıya yönlendirmenin gerçekleri (iş akışı işleminin içinde, kilit altında okunur).
 * @param {any} tx  @param {{ id: string, status: string, removedAt: Date | null, orderTypeCode: string, drawingTrack: string, compOfId: string | null }} order
 */
export async function reassignFacts(tx, order) {
  const staff = { appRole: { in: ['SATIS', 'CIZIM'] } };
  const [submitted, drawings, pdfImports, crates, loaded, documents, batches, payments, compFrom, compTo, staffNotes, staffFiles] = await Promise.all([
    tx.orderEvent.count({ where: { orderId: order.id, event: 'OFFER_SUBMITTED' } }),
    tx.drawing.count({ where: { orderId: order.id } }),
    tx.offerImport.count({ where: { orderId: order.id } }),
    tx.crateOrder.count({ where: { orderId: order.id } }),
    tx.loadingConfirmationItem.count({ where: { orderId: order.id } }),
    tx.fgoDocument.count({ where: { orderId: order.id } }),
    tx.billingBatchOrder.count({ where: { orderId: order.id } }),
    tx.manualPayment.count({ where: { orderId: order.id } }),
    tx.compensation.count({ where: { sourceOrderId: order.id } }),
    tx.compensation.count({ where: { destOrderId: order.id } }),
    tx.orderNote.count({ where: { orderId: order.id, internal: true, user: staff } }),
    tx.orderFile.count({ where: { orderId: order.id, kind: 'INTERNAL', uploadedBy: staff } }),
  ]);
  return {
    status: order.status, removed: !!order.removedAt, orderType: order.orderTypeCode, drawingTrack: order.drawingTrack,
    submittedEver: submitted > 0, drawings, pdfImports, crates, loaded, documents: documents + batches, payments,
    compensations: compFrom + compTo > 0 || !!order.compOfId, staffNotes, staffFiles,
  };
}
