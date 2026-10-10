// Yönetici acil erişim kurtarma — sunucu komutu (P6 — karar 246). Yalnızca sunucuda, SSH ile bağlanmış operatör çalıştırır:
//   takip yonetici-kurtar yonetici@firma.com
// (deploy/takip.sh → araç konteyneri: node scripts/admin-recover.mjs E-POSTA). Akış ve kurallar:
// server/auth/admin-recovery-cli.js + server/auth/admin-recovery.js. Şifre yalnızca bu süreçte, terminalden görünmeden
// okunur: komut satırına, ortam değişkenine, dosyaya, kabuk geçmişine ya da günlüğe yazılmaz.
import os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { runRecoveryCli } from '../server/auth/admin-recovery-cli.js';

const stdin = process.stdin;
const out = process.stderr; // sorular ve sonuç; stdout boş kalır

/** Terminalden bir satır: echo = false → yazılan görünmez (ham kip; geri silme ve Ctrl+C desteklenir) */
function readLine(question, echo) {
  return new Promise((resolve) => {
    out.write(question);
    let buf = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const finish = (value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') return finish(buf);
        if (c === '\u0003' || c === '\u0004') {
          // Ctrl+C / Ctrl+D: hiçbir şey değişmeden çık
          buf = '';
          stdin.setRawMode(false);
          out.write('\nVazgeçildi; hiçbir şey değişmedi.\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          if (buf.length) {
            buf = [...buf].slice(0, -1).join('');
            if (echo) out.write('\b \b');
          }
          continue;
        }
        if (c < ' ') continue; // diğer denetim karakterleri
        buf += c;
        if (echo) out.write(c);
      }
    };
    stdin.on('data', onData);
  });
}

const isTTY = !!stdin.isTTY && typeof stdin.setRawMode === 'function';
const io = {
  isTTY,
  ask: (q) => readLine(q, true),
  askHidden: (q) => readLine(q, false),
  print: (s) => out.write(`${s}\n`),
};

const db = new PrismaClient();
let code = 1;
try {
  code = await runRecoveryCli({ argv: process.argv.slice(2), db, io, operator: process.env.TAKIP_OPERATOR, host: os.hostname() });
} catch (e) {
  // Ayrıntı yazılmaz (bağlantı adresi / değer sızmasın)
  out.write(`✘ Beklenmeyen hata; hiçbir şey değişmedi (${String(e?.code ?? e?.name ?? 'HATA').replace(/[^A-Z0-9_]/gi, '').slice(0, 30)}).\n`);
  code = 1;
} finally {
  await db.$disconnect().catch(() => {});
}
process.exit(code);
