#!/usr/bin/env bash
# İstek gövdesi sınırları (güvenlik denetimi AUD-4, karar 141) — gerçek kurulumda, gerçek Caddy + uygulama ile denenir.
# Büyük kademelerin gövde kapısı (karar 143: oturum / depo bağlantısı olmadan büyük gövde uygulamaya iletilmez): body-gate.sh.
# .github/workflows/deploy-test.yml çalıştırır; kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi).
# GERÇEK SUNUCUDA ÇALIŞTIRILMAZ. Caddyfile değişikliğinin yayınla etkin olması / bozuk Caddyfile'ın yayını durdurması:
# deploy/test/caddy-deploy.sh.
#
# İstekler çok parçalı formdur (multipart): Next böyle bir POST'u olası sunucu işlemi sayıp gövdenin TAMAMINI okur, yani
# vekilin sınırı kesin olarak devreye girer (gövdeyi okumadan yanıt veren bir adreste sonuç yarışa kalırdı). Oturum yok:
# istekler giriş yapmamış bir istemcidendir. Dış istek yok (yalnızca https://localhost).
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

SITE=${SITE:-https://localhost}
ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
compose() { sudo docker compose -p takip --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
T=$(mktemp -d)
RESULTS="$T/sonuclar.txt"
: >"$RESULTS"

diag() { # diag SATIR ÇIKIŞ KOMUT
  trap - ERR
  set +ex
  {
    echo "satır $1 (çıkış $2): $3"
    echo "--- sonuçlar"; cat "$RESULTS" || true
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' || true
    echo "--- caddy günlüğü"; compose logs --no-log-prefix --tail 15 caddy || true
    echo "--- uygulama günlüğü"; compose logs --no-log-prefix --tail 10 app || true
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=Gövde sınırı testi::/'
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR

# post YOL BAYT → HTTP durum kodu (BAYT büyüklüğünde tek dosyalı çok parçalı POST; bağlantı kesilse de kod yazılır)
post() {
  local f="$T/govde-$2"
  [ -f "$f" ] || head -c "$2" /dev/zero >"$f"
  curl -sk -o /dev/null -w '%{http_code}' --max-time 180 -X POST -F "dosya=@$f;type=application/octet-stream" "$SITE$1" || true
}
# Beklenen: vekil reddeder (413)
rejected() {
  local c
  c=$(post "$1" "$2")
  echo "$1 $2 bayt → $c (beklenen 413)" | tee -a "$RESULTS"
  [ "$c" = 413 ]
}
# Beklenen: vekilden geçer — yanıtı uygulama verir (413 / 401 değil; bağlantı hatası 000 ve vekil hatası 502 de değil)
passes() {
  local c
  c=$(post "$1" "$2")
  echo "$1 $2 bayt → $c (vekilden geçmeli)" | tee -a "$RESULTS"
  [ "$c" != 413 ] && [ "$c" != 401 ] && [ "$c" != 000 ] && [ "$c" != 502 ]
}
# Beklenen: gövde kapısı reddeder (401) — oturumsuz istemcinin büyük gövdesi
gated() {
  local c
  c=$(post "$1" "$2")
  echo "$1 $2 bayt → $c (beklenen 401: gövde kapısı)" | tee -a "$RESULTS"
  [ "$c" = 401 ]
}
{
  # 1. Yayındaki Caddyfile depodakiyle aynı ve Caddy çalışıyor
  sudo cmp -s deploy/Caddyfile /opt/takip/src/deploy/Caddyfile
  [ "$(compose ps --status running --services | grep -cx caddy)" = 1 ]
  curl -fsSk "$SITE/login" | grep -q 'GKH Digital'

  # 2. Varsayılan kademe (2 MB = 2.000.000 bayt): giriş ve diğer olağan adresler (kapıya sorulmaz)
  passes /login 100000
  passes /login 1500000
  rejected /login 2500000
  rejected /setup 2500000
  rejected / 2500000
  rejected /siparisler 2500000
  rejected /yuklemeler 2500000
  rejected /admin/users 2500000
  rejected /login 40000000

  # 3. Büyük kademeler (yönetim Excel 6 MB, yükleme sayfaları 260 MB) yalnızca gövde kapısından geçen isteklere açıktır
  # (karar 143). Bu betikteki istekler oturumsuzdur: 2 MB'ı aşan gövde bu sayfalarda kapıda 401 ile biter; sınırın altındaki
  # gövde kapıya sorulmadan olağan kademeden geçer. Oturumla / depo bağlantısıyla geçiş, kademe sınırları (6 MB → 413) ve
  # uygulamaya iletilen bayt ölçümü: deploy/test/body-gate.sh.
  gated /admin/katalog 5300000
  gated /admin/fiyatlar 5300000
  gated /admin/musteri-fiyatlari 5300000
  gated /admin/profil-katalogu 5300000
  gated /admin/stok 5300000
  gated /admin/stok 6500000
  gated /siparisler/yeni 6500000
  gated /siparisler/yeni 40000000
  gated /siparisler/cmyoksiparis0000000000000 6500000
  gated "/depo/$(head -c 43 /dev/zero | tr '\0' x)" 6500000

  # 4. Aynı sayfalarda küçük gövde (≤ 2 MB) kapıya sorulmaz: olağan kademeden uygulamaya gider
  passes /admin/katalog 1500000
  passes /siparisler/yeni 1500000
  passes /siparisler/cmyoksiparis0000000000000 100000
  passes "/depo/$(head -c 43 /dev/zero | tr '\0' x)" 1500000

  # 5. Gerçek bir sunucu işlemi vekilden geçer: giriş formu (tarayıcının JavaScript'siz gönderdiği biçimde — sayfadaki gizli
  # alanlarla, çok parçalı POST /login). Şifre yanlış: giriş reddedilir ama işlem ÇALIŞIR — yanıtı işlemin kendisi üretir
  # (303, /login?…error=invalid adresine yönlendirme).
  curl -fsSk "$SITE/login" -o "$T/login.html"
  python3 - "$T/login.html" >"$T/login.args" <<'PY'
import sys
from html.parser import HTMLParser

class Form(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth, self.fields, self.done = 0, [], False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'form' and not self.done:
            self.depth += 1
        elif tag == 'input' and self.depth and a.get('type') == 'hidden' and a.get('name'):
            self.fields.append((a['name'], a.get('value') or ''))
    def handle_endtag(self, tag):
        if tag == 'form' and self.depth:
            self.depth -= 1
            self.done = True

p = Form()
p.feed(open(sys.argv[1], encoding='utf-8').read())
for name, value in p.fields:
    print(f'{name}={value}')
PY
  [ -s "$T/login.args" ]
  login_args=()
  while IFS= read -r line; do login_args+=(--form-string "$line"); done <"$T/login.args"
  c=$(curl -sk -o /dev/null -D "$T/login-basliklar.txt" -w '%{http_code}' -X POST -H "Origin: $SITE" "${login_args[@]}" \
    --form-string 'email=yonetici@kurulum.test' --form-string 'password=yanlis-sifre-12345' "$SITE/login" || true)
  echo "giriş işlemi (gerçek sunucu işlemi, küçük gövde) → $c $(grep -i '^location:' "$T/login-basliklar.txt" | tr -d '\r' || true) (beklenen 303, error=invalid)" | tee -a "$RESULTS"
  [ "$c" = 303 ]
  grep -i '^location:' "$T/login-basliklar.txt" | grep -q 'error=invalid'

  # 6. Küçük istekler olağan çalışır (sayfa, sürüm, oturum etkinliği)
  curl -fsSk "$SITE/surum" | jq -e '.version != null' >/dev/null
  [ "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "$SITE/oturum/etkinlik" -H 'Content-Type: application/json' -H 'X-Takip-Activity: 1' -H "Origin: $SITE" -d '{"idle":0}')" = 401 ]

  # 7. Caddyfile, Caddy 2'nin eski sürümlerinde de geçerli (sunucudaki "caddy:2" imajı güncel olmayabilir)
  # Üretim ayarında beklenen: siteler tam olarak asıl ad + eski ad; eski adın rotasındaki tek işleyici 308 yönlendirmesi
  LEGACY_REDIRECT='([.apps.http.servers[].routes[] | .match[]?.host[]?] | unique) == ["takip.gkh.ro", "takip.sistembalustrada.ro"]
    and ([.apps.http.servers[].routes[] | select(any(.match[]?; (.host // []) | index("takip.sistembalustrada.ro") != null))
      | .. | objects | select(has("handler") and .handler != "subroute") | "\(.handler) \(.status_code) \(.headers.Location[0]?)"]
      == ["static_response 308 https://takip.gkh.ro{http.request.uri}"])'
  for tag in 2.6.4 2.7.6 2.8.4 2; do
    if ! out=$(sudo docker run --rm -e APP_DOMAIN=localhost -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "caddy:$tag" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
      echo "$out" | tail -n 5
      echo "caddy:$tag Caddyfile'ı kabul etmedi: $(echo "$out" | tail -n 1)" | tee -a "$RESULTS"
      false
    fi
    echo "caddy:$tag → Caddyfile geçerli" | tee -a "$RESULTS"
    # Üretimin ayarı (APP_DOMAIN=takip.gkh.ro; yalnızca "caddy adapt", ağ kapalı — hiçbir yere istek gitmez): iki site vardır
    # ve eski alan adı uygulamaya iletilmez, yolu ve sorgusu korunarak 308 ile asıl ada yönlenir (karar 154)
    if ! prod=$(sudo docker run --rm --network none -e APP_DOMAIN=takip.gkh.ro -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "caddy:$tag" \
      caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>"$T/adapt-hata.txt") || ! echo "$prod" | jq -e "$LEGACY_REDIRECT" >/dev/null; then
      echo "caddy:$tag üretim ayarında (APP_DOMAIN=takip.gkh.ro) eski alan adı yönlendirmesi beklenen gibi değil: $(tail -n 1 "$T/adapt-hata.txt" | cut -c1-300)" | tee -a "$RESULTS"
      false
    fi
    echo "caddy:$tag → APP_DOMAIN=takip.gkh.ro: takip.sistembalustrada.ro yalnızca 308 → https://takip.gkh.ro{uri} (vekil yok)" | tee -a "$RESULTS"
  done
  # (eski sürüm imajları silinmez: hemen ardından deploy/test/body-gate.sh aynı imajlarla kapının davranışını dener ve siler)

  echo "::notice title=Gövde sınırları (gerçek Caddy)::$(sed 's/%/%25/g' "$RESULTS" | sed ':a;N;$!ba;s/\n/%0A/g')"
}
