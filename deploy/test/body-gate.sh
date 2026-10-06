#!/usr/bin/env bash
# Gövde kapısı (güvenlik denetimi AUD-4, karar 143) — gerçek Caddy ile denenir. .github/workflows/deploy-test.yml çalıştırır;
# kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi). GERÇEK SUNUCUDA ÇALIŞTIRILMAZ.
#
#   A. GERÇEK KURULUM (gerçek Caddy + gerçek uygulama + gerçek veritabanı):
#      - giriş yapmamış istemcinin büyük gövdesi 401 ile reddedilir ve uygulama kapsayıcısına ULAŞMAZ (kapsayıcının ağdan
#        aldığı bayt sayısıyla ölçülür); geçerli oturumla aynı gövde uygulamaya ulaşır
#      - boşta kalmış / süresi dolmuş / pasif kullanıcıya ait / uydurma oturum reddedilir; kapı hiçbir kaydı değiştirmez
#      - geçerli depo bağlantısı oturumsuz geçer; geçersiz / süresi dolmuş bağlantı geçmez
#      - gerçek yüklemeler çalışır: sipariş dosyası (oturum), depo teslim belgesi (bağlantı), yönetim Excel ön izlemesi
#      - kapının adresi dışarıya kapalıdır; adresin kendisi yalnızca GET'tir ve gövde okumaz
#   B. SAHTE UYGULAMA + GERÇEK CADDY (2.6.4, 2.7.6, 2.8.4 ve güncel "caddy:2"; depodaki Caddyfile):
#      Caddy'nin kapıya ne sorduğu ve uygulamaya kaç bayt gövde ilettiği doğrudan ölçülür (deploy/test/body-gate-matrix.sh);
#      bozuk / hatalı / gelmeyen kapı yanıtında ve uygulama kapalıyken kapalı tarafa düşer.
#
# Deneme verisi rastgele oturum / depo anahtarlarıdır; günlüğe ve notlara yazılmaz (çerez dosyasından okunur). Dış istek
# yok (yalnızca https://localhost ve yerel kapsayıcılar); e-posta, FGO, çeviri, kur isteği doğmaz.
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

