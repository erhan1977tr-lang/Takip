// Giriş / kod denemesi sınırının veritabanı tarafı — deneme hakkı ATOMİK ayrılır (karar 148; güvenlik denetimi 3.50.9
// AUD-10). Sınırlar ve pencere değişmedi (saf hesap: server/auth/throttle.js): 15 dakikada aynı e-posta + IP 5,
// aynı e-posta 20, aynı IP 30.
//
// Sorun: eski akış "son hataları say → kilitli değilse şifreyi / kodu doğrula → hatayı kaydet" idi (sayım ve kayıt ayrı,
// kilitsiz sorgular). Aynı anda gelen isteklerin hepsi kayıtlardan önce saydığı için hepsi doğrulamaya geçiyordu.
//
// Kural: deneme, doğrulanmadan ÖNCE sayılır. Giriş ve kod ekranı yalnızca runAttempt'i çağırır:
//   1. reserveAttempt — kısa bir işlemde: e-posta kilidi → IP kilidi → son kayıtları say → kilitliyse reddet, değilse
//      deneme satırını HEMEN yaz. Satırın türü "PENDING"dir: doğrulaması süren deneme. PENDING satır her sayıma
//      (5 / 20 / 30) tamamlanmış hata gibi girer. Sayım, kilidi alan işlemden önce bitmiş bütün kayıtları görür
//      (READ COMMITTED: her ifade güncel veriyi okur) — paralel isteklerle sınırın üstüne çıkılamaz.
//   2. doğrulama — şifre (scrypt) / kod karşılaştırması bu işlemin DIŞINDA yapılır: kilit ve veritabanı bağlantısı
//      doğrulama süresince tutulmaz.
//   3. sonuç:
//        başarısız           → failAttempt: AYNI satır kalıcı hata olur (türü yazılır: LOGIN / CODE); ikinci satır yazılmaz
//        giriş başarılı      → clearAttempts: kendi satırı + aynı e-posta + IP'nin TAMAMLANMIŞ hataları silinir (eski
//                              davranış: başarılı giriş o çiftin hatalarını temizler). Doğrulaması süren BAŞKA
//                              denemelerin (PENDING) satırlarına dokunulmaz — başarılı bir giriş, o anda süren
//                              denemeleri sayım dışına çıkaramaz.
//        kod doğru           → releaseAttempt: yalnızca kendi satırı silinir (eski davranış: doğru kod öteki hataları
//                              temizlemez)
//        beklenmeyen hata    → deneme HATA sayılır (failAttempt) ve hata yukarı iletilir: doğrulaması bitmemiş bir
//                              deneme "sayılmamış" kalamaz, PENDING olarak da birikmez.
// PENDING satırın kalıcı kilit yaratamaması:
//   - sunucu doğrulama sırasında kapanırsa satır PENDING kalır; sayıma yalnızca 15 dakikalık pencere boyunca girer
//     (her hata gibi), sonra etkisizdir; bir günden eski kayıtlar silinir (failAttempt + işçinin saatlik temizliği).
//   - PENDING satır da bir hak kullanır: bir e-posta + IP için pencerede en çok 5 satır (PENDING + hata) olabilir —
//     yarıda kalmış denemeler olağan 15 dakikalık kilitten daha fazlasına yol açamaz.
// Kilit sırası sabittir (önce e-posta, sonra IP): hiçbir işlem IP kilidini tutarken e-posta kilidi beklemez → kilitlenme
// (deadlock) döngüsü oluşmaz. Kilitler işlem bitince kendiliğinden bırakılır (pg_advisory_xact_lock).
//
// Kilit olayı (karar 149; güvenlik denetimi AUD-11): "kilit oluştu" bilgisi, kilidi OLUŞTURAN denemeye bağlıdır.
// reserveAttempt, ayırdığı denemenin hangi sınırı doldurduğunu (5. / 20. / 30. deneme) döndürür; o deneme BAŞARISIZ
// biterse runAttempt sonucu bunu taşır (`filled`) ve çağıran tek bir kilit kaydı yazar (server/auth/lock-events.js).
// Zaten kilitliyken gelen istek hak ayıramaz → olay da üretmez: reddedilen istek yolu hiçbir şey yazmaz.
import { filledScopes, throttleState, WINDOW_MS } from './throttle.js';

/** Doğrulaması süren denemenin türü (AuthFailure.kind) */
export const ATTEMPT_PENDING = 'PENDING';
/** Tamamlanmış hata türleri */
export const ATTEMPT_KINDS = Object.freeze(['LOGIN', 'CODE']);

/** Sayaç anahtarları: saklanan, sayılan ve kilitlenen değer AYNI kırpılmış değerdir */
const keyOf = (email, ip) => ({ email: String(email ?? '').slice(0, 200), ip: String(ip ?? '').slice(0, 64) });

/**
 * Deneme hakkı ayırır (doğrulamadan önce çağrılır).
 * @param {any} db
 * @param {{ email: string, ip: string, now?: Date }} o
 * @returns {Promise<{ ok: true, id: string, filled: ('account' | 'email' | 'ip')[] } | { ok: false, minutes: number }>}
 *   ok=false: kilitli (kalan dakika) · filled: bu denemenin doldurduğu sınırlar (çoğu denemede boş)
 */
