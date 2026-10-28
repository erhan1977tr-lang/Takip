// Fabrika sipariş formu (Trakya Cam / GlassWorld düzeni) — SENTETİK satırlar: gerçek müşteri adı ve ticari fiyat yoktur
// (firma "MUSTERIX", kod ABC; fiyatlar uydurma). Birim testi (test/pdf-import.test.js) ve veritabanı testi kullanır.
export const DESC_TENTESOL = '6 mm Temperli Düz Cam DR+1.14 Şeffaf+6 mm Tentesol Füme Reflekte Temperli DR ŞEKİLLİ + CNC OYUK';
export const DESC_BRONZE = '6 mm Temperli Düz Cam DR+1.14 Şeffaf+6 mm Temperli Bronz Cam DR .';
export const DESC_UC = '8 mm Temperli Ultra Clear DR+1.14 Şeffaf+8 mm Temperli Ultra Clear DR ŞEKİLLİ - DELİKLİ';

/** Fabrika formunun satırları (sentetik): başlık + tablo + grup özeti + toplamlar */
export function form({ no = '90001', project = 'MUSTERIX ABC 40', rows, total, sub, vat = '0,00', grand, extraHead = [], page2 = null }) {
  const head = [
    'Trakya Cam ve Alm SİPARİŞ FORMU',
    `Form No : Std Sipariş Tarihi : 01-09-2026`,
    `Sipariş No : ${no} 121.001 Teslim Tarihi : 01-10-2026`,
    'Müşteri Adı : ALICI FIRMA S.R.L Rapor Tarihi : 02-10-2026 17:37',
    `Proje / Müşterisi : ${project}`,
    'Adres : SOKAK 1, ŞEHİR VD/No:VERGI 1111111111 T:111 111 11 11 KİŞİ F:',
    ...extraHead,
    'S.No Cam Adı / Cinsi En x Boy Adet M2 Top. M2 Birim Fiyat İsk. Tutar Poz',
  ];
  const tail = [
    `Toplam : ${total}`,
    'Şablon Farkı %: Küçük Ölçü Farkı %:',
    'Form No:0104 CAM / ÜRÜN GRUP BİLGİLERİ 20,00 20,00',
    'S.No Cam Adı / Cinsi Adet Top. M2 KG Birim Fiyat Fiyat İsk Tutar',
    // Grup özeti aynı kalemleri tekrarlar: satır olarak OKUNMAZ (okunsaydı A denetimi tutmazdı)
    '1 6 mm Tentesol Füme Reflekte Temperli DR + 6 mm Temperli Düz Cam DR 2 4,235 127,05 100,00 € 100,00 0,0 423,50 Ö',
    'CNC İŞLEMİ 2,000 5,00 € 5,00 0,0 10,00 ö',
    `Akbilgi | GlassWorld Sürüm :1.61.4 Toplam : MTL: 9,99 2 4,235 127,05 Toplam Tutar : ${sub} TL`,
    'G:01-09-2026 16:10:53 | Kişi D:02-09-2026 13:27:07 | Kişi € Kur :1,0000 İndirim Toplamı : 0,00 TL',
    'Fiyat Katagorisi',
    `Tüm Fiyatlar "Özel" Fiyatı Özel ( 8) Ara Toplam : ${sub} TL`,
    'İnşaat',
    `KDV Tutarı 20,00 : ${vat} TL`,
    `Genel Toplam : ${grand} TL`,
    'Verilen fiyat tekliflerimiz 10 gün için geçerlidir. Bu süre içerisinde anlaşma yapılmamış ise cam üreticileri.',
  ];
  const lines = [...head, ...rows, ...(page2 ? [] : tail)].map((text) => ({ page: 1, text }));
  if (page2) lines.push(...page2.map((text) => ({ page: 2, text })), ...tail.map((text) => ({ page: 2, text })));
  return lines;
}

