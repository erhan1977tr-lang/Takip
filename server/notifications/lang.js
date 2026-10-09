// Müşteriye giden bildirim e-postasının dili (Paket 9, karar 200) — tek kural.
//   Kullanıcının kayıtlı tercihi (Ayarlar → Dil: Türkçe / Română) varsa o; "Otomatik"te mevcut algılama — kullanıcının son
//   girişteki / panelde seçtiği dil (User.language: giriş ekranının IP ülkesi / tarayıcı diline göre açılan dili); ikisi de
//   yoksa müşteri varsayılanı Romence.
//   Dil, olay kuyruğa YAZILIRKEN belirlenir ve olayın verisinde saklanır (payload.lang): işçi sonra gönderse de, kullanıcı
//   bu arada dilini değiştirse de e-posta olay anındaki dille gider. Eski olaylarda (lang yok) gönderim anındaki kural.
//   Tedarikçi siparişi e-postası her zaman Türkçedir (ayrı şablon, bu kurala girmez); mali belge e-postası Romencedir (karar 111).
export const CUSTOMER_DEFAULT_LANG = 'ro';

/** @param {{ fixedLanguage?: string | null, language?: string | null } | null | undefined} user @returns {'ro' | 'tr'} */
export function customerMailLang(user) {
  for (const v of [user?.fixedLanguage, user?.language]) if (v === 'ro' || v === 'tr') return v;
  return CUSTOMER_DEFAULT_LANG;
}

/** Olayın verisindeki dil (yalnızca geçerli değer) */
export const snapshotLang = (payload) => (payload && (payload.lang === 'ro' || payload.lang === 'tr') ? payload.lang : null);
