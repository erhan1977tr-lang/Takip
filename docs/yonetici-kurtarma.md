# Yönetici acil erişim kurtarma (karar 246)

Yönetici hesabına girilemediğinde (şifre unutuldu, hesap giriş kilidine düştü, ele geçirildiğinden şüpheleniliyor) **sunucu
operatörünün** SSH ile çalıştırdığı tek komut. Uygulamada (web / HTTP) kurtarma yolu yoktur.

## Ne yapar

- Yalnızca açıkça yazılan, **var olan**, etkin, silinmemiş, iç ekipten **yönetici (ADMIN)** hesabı için çalışır.
  - Yeni hesap açmaz.
  - Rol, ad, e-posta, firma ve etkinlik değiştirmez.
  - Başka hiçbir kullanıcıya dokunmaz.
- Yeni şifre:
  - ekranda görünmeden iki kez sorulur;
  - ortak şifre kuralına uyar: en az 10 karakter, en az 4 farklı karakter;
  - komut satırına, ortam değişkenine, kabuk geçmişine, dosyaya ya da günlüğe yazılmaz.
- Tek veritabanı işleminde şunları yapar:
  - şifre özetini yazar;
  - hesabın **bütün açık oturumlarını kapatır**;
  - bekleyen davet / doğrulama kodlarını geçersiz kılar;
  - **ADMIN_RECOVERY** denetim kaydını yazar (operatör adı, sunucu adı, kapatılan oturum sayısı; şifre ya da e-posta yok).
- Giriş deneme sayaçlarına dokunmaz (karar 148–149). Hesap hatalı denemeler nedeniyle giriş kilidindeyse kilit, denemeler
  durduktan en geç 15 dakika sonra kendiliğinden açılır; yeni şifreyle o zaman girilir.
- Bir adım başarısız olursa hiçbiri yazılmaz.
- Başarısız denemeler de denetime yazılır: **ADMIN_RECOVERY_FAILED**, yalnızca neden kodu.

## Kullanım (sunucuda, root)

```sh
ssh <operatör>@<sunucu>
sudo takip yonetici-kurtar yonetici@firma.com
```

Komut sırayla şunları yapar:

1. Hesabı gösterir (ad, e-posta, rol) ve ne olacağını yazar.
2. Onay için e-postayı **yeniden yazmanızı** ister.
3. Yeni şifreyi iki kez sorar (yazarken görünmez). Kurala uymayan ya da eşleşmeyen şifrede en çok 3 deneme hakkı vardır.
4. Sonucu yazar: "Şifre değiştirildi. N açık oturum kapatıldı, … bekleyen kod geçersiz kılındı."

Ardından yönetici giriş sayfasından yeni şifreyle girer.

Vazgeçmek için Ctrl+C (hiçbir şey değişmez).

## Çalışmadığı durumlar (bilinçli)

| Durum | Sonuç |
|---|---|
| root değil | "root olarak çalıştırılmalı" |
| Etkileşimli terminal yok (boru, betik, cron) | Çalışmaz: şifre borudan / dosyadan okunmaz |
| Şifre ya da başka bir argüman komut satırında | "Kullanım: …" — şifre asla argüman olarak alınmaz |
| Hesap yok | Yeni hesap açılmaz |
| Yönetici yardımcısı, satış, çizim, denetimci, müşteri | "yönetici (ADMIN) değil" — rol değişmez |
| Pasif ya da silinmiş hesap | Kurtarılmaz |

## Güvenlik notları

- Bu komutu çalıştırabilen kişi sunucuda root'tur; zaten veritabanına doğrudan erişebilir. Komut, bu erişimi **denetimli ve
  dar** bir yola çevirir: tek hesap, yalnızca şifre, oturumlar kapanır, kayıt yazılır.
- Kurtarmadan sonra denetim kaydını kontrol edin. Denetim kayıtları şimdilik ekranda listelenmez (SEC-16); sunucuda salt okunur
  sorguyla görülür:

  ```sh
  cd /opt/takip
  docker compose -p takip --env-file /opt/takip/.env -f /opt/takip/src/deploy/docker-compose.yml exec -T \
    -e PGOPTIONS='-c default_transaction_read_only=on' db psql -U takip -d takip -X -P pager=off -c \
    "SELECT \"createdAt\", action, \"entityId\", details FROM \"AuditLog\" WHERE action LIKE 'ADMIN_RECOVERY%' ORDER BY \"createdAt\" DESC LIMIT 20;"
  ```

  Yöneticinin sonraki girişi Ayarlar → Giriş logları sayfasında görünür.
- Hesabın ele geçirildiğinden şüpheleniliyorsa kurtarmadan sonra hesabın son işlemlerini denetim kaydından gözden geçirin.
- İlk kurulumdaki `takip yonetici E-POSTA "AD"` komutu ayrıdır (karar 247): yalnızca YENİ yönetici hesabı açar ve tek
  kullanımlık kod üretir. Var olan hesabın rolünü, türünü, etkinliğini ya da şifresini değiştirmez; eski `--reset` seçeneği
  kaldırıldı (verilirse hiçbir şey değişmeden reddedilir). Şifresini henüz belirlememiş (kodu süresi dolmuş) bir yönetici için
  komutu yeniden çalıştırmak yalnızca yeni kod üretir. Şifresi olan yönetici için acil erişim yalnızca `yonetici-kurtar`dır.
