// Geçmiş verinin açık hedef hesaba bağlanması (karar 300, bölüm 7) — sunucu komutu, HTTP yolu yoktur.
//   node scripts/sales-link.mjs --target satis@firma.com [--drawer cizim@firma.com]            → ön kontrol / önizleme (yazmaz)
//   node scripts/sales-link.mjs --target satis@firma.com [--drawer cizim@firma.com] --apply    → uygular (tek işlem)
// Hedef hesap açıkça verilir; tahmin edilmez. Çıktı: plan, belirsizlikler, para birimi başına toplamlar (önce / sonra).
import { PrismaClient } from '@prisma/client';
import os from 'node:os';
import { applyLink, previewLink } from '../server/orders/sales-link.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? '' : null; };
const target = opt('target');
const drawer = opt('drawer');
const apply = args.includes('--apply');
if (!target) {
  console.error('Kullanım: node scripts/sales-link.mjs --target E-POSTA [--drawer E-POSTA] [--apply]');
  process.exit(2);
}

const db = new PrismaClient();
try {
  const pre = await previewLink(db, { targetEmail: target, drawerEmail: drawer });
  console.log('Hedef hesap:', pre.target ? `${pre.target.email} (${pre.target.name})` : 'BULUNAMADI');
  console.log('Çizimci:', pre.drawer ? pre.drawer.email : 'YOK');
  console.log('Plan:', JSON.stringify(pre.plan));
  console.log('Toplamlar (önce):', JSON.stringify(pre.before));
  if (pre.ambiguities.length) {
    console.log('BELİRSİZ / ÇELİŞKİLİ KAYITLAR:');
    for (const a of pre.ambiguities) console.log(`  - ${a.code}: ${a.detail.join(', ')}`);
  }
  if (!pre.ok) {
    console.log('ENGEL:', pre.problems.join(', '));
    process.exit(1);
  }
  if (!apply) {
    console.log('Önizleme tamam — hiçbir şey yazılmadı. Uygulamak için --apply ekleyin.');
    process.exit(0);
  }
  const r = await applyLink(db, { targetEmail: target, drawerEmail: drawer, operator: `${process.env.SUDO_USER ?? os.userInfo().username}@${os.hostname()}` });
  if (!r.ok) {
    console.log('UYGULANMADI:', r.code);
    process.exit(1);
  }
  console.log('Uygulandı:', JSON.stringify(r.counts));
  console.log('Toplamlar (sonra):', JSON.stringify(r.after));
  console.log('Toplamlar değişmedi: EVET');
} catch (e) {
  console.error('HATA:', e?.message ?? e, '— işlem geri alındı, hiçbir şey değişmedi.');
  process.exit(1);
} finally {
  await db.$disconnect();
}
