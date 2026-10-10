// Kurulum komutu `takip yonetici E-POSTA "AD"` (scripts/create-admin.mjs) — karar 247. YALNIZCA sunucu komutundan; HTTP
// yolu YOKTUR (bu modülü hiçbir sayfa, sunucu işlemi ya da route içe aktarmaz — test/admin-bootstrap.test.js tarar).
//
// Kurallar (en küçük güvenli davranış):
//   - E-posta için hesap YOKSA: yeni bir iç ekip YÖNETİCİ (ADMIN) hesabı açılır (fabrika kaydı yoksa o da açılır) ve tek
//     kullanımlık kod üretilir. İlk kurulumun (install.sh) ve sunucudan yeni yönetici eklemenin tek yolu budur
//     (yönetici rolü panelden verilmez — app/(panel)/admin/users/actions.ts).
//   - Hesap VARSA hiçbir rol, tür, etkinlik, ad ya da şifre DEĞİŞMEZ:
//       · yönetici değil (müşteri, satış, çizim, denetimci, yönetici yardımcısı) → REDDEDİLİR (sessiz rol yükseltme yok);
//       · silinmiş / pasif / müşteri türünde → reddedilir (yeniden etkinleştirme yok);
//       · şifresi olan yönetici → reddedilir; acil erişim yalnızca `takip yonetici-kurtar` ile (karar 246);
//       · şifresini henüz belirlememiş (kurulumu yarım kalmış) etkin yönetici → yalnızca YENİ KOD üretilir: eski kodlar
//         kapanır, rol / ad / şifre değişmez. Bu hesabın şifresi olmadığı için kurtarma komutunu dolanmaz.
//   - Eski `--reset` seçeneği kaldırıldı: verilirse hiçbir şey değişmeden reddedilir (`RESET_REMOVED`).
//   - Her sonuç denetime yazılır: ADMIN_BOOTSTRAP (mode CREATED | CODE_REISSUED) ya da ADMIN_BOOTSTRAP_REFUSED (yalnızca
//     neden kodu; e-posta, kod, şifre yok). Kontrol ve yazma tek işlemde, hesap satırı kilitlenerek yapılır.
import { createInvite } from './inviteCode.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Var olan hesap için karar (saf). null hesap → CREATE.
 * @param {{ type?: string, appRole?: string, isActive?: boolean, deletedAt?: unknown, hasPassword?: boolean } | null} user
 * @returns {'CREATE' | 'REISSUE' | 'DELETED' | 'NOT_INTERNAL' | 'NOT_ADMIN' | 'INACTIVE' | 'HAS_PASSWORD'}
 */
export function bootstrapDecision(user) {
  if (!user) return 'CREATE';
  if (user.deletedAt) return 'DELETED';
  if (user.type !== 'INTERNAL') return 'NOT_INTERNAL';
  if (user.appRole !== 'ADMIN') return 'NOT_ADMIN';
  if (!user.isActive) return 'INACTIVE';
  if (user.hasPassword) return 'HAS_PASSWORD';
  return 'REISSUE';
}

const refuse = async (db, code, userId = null) => {
  try {
    await db.auditLog.create({
      data: { action: 'ADMIN_BOOTSTRAP_REFUSED', entityType: 'User', entityId: userId, userId, actorRole: 'SYSTEM', details: { via: 'SSH_CLI', code } },
    });
  } catch {
    /* denetim yazılamazsa da hiçbir şey değişmemiştir */
  }
  return { ok: false, code };
};

/**
 * @param {any} db
 * @param {{ email: unknown, name?: string, factoryName?: string, reset?: boolean, secret: string, ttlHours?: number, now?: Date }} p
 * @returns {Promise<{ ok: true, mode: 'CREATED' | 'CODE_REISSUED', userId: string, code: string, ttlHours: number, factoryCreated: boolean }
 *   | { ok: false, code: string }>}
 */
