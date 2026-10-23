// Fabrika Ekipleri (4.3.19, karar 304) — TEK yazan. Ekip = bir cam fabrikasını temsil eden satışçı hesabı + ad + aktiflik.
// İkinci bir eşleştirme yok: ekran var olan alanları yazar —
//   çizimci        = User.defaultDrawerId (setDefaultDrawer ile aynı kural ve denetim kaydı),
//   fiyat tablosu  = User.priceTableId     (assignTable ile aynı kural ve denetim kaydı),
//   finansal hesap = satışçı hesabı        (FactoryPayment.salesUserId — Muhasebe → Cam Fabrika Hesap Durumu).
// Kurallar: satışçı tek ekipte (DB unique) ve ekip oluştuktan sonra değişmez; aktif ekipler arasında çizimci ve fiyat
// tablosu tekil; pasifleştirme geçmiş siparişleri, kullanıcı hesaplarını ve var olan bağlantıları DEĞİŞTİRMEZ — yalnızca
// yeni yönlendirme / atamayı engeller (sales-routing.js → routeNewOrder, saveRoutingRule; transitions.js → assign_sales).
// Yetki: USER_MANAGE + PRICE_TABLE_MANAGE (yönetici) — her dışa açık işlevin ilk deyimi.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { ROUTING_TIMEZONE, ruleAt, validDrawer, validSales } from '../orders/sales-routing.js';
import { lockTeams, teamConflicts } from './state.js';

const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });
export const TEAM_NAME_MAX = 80;
const USER_FIELDS = { id: true, type: true, appRole: true, isActive: true, deletedAt: true, name: true, email: true, defaultDrawerId: true, priceTableId: true };

export const allowed = (actor) => !!actor?.id && can(actor.role, 'USER_MANAGE') && can(actor.role, 'PRICE_TABLE_MANAGE');

/** Ad karşılaştırma anahtarı: büyük / küçük harf ve Türkçe noktalı / noktasız I farkı yok */
export const teamNameKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(/[İIı]/g, 'i').toLocaleLowerCase('tr');

/**
 * Form girdisi (saf). Ad 2–80 karakter; çizimci zorunlu (1 fabrika = 1 satışçı + 1 çizimci); fiyat tablosu isteğe bağlı.
 * @returns {{ ok: true, team: { id: string | null, name: string, salesUserId: string, drawerId: string, priceTableId: string | null } } | { ok: false, code: string }}
 */
export function parseTeam(input) {
  const str = (v, n = 64) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const name = str(input?.name, 200).replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > TEAM_NAME_MAX) return { ok: false, code: 'NAME' };
  const drawerId = str(input?.drawerId);
  if (!drawerId) return { ok: false, code: 'DRAWER' };
  const id = str(input?.id) || null;
  const salesUserId = str(input?.salesUserId);
  if (!id && !salesUserId) return { ok: false, code: 'SALES' };
  return { ok: true, team: { id, name, salesUserId, drawerId, priceTableId: str(input?.priceTableId) || null } };
}

async function nameTaken(tx, name, exceptId) {
  const rows = await tx.factoryTeam.findMany({ where: exceptId ? { id: { not: exceptId } } : {}, select: { name: true } });
  return rows.some((r) => teamNameKey(r.name) === teamNameKey(name));
}

/** Satışçının çizimci + fiyat tablosu bağlantılarını yazar (değiştiyse), mevcut denetim kayıtlarıyla */
async function writeLinks(tx, sales, { drawerId, priceTableId }, actor) {
  const changes = {};
  if ((sales.defaultDrawerId ?? null) !== drawerId) {
    await tx.user.update({ where: { id: sales.id }, data: { defaultDrawerId: drawerId } });
    await writeAudit(tx, { action: 'SALES_DEFAULT_DRAWER', entityType: 'User', entityId: sales.id, userId: actor.id, details: { before: sales.defaultDrawerId ?? null, after: drawerId, via: 'FACTORY_TEAM' } }, actor);
    changes.drawer = { before: sales.defaultDrawerId ?? null, after: drawerId };
  }
  if ((sales.priceTableId ?? null) !== priceTableId) {
    await tx.user.update({ where: { id: sales.id }, data: { priceTableId } });
    await writeAudit(tx, { action: 'PRICE_TABLE_ASSIGN', entityType: 'User', entityId: sales.id, userId: actor.id, details: { user: sales.email, before: sales.priceTableId ?? null, after: priceTableId, via: 'FACTORY_TEAM' } }, actor);
    changes.table = { before: sales.priceTableId ?? null, after: priceTableId };
  }
  return changes;
}

