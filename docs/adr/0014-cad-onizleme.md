# 0014 — Güvenli dosya önizlemesi ve DWG / DXF için GNU LibreDWG

**Durum:** Uygulandı (3.88.0) · 15.10.2026 · karar 283

## Bağlam
Kullanıcılar yetkili oldukları PDF, resim (JPG / PNG / WEBP) ve teknik çizim (DWG / DXF) dosyalarını indirmeden, uygulama
içinde görmek istiyor. İndirme yolu (`/dosya/<tür>/<kimlik>`) ve rol / firma erişim kuralları değişmemeli. DWG kapalı,
belgelenmemiş bir biçimdir; tarayıcıda doğrudan çizilemez. Harici / bulut DWG görüntüleme hizmeti ve müşteri dosyasının
dışarı gönderilmesi kabul edilmez (ürün sahibi).

## Araştırma: GNU LibreDWG (15.10.2026)
- **Sürüm:** son kararlı sürüm **0.14** (GitHub `LibreDWG/libredwg`, `0.14` etiketi; sürüm paketi
  `libredwg-0.14.tar.xz`, SHA-256 `62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275`).
- **Biçim desteği (resmî el kitabı):** DWG okuma r1.2 → r2018 ("%99"), DXF yazma "çoğunlukla"; PROXY nesneleri ve bazı
  sınıflar (ör. `ACAD_TABLE`) desteklenmez. C API (`dwg_read_file`, `dwg_write_file`, nesne erişimi) ve programlar
  (`dwg2dxf`, `dwgread`, `dwg2SVG` …) sunulur. Kurulum: kaynak paketinden `configure && make` (bağımlılık yalnızca libc / libm).
- **Gerçek örneklerle deneme** (paketin kendi 141 DWG test dosyası, r1.4 → 2018; müşteri dosyası değil): 141 / 141 DWG
  dönüştürüldü (en uzunu < 1 sn). AutoCAD'in kendi DXF'i bulunan 43 örnekten 41'inde çizim kapsamı birebir aynı. Fark eden
  ikisi: `2000/TS1.dwg` (LibreDWG `ACAD_TABLE`'ı DXF'e yazmıyor) ve `r2.6/dim.dwg` (R2.x ölçü bloklarının hepsine aynı ad
  `*D` veriliyor). Kesik / rastgele / bit çevrilmiş 19 bozuk dosyanın 8'i dönüştürülemedi, 11'i dönüştürüldü ama
  dönüştürücü hata satırları bildirdi.
- **Sonuç:** "tüm sürümler / tüm nesneler eksiksiz" VARSAYILMAZ. Dönüştürücü (sürümü sabit) desteklemediği nesneleri DXF'e
  yazmadan geçer ama hata çıktısında bildirir; önizleme bu bilgiyi kullanır ve hiçbir durumda sessizce eksik çizim
  göstermez (aşağıda).

## Lisans değerlendirmesi (GPLv3+)
- LibreDWG **GPLv3 ya da sonrası** ile lisanslıdır (kütüphane dahil — LGPL değil).
- TAKİP'e **bağlanmaz / gömülmez**: imajdaki `dwg2dxf` programı ayrı bir süreç olarak, dosya üzerinden çalıştırılır
  (komut satırı + dosya; ortak bellek / bağlantı yok). GPL SSS'ye göre ayrı programlarla bu tür "kol uzunluğunda" iletişim
  birleşik eser oluşturmaz; TAKİP'in kendi kodu GPL yükümlülüğüne girmez.
- TAKİP **dağıtılmıyor**: tek sunucuda çalışan hizmettir (SaaS). GPLv3'te ağ üzerinden kullanım dağıtım sayılmaz (AGPL
  değil); kaynak sunma yükümlülüğü yalnızca programın kopyası başkasına verilirse doğar.
- Yine de yükümlülük yok sayılmaz: imajda lisans metni (`/usr/share/doc/libredwg/COPYING`) ve tam kaynak adresi + SHA-256
  (`/usr/share/doc/libredwg/SOURCE`) bulunur; derleme yalnızca değiştirilmemiş resmî kaynak paketinden yapılır. İmaj
  başkasına verilirse (ör. müşteriye kurulum) aynı kaynak adresi birlikte verilmelidir.
- **Değerlendirme: uygun.** Ücretli / harici API gerekmez; müşteri dosyası sunucudan çıkmaz.

