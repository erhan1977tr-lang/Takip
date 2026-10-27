// Müşteri üretim onayı — mevcut siparişlerin kapsama alınması (karar 305). Yalnızca sunucuda, komut satırından; HTTP yolu yok.
// Kurallar: server/orders/production-approval-enroll.js. Varsayılan ÖN İZLEME (salt okunur işlem): etkilenecek siparişleri,
// kategorilerini ve onay kodunu yazar; hiçbir şey değiştirmez. Uygulamak için ön izlemenin onay kodu verilir.
// Kullanım (sunucuda, araç kapsayıcısında):
//   node scripts/production-approval-enroll.mjs                         # ön izleme (kesim günü ayardan; varsayılan 2026-11-06)
//   node scripts/production-approval-enroll.mjs --kesim 2026-11-06      # başka kesim günüyle ön izleme
//   node scripts/production-approval-enroll.mjs --uygula --onay KOD     # uygula (müşterilere e-posta + zil kuyruğa yazılır)
//   node scripts/production-approval-enroll.mjs --uygula --onay KOD --bildirimsiz   # kapsama al, müşteriye henüz bildirme
// Bildirimin kontrollü başlatılması (iletilmemiş talepler; süre müşteriye iletildiği anda başlar):
//   node scripts/production-approval-enroll.mjs --bildirim [--siparis GLA68,GLA70]               # ön izleme + onay kodu
//   node scripts/production-approval-enroll.mjs --bildirim [--siparis …] --uygula --onay KOD     # e-posta + zil kuyruğa
// Ekrana müşteri adı, fiyat, tutar, e-posta yazılmaz (yalnızca sipariş no, durum, gün, kategori).
import { PrismaClient } from '@prisma/client';
import { applyEnrollment, applyNotify, planEnrollment, planNotify } from '../server/orders/production-approval-enroll.js';
import { APPROVAL_SETTING_KEY, approvalCutoff, approvalSettingOn } from '../server/orders/production-approval.js';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const val = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const LABEL = {
  REQUEST: 'onay talebi açılacak',
  FLAG_ONLY: 'kapsama alınacak (güncel teklif henüz müşteride değil — onay teklif gönderilince istenir)',
  ALREADY: 'zaten kapsamda — atlanır',
  LOADED: 'yüklendi / yükleme onayı kalemi var (kısmi dahil) — DOKUNULMAZ',
  FINAL_INVOICED: 'nihai fatura kesilmiş — DOKUNULMAZ',
  COMPENSATION: 'telafi (-T) siparişi — DOKUNULMAZ',
  NO_OFFER: 'müşteriye gönderilmiş güncel teklif yok — DOKUNULMAZ (incelenmeli)',
};

