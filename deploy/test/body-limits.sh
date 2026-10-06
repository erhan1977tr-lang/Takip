#!/usr/bin/env bash
# İstek gövdesi sınırları (güvenlik denetimi AUD-4, karar 141) — gerçek kurulumda, gerçek Caddy + uygulama ile denenir.
# .github/workflows/deploy-test.yml çalıştırır; kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi).
# GERÇEK SUNUCUDA ÇALIŞTIRILMAZ: deneme yayını yapar (Caddyfile'ı değiştiren bir commit).
#
#   bash deploy/test/body-limits.sh            sınırlar (yayındaki Caddyfile) + eski Caddy sürümleriyle sözdizimi denetimi
#   bash deploy/test/body-limits.sh yayin      Caddyfile değişikliği "takip guncelle" ile gerçekten etkin oluyor mu
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
# Beklenen: vekilden geçer — yanıtı uygulama verir (413 değil; bağlantı hatası 000 ve vekil hatası 502 de değil)
passes() {
  local c
  c=$(post "$1" "$2")
  echo "$1 $2 bayt → $c (vekilden geçmeli)" | tee -a "$RESULTS"
  [ "$c" != 413 ] && [ "$c" != 000 ] && [ "$c" != 502 ]
}
wait_site() {
  local n=0
  while [ "$n" -lt 60 ]; do
    if curl -fsSk -o /dev/null "$SITE/surum"; then return 0; fi
    sleep 2
    n=$((n + 1))
  done
  return 1
}

if [ "${1:-}" != yayin ]; then
  # 1. Yayındaki Caddyfile depodakiyle aynı ve Caddy çalışıyor
  sudo cmp -s deploy/Caddyfile /opt/takip/src/deploy/Caddyfile
  [ "$(compose ps --status running --services | grep -cx caddy)" = 1 ]
  curl -fsSk "$SITE/login" | grep -q 'GKH Digital'

  # 2. Varsayılan kademe (2 MB = 2.000.000 bayt): giriş ve diğer olağan adresler
  passes /login 100000
  passes /login 1500000
  rejected /login 2500000
  rejected /setup 2500000
  rejected / 2500000
  rejected /siparisler 2500000
  rejected /yuklemeler 2500000
  rejected /admin/users 2500000
  rejected /login 40000000

  # 3. Yönetim Excel sayfaları (6 MB): 5 MiB'lık dosya geçer, daha büyüğü geçmez
  passes /admin/katalog 5300000
  rejected /admin/katalog 6500000
  passes /admin/fiyatlar 5300000
  passes /admin/musteri-fiyatlari 5300000
  passes /admin/profil-katalogu 5300000
  passes /admin/stok 5300000
  rejected /admin/stok 6500000

  # 4. Dosya yükleme formu olan sayfalar (260 MB): orta boy gövdeler geçer
  passes /siparisler/yeni 6500000
  passes /siparisler/yeni 40000000
  passes /siparisler/cmyoksiparis0000000000000 6500000
  passes "/depo/$(head -c 43 /dev/zero | tr '\0' x)" 6500000

  # 5. Küçük istekler olağan çalışır (sayfa, sürüm, oturum etkinliği)
  curl -fsSk "$SITE/surum" | jq -e '.version != null' >/dev/null
  [ "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "$SITE/oturum/etkinlik" -H 'Content-Type: application/json' -H 'X-Takip-Activity: 1' -H "Origin: $SITE" -d '{"idle":0}')" = 401 ]

  # 6. Caddyfile, Caddy 2'nin eski sürümlerinde de geçerli (sunucudaki "caddy:2" imajı güncel olmayabilir)
  for tag in 2.6.4 2.7.6 2.8.4 2; do
    if ! out=$(sudo docker run --rm -e APP_DOMAIN=localhost -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "caddy:$tag" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
      echo "$out" | tail -n 5
      echo "caddy:$tag Caddyfile'ı kabul etmedi: $(echo "$out" | tail -n 1)" | tee -a "$RESULTS"
      false
    fi
    echo "caddy:$tag → Caddyfile geçerli" | tee -a "$RESULTS"
  done
  sudo docker rmi caddy:2.6.4 caddy:2.7.6 caddy:2.8.4 >/dev/null 2>&1 || true

  echo "::notice title=Gövde sınırları (gerçek Caddy)::$(sed 's/%/%25/g' "$RESULTS" | sed ':a;N;$!ba;s/\n/%0A/g')"
  exit 0
fi

# ---------- "yayin": Caddyfile değişikliği gerçek yayınla etkin olur ----------
# Sınırlar yalnızca Caddy yeni dosyayı okursa geçerlidir: takip.sh, Caddyfile değişen yayında Caddy'yi yeniden başlatır.
# Varsayılan sınır geçici olarak 3 MB yapılır, yayınlanır ve yeni sınırın gerçekten uygulandığına bakılır.
rejected /login 2500000
sed -i 's/max_size 2MB/max_size 3MB/' deploy/Caddyfile
grep -q 'max_size 3MB' deploy/Caddyfile
git commit -qam "gövde sınırı yayın testi"
sudo env TAKIP_SKIP_CI_GATE=1 takip guncelle
wait_site
new=$(git rev-parse --short=7 HEAD)
curl -fsSk "$SITE/surum" | jq -e --arg b "$new" '.build == $b' >/dev/null
sudo cmp -s deploy/Caddyfile /opt/takip/src/deploy/Caddyfile
passes /login 2500000
rejected /login 3500000
passes /siparisler/yeni 6500000
# Özgün sınıra dönüş de aynı yoldan
sed -i 's/max_size 3MB/max_size 2MB/' deploy/Caddyfile
git commit -qam "gövde sınırı yayın testi — geri"
sudo env TAKIP_SKIP_CI_GATE=1 takip guncelle
wait_site
rejected /login 2500000
passes /login 1500000
echo "::notice title=Gövde sınırları — yayınla etkinleşme::$(sed 's/%/%25/g' "$RESULTS" | sed ':a;N;$!ba;s/\n/%0A/g')"
