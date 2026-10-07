// Otomatik "Yüklendi" (karar 156): yükleme gününden AUTO_SHIP_DAYS (45) gün geçtiği hâlde hâlâ üretimde duran cam
// siparişi kendiliğinden "Yüklendi" olur ve "Yüklenen ve arşiv" sekmesine düşer. Yeni bir durum ya da işaret YOKTUR:
// satışın "Yüklendi" düğmesinin verdiği durumun aynısıdır ve aynı iş akışı servisinden geçer (runOrderAction → geçmiş +
// denetim kaydı). Fark: yükleme GÜNÜ değişmez (fiili gün yazılmaz), sandıklar yerinde kalır, müşteriye "yüklendi"
// bildirimi gitmez (server/orders/transitions.js → auto_shipped).
//
// Kapsam bilerek dardır — yalnızca "yüklenmiş olması beklenen" sipariş kapanır:
//   · cam siparişi, durumu URETIMDE (teklifi / çizimi bitmemiş sipariş kendiliğinden kapanmaz), beklemede değil, silinmemiş
//   · yükleme günü (fiili, yoksa planlanan) bugünden en az 45 gün önce
//   · ileri güne aktarılmış ama henüz yüklenmemiş camı (etkin aktarım) yok
import { dayKey } from './loading.js';
import { runOrderAction, WorkflowError } from './transitions.js';

export const AUTO_SHIP_DAYS = 45;
/** İşçi bu kuralı saatte bir çalıştırır */
export const AUTO_SHIP_EVERY_MS = 3_600_000;
const SYSTEM_ACTOR = { id: null, role: 'SYSTEM', system: true, autoShip: true, ip: null };

/** "YYYY-AA-GG" gününden `days` gün öncesi (takvim günü) */
export function cutoffDay(today, days = AUTO_SHIP_DAYS) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Kural (saf): bu sipariş bugün otomatik "Yüklendi" yapılır mı? (etkin aktarım denetimi sorgudadır)
 * @param {{ orderTypeCode: string, status: string, onHold: boolean, removedAt?: Date | null, actualShipDate?: Date | null, estimatedShipDate?: Date | null }} o
 * @param {string} today  uygulama saat dilimindeki gün (YYYY-AA-GG)
 */
export function autoShipDue(o, today, days = AUTO_SHIP_DAYS) {
  if (o.orderTypeCode !== 'GLASS_ORDER' || o.status !== 'URETIMDE' || o.onHold || o.removedAt) return false;
  const d = o.actualShipDate ?? o.estimatedShipDate;
  return !!d && dayKey(d) <= cutoffDay(today, days);
}

/**
 * Süresi dolan siparişleri "Yüklendi" yapar (işçi). Her sipariş kendi veritabanı işleminde, iş akışı servisinden geçer;
 * biri geçemezse (aynı anda değişti, artık üretimde değil) atlanır, ötekiler etkilenmez.
 * @param {any} db
 * @param {{ now?: Date, batch?: number, log?: (...a: unknown[]) => void }} [o]
 * @returns {Promise<{ shipped: number, skipped: number }>}
 */
export async function autoShipOrders(db, { now = new Date(), batch = 100, log = () => {} } = {}) {
  const today = dayKey(now);
  const cutoff = cutoffDay(today);
  // Sorgu geniş tutulur (saat dilimi payı: +2 gün); kesin karar autoShipDue'dadır
  const before = new Date(`${cutoff}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() + 2);
  const rows = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', status: 'URETIMDE', onHold: false, removedAt: null,
      replans: { none: { status: 'ACTIVE' } },
      OR: [{ actualShipDate: { lt: before } }, { actualShipDate: null, estimatedShipDate: { lt: before } }],
    },
    select: { id: true, orderNo: true, orderTypeCode: true, status: true, onHold: true, removedAt: true, actualShipDate: true, estimatedShipDate: true },
    orderBy: [{ estimatedShipDate: 'asc' }, { createdAt: 'asc' }],
    take: batch,
  });
  let shipped = 0, skipped = 0;
  for (const o of rows) {
    if (!autoShipDue(o, today)) continue;
    try {
      await runOrderAction(db, { orderId: o.id, action: 'auto_shipped', actor: SYSTEM_ACTOR, payload: { days: AUTO_SHIP_DAYS, shipDay: dayKey(o.actualShipDate ?? o.estimatedShipDate) } });
      shipped++;
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      skipped++;
      log('otomatik yüklendi atlandı:', o.orderNo, e.code);
    }
  }
  return { shipped, skipped };
}
