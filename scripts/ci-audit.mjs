#!/usr/bin/env node
// Bağımlılık güvenlik taraması (karar 289; güvenlik denetimi 3.93.2 Y-9). Yalnızca CI'da çalışır.
//  · üretim bağımlılıklarında KRİTİK açık → ::error ve çıkış 1 (CI kırmızı, yayın kapısı geçmez)
//  · üretimde YÜKSEK, geliştirme bağımlılıklarında yüksek / kritik → ::warning (CI kırmızı olmaz, özet görünür)
//  · kayıt sunucusuna ulaşılamazsa → ::warning "tarama yapılamadı" (başarılı tarama gibi raporlanmaz)
// Çıktıya yalnızca paket adı, önem derecesi ve danışma başlığı yazılır.
import { spawnSync } from 'node:child_process';
import { summarize } from '../server/security/audit-summary.js';

function audit(args) {
  const r = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(r.stdout || '{}');
  } catch {
    return { error: { summary: 'yanıt okunamadı' } };
  }
}

const esc = (s) => String(s).replace(/[\r\n%]/g, ' ').slice(0, 300);
let code = 0;
for (const [label, args, fatal] of [
  ['üretim', ['--omit=dev'], ['critical']],
  ['tüm (geliştirme dahil)', [], []],
]) {
  const data = audit(args);
  const s = summarize(data);
  if (s.error) {
    console.log(`::warning title=npm audit (${label})::Tarama yapılamadı — ${esc(s.error)}`);
    continue;
  }
  console.log(`npm audit (${label}): ${JSON.stringify(s.counts)}`);
  for (const v of s.items) {
    if (v.severity !== 'critical' && v.severity !== 'high') continue;
    const bad = fatal.includes(v.severity);
    if (bad) code = 1;
    console.log(`::${bad ? 'error' : 'warning'} title=npm audit ${v.severity} (${label})::${esc(v.name)} — ${esc(v.title)}`);
  }
}
process.exit(code);
