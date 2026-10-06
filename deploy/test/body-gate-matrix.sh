#!/usr/bin/env bash
# Gövde kapısının davranış denetimi (karar 143) — gerçek Caddy + depodaki Caddyfile, arkasında SAHTE uygulama
# (deploy/test/body-gate-mock.mjs). deploy/test/body-gate.sh her Caddy sürümü için çağırır:
#
#   bash body-gate-matrix.sh SİTE DENETİM ETİKET SONUÇ_DOSYASI
#     SİTE     Caddy'nin adresi (https://localhost:PORT)      DENETİM  sahte uygulamanın denetim adresi (http://…:PORT)
#
# Ölçülen: Caddy kapıya ne soruyor (gövdesiz GET, özgün adres), kapının yanıtına göre ne yapıyor ve uygulamaya kaç bayt
# GÖVDE iletiyor. İzinsiz hiçbir büyük gövdenin tek baytı uygulamaya ulaşmamalıdır. Dış istek yok.
set -Eeuo pipefail

SITE=$1
CONTROL=$2
LABEL=$3
RESULTS=$4
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
trap 'echo "✘ [$LABEL] satır $LINENO: $BASH_COMMAND" | tee -a "$RESULTS"; echo "--- son kayıt"; curl -fsS "$CONTROL/kayit" | head -c 1500 || true; echo' ERR

MB40=40000000
note() { echo "[$LABEL] $*" | tee -a "$RESULTS"; }
mode() { curl -fsS -X POST "$CONTROL/mod/$1" >/dev/null; }
# Sahte uygulamanın kaydından bir değer (jq ifadesi)
seen() { curl -fsS "$CONTROL/kayit" | jq -r "$1"; }
GATES='[.istekler[] | select(.kapi)] | length'
APPS='[.istekler[] | select(.kapi | not)] | length'
BODY='[.istekler[] | select(.kapi | not) | .bayt] | add // 0'
GATE_BODY='[.istekler[] | select(.kapi) | .bayt] | add // 0'
file() { # file BAYT → dosya yolu (seyrek dosya: diskte yer tutmaz)
  local f="$T/govde-$1"
  [ -f "$f" ] || truncate -s "$1" "$f"
  echo "$f"
}
CODE=''
UP=''
# send YOL BAYT [curl seçenekleri…] — çok parçalı form (tarayıcının dosyalı formu gibi); CODE = durum, UP = curl'ün yolladığı bayt
send() {
  local path=$1 bytes=$2 out
  shift 2
  out=$(curl -sk -o "$T/yanit" -w '%{http_code} %{size_upload}' --max-time 60 -X POST -F "dosya=@$(file "$bytes");type=application/octet-stream" "$@" "$SITE$path" || true)
  CODE=${out%% *}
  UP=${out##* }
}
# raw YOL BAYT [curl seçenekleri…] — gövde tam BAYT uzunluğunda (Content-Length = BAYT)
raw() {
  local path=$1 bytes=$2 out
  shift 2
  out=$(curl -sk -o "$T/yanit" -w '%{http_code} %{size_upload}' --max-time 60 -X POST -H 'Content-Type: application/octet-stream' --data-binary "@$(file "$bytes")" "$@" "$SITE$path" || true)
  CODE=${out%% *}
  UP=${out##* }
}
# stream YOL BAYT [curl seçenekleri…] — boyu BİLDİRİLMEYEN gövde (HTTP/1.1: chunked; HTTP/2: Content-Length yok)
stream() {
  local path=$1 bytes=$2 out
  shift 2
  out=$(head -c "$bytes" /dev/zero | curl -sk -o "$T/yanit" -w '%{http_code} %{size_upload}' --max-time 60 -X POST -H 'Content-Type: application/octet-stream' -T - "$@" "$SITE$path" || true)
  CODE=${out%% *}
  UP=${out##* }
}
# Uygulamaya hiçbir şey iletilmedi: kapı dışında istek yok, gövde baytı yok; kapı isteği de gövdesiz
nothing_forwarded() {
  [ "$(seen "$APPS")" = 0 ]
  [ "$(seen "$BODY")" = 0 ]
  [ "$(seen "$GATE_BODY")" = 0 ]
}
# Sınır aşıldı: istek başarıyla bitmedi, uygulamaya en çok SINIR bayt iletildi ve uygulama isteği TAMAMLANMIŞ görmedi.
# Ölçüt bayttır, durum kodu değil: kod Caddy sürümüne (güncel 413, 2.6 → 502) ve bağlantının kesildiği ana göre değişir
# (yanıt okunamadan bağlantı kapanırsa curl 000 / 100 görür). Gerçek kurulumdaki (güncel Caddy) 413: body-limits.sh.
cut_off() { # cut_off SINIR
  case $CODE in 2?? | 3??) return 1 ;; esac
  [ "$(seen "$BODY")" -le "$1" ]
  [ "$(seen '[.istekler[] | select((.kapi | not) and .bitti)] | length')" = 0 ]
}
# Kapıya tam bir kez, gövdesiz GET ile, özgün adres ve yöntemle soruldu
asked_once() { # asked_once ÖZGÜN_ADRES
  [ "$(seen "$GATES")" = 1 ]
  [ "$(seen '[.istekler[] | select(.kapi)][0] | "\(.yontem) \(.yol) \(.ozgunYontem) \(.ozgunAdres) \(.bayt) \(.aktarim) \(.expect)"')" = "GET /oturum/govde-izni POST $1 0 null null" ]
  # Kapı isteğinde gövde bildirimi de yok (Content-Length yok ya da 0)
  case $(seen '[.istekler[] | select(.kapi)][0].boy') in null | 0) ;; *) return 1 ;; esac
}