export async function bootstrapAdmin(db, { email, name = '', factoryName, reset = false, secret, ttlHours = 24, now = new Date() }) {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) return { ok: false, code: 'BAD_EMAIL' };
  if (String(secret ?? '').length < 32) return { ok: false, code: 'NO_SECRET' };
  if (reset) return refuse(db, 'RESET_REMOVED');
  const ttl = Number(ttlHours) > 0 ? Number(ttlHours) : 24;

  let result;
  try {
    result = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT id, type::text AS type, "appRole"::text AS "appRole", "isActive", "deletedAt", ("passwordHash" IS NOT NULL) AS "hasPassword" FROM "User" WHERE email = ${e} FOR UPDATE`;
      const existing = rows[0] ?? null;
      const decision = bootstrapDecision(existing);
      if (decision !== 'CREATE' && decision !== 'REISSUE') return { ok: false, code: decision, userId: existing?.id ?? null };

      let userId;
      let factoryCreated = false;
      const firstAdmin = (await tx.user.count({ where: { appRole: 'ADMIN' } })) === 0;
      if (decision === 'CREATE') {
        let factory = await tx.customer.findFirst({ where: { type: 'FACTORY' }, orderBy: { createdAt: 'asc' } });
        if (!factory) {
          factory = await tx.customer.create({ data: { name: typeof factoryName === 'string' && factoryName.trim() ? factoryName.trim() : 'Fabrika', type: 'FACTORY' } });
          factoryCreated = true;
        }
        const created = await tx.user.create({ data: { email: e, name: String(name ?? '').trim(), appRole: 'ADMIN', type: 'INTERNAL', customerId: factory.id } });
        userId = created.id;
      } else {
        userId = existing.id;
        // Şifresi olmayan hesabın oturumu olmamalı; yine de kapatılır (yeni kodla girişten önce temiz durum)
        await tx.session.deleteMany({ where: { userId } });
      }
      const { code, record } = createInvite(e, secret, ttl, now);
      await tx.userInvite.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      // Kod bu terminalde teslim edildiği için "gönderildi" sayılır.
      await tx.userInvite.create({ data: { userId, codeHash: record.codeHash, expiresAt: record.expiresAt, sentAt: now } });
      const mode = decision === 'CREATE' ? 'CREATED' : 'CODE_REISSUED';
      await tx.auditLog.create({
        data: { action: 'ADMIN_BOOTSTRAP', entityType: 'User', entityId: userId, userId, actorRole: 'SYSTEM', details: { via: 'SSH_CLI', mode, firstAdmin, factoryCreated } },
      });
      return { ok: true, mode, userId, code, ttlHours: ttl, factoryCreated };
    });
  } catch (err) {
    // Aynı e-postayla eşzamanlı ikinci açılış: benzersizlik kuralı → hiçbir şey yazılmadı
    if (err?.code === 'P2002') return refuse(db, 'CONFLICT');
    throw err;
  }
  if (!result.ok) return refuse(db, result.code, result.userId);
  return result;
}

/** Komut çıktısı için Türkçe açıklama (yalnızca sunucu terminali; arayüz metni değildir). */
export const BOOTSTRAP_MESSAGES = {
  BAD_EMAIL: 'Geçerli bir e-posta adresi gerekli.',
  NO_SECRET: 'AUTH_SECRET ortam değişkeni en az 32 karakter olmalı.',
  RESET_REMOVED: '--reset artık yok; hiçbir şey değişmedi. Şifresini unutan yönetici için: sudo takip yonetici-kurtar E-POSTA',
  HAS_PASSWORD: 'Bu e-postada şifresi belirlenmiş bir yönetici hesabı var; hiçbir şey değişmedi. Acil erişim için: sudo takip yonetici-kurtar E-POSTA',
  NOT_ADMIN: 'Bu e-postada yönetici OLMAYAN bir hesap var; rolü bu komutla değiştirilmez, hiçbir şey değişmedi. Yeni yönetici için başka bir e-posta kullanın.',
  NOT_INTERNAL: 'Bu e-postada bir müşteri hesabı var; yönetici yapılamaz, hiçbir şey değişmedi.',
  INACTIVE: 'Bu e-postadaki yönetici hesabı pasif; bu komut hesabı yeniden etkinleştirmez, hiçbir şey değişmedi.',
  DELETED: 'Bu e-postadaki hesap silinmiş; hiçbir şey değişmedi.',
  CONFLICT: 'Aynı e-posta için eşzamanlı başka bir işlem hesabı açtı; hiçbir şey değişmedi. Komutu yeniden çalıştırın.',
};
