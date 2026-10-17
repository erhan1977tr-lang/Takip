// Sipariş oluşturma hız sınırı (karar 289; güvenlik denetimi 3.93.2 / NEW-GL-03). Müşterinin cam ve profil siparişleri
// birlikte sayılır. Sayaç bellekte DEĞİL veritabanındadır (sipariş satırlarının kendisi): sayım, siparişi yazan işlemin
// içinde firma kilidi (order-no:<firma>, pg_advisory_xact_lock) alındıktan SONRA yapılır — birden çok uygulama örneğinde
// de aynı firmanın eşzamanlı istekleri sırayla sayılır, sınır aşılamaz. Tek kullanımlık form anahtarıyla gelen yineleme
// sınırdan ÖNCE ilk siparişi döndürür (sayılmaz). Sınırlar olağan kullanımın çok üstündedir.
import { WorkflowError } from '../domain/workflow.js';

export const ORDER_RATE = Object.freeze({
  userHour: 60, // bir kullanıcı / saat
  firmHour: 120, // bir firma (bütün kullanıcıları) / saat
  firmDay: 500, // bir firma / 24 saat
});
const HOUR = 3_600_000;

/** Saf kural: sayımlar → aşılan sınır ya da null */
export function orderRateProblem({ userHour, firmHour, firmDay }, limits = ORDER_RATE) {
  if (userHour >= limits.userHour) return 'USER_HOUR';
  if (firmHour >= limits.firmHour) return 'FIRM_HOUR';
  if (firmDay >= limits.firmDay) return 'FIRM_DAY';
  return null;
}

/**
 * Firma kilidi ALINMIŞ işlemin içinde çağrılır; sınır aşılmışsa WorkflowError('ORDER_RATE_LIMIT').
 * @param {any} tx  @param {{ firmId: string, userId: string, now?: Date, limits?: typeof ORDER_RATE }} o
 */
export async function assertOrderRate(tx, { firmId, userId, now = new Date(), limits = ORDER_RATE }) {
  const t = now.getTime();
  const [userHour, firmHour, firmDay] = await Promise.all([
    tx.order.count({ where: { customerId: firmId, createdById: userId, createdAt: { gte: new Date(t - HOUR) } } }),
    tx.order.count({ where: { customerId: firmId, createdAt: { gte: new Date(t - HOUR) } } }),
    tx.order.count({ where: { customerId: firmId, createdAt: { gte: new Date(t - 24 * HOUR) } } }),
  ]);
  const problem = orderRateProblem({ userHour, firmHour, firmDay }, limits);
  if (problem) throw new WorkflowError('ORDER_RATE_LIMIT', { scope: problem });
}
