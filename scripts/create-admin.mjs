// Yönetici hesabı açar ve tek kullanımlık kodu ekrana yazar (ilk kurulum; sunucuda `takip yonetici`). Kurallar: karar 247,
// server/auth/admin-bootstrap.js — var olan hesabın rolü / şifresi DEĞİŞMEZ; şifresi olan yönetici için acil erişim yalnızca
// `takip yonetici-kurtar` (karar 246). Şifresini henüz belirlememiş yönetici için yeniden çalıştırmak yeni kod üretir.
// Kullanım:
//   npm run create-admin -- yonetici@firma.com "Ad Soyad" [--factory "GKH Trading"]
import { PrismaClient } from '@prisma/client';
import { BOOTSTRAP_MESSAGES, bootstrapAdmin } from '../server/auth/admin-bootstrap.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const val = args[i + 1];
  args.splice(i, val && !val.startsWith('--') ? 2 : 1);
  return val && !val.startsWith('--') ? val : true;
};
const factoryName = flag('--factory');
const reset = flag('--reset') !== undefined;
const [emailArg, nameArg = ''] = args;

const db = new PrismaClient();
let exitCode = 0;
try {
  const r = await bootstrapAdmin(db, {
    email: emailArg,
    name: nameArg,
    factoryName: typeof factoryName === 'string' ? factoryName : undefined,
    reset,
    secret: process.env.AUTH_SECRET || '',
    ttlHours: Number(process.env.INVITE_CODE_TTL_HOURS || 24) || 24,
  });
  if (!r.ok) {
    if (r.code === 'BAD_EMAIL') console.error('Kullanım: npm run create-admin -- yonetici@firma.com "Ad Soyad" [--factory "Fabrika adı"]');
    console.error(`✘ ${BOOTSTRAP_MESSAGES[r.code] ?? `Yönetici hesabı açılamadı (${r.code}).`}`);
    exitCode = 1;
  } else {
    if (r.factoryCreated) console.log('Fabrika kaydı oluşturuldu.');
    console.log(r.mode === 'CREATED' ? 'Yönetici hesabı oluşturuldu.' : 'Şifresi henüz belirlenmemiş yönetici hesabı için yeni kod üretildi (eski kodlar geçersiz).');
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
    console.log('');
    console.log(`Doğrulama kodu: ${r.code}   (${r.ttlHours} saat geçerli, tek kullanımlık)`);
    console.log(`Giriş: ${appUrl || '<uygulama adresi>'}/login  → e-postanızı yazıp şifre alanını boş bırakın.`);
    // Otomatik testler ve install.sh kodu bu satırdan okur.
    console.log(`CODE=${r.code}`);
  }
} finally {
  await db.$disconnect();
}
process.exit(exitCode);
