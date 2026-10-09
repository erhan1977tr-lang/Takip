// Giriş logları (Paket A, karar 223): kim, hangi rolle, ne zaman, hangi IP'den giriş yaptı / deneyip başaramadı.
// Yalnızca gerçek yönetici görür (AUDIT_VIEW — Yönetici Yardımcısında yok). Kayıtlar LOGIN_LOG_RETENTION_DAYS (365) gün
// saklanır; arka plan işçisi saatte bir eskileri siler (pruneLoginEvents).
//
// Yazılan alanlar SABİTTİR: kullanıcı (biliniyorsa), o anki rolü, tür (LOGIN | CODE | SETUP), başarılı mı, bu deneme bir giriş
// sınırını doldurdu mu (kilit başladı mı), IP, zaman. ŞİFRE, KOD, OTURUM / KURULUM BELİRTECİ, ÇEREZ, TARAYICI BİLGİSİ ve
// DENENEN E-POSTA METNİ hiçbir zaman yazılmaz (karar 149 ile aynı veri azaltımı).
//
// Kimlik: başarısız denemenin kullanıcısı yalnızca KESİN biliniyorsa yazılır —
//   - giriş: e-posta gerçek, etkin, şifresi olan bir hesaba ait ve şifre o hesapla KARŞILAŞTIRILDI (yanlış şifre);
//   - kod: o hesabın gerçek, açık davetinde kod KARŞILAŞTIRILDI (wrong_code).
// Hesap yok / pasif / şifresi henüz yok / davet yok ya da kilitli → userId BOŞ ("bilinmeyen hesap"): olay yanlış kişiye
// atfedilmez ve denenen adres saklanmaz. Kilitliyken gelen istekler hiç kaydedilmez (o yol salt-okunurdur — karar 149);
// her kayıt sayılan bir denemeye karşılık gelir (sınırlarla — 5 / 20 / 30 — sınırlı).
// Kayıt yazılamazsa giriş akışı etkilenmez (hata fırlatılmaz; yalnızca hata türü günlüğe yazılır).

export const LOGIN_LOG_RETENTION_DAYS = 365;
export const LOGIN_LOG_PAGE = 50;
const DAY = 86_400_000;
const KINDS = ['LOGIN', 'CODE', 'SETUP'];
const ROLES_ALLOWED = ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI'];

/** IP alanı: yalnızca IP'de görülen karakterler, en çok 64 (başlıktan gelen değer zaten tek bir adres — client-ip.js) */
export const safeIp = (ip) => {
  const v = String(ip ?? '').trim();
  return /^[0-9A-Fa-f:.]{2,64}$/.test(v) ? v : null;
};

/**
 * Kaydın verisi (saf): yalnızca izinli alanlar.
 * @param {{ kind: string, success: boolean, user?: { id: string, appRole?: string | null } | null, ip?: string | null, locked?: boolean, now?: Date }} e
 */
export function loginEventData({ kind, success, user = null, ip = null, locked = false, now = new Date() }) {
  if (!KINDS.includes(kind)) return null;
  const role = user?.appRole && ROLES_ALLOWED.includes(user.appRole) ? user.appRole : null;
  return {
    kind, success: success === true, locked: success !== true && locked === true,
    userId: user?.id ?? null, role: user?.id ? role : null, ip: safeIp(ip), createdAt: now,
  };
}

/**
 * Bir giriş olayını yazar; hiçbir zaman hata fırlatmaz.
 * @param {any} db
 * @param {{ kind: 'LOGIN' | 'CODE' | 'SETUP', success: boolean, user?: { id: string, appRole?: string | null } | null, ip?: string | null, locked?: boolean, now?: Date, log?: (...a: any[]) => void }} e
 * @returns {Promise<boolean>}
 */
export async function recordLoginEvent(db, { log = console.error, ...e }) {
  try {
    const data = loginEventData(e);
    if (!data) return false;
    await db.loginEvent.create({ data });
    return true;
  } catch (err) {
    log('giriş logu yazılamadı', err && typeof err === 'object' && 'name' in err ? /** @type {any} */ (err).name : 'hata');
    return false;
  }
}

/**
 * Kodu yanlış girilen hesabı bulur (yalnızca 'wrong_code' sonucunda çağrılır: kod o hesabın gerçek davetiyle
 * karşılaştırıldı — kimlik kesin). Bulunamazsa null (olay kullanıcıya bağlanmaz).
 * @param {any} db @param {string} email
 */
export async function codeOwner(db, email) {
  const mail = String(email ?? '').trim().toLowerCase();
  if (!mail) return null;
  try {
    return await db.user.findUnique({ where: { email: mail }, select: { id: true, appRole: true } });
  } catch {
    return null;
  }
}

/** 365 günden eski kayıtları siler (işçi, saatte bir). @param {any} db @param {Date} [now] */
export async function pruneLoginEvents(db, now = new Date()) {
  const r = await db.loginEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - LOGIN_LOG_RETENTION_DAYS * DAY) } } });
  return r.count;
}

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/**
 * Ekranın süzgeçleri (adres satırından — güvenilmeyen girdi): yalnızca bilinen değerler; bilinmeyen değer yok sayılır.
 * Sayfa: 1…1000. Gün aralığı: en çok saklama süresi kadar geriye.
 * @param {Record<string, string | undefined>} q
 */
export function parseLoginFilter(q) {
  const result = q.sonuc === 'basarili' ? true : q.sonuc === 'basarisiz' ? false : null;
  const kind = KINDS.includes(q.tur ?? '') ? q.tur : null;
  const role = ROLES_ALLOWED.includes(q.rol ?? '') ? q.rol : null;
  const userId = isId(q.kullanici) ? q.kullanici : null;
  const unknown = q.kullanici === 'bilinmeyen';
  const from = isDay(q.bas) ? q.bas : null;
  const to = isDay(q.bit) ? q.bit : null;
  const ip = safeIp(q.ip);
  const page = Math.min(1000, Math.max(1, Number.parseInt(String(q.sayfa ?? '1'), 10) || 1));
  return { result, kind, role, userId, unknown, from, to, ip, page };
}

/**
 * Süzgeç → sorgu koşulu. Günler UTC gün sınırıdır (ekran tarih + saat gösterir).
 * @param {ReturnType<typeof parseLoginFilter>} f
 */
export function loginWhere(f) {
  /** @type {any} */
  const where = {};
  if (f.result !== null) where.success = f.result;
  if (f.kind) where.kind = f.kind;
  if (f.role) where.role = f.role;
  if (f.unknown) where.userId = null;
  else if (f.userId) where.userId = f.userId;
  if (f.ip) where.ip = f.ip;
  if (f.from || f.to) {
    where.createdAt = {};
    if (f.from) where.createdAt.gte = new Date(`${f.from}T00:00:00Z`);
    if (f.to) where.createdAt.lt = new Date(Date.parse(`${f.to}T00:00:00Z`) + DAY);
  }
  return where;
}