note "Caddy: $(curl -sk -o /dev/null -w 'HTTP/%{http_version}' "$SITE/login") üzerinden denendi"

# ---------- A. Kapı "izin yok" diyor ----------
mode ret
send /siparisler/yeni $MB40
[ "$CODE" = 401 ]; asked_once /siparisler/yeni; nothing_forwarded
note "izinsiz 40 MB POST /siparisler/yeni (HTTP/2) → $CODE · uygulamaya iletilen gövde $(seen "$BODY") bayt · kapıya gövdesiz 1 GET · curl 40.000.000 baytın $UP baytını yollayabildi"

mode ret
send '/siparisler/yeni?tip=GLASS_ORDER' $MB40 --http1.1
[ "$CODE" = 401 ]; asked_once '/siparisler/yeni?tip=GLASS_ORDER'; nothing_forwarded
note "izinsiz 40 MB POST (HTTP/1.1, sorgulu adres) → $CODE · uygulamaya 0 bayt · curl $UP bayt yollayabildi"

mode ret
send /siparisler/yeni $MB40 --http1.1 -H 'Expect: 100-continue'
[ "$CODE" = 401 ]; asked_once /siparisler/yeni; nothing_forwarded
note "izinsiz 40 MB POST (HTTP/1.1, Expect: 100-continue) → $CODE · uygulamaya 0 bayt · curl $UP bayt yolladı"

mode ret
stream /siparisler/cmabc 20000000
[ "$CODE" = 401 ]; [ "$(seen "$GATES")" = 1 ]; nothing_forwarded
mode ret
stream /siparisler/cmabc 20000000 --http1.1
[ "$CODE" = 401 ]; [ "$(seen "$GATES")" = 1 ]; nothing_forwarded
note "izinsiz, boyu bildirilmeyen 20 MB gövde (HTTP/2 ve HTTP/1.1 chunked) → 401 · uygulamaya 0 bayt"

mode ret
send /depo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf $MB40
[ "$CODE" = 401 ]; asked_once /depo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf; nothing_forwarded
mode ret
send /admin/katalog 5300000
[ "$CODE" = 401 ]; asked_once /admin/katalog; nothing_forwarded
note "izinsiz 40 MB POST /depo/<anahtar> ve 5,3 MB POST /admin/katalog → 401 · uygulamaya 0 bayt"

# Öteki yöntemler (PUT / DELETE / PATCH) de kapıdan geçer
for m in PUT DELETE PATCH; do
  mode ret
  send /siparisler/cmabc $MB40 -X "$m"
  [ "$CODE" = 401 ]; [ "$(seen "$GATES")" = 1 ]; nothing_forwarded
done
note "izinsiz 40 MB PUT / DELETE / PATCH → 401 · uygulamaya 0 bayt"

# İstemcinin yazdığı başlıklar kapıyı yanıltamaz: özgün adres ve yöntem Caddy'den gelir; "izin" başlığı istekte işe yaramaz
mode ret
send /siparisler/yeni $MB40 -H 'X-Forwarded-Uri: /depo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf' -H 'X-Forwarded-Method: GET' -H 'X-Takip-Govde: izin' -H 'CF-Connecting-IP: 203.0.113.9' -H 'X-Real-IP: 203.0.113.9'
[ "$CODE" = 401 ]; asked_once /siparisler/yeni; nothing_forwarded
[ "$(seen '[.istekler[] | select(.kapi)][0].sahteIp | length')" = 0 ]
note "sahte X-Forwarded-Uri / X-Forwarded-Method / X-Takip-Govde başlıklarıyla 40 MB POST → 401 (kapıya giden adres Caddy'nin yazdığı gerçek adres)"

