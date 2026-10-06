#!/usr/bin/env bash
# Yayın, ön sunucuyu (Caddy) da doğrular (karar 142) — gerçek kurulumda, gerçek Caddy ile, gerçek "takip guncelle" ile.
# .github/workflows/deploy-test.yml çalıştırır; kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi).
# GERÇEK SUNUCUDA ÇALIŞTIRILMAZ: deneme yayınları yapar (Caddyfile'ı değiştiren / bozan commit'ler).
#
#   A. Geçerli Caddyfile değişikliği: yayın başarılı, yeni ayar gerçekten etkin, site HTTPS üzerinden doğrulandı.
#   B. Geçersiz Caddyfile (bilinmeyen yönerge): yayın BAŞLAMADAN başarısız — derleme yok, Caddy yeniden başlamaz,
#      site önceki sürüm ve önceki ayarla çalışmaya devam eder.
#   C. Sözdizimi geçerli ama yönlendirmeyi bozan Caddyfile: uygulama açılır, site HTTPS üzerinden yanıt vermez →
#      yayın BAŞARISIZ, önceki sürüme ve önceki Caddyfile'a dönülür, site yeniden çalışır.
#   D. Özgün Caddyfile'a dönüş: yayın başarılı.
# Dış istek yok (yalnızca https://localhost).
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

