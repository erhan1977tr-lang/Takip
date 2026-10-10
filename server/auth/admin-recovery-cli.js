// Yönetici acil erişim kurtarma komutunun akışı (P6 — karar 246). Terminal girdisi / çıktısı dışarıdan verilir (io): gerçek
// komut scripts/admin-recover.mjs (gizli terminal girişi), testler sahte io. Akış:
//   1. Tek argüman: kurtarılacak YÖNETİCİ hesabının e-postası. Başka argüman (ör. "--password …") reddedilir — şifre komut
//      satırından ASLA alınmaz.
//   2. Etkileşimli terminal zorunlu (boru / dosyadan şifre okunmaz).
//   3. Hesap bulunur ve uygunluk denetlenir (var olan, etkin, iç ekip, ADMIN). Operatör e-postayı bir kez daha yazarak onaylar.
//   4. Yeni şifre iki kez, ekranda görünmeden; kurala uymazsa ya da eşleşmezse en çok MAX_TRIES deneme.
//   5. recoverAdmin: tek işlemde şifre, oturum iptali, davet kodu kapatma, denetim kaydı (giriş deneme sayaçlarına dokunmaz).
// Çıktıya şifre, özet ya da hata ayrıntısı yazılmaz; yalnızca sabit metinler ve sayılar.
import { findRecoveryTarget, newPasswordProblem, normalizeEmail, recordRecoveryFailure, recoverAdmin } from './admin-recovery.js';
import { PASSWORD_MIN } from './password-policy.js';

export const MAX_TRIES = 3;

const MESSAGES = {
  BAD_EMAIL: 'E-posta biçimi geçersiz.',
  NOT_FOUND: 'Bu e-postayla bir hesap yok. Kurtarma yalnızca var olan yönetici hesabı içindir; yeni hesap açılmaz.',
  DELETED: 'Bu hesap silinmiş (anonimleştirilmiş); kurtarılamaz.',
  INACTIVE: 'Bu hesap pasif. Pasif hesap bu komutla açılmaz.',
  NOT_INTERNAL: 'Bu hesap iç ekip hesabı değil; kurtarılamaz.',
  NOT_ADMIN: 'Bu hesap yönetici (ADMIN) değil; bu komut yalnızca yönetici hesabını kurtarır ve rol değiştirmez.',
  MISMATCH: 'İki şifre aynı değil.',
  short: `Şifre en az ${PASSWORD_MIN} karakter olmalı.`,
  long: 'Şifre çok uzun.',
  trivial: 'Şifre çok basit (en az 4 farklı karakter).',
};

/**
 * @param {{ argv: string[], db: any, io: { isTTY: boolean, ask: (q: string) => Promise<string>, askHidden: (q: string) => Promise<string>, print: (s: string) => void },
 *   operator?: unknown, host?: unknown, now?: Date }} p
 * @returns {Promise<number>} çıkış kodu (0 başarılı)
 */
export async function runRecoveryCli({ argv, db, io, operator, host, now }) {
  const fail = async (code, userId = null, text = MESSAGES[code] ?? 'İşlem yapılamadı.') => {
    io.print(`✘ ${text}`);
    await recordRecoveryFailure(db, { code, userId, operator, host });
    return 1;
  };
  if (argv.length !== 1 || String(argv[0]).startsWith('-')) {
    io.print('Kullanım: takip yonetici-kurtar E-POSTA   (şifre komut satırından verilmez; komut sorar)');
    return 2;
  }
  if (!io.isTTY) {
    io.print('✘ Bu komut yalnızca etkileşimli terminalde (SSH oturumu) çalışır; şifre borudan ya da dosyadan okunmaz.');
    return 2;
  }
  const email = normalizeEmail(argv[0]);
  const target = await findRecoveryTarget(db, email);
  if (!target.ok) return fail(target.code, target.userId ?? null);
  io.print(`Hesap: ${target.user.name || '—'} <${target.user.email}> · rol: yönetici`);
  io.print('Bu hesabın şifresi değişecek, açık oturumları kapanacak ve bekleyen doğrulama kodları geçersiz olacak.');
  const typed = normalizeEmail(await io.ask('Onaylamak için e-postayı yeniden yazın: '));
  if (typed !== email) return fail('CONFIRM_MISMATCH', target.user.id, 'Onay e-postası eşleşmedi; hiçbir şey değişmedi.');
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const password = await io.askHidden(`Yeni şifre (en az ${PASSWORD_MIN} karakter, ekranda görünmez): `);
    const confirm = await io.askHidden('Yeni şifre (tekrar): ');
    const problem = newPasswordProblem(password, confirm);
    if (problem) {
      io.print(`✘ ${MESSAGES[problem]}${attempt < MAX_TRIES ? ' Yeniden deneyin.' : ''}`);
      continue;
    }
    let r;
    try {
      r = await recoverAdmin(db, { email, password, confirm, operator, host, now });
    } catch (e) {
      // Ayrıntı yazılmaz (sorgu / değer sızmasın); işlem geri alındı
      return fail('ERROR', target.user.id, `İşlem tamamlanamadı; hiçbir şey değişmedi (${String(e?.code ?? 'HATA').replace(/[^A-Z0-9_]/gi, '').slice(0, 20)}).`);
    }
    if (!r.ok) return fail(r.code, target.user.id);
    io.print(`✔ Şifre değiştirildi. ${r.sessionsRevoked} açık oturum kapatıldı, ${r.invitesClosed} bekleyen kod geçersiz kılındı.`);
    io.print('  Not: hesap hatalı denemeler nedeniyle giriş kilidindeyse kilit en geç 15 dakika içinde kendiliğinden açılır.');
    io.print('Denetim kaydı yazıldı (ADMIN_RECOVERY). Yönetici şimdi giriş sayfasından yeni şifreyle girebilir.');
    return 0;
  }
  return fail('TOO_MANY_TRIES', target.user.id, 'Çok fazla hatalı deneme; hiçbir şey değişmedi.');
}