# Adresin başka yazımları: ya kapıya sorulur ya da olağan 2 MB kademesine düşer — büyük gövde hiçbir yazımla iletilmez
for p in /SIPARISLER/yeni /Depo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf //siparisler/yeni /siparisler//yeni /%73iparisler/yeni /siparisler/%2e%2e/siparisler/yeni /x/../siparisler/yeni '/siparisler/yeni/' '/siparisler/yeni;x=1' /ADMIN/Katalog; do
  mode ret
  send "$p" $MB40 --path-as-is
  [ "$CODE" != 200 ]
  [ "$(seen "$BODY")" -le 2000000 ]
  echo "  $p → $CODE · kapı $(seen "$GATES") · uygulamaya $(seen "$BODY") bayt" >>"$T/yazimlar"
done
note "adresin 10 farklı yazımı (büyük harf, çift eğik çizgi, %-kodlama, .. parçaları) izinsiz 40 MB ile → hiçbiri geçmedi, uygulamaya en çok $(sort -t' ' -k7 -n "$T/yazimlar" | awk '{ if ($(NF-1) > m) m = $(NF-1) } END { print m + 0 }') bayt (olağan 2 MB kademesi)"

# Kapının adresi dışarıya kapalı: istek uygulamaya hiç gitmez
mode izin
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/oturum/govde-izni")" = 404 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Uri: /siparisler/yeni' "$SITE/oturum/govde-izni")" = 404 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/oturum/govde-izni/x")" = 404 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/OTURUM/Govde-Izni")" = 404 ]
send /oturum/govde-izni 1000000
[ "$CODE" = 404 ]
[ "$(seen '.istekler | length')" = 0 ]
note "kapının adresi (/oturum/govde-izni) dışarıdan → 404 (GET ve POST; uygulamaya hiçbir istek gitmedi)"

# Küçük gövdeler ve GET kapıya hiç sorulmaz (kapı "izin yok" dese de çalışır): olağan 2 MB kademesi
mode ret
send /siparisler/cmabc 100000
[ "$CODE" = 200 ]; [ "$(seen "$GATES")" = 0 ]; [ "$(seen "$APPS")" = 1 ]
mode ret
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/siparisler/yeni")" = 200 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' -I "$SITE/siparisler/cmabc")" = 200 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/depo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf")" = 200 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/admin/katalog")" = 200 ]
[ "$(seen "$GATES")" = 0 ]
note "küçük gövde (100 KB POST) ve GET / HEAD yükleme sayfalarında → kapıya sorulmadan geçti"

# Sınır: bildirilen boy 2.000.000 → kapısız (olağan kademe); 2.000.001 → kapı
mode ret
raw /siparisler/cmabc 2000000
[ "$CODE" = 200 ]; [ "$(seen "$GATES")" = 0 ]; [ "$(seen "$BODY")" = 2000000 ]
mode ret
raw /siparisler/cmabc 2000001
[ "$CODE" = 401 ]; [ "$(seen "$GATES")" = 1 ]; nothing_forwarded
mode ret
raw /admin/stok 2000001
[ "$CODE" = 401 ]; [ "$(seen "$GATES")" = 1 ]; nothing_forwarded
note "sınır: Content-Length 2.000.000 → kapısız geçti (2.000.000 bayt iletildi); 2.000.001 → kapı, 401, 0 bayt"

# Büyük gövdeli GET kapıya sorulmaz ama olağan 2 MB sınırındadır
mode izin
send /siparisler/yeni $MB40 -X GET
cut_off 2000000; [ "$(seen "$GATES")" = 0 ]
note "40 MB gövdeli GET /siparisler/yeni → kesildi ($CODE; olağan 2 MB kademesi, kapı izni aranmaz)"

# Yükleme sayfası olmayan adresler: kapı izin verse de 2 MB (kapıya sorulmaz)
mode izin
for p in /login /setup /siparisler /yuklemeler /admin/users /depo; do
  mode izin
  send "$p" 2500000
  cut_off 2000000; [ "$(seen "$GATES")" = 0 ]; c1=$CODE
done
mode izin
send /login 1500000
[ "$CODE" = 200 ]; [ "$(seen "$GATES")" = 0 ]
note "olağan adresler (/login, /setup, /siparisler, /yuklemeler, /admin/users, /depo): 2,5 MB kesildi ($c1), 1,5 MB geçer; kapıya sorulmaz"

