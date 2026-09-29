# Sürüm notları

Sürüm numarası logonun altında görünür ve her güncellemede artar:
**yeni özellik → ikinci hane** (3.1.0), **düzeltme → üçüncü hane** (3.0.1).
Önceki sistem v2.25 olduğu için yeni sistem 3.0.0 ile başladı.

## 3.3.2 — 29.09.2026 · Aşama 1 (giriş, roller, yetkiler, firmalar)

- **Denetimci** rolü: yönetici kullanıcı eklerken seçebilir. Tüm siparişleri tam firma adıyla, iç notları ve iç dosyaları görür;
  teklif olarak yalnızca müşteriye gönderilmiş olanı görür. Hiçbir işlem yapamaz. Menüsü: Siparişler, Teklifler, Yüklemeler.
- Yetkiler tek bir tablodan yönetiliyor; her sayfa ve işlem sunucuda bu tabloya göre kontrol ediliyor.
- Satış ve çizim ekibine firmanın adı daha veritabanından gelirken maskeleniyor; iletişim bilgileri (kişi, telefon, adres,
  vergi no) hiç gitmiyor. Çizim ekibi teklif tutarlarını görmüyor; satış yönetici fiyatını görmüyor.
- Girişte hatalı deneme sınırı: 15 dakikada 5 hatalı denemeden sonra giriş geçici olarak kilitlenir (kod ekranında da).
  Giriş, çıkış ve kilit olayları denetim kaydına yazılır.
- Şifre en az 6 karakter (en az bir harf ve bir rakam).
- **Firma kodu tam 3 harf** (A–Z). Eski kodlar 3 harfe çevrildi ve siparişlerin numaraları yeni koda göre güncellendi.
  Siparişi olan firmanın kodu artık değiştirilemez. Kod boş bırakılırsa addan, boşta olan bir kod önerilir.
- Demo ortamına Denetimci hesabı eklendi (denetim@ornek.test).

## 3.2.1 — 29.09.2026

- Kod denetiminin ilk bulguları düzeltildi (yönetici formlarındaki bağlantılar sayfayı yeniden yüklemeden açılır).

## 3.2.0 — 29.09.2026 · Aşama 0 (temel)

Ekranlarda ve iş akışında değişiklik yok; yeniden yapılanmanın temeli atıldı.

- Proje kuralları (`CLAUDE.md`), ana tanım (`docs/spec`), ürün kararları (`docs/decisions.md`) ve 11 mimari karar kaydı (`docs/adr`).
- Ortam değişkenleri tek yerde tanımlı ve doğrulanıyor; eksik/hatalı değer varsa sunucu açılmaz ve hepsini tek seferde listeler
  (`npm run env:check`). `.env.example` tamamlandı.
- Denetim kaydı veritabanında korunuyor: kayıtlar güncellenemez ve silinemez.
- Temel veri çerçevesi (`npm run db:seed`): beş rol (Denetimci dahil) ve yetkileri; sipariş tipleri, birimler ve profil kataloğu verisi
  sonraki aşamalar için hazır. Sunucu kurulumunda migration ile birlikte çalışır.
- İş akışı servisi iskeleti (tek geçiş noktası, denetim, bildirim kuyruğu) ve testleri.
- Kod denetimi (ESLint), ayrı veritabanında çalışan veritabanı testleri, satış/çizim ekranlarında müşteri adı sızıntı testi.

## 3.1.1 — 29.09.2026

- Teklif tablosunda uzun (Romence) sütun başlıkları iki satıra iner; açıklama sütunu daralmaz.

## 3.1.0 — 29.09.2026

- Uygulama Romence ve Türkçe: giriş ekranı, tüm paneller, durumlar, hareket geçmişi, hata mesajları.
- Giriş ekranının dili bağlantının geldiği ülkeye göre otomatik: Türkiye IP'si → Türkçe, Romanya (ve Moldova) → Romence;
  ülke bilinmiyorsa tarayıcı dili, o da değilse Romence. IP aralıkları RIPE NCC'nin herkese açık verisinden (aylık yenilenir).
- Giriş ekranında RO | TR düğmeleri, panellerin sağ üstünde dil seçimi; seçim hatırlanır.
- Hangi dilde giriş yapıldıysa panel o dille açılır; kullanıcının dili kaydedilir (e-postalar o dilde gider).
- Yönetici yeni kullanıcı eklerken davet e-postasının dilini Romence ya da Türkçe seçer.

## 3.0.0 — 28.09.2026

İlk sürüm.

- GKH Digital logosu giriş ekranında ve panellerin sol üstünde; altında sürüm numarası. Tarayıcı sekmesi simgesi.
- Giriş: e-posta + şifre; ilk girişte e-posta koduyla şifre belirleme. Roller: sistem yöneticisi, satış, çizimci, müşteri.
- Yönetici: müşteri firmaları, kullanıcılar, davetler, cam kataloğu.
- Sipariş akışı: müşteri siparişi → satış kararı (çizime / teklife gönder, beklemeye al; kararı geri alma)
  → çizim ve teklif hatları paralel → çizim onayı + teklif müşterideyken otomatik üretim → yükleme → arşiv.
- Teklif: cam satırları, CNC ve delik alt satırları, bedelsiz satır; fiyatsız satırla gönderilemez;
  yönetici fiyat onayı ve müşterideki teklifi güncelleme; revize çizim sonrası teklif kontrolü.
- Yükleme takvimi (satış / yönetici ve müşteri), sandık ölçü ve ağırlıkları, yük tahmini.
- Notlar, hareket geçmişi, SLA, müşteri adı maskeleme, yetkili dosya indirme.
- Codespaces demo ortamı (örnek veriler, demo posta kutusu).
