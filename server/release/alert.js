// Yayın / geri dönüş alarmı (3.92.0, karar 287). YALNIZCA sunucu aracı çağırır (deploy/takip.sh → release_alert):
//   node scripts/release-alert.mjs TÜR --host AD --from SÜRÜM --to SÜRÜM --mode gozlem|otomatik [KOD …]
// Yedek alarmının altyapısı kullanılır (karar 249 / 275): alıcılar BACKUP_ALERT_EMAIL, yoksa etkin yöneticiler; her alıcıya
// ayrı ileti; markalı şablon. E-postaya YALNIZCA sabit metin, bilinen kodlar, sürüm numaraları, sunucu adı ve saat girer —
// günlük satırı, komut çıktısı, yol, token, anahtar, şifre, hata metni ASLA girmez (bilinmeyen kod → UNKNOWN).
import { sendBrandedMail, brandedHtml } from '../mail/send.js';
import { cleanHost } from '../backup/alert.js';

/** Alarm türleri → konu */
export const RELEASE_ALERT_KINDS = Object.freeze({
  DEPLOY_FAILED: 'Yayın açılmadı',
  DEPLOY_UNHEALTHY: 'Yayın sağlık denetiminden geçmedi',
  ROLLBACK_DONE: 'Önceki sürüme geri dönüldü',
  ROLLBACK_FAILED: 'Geri dönüş sağlık denetiminden geçmedi',
  INTERRUPTED: 'Yarıda kalmış yayın / geri dönüş',
  MISMATCH: 'Uygulama ve işçi farklı sürümlerde',
});

/** Bilinen kodlar → Türkçe açıklama */
export const RELEASE_CODES = Object.freeze({
  APP_DOWN: 'Uygulama sağlıklı değil (kapsayıcı sağlık denetimi).',
  APP_IMAGE: 'Uygulama beklenen imajla çalışmıyor.',
  WORKER_DOWN: 'Arka plan işçisi çalışmıyor ya da sürekli yeniden başlıyor.',
  WORKER_IMAGE: 'Arka plan işçisi beklenen imajla çalışmıyor.',
  DB: 'Veritabanına (PostgreSQL) erişilemedi.',
  MIGRATION_FAILED: 'Veritabanında yarım kalmış migration var.',
  MIGRATION_ERROR: 'Veritabanı güncellemesi (migration) başarısız oldu.',
  EDGE: 'Site HTTPS üzerinden (Caddy) yanıt vermiyor.',
  VERSION: '/surum beklenen sürümü / commit\'i göstermiyor.',
  PROBE: 'Salt okunur uygulama yoklaması (Prisma ile veritabanı okuma) başarısız.',
  REVERTED: 'Veritabanı değişmediği için önceki sürüme dönüldü.',
  NOT_REVERTED: 'Önceki sürüme otomatik DÖNÜLMEDİ.',
  MIGRATION_CHANGED: 'Bu yayın veritabanına migration uyguladı: eski kodla uyumluluk kanıtlanamıyor.',
  ROLLBACK_SAFE: 'Son sağlıklı sürüme geri dönüş GÜVENLİ görünüyor (gözlem kipi: uygulanmadı).',
  ROLLBACK_UNSAFE: 'Son sağlıklı sürüme geri dönüş GÜVENLİ DEĞİL.',
  ROLLBACK_NO_TARGET: 'Geri dönülecek doğrulanmış sağlıklı sürüm yok.',
  ROLLBACK_AUTO: 'Otomatik kip: güvenli olduğu için geri dönüş başlatıldı.',
  NO_RECORD: 'Hedefin doğrulanmış kaydı yok.',
  IMAGE_MISSING: 'Hedef sürümün imajı sunucuda yok.',
  IMAGE_CHANGED: 'Hedef sürümün imaj kimliği kayıttakiyle aynı değil.',
  NO_SOURCE: 'Hedef sürümün kaynağı sunucuda yok.',
  CADDY_INVALID: 'Hedef sürümün Caddyfile\'ı geçersiz.',
  OP_DEPLOY: 'Bir yayın yarıda kaldı (sunucu / süreç durdu); olağan akış yeniden deneyecek.',
  OP_ROLLBACK: 'Bir geri dönüş yarıda kaldı; aynı denetimlerle tamamlanmaya çalışıldı.',
  STACK_MISMATCH: 'Uygulama ve arka plan işçisi yayındaki imajla çalışmıyor.',
  UNKNOWN: 'Tanımlanmamış bir durum bildirildi.',
});

