// Ayarlar → Giriş Logları (Paket A, karar 223) — yalnızca yönetici
export default {
  title: 'Giriş Logları',
  intro: 'Başarılı ve başarısız girişler: kullanıcı, rol, tarih / saat, IP. Kayıtlar {days} gün saklanır, sonra otomatik silinir. Şifre, kod ve denenen e-posta adresi kaydedilmez.',
  listTitle: 'Giriş kayıtları — sayfa {page}',
  empty: 'Bu süzgeçle kayıt yok.',
  unknown: 'Bilinmeyen hesap',
  success: 'Başarılı',
  failure: 'Başarısız',
  locked: 'kilit başladı',
  prev: '‹ Önceki',
  next: 'Sonraki ›',
  kind: {
    LOGIN: 'Giriş (şifre)',
    CODE: 'Doğrulama kodu',
    SETUP: 'İlk giriş (şifre belirlendi)',
  },
  col: { time: 'Tarih / saat', user: 'Kullanıcı', role: 'Rol', kind: 'Tür', result: 'Sonuç', ip: 'IP' },
  filter: {
    user: 'Kullanıcı', role: 'Rol', result: 'Sonuç', kind: 'Tür', from: 'Başlangıç', to: 'Bitiş', ip: 'IP adresi',
    all: 'Tümü', apply: 'Süz', clear: 'Temizle',
  },
};
