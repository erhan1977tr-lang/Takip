#!/usr/bin/env bash
# Gerçek sunucu işareti (güvenlik denetimi AUD-13, karar 151) — gerçek Docker Compose ile denenir.
# .github/workflows/deploy-test.yml çalıştırır; kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi).
# GERÇEK SUNUCUDA ÇALIŞTIRILMAZ: sunucudaki .env dosyasına geçici satırlar yazar, kapsayıcıları yeniden kurar.
#
#   1. İşaret (TAKIP_DEPLOYMENT) Compose dosyasında SABİT değerdir: .env'e TAKIP_DEPLOYMENT= (boş), =test, =0, =false,
#      ="demo" yazılsa da Compose'un uygulama / işçi / araç servisleri için çözdüğü değer "server" kalır.
#   2. Sunucuya yanlışlıkla kopyalanmış bir demo / test .env'i (TAKIP_DEPLOYMENT=demo, DEMO_MODE=1, MAIL_OUTBOX_DIR,
#      TRANSLATE_FAKE=1, COOKIE_SECURE=false, NODE_ENV=development) ile kapsayıcılar yeniden kurulur:
#      - site AÇIK kalır, işçi çalışır (yeniden başlatılmadan); kapsayıcıdaki işaret yine "server"
#      - giriş sayfasında demo kutusu yok; /demo/posta yöneticiye de 404; dil çerezi Secure
#      - Entegrasyonlar'da "Ortam uyarıları" kartı yalnızca dört ayarın ADINI gösterir (değer / klasör yolu yok);
#        sahte çeviri uyarısı yok
#      - uygulama ve işçi günlüğünde göze çarpan uyarı + dört ad; klasör yolu yok
#      - e-posta klasörü ne uygulamada ne işçide oluşur
#      - demo verisi betiği çalışmaz; işaret komut satırından bilerek kaldırılsa bile dolu veritabanına yazmaz
#      - antivirüs (karar 150) etkilenmez: tarayıcı clamav:3310, EICAR yakalanır
#   3. Satırlar kaldırılınca uyarılar ve kart kaybolur.
#
# Dış istek yok (yalnızca https://localhost ve yerel kapsayıcılar). Oturum anahtarı rastgeledir; günlüğe / notlara yazılmaz.
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

