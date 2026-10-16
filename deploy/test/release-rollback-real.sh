#!/usr/bin/env bash
# Son sağlıklı sürüm kaydı ve güvenli geri dönüş (karar 287) — GERÇEK kurulumda, gerçek Docker, gerçek PostgreSQL, gerçek
# Caddy ve gerçek "takip guncelle / rollback" ile. .github/workflows/deploy-test.yml çalıştırır (GitHub'ın tek kullanımlık
# test makinesi). GERÇEK SUNUCUDA ÇALIŞTIRILMAZ: deneme yayınları, geri dönüş ve deneme migration'ı yapar.
#
#   A. Yayındaki sürüm doğrulanmış sağlıklı sürüm (kayıt yoksa: surum-dogrula). Kayıttaki imaj kimlikleri Docker'dakiyle aynı.
#   B. Yeni sürüm (migration yok) yayınlanır: sağlık denetimi (salt okunur Prisma yoklaması dahil) geçer, kayıt yazılır,
#      önceki sağlıklı sürüm geri dönüş adayı olur, imajları korunur.
#   C. rollback-kontrol GÜVENLİ der; takip rollback: uygulama + işçi eski imaja geçer, /surum eski commit, veritabanı
#      (migration listesi, kayıt sayıları) DEĞİŞMEZ; süre ölçülür (hedef 5–10 dk). Tekrar çalıştırma güvenle reddedilir.
#   D. Migration'lı yeni sürüm: yayından sonra geri dönüş REDDEDİLİR (migration listesi değişti); servis yerinde kalır.
# Dış istek yok (yalnızca https://localhost).
# shellcheck disable=SC2024 # komut çıktıları bilerek testin kendi geçici klasörüne (kullanıcının) yazılır
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