// Sentetik form 1: iki satır, alt alta (cam adı + sayılar ayrı satırda), her camda bir CNC
export const FORM_CNC = form({
  rows: [
    `1 ${DESC_TENTESOL}`, '3000 1000 1 3,000 3,000 100,00 TL 0,0 300,00 ABC 40', 'CNC İŞLEMİ ADET 1,000 1,000 5,00 TL 0,0 5,00',
    `2 ${DESC_TENTESOL}`, '1235 1000 1 1,235 1,235 100,00 TL 0,0 123,50 ABC 40', 'CNC İŞLEMİ ADET 1,000 1,000 5,00 TL 0,0 5,00',
  ],
  total: '2 4,235 433,50', sub: '433,50', vat: '86,70', grand: '520,20',
});


// Normal / şekilli cam (karar 262) — kullanıcının verdiği açıklama düzeni: cam adı iki satıra bölünmüş, ikinci satır
// sayılarla aynı satırda; aynı teknik cam, ikincisi "- ŞEKİLLİ". Metraj 3 ondalık (1183 × 2017 = 2,386 m² — karar 261).
export const DESC_NORMAL = '66.3 TEMPER LAMİNE CAM REFLEKTE FÜME + ŞEFFAF';
export const DESC_SHAPED = '66.3 TEMPER LAMİNE CAM - ŞEKİLLİ REFLEKTE FÜME + ŞEFFAF';
export const shapedForm = ({ no = '97001', code = 'ABC 40' } = {}) => form({
  no, project: `MUSTERIX ${code}`,
  rows: [
    '1 66.3 TEMPER LAMİNE CAM', `REFLEKTE FÜME + ŞEFFAF 1183 2017 2 2,386 4,772 100,00 TL 0,0 477,20 ${code}`,
    '2 66.3 TEMPER LAMİNE CAM - ŞEKİLLİ', `REFLEKTE FÜME + ŞEFFAF 1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ${code}`,
  ],
  total: '3 5,772 577,20', sub: '577,20', vat: '115,44', grand: '692,64',
});

/** Satırları pdf.js parçası biçimine çevirir (satır başına bir parça, 12 pt aralık) — çıkarma adımı olmadan test için */
export const itemsOf = (lines) => lines.map((l, i) => ({ page: l.page, x: 20, y: 40 + i * 12, str: l.text }));

// ---------------------------------------------------------------------------------------------------------------- 4.2.11
// NOKTALI ONDALIK biçimli fabrika formu (GlassWorld 1.61.4 çıktısını alan iş istasyonunun bölge ayarı — ALE106 / ALE107 bu
// biçimde basıldı: 4.983 · 68.00 € · 0.0 · 481.64). Satır düzeni pdf.js'in gerçek bir noktalı biçimli formdan çıkardığı
// düzenin AYNISI (başlık sırası, tek satırlık cam satırı, "€" fiyattan sonra, "Toplam :" ve grup özeti ayrı, "Toplam Tutar" ayrı
// satırda, koşullar metninde virgüllü "0,30m2"). Kişi, adres, telefon, firma, fabrika numarası ve FİYATLAR SENTETİKTİR (gerçek
// müşteri / ticari veri yok); ölçü ve adetler ALE106 / ALE107'nin geometrisidir (3 + 1 + 1 cam, tek cam).
export const DESC_UC_838 = '8 mm Temperli Ultra Clear DR+1.14+8 mm Temperli Ultra Clear DR .';
export const DESC_DUZ_8 = '8 mm Temperli Düz Cam DR .';