SITE=${SITE:-https://localhost}
HOST=${SITE#https://}
ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
HERE=$(cd "$(dirname "$0")" && pwd)
compose() { sudo docker compose -p takip --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
sql() { compose exec -T db psql -U takip -d takip -Atc "$1"; }
T=$(mktemp -d)
RESULTS="$T/sonuclar.txt"
: >"$RESULTS"
NET=takip-kapi-test
MOCK=takip-kapi-sahte
EDGE=takip-kapi-caddy
MOCK_SITE=https://localhost:18443
MOCK_CONTROL=http://127.0.0.1:13001

# Günlük satırlarında depo anahtarı (adresin parçası) görünmesin
scrub() { sed -E 's#/depo/[A-Za-z0-9_%-]+#/depo/…#g'; }
cleanup() {
  if [ -n "${WORKER_ID:-}" ]; then sudo docker unpause "$WORKER_ID" >/dev/null 2>&1 || true; fi
  sudo docker rm -f "$EDGE" "$MOCK" >/dev/null 2>&1 || true
  sudo docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$T"
}
diag() { # diag SATIR ÇIKIŞ KOMUT
  trap - ERR
  set +e
  {
    echo "satır $1 (çıkış $2): $(echo "$3" | scrub | cut -c1-300)"
    echo "--- sonuçlar"; tail -n 30 "$RESULTS"
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}'
    echo "--- caddy günlüğü"; compose logs --no-log-prefix --tail 6 caddy | scrub | cut -c1-400
    echo "--- uygulama günlüğü"; compose logs --no-log-prefix --tail 8 app | scrub | cut -c1-400
    if [ -f "$T/surum.txt" ]; then echo "--- sürüm denemesi"; tail -n 8 "$T/surum.txt"; fi
    echo "--- deneme caddy'si"; sudo docker logs --tail 5 "$EDGE" 2>&1 | scrub | cut -c1-400
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=Gövde kapısı testi::/'
  cleanup
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR
trap cleanup EXIT
note() { echo "$*" | tee -a "$RESULTS"; }
publish() { # publish BAŞLIK DOSYA
  echo "::notice title=$1::$(sed 's/%/%25/g' "$2" | sed ':a;N;$!ba;s/\n/%0A/g')"
}

# ====================================================================================================================
# A. GERÇEK KURULUM
# ====================================================================================================================
sudo cmp -s deploy/Caddyfile /opt/takip/src/deploy/Caddyfile
[ "$(compose ps --status running --services | grep -cx caddy)" = 1 ]
curl -fsSk "$SITE/login" | grep -q 'GKH Digital'
APP_ID=$(compose ps -q app | head -n 1)
WORKER_ID=$(compose ps -q worker | head -n 1)
note "gerçek kurulum: $(compose exec -T caddy caddy version | cut -d' ' -f1) + uygulama $(curl -fsSk "$SITE/surum" | jq -r '"\(.version) (\(.build))"')"

# Deneme verisi (çalışan işçi kapsayıcısında, uygulamanın kendi modülleriyle); anahtarlar yalnızca $T altındaki dosyalarda
cat "$HERE/body-gate-fixtures.mjs" | sudo docker exec -i -u 1001:1001 -e TAKIP_TEST_FIXTURES=1 "$WORKER_ID" node --input-type=module - | tail -n 1 >"$T/veri.json"
jq -e '.valid.token and .depot.token' "$T/veri.json" >/dev/null
f() { jq -r ".$1" "$T/veri.json"; }
# jar AD → o oturumun çerez dosyası (curl -b); anahtar komut satırına / günlüğe yazılmaz
jar() {
  local file="$T/cerez-$1"
  [ -f "$file" ] || printf '%s\tFALSE\t/\tTRUE\t0\ttakip_session\t%s\n' "$HOST" "$(f "$1.token")" >"$file"
  echo "$file"
}
printf '%s\tFALSE\t/\tTRUE\t0\ttakip_session\t%s\n' "$HOST" "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" >"$T/cerez-uydurma"
RANDOM_DEPOT=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')

file() { # file BAYT → dosya yolu (seyrek dosya)
  local p="$T/govde-$1"
  [ -f "$p" ] || truncate -s "$1" "$p"
  echo "$p"
}
CODE=''
UP=''
# post YOL BAYT [curl seçenekleri…] — BAYT büyüklüğünde tek dosyalı çok parçalı POST; CODE = durum, UP = curl'ün yolladığı bayt
post() {
  local path=$1 bytes=$2 out
  shift 2
  out=$(curl -sk -o /dev/null -w '%{http_code} %{size_upload}' --max-time 180 -X POST -F "dosya=@$(file "$bytes");type=application/octet-stream" "$@" "$SITE$path" || true)
  CODE=${out%% *}
  UP=${out##* }
}
# Uygulama kapsayıcısının ağdan aldığı toplam bayt (Caddy'nin ilettiği gövde buradan görünür)
rx() { sudo docker exec "$APP_ID" cat /sys/class/net/eth0/statistics/rx_bytes; }
# İsteği vekil değil uygulama yanıtladı: kapı reddi (401), boyut reddi (413), bağlantı / vekil hatası (000 / 502 / 504) değil
by_app() { case $CODE in 401 | 413 | 000 | 502 | 504) return 1 ;; esac; }
# Kapının hiçbir kaydı değiştirmediğini görmek için: oturumlar (son etkinlik anlarıyla), hatalı deneme ve denetim kaydı sayıları
state() {
  sql 'select id, "lastSeenAt", "expiresAt" from "Session" order by id; select count(*) from "AuthFailure"; select count(*) from "AuditLog"; select count(*) from "OrderFile"; select count(*) from "OrderEvent"'
}

# ---------- A1. Kapının adresi: dışarıya kapalı; kendisi yalnızca GET, gövde okumaz ----------
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$SITE/oturum/govde-izni")" = 404 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' -b "$(jar valid)" -H 'X-Forwarded-Uri: /siparisler/yeni' "$SITE/oturum/govde-izni")" = 404 ]
[ "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -b "$(jar valid)" "$SITE/oturum/govde-izni")" = 404 ]
note "kapının adresi dışarıdan (geçerli oturumla bile) → 404"
# Uygulamaya doğrudan (Caddy'siz, kapsayıcının içinden): direct YÖNTEM ADRES [GÖVDE_BAYT] < anahtar → "durum başlık yanıt-boyu"
direct() {
  sudo docker exec -i -e M="$1" -e U="${2:-}" -e B="${3:-0}" "$APP_ID" node -e '
    let c = "";
    process.stdin.on("data", (d) => { c += d; }).on("end", async () => {
      const headers = {};
      if (process.env.U) headers["x-forwarded-uri"] = process.env.U;
      if (c.trim()) headers.cookie = "takip_session=" + c.trim();
      const n = Number(process.env.B);
      const r = await fetch("http://127.0.0.1:3000/oturum/govde-izni", { method: process.env.M, headers, body: n ? "x".repeat(n) : undefined });
      console.log(r.status, r.headers.get("x-takip-govde") || "-", (await r.text()).length, r.headers.get("cache-control") || "-");
    });'
}
[ "$(f valid.token | direct GET /siparisler/yeni)" = "204 izin 0 no-store" ]
[ "$(f valid.token | direct GET '/siparisler/yeni?tip=GLASS_ORDER')" = "204 izin 0 no-store" ]
[ "$(f valid.token | direct GET /admin/katalog)" = "204 izin 0 no-store" ]
[ "$(f valid.token | direct HEAD /siparisler/yeni)" = "204 izin 0 no-store" ]
[ "$(echo | direct GET /siparisler/yeni)" = "401 - 0 no-store" ]
[ "$(f valid.token | direct GET '')" = "401 - 0 no-store" ]
[ "$(f valid.token | direct GET /login)" = "401 - 0 no-store" ]
[ "$(f valid.token | direct GET /SIPARISLER/yeni)" = "401 - 0 no-store" ]
[ "$(f idle.token | direct GET /siparisler/yeni)" = "401 - 0 no-store" ]
[ "$(f expired.token | direct GET /siparisler/yeni)" = "401 - 0 no-store" ]
[ "$(f inactive.token | direct GET /siparisler/yeni)" = "401 - 0 no-store" ]
[ "$(echo | direct GET "/depo/$(f depot.token)")" = "204 izin 0 no-store" ]
[ "$(echo | direct GET "/depo/$(f depotExpired.token)")" = "401 - 0 no-store" ]
[ "$(echo | direct GET "/depo/$RANDOM_DEPOT")" = "401 - 0 no-store" ]
[ "$(f valid.token | direct GET "/depo/$RANDOM_DEPOT")" = "401 - 0 no-store" ]
[ "$(echo | direct GET "/siparisler/$(f depot.token)")" = "401 - 0 no-store" ]
for m in POST PUT PATCH DELETE; do
  [ "$(f valid.token | direct "$m" /siparisler/yeni 3000000 | cut -d' ' -f1,2)" = "405 -" ]
done
note "kapının adresi (uygulamada, doğrudan): geçerli oturum / geçerli depo bağlantısı → 204 + izin; oturumsuz, boşta, süresi dolmuş, pasif kullanıcı, bilinmeyen adres, geçersiz / süresi dolmuş bağlantı → 401; POST / PUT / PATCH / DELETE (3 MB gövdeyle) → 405"

# "Kapı hiçbir kaydı değiştirmedi" karşılaştırması boyunca arka plan işçisi duraklatılır: işçi saatte bir geçersiz oturum
# satırlarını siler (olağan temizlik); o tur tam bu aralığa denk gelirse karşılaştırma yanıltıcı olurdu.
sudo docker pause "$WORKER_ID" >/dev/null
before=$(state)

# ---------- A2. Giriş yapmamış istemci: büyük gövde uygulamaya ulaşmaz ----------
r0=$(rx)
post /siparisler/yeni 100000000
r1=$(rx)
[ "$CODE" = 401 ]
[ $((r1 - r0)) -lt 1000000 ]
note "oturumsuz 100 MB POST /siparisler/yeni → $CODE · uygulama kapsayıcısına ulaşan: $((r1 - r0)) bayt (kapının sorusu ve yanıtı dahil) · curl 100.000.000 baytın $UP baytını yollayabildi"
r0=$(rx)
post "/siparisler/$(f glassId)" 100000000 --http1.1
r1=$(rx)
[ "$CODE" = 401 ]
[ $((r1 - r0)) -lt 1000000 ]
note "oturumsuz 100 MB POST /siparisler/<sipariş> (HTTP/1.1) → $CODE · uygulamaya ulaşan: $((r1 - r0)) bayt · curl $UP bayt yollayabildi"
# Var olan ve olmayan sipariş aynı yanıtı alır (kapı siparişe bakmaz: var mı yok mu belli olmaz)
post /siparisler/cmyoksiparis0000000000000 40000000
[ "$CODE" = 401 ]
post /admin/katalog 5300000
[ "$CODE" = 401 ]
post /admin/stok 5300000
[ "$CODE" = 401 ]
note "oturumsuz: var olmayan sipariş adresi 40 MB → 401 (var olanla aynı); yönetim Excel sayfaları 5,3 MB → 401"

# ---------- A3. Geçerli oturum: aynı gövde uygulamaya ulaşır ----------
r0=$(rx)
post /siparisler/yeni 40000000 -b "$(jar valid)"
r1=$(rx)
by_app
# Olağan kademenin (2 MB) geçirebileceğinden fazlası uygulamaya ulaştı: büyük kademe bu oturuma açıldı
[ $((r1 - r0)) -gt 2000000 ]
note "geçerli oturumla aynı türden 40 MB POST /siparisler/yeni → $CODE (yanıtı uygulama verdi) · uygulama kapsayıcısına ulaşan: $((r1 - r0)) bayt"
post /admin/katalog 5300000 -b "$(jar valid)"
by_app
post /admin/katalog 6500000 -b "$(jar valid)"
[ "$CODE" = 413 ]
note "geçerli oturumla yönetim Excel: 5,3 MB uygulamaya ulaşır; 6,5 MB → 413 (kapı kademe sınırını kaldırmaz)"

# ---------- A4. Geçersiz oturumlar ----------
for s in idle expired inactive uydurma; do
  r0=$(rx)
  post /siparisler/yeni 40000000 -b "$(jar "$s")"
  r1=$(rx)
  [ "$CODE" = 401 ]
  [ $((r1 - r0)) -lt 1000000 ]
done
note "31 dakikadır etkinliksiz, mutlak süresi dolmuş, pasif kullanıcıya ait ve uydurma oturumla 40 MB POST → hepsi 401 · uygulamaya gövde ulaşmadı"

# ---------- A5. Depo bağlantısı ----------
r0=$(rx)
post "/depo/$(f depot.token)" 21000000
r1=$(rx)
by_app
[ $((r1 - r0)) -gt 2000000 ]
c_valid=$CODE
d_valid=$((r1 - r0))
r0=$(rx)
post "/depo/$RANDOM_DEPOT" 100000000
r1=$(rx)
[ "$CODE" = 401 ]
[ $((r1 - r0)) -lt 1000000 ]
d_invalid=$((r1 - r0))
post "/depo/$(f depotExpired.token)" 40000000
[ "$CODE" = 401 ]
post /depo/kisa 40000000
[ "$CODE" = 401 ]
# Geçerli oturum, geçersiz bağlantının yerini tutmaz; geçerli bağlantı başka adreste işe yaramaz
post "/depo/$RANDOM_DEPOT" 40000000 -b "$(jar valid)"
[ "$CODE" = 401 ]
post "/siparisler/$(f depot.token)" 40000000
[ "$CODE" = 401 ]
note "depo bağlantısı: geçerli bağlantı (oturumsuz) 21 MB → $c_valid, uygulamaya $d_valid bayt ulaştı; uydurma bağlantı 100 MB → 401 (uygulamaya $d_invalid bayt); süresi dolmuş / biçimsiz bağlantı → 401; oturum bağlantının, bağlantı oturumun yerini tutmaz"

# ---------- A6. Kapı hiçbir kaydı değiştirmedi ----------
after=$(state)
[ "$before" = "$after" ]
[ "$(sql "select count(*) from \"Session\" where id in ('$(f valid.id)', '$(f idle.id)', '$(f expired.id)', '$(f inactive.id)')")" = 4 ]
sudo docker unpause "$WORKER_ID" >/dev/null
note "kapı salt okunur: $(echo "$before" | grep -c '|') oturum satırı (boşta / süresi dolmuş olanlar dahil) aynen duruyor, son etkinlik anları değişmedi; hatalı deneme, denetim kaydı, dosya ve sipariş olayı sayıları aynı"

# ---------- A7. Küçük gövdeler kapıya sorulmaz (oturumsuz küçük POST'u uygulama yanıtlar) ----------
post /siparisler/yeni 100000
by_app
post "/depo/$RANDOM_DEPOT" 100000
by_app
note "küçük gövde (100 KB) yükleme sayfalarında kapıya sorulmadan uygulamaya gider (oturum denetimini uygulama yapar)"

# ---------- A8. Gerçek yüklemeler ----------
# Sayfadaki formun gizli alanları (tarayıcının JavaScript'siz gönderdiği biçim): form_fields HTML DOSYA_ALANI [ATLANACAK_KİMLİK]
form_fields() {
  python3 - "$@" <<'PY'
import sys
from html.parser import HTMLParser

class Forms(HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms, self.cur = [], None
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'form':
            self.cur = {'hidden': [], 'files': []}
        elif tag == 'input' and self.cur is not None:
            if a.get('type') == 'hidden' and a.get('name'):
                self.cur['hidden'].append((a['name'], a.get('value') or ''))
            elif a.get('type') == 'file':
                self.cur['files'].append((a.get('name'), a.get('id')))
    def handle_endtag(self, tag):
        if tag == 'form' and self.cur is not None:
            self.forms.append(self.cur)
            self.cur = None

p = Forms()
p.feed(open(sys.argv[1], encoding='utf-8').read())
skip = sys.argv[3] if len(sys.argv) > 3 else None
for form in p.forms:
    if any(name == sys.argv[2] and ident != skip for name, ident in form['files']):
        for name, value in form['hidden']:
            print(f'{name}={value}')
        break
PY
}
# submit SAYFA HTML DOSYA_ALANI DOSYA TÜR [ATLANACAK_KİMLİK] [curl seçenekleri…] → CODE, başlıklar $T/basliklar, gövde $T/yanit
submit() {
  local page=$1 html=$2 field=$3 upload=$4 mime=$5 skip=$6 args=() line
  shift 6
  form_fields "$html" "$field" "$skip" >"$T/alanlar"
  [ -s "$T/alanlar" ]
  while IFS= read -r line; do args+=(--form-string "$line"); done <"$T/alanlar"
  CODE=$(curl -sk -o "$T/yanit" -D "$T/basliklar" -w '%{http_code}' --max-time 180 -X POST -H "Origin: $SITE" "${args[@]}" -F "$field=@$upload;type=$mime" "$@" "$SITE$page" || true)
}
# 9 MB'lık geçerli bir PDF (içerik denetiminden geçer; varsayılan 2 MB ve yönetim 6 MB sınırlarından büyük)
{ printf '%%PDF-1.4\n%% kapi denemesi\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%%%EOF\n'; head -c 9000000 /dev/zero | tr '\0' ' '; } >"$T/kapi-deneme.pdf"
PDF_SIZE=$(stat -c %s "$T/kapi-deneme.pdf")

# Sipariş dosyası (geçerli oturum → sipariş sayfasındaki "dosya ekle" formu)
order="/siparisler/$(f glassId)"
curl -fsSk -b "$(jar valid)" "$SITE$order" -o "$T/siparis.html"
r0=$(rx)
submit "$order" "$T/siparis.html" files "$T/kapi-deneme.pdf" application/pdf drawing-file -b "$(jar valid)"
r1=$(rx)
[ "$CODE" = 303 ]
[ $((r1 - r0)) -ge "$PDF_SIZE" ]
grep -i '^location:' "$T/basliklar" | grep -q 'ok=files_added'
[ "$(sql "select size from \"OrderFile\" where \"orderId\" = '$(f glassId)' and name = 'kapi-deneme.pdf'")" = "$PDF_SIZE" ]
note "gerçek yükleme — sipariş dosyası (geçerli oturum, $PDF_SIZE baytlık PDF) → $CODE ok=files_added; dosya kaydı oluştu (tarama: $(sql "select \"scanStatus\" from \"OrderFile\" where \"orderId\" = '$(f glassId)' and name = 'kapi-deneme.pdf'"))"
# Aynı form, aynı dosya, oturumsuz: kapıda biter, kayıt oluşmaz
r0=$(rx)
submit "$order" "$T/siparis.html" files "$T/kapi-deneme.pdf" application/pdf drawing-file
r1=$(rx)
[ "$CODE" = 401 ]
[ $((r1 - r0)) -lt 1000000 ]
[ "$(sql "select count(*) from \"OrderFile\" where \"orderId\" = '$(f glassId)'")" = 1 ]
note "aynı form oturumsuz gönderilirse → 401, dosya kaydı oluşmaz"

# Depo teslim belgesi (oturum yok; geçerli bağlantı → depo sayfasındaki form; sipariş teslim edilmiş: yalnızca ek belge eklenir)
depot="/depo/$(f depot.token)"
curl -fsSk "$SITE$depot" -o "$T/depo.html"
submit "$depot" "$T/depo.html" files "$T/kapi-deneme.pdf" application/pdf ''
[ "$CODE" = 303 ]
grep -i '^location:' "$T/basliklar" | grep -q 'ok=added'
[ "$(sql "select size from \"OrderFile\" where \"orderId\" = '$(f depot.orderId)' and source = 'DEPOT_LINK'")" = "$PDF_SIZE" ]
note "gerçek yükleme — depo teslim belgesi (oturumsuz, geçerli bağlantı, $PDF_SIZE baytlık PDF) → $CODE ok=added; dosya kaydı oluştu"

# Yönetim Excel ön izlemesi (geçerli yönetici oturumu; 3 MB'lık gerçek katalog dosyası → 2 MB'ı aşar, kapıdan ve 6 MB kademesinden geçer)
cp test/fixtures/cam-katalogu.xlsx "$T/kapi-katalog.xlsx"
python3 - "$T/kapi-katalog.xlsx" <<'PY'
import sys, zipfile
# Geçerli bir .xlsx'e, okunmayan 3 MB'lık bir parça eklenir (dosya büyür, içerik aynı kalır)
with zipfile.ZipFile(sys.argv[1], 'a') as z:
    z.writestr(zipfile.ZipInfo('dolgu/dolgu.bin'), b'\0' * 3_000_000, compress_type=zipfile.ZIP_STORED)
PY
[ "$(stat -c %s "$T/kapi-katalog.xlsx")" -gt 3000000 ]
glass_before=$(sql 'select count(*) from "GlassProduct"')
curl -fsSk -b "$(jar valid)" "$SITE/admin/katalog" -o "$T/katalog.html"
submit /admin/katalog "$T/katalog.html" file "$T/kapi-katalog.xlsx" application/vnd.openxmlformats-officedocument.spreadsheetml.sheet '' -b "$(jar valid)"
[ "$CODE" = 200 ]
grep -q 'kapi-katalog.xlsx' "$T/yanit"
[ "$(sql 'select count(*) from "GlassProduct"')" = "$glass_before" ]
note "gerçek yükleme — yönetim Excel ön izlemesi (geçerli yönetici oturumu, $(stat -c %s "$T/kapi-katalog.xlsx") baytlık .xlsx) → $CODE, dosya okundu ve ön izleme geldi (katalog değişmedi)"
submit /admin/katalog "$T/katalog.html" file "$T/kapi-katalog.xlsx" application/vnd.openxmlformats-officedocument.spreadsheetml.sheet ''
[ "$CODE" = 401 ]
note "aynı Excel oturumsuz gönderilirse → 401"

# Deneme oturumları silinir (siparişler ve dosyalar tek kullanımlık test makinesinde kalır)
sql "delete from \"Session\" where \"userAgent\" = 'kapi-testi'" >/dev/null
publish 'Gövde kapısı — gerçek kurulum (Caddy + uygulama)' "$RESULTS"

# ====================================================================================================================
# B. SAHTE UYGULAMA + GERÇEK CADDY SÜRÜMLERİ
# ====================================================================================================================
# Sahte uygulama, çalışan uygulamanın imajındaki node ile çalışır (yeni imaj çekilmez). İmaj adı çalışan kapsayıcıdan okunur:
# yalnızca belge değişen yayında "yayınlanan commit" ilerler ama imaj derlenmez (o commit adına imaj yoktur).
IMAGE=$(sudo docker inspect -f '{{.Config.Image}}' "$APP_ID")
sudo docker network create "$NET" >/dev/null
# Sahte uygulama: aynı ağda "app" adıyla (Caddyfile'daki app:3000); denetim portu yalnızca yerel makineye açık
# (--no-healthcheck: imajın sağlık denetimi 30 saniyede bir GET /login yollar; sahte uygulamanın saydığı isteklere karışmasın)
sudo docker run -d --name "$MOCK" --no-healthcheck --network "$NET" --network-alias app -p 127.0.0.1:13001:3001 \
  -v "$HERE/body-gate-mock.mjs:/sahte.mjs:ro" --entrypoint node "$IMAGE" /sahte.mjs 3000 3001 >/dev/null
mock_up() {
  for _ in $(seq 1 40); do
    if curl -fsS "$MOCK_CONTROL/kayit" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}
mock_up
for tag in 2.6.4 2.7.6 2.8.4 2; do
  : >"$T/surum.txt"
  sudo docker run -d --name "$EDGE" --network "$NET" -e APP_DOMAIN=localhost -p 127.0.0.1:18443:443 \
    -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "caddy:$tag" >/dev/null
  ready=0
  for _ in $(seq 1 60); do
    if [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$MOCK_SITE/login" || true)" = 200 ]; then ready=1; break; fi
    sleep 0.5
  done
  [ "$ready" = 1 ]
  label="caddy:$tag → $(sudo docker exec "$EDGE" caddy version | cut -d' ' -f1)"
  bash "$HERE/body-gate-matrix.sh" "$MOCK_SITE" "$MOCK_CONTROL" "$label" "$T/surum.txt"
  # Uygulama kapalı: kapıya ulaşılamaz → istek vekil hatasıyla biter (büyük gövde hiçbir yere iletilmez)
  sudo docker stop -t 1 "$MOCK" >/dev/null
  out=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 60 -X POST -F "dosya=@$(file 40000000);type=application/octet-stream" "$MOCK_SITE/siparisler/yeni" || true)
  case $out in 502 | 503 | 504) ;; *) echo "uygulama kapalıyken beklenmeyen yanıt: $out" | tee -a "$T/surum.txt"; false ;; esac
  echo "[$label] uygulama kapalıyken 40 MB POST → $out (kapalı tarafa düştü)" | tee -a "$T/surum.txt"
  sudo docker start "$MOCK" >/dev/null
  mock_up
  if grep -q '^✘' "$T/surum.txt"; then cat "$T/surum.txt"; false; fi
  cat "$T/surum.txt" >>"$RESULTS"
  publish "Gövde kapısı — $label (sahte uygulama, iletilen bayt ölçümü)" "$T/surum.txt"
  sudo docker rm -f "$EDGE" >/dev/null
done
sudo docker rmi caddy:2.6.4 caddy:2.7.6 caddy:2.8.4 >/dev/null 2>&1 || true
echo "gövde kapısı: tüm denemeler geçti ($(wc -l <"$RESULTS") satır)"
