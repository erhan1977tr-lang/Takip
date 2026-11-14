// "Tüm aktif siparişler" listesinin kısaltılması (ürün sahibi, 14.11.2026; karar 316).
//
//   Tahmini yükleme gününün üzerinden LIST_ARCHIVE_DAYS (4) gün geçen, üretimdeki / yüklenmiş cam siparişi sipariş
//   listelerinde "Tüm aktif siparişler" (müşteride "Active") bölümünden çıkar ve "Yüklenen ve arşiv" bölümünde görünür —
//   müşteri, satış, yönetici, yönetici yardımcısı ve denetimci listelerinde; geçmiş siparişler dahil (kural her gösterimde
//   kayıtlı tarihe bakar, bir kerelik taşıma yoktur).
//
//   YALNIZCA LİSTE GÖRÜNÜMÜ: siparişin durumu, yükleme onayı, fatura / FGO, sandık, bildirim ve otomatik arşiv (karar 158)
//   değişmez; hiçbir kayıt yazılmaz. "Sıra bende" iş kuyrukları, çizim paneli ve profil siparişleri bu kuraldan etkilenmez.
//   Kapsam: cam siparişi, durum URETIMDE ya da YUKLENDI, beklemede değil. İş akışında ilerlemesi gereken sipariş (YENI,
//   HAZIRLANIYOR — çizim / teklif bekliyor) tarihi geçse de aktif listede kalır: üzerinde yapılacak iş vardır.
//   Gün işletmenin saat diliminde alınır (dayKey — Europe/Bucharest); tahmini gün + 4. günden itibaren arşiv bölümünde.
import { dayKey } from './loading.js';

export const LIST_ARCHIVE_DAYS = 4;
/** Kuralın uygulandığı durumlar (üretimde / yüklendi) */
export const LIST_ARCHIVE_STATUSES = Object.freeze(['URETIMDE', 'YUKLENDI']);
const TZ = 'Europe/Bucharest';

/** "YYYY-AA-GG" gününden `days` gün sonrası / öncesi (takvim günü) */
export function shiftDay(day, days) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Bugün (işletmenin saat diliminde) tahmini günü en geç bu gün olan sipariş arşiv bölümündedir */
export function listArchiveCutoff(now = new Date(), days = LIST_ARCHIVE_DAYS) {
  return shiftDay(dayKey(now), -days);
}

/** Saat diliminin o andaki farkı (ms; Bucharest +2 / +3 saat) */
function tzOffsetMs(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/** "YYYY-AA-GG" gününün işletme saatiyle gece yarısı (UTC an) */
export function localMidnight(day) {
  const guess = new Date(`${day}T00:00:00Z`);
  return new Date(guess.getTime() - tzOffsetMs(guess));
}

/**
 * Sipariş liste görünümünde arşiv bölümüne geçti mi (saf).
 * @param {{ orderTypeCode?: string, status: string, onHold?: boolean, removedAt?: Date | null, estimatedShipDate?: Date | string | null }} order
 * @param {Date} [now]
 */
export function shipWindowPassed(order, now = new Date(), days = LIST_ARCHIVE_DAYS) {
  if (order.orderTypeCode !== 'GLASS_ORDER' || order.removedAt || order.onHold) return false;
  if (!LIST_ARCHIVE_STATUSES.includes(order.status) || !order.estimatedShipDate) return false;
  return dayKey(order.estimatedShipDate) <= listArchiveCutoff(now, days);
}

/**
 * Aynı kuralın veritabanı koşulu (Prisma): tahmini günü (yerel) en geç kesim günü olan sipariş = tahmini an, kesim gününden
 * sonraki günün yerel gece yarısından önce.
 * @param {Date} [now]
 */
export function shipWindowWhere(now = new Date(), days = LIST_ARCHIVE_DAYS) {
  return {
    orderTypeCode: 'GLASS_ORDER',
    status: { in: [...LIST_ARCHIVE_STATUSES] },
    onHold: false,
    estimatedShipDate: { lt: localMidnight(shiftDay(listArchiveCutoff(now, days), 1)) },
  };
}

/**
 * shipWindowWhere'in tersi — aktif listede kalanlar. NOT { … } yerine açık OR yazılır: SQL'de NULL tarihli sipariş
 * NOT (… AND tarih < x) koşulunda düşerdi (tarihsiz sipariş aktif listede kalmalı).
 * @param {Date} [now]
 */
export function notShipWindowWhere(now = new Date(), days = LIST_ARCHIVE_DAYS) {
  const w = shipWindowWhere(now, days);
  return {
    OR: [
      { orderTypeCode: { not: w.orderTypeCode } },
      { status: { notIn: w.status.in } },
      { onHold: true },
      { estimatedShipDate: null },
      { estimatedShipDate: { gte: w.estimatedShipDate.lt } },
    ],
  };
}
