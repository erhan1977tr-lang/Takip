// Yedek alarmı (P7, karar 249). Sunucu aracı (deploy/takip.sh) yedek ya da bekçi denetimi sorun bulduğunda araç
// konteynerinde scripts/backup-alert.mjs'i SABİT KODLARLA çağırır; bu modül e-postayı üretir ve gönderir.
// Kural: e-postaya yalnızca sabit metin, sorun kodları, sunucu adı ve saat girer — günlük satırı, komut çıktısı, dosya yolu,
// token, anahtar, şifre ya da hata metni ASLA girmez (kodlar dışındaki her şey reddedilir / atılır).
import { brandedHtml, sendBrandedMail } from '../mail/send.js';

/** Bilinen sorun kodları → Türkçe açıklama (sunucu operatörü / yönetici okur) */
export const BACKUP_PROBLEMS = Object.freeze({
  DB_DUMP: 'Veritabanı yedeği alınamadı (pg_dump).',
  DB_VERIFY: 'Veritabanı yedeği geçici veritabanına geri yüklenemedi (bütünlük denetimi başarısız).',
  FILES: 'Dosya yedeği (yüklenen dosyalar arşivi) alınamadı.',
  FILES_VERIFY: 'Dosya yedeği arşivi okunamadı (bütünlük denetimi başarısız).',
  RCLONE_MISSING: 'Google Drive aracı (rclone) kurulu değil; yedek yalnızca sunucuda.',
  ENCRYPT: 'Yedek şifrelenemedi ya da şifreli kopya çözülerek doğrulanamadı (age / anahtar); Drive\'a hiçbir şey gönderilmedi.',
  DRIVE_UPLOAD: 'Yedek Google Drive\'a yüklenemedi.',
  DRIVE_VERIFY: 'Google Drive\'daki kopya doğrulanamadı (md5 uyuşmuyor ya da okunamadı).',
  STALE: 'Son başarılı yedek (yerel + Google Drive) 26 saatten eski.',
  BACKUP_TIMER: 'Gece yedeği zamanlayıcısı (takip-backup.timer) çalışmıyor.',
  CHECK_TIMER: 'Yedek denetim zamanlayıcısı (takip-backup-check.timer) çalışmıyor ya da 3 saattir çalışmadı.',
  UNKNOWN: 'Tanımlanmamış bir yedek sorunu bildirildi.',
});
export const BACKUP_ALERT_KINDS = Object.freeze(['FAIL', 'RECOVERED']);
const MAX_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;

/** Yalnızca bilinen kodlar (sıralı, tekil); bilinmeyen değer içeriğiyle taşınmaz → UNKNOWN */
export function cleanCodes(list) {
  const out = new Set();
  for (const raw of list ?? []) {
    const c = String(raw ?? '').trim();
    if (!c) continue;
    out.add(Object.hasOwn(BACKUP_PROBLEMS, c) ? c : 'UNKNOWN');
  }
  return [...out].sort();
}
/** Sunucu adı: harf, rakam, nokta, tire; en çok 64 */
export const cleanHost = (v) => String(v ?? '').replace(/[^A-Za-z0-9.-]/g, '').slice(0, 64) || 'sunucu';
/** Saat cinsinden yaş (tam sayı, 0–100000) ya da null */
export function cleanAge(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : null;
}

/** BACKUP_ALERT_EMAIL: virgül / boşlukla ayrılmış adresler; geçersiz olan varsa hata (yanlış alıcıya gitmesin) */
export function parseRecipients(v) {
  const list = String(v ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length > MAX_RECIPIENTS) throw new Error(`en çok ${MAX_RECIPIENTS} adres`);
  for (const a of list) if (!EMAIL_RE.test(a)) throw new Error('geçerli e-posta adresleri olmalı (virgülle ayrılmış)');
  return [...new Set(list)];
}

/**
 * Alıcılar: ortamda BACKUP_ALERT_EMAIL varsa yalnızca onlar; yoksa etkin iç ekip yöneticileri (ADMIN). Veritabanı
 * okunamazsa (yedek sorunu veritabanından olabilir) boş liste — çağıran bunu ayrıca bildirir.
 * @param {{ configured: string[] | null | undefined, db?: any }} p
 */
