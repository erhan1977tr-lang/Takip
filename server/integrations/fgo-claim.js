// FGO belge işlerinin sahiplenilmesi — cam (server/glass/billing.js), müşteri partisi (server/glass/batch.js) ve profil
// (server/profile/fgo-jobs.js) işçilerinin ORTAK kuralı. Kuyruk aynıdır (NotificationOutbox); yalnızca "bu işi şimdi kim
// kesiyor" sorusu tek bir veritabanı güncellemesiyle (atomik) yanıtlanır.
//
//   Sorun: iş yalnızca deneme sayısı artırılarak sahipleniliyordu. İş kesilirken (FGO isteği sürerken) satır hâlâ
//   "bekliyor" göründüğünden, o sırada kuyruğu okuyan ikinci bir işçi (arka plan işçisi + düğmeyle hemen deneme) aynı işi
//   yeni deneme sayısıyla sahiplenip FGO'ya İKİNCİ isteği gönderebiliyordu.
//   Çözüm: sahiplenen işçi aynı güncellemede işin availableAt alanını ileri alır (işlem kirası). Kira bitene kadar iş
//   hiçbir işçinin okumasına girmez; okumuş olan da güncelleme koşulunu (deneme sayısı + availableAt) tutturamaz.
//     başarı  → iş SENT olur (kira anlamsızlaşır)
//     hata    → iş mevcut kuralla yeniden zamanlanır (availableAt = şimdi + bekleme) ya da FAILED olur
//     işçi çöktü → kira dolunca iş yeniden denenebilir (IdExtern aynı kalır; FGO'nun ve veritabanının tekrar engelleri sürer)
//   Kiradaki iş: PENDING + availableAt ileride + lastError boş (sahiplenirken temizlenir; bekleyen işte hep doludur).

/** İşlem kirası: bir FGO isteği en çok 20 sn sürer (iş başına birkaç istek ≈ en kötü 1,5 dk); 10 dk güvenle aşar. */
export const FGO_LEASE_MS = 10 * 60_000;

/** Kirada OLMAYAN, hata nedeniyle bekleyen işler (öne alınabilir): hata yazılmış olanlar. */
export const WAITING_JOBS = { lastError: { not: null } };

/**
 * İşi sahiplenir: yalnızca BİR çağıran true alır; FGO'ya yalnızca o gider.
 * @param {any} db
 * @param {{ id: string, attempts: number }} row  kuyruktan okunan satır
 * @param {{ now?: Date, leaseMs?: number }} [o]  now: işçinin okuma anı (availableAt koşulu)
 * @returns {Promise<boolean>}
 */
export async function claimFgoJob(db, row, { now = new Date(), leaseMs = FGO_LEASE_MS } = {}) {
  // Kira gerçek sahiplenme anından sayılır (bir turda sırayla birkaç iş kesilirken sonrakilerin kirası kısalmasın)
  const until = new Date(Math.max(now.getTime(), Date.now()) + leaseMs);
  const claimed = await db.notificationOutbox.updateMany({
    where: { id: row.id, status: 'PENDING', attempts: row.attempts, availableAt: { lte: now } },
    data: { attempts: { increment: 1 }, availableAt: until, lastError: null },
  });
  return claimed.count === 1;
}