SITE=${SITE:-https://localhost}
ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
STATE=/opt/takip/state
DEPLOY_LOG=/opt/takip/logs/deploy.log
compose() { sudo docker compose -p takip --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
T=$(mktemp -d)
RESULTS="$T/sonuclar.txt"
: >"$RESULTS"
note() { echo "$*" | tee -a "$RESULTS"; }

diag() { # diag SATIR ÇIKIŞ KOMUT
  trap - ERR
  set +ex
  {
    echo "satır $1 (çıkış $2): $3"
    echo "--- sonuçlar"; cat "$RESULTS" || true
    echo "--- yayın kaydı"; sudo tail -n 14 "$DEPLOY_LOG" || true
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' || true
    echo "--- caddy günlüğü"; compose logs --no-log-prefix --tail 8 caddy || true
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=Caddy yayın testi::/'
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR

# post YOL BAYT → HTTP durum kodu (çok parçalı POST; Next gövdenin tamamını okur → vekilin sınırı kesin devreye girer)
post() {
  local f="$T/govde-$2"
  [ -f "$f" ] || head -c "$2" /dev/zero >"$f"
  curl -sk -o /dev/null -w '%{http_code}' --max-time 180 -X POST -F "dosya=@$f;type=application/octet-stream" "$SITE$1" || true
}
build_now() { curl -fsSk --max-time 10 "$SITE/surum" | jq -r .build; }
wait_site() { # wait_site BEKLENEN_SÜRÜM
  local n=0
  while [ "$n" -lt 60 ]; do
    if [ "$(build_now 2>/dev/null || true)" = "$1" ]; then return 0; fi
    sleep 2
    n=$((n + 1))
  done
  return 1
}
caddy_started() { sudo docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q caddy | head -n 1)"; }
deploy() { sudo env TAKIP_SKIP_CI_GATE=1 TAKIP_EDGE_WAIT=30 takip guncelle; }
log_lines() { sudo wc -l "$DEPLOY_LOG" | cut -d' ' -f1; }
# Bu denemede yazılan yayın kaydı satırları (log_from SATIR)
log_from() { sudo tail -n "+$(($1 + 1))" "$DEPLOY_LOG"; }

orig=$(git rev-parse HEAD)
[ "$(sudo cat "$STATE/deployed")" = "$orig" ]
[ "$(post /login 2500000)" = 413 ]

# ---------- A. Geçerli değişiklik: etkin olur ve doğrulanır ----------
n=$(log_lines)
sed -i 's/max_size 2MB/max_size 3MB/' deploy/Caddyfile
grep -q 'max_size 3MB' deploy/Caddyfile
git commit -qam "caddy testi A — geçerli değişiklik"
a=$(git rev-parse HEAD)
deploy
wait_site "${a:0:7}"
[ "$(sudo cat "$STATE/deployed")" = "$a" ]
sudo cmp -s deploy/Caddyfile /opt/takip/src/deploy/Caddyfile
log_from "$n" | grep -q 'yeni Caddyfile geçerli'
log_from "$n" | grep -q 'site HTTPS üzerinden yeni sürümü veriyor'
[ "$(post /login 2500000)" != 413 ]
[ "$(post /login 3500000)" = 413 ]
note "A. geçerli Caddyfile değişikliği: yayın başarılı, yeni sınır etkin (2,5 MB geçer, 3,5 MB 413), Caddy doğrulandı"

# ---------- B. Geçersiz Caddyfile: yayın başlamadan durur ----------
n=$(log_lines)
started=$(caddy_started)
sed -i 's/^\tencode zstd gzip$/\tencode zstd gzip\n\tbilinmeyen_yonerge_deneme evet/' deploy/Caddyfile
grep -q 'bilinmeyen_yonerge_deneme' deploy/Caddyfile
git commit -qam "caddy testi B — geçersiz Caddyfile"
b=$(git rev-parse HEAD)
if deploy; then echo "geçersiz Caddyfile yayınlanmamalıydı"; false; fi
log_from "$n" | grep -q 'Caddyfile geçersiz'
[ "$(sudo cat "$STATE/failed")" = "$b" ]
[ "$(sudo cat "$STATE/deployed")" = "$a" ]
# Hiçbir şeye dokunulmadı: imaj derlenmedi, Caddy yeniden başlamadı, kaynak önceki sürümde, site aynı sürümle yanıt veriyor
if sudo docker image inspect "takip:$b" >/dev/null 2>&1; then echo "geçersiz Caddyfile için imaj derlenmemeliydi"; false; fi
[ "$(caddy_started)" = "$started" ]
[ "$(sudo git -C /opt/takip/src rev-parse HEAD)" = "$a" ]
[ "$(build_now)" = "${a:0:7}" ]
[ "$(post /login 2500000)" != 413 ]
[ "$(post /login 3500000)" = 413 ]
# Aynı commit bir daha denenmez
deploy | grep -q 'daha önce yayınlanamadı'
note "B. geçersiz Caddyfile: yayın başlamadan başarısız (derleme yok, Caddy yeniden başlamadı, site önceki sürümde)"
git revert --no-edit HEAD >/dev/null
deploy
[ "$(sudo cat "$STATE/deployed")" = "$(git rev-parse HEAD)" ]
[ "$(build_now)" = "${a:0:7}" ]

# ---------- C. Geçerli sözdizimi, bozuk yönlendirme: yayın başarısız, geri dönülür ----------
n=$(log_lines)
good=$(git rev-parse HEAD)
sed -i 's/reverse_proxy app:3000/reverse_proxy app:3999/' deploy/Caddyfile
grep -q 'app:3999' deploy/Caddyfile
git commit -qam "caddy testi C — yönlendirmeyi bozan Caddyfile"
c=$(git rev-parse HEAD)
if deploy; then echo "yönlendirmeyi bozan Caddyfile yayınlanmamalıydı"; false; fi
log_from "$n" | grep -q 'yeni Caddyfile geçerli'
log_from "$n" | grep -q 'site HTTPS üzerinden (Caddy) yeni sürümü vermiyor; önceki sürüme dönülüyor'
log_from "$n" | grep -q 'önceki sürüm yeniden yayında'
[ "$(sudo cat "$STATE/failed")" = "$c" ]
[ "$(sudo cat "$STATE/deployed")" = "$good" ]
# Geri dönüş: önceki imaj, önceki kaynak, önceki Caddyfile; site yeniden yanıt veriyor ve sınırlar yerinde
wait_site "${a:0:7}"
[ "$(sudo git -C /opt/takip/src rev-parse HEAD)" = "$good" ]
git show "$good:deploy/Caddyfile" | sudo cmp -s - /opt/takip/src/deploy/Caddyfile
[ "$(compose ps --status running --services | grep -cx caddy)" = 1 ]
[ "$(post /login 2500000)" != 413 ]
[ "$(post /login 3500000)" = 413 ]
# Kayda Caddy'nin günlük satırları (istek adresleri) yazılmaz
if log_from "$n" | grep -qiE 'http\.log|"uri"|/depo/'; then echo "yayın kaydına Caddy günlüğü yazılmamalı"; false; fi
note "C. yönlendirmeyi bozan Caddyfile: yayın başarısız, önceki sürüme ve önceki Caddyfile'a dönüldü, site yeniden çalışıyor"
git revert --no-edit HEAD >/dev/null
deploy
[ "$(sudo cat "$STATE/deployed")" = "$(git rev-parse HEAD)" ]

# ---------- D. Özgün Caddyfile'a dönüş ----------
n=$(log_lines)
sed -i 's/max_size 3MB/max_size 2MB/' deploy/Caddyfile
git diff --quiet "$orig" -- deploy/Caddyfile
git commit -qam "caddy testi D — özgün Caddyfile"
d=$(git rev-parse HEAD)
deploy
wait_site "${d:0:7}"
log_from "$n" | grep -q 'site HTTPS üzerinden yeni sürümü veriyor'
sudo cmp -s deploy/Caddyfile /opt/takip/src/deploy/Caddyfile
[ "$(post /login 2500000)" = 413 ]
[ "$(post /login 1500000)" != 413 ]
note "D. özgün Caddyfile: yayın başarılı, 2 MB sınırı yeniden etkin"

echo "::notice title=Yayın Caddy'yi doğrular (gerçek yayın)::$(sed 's/%/%25/g' "$RESULTS" | sed ':a;N;$!ba;s/\n/%0A/g')"