export async function resolveRecipients({ configured, db }) {
  if (configured?.length) return configured;
  if (!db) return [];
  try {
    const rows = await db.user.findMany({
      where: { appRole: 'ADMIN', type: 'INTERNAL', isActive: true, deletedAt: null },
      select: { email: true }, orderBy: { createdAt: 'asc' }, take: MAX_RECIPIENTS,
    });
    return rows.map((r) => String(r.email).toLowerCase()).filter((e) => EMAIL_RE.test(e));
  } catch {
    return [];
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const stamp = (d) => new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' }).format(d);

/**
 * @param {{ kind: 'FAIL' | 'RECOVERED', codes?: string[], host?: string, ageHours?: number | null, now?: Date }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderBackupAlert({ kind, codes = [], host, ageHours = null, now = new Date() }) {
  const h = cleanHost(host);
  const list = cleanCodes(codes);
  const age = cleanAge(ageHours);
  const fail = kind === 'FAIL';
  const subject = fail ? `[TAKİP] Yedek ALARMI — ${h}` : `[TAKİP] Yedek düzeldi — ${h}`;
  const lines = fail
    ? [
      'Merhaba,',
      '',
      `TAKİP sunucusunun (${h}) yedeğinde sorun var (${stamp(now)}, Romanya saati):`,
      '',
      ...list.map((c) => `  - ${BACKUP_PROBLEMS[c]} [${c}]`),
      ...(age != null ? ['', `Son başarılı yedek (yerel + Google Drive): ${age} saat önce.`] : []),
      '',
      'Sunucuda kontrol: sudo takip yedek-kontrol durum   ·   ayrıntı: /opt/takip/logs/backup.log',
      'Elle yedek: sudo takip yedek',
      '',
      'Bu uyarı aynı sorun sürdükçe en çok günde bir kez yinelenir; sorun giderilince "düzeldi" e-postası gelir.',
    ]
    : [
      'Merhaba,',
      '',
      `TAKİP sunucusunun (${h}) yedeği yeniden düzgün çalışıyor (${stamp(now)}, Romanya saati).`,
      ...(age != null ? [`Son başarılı yedek (yerel + Google Drive): ${age} saat önce.`] : []),
    ];
  const text = [...lines, '', 'Bu e-posta TAKİP sunucu aracı tarafından otomatik gönderildi (GKH Trading Invest SRL).'].join('\n');
  const body = fail
    ? `<p style="margin:0 0 12px">Merhaba,</p>
<p>TAKİP sunucusunun (<b>${esc(h)}</b>) yedeğinde sorun var (${esc(stamp(now))}, Romanya saati):</p>
<ul>${list.map((c) => `<li>${esc(BACKUP_PROBLEMS[c])} <code>${esc(c)}</code></li>`).join('')}</ul>
${age != null ? `<p>Son başarılı yedek (yerel + Google Drive): <b>${age} saat önce</b>.</p>` : ''}
<p>Sunucuda kontrol: <code>sudo takip yedek-kontrol durum</code> · ayrıntı: <code>/opt/takip/logs/backup.log</code><br>Elle yedek: <code>sudo takip yedek</code></p>
<p style="color:#6b7280">Bu uyarı aynı sorun sürdükçe en çok günde bir kez yinelenir; sorun giderilince "düzeldi" e-postası gelir.</p>`
    : `<p style="margin:0 0 12px">Merhaba,</p>
<p>TAKİP sunucusunun (<b>${esc(h)}</b>) yedeği yeniden düzgün çalışıyor (${esc(stamp(now))}, Romanya saati).</p>
${age != null ? `<p>Son başarılı yedek (yerel + Google Drive): ${age} saat önce.</p>` : ''}`;
  return { subject, text, html: brandedHtml({ lang: 'tr', title: subject, body }) };
}

/**
 * @param {{ transport: any, from: string, recipients: string[], kind: string, codes?: string[], host?: string, ageHours?: number | null, now?: Date }} p
 * @returns {Promise<{ ok: true, sent: number } | { ok: false, code: 'BAD_KIND' | 'NO_CODES' | 'NO_RECIPIENTS' | 'SEND_FAILED' }>}
 */
export async function sendBackupAlert({ transport, from, recipients, kind, codes = [], host, ageHours = null, now = new Date() }) {
  if (!BACKUP_ALERT_KINDS.includes(kind)) return { ok: false, code: 'BAD_KIND' };
  const list = cleanCodes(codes);
  if (kind === 'FAIL' && list.length === 0) return { ok: false, code: 'NO_CODES' };
  if (!recipients?.length) return { ok: false, code: 'NO_RECIPIENTS' };
  const msg = renderBackupAlert({ kind: /** @type {'FAIL' | 'RECOVERED'} */ (kind), codes: list, host, ageHours, now });
  try {
    // Alıcılar birbirini görmez: her adrese ayrı ileti
    for (const to of recipients) await sendBrandedMail(transport, { from, to, subject: msg.subject, text: msg.text, html: msg.html });
  } catch {
    return { ok: false, code: 'SEND_FAILED' };
  }
  return { ok: true, sent: recipients.length };
}
