// Demo örnek verisinin (scripts/demo/seed.mjs) çalışma koşulları — karar 151 (güvenlik denetimi 3.50.9 AUD-13).
// Betik gerçek bir veritabanına demo yöneticisi, demo firması ve örnek siparişler yazar; bu yüzden TEK bir ayara
// (DEMO_MODE=1) güvenmez. İki bağımsız koşul vardır ve ikisi de "kapalı başarısız"dır (emin değilse ÇALIŞMAZ):
//   1. ORTAM  (demoSeedEnvGuard): gerçek sunucu işareti (TAKIP_DEPLOYMENT) varsa HER ZAMAN reddedilir — DEMO_MODE ne olursa
//      olsun; ayrıca DEMO_MODE tam olarak "1" olmalıdır (doğrulanmış değer de true olmalı: gerçek sunucuda o zaten false).
//   2. VERİ   (demoSeedDataGuard): ilk yüklemede veritabanı BOŞ olmalıdır — demo hesabı olmayan bir kullanıcı ya da herhangi
//      bir sipariş varsa reddedilir. İşaret bir şekilde verilmemiş olsa bile (ör. imaj Compose'suz elle çalıştırıldı),
//      gerçek verisi olan bir veritabanına demo verisi eklenemez. Demo hesapları zaten varsa (yeniden çalıştırma: "zaten
//      yüklü" / şifre yenileme) bu koşul aranmaz — o yol yalnızca demo hesaplarına dokunur.
import { isServerDeployment, validateEnv } from '../env.js';

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true } | { ok: false, reason: 'server' | 'not-demo' }}
 */
export function demoSeedEnvGuard(env = process.env) {
  if (isServerDeployment(env)) return { ok: false, reason: 'server' };
  const { server, values } = validateEnv(env);
  if (server) return { ok: false, reason: 'server' };
  if (String(env.DEMO_MODE ?? '').trim() !== '1' || values.DEMO_MODE !== true) return { ok: false, reason: 'not-demo' };
  return { ok: true };
}

/**
 * @param {{ demoAdminExists: boolean, otherUsers: number, orders: number }} state
 *   otherUsers: demo hesabı OLMAYAN kullanıcı sayısı · orders: toplam sipariş sayısı
 * @returns {{ ok: true } | { ok: false, reason: 'not-empty' }}
 */
export function demoSeedDataGuard({ demoAdminExists, otherUsers, orders }) {
  if (demoAdminExists === true) return { ok: true };
  if (!Number.isInteger(otherUsers) || !Number.isInteger(orders) || otherUsers > 0 || orders > 0) return { ok: false, reason: 'not-empty' };
  return { ok: true };
}

/** Reddin sabit metni (değer içermez) */
export const DEMO_SEED_REFUSALS = Object.freeze({
  server: 'Bu betik GERÇEK SUNUCUDA çalışmaz: demo verisi üretim veritabanına yüklenemez (DEMO_MODE ayarlı olsa da).',
  'not-demo': 'Bu betik yalnızca demo ortamında çalışır (DEMO_MODE=1).',
  'not-empty': 'Bu veritabanında demo dışı kullanıcı ya da sipariş var: demo verisi yalnızca BOŞ bir veritabanına yüklenir.',
});