SITE=${SITE:-https://localhost}
ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
STATE=/opt/takip/state
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
    for f in "$T"/*.out; do [ -f "$f" ] && { echo "--- $(basename "$f")"; tail -n 12 "$f"; }; done
    echo "--- yayın kaydı"; sudo tail -n 20 /opt/takip/logs/deploy.log || true
    echo "--- işlem geçmişi"; sudo tail -n 12 /opt/takip/logs/release.log || true
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' || true
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=Geri dönüş testi::/'
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR

build_now() { curl -fsSk --max-time 10 "$SITE/surum" | jq -r .build; }
deploy() { sudo env TAKIP_SKIP_CI_GATE=1 takip guncelle >"$T/$1.out" 2>&1; }
st() { sudo cat "$STATE/$1" 2>/dev/null || true; }
rec() { sudo grep -E "^$2=" "$STATE/releases/$1.kayit" | cut -d= -f2-; }
img() { sudo docker image inspect -f '{{.Id}}' "takip:$1"; }
running_img() { sudo docker inspect -f '{{.Image}}' "$(compose ps -q "$1" | head -n 1)"; }
db() { compose exec -T db psql -U takip -d takip -qtAc "$1"; }
fingerprint() { # veritabanı parmak izi: migration listesi + temel kayıt sayıları
  db 'SELECT string_agg(migration_name || '"':'"' || checksum, '"','"' ORDER BY migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'
  for t in User Customer Order; do db "SELECT count(*) FROM \"$t\""; done
}

# ---------- hazırlık: çalışma kopyası yayındaki commit'in içeriğine (önceki adımların bozuk commit'i geri alınır) ----------
git config user.name ci && git config user.email ci@kurulum.test
d0=$(st deployed)
git read-tree -u --reset "$d0"
git commit -qm "geri dönüş testi — hazırlık (yayındaki içerik)" || true

# ---------- A. yayındaki sürüm sağlıklı kayıtlı ----------
if [ "$(st release-healthy)" != "$d0" ]; then sudo takip surum-dogrula >"$T/dogrula.out" 2>&1; fi
[ "$(st release-healthy)" = "$d0" ]
H0=$d0
tag0=$(rec "$H0" tag)
[ "$(rec "$H0" app_image)" = "$(img "$tag0")" ] && [ "$(rec "$H0" tools_image)" = "$(img "$tag0-tools")" ]
[ "$(sudo stat -c %a "$STATE/releases")" = 700 ]
note "A. yayındaki sürüm $(rec "$H0" version) ($(echo "$H0" | cut -c1-7)) sağlıklı kayıtlı; imaj kimlikleri Docker'la aynı"

# ---------- B. yeni sürüm: sağlık + kayıt + aday ----------
echo "// geri dönüş testi B $(date +%s)" >>app/surum/route.ts
git commit -qam "geri dönüş testi B"
H1=$(git rev-parse HEAD)
deploy b
[ "$(build_now)" = "${H1:0:7}" ]
[ "$(st release-healthy)" = "$H1" ] && [ "$(st release-healthy-prev)" = "$H0" ]
[ "$(rec "$H1" app_image)" = "$(img "$H1")" ] && [ "$(running_img app)" = "$(img "$H1")" ] && [ "$(running_img worker)" = "$(img "$H1-tools")" ]
sudo grep -q "SAGLIKLI_KAYIT .* $(echo "$H1" | cut -c1-7) .*yoklama=PROBE_OK" /opt/takip/logs/release.log
grep -q 'yayın öncesi: yeni migration yok' "$T/b.out"
img "$tag0" >/dev/null && img "$tag0-tools" >/dev/null
note "B. yeni sürüm sağlık denetiminden (salt okunur Prisma yoklaması dahil) geçti, kaydedildi; önceki sürüm aday, imajları korundu"

# ---------- C. güvenli geri dönüş ----------
sudo takip surum-durum >"$T/sd.out" 2>&1
grep -q "$(rec "$H0" app_image)" "$T/sd.out"
sudo takip rollback-kontrol >"$T/rk.out" 2>&1
grep -q 'Geri dönüş GÜVENLİ' "$T/rk.out" && grep -q 'PROBE_OK' "$T/rk.out"
fp_before=$(fingerprint)
t0=$(date +%s)
sudo takip rollback --onay "${H0:0:7}" >"$T/rb.out" 2>&1
secs=$(($(date +%s) - t0))
[ "$(build_now)" = "${tag0:0:7}" ]
[ "$(running_img app)" = "$(img "$tag0")" ] && [ "$(running_img worker)" = "$(img "$tag0-tools")" ]
[ "$(st deployed)" = "$H0" ] && [ "$(st release-healthy)" = "$H0" ] && [ "$(st failed)" = "$H1" ]
[ "$(fingerprint)" = "$fp_before" ]
sudo grep -q 'GERI_DONUS_TAMAM elle' /opt/takip/logs/release.log
[ "$secs" -lt 600 ]
note "C. geri dönüş: uygulama + işçi önceki imajda, /surum önceki commit, veritabanı parmak izi aynı — süre ${secs} sn"
echo "::notice title=Geri dönüş süresi (gerçek Docker)::takip rollback ${secs} sn sürdü (denetim + yoklama + kapsayıcı geçişi + tam sağlık denetimi)"
if sudo takip rollback --onay "${H0:0:7}" >"$T/rb2.out" 2>&1; then echo "tekrar geri dönüş reddedilmeliydi"; exit 1; fi
[ "$(build_now)" = "${tag0:0:7}" ]
# Geri dönülen sürüm otomatik güncellemeyle yeniden yayınlanmaz
sudo env TAKIP_SKIP_CI_GATE=1 takip guncelle >"$T/g.out" 2>&1 || true
[ "$(build_now)" = "${tag0:0:7}" ]
note "C2. tekrar çalıştırma güvenle reddedildi; geri dönülen sürüm otomatik yeniden yayınlanmadı"

# ---------- D. migration'lı sürüm: geri dönüş reddedilir ----------
mig=$(date -u +%Y%m%d%H%M%S)_geri_donus_deneme
mkdir -p "prisma/migrations/$mig"
echo 'CREATE TABLE "GeriDonusDeneme" ("id" INTEGER);' >"prisma/migrations/$mig/migration.sql"
echo "// geri dönüş testi D $(date +%s)" >>app/surum/route.ts
git add -A && git commit -qm "geri dönüş testi D — migration"
H2=$(git rev-parse HEAD)
deploy d
[ "$(build_now)" = "${H2:0:7}" ]
grep -q "bu yayın 1 migration uygular ($mig)" "$T/d.out"
[ "$(st release-healthy)" = "$H2" ] && [ "$(st release-healthy-prev)" = "$H0" ]
if sudo takip rollback-kontrol >"$T/rk2.out" 2>&1; then echo "migration sonrası güvenli denmemeliydi"; exit 1; fi
grep -q 'MIGRATION_CHANGED' "$T/rk2.out" && grep -q "+$mig" "$T/rk2.out"
if sudo takip rollback --onay "${H0:0:7}" >"$T/rb3.out" 2>&1; then echo "migration sonrası geri dönülmemeliydi"; exit 1; fi
[ "$(build_now)" = "${H2:0:7}" ] && [ "$(running_img worker)" = "$(img "$H2-tools")" ]
[ "$(db "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$mig'")" = 1 ]
# Kanıt notu: Prisma'nın sakladığı checksum ile dosyanın SHA-256'sı (uyumluluk kararı buna DEĞİL, veritabanının kendi kaydına dayanır)
note "D. migration'lı yayından sonra geri dönüş reddedildi; servis ve veritabanı yerinde (checksum = sha256: $([ "$(db "SELECT checksum FROM \"_prisma_migrations\" WHERE migration_name = '$mig'")" = "$(sha256sum "prisma/migrations/$mig/migration.sql" | cut -c1-64)" ] && echo evet || echo hayır))"

# Gizli değerler geri dönüş kayıtlarına sızmadı
for k in POSTGRES_PASSWORD AUTH_SECRET; do
  v=$(sudo grep -E "^$k=" "$ENV_FILE" | cut -d= -f2- | tr -d "'\"")
  [ -n "$v" ] || continue
  if sudo grep -rqF -- "$v" /opt/takip/logs /opt/takip/state "$T"; then echo "gizli değer sızdı: $k"; exit 1; fi
done
note "Gizli değerler (veritabanı şifresi, oturum anahtarı) günlüklere / kayıtlara sızmadı"
cat "$RESULTS"
