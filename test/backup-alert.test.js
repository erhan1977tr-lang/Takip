// Yedek alarmı e-postası (P7, karar 249): yalnızca sabit metin + bilinen kodlar; sır / günlük / serbest metin girmez;
// alıcılar BACKUP_ALERT_EMAIL ya da etkin yöneticiler; gerçek SMTP yok (sahte taşıyıcı).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKUP_PROBLEMS, cleanCodes, cleanKeys, parseRecipients, recipientKey, renderBackupAlert, resolveRecipients, sendBackupAlert } from '../server/backup/alert.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const NOW = new Date('2026-10-11T07:00:00Z');

test('kodlar: yalnızca bilinenler, sıralı ve tekil; bilinmeyen değer içeriğiyle taşınmaz', () => {
  assert.deepEqual(cleanCodes(['STALE', 'DB_DUMP', 'STALE', '']), ['DB_DUMP', 'STALE']);
  assert.deepEqual(cleanCodes(['SMTP_PASS=gizli', 'constructor', '__proto__']), ['UNKNOWN']);
});

test('e-posta: sorunlar Türkçe açıklamayla; sır, yol, serbest metin yok; düzeldi e-postası ayrı', () => {
  const m = renderBackupAlert({ kind: 'FAIL', codes: ['STALE', 'DRIVE_VERIFY', 'ghp_TOKEN123', '<script>'], host: 'srv-1; rm -rf /', ageHours: 27, now: NOW });
  assert.match(m.subject, /^\[TAKİP\] Yedek ALARMI — srv-1rm-rf$/);
  for (const c of ['STALE', 'DRIVE_VERIFY', 'UNKNOWN']) assert.ok(m.text.includes(BACKUP_PROBLEMS[c]) && m.html.includes(c), c);
  assert.match(m.text, /27 saat önce/);
  for (const s of ['ghp_TOKEN123', '<script>', 'rm -rf']) assert.ok(!m.text.includes(s) && !m.html.includes(s), s);
  assert.ok(m.html.includes('gkh-logo@takip'), 'ortak GKH düzeni');
  const r = renderBackupAlert({ kind: 'RECOVERED', host: 'srv-1', ageHours: 0, now: NOW });
  assert.match(r.subject, /Yedek düzeldi/);
  assert.ok(!r.text.includes('ALARM'));
});

test('alıcılar: BACKUP_ALERT_EMAIL önce; yoksa etkin yöneticiler; veritabanı okunamazsa boş', async () => {
  assert.deepEqual(parseRecipients('A@x.test, b@y.test;a@x.test'), ['a@x.test', 'b@y.test']);
  assert.throws(() => parseRecipients('a@x.test, "Ad" <b@y.test>'));
  assert.throws(() => parseRecipients(Array.from({ length: 11 }, (_, i) => `u${i}@x.test`).join(',')));
  let where = null;
  const db = { user: { findMany: async (q) => { where = q.where; return [{ email: 'Admin@Firma.test' }]; } } };
  assert.deepEqual(await resolveRecipients({ configured: ['ops@x.test'], db }), ['ops@x.test']);
  assert.equal(where, null, 'adres verilmişse veritabanı okunmaz');
  assert.deepEqual(await resolveRecipients({ configured: [], db }), ['admin@firma.test']);
  assert.deepEqual(where, { appRole: 'ADMIN', type: 'INTERNAL', isActive: true, deletedAt: null });
  assert.deepEqual(await resolveRecipients({ configured: [], db: { user: { findMany: async () => { throw new Error('db yok'); } } } }), []);
});

test('gönderim: alıcı başına ayrı ileti (birbirini görmez); hata / alıcısız / kodsuz alarm gönderilmiş sayılmaz', async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return {}; } };
  assert.deepEqual(await sendBackupAlert({ transport, from: 'noreply@gkh.test', recipients: ['a@x.test', 'b@x.test'], kind: 'FAIL', codes: ['DB_DUMP'], host: 'h', now: NOW }),
    { ok: true, sent: 2, delivered: [recipientKey('a@x.test'), recipientKey('b@x.test')] });
  assert.deepEqual(sent.map((m) => m.to), ['a@x.test', 'b@x.test']);
  assert.ok(sent.every((m) => !m.cc && !m.bcc && /GKH Trading Invest SRL/.test(m.from)));
  assert.deepEqual(await sendBackupAlert({ transport, from: 'f@x.test', recipients: [], kind: 'FAIL', codes: ['DB_DUMP'] }), { ok: false, code: 'NO_RECIPIENTS' });
  assert.deepEqual(await sendBackupAlert({ transport, from: 'f@x.test', recipients: ['a@x.test'], kind: 'FAIL', codes: [] }), { ok: false, code: 'NO_CODES' });
  assert.deepEqual(await sendBackupAlert({ transport, from: 'f@x.test', recipients: ['a@x.test'], kind: 'BOOM', codes: ['DB_DUMP'] }), { ok: false, code: 'BAD_KIND' });
  const broken = { sendMail: async () => { throw new Error('535 auth failed user=ops pass=gizli'); } };
  assert.deepEqual(await sendBackupAlert({ transport: broken, from: 'f@x.test', recipients: ['a@x.test'], kind: 'RECOVERED' }), { ok: false, code: 'SEND_FAILED', delivered: [] });
});

