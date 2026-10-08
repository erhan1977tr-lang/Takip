import type { Prisma } from '@prisma/client';
import { db } from './db';
import type { CurrentUser } from './auth/session';
import { userCan } from './permissions';
import { orderScope, sanitizeRows } from './orders';
import { lineKindText } from './labels';
import type { T } from './i18n';
import { getEnv } from '../server/env.js';
import { localDay } from '../server/profile/dates.js';
import { OFFER_REPORT_MAX, customerOfferReport, offerRange, offerWindow } from '../server/orders/customer-offers.js';

// "Tekliflerim" (karar 164): müşteri kullanıcısının KENDİ FİRMASININ cam teklifleri, seçilen tarih aralığında. Sayfa
// (/siparisler → Tekliflerim) ve PDF adresi (/teklifler/pdf) aynı yükleyiciyi kullanır.
//   Erişim: yalnızca müşteri kullanıcısı (User.type = CUSTOMER — iç ekip fabrika firmasına bağlıdır) ve teklif indirme
//   yetkisi (OFFER_EXPORT). Sorgu firma kapsamı (orderScope) + açık firma koşuluyla yapılır: başka firmanın teklifi hiçbir
//   koşulda gelmez. Fiyatlar sanitizeRows'tan geçer (iki kademeli fiyat, karar 4): satırda yalnızca müşteri fiyatı kalır.

/** Bu kullanıcı "Tekliflerim" dökümünü alabilir mi (sayfa ve PDF adresi aynı koşul) */
export function canSeeOfferReport(user: CurrentUser): boolean {
  return user.type === 'CUSTOMER' && !!user.customerId && userCan(user, 'OFFER_EXPORT');
}

const include = {
  customer: { select: { name: true } },
  offers: {
    where: { status: 'GONDERILDI' },
    orderBy: { createdAt: 'desc' },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  },
} satisfies Prisma.OrderInclude;

export type OfferReportResult =
  | { ok: true; from: string; to: string; report: ReturnType<typeof customerOfferReport>; tooMany: boolean }
  | { ok: false; code: 'BAD_DATE' | 'ORDER' | 'TOO_LONG'; from: string; to: string };

/**
 * Dökümü yükler. q: { bas, bit } ("YYYY-MM-DD"; boşsa bu ayın ilk günü → bugün).
 * tooMany: aralıktaki teklif sayısı üst sınırı aşıyor (liste / PDF üretilmez; aralık daraltılmalı).
 */
export async function loadOfferReport(user: CurrentUser, q: { bas?: string; bit?: string }, t: T, locale: 'tr' | 'ro'): Promise<OfferReportResult> {
  const tz = getEnv().APP_TIMEZONE;
  const range = offerRange(q, localDay(new Date(), tz));
  if (!range.ok) return range;
  if (!canSeeOfferReport(user)) return { ok: true, from: range.from, to: range.to, report: { from: range.from, to: range.to, sections: [], totals: [] }, tooMany: false };
  const window = offerWindow(range);
  const raw = await db.order.findMany({
    where: {
      ...orderScope(user),
      customerId: user.customerId!,
      orderTypeCode: 'GLASS_ORDER',
      status: { not: 'IPTAL' },
      offers: { some: { status: 'GONDERILDI', sentAt: { gte: window.gte, lt: window.lt } } },
    },
    include,
    orderBy: { createdAt: 'asc' },
    take: OFFER_REPORT_MAX * 2 + 1,
  });
  // Müşteri fiyatı: sanitizeRows → offerPrices (satırın unitPrice'ı müşteri fiyatıdır; satış fiyatı hiç kalmaz)
  const rows = sanitizeRows(user, raw);
  const report = customerOfferReport(rows, {
    from: range.from, to: range.to, timeZone: tz, locale,
    kindLabel: (k: string) => lineKindText(t, k),
    price: (l: { unitPrice: unknown }) => l.unitPrice,
  });
  const tooMany = report.sections.length > OFFER_REPORT_MAX || raw.length > OFFER_REPORT_MAX * 2;
  return { ok: true, from: range.from, to: range.to, report, tooMany };
}
