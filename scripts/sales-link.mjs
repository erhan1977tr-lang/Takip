// Geçmiş verinin satışçılara bağlanması (karar 300 bölüm 7; 4.3.17 D-1 — karar 302) — sunucu komutu, HTTP yolu yoktur.
//   node scripts/sales-link.mjs [--assign GLA68=satis@firma.com …] [--payments satis@firma.com]
//       → ön kontrol / önizleme (YAZMAZ): tarihsel satışçıya göre dağılım, sahipsiz kalanlar, onay kodu
//   node scripts/sales-link.mjs --apply --approve KOD [aynı --assign / --payments]
//       → yalnızca önizlemede gösterilen ve onaylanan dağılımı uygular (tek işlem; dağılım değiştiyse hiçbir şey yazılmaz)
// Tarihsel sahibi belirlenemeyen siparişler OTOMATİK olarak kimseye verilmez: --assign ile açık karar ya da bağlamadan sonra
// panelde "Satışçıya ata" (yönetici).
import { PrismaClient } from '@prisma/client';
import os from 'node:os';
import { LINK_TX, applyLink, parseDecisions, previewLink } from '../server/orders/sales-link.js';

const args = process.argv.slice(2);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] ?? ''] : []));
const apply = args.includes('--apply');
const approve = values('approve')[0] ?? null;
const payments = values('payments')[0] ?? null;
const decisions = parseDecisions(values('assign'));
const known = new Set(['--apply', '--approve', '--assign', '--payments']);
const unknown = args.filter((a, i) => a.startsWith('--') && !known.has(a) && !['--approve', '--assign', '--payments'].includes(args[i - 1]));
if (!decisions || unknown.length || (apply && !approve)) {
  console.error('Kullanım: node scripts/sales-link.mjs [--assign SIPARIS=E-POSTA …] [--payments E-POSTA] [--apply --approve ONAY-KODU]');
  if (!decisions) console.error('  --assign biçimi: GLA68=satis@firma.com');
  if (apply && !approve) console.error('  --apply için önizlemenin onay kodu gerekir (--approve KOD).');
  process.exit(2);
}

const PROBLEM = {
  ALREADY_LINKED: 'bağlama daha önce yapılmış',
  DECISION_UNKNOWN_ORDER: 'karar verilen sipariş bağlamaya girmiyor (yok ya da zaten sorumlusu var)',
  DECISION_AMBIGUOUS_ORDER: 'aynı numaralı birden çok sipariş — karar verilemez',
  DECISION_NOT_SALES: 'karardaki hesap etkin bir satışçı değil',
  DECISION_TWICE: 'aynı sipariş için iki farklı karar',
  PAYMENTS_NEED_DECISION: 'hesabı boş fabrika ödemesi var — hangi satışçının hesabına yazılacağını --payments ile açıkça verin',
  PAYMENT_OWNER_NOT_SALES: '--payments hesabı etkin bir satışçı değil',
  APPROVAL_MISMATCH: 'onay kodu güncel dağılımla eşleşmiyor (önizlemeden sonra veri ya da karar değişti) — önizlemeyi yeniden çalıştırın',
  APPROVAL_REQUIRED: 'onay kodu gerekli',
};
const REASON = { UNKNOWN: 'iz yok', CONFLICT: 'birden çok satışçı', INACTIVE_OWNER: 'satışçı pasif / silinmiş' };