export async function reserveAttempt(db, { email, ip, now = new Date() }) {
  const k = keyOf(email, ip);
  const since = new Date(now.getTime() - WINDOW_MS);
  return db.$transaction(async (tx) => {
    // Sabit sıra: önce e-posta, sonra IP
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-email:${k.email}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-ip:${k.ip}`}, 0))`;
    // Sayım türe bakmaz: doğrulaması süren (PENDING) denemeler de sayılır
    const byEmail = await tx.authFailure.findMany({ where: { email: k.email, createdAt: { gte: since } }, select: { createdAt: true, ip: true } });
    const byIp = await tx.authFailure.findMany({ where: { ip: k.ip, createdAt: { gte: since } }, select: { createdAt: true } });
    const ms = (rows) => rows.map((r) => r.createdAt.getTime());
    const counted = { account: ms(byEmail.filter((r) => r.ip === k.ip)), email: ms(byEmail), ip: ms(byIp) };
    const state = throttleState(counted, now.getTime());
    if (state.locked) return { ok: false, minutes: state.minutes };
    const row = await tx.authFailure.create({ data: { kind: ATTEMPT_PENDING, email: k.email, ip: k.ip, createdAt: now }, select: { id: true } });
    // Bu denemenin DOLDURDUĞU sınırlar (karar 149): aynı sayımdan, aynı kilitlerin altında hesaplanır — bir sınırı
    // aynı anda gelen isteklerden yalnızca BİRİ doldurabilir. Yeni sorgu / kilit yoktur; sınır kararını etkilemez.
    return { ok: true, id: row.id, filled: filledScopes(counted, now.getTime()) };
  }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10_000 });
}

/**
 * Doğrulama başarısız: ayrılan satır kalıcı hata olur (yeni satır yazılmaz). Bir günden eski kayıtlar da silinir.
 * @param {any} db
 * @param {{ id: string, kind: 'LOGIN' | 'CODE', now?: Date }} o
 * @returns {Promise<void>}
 */
export async function failAttempt(db, { id, kind, now = new Date() }) {
  if (!ATTEMPT_KINDS.includes(kind)) throw new Error(`geçersiz deneme türü: ${kind}`);
  await db.authFailure.updateMany({ where: { id, kind: ATTEMPT_PENDING }, data: { kind } });
  await db.authFailure.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) } } });
}

/**
 * Doğrulama başarılı, öteki hatalar temizlenmeyecek (kod girişi): yalnızca ayrılan satır silinir.
 * @param {any} db
 * @param {{ id: string }} o
 * @returns {Promise<void>}
 */
export async function releaseAttempt(db, { id }) {
  await db.authFailure.deleteMany({ where: { id } });
}

/**
 * Giriş başarılı: ayrılan satır ve aynı e-posta + IP'nin tamamlanmış hataları silinir. Doğrulaması süren başka
 * denemelerin (PENDING) satırları kalır.
 * @param {any} db
 * @param {{ id: string, email: string, ip: string }} o
 * @returns {Promise<void>}
 */
export async function clearAttempts(db, { id, email, ip }) {
  const k = keyOf(email, ip);
  await db.authFailure.deleteMany({ where: { OR: [{ id }, { email: k.email, ip: k.ip, kind: { not: ATTEMPT_PENDING } }] } });
}

/**
 * Bir denemenin TAMAMI: hak ayır → doğrula (işlem / kilit dışında) → sonucu yaz. Giriş ve kod ekranının tek giriş noktası.
 * `verify` şifreyi / kodu doğrular ve `{ ok: boolean, … }` döner; yalnızca hak ayrılabildiyse çağrılır.
 *   LOGIN başarılı → clearAttempts · CODE başarılı → releaseAttempt · başarısız → failAttempt
 *   `verify` ya da sonuç yazımı hata fırlatırsa deneme HATA sayılır (satır PENDING kalmaz) ve hata yukarı iletilir.
 * @template {{ ok: boolean }} T
 * @param {any} db
 * @param {{ kind: 'LOGIN' | 'CODE', email: string, ip: string, now?: Date }} o
 * @param {() => Promise<T>} verify
 * @returns {Promise<{ locked: true, minutes: number } | { locked: false, outcome: T, filled?: ('account' | 'email' | 'ip')[] }>}
 *   filled: deneme başarısız bitti VE bu sınırları doldurdu (kilidi bu deneme oluşturdu) — yalnızca o durumda vardır
 */
export async function runAttempt(db, { kind, email, ip, now = new Date() }, verify) {
  if (!ATTEMPT_KINDS.includes(kind)) throw new Error(`geçersiz deneme türü: ${kind}`);
  const reserved = await reserveAttempt(db, { email, ip, now });
  if (!reserved.ok) return { locked: true, minutes: reserved.minutes };
  let settled = false;
  try {
    const outcome = await verify();
    if (!outcome?.ok) await failAttempt(db, { id: reserved.id, kind, now });
    else if (kind === 'LOGIN') await clearAttempts(db, { id: reserved.id, email, ip });
    else await releaseAttempt(db, { id: reserved.id });
    settled = true;
    // Kilit olayı: yalnızca BAŞARISIZ biten ve bir sınırı dolduran deneme taşır. Başarılı deneme kilit oluşturmaz
    // (satırı silinir); sınırı doldurmayan denemenin sonucu eskisiyle aynıdır (`filled` alanı hiç yoktur).
    return !outcome?.ok && reserved.filled.length ? { locked: false, outcome, filled: reserved.filled } : { locked: false, outcome };
  } finally {
    // Beklenmeyen hata: deneme hata sayılır (PENDING bırakılmaz). Bu yazım da başarısız olursa satır PENDING kalır ve
    // pencere dolunca etkisizleşir — asıl hata gizlenmez.
    if (!settled) await failAttempt(db, { id: reserved.id, kind, now }).catch(() => {});
  }
}
