// Sunucu açılırken bir kez çalışır: ortam değişkenleri hatalıysa sunucu açılmaz (ADR 0011).
// Denetim işçiyle ORTAKTIR (server/env.js → startupEnv): gerçek sunucuda test / geliştirme ayarları burada da yok sayılır
// ve uyarısı günlüğe yazılır (karar 151). Rapor yalnızca değişken adlarını içerir, değer içermez.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startupEnv } = await import('./server/env.js');
  const startup = startupEnv(process.env);
  if (!startup.ok) {
    console.error(startup.report);
    process.exit(1);
  }
  if (startup.report) console.warn(startup.report);
}