## Karar
- **Erişim:** önizleme, indirmeyle AYNI adres ve AYNI sorgudan geçer: `/dosya/<tür>/<kimlik>?onizle=1` (PDF / resim
  dosyanın kendisi) ve `?onizle=cad` (DWG / DXF → geometri JSON'u). Kapsam (`orderScope`), iç dosya kuralı, geri çekilen
  çizim sürümü (karar 146, `findDrawingFile`), imzalı teslim belgesi (karar 273 / 274), tedarik eki (`SUPPLIER_MANAGE`),
  virüslü dosya (403) ve disk denetimi önizlemeden ÖNCE çalışır. Ayrı denetim kaydı `FILE_PREVIEW` (indirme kaydı
  `FILE_DOWNLOAD` yazılmaz). Kullanıcı başına istek sınırı (120 / 5 dk). Yeni / tahmin edilebilir herkese açık adres yok.
- **Tür:** uzantıya güvenilmez — ilk baytlar (`server/files/preview.js`) ve uzantı ailesi uyuşmalı (MIME taklidi →
  `MISMATCH`). SVG / HTML önizlenmez. PDF / resim yanıtı: içerik türü imzadan, `Content-Disposition: inline`,
  `Content-Security-Policy: sandbox; default-src 'none'`, `nosniff`, `private, no-store`, `CORP: same-origin`.
- **CAD hizmeti** (`server/cad/service.mjs`, Compose servisi `cad`): uygulamayla aynı imaj, ayrı kapsayıcı; nobody
  (65534), salt okunur kök, `cap_drop: ALL`, `no-new-privileges`, bellek 3 GB / işlemci 1,5 / süreç 64; yalnızca `cad`
  iç ağı (`internal: true` — internet, veritabanı, antivirüs yok); yükleme birimi ve `.env` bağlı değil. Uygulama yetki
  denetiminden sonra dosyanın baytlarını gönderir. Her istek yeni bir `/tmp` klasöründe (bellekte, `noexec`) sabit adlarla
  (`in.dwg`, `out.dxf`, `out.json`) çalışır; dosya adı komuta girmez; kabuk yok (`spawn` + argüman dizisi); klasör her
  durumda silinir. `dwg2dxf` ve ayrıştırıcı (`dxf-cli.mjs`, ayrı node süreci) `prlimit` (bellek, işlemci süresi, dosya
  boyutu, çekirdek dökümü yok) + süre sınırıyla, tek tek (1 iş + 3 bekleyen) çalışır. Yanıtlar yalnızca sabit kodlar
  taşır.
- **Sessiz eksik yok:** ayrıştırıcının çizemediği / yaklaşık çizdiği nesneler (`notes.unsupported`, `notes.partial`),
  kağıt alanı, dönüştürücünün DXF'e yazmadığı türler (hata çıktısından tür adı + sayı, `converterReport` →
  `notes.dropped`) ve dönüştürücü hata satırları (`notes.converterErrors`; küçük önizleme resmine ait olanlar hariç)
  önizlemenin üstünde uyarı olarak listelenir; aynı adlı birden çok blok tahmin edilmez (çizilmeyen sayılır).
- **Ölçü uydurulmaz:** birim yalnızca dosyanın `$INSUNITS` değeridir (yoksa "belirtilmemiş"); ölçüm aracı yok.
- **Önbellek:** CAD sonucu yalnızca uygulama sürecinde, o istekte yetkisi doğrulanmış dosya için okunan özel bir
  bellek önbelleğindedir (anahtar: depolama anahtarı + boyut + değişme zamanı). Paylaşılan / herkese açık önbellek yok.
- **Arayüz:** ortak "Önizle / Previzualizare" düğmesi ve tek pencere (`components/FilePreview.tsx`,
  `FilePreviewViewer.tsx`); "Aç" ve "İndir" korunur. pdf.js ve çizici yalnızca düğmeye basılınca yüklenir.

## Sonuçlar
- İmaj derlemesine bir aşama eklenir (LibreDWG kaynaktan, ~3–5 dk; uygulama kodundan bağımsız olduğu için önbellekten gelir).
- Sunucuda bir kapsayıcı daha (boşta ~50 MB); dönüşüm sırasında en çok 3 GB.
- `ACAD_TABLE`, `MULTILEADER`, 3B katılar, PROXY nesneleri gibi türler gösterilmez — uyarıda listelenir; kesin bilgi için
  dosya indirilip CAD programında açılmalıdır.
- LibreDWG sürümü değiştirilecekse: yeni sürüm paketi + SHA-256 Dockerfile'da, CI'da ve kurulum testinde birlikte
  güncellenir ve gerçek örneklerle yeniden denenir (`deploy/test/cad-preview.sh`).