/**
 * Ekip oluştur / düzenle. Satışçı yalnızca oluştururken seçilir (sonra değişmez). Çizimci ve fiyat tablosu satışçının var
 * olan alanlarına yazılır. Ekip aktifse (yeni ekip aktif başlar) çakışmalar reddedilir; pasif ekipte bağlantılar kaydedilir,
 * aktifleştirmede yeniden denetlenir. Hiçbir siparişe dokunulmaz.
 * @param {any} db  @param {{ input: object, actor: { id: string, role: string, ip?: string | null } }} p
 */
export async function saveTeam(db, { input, actor }) {
  if (!allowed(actor)) return FORBIDDEN;
  const parsed = parseTeam(input);
  if (!parsed.ok) return parsed;
  const t = parsed.team;
  return db.$transaction(async (tx) => {
    await lockTeams(tx);
    const existing = t.id ? await tx.factoryTeam.findUnique({ where: { id: t.id } }) : null;
    if (t.id && !existing) return { ok: false, code: 'NOT_FOUND' };
    const salesUserId = existing ? existing.salesUserId : t.salesUserId;
    const sales = await tx.user.findUnique({ where: { id: salesUserId }, select: USER_FIELDS });
    if (!validSales(sales)) return { ok: false, code: 'SALES' };
    if (!existing && (await tx.factoryTeam.findUnique({ where: { salesUserId } }))) return { ok: false, code: 'SALES_IN_TEAM' };
    const drawer = await tx.user.findUnique({ where: { id: t.drawerId }, select: USER_FIELDS });
    if (!validDrawer(drawer)) return { ok: false, code: 'DRAWER' };
    if (t.priceTableId && !(await tx.priceTable.findFirst({ where: { id: t.priceTableId, kind: 'SALES', isActive: true } }))) return { ok: false, code: 'TABLE' };
    if (await nameTaken(tx, t.name, existing?.id)) return { ok: false, code: 'NAME_TAKEN' };
    const active = existing ? existing.isActive : true;
    if (active) {
      const conflicts = await teamConflicts(tx, { salesUserId, drawerId: drawer.id, priceTableId: t.priceTableId });
      if (conflicts.length) return { ok: false, code: conflicts[0], conflicts };
    }
    const row = existing
      ? await tx.factoryTeam.update({ where: { id: existing.id }, data: { name: t.name } })
      : await tx.factoryTeam.create({ data: { name: t.name, salesUserId, isActive: true, createdById: actor.id } });
    const links = await writeLinks(tx, sales, { drawerId: drawer.id, priceTableId: t.priceTableId }, actor);
    await writeAudit(tx, {
      action: existing ? 'FACTORY_TEAM_UPDATED' : 'FACTORY_TEAM_CREATED', entityType: 'FactoryTeam', entityId: row.id, userId: actor.id,
      details: { name: { before: existing?.name ?? null, after: row.name }, salesUserId, isActive: row.isActive, ...links },
    }, actor);
    return { ok: true, id: row.id, created: !existing };
  });
}

/**
 * Aktifleştir / pasifleştir. Pasifleştirme: siparişler, kullanıcı hesapları, çizimci / fiyat tablosu bağlantıları DEĞİŞMEZ;
 * şu anki ya da başlayacak otomatik yönlendirme kuralı bu satışçıyı gösteriyorsa uyarı döner (kural kendisi değişmez —
 * yeni siparişler atama bekler ve yöneticiye uyarı düşer). Aktifleştirme: satışçı geçerli olmalı ve çakışma olmamalı.
 * @param {any} db  @param {{ id: string, active: boolean, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 */