# ---------- B. Kapı izin veriyor ----------
mode izin
send /siparisler/yeni $MB40
[ "$CODE" = 200 ]; asked_once /siparisler/yeni
[ "$(seen "$APPS")" = 1 ]
[ "$(seen '[.istekler[] | select(.kapi | not)][0] | "\(.yontem) \(.yol) \(.bitti)"')" = "POST /siparisler/yeni true" ]
[ "$(seen "$BODY")" -ge $MB40 ]
[ "$(cat "$T/yanit")" = "govde $(seen "$BODY")" ]
note "izinli 40 MB POST /siparisler/yeni → $CODE · uygulamaya $(seen "$BODY") bayt iletildi (kapıya 1 gövdesiz GET, sonra özgün POST)"

mode izin
send /siparisler/cmabc $MB40 --http1.1
[ "$CODE" = 200 ]; [ "$(seen "$BODY")" -ge $MB40 ]
mode izin
stream /siparisler/cmabc 20000000
[ "$CODE" = 200 ]; [ "$(seen "$BODY")" = 20000000 ]
mode izin
stream /siparisler/cmabc 20000000 --http1.1
[ "$CODE" = 200 ]; [ "$(seen "$BODY")" = 20000000 ]
mode izin
send /depo/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf 21000000
[ "$CODE" = 200 ]; [ "$(seen "$BODY")" -ge 21000000 ]
note "izinli: HTTP/1.1 40 MB, boyu bildirilmeyen 20 MB (iki protokol), /depo 21 MB → 200, gövdenin tamamı iletildi"

# İzin, kademenin sınırını kaldırmaz
mode izin
send /admin/katalog 5300000
[ "$CODE" = 200 ]; [ "$(seen "$BODY")" -ge 5300000 ]
mode izin
send /admin/katalog 6500000
cut_off 6000000; c1=$CODE
mode izin
send /siparisler/yeni 261000000
cut_off 260000000; c2=$CODE
mode izin
stream /siparisler/yeni 261000000 --http1.1
cut_off 260000000
note "izinli olsa da kademe sınırı geçerli: yönetim Excel 5,3 MB geçer / 6,5 MB kesildi ($c1, en çok 6.000.000 bayt iletildi); yükleme sayfası 261 MB kesildi ($c2, en çok 260.000.000 bayt; bildirilen ve bildirilmeyen boy)"

# ---------- C. Karar isteğe göre: çerez kapıya ulaşır ----------
mode cerez
send /siparisler/yeni 5000000 -b 'takip_session=gecerli'
[ "$CODE" = 200 ]; [ "$(seen "$BODY")" -ge 5000000 ]
send /siparisler/yeni 5000000 -b 'takip_session=baska'
[ "$CODE" = 401 ]
send /siparisler/yeni 5000000
[ "$CODE" = 401 ]
[ "$(seen "$APPS")" = 1 ]
[ "$(seen "$GATES")" = 3 ]
note "çerez kapıya aynen ulaşır: geçerli çerezle 5 MB → 200; başka çerezle / çerezsiz → 401 (üç istekten yalnızca biri uygulamaya iletildi)"

# ---------- D. Kapalı tarafa düşme: bozuk / hatalı / gelmeyen kapı yanıtı ----------
for m in basliksiz yanlis-deger iki-yuz yonlendirme hata bulunamadi; do
  mode "$m"
  send /siparisler/yeni $MB40
  [ "$CODE" = 401 ]; [ "$(seen "$GATES")" = 1 ]; nothing_forwarded
  mode "$m"
  send /admin/katalog 5300000 --http1.1
  [ "$CODE" = 401 ]; nothing_forwarded
done
note "bozuk kapı yanıtları (204 başlıksız, yanlış başlık değeri, 200 + başlık, 302, 500, 404) → hepsi 401 · uygulamaya 0 bayt"

mode kopar
send /siparisler/yeni $MB40
[ "$CODE" = 502 ]; nothing_forwarded
note "kapı bağlantıyı koparırsa → $CODE · uygulamaya 0 bayt"

mode as
t0=$(date +%s)
send /siparisler/yeni $MB40
t1=$(date +%s)
[ "$CODE" = 502 ] || [ "$CODE" = 504 ]
nothing_forwarded
[ $((t1 - t0)) -ge 8 ] && [ $((t1 - t0)) -le 25 ]
note "kapı yanıt vermezse (zaman aşımı) → $CODE, $((t1 - t0)) sn sonra · uygulamaya 0 bayt"
mode ret
