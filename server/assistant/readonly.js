// TAKİP Telegram asistanı — salt okunur veritabanı erişimi (3.84.0, karar 278).
// Her araç çağrısı PostgreSQL'in READ ONLY işleminde çalışır: araç kodunda bir hata olsa bile INSERT / UPDATE / DELETE,
// sıra (sequence) ilerletme ve kilit alan yazma işlemleri veritabanında reddedilir ("cannot execute … in a read-only
// transaction"). İşlem süresi sınırlıdır (statement_timeout + işlem zaman aşımı). Yazan TEK SQL komutu işlemin kendisini
// salt okunur yapan SET TRANSACTION'dır.

export const QUERY_TIMEOUT_MS = 10_000;

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @returns {<T>(fn: (tx: any) => Promise<T>) => Promise<T>}
 */
export function readOnly(db) {
  return (fn) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = 8000`;
    return fn(tx);
  }, { timeout: QUERY_TIMEOUT_MS, maxWait: 5_000 });
}