export async function setTeamActive(db, { id, active, actor, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  if (typeof id !== 'string' || !id) return { ok: false, code: 'NOT_FOUND' };
  return db.$transaction(async (tx) => {
    await lockTeams(tx);
    const team = await tx.factoryTeam.findUnique({ where: { id } });
    if (!team) return { ok: false, code: 'NOT_FOUND' };
    if (team.isActive === !!active) return { ok: true, changed: false, routingWarning: false };
    if (active) {
      const sales = await tx.user.findUnique({ where: { id: team.salesUserId }, select: USER_FIELDS });
      if (!validSales(sales)) return { ok: false, code: 'SALES' };
      const conflicts = await teamConflicts(tx, { salesUserId: sales.id, drawerId: sales.defaultDrawerId, priceTableId: sales.priceTableId });
      if (conflicts.length) return { ok: false, code: conflicts[0], conflicts };
    }
    await tx.factoryTeam.update({ where: { id }, data: { isActive: !!active } });
    const routingWarning = !active && (await routesTo(tx, team.salesUserId, now));
    await writeAudit(tx, {
      action: active ? 'FACTORY_TEAM_ACTIVATED' : 'FACTORY_TEAM_DEACTIVATED', entityType: 'FactoryTeam', entityId: id, userId: actor.id,
      details: { name: team.name, salesUserId: team.salesUserId, routingWarning },
    }, actor);
    return { ok: true, changed: true, routingWarning };
  });
}

/** Şu anki ya da ileride başlayacak otomatik kural bu satışçıyı mı gösteriyor */
async function routesTo(tx, salesUserId, now) {
  const rules = await tx.glassRoutingRule.findMany({ orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }], take: 50 });
  const current = ruleAt(rules, now);
  const relevant = [current, ...rules.filter((r) => new Date(r.startsAt) > now)].filter(Boolean);
  return relevant.some((r) => r.mode === 'AUTO' && r.targetUserId === salesUserId);
}

/**
 * Yönetim ekranı verisi (salt okunur): ekipler (satışçı, çizimci, fiyat tablosu), seçilebilecek hesaplar ve tablolar, şu
 * anki otomatik kuralın pasif ekibi gösterip göstermediği.
 */
export async function loadTeamsAdmin(db, now = new Date()) {
  const person = { select: { id: true, name: true, email: true, isActive: true, deletedAt: true, appRole: true, type: true } };
  const [teams, sales, drawers, tables, rules] = await Promise.all([
    db.factoryTeam.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { salesUser: { select: { ...person.select, defaultDrawer: person, priceTable: { select: { id: true, name: true, isActive: true } } } } },
    }),
    db.user.findMany({ where: { appRole: 'SATIS', type: 'INTERNAL', isActive: true, deletedAt: null }, orderBy: [{ name: 'asc' }, { email: 'asc' }], select: { id: true, name: true, email: true, factoryTeam: { select: { id: true } } } }),
    db.user.findMany({ where: { appRole: 'CIZIM', type: 'INTERNAL', isActive: true, deletedAt: null }, orderBy: [{ name: 'asc' }, { email: 'asc' }], select: { id: true, name: true, email: true } }),
    db.priceTable.findMany({ where: { kind: 'SALES', isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, currency: true } }),
    db.glassRoutingRule.findMany({ orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }], take: 50 }),
  ]);
  const current = ruleAt(rules, now);
  const inactiveTargets = new Set(teams.filter((x) => !x.isActive).map((x) => x.salesUserId));
  return {
    teams,
    freeSales: sales.filter((s) => !s.factoryTeam),
    drawers, tables,
    routingToInactive: !!current && current.mode === 'AUTO' && inactiveTargets.has(current.targetUserId),
    timeZone: ROUTING_TIMEZONE,
  };
}
