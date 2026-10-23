// Fabrika ekibi durumu (4.3.19, karar 304) — bağımlılıksız okuma yardımcıları. Yazan tek yer: server/teams/service.js.
// Ekip = satışçı hesabının adı + aktifliği; çizimci (User.defaultDrawerId), fiyat tablosu (User.priceTableId) ve finansal
// hesap (satışçı) var olan alanlardır. Bu dosya sales-routing.js, pricing/tables.js ve transitions.js tarafından da
// kullanılır; döngüsel bağımlılık olmaması için başka modül içe aktarmaz.

export const TEAM_LOCK = 'factory-teams';

/** Ekip yazımlarının ortak kilidi: ekip kaydı, varsayılan çizimci ve fiyat tablosu ataması aynı sırayla yazılır */
export async function lockTeams(tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${TEAM_LOCK}, 0))`;
}

/** Satışçının ekibi PASİF mi (ekibi olmayan satışçı: hayır — geriye uyum) */
export async function teamInactive(tx, salesUserId) {
  if (!salesUserId) return false;
  const t = await tx.factoryTeam.findUnique({ where: { salesUserId }, select: { isActive: true } });
  return !!t && !t.isActive;
}

/** Satışçının ekibi AKTİF mi */
export async function teamActive(tx, salesUserId) {
  if (!salesUserId) return false;
  const t = await tx.factoryTeam.findUnique({ where: { salesUserId }, select: { isActive: true } });
  return !!t?.isActive;
}

/**
 * Aktif ekipler arasında tekillik (karar 304): bir çizimci ya da fiyat tablosu başka bir AKTİF ekibin satışçısına bağlıysa
 * çakışma. Kendi ekibi (salesUserId) sayılmaz. Var olan bağlantılar otomatik değişmez — kural yalnızca yeni yazımlarda.
 * @param {any} tx
 * @param {{ salesUserId: string, drawerId?: string | null, priceTableId?: string | null }} p
 * @returns {Promise<('DRAWER_IN_TEAM' | 'TABLE_IN_TEAM')[]>}
 */
export async function teamConflicts(tx, { salesUserId, drawerId = null, priceTableId = null }) {
  const out = [];
  const others = { isActive: true, salesUserId: { not: salesUserId } };
  if (drawerId && (await tx.factoryTeam.count({ where: { ...others, salesUser: { defaultDrawerId: drawerId } } }))) out.push('DRAWER_IN_TEAM');
  if (priceTableId && (await tx.factoryTeam.count({ where: { ...others, salesUser: { priceTableId } } }))) out.push('TABLE_IN_TEAM');
  return out;
}

/** Ekip adları (satışçı kimliği → ad), pasifler dahil — nakliye listesi bölüm başlığı, hesap adları */
export async function teamNames(db) {
  const rows = await db.factoryTeam.findMany({ select: { salesUserId: true, name: true } });
  return new Map(rows.map((r) => [r.salesUserId, r.name]));
}
