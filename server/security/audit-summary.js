// `npm audit --json` çıktısının özeti (karar 289) — saf; scripts/ci-audit.mjs kullanır.
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];

/** @param {any} data → { error } | { counts, items: [{ name, severity, title }] } */
export function summarize(data) {
  if (!data || typeof data !== 'object') return { error: 'boş yanıt' };
  if (data.error) return { error: String(data.error.summary || data.error.code || 'hata') };
  const vulns = data.vulnerabilities;
  if (!vulns || typeof vulns !== 'object') return { error: 'beklenmeyen biçim' };
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  const items = [];
  for (const [name, v] of Object.entries(vulns)) {
    const severity = LEVELS.includes(v?.severity) ? v.severity : 'info';
    counts[severity] += 1;
    const advisory = Array.isArray(v?.via) ? v.via.find((x) => x && typeof x === 'object') : null;
    items.push({ name, severity, title: advisory?.title ? String(advisory.title) : `${name} üzerinden` });
  }
  items.sort((a, b) => LEVELS.indexOf(b.severity) - LEVELS.indexOf(a.severity) || a.name.localeCompare(b.name));
  return { counts, items };
}
