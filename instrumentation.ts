// Sunucu açılırken bir kez çalışır: ortam değişkenleri hatalıysa sunucu açılmaz (ADR 0011).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { validateEnv, formatEnvReport } = await import('./server/env.js');
  const result = validateEnv(process.env);
  const report = formatEnvReport(result);
  if (result.errors.length) {
    console.error(report);
    process.exit(1);
  }
  if (report) console.warn(report);
}
