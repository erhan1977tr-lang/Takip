// Davet kodunun doğrulanması — deneme hakkı ATOMİK alınır (karar 148; güvenlik denetimi 3.50.9 AUD-10).
//
// Sorun: eski akış "daveti oku → attempts < 5 mi → kodu karşılaştır → attempts'i artır" idi. Aynı anda gelen istekler
// attempts'i hep artırılmadan önce okuyor, hepsi kodu gerçekten deniyordu: davet başına 5 olması gereken tahmin sayısı
// paralel istek sayısı kadar oluyordu (6 haneli kod; doğru tahmin şifreyi belirler → hesap ele geçirilir).
//
// Kural: deneme hakkı, kod karşılaştırılmadan ÖNCE tek bir koşullu güncellemeyle alınır:
//     UPDATE "UserInvite" SET attempts = attempts + 1
//      WHERE id = … AND "usedAt" IS NULL AND "sentAt" IS NOT NULL AND "expiresAt" > … AND attempts < 5
// PostgreSQL aynı satırı güncelleyen ifadeleri satır kilidiyle sıraya sokar ve koşulu güncel satırla yeniden değerlendirir:
// kaç istek aynı anda gelirse gelsin en çok 5 hak alınabilir; attempts hiçbir anda 5'i geçmez. Kilit ya da uzun işlem
// gerekmez (depodaki claimFgoJob ve "çeviriyi yeniden dene" sahiplenmesiyle aynı kalıp).
//   hak alınamadı → kod HİÇ karşılaştırılmaz (davet kilitli / süresi dolmuş / kullanılmış / yenisiyle değiştirilmiş)
//   kod yanlış    → hak harcanmış kalır: bir davet için en çok 5 yanlış karşılaştırma yapılabilir
//   kod doğru     → hak geri verilir (doğru kod deneme saymaz — eski davranış)
// Şifre adımı (setPasswordAction) ve davet üretimi (lib/invite.ts) değişmedi.
import { MAX_ATTEMPTS, codeMatches } from './inviteCode.js';

/**
 * @param {any} db
 * @param {{ email: unknown, code: unknown, secret: string, now?: Date,
 *   compare?: (o: { code: unknown, email: string, codeHash: string, secret: string }) => boolean | Promise<boolean> }} o
 *   compare: yalnızca testler içindir (karşılaştırmaları saymak / bekletmek için); uygulama vermez
 * @returns {Promise<{ ok: true, inviteId: string, userId: string } | { ok: false, reason: 'no_invite' | 'unavailable' | 'wrong_code' }>}
 *   no_invite   : böyle bir kullanıcı / açık davet yok (kullanıcı pasif ya da şifresi zaten var)
 *   unavailable : deneme hakkı alınamadı — kod karşılaştırılmadı
 *   wrong_code  : kod karşılaştırıldı, yanlış
 */
export async function verifyInviteCode(db, { email, code, secret, now = new Date(), compare = codeMatches }) {
  const mail = String(email ?? '').trim().toLowerCase();
  const user = mail ? await db.user.findUnique({ where: { email: mail } }) : null;
  const invite = user && user.isActive && !user.passwordHash
    ? await db.userInvite.findFirst({ where: { userId: user.id, usedAt: null, sentAt: { not: null } }, orderBy: { createdAt: 'desc' } })
    : null;
  if (!user || !invite) return { ok: false, reason: 'no_invite' };
  // Deneme hakkı: tek adımda denetlenir ve alınır. Koşullar okunan kopyaya değil, o anki satıra uygulanır.
  const claimed = await db.userInvite.updateMany({
    where: { id: invite.id, usedAt: null, sentAt: { not: null }, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return { ok: false, reason: 'unavailable' };
  // (await: testler karşılaştırmayı bekletebilsin diye — uygulamanın karşılaştırması eşzamanlıdır)
  if (!(await compare({ code, email: mail, codeHash: invite.codeHash, secret }))) return { ok: false, reason: 'wrong_code' };
  // Doğru kod deneme saymaz: alınan hak geri verilir
  await db.userInvite.updateMany({ where: { id: invite.id, attempts: { gt: 0 } }, data: { attempts: { decrement: 1 } } });
  return { ok: true, inviteId: invite.id, userId: user.id };
}
