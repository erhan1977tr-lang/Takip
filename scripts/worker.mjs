// Arka plan işçisi (sunucuda "worker" servisi olarak sürekli çalışır; docker compose).
//   - Taranmamış (PENDING) dosyaları antivirüsten geçirir: tarayıcıya yüklemede ulaşılamadıysa ya da eski dosyalar.
//   - Durumunu yönetici → Entegrasyonlar sayfası için kaydeder.
//   - Profil siparişi (Aşama 6): kuyruktaki depo e-postalarını (Comanda Depozit PDF'i + depo bağlantısı) gönderir; olmazsa yeniden dener.
//   - FGO (Aşama 6b): kuyruktaki proforma ve faturaları keser (BT kuruyla, RON).
//   - Cam FGO belgeleri (proforma / avans / fatura) ve müşteriye belge e-postaları.
//   - Sipariş olaylarının bildirim e-postaları (server/notifications/email.js; NOTIFY_EMAILS).
//   - Aynı olayların uygulama içi bildirimleri (zil): server/notifications/inapp.js — e-postadan bağımsız ayrı kanal.
//   - Muhasebe: açık FGO belgelerinin tutar / ödeme durumu saatte bir FGO'dan yenilenir (server/accounting/receivables.js).
//   - Oturum temizliği: süresi dolmuş / boşta kalmış oturum satırları saatte bir silinir (server/auth/session-policy.js).
//   - "Fatura bekliyor" (karar 126): yüklenmiş ama kapanış faturası kesilmemiş cam, ayardaki gün dolunca muhasebe yetkisine
//     saatte bir denetlenip kapsam başına bir kez bildirilir (server/accounting/uninvoiced.js). FGO'ya istek atılmaz.
//   - Otomatik arşiv (karar 158): fiziksel yüklemesi kanıtlı (kişinin "Yüklendi"si ya da eksiksiz yükleme onayı) cam siparişi
//     yükleme gününden 45 gün sonra mevcut arşiv durumuna geçer; 3.51.0'ın tarihe bakarak verdiği "Yüklendi"ler önce geri
//     alınır. Saatte bir (server/orders/auto-archive.js). Yalnızca veritabanı.
//   node scripts/worker.mjs          → her dakika
//   node scripts/worker.mjs --once   → bir tur (testler)
import { PrismaClient } from '@prisma/client';
import { AV_STATUS_KEY, getAvSettings, scanPending } from '../server/files/antivirus.js';
import { dispatchWarehouseEmails } from '../server/profile/warehouse.js';
import { dispatchFgoJobs } from '../server/profile/fgo-jobs.js';
import { dispatchDocEmails, dispatchGlassJobs } from '../server/glass/billing.js';
import { dispatchBatchJobs } from '../server/glass/batch.js';
import { syncFgoDocuments } from '../server/accounting/receivables.js';
import { readMailConfig } from '../server/mail/config.js';
import { createTransport } from '../server/mail/transport.js';
import { outboxTransport } from '../server/mail/outbox-transport.js';
import { getEnv, startupEnv } from '../server/env.js';
import { dispatchNotifications } from '../server/notifications/email.js';
import { dispatchInApp } from '../server/notifications/inapp.js';
import { pruneSessions } from '../server/auth/session-policy.js';
import { REMIND_EVERY_MS, remindUninvoiced } from '../server/accounting/uninvoiced.js';
import { AUTO_ARCHIVE_EVERY_MS, autoArchiveOrders, repairAutoShipped } from '../server/orders/auto-archive.js';

const once = process.argv.includes('--once');
const INTERVAL_MS = 60_000;

// Açılış denetimi — uygulamayla AYNI (server/env.js → startupEnv; karar 151, güvenlik denetimi AUD-13): ortam hatalıysa
// işçi BAŞLAMAZ (veritabanına bağlanmadan, hiçbir işe dokunmadan çıkar); uyarılar günlüğe yazılır. Gerçek sunucuda test /
// geliştirme ayarları (MAIL_OUTBOX_DIR, DEMO_MODE, TRANSLATE_FAKE, COOKIE_SECURE=false) burada da yok sayılır. Aşağıdaki
// kod bu ayarları ham ortamdan DEĞİL, yalnızca doğrulanmış değerlerden (getEnv) okur.
const startup = startupEnv(process.env);
if (!startup.ok) {
  console.error(startup.report);
  console.error('İşçi başlatılmadı: ortam değişkenleri hatalı.');
  process.exit(1);
}
if (startup.report) console.warn(startup.report);
const env = getEnv();