/** Yalnızca bilinen kodlar (sıra korunur, tekil); bilinmeyen → UNKNOWN */
export function cleanReleaseCodes(list) {
  const out = [];
  for (const raw of list ?? []) {
    const c = String(raw ?? '').trim();
    if (!c) continue;
    const k = Object.hasOwn(RELEASE_CODES, c) ? c : 'UNKNOWN';
    if (!out.includes(k)) out.push(k);
  }
  return out.slice(0, 20);
}
/** Sürüm numarası: yalnızca rakam ve nokta (en çok 20); başka her şey atılır */
export const cleanVersion = (v) => String(v ?? '').replace(/[^0-9.]/g, '').slice(0, 20) || '?';
export const cleanMode = (v) => (v === 'otomatik' ? 'otomatik' : 'gozlem');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const stamp = (d) => new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' }).format(d);

/**
 * @param {{ kind: string, codes?: string[], host?: string, from?: string, to?: string, mode?: string, now?: Date }} p
 * @returns {{ subject: string, text: string, html: string } | null}
 */
export function renderReleaseAlert({ kind, codes = [], host, from, to, mode, now = new Date() }) {
  if (!Object.hasOwn(RELEASE_ALERT_KINDS, kind)) return null;
  const h = cleanHost(host);
  const list = cleanReleaseCodes(codes);
  const f = cleanVersion(from);
  const t = cleanVersion(to);
  const m = cleanMode(mode);
  const title = RELEASE_ALERT_KINDS[kind];
  const subject = `[TAKİP] ${title} — ${h}`;
  const versions = kind === 'ROLLBACK_DONE' || kind === 'ROLLBACK_FAILED'
    ? `Geri dönüş: ${f} → ${t}`
    : `Sürüm: ${f}${t !== '?' && t !== f ? ` (son sağlıklı sürüm: ${t})` : ''}`;
  const modeLine = m === 'gozlem'
    ? 'Geri dönüş kipi: GÖZLEM — canlı servis kendiliğinden eski sürüme geçirilmez; karar yöneticinindir.'
    : 'Geri dönüş kipi: OTOMATİK — güvenli olduğu kanıtlanırsa son sağlıklı sürüme dönülür.';
  const lines = [
    'Merhaba,',
    '',
    `TAKİP sunucusu (${h}) — ${title} (${stamp(now)}, Romanya saati).`,
    versions,
    '',
    ...list.map((c) => `  - ${RELEASE_CODES[c]} [${c}]`),
    '',
    modeLine,
    'Veritabanı hiçbir durumda otomatik olarak yedeğe döndürülmez, migration geri alınmaz.',
    '',
    'Sunucuda: sudo takip surum-durum · sudo takip rollback-kontrol · ayrıntı: /opt/takip/logs/release.log',
  ];
  const text = [...lines, '', 'Bu e-posta TAKİP sunucu aracı tarafından otomatik gönderildi (GKH Trading Invest SRL).'].join('\n');
  const body = `<p style="margin:0 0 12px">Merhaba,</p>
<p>TAKİP sunucusu (<b>${esc(h)}</b>) — <b>${esc(title)}</b> (${esc(stamp(now))}, Romanya saati).<br>${esc(versions)}</p>
${list.length ? `<ul>${list.map((c) => `<li>${esc(RELEASE_CODES[c])} <code>${esc(c)}</code></li>`).join('')}</ul>` : ''}
<p>${esc(modeLine)}<br>Veritabanı hiçbir durumda otomatik olarak yedeğe döndürülmez, migration geri alınmaz.</p>
<p>Sunucuda: <code>sudo takip surum-durum</code> · <code>sudo takip rollback-kontrol</code> · ayrıntı: <code>/opt/takip/logs/release.log</code></p>`;
  return { subject, text, html: brandedHtml({ lang: 'tr', title: subject, body }) };
}

/**
 * Her alıcıya ayrı ileti; bir alıcının hatası ötekileri durdurmaz.
 * @param {{ transport: any, from: string, recipients: string[], kind: string, codes?: string[], host?: string, fromVersion?: string, toVersion?: string, mode?: string, now?: Date }} p
 * @returns {Promise<{ ok: boolean, code?: string, sent: number, failed: number }>}
 */
export async function sendReleaseAlert({ transport, from, recipients, kind, codes = [], host, fromVersion, toVersion, mode, now = new Date() }) {
  const msg = renderReleaseAlert({ kind, codes, host, from: fromVersion, to: toVersion, mode, now });
  if (!msg) return { ok: false, code: 'BAD_KIND', sent: 0, failed: 0 };
  if (!recipients?.length) return { ok: false, code: 'NO_RECIPIENTS', sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    try {
      await sendBrandedMail(transport, { from, to, subject: msg.subject, text: msg.text, html: msg.html });
      sent++;
    } catch {
      failed++;
    }
  }
  if (!sent) return { ok: false, code: 'SEND_FAILED', sent, failed };
  return { ok: !failed, code: failed ? 'PARTIAL' : undefined, sent, failed };
}