const db = new PrismaClient();
let exit = 0;
try {
  const setting = await db.integrationSetting.findUnique({ where: { key: APPROVAL_SETTING_KEY }, select: { value: true } });
  const cutoff = val('--kesim') ?? approvalCutoff(setting?.value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('Kesim günü YYYY-AA-GG biçiminde olmalı.');
  const MSG = {
    CODE_REQUIRED: 'Onay kodu eksik ya da biçimi yanlış.',
    APPROVAL_MISMATCH: 'Onay kodu tutmuyor: ön izleme değişti — ön izlemeyi yeniden çalıştırın.',
    CONFLICT: 'Bu arada bir siparişte işlem yapıldı — hiçbir şey yazılmadı; ön izlemeyi yeniden çalıştırın.',
  };
  if (has('--bildirim')) {
    const orderNos = val('--siparis') ? String(val('--siparis')).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null;
    if (!has('--uygula')) {
      const plan = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return planNotify(tx, { orderNos });
      }, { timeout: 60_000 });
      console.log('Müşteri üretim onayı — bildirim ön izlemesi (salt okunur): müşteriye henüz iletilmemiş onay talepleri');
      console.log(['Sipariş', 'Durum', 'Önceki iletim hatası'].join('\t'));
      for (const r of plan.rows) console.log([r.orderNo, r.status, r.error ?? '-'].join('\t'));
      if (plan.missing.length) console.log(`Listede olmayan (talep yok / iletildi / karar verildi / kuyrukta): ${plan.missing.join(', ')}`);
      console.log(`\nToplam: ${plan.rows.length}\nOnay kodu: ${plan.code}`);
      console.log('Başlatmak için (müşterilere e-posta + zil gider): --bildirim' + (orderNos ? ` --siparis ${orderNos.join(',')}` : '') + ' --uygula --onay ' + plan.code);
    } else {
      if (!approvalSettingOn(setting?.value)) throw new Error('Özellik ayarı kapalı: önce Ayarlar → Entegrasyonlar → Müşteri üretim onayı açılmalı.');
      const r = await applyNotify(db, { code: String(val('--onay') ?? '').toUpperCase(), orderNos, operator: process.env.SUDO_USER || process.env.USER || 'bilinmiyor' });
      if (!r.ok) {
        console.error(`✘ ${MSG[r.code] ?? r.code}`);
        exit = 1;
      } else console.log(`✔ Bildirim kuyruğa yazılan talep: ${r.queued}`);
    }
  } else if (!has('--uygula')) {
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return planEnrollment(tx, { cutoff });
    }, { timeout: 60_000 });
    console.log(`Müşteri üretim onayı — geçiş ön izlemesi (salt okunur). Kesim: planlanan yükleme ≥ ${cutoff}`);
    console.log(`Özellik ayarı: ${approvalSettingOn(setting?.value) ? 'AÇIK' : 'KAPALI (uygulamadan önce açılmalı)'}`);
    console.log('');
    console.log(['Sipariş', 'Durum', 'Yükleme', 'Kategori', 'Teklif', 'Notlar'].join('\t'));
    for (const r of plan.rows) {
      const notes = [r.onHold ? 'beklemede' : '', r.proforma ? 'proforma var' : '', r.confirmationItems ? `yükleme onayı kalemi: ${r.confirmationItems}` : '', r.flagged ? 'bayraklı' : ''].filter(Boolean).join(', ');
      console.log([r.orderNo, r.status, r.shipDay, r.category, r.offerStatus ?? '-', notes].join('\t'));
    }
    console.log('');
    for (const [k, n] of Object.entries(plan.counts)) console.log(`${String(n).padStart(5)}  ${k} — ${LABEL[k] ?? k}`);
    console.log('');
    console.log(`Onay kodu: ${plan.code}`);
    console.log('Uygulamak için (müşterilere bildirim gider): --uygula --onay ' + plan.code);
    console.log('Bildirimsiz kapsama almak için (sonra --bildirim ile kontrollü başlatılır): --uygula --onay ' + plan.code + ' --bildirimsiz');
  } else {
    if (!approvalSettingOn(setting?.value)) throw new Error('Özellik ayarı kapalı: önce Ayarlar → Entegrasyonlar → Müşteri üretim onayı açılmalı.');
    const r = await applyEnrollment(db, {
      cutoff, code: String(val('--onay') ?? '').toUpperCase(), notify: !has('--bildirimsiz'),
      operator: process.env.SUDO_USER || process.env.USER || 'bilinmiyor',
    });
    if (!r.ok) {
      console.error(`✘ ${MSG[r.code] ?? r.code}`);
      exit = 1;
    } else {
      console.log(`✔ Onay talebi açılan: ${r.requested} · yalnızca kapsama alınan: ${r.flagged} · dokunulmayan: ${JSON.stringify(r.skipped)}`);
      if (has('--bildirimsiz')) console.log('Müşterilere henüz bildirim gitmedi; süre başlamadı. Başlatmak için: --bildirim (ön izleme)');
    }
  }
} catch (e) {
  console.error(`✘ ${e instanceof Error ? e.message : String(e)}`);
  exit = 1;
} finally {
  await db.$disconnect();
}
process.exit(exit);
