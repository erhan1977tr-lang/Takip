// Ayar olarak veritabanında saklanan gizli değerler (ör. FGO API anahtarı) için şifreleme.
// Anahtar sunucudaki AUTH_SECRET'tan türetilir; veritabanı yedeği tek başına anahtarı açmaya yetmez.
// Değer ekranda bir daha gösterilmez; yalnızca "kayıtlı" olduğu bilinir.
import crypto from 'node:crypto';

const keyOf = (secret, purpose) => crypto.createHash('sha256').update(`takip:${purpose}:${secret}`).digest();

/** @returns {string} "v1:<iv>:<tag>:<veri>" (base64url) */
export function sealSecret(plain, secret, purpose) {
  if (!secret) throw new Error('AUTH_SECRET yok');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret, purpose), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

/** Açılamazsa (anahtar değişmiş, bozuk veri) null */
export function openSecret(sealed, secret, purpose) {
  try {
    const [v, iv, tag, data] = String(sealed ?? '').split(':');
    if (v !== 'v1' || !iv || !tag || !data) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret, purpose), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