const db = new PrismaClient();
let stopping = false;
let wake = () => {};
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    wake();
  });
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// SMTP ayarlı değilse depo e-postaları kuyrukta bekler (yönetici sipariş sayfasında görür).
// MAIL_OUTBOX_DIR (yalnızca geliştirme/test/demo): e-postalar gönderilmez, klasöre yazılır. Değer doğrulanmış ortamdan
// gelir: gerçek sunucuda her zaman boştur (yok sayılır) → e-postalar SMTP ile gider, diske yazılmaz.
let mail = null;
if (env.MAIL_OUTBOX_DIR) {
  mail = {
    transport: outboxTransport(env.MAIL_OUTBOX_DIR),
    from: env.MAIL_FROM || 'Takip <noreply@localhost>',
    appUrl: env.APP_URL || '',
  };
} else {
  try {
    const cfg = readMailConfig(process.env);
    mail = { transport: createTransport(cfg), from: cfg.from, appUrl: cfg.appUrl };
  } catch (e) {
    log('e-posta ayarlı değil; depo e-postaları kuyrukta bekleyecek:', e?.message ?? e);
  }
}

async function profileTick() {
  const now = new Date();
  const f = await dispatchFgoJobs(db, { now, log });
  if (f.done || f.failed) log('FGO:', JSON.stringify(f));
  const g = await dispatchGlassJobs(db, { now, log });
  if (g.done || g.failed) log('FGO cam:', JSON.stringify(g));
  const b = await dispatchBatchJobs(db, { now, log });
  if (b.done || b.failed) log('FGO müşteri proforması:', JSON.stringify(b));
  // Uygulama içi bildirimler: e-posta ayarlı olmasa da dağıtılır (FGO işlerinden sonra: hata bildirimleri aynı turda)
  const a = await dispatchInApp(db, { now, log });
  if (a.created) log('uygulama içi bildirim:', JSON.stringify(a));
  if (!mail) return;
  const e = await dispatchDocEmails(db, { ...mail, now, log });
  if (e.sent || e.failed) log('belge e-postası:', JSON.stringify(e));
  const r = await dispatchWarehouseEmails(db, { ...mail, now, timeZone: getEnv().APP_TIMEZONE, log });
  if (r.sent || r.failed) log('depo e-postası:', JSON.stringify(r));
  // Sipariş olaylarının bildirim e-postaları (işlem tamamlandıktan sonra, kuyruktan)
  if (getEnv().NOTIFY_EMAILS) {
    const n = await dispatchNotifications(db, { ...mail, now, timeZone: getEnv().APP_TIMEZONE, log });
    if (n.sent || n.failed) log('bildirim e-postası:', JSON.stringify(n));
  }
}

// Saatte bir: açık (ödenmemiş / kısmi) FGO belgelerinin durumu. Kendi hata yakalaması var: FGO'ya ulaşılamaması
// belge kesimini, e-postaları ya da taramayı etkilemez; sipariş verisine dokunmaz, yönetici uyarısı üretmez.
async function fgoSyncTick() {
  if (once) return; // --once (testler): dış istek yok
  const env = getEnv();
  const r = await syncFgoDocuments(db, { now: new Date(), secret: env.AUTH_SECRET, appUrl: env.APP_URL ?? '', log });
  if (r.ran) log('FGO durum eşitleme:', JSON.stringify({ checked: r.checked, failed: r.failed }));
}

// Saatte bir (ve işçi başlarken): geçersiz oturum satırları + eski hatalı giriş kayıtları silinir (SEC-11).
// Kullanıcıyı etkilemez: bu oturumlar zaten kabul edilmiyordu.
const PRUNE_MS = 3_600_000;
let prunedAt = 0;
async function pruneTick() {
  if (Date.now() - prunedAt < PRUNE_MS) return;
  prunedAt = Date.now();
  const r = await pruneSessions(db);
  if (r.sessions || r.failures) log('oturum temizliği:', JSON.stringify(r));
}