/** Noktalı ondalık biçimli fabrika formunun satırları (sentetik): başlık + tablo + grup özeti + toplamlar + koşullar */
export function dotForm({ no = '91106', project = 'ABC 106', rows, total, group = [], sub, vat = '0.00', grand, page2 = null }) {
  const head = [
    'SİPARİŞ FORMU',
    'Trakya Cam ve Alm',
    'Form No : Std',
    'Sipariş Tarihi : 28-10-2026',
    `Sipariş No : ${no} 121.001`,
    'Teslim Tarihi : 13-11-2026',
    'Müşteri Adı : Rapor Tarihi : 28-10-2026 12:09',
    'ALICI FIRMA S.R.L',
    `Proje / Müşterisi : ${project}`,
    'Adres : SOKAK 1, ŞEHİR VD/No:VERGI 1111111111 T:111 111 11 11 KİŞİ F:',
    'S.No Cam Adı / Cinsi En x Boy Adet M2 Top. M2 Birim Fiyat İsk. Tutar Poz',
  ];
  const tail = [
    `Toplam : ${total}`,
    'Şablon Farkı %: Küçük Ölçü Farkı %:',
    'Form No:0104 CAM / ÜRÜN GRUP BİLGİLERİ 20.00 20.00',
    'S.No Cam Adı / Cinsi Adet Top. M2 KG Birim Fiyat Fiyat İsk Tutar',
    // Grup özeti aynı kalemleri tekrarlar: satır olarak OKUNMAZ (okunsaydı satırlar iki kez aktarılırdı)
    ...group,
    'Akbilgi | GlassWorld Sürüm :1.61.4 Toplam : MTL: 9.99 5 7.083 283.33',
    `Toplam Tutar : ${sub} TL`,
    'G:28-10-2026 10:34:30 | Kişi D:28-10-2026 11:54:26 | Kişi € Kur :1.0000 İndirim Toplamı : 0.00 TL',
    'Fiyat Katagorisi',
    `Özel ( 3) Ara Toplam : ${sub} TL`,
    'Tüm Fiyatlar "Özel" Fiyatı',
    'İnşaat',
    `KDV Tutarı 20.00 : ${vat} TL`,
    `Genel Toplam : ${grand} TL`,
    'Verilen fiyat tekliflerimiz 10 gün için geçerlidir. Bu süre içerisinde anlaşma yapılmamış ise cam üreticileri. tarafından uygulanan zamlar fiyatlara',
    // Koşullar metninde virgüllü sayı: sayı biçimi kararını etkilemez (yapı satırı değil)
    'Isıcamlarda 0,30m2 den küçük, 7m2den büyük ölçüler için fiyat farkı uygulanır.',
  ];
  const lines = [...head, ...rows, ...(page2 ? [] : tail)].map((text) => ({ page: 1, text }));
  if (page2) lines.push(...page2.map((text) => ({ page: 2, text })), ...tail.map((text) => ({ page: 2, text })));
  return lines;
}

/** ALE106 eşdeğeri (sentetik fiyat 50.00 €/m²): üç cam satırı (3 + 1 + 1 adet), uzun lamine cam adı, Poz sütunu boş */
export const DOT_FORM_3 = dotForm({
  no: '91106', project: 'ABC 106',
  rows: [
    `1 ${DESC_UC_838} 1582 1050 3 1.661 4.983 50.00 € 0.0 249.15`,
    `2 ${DESC_UC_838} 1002 1050 1 1.052 1.052 50.00 € 0.0 52.60`,
    `3 ${DESC_UC_838} 998 1050 1 1.048 1.048 50.00 € 0.0 52.40`,
  ],
  total: '5 7.083 354.15',
  group: ['1 8mm Temperli Ultra Clear DR + 8mm Temperli Ultra Clear DR . 5 7.083 283.33 50.00 € 50.00 0.0 354.15 Ö'],
  sub: '354.15', vat: '70.83', grand: '424.98',
});

/** ALE107 eşdeğeri (sentetik fiyat 20.00 €/m²): tek cam satırı */
export const DOT_FORM_1 = dotForm({
  no: '91107', project: 'ABC 107',
  rows: [`1 ${DESC_DUZ_8} 2215 1015 1 2.248 2.248 20.00 € 0.0 44.96`],
  total: '1 2.248 44.96',
  group: [`1 ${DESC_DUZ_8} 1 2.248 44.96 20.00 € 20.00 0.0 44.96 Ö`],
  sub: '44.96', vat: '8.99', grand: '53.95',
});