SITE=${SITE:-https://localhost}
HOST=${SITE#https://}
ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
HERE=$(cd "$(dirname "$0")" && pwd)
OWNER=1001:1001
OUTBOX=/tmp/aud13-gizli-outbox
NAMES='DEMO_MODE MAIL_OUTBOX_DIR TRANSLATE_FAKE COOKIE_SECURE'
compose() { sudo docker compose -p takip --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
sql() { compose exec -T db psql -U takip -d takip -Atc "$1"; }
cid() { compose ps -q "$1" | head -n 1; }
T=$(mktemp -d)
RESULTS="$T/sonuclar.txt"
: >"$RESULTS"

# .env her durumda testten önceki hâline döner (asıl dosya testin başında kopyalanır)
restore_env() { if [ -f "$T/env.asil" ]; then sudo cp -p "$T/env.asil" "$ENV_FILE"; fi; }
diag() { # diag SATIR ÇIKIŞ KOMUT
  trap - ERR
  set +e
  {
    echo "satır $1 (çıkış $2): $(echo "$3" | cut -c1-300)"
    echo "--- sonuçlar"; tail -n 30 "$RESULTS"
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}'
    echo "--- uygulama günlüğü"; compose logs --no-log-prefix --tail 12 app | cut -c1-300
    echo "--- işçi günlüğü"; compose logs --no-log-prefix --tail 12 worker | cut -c1-300
    for f in seed1.log seed2.log av.txt; do if [ -f "$T/$f" ]; then echo "--- $f"; tail -n 6 "$T/$f" | cut -c1-300; fi; done
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=Gerçek sunucu işareti testi::/'
  restore_env
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR
note() { echo "$*" | tee -a "$RESULTS"; }

site_up() {
  for _ in $(seq 1 60); do
    if curl -fsSk "$SITE/login" 2>/dev/null | grep -q 'GKH Digital'; then return 0; fi
    sleep 3
  done
  echo "site açılmadı"; return 1
}
# İşçi başladı ve en az bir tur attı (açılış günlüğü yazılmış, tarama turunun zamanı ilerlemiş)
worker_ready() {
  local a b
  a=$(sql "select value->>'lastRun' from \"IntegrationSetting\" where key = 'antivirus.status'")
  for _ in $(seq 1 40); do
    b=$(sql "select value->>'lastRun' from \"IntegrationSetting\" where key = 'antivirus.status'")
    compose logs --no-log-prefix worker >"$T/isci-hazir.log" 2>&1 || true
    if [ -n "$b" ] && [ "$b" != "$a" ] && grep -q 'işçi başladı' "$T/isci-hazir.log"; then return 0; fi
    sleep 5
  done
  echo "işçi yeni tur atmadı (son: $a)"; return 1
}
# Kapsayıcının gördüğü ham ortam değeri
raw() { sudo docker exec "$(cid "$1")" printenv "$2"; }
# Compose'un bir servis için ÇÖZDÜĞÜ işaret (env_file ile environment birleşiminin sonucu); kapsayıcı kurulmadan
merged() { compose --profile tools config --format json | jq -r --arg s "$1" '.services[$s].environment.TAKIP_DEPLOYMENT // "YOK"'; }
# Demo verisinin değiştireceği tablolar (oturum / deneme satırları hariç)
state() {
  sql "select (select count(*) from \"User\") || ' ' || (select count(*) from \"Customer\") || ' ' || (select count(*) from \"Order\") || ' ' || (select count(*) from \"OrderFile\") || ' ' || (select count(*) from \"AuditLog\" where action = 'DEMO_SEED') || ' ' || (select count(*) from \"User\" where email like '%@ornek.test')"
}

set -x
# ---------- 0. Başlangıç: temiz .env, işaret üç serviste de "server" ----------
site_up
sudo cmp -s deploy/docker-compose.yml "$COMPOSE_FILE"
if sudo grep -Eq '^(TAKIP_DEPLOYMENT|DEMO_MODE|MAIL_OUTBOX_DIR|TRANSLATE_FAKE|COOKIE_SECURE|NODE_ENV)=' "$ENV_FILE"; then echo ".env başlangıçta temiz değil"; exit 1; fi
sudo cp -p "$ENV_FILE" "$T/env.asil"
[ "$(raw app TAKIP_DEPLOYMENT)" = server ]
[ "$(raw worker TAKIP_DEPLOYMENT)" = server ]
[ "$(compose run --rm --no-deps -T tools printenv TAKIP_DEPLOYMENT | tr -d '\r' | tail -n 1)" = server ]
for s in app worker tools; do [ "$(merged "$s")" = server ]; done
note "başlangıç: uygulama, işçi ve araç servislerinde TAKIP_DEPLOYMENT=server (Compose'daki sabit değer)"

# ---------- 1. .env işareti ezemez: Compose'un çözdüğü değer hep "server" ----------
for line in 'TAKIP_DEPLOYMENT=' 'TAKIP_DEPLOYMENT=test' 'TAKIP_DEPLOYMENT=0' 'TAKIP_DEPLOYMENT=false' 'TAKIP_DEPLOYMENT="demo"'; do
  restore_env
  echo "$line" | sudo tee -a "$ENV_FILE" >/dev/null
  for s in app worker tools; do [ "$(merged "$s")" = server ]; done
  note ".env → $line : Compose yine server çözdü (app, worker, tools)"
done
restore_env

# ---------- 2. Sunucuya kopyalanmış demo / test .env'i ----------
before=$(state)
printf '%s\n' 'TAKIP_DEPLOYMENT=demo' 'DEMO_MODE=1' "MAIL_OUTBOX_DIR=$OUTBOX" 'TRANSLATE_FAKE=1' 'COOKIE_SECURE=false' 'NODE_ENV=development' | sudo tee -a "$ENV_FILE" >/dev/null
compose up -d
site_up
worker_ready
APP=$(cid app)
WORKER=$(cid worker)
# Site açık, işçi çalışıyor (ortam "hatası" sayılmadı: yeniden başlatma yok)
[ "$(sudo docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$APP")" = "running 0" ]
[ "$(sudo docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$WORKER")" = "running 0" ]
# İşaret kapsayıcıda yine "server"; test ayarlarının ham değerleri kapsayıcıda VAR (yok sayan koddur, yoklukları değil)
[ "$(raw app TAKIP_DEPLOYMENT)" = server ]
[ "$(raw worker TAKIP_DEPLOYMENT)" = server ]
[ "$(raw app DEMO_MODE)" = 1 ]
[ "$(raw app COOKIE_SECURE)" = false ]
[ "$(raw worker MAIL_OUTBOX_DIR)" = "$OUTBOX" ]
note "kopyalanmış demo / test .env'i ile yeniden kurulum: site açık, işçi çalışıyor, işaret kapsayıcılarda server"

# Giriş sayfası: demo kutusu yok
curl -fsSk "$SITE/login" >"$T/giris.html"
grep -q 'name="password"' "$T/giris.html"
if grep -q 'demo-accounts\|ornek\.test' "$T/giris.html"; then echo "giriş sayfasında demo kutusu var"; exit 1; fi
# Dil çerezi: Secure (COOKIE_SECURE=false yok sayıldı)
curl -sk -o /dev/null -D "$T/dil.txt" "$SITE/dil?l=ro&next=/login"
grep -i '^set-cookie:' "$T/dil.txt" | tr -d '\r' >"$T/dil-cerez.txt"
[ -s "$T/dil-cerez.txt" ]
if grep -iqv ';[[:space:]]*secure' "$T/dil-cerez.txt"; then echo "Secure olmayan çerez"; exit 1; fi
note "giriş sayfasında demo kutusu yok; dil çerezi Secure"

# Yönetici oturumu (rastgele anahtar; çalışan işçi kapsayıcısında, uygulamanın kendi modülleriyle)
set +x # oturum anahtarı komut izine (günlüğe) yazılmasın
cat "$HERE/env-marker-fixtures.mjs" | sudo docker exec -i -u "$OWNER" -e TAKIP_TEST_FIXTURES=1 "$WORKER" node --input-type=module - | tail -n 1 >"$T/veri.json"
jq -e .token "$T/veri.json" >/dev/null
printf '%s\tFALSE\t/\tTRUE\t0\ttakip_session\t%s\n' "$HOST" "$(jq -r .token "$T/veri.json")" >"$T/cerez"
set -x
# Demo posta kutusu yöneticiye de yok
[ "$(curl -sk -o /dev/null -w '%{http_code}' -b "$T/cerez" "$SITE/demo/posta")" = 404 ]
# Entegrasyonlar: "Ortam uyarıları" kartı — dört ad; değer / klasör yolu / sahte çeviri uyarısı / demo bağlantısı yok
[ "$(curl -sk -o "$T/ent.html" -w '%{http_code}' -b "$T/cerez" "$SITE/admin/entegrasyonlar")" = 200 ]
grep -q 'id="ortam-uyarilari"' "$T/ent.html"
for n in $NAMES; do grep -q "data-env-ignored=\"$n\"" "$T/ent.html"; done
[ "$(grep -o 'data-env-ignored="' "$T/ent.html" | wc -l)" = 4 ]
if grep -q 'aud13-gizli-outbox\|TEST MODU\|MOD DE TEST\|/demo/posta' "$T/ent.html"; then echo "Entegrasyonlar sayfasında değer / sahte çeviri / demo bağlantısı var"; exit 1; fi
note "yönetici: /demo/posta 404; Entegrasyonlar'da 'Ortam uyarıları' kartı dört adı gösteriyor, değer göstermiyor"

# Günlükler: göze çarpan uyarı + dört ad; klasör yolu yok (uygulama ve işçi aynı raporu yazar)
for s in app worker; do
  compose logs --no-log-prefix "$s" >"$T/$s.log" 2>&1
  grep -q 'GÜVENLİK UYARISI — test / geliştirme ayarları gerçek sunucuda YOK SAYILDI' "$T/$s.log"
  for n in $NAMES; do grep -q "⚠ $n: gerçek sunucuda yok sayıldı" "$T/$s.log"; done
  if grep -q 'aud13-gizli-outbox' "$T/$s.log"; then echo "$s günlüğünde ayarın değeri var"; exit 1; fi
done
# E-posta klasörü ne uygulamada ne işçide oluştu (işçi en az bir tur attı)
sudo docker exec "$APP" sh -c "test ! -e '$OUTBOX'"
sudo docker exec "$WORKER" sh -c "test ! -e '$OUTBOX'"
note "uygulama ve işçi günlüğünde uyarı (yalnızca adlar); e-posta klasörü oluşmadı"

# Demo verisi betiği: gerçek sunucuda çalışmaz (DEMO_MODE=1 .env'de olsa da)
if compose run --rm --no-deps -T tools node scripts/demo/seed.mjs >"$T/seed1.log" 2>&1; then echo "demo verisi betiği gerçek sunucuda çalıştı"; exit 1; fi
grep -q 'GERÇEK SUNUCUDA çalışmaz' "$T/seed1.log"
# İşaret komut satırından BİLEREK kaldırılsa bile (root; .env ile yapılamaz): veritabanı boş değil → yine yazmaz
if compose run --rm --no-deps -T -e TAKIP_DEPLOYMENT= -e DEMO_MODE=1 tools node scripts/demo/seed.mjs >"$T/seed2.log" 2>&1; then echo "demo verisi dolu veritabanına yazıldı"; exit 1; fi
grep -q 'yalnızca BOŞ bir veritabanına yüklenir' "$T/seed2.log"
[ "$(state)" = "$before" ]
note "demo verisi betiği reddedildi (işaretle ve işaret kaldırılıp dolu veritabanında); kullanıcı / firma / sipariş sayıları aynı: $before"

# Antivirüs (karar 150) etkilenmedi: tarayıcının adresi sunucu ayarından, EICAR yakalanıyor
sudo takip antivirus | tee "$T/av.txt"
grep -q 'clamav:3310' "$T/av.txt"
grep -q 'EICAR) yakalandı' "$T/av.txt"

# ---------- 3. Satırlar kaldırılınca uyarılar ve kart kaybolur ----------
restore_env
compose up -d
site_up
worker_ready
[ "$(raw app TAKIP_DEPLOYMENT)" = server ]
[ "$(raw worker TAKIP_DEPLOYMENT)" = server ]
for s in app worker; do
  compose logs --no-log-prefix "$s" >"$T/$s-temiz.log" 2>&1
  if grep -q 'YOK SAYILDI' "$T/$s-temiz.log"; then echo "$s: temiz .env ile uyarı var"; exit 1; fi
done
[ "$(curl -sk -o "$T/ent-temiz.html" -w '%{http_code}' -b "$T/cerez" "$SITE/admin/entegrasyonlar")" = 200 ]
if grep -q 'ortam-uyarilari\|data-env-ignored' "$T/ent-temiz.html"; then echo "temiz .env ile uyarı kartı var"; exit 1; fi
sudo cmp -s "$T/env.asil" "$ENV_FILE"
note "satırlar kaldırıldı: uyarı ve kart yok; .env testten önceki hâlinde"

set +x
echo "::notice title=Gerçek sunucu işareti (karar 151) — gerçek Compose::$(sed 's/%/%25/g' "$RESULTS" | sed ':a;N;$!ba;s/\n/%0A/g')"
rm -rf "$T"
