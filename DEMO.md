# Takip — canlı demo (GitHub Codespaces)

Sunucu hazır olana kadar uygulamanın gerçek, çalışan halini GitHub üzerinde açabilirsiniz. Veritabanı, örnek siparişler
ve dört rolün hesabı kendiliğinden kurulur. **Bu ortam yalnızca deneme içindir; gerçek müşteri verisi girmeyin.**

## Açmak (ilk sefer 5–10 dakika sürer)

1. GitHub'da **erhan1977tr-lang/Takip** deposunu açın ve dal seçiciden **backend**'i seçin.
2. Yeşil **Code** düğmesi → **Codespaces** sekmesi → **Create codespace on backend**.
3. Tarayıcıda bir düzenleyici açılır; alttaki terminalde kurulum ilerler. Bitince uygulama kendiliğinden yeni sekmede açılır.
   Açılmazsa alttaki **Ports** sekmesinde **Takip (3000)** satırındaki küre simgesine tıklayın.
4. Şifre, soldaki dosya listesindeki **DEMO-GIRIS.txt** dosyasındadır (tüm demo hesapları için aynı).
   Giriş ekranındaki demo hesaplarından birine tıklayınca e-posta kendiliğinden dolar.

## Hesaplar

| Rol | E-posta |
|---|---|
| Sistem yöneticisi | yonetici@ornek.test |
| Satış | satis@ornek.test |
| Çizimci | cizim@ornek.test |
| Müşteri (Örnek Cam SRL, çizim onay yetkili) | musteri@ornek.test |

Farklı rolleri aynı anda denemek için ikinci hesabı gizli pencerede ya da başka bir tarayıcıda açın.

## Neler denenebilir

- **Satış:** ORN101 ve ORN102 karar bekliyor → *Çizim Ekibine Gönder* / *Teklife Gönder*. ORN106'da *Çizime Göndermeyi Geri Al*.
- **Çizimci:** ORN106'yı üstlenip bir PDF yükleyin; çizim müşterinin onayına gider.
- **Müşteri:** ORN104'te revize çizim onay bekliyor → *Çizimi onayla* ya da revizyon isteyin. *Yeni Sipariş* ile sipariş gönderin.
- **Yönetici:** ORN105'in fiyatını onaylayın. ORN104 *Teklif kontrolü* altında: revize çizim ölçüyü değiştirdi, teklifi güncelleyin.
  *Kullanıcılar*'dan yeni kullanıcı oluşturun; doğrulama kodu **Demo posta kutusu**'na düşer, o kodla ilk girişi deneyin.

Demo ortamında e-posta gönderilmez; tüm e-postalar yöneticinin *Demo posta kutusu* sayfasında görünür.

## Güncel sürüm

Codespace her açılışta son sürümü çeker ve gerekirse yeniden derler. Açıkken güncellemek için alttaki terminale yazın:

```
npm run demo
```

## Telefonda açmak / başkasına göstermek

Adres varsayılan olarak **yalnızca sizin GitHub hesabınızla** açılır. Telefonda, GitHub'a giriş yapılmış tarayıcıda aynı adresi açabilirsiniz.
Başkasına göstermek için **Ports** → *Takip* satırına sağ tıklayın → *Port Visibility* → *Public*. İşiniz bitince *Private*'a geri alın.

## Ücret ve kapatma

GitHub Free hesaplarda her ay 120 çekirdek-saat ve 15 GB depolama ücretsizdir (bu ortamın 2 çekirdekli makinesinde yaklaşık 60 saat).
Hesapta ödeme yöntemi yoksa kota dolunca kullanım durur, ücret çıkmaz. Codespace kullanılmadığında bir süre sonra kendiliğinden durur;
**github.com/codespaces** sayfasından durdurabilir ya da silebilirsiniz. Silinirse örnek veriler de silinir, yeniden açınca baştan kurulur.
