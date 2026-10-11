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