test('kısmi gönderim (karar 275): bir alıcının hatası ötekileri durdurmaz; alanlar yeniden almaz, almayana yeniden denenir', async () => {
  const sent = [];
  let bFails = true;
  const transport = { sendMail: async (m) => { if (m.to === 'b@x.test' && bFails) throw new Error('452 b@x.test gizli'); sent.push(m.to); return {}; } };
  const base = { transport, from: 'f@x.test', recipients: ['a@x.test', 'b@x.test', 'c@x.test'], kind: 'FAIL', codes: ['DB_DUMP'], host: 'h', now: NOW };
  const [ka, kb, kc] = base.recipients.map(recipientKey);
  // B'nin hatası C'yi durdurmaz; sonuç kısmi, adres / hata metni yok
  const first = await sendBackupAlert(base);
  assert.deepEqual(first, { ok: false, code: 'PARTIAL', sent: 2, failed: 1, delivered: [ka, kc] });
  assert.deepEqual(sent, ['a@x.test', 'c@x.test']);
  assert.ok(!JSON.stringify(first).includes('@'), 'sonuçta adres yok');
  // Yeniden deneme: alanlar atlanır; B hâlâ gönderilemiyor → yine kısmi, kimse ikinci kez almaz
  assert.deepEqual(await sendBackupAlert({ ...base, skip: first.delivered }), { ok: false, code: 'PARTIAL', sent: 0, failed: 1, delivered: [ka, kc] });
  assert.deepEqual(sent, ['a@x.test', 'c@x.test']);
  // B düzelince yalnızca B alır; alarm tamamlanır
  bFails = false;
  assert.deepEqual(await sendBackupAlert({ ...base, skip: first.delivered }), { ok: true, sent: 1, delivered: [ka, kb, kc] });
  assert.deepEqual(sent, ['a@x.test', 'c@x.test', 'b@x.test']);
  // Hiçbiri alamazsa: SEND_FAILED (sunucu aracı hepsine yeniden dener)
  const broken = { sendMail: async () => { throw new Error('x'); } };
  assert.deepEqual(await sendBackupAlert({ ...base, transport: broken }), { ok: false, code: 'SEND_FAILED', delivered: [] });
  // Anahtar: adres değil, sabit ve büyük / küçük harften bağımsız; bozuk "--skip" değerleri atılır
  assert.match(ka, /^[a-f0-9]{16}$/);
  assert.equal(recipientKey('A@X.test'), ka);
  assert.notEqual(ka, kb);
  assert.deepEqual(cleanKeys(`${ka},x@y.test,${ka},ZZZZ,${kb}`), [ka, kb]);
  assert.deepEqual(cleanKeys(undefined), []);
});

test('yapı: betik ayarları getEnv ile okur, adres / hata metni yazdırmaz; sunucu aracı yalnızca kod gönderir; bekçi zamanlayıcısı kurulur', () => {
  const s = read('scripts/backup-alert.mjs');
  assert.ok(!/process\.env\.[A-Z]/.test(s), 'tek tek process.env okunmaz');
  assert.ok(!/console\.(log|error)/.test(s));
  assert.ok(!/\$\{(e|err|recipients|to)\b/.test(s), 'hata metni / adres yazılmaz');
  const sh = read('deploy/takip.sh');
  assert.ok(sh.includes('compose run --rm --no-deps -T tools node scripts/backup-alert.mjs "$kind" --age "$hours" --host "${host:-sunucu}" ${skip:+--skip "$skip"} "$@"'));
  // TESLIM satırı (alıcı anahtarları) günlüğe yazılmaz; yalnızca durum dosyasına
  assert.ok(sh.includes("grep -v '^TESLIM ' >>\"$LOGS/backup-alert.log\""));
  assert.ok(s.includes("say(`TESLIM ${r.delivered.join(',')}`)") && s.includes('code = 3;'));
  assert.ok(sh.includes('yedek-kontrol | backup-check) cmd_backup_check "$@" ;;'));
  assert.ok(sh.includes('BACKUP_STALE_SECONDS=$((26 * 3600))'));
  assert.ok(read('deploy/systemd/takip-backup-check.timer').includes('OnCalendar=hourly'));
  assert.ok(read('deploy/systemd/takip-backup-check.service').includes('ExecStart=/usr/local/bin/takip yedek-kontrol'));
  assert.ok(read('deploy/install.sh').includes('takip-backup.timer takip-backup-check.timer'));
  assert.ok(read('.github/workflows/deploy-test.yml').includes('bash deploy/test/backup-alert.sh'));
});
