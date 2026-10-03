// Yüklenmeyen camın yerine açılan telafiler (Aşama 9, karar 109) — aktarım kapasitesiyle ortak okunan tek sayı.
//   Onaylı yüklemede yüklenmeyen cam (NOT_LOADED) iki yoldan yeniden üretilebilir / gönderilebilir:
//     - ileri bir güne AKTARILIR (LoadingReplan — aynı sipariş, aynı cam), ya da
//     - yerine TELAFİ camı açılır (Compensation — başka sipariş / telafi siparişi) ve bu ilişki kaydedilir.
//   Aynı adet ikisine birden girmemeli (aynı cam iki kez üretilmesin): kapsamın serbest kalanı
//   = geçerli yüklenmeyen adet − vazgeçilmemiş aktarımlar − bu kapsama bağlı (reddedilmemiş) telafiler.
//   Bu dosyanın başka modüle bağımlılığı yoktur (aktarım ve telafi servisleri birlikte kullanır).

/**
 * Bir onayın kapsamlarına bağlı telafi adetleri: kapsam anahtarı ("l:<teklif satırı>" / "r:<aktarım>") → adet.
 * @param {any} db  @param {string} confirmationId
 * @returns {Promise<Map<string, number>>}
 */
export async function compensatedByScope(db, confirmationId) {
  const prefix = `${confirmationId}|`;
  const rows = await db.compensation.findMany({
    where: { notLoadedScope: { startsWith: prefix }, status: { not: 'REJECTED' } },
    select: { notLoadedScope: true, quantity: true },
  });
  const out = new Map();
  for (const r of rows) {
    const key = String(r.notLoadedScope).slice(prefix.length);
    out.set(key, (out.get(key) ?? 0) + r.quantity);
  }
  return out;
}
