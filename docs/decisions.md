# Kararlar ve yol haritası

Kaynaklar: `CLAUDE.md` (proje kuralları) ve `docs/spec/GKH_TAKIP_REBUILD_SPEC.md` (ana tanım, v1.0).
Bu dosya, tanımla mevcut sistemin çeliştiği yerlerde ürün sahibinin **verdiği kararları** kaydeder.
Tanım ile bu dosya çelişirse bu dosya geçerlidir.

## Onaylanan kararlar (29.09.2026)

| # | Konu | Karar | Tanımdaki karşılığı |
|---|------|-------|---------------------|
| 1 | Çizim ve teklif | **Paralel** yürür. Satış incelemesinden sonra çizim (gerekiyorsa) ve teklif birbirini beklemez. | Tanım sıralı akış çiziyor (çizim → teklif). |
| 2 | Müşteri onayı | Müşteri teklifi **onaylamaz**. Çizim onaylı/gereksiz **ve** teklif müşteriye gönderilmişse sipariş kendiliğinden üretime geçer. | Tanım "customer-visible offer / approval" diyor. |
| 3 | Reddetme / iptal | Satış siparişi reddedemez. **Yalnızca yönetici iptal eder.** | — |
| 4 | Fiyat | **İki kademe:** satış kendi fiyatını girer (satış fiyatı / satış tutarı). Yönetici teklifin **yönetim kopyasını** yeni sürüm olarak açar, müşteri fiyatını girer (teklif fiyatı / teklif tutarı). Müşteri yalnızca yönetici fiyatını görür. Yönetici fiyatını yönetici dışında kimse görmez. Yönetici ekranlarında (teklif, yükleme) iki sütun yan yana. | Tanım tek fiyat katmanı anlatıyor. Ayrıntı: ADR 0009. |
| 5 | Sipariş no | **Firma kodu + müşterinin sipariş numarası** (`GLA68`). Numara zorunlu; formda firmanın bir sonraki numarasıyla dolu gelir, müşteri değiştirebilir; sipariş oluştuktan sonra sabit. Firma kodları benzersiz olduğundan numaralar çakışmaz. Önerilen numara değiştirilmemişken aynı anda başka sipariş aldıysa bir sonraki numara otomatik verilir. (29.09.2026'da netleşti; ilk yorumdaki "ayrı sistem numarası" düzeltildi.) | Tanım müşteri numarasının ayrı tutulmasını öneriyor; ürün sahibi kuralı netleştirdi. |
| 6 | Adresler | Ortak sayfa adresleri kalır (`/siparisler`, `/teklifler`, `/yuklemeler`, `/admin/...`); sayfa role göre içerik gösterir. | Tanım `/customer/...`, `/sales/...` öneriyor. |
| 7 | Maskeleme | Sabit uzunluk: ilk 3 karakter + 10 yıldız (`GLA**********`). Ad uzunluğu da gizlenir. Sunucuda yapılır. | Tanım adın uzunluğu kadar yıldız gösteriyor. |
| 8 | Denetimci | İlk sürümde **yalnızca görüntüler**, hiçbir işlem yapamaz. | Tanımda belirsiz bırakılmış. |
| 9 | Dil | Romence ve Türkçe kalır. İngilizce arayüz yok. | Tanım İngilizce örnekler kullanıyor. |
| 10 | Antivirüs | Müşterinin ya da başkasının yüklediği her dosya taranır; ayarlar yönetici **Entegrasyonlar** sayfasından. Ayrıntı: ADR 0010. | Tanım "scan/validate uploads as appropriate". |

## Aşama 1 kararları (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 11 | Denetimci ne görür | Tüm cam siparişleri, tam firma adı, iç notlar ve iç dosyalar; teklif olarak **yalnızca müşteriye gönderilmiş** olanı (müşterinin gördüğü tutarla). Hazırlanan teklifler ve yönetim kopyası fiyatları görünmez. Hiçbir işlem yapamaz. |
| 12 | Şifre | En az **6 karakter** (en az bir harf ve bir rakam). Hatalı deneme sınırı: aynı e-posta + IP 15 dakikada 5, aynı e-posta 20, aynı IP 30 → geçici kilit. |
| 13 | Firma kodu | Tüm sistemde **tam 3 harf** (A–Z). Eski kodlar 3 harfe çevrildi, siparişlerin numaraları da yeni koda göre güncellendi. Siparişi olan firmanın kodu değişmez. |
| 14 | Müşteri adına işlem | Aşama 9'a kaldı. |

## Aşama 2 kararları (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 17 | Dosya türleri | Müşteri ve çizimci için: PDF, DWG, DXF, STEP/STP, IGS/IGES, XLS/XLSX, DOC/DOCX, ZIP, JPG/JPEG, PNG; dosya başına en fazla 100 MB. İçerik uzantıyla uyuşmalı. |
| 18 | Antivirüs ulaşılamazsa | Dosya kabul edilir, "taranmadı" işaretlenir, işçi sonra tarar. "Taranmadı" dosya uyarıyla indirilebilir; virüslü dosya karantinada, indirilemez. Yönetici Entegrasyonlar'dan "reddet"e çevirebilir. |
| 19 | Sunucu belleği | 8 GB; ClamAV (~1,5 GB) aynı sunucuda çalışır. |

## Aşama 3 kararları (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 20 | Cam adları | Katalogda her camın Türkçe ve Romence adı + rengi (İngilizcesi Excel'de durur). **Herkes camı seçtiği arayüz dilinde görür** (müşteri de iç ekip de). Sipariş satırı iki dildeki adı ve ağırlığı sipariş anındaki haliyle saklar. |
| 21 | Cam kataloğu Excel'i | Yönetici kataloğu Excel'le indirip yükler. Düzen ürün sahibinin dosyasıyla aynı: `Cam adı (TR) · Renk (TR) · Cam adı (RO) · Renk (RO) · Cam adı (EN) · Renk (EN) · Ağırlık (kg/m²) · Aktif`. Cam, Türkçe ad + renkten tanınır; yüklemede önce önizleme, sonra onay. Dosyada olmayan cama dokunulmaz (silinmez). |
| 22 | Cam ağırlığı | kg/m², zorunlu. Yüklemelerde (ağırlık hesabı) kullanılır; **tekliflerde görünmez**. |
| 23 | Pasif cam | Hiçbir seçim listesinde görünmez; formdan gönderilirse sunucu reddeder. Eski siparişler değişmez. |
| 24 | Taslak sipariş | Müşteri "Taslak kaydet" ile formu yarım bırakabilir. Taslak sipariş değildir: numarası, SLA'sı yoktur, satışa ve kuyruklara düşmez; yalnızca firmanın müşteri kullanıcıları görür. Numara ve SLA "Gönder"de kesinleşir. |
| 25 | Müşteriden bilgi isteme | Yapılmayacak: satış beklemeye alır, iletişim telefonla ya da notla yürür. |
| 27 | Sandıklar | Sandık ölçü (uzunluk/genişlik/yükseklik) ve son ağırlıkları **Yüklemeler sekmesinde**, yükleme günü + müşteri bazında girilir; satış ya da yönetici girer. Sandık no o gün içinde tektir; sandığın hangi siparişleri taşıdığı seçilir. Sipariş sayfasında giriş yok. Siparişin yükleme günü değişirse sandıkları da yeni güne taşınır (başka siparişle ortak sandık eski günde kalır; numara doluysa kayar). |
| 26 | Fiyat tabloları (Aşama 3b) | Yönetici fiyat tabloları tutar (cam başına birim fiyat; delik ve CNC için sabit fiyat), Excel'le yükler; her satışçı bir tabloya atanır, atanmayan varsayılanı kullanır. Satışın teklifine fiyatlar dolu gelir; satışçı değiştirebilir, değiştirirse yöneticinin **Önemli kararlar** listesine ve giriş ekranına uyarı düşer. "Açık tekliflere uygula" yok. |

## Sunucu (29.09.2026)

| # | Konu | Karar |
|---|------|-------|
| 15 | Sunucu | Contabo VPS, **gerçek kullanım** (örnek veri yok). Adres şimdilik IP'den ücretsiz `*.sslip.io` (HTTPS). |
| 16 | Güncelleme | `backend` dalına gelen ve testlerden geçen her sürüm sunucuda kendiliğinden yayınlanır (ADR 0012). |

## Hâlâ açık olan konular (uygulamadan önce sorulacak)

- `GLA64-1` gibi eklerin anlamı → şimdilik üretilmez; müşteri numarası alanında serbest metin olarak durur.
- Profil siparişi numara biçimi → varsayılan `GLAP12` (tanımın önerisi), ayardan değiştirilebilir olacak.
- Profil siparişinde müşteri teklifi gördükten sonraki durumlar.
- KDV varsayılanları (dahil / hariç).
- Bildirim olay listesi ve metinleri.
- Sandık / brüt ağırlık formüllerinin tamamı.

## Aşamalar ve mevcut durum

Mevcut uygulama (3.1.x) cam siparişi akışının büyük bölümünü zaten çalıştırıyor. Yeniden yapılanma
**sıfırdan yazma değil**; her aşama mevcut kodu tanıma ve kararlara göre sağlamlaştırır (ADR 0001).

| Aşama | Kapsam | Mevcut durum |
|-------|--------|--------------|
| 0 | Depo, ortam, migration, test, lint, seed, mimari kararlar | 3.2.x'te tamamlandı |
| 1 | Giriş, kullanıcı, firma, rol/yetki, sunucuda maskeleme | **3.3.2'de tamamlandı** |
| 2 | Sipariş tipleri, numaralandırma, dosya, not, geçmiş, denetim servisi | **3.5.0'da tamamlandı** |
| 3 | Cam sipariş formu, katalog, yükleme, satış incelemesi | **3a (3.6.x): katalog, taslak, kuyruklar · 3b (3.7.x): fiyat tabloları, Önemli kararlar** |
| 4 | Çizim: atama, sürüm, onay, revizyon, SLA | Büyük ölçüde var |
| 5 | Satış teklifi, yönetici fiyatı, müşteriye gönderim | Var; iki kademeli fiyat (yönetim kopyası) eksik |
| 6 | Profil siparişi ve profil kataloğu | Yok (katalog verisi `prisma/seed/data` içinde hazır) |
| 7 | Yükleme, sandık, ağırlık, dışa aktarma | Takvim ve sandık var; Excel/PDF ve özel durum notu eksik |
| 8 | SMTP, bildirim tercihleri, outbox, WhatsApp, çeviri, görüntüleyici, ERP | SMTP var; outbox, tercih ve diğerleri eksik |
| 9 | Raporlar, politikalar, SLA ayarı, denetim ekranı | Kısmen |
| 10 | Beş rol uçtan uca test, güvenlik testleri, yedekleme, kurulum belgesi | Kısmen |