// Saatte bir: uyarı günü gelmiş, kapanış faturası kesilmemiş yüklemeler → muhasebe yetkisine uygulama içi bildirim.
// Yalnızca veritabanı okur (FGO'ya istek yok); bildirim kapsam başına bir kez yazılır (benzersiz anahtar).
let remindedAt = 0;
async function uninvoicedTick() {
  if (once) return; // --once (testler): kural test/db/uninvoiced.test.js'te doğrudan denenir
  if (Date.now() - remindedAt < REMIND_EVERY_MS) return;
  remindedAt = Date.now();
  const r = await remindUninvoiced(db, { now: new Date(), log });
  if (r.created) log('fatura bekliyor:', JSON.stringify(r));
}

// Saatte bir (ve işçi başlarken) — karar 158: önce 3.51.0'ın tarihe bakarak verdiği "Yüklendi"ler mevcut üretim durumuna geri
// alınır; sonra fiziksel yüklemesi KANITLI (kişinin "Yüklendi"si ya da eksiksiz yükleme onayı) ve yükleme gününden 45 gün
// geçmiş cam siparişleri mevcut arşiv durumuna geçer. Planlanan tarih kanıt değildir; "Yüklendi" otomatik yazılmaz.
// Yalnızca veritabanı (dış istek yok); her sipariş iş akışı servisinden geçer (geçmiş + denetim kaydı).
let autoArchivedAt = 0;
async function autoArchiveTick() {
  if (once) return; // --once (testler): kural test/db/auto-archive.test.js'te doğrudan denenir
  if (Date.now() - autoArchivedAt < AUTO_ARCHIVE_EVERY_MS) return;
  autoArchivedAt = Date.now();
  const repaired = await repairAutoShipped(db, { log });
  if (repaired.reverted || repaired.skipped) log('otomatik "Yüklendi" geri alındı:', JSON.stringify(repaired));
  const r = await autoArchiveOrders(db, { now: new Date(), log });
  if (r.archived || r.skipped) log('otomatik arşiv:', JSON.stringify(r));
}

// Uygulama içi bildirimler turun BAŞINDA da dağıtılır (Paket 3 — bildirim gecikmesi): virüs taraması ve FGO işleri uzun
// sürse de zil beklemez. Uygulama, iş akışı işleminden hemen sonra kendi olaylarını zaten dağıtır (lib/notifications.ts →
// deliverInAppNow); bu adım o dağıtım yapılamadığında yedektir. Aynı olay aynı kullanıcıya bir kez yazılır (benzersiz anahtar).
async function inAppTick() {
  const a = await dispatchInApp(db, { now: new Date(), log });
  if (a.created) log('uygulama içi bildirim:', JSON.stringify(a));
}

async function tick() {
  const settings = await getAvSettings(db);
  const r = await scanPending(db, settings, { log });
  const value = { lastRun: new Date().toISOString(), enabled: settings.enabled, ...r };
  await db.integrationSetting.upsert({ where: { key: AV_STATUS_KEY }, create: { key: AV_STATUS_KEY, value }, update: { value } });
  if (r.scanned || r.missing || (r.stopped && r.stopped !== 'disabled')) log('tarama:', JSON.stringify(r));
}

log('işçi başladı');
while (!stopping) {
  try {
    await inAppTick();
  } catch (e) {
    log('bildirim hatası:', e?.message ?? e);
  }
  try {
    await tick();
  } catch (e) {
    log('hata:', e?.message ?? e);
  }
  try {
    await profileTick();
  } catch (e) {
    log('profil hatası:', e?.message ?? e);
  }
  try {
    await fgoSyncTick();
  } catch (e) {
    log('FGO durum eşitleme hatası:', e?.message ?? e);
  }
  try {
    await pruneTick();
  } catch (e) {
    log('oturum temizliği hatası:', e?.message ?? e);
  }
  try {
    await uninvoicedTick();
  } catch (e) {
    log('fatura bekliyor hatası:', e?.message ?? e);
  }
  try {
    await autoArchiveTick();
  } catch (e) {
    log('otomatik arşiv hatası:', e?.message ?? e);
  }
  if (once) break;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, INTERVAL_MS);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
await db.$disconnect();
log('işçi durdu');
