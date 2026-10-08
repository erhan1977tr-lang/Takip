import { db } from './db';
import type { CurrentUser } from './auth/session';
import { userCan } from './permissions';

/** Satırın fiyat değişikliği (server/orders/price-changes.js → priceChanges; denetim kaydındaki hâli) */
export type PriceLineChange = {
  no: number; change: 'PRICE' | 'ADDED' | 'REMOVED'; description: string; kind: string; enMm: number | null; boyMm: number | null;
  crateFee: boolean; old: string | null; new: string | null;
};
/** Yöneticinin "Hareketler"indeki müşteri fiyatı değişikliği (bir denetim kaydı) */
export type PriceChangeEntry = {
  id: string; at: Date; who: string | null; version: number; sent: boolean; currency: string;
  changes: PriceLineChange[]; more: number; oldTotal: string | null; newTotal: string | null;
};

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : null);
const intOr = (v: unknown, d: number | null = null) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d);
const price = (v: unknown) => (v === 'FREE' ? 'FREE' : typeof v === 'string' && /^-?\d+(\.\d{1,2})?$/.test(v) ? v : null);

function lineOf(x: unknown): PriceLineChange | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const change = o.change === 'ADDED' || o.change === 'REMOVED' ? o.change : o.change === 'PRICE' ? 'PRICE' : null;
  const no = intOr(o.no);
  if (!change || no == null) return null;
  return {
    no, change, description: str(o.description) ?? '', kind: str(o.kind, 10) ?? 'CAM', enMm: intOr(o.enMm), boyMm: intOr(o.boyMm),
    crateFee: o.crateFee === true, old: price(o.old), new: price(o.new),
  };
}

/**
 * Müşteri fiyatı değişiklikleri (fonksiyonel paket 4) — yöneticinin "Hareketler"i için, sipariş başına denetim kaydından
 * (OFFER_PRICE_CHANGED; server/orders/transitions.js → recordPriceChange). Yalnızca yönetici (müşteri fiyatını hazırlarken de
 * gören rol); öbür rollere boş liste — kayıt hiçbir koşulda başka role gitmez. Kayıt değişmezdir; burada yalnızca okunur.
 */
export async function loadPriceChanges(orderId: string, user: CurrentUser): Promise<PriceChangeEntry[]> {
  if (!userCan(user, 'OFFER_SEND')) return [];
  const rows = await db.auditLog.findMany({
    where: { action: 'OFFER_PRICE_CHANGED', entityType: 'Order', entityId: orderId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, createdAt: true, details: true, user: { select: { name: true, email: true } } },
  });
  return rows.flatMap((r) => {
    const d = (r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? r.details : {}) as Record<string, unknown>;
    const changes = Array.isArray(d.changes) ? d.changes.map(lineOf).filter((x): x is PriceLineChange => !!x) : [];
    if (changes.length === 0) return [];
    return [{
      id: r.id, at: r.createdAt, who: r.user?.name || r.user?.email || null, version: intOr(d.version, 1) ?? 1, sent: d.sent === true,
      currency: typeof d.currency === 'string' && /^[A-Z]{3}$/.test(d.currency) ? d.currency : 'EUR',
      changes, more: intOr(d.more, 0) ?? 0, oldTotal: price(d.oldTotal), newTotal: price(d.newTotal),
    }];
  });
}