const db = new PrismaClient();
try {
  const pre = await previewLink(db, { decisions, paymentEmail: payments });
  const s = pre.summary;
  console.log(`Sorumlusu boş cam siparişi: ${s.orders}`);
  console.log('DAĞILIM (tarihsel satışçıya göre):');
  for (const o of s.byOwner) console.log(`  - ${o.email}: ${o.orders} sipariş (çizimci: ${o.drawer ?? 'YOK'})`);
  if (s.decisions.length) {
    console.log('YÖNETİCİ KARARLARI (--assign):');
    for (const d of s.decisions) console.log(`  - ${d.orderNo} → ${d.owner}${d.override ? ' (tarihsel sahibin yerine)' : ''}`);
  }
  console.log(`SAHİPSİZ KALACAK (yönetici kararı gerekir — panelde "Satışçıya ata" ya da --assign): ${s.unresolved.length}`);
  for (const u of s.unresolved) console.log(`  - ${u.orderNo} [${u.status}${u.removed ? ', silinmiş' : ''}] ${REASON[u.reason] ?? u.reason}${u.candidates.length ? `: ${u.candidates.join(', ')}` : ''}`);
  console.log(`Çizimcisi boş olup satışçının varsayılan çizimcisi atanacak sipariş: ${s.drawersToSet}`);
  if (s.drawerMismatch.length) {
    console.log(`UYARI — çizimcisi satışçının varsayılan çizimcisinden farklı (değiştirilmez; gerekirse --assign ile doğru satışçıya verin): ${s.drawerMismatch.length}`);
    for (const d of s.drawerMismatch) console.log(`  - ${d.orderNo} → ${d.owner}`);
  }
  if (s.ownersWithoutDrawer.length) console.log(`  Varsayılan çizimcisi olmayan satışçılar (siparişleri çizimcisiz kalır): ${s.ownersWithoutDrawer.join(', ')}`);
  console.log(`Sandık: ${s.crates.total} sahipsiz, ${s.crates.linked} bağlanacak, ${s.crates.kept.length} eski kayıt olarak kalacak`);
  for (const c of s.crates.kept) console.log(`  - #${c.crateNo} ${c.day ?? '—'}: ${({ EMPTY: 'boş', MIXED: 'farklı satışçıların siparişleri', UNRESOLVED: 'sahipsiz sipariş içeriyor' })[c.reason] ?? c.reason}`);
  console.log(`Hesabı boş fabrika ödemesi: ${s.payments.count}${s.payments.owner ? ` → ${s.payments.owner}` : ''}`);
  console.log('Otomatik yönlendirme kuralı yazılmaz: yeni siparişlerde sorumlu satışçıyı yönetici seçer.');
  console.log('Toplamlar (önce):', JSON.stringify(pre.before));
  if (!pre.ok) {
    console.log('ENGEL:');
    for (const p of pre.problems) console.log(`  - ${p.code}${p.detail ? ` (${p.detail})` : ''}: ${PROBLEM[p.code] ?? ''}`);
    process.exit(1);
  }
  console.log(`ONAY KODU: ${pre.approval}`);
  if (!apply) {
    console.log('Önizleme tamam — hiçbir şey yazılmadı. Dağılımı onaylıyorsanız aynı seçeneklerle --apply --approve <ONAY KODU> ekleyin.');
    process.exit(0);
  }
  const started = Date.now();
  let r;
  try {
    r = await applyLink(db, { approval: approve, decisions, paymentEmail: payments, operator: `${process.env.SUDO_USER ?? os.userInfo().username}@${os.hostname()}` });
  } catch (e) {
    console.error(`Süre: ${Date.now() - started} ms (işlem sınırı ${LINK_TX.timeout} ms)`);
    throw e;
  }
  const tm = r.timing ? ` — önizleme ${r.timing.previewMs} ms, işlem ${r.timing.applyMs} ms, toplam ${r.timing.totalMs} ms (işlem sınırı ${r.timing.limitMs ?? LINK_TX.timeout} ms)` : '';
  if (!r.ok) {
    console.log('UYGULANMADI:', r.code, PROBLEM[r.code] ?? '', tm);
    process.exit(1);
  }
  console.log('Uygulandı:', JSON.stringify(r.counts));
  console.log('Toplamlar (sonra):', JSON.stringify(r.after));
  console.log('Toplamlar değişmedi: EVET');
  console.log(`Süre:${tm}`);
} catch (e) {
  // Prisma işlem süresi aşımı (P2028) ya da PostgreSQL zaman aşımı: işlem bütünüyle geri alınır
  const timeout = e?.code === 'P2028' || /statement timeout|lock timeout|Transaction already closed|expired transaction/i.test(String(e?.message ?? ''));
  console.error(timeout ? 'HATA: ZAMAN AŞIMI' : 'HATA:', e?.message ?? e, '— işlem geri alındı, hiçbir şey değişmedi.');
  process.exit(1);
} finally {
  await db.$disconnect();
}
