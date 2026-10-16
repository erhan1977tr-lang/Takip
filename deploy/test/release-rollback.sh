#!/usr/bin/env bash
# Yayın sağlığı, son sağlıklı sürüm kaydı ve güvenli geri dönüş (deploy/takip.sh, karar 287) — mantık testi.
# SAHTE docker (imajlar, kapsayıcılar, veritabanının migration tablosu, araç kapsayıcısı) ve SAHTE curl (/surum); geçici git
# deposu. Gerçek Docker'a, veritabanına, ağa, e-postaya ya da sunucudaki hiçbir dosyaya dokunulmaz: araç geçici bir klasörde
# (TAKIP_BASE) çalışır. Her senaryo temiz bir ortamla başlar: v1 ve v2 yayınlanmış ve sağlıklı (v2 son sağlıklı, v1 aday).
# Yayın kapısı burada atlanır (TAKIP_SKIP_CI_GATE=1; kapının kendisi deploy/test/deploy-gate.sh'ta sınanır).
# Root gerekir (komutlar yalnızca root'a açık): sudo bash deploy/test/release-rollback.sh
set -Eeuo pipefail

[ "$(id -u)" = 0 ] || { echo "root olarak çalıştırın: sudo bash $0"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
TAKIP=$HERE/../takip.sh
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
FAKE=$ROOT/bin
mkdir -p "$FAKE"
export GIT_CONFIG_GLOBAL=$ROOT/gitconfig GIT_CONFIG_NOSYSTEM=1
: >"$GIT_CONFIG_GLOBAL"
export TAKIP_REPO=gkh/Takip TAKIP_SKIP_CI_GATE=1 TAKIP_HEALTH_GAP=0 TAKIP_HEALTHY_WAIT=2 TAKIP_EDGE_WAIT=2 TAKIP_ROLLBACK_WAIT=2 \
  TAKIP_DB_TRIES=2 TAKIP_DB_GAP=0
export PATH="$FAKE:$PATH"
# Ortam dosyasındaki "gizli" değerler: hiçbir günlüğe / duruma / alarma sızmamalı (senaryo 15)
SECRETS=(GIZLI_PG_9f3a GIZLI_SMTP_77c1 GIZLI_AUTH_51be GIZLI_GH_0d2e GIZLI_TG_aa01 GIZLI_OAI_c9f0)

# ---------- sahte docker ----------
cat >"$FAKE/docker" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
CT=$S/ct IMG=$S/img
mkdir -p "$CT" "$IMG"
SRCDIR=$TAKIP_BASE/src
log() { echo "$*" >>"$S/docker.log"; }
idof() { cat "$IMG/$1" 2>/dev/null; }
tagof_id() { local f; for f in "$IMG"/*; do case $f in *.gitsha | *.ver) continue ;; esac; [ "$(cat "$f")" = "$1" ] && { basename "$f"; return; }; done; }
img_tag() { echo "${1#takip:}"; }
case "$1 ${2:-}" in
  'build '*)
    sha='' tag='' tgt=''
    shift
    while [ $# -gt 0 ]; do case $1 in --build-arg) sha=${2#GIT_SHA=}; shift 2 ;; --target) tgt=$2; shift 2 ;; -t) tag=$(img_tag "$2"); shift 2 ;; *) shift ;; esac; done
    if [ -x "$S/on-build" ]; then mv "$S/on-build" "$S/on-build.ran"; "$S/on-build.ran"; fi
    [ -e "$S/fault-build-$sha" ] && { log "build-fail $tag"; exit 1; }
    echo "sha256:$(printf '%s %s %s' "$tag" "$tgt" "$(date +%s%N)" | sha256sum | cut -c1-64)" >"$IMG/$tag"
    if [ -e "$S/fault-gitsha-$sha" ]; then echo 0000000000000000000000000000000000000000 >"$IMG/$tag.gitsha"; else echo "$sha" >"$IMG/$tag.gitsha"; fi
    git -C "$SRCDIR" show "$sha:package.json" 2>/dev/null | jq -r .version >"$IMG/$tag.ver"
    log "build $tag"
    exit 0 ;;
  'image inspect')
    f=$4 ref=''
    for a in "$@"; do case $a in takip:*) ref=$(img_tag "$a") ;; esac; done
    [ -f "$IMG/$ref" ] || exit 1
    case $f in
      *.Id*) cat "$IMG/$ref" ;;
      *Config.Env*) echo "GIT_SHA=$(cat "$IMG/$ref.gitsha")"; echo NODE_ENV=production ;;
    esac
    exit 0 ;;
  'image prune') exit 0 ;;
  'images takip') for f in "$IMG"/*; do case $f in *.gitsha | *.ver) ;; *) [ -f "$f" ] && basename "$f" ;; esac; done; exit 0 ;;
  'rmi '*) t=$(img_tag "$2"); rm -f "$IMG/$t" "$IMG/$t.gitsha" "$IMG/$t.ver"; log "rmi $t"; exit 0 ;;
  'inspect -f')
    f=$3 c=$4
    case $c in
      c-app)
        tag=$(cat "$CT/app.tag" 2>/dev/null)
        case $f in
          *Health.Status*) if [ -e "$S/fault-app-down-$tag" ]; then echo unhealthy; else echo healthy; fi ;;
          '{{.Image}}') cat "$CT/app.img" ;;
          *) echo running/healthy ;;
        esac ;;
      c-worker)
        tag=$(cat "$CT/worker.tag" 2>/dev/null)
        case $f in
          *Restarting*)
            if [ -e "$S/fault-worker-down-$tag" ]; then echo "restarting|true|$(date -u +%FT%TZ)"
            elif [ -s "$S/worker-transient" ] && [ "$(cat "$S/worker-transient")" -gt 0 ]; then
              echo $(($(cat "$S/worker-transient") - 1)) >"$S/worker-transient"; echo "restarting|true|$(date -u +%FT%TZ)"
            else echo "running|false|$(date -u -d "@$(cat "$CT/worker.started")" +%FT%T.123456789Z)"; fi ;;
          '{{.Image}}') cat "$CT/worker.img" ;;
          *) echo running ;;
        esac ;;
      c-caddy) case $f in *Running*) echo true ;; *) echo 'durum=running yeniden-başlatma=0' ;; esac ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  'exec -i') cat >/dev/null; [ -e "$S/fault-caddy-invalid" ] && { echo 'Error: hatalı'; exit 1; }; exit 0 ;;
  'compose '*)
    shift
    envf=''
    while [ $# -gt 0 ]; do case $1 in -p | -f) shift 2 ;; --env-file) envf=$2; shift 2 ;; *) break ;; esac; done
    tag=${APP_TAG:-$(grep -E '^APP_TAG=' "$envf" 2>/dev/null | tail -1 | cut -d= -f2-)}
    sub=$1; shift
    case $sub in
      ps)
        svc=${*: -1}
        case $svc in app | worker) [ -s "$CT/$svc.img" ] && echo "c-$svc" ;; caddy) echo c-caddy ;; db) echo c-db ;; esac
        exit 0 ;;
      up)
        case " $* " in
          *' db '*) exit 0 ;;
        esac
        [ -n "$(idof "$tag")" ] && [ -n "$(idof "$tag-tools")" ] || { log "up-fail $tag"; exit 1; }
        idof "$tag" >"$CT/app.img"; echo "$tag" >"$CT/app.tag"
        log "up $tag"
        if [ -e "$S/kill-at-up" ]; then
          rm -f "$S/kill-at-up"
          log "KESINTI"
          kill -9 "$(sed -n 's/^pid=//p' "$TAKIP_BASE/state/release-op")"
          exit 1
        fi
        idof "$tag-tools" >"$CT/worker.img"; echo "$tag" >"$CT/worker.tag"; echo $(($(date +%s) - 120)) >"$CT/worker.started"
        exit 0 ;;
      restart) log "restart $*"; exit 0 ;;
      exec)
        sql=${*: -1}
        case " $* " in
          *' pg_dump '*) echo FAKEDUMP; exit 0 ;;
        esac
        [ -e "$S/fault-db" ] && exit 2
        case $sql in
          'SELECT 1') echo 1 ;;
          *'finished_at IS NULL'*) cat "$S/db.failed" 2>/dev/null || echo 0 ;;
          *migration_name*) LC_ALL=C sort "$S/db.migrations" 2>/dev/null || true ;;
        esac
        exit 0 ;;
      run)
        case " $* " in
          *' scripts/release-alert.mjs '*)
            echo "$*" | sed 's/.*release-alert.mjs //' >>"$S/alerts"
            [ -e "$S/fault-alert" ] && exit 1
            exit 0 ;;
          *' scripts/backup-alert.mjs '*) exit 0 ;;
          *' node - '* | *' node -')
            cat >/dev/null
            echo "probe $tag" >>"$S/docker.log"
            if [ -e "$S/fault-probe-$tag" ]; then echo 'PROBE_FAIL User P2022'; exit 1; fi
            echo 'PROBE_OK 7'; exit 0 ;;
          *' tools ')
            log "migration $tag"
            [ -e "$S/fault-migration-$tag" ] && exit 1
            for m in $(git -C "$SRCDIR" ls-tree -d --name-only "$tag:prisma/migrations" 2>/dev/null); do
              grep -q "^$m " "$S/db.migrations" 2>/dev/null || echo "$m $(printf '%s' "$m" | sha256sum | cut -c1-64)" >>"$S/db.migrations"
            done
            exit 0 ;;
        esac
        exit 0 ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
SH
# ---------- sahte curl: /surum yayındaki uygulamanın sürümünü verir; GitHub yok ----------
cat >"$FAKE/curl" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
url=''
for a in "$@"; do case $a in http*) url=$a ;; esac; done
case $url in
  https://*/surum)
    tag=$(cat "$S/ct/app.tag" 2>/dev/null) || exit 7
    [ -e "$S/fault-edge" ] && exit 7
    [ -e "$S/fault-app-down-$tag" ] && exit 22
    v=$(cat "$S/img/$tag.ver" 2>/dev/null)
    [ -e "$S/fault-version-$tag" ] && v=0.0.0
    printf '{"version":"%s","build":"%s"}' "$v" "${tag:0:7}"
    ;;
  *) exit 7 ;;
esac
SH
chmod +x "$FAKE/docker" "$FAKE/curl"

# ---------- yardımcılar ----------
n=0
fail() {
  echo "✘ $*"
  for f in "$TAKIP_BASE/logs/deploy.log" "$TAKIP_BASE/logs/release.log" "$FAKE_STATE/docker.log" "$FAKE_STATE/alerts" "$ROOT/out"; do
    echo "--- $f"; tail -n 40 "$f" 2>/dev/null || true
  done
  exit 1
}
ok() { n=$((n + 1)); echo "✔ $*"; }
st() { cat "$TAKIP_BASE/state/$1" 2>/dev/null || true; }
envtag() { grep -E '^APP_TAG=' "$TAKIP_BASE/.env" | tail -1 | cut -d= -f2-; }
rec() { grep -E "^$2=" "$TAKIP_BASE/state/releases/$1.kayit" 2>/dev/null | cut -d= -f2-; }
running() { cat "$FAKE_STATE/ct/$1.tag" 2>/dev/null; }
tk() { bash "$TAKIP" "$@" >>"$ROOT/out" 2>&1; }
dlog() { cat "$TAKIP_BASE/logs/deploy.log" 2>/dev/null; }
rlog_has() { grep -q -- "$1" "$TAKIP_BASE/logs/release.log" 2>/dev/null; }
alert_has() { grep -q -- "$1" "$FAKE_STATE/alerts" 2>/dev/null; }
mcount() { grep -c . "$FAKE_STATE/db.migrations" 2>/dev/null || echo 0; }
commit() { # commit SÜRÜM [MIGRATION_ADI] [DOSYA] → yeni commit backend'e itilir, SHA yazılır
  echo "{\"version\":\"$1\"}" >"$WORK/package.json"
  if [ -n "${2:-}" ]; then mkdir -p "$WORK/prisma/migrations/$2"; echo "CREATE TABLE \"$2\" (id int);" >"$WORK/prisma/migrations/$2/migration.sql"; fi
  mkdir -p "$(dirname "$WORK/${3:-app/kod.ts}")"
  date +%s%N >>"$WORK/${3:-app/kod.ts}"
  git -C "$WORK" add -A
  git -C "$WORK" commit -qm "v$1"
  git -C "$WORK" push -q "$ORIGIN" HEAD:backend
  git -C "$WORK" rev-parse HEAD
}
# Temiz ortam: v1 (ilk kurulum) ve v2 yayında; v2 son sağlıklı, v1 geri dönüş adayı
fresh() {
  rm -rf "$ROOT/env"
  mkdir -p "$ROOT/env/fake" "$ROOT/env/base/state" "$ROOT/env/base/logs"
  export FAKE_STATE=$ROOT/env/fake TAKIP_BASE=$ROOT/env/base
  ORIGIN=$ROOT/env/origin.git WORK=$ROOT/env/work
  printf 'APP_TAG=\nAPP_DOMAIN=takip.test\nAPP_URL=https://takip.test\nPOSTGRES_PASSWORD=%s\nSMTP_PASS=%s\nAUTH_SECRET=%s\nTELEGRAM_BOT_TOKEN=%s\nOPENAI_API_KEY=%s\n' \
    "${SECRETS[0]}" "${SECRETS[1]}" "${SECRETS[2]}" "${SECRETS[4]}" "${SECRETS[5]}" >"$TAKIP_BASE/.env"
  echo "${SECRETS[3]}" >"$TAKIP_BASE/github-token"
  : >"$ROOT/out"
  git init -q --bare "$ORIGIN"
  git init -q -b backend "$WORK"
  git -C "$WORK" config user.email dev@gkh.test
  git -C "$WORK" config user.name dev
  mkdir -p "$WORK/deploy" "$WORK/app" "$WORK/prisma/migrations/20260101000000_baslangic"
  cp "$TAKIP" "$WORK/deploy/takip.sh"
  echo ':80' >"$WORK/deploy/Caddyfile"
  echo 'CREATE TABLE "User" (id int);' >"$WORK/prisma/migrations/20260101000000_baslangic/migration.sql"
  mkdir -p "$WORK/scripts" && echo '// alarm' >"$WORK/scripts/release-alert.mjs"
  V1=$(commit 1.0.0)
  git clone -q -b backend "$ORIGIN" "$TAKIP_BASE/src"
  tk _ilk || fail "ilk kurulum"
  V2=$(commit 1.0.1)
  tk _otomatik || true
  [ "$(st release-healthy)" = "$V2" ] && [ "$(st release-healthy-prev)" = "$V1" ] || fail "temel durum kurulamadı"
}
short() { echo "${1:0:7}"; }

# ===== 1. Başarılı yayın ve sağlıklı sürüm kaydı =====
fresh
[ "$(st deployed)" = "$V2" ] && [ "$(envtag)" = "$V2" ] && [ "$(running app)" = "$V2" ] && [ "$(running worker)" = "$V2" ] || fail "v2 yayında değil"
[ "$(rec "$V2" sha)" = "$V2" ] && [ "$(rec "$V2" version)" = 1.0.1 ] && [ "$(rec "$V2" tag)" = "$V2" ] || fail "kayıt alanları"
[ "$(rec "$V2" app_image)" = "$(cat "$FAKE_STATE/img/$V2")" ] && [ "$(rec "$V2" tools_image)" = "$(cat "$FAKE_STATE/img/$V2-tools")" ] || fail "imaj kimlikleri kayıtta"
[ "$(rec "$V2" migrations_count)" = 1 ] && [ "$(rec "$V2" source)" = deploy ] && [ -n "$(rec "$V2" deployed_at)" ] && [ -n "$(rec "$V2" verified_at)" ] || fail "migration / zaman / kaynak"
diff -q "$TAKIP_BASE/state/releases/$V2.migrations" <(LC_ALL=C sort "$FAKE_STATE/db.migrations") >/dev/null || fail "migration listesi veritabanından"
[ "$(stat -c %a "$TAKIP_BASE/state/releases")" = 700 ] && [ "$(stat -c %a "$TAKIP_BASE/state/releases/$V2.kayit")" = 600 ] || fail "kayıt izinleri"
rlog_has "SAGLIKLI_KAYIT 1.0.1" && rlog_has "YAYIN_TAMAM 1.0.1" && dlog | grep -q 'yayın öncesi: yeni migration yok' || fail "işlem kaydı / ön denetim"
[ -f "$FAKE_STATE/img/$V1" ] && [ -f "$FAKE_STATE/img/$V1-tools" ] || fail "geri dönüş adayının imajı silindi"
[ ! -e "$TAKIP_BASE/state/release-op" ] || fail "işlem işareti kaldı"
ok "1. başarılı yayın: kayıt (sürüm, tam SHA, imaj kimlikleri, migration, zaman, sağlık), göstergeler, aday imajlar korundu"
bash "$TAKIP" surum-durum >"$ROOT/sd" 2>&1 || fail "surum-durum"
grep -q "Son sağlıklı.*1.0.1 ($(short "$V2"))" "$ROOT/sd" && grep -q "$(rec "$V1" app_image)" "$ROOT/sd" && grep -q 'Geri dönüş kipi: gozlem' "$ROOT/sd" || fail "surum-durum içeriği"
ok "1b. surum-durum: son sağlıklı sürüm, aday ve imaj kimlikleri, kip, yedek durumu (salt okunur)"
# Kayıtlar kalıcı: aracın yeniden çalışması (yeniden başlatma) kaydı değiştirmez
cp "$TAKIP_BASE/state/releases/$V2.kayit" "$ROOT/k"
tk _otomatik || true
diff -q "$ROOT/k" "$TAKIP_BASE/state/releases/$V2.kayit" >/dev/null && [ "$(st release-healthy)" = "$V2" ] || fail "boşta çalıştırma kaydı değiştirdi"
ok "1c. kayıt yeniden çalıştırmada aynen korunur"

# ===== 2. Yeni uygulama açılmıyor =====
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-app-down-$V3"
tk _otomatik || true
[ "$(envtag)" = "$V2" ] && [ "$(running app)" = "$V2" ] && [ "$(st deployed)" = "$V2" ] && [ "$(st failed)" = "$V3" ] || fail "migration yokken önceki sürüme dönülmedi"
[ "$(st release-healthy)" = "$V2" ] && [ ! -e "$TAKIP_BASE/state/releases/$V3.kayit" ] || fail "başarısız yayın sağlıklı kaydın üzerine yazdı"
alert_has "DEPLOY_FAILED .*APP_DOWN REVERTED" || alert_has "DEPLOY_FAILED" || fail "alarm yok"
grep -q 'APP_DOWN REVERTED' "$FAKE_STATE/alerts" || fail "alarm kodları"
ok "2. açılmayan yeni sürüm (migration yok): önceki sürüme dönüldü, sağlıklı kayıt değişmedi, alarm"
fresh
V3=$(commit 1.0.2 20260201000000_yeni_tablo); touch "$FAKE_STATE/fault-app-down-$V3"
tk _otomatik || true
[ "$(mcount)" = 2 ] || fail "migration uygulanmalıydı"
[ "$(envtag)" = "$V3" ] && [ "$(st failed)" = "$V3" ] && [ "$(st release-healthy)" = "$V2" ] || fail "migration uygulanmışken eski koda dönüldü"
grep -q 'APP_DOWN NOT_REVERTED MIGRATION_CHANGED' "$FAKE_STATE/alerts" && dlog | grep -q 'OTOMATİK DÖNÜLMEDİ' || fail "elle müdahale bildirimi"
ok "2b. açılmayan yeni sürüm + migration: eski kod yeni şemayla çalıştırılmadı, elle müdahale alarmı"

# ===== 3. Yanlış sürüm / commit =====
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-version-$V3"
tk _otomatik || true
[ "$(st release-healthy)" = "$V2" ] && [ ! -e "$TAKIP_BASE/state/releases/$V3.kayit" ] || fail "yanlış sürüm sağlıklı sayıldı"
grep -q 'DEPLOY_UNHEALTHY .*VERSION' "$FAKE_STATE/alerts" || fail "VERSION alarmı"
[ "$(envtag)" = "$V3" ] || fail "gözlem kipinde servis değiştirildi"
ok "3. /surum yanlış sürüm: sağlıksız (VERSION), kayıt yok, gözlem kipinde servis değiştirilmedi"
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-gitsha-$V3"
tk _otomatik || true
grep -q "migration $V3" "$FAKE_STATE/docker.log" && fail "onaylanmayan commit'i taşıyan imaj migration'a geçti"
[ "$(envtag)" = "$V2" ] && [ "$(st failed)" = "$V3" ] && dlog | grep -q "onaylanan commit'i taşımıyor" || fail "imaj commit denetimi"
ok "3b. derlenen imaj onaylanan commit'i taşımıyor: yedek / migration / başlatma yok"

# ===== 4. Uygulama sağlıklı, işçi başarısız =====
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-worker-down-$V3"
tk _otomatik || true
grep -q 'DEPLOY_UNHEALTHY .*WORKER_DOWN.*ROLLBACK_SAFE' "$FAKE_STATE/alerts" || fail "işçi alarmı + güvenli geri dönüş değerlendirmesi"
[ "$(envtag)" = "$V3" ] && [ "$(running app)" = "$V3" ] && [ "$(st release-healthy)" = "$V2" ] && dlog | grep -q 'GÖZLEM KİPİ' || fail "gözlem kipi"
rlog_has "YAYIN_SAGLIKSIZ 1.0.2 $(short "$V3") WORKER_DOWN kip=gozlem geri_donus=SAFE" || fail "işlem kaydı"
ok "4. işçi çalışmıyor: algılandı, kaydedildi, geri dönüş GÜVENLİ hesaplandı, alarm; gözlem kipinde geçiş YOK"

# ===== 5. Geçici sağlık hatası =====
fresh
V3=$(commit 1.0.2); echo 1 >"$FAKE_STATE/worker-transient"
tk _otomatik || true
[ "$(st release-healthy)" = "$V3" ] && [ "$(st release-healthy-prev)" = "$V2" ] || fail "geçici sorun sonrası sağlıklı kaydedilmeliydi"
dlog | grep -q 'sağlık denetimi 1/3: WORKER_DOWN' && dlog | grep -q 'geçici sorunu aştı' || fail "tekrar deneme kaydı"
[ ! -s "$FAKE_STATE/alerts" ] || fail "geçici sorunda alarm gitmemeli"
ok "5. geçici sağlık hatası: sınırlı tekrar denemeyle geçti, kayıt yazıldı, alarm yok"

# ===== 6. Kalıcı sağlık hatası =====
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-probe-$V3"
tk _otomatik || true
[ "$(dlog | grep -c 'sağlık denetimi [123]/3: PROBE')" = 3 ] || fail "3 tur denenmeliydi"
grep -q 'DEPLOY_UNHEALTHY .*PROBE' "$FAKE_STATE/alerts" && [ "$(st release-healthy)" = "$V2" ] && [ "$(st failed)" = "$V3" ] || fail "kalıcı hata"
tk _otomatik || true
[ "$(grep -c "build $V3" "$FAKE_STATE/docker.log")" = 2 ] || fail "başarısız sürüm yeniden yayınlandı"  # runner + tools bir kez
ok "6. kalıcı sağlık hatası: 3 tur, sağlıksız, alarm, yeniden yayınlanmaz"

# ===== 7. Güvenli geri dönüş (elle) + 13. geri dönüş sonrası sağlık =====
fresh
m0=$(cat "$FAKE_STATE/db.migrations")
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 || fail "rollback-kontrol güvenli demeliydi: $(cat "$ROOT/rk")"
grep -q 'Geri dönüş GÜVENLİ' "$ROOT/rk" && grep -q "$(rec "$V1" app_image)" "$ROOT/rk" || fail "kontrol çıktısı"
bash "$TAKIP" rollback --onay yanlis >>"$ROOT/out" 2>&1 && fail "yanlış onayla geri dönüldü"
[ "$(envtag)" = "$V2" ] || fail "onaysız değişti"
t0=$(date +%s%N)
l0=$(wc -l <"$FAKE_STATE/docker.log")
bash "$TAKIP" rollback --onay "$(short "$V1")" >"$ROOT/rb" 2>&1 || fail "geri dönüş başarısız: $(cat "$ROOT/rb")"
ms=$((($(date +%s%N) - t0) / 1000000))
[ "$(envtag)" = "$V1" ] && [ "$(running app)" = "$V1" ] && [ "$(running worker)" = "$V1" ] && [ "$(st deployed)" = "$V1" ] || fail "uygulama + işçi v1'e geçmedi"
[ "$(st release-healthy)" = "$V1" ] && [ "$(rec "$V1" source)" = rollback ] && [ "$(st failed)" = "$V2" ] || fail "göstergeler"
[ "$(cat "$FAKE_STATE/db.migrations")" = "$m0" ] && ! tail -n +$((l0 + 1)) "$FAKE_STATE/docker.log" | grep -qE '^(migration|build)' || fail "geri dönüş veritabanına dokundu / derleme yaptı"
grep -q "probe $V1" "$FAKE_STATE/docker.log" && rlog_has "GERI_DONUS_TAMAM elle" && alert_has "ROLLBACK_DONE" || fail "yoklama / kayıt / alarm"
[ "$(git -C "$TAKIP_BASE/src" rev-parse HEAD)" = "$V1" ] || fail "kaynak v1'e geçmedi"
ok "7. elle güvenli geri dönüş: imajlar + migration + yoklama denetlendi, uygulama ve işçi birlikte v1, veritabanı değişmedi (${ms} ms, sahte docker)"
ok "13. geri dönüş sonrası tam sağlık denetimi geçti; v1 'rollback' kaynağıyla sağlıklı kaydedildi; v2 yeniden yayınlanmaz"
tk _otomatik || true
[ "$(envtag)" = "$V1" ] || fail "geri dönülen sürüm otomatik yeniden yayınlandı"
bash "$TAKIP" rollback --onay "$(short "$V1")" >"$ROOT/rb2" 2>&1 && fail "tekrar geri dönüş"
grep -q 'geri dönülecek doğrulanmış sağlıklı sürüm yok' "$ROOT/rb2" && [ "$(envtag)" = "$V1" ] || fail "tekrar çalıştırma"
ok "7b. tekrar çalıştırma güvenle reddedilir, hiçbir şey değişmez; otomatik güncelleme geri dönülen sürümü yeniden yayınlamaz"
V3=$(commit 1.0.2)
tk _otomatik || true
[ "$(st release-healthy)" = "$V3" ] && [ "$(st release-healthy-prev)" = "$V1" ] || fail "yeni commit normal yayınlanmalıydı"
ok "7c. yeni commit geri dönüşten sonra normal yayınlanır (aday: v1)"
# Gözlem kipinde sağlıksız yayından sonra elle geri dönüş: hedef son sağlıklı sürüm (v2)
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-worker-down-$V3"
tk _otomatik || true
bash "$TAKIP" rollback --onay "$(short "$V2")" >"$ROOT/rb" 2>&1 || fail "sağlıksız sürümden geri dönüş: $(cat "$ROOT/rb")"
[ "$(envtag)" = "$V2" ] && [ "$(running worker)" = "$V2" ] && [ "$(st release-healthy)" = "$V2" ] || fail "v2'ye dönülmedi"
ok "7d. sağlıksız yayından son sağlıklı sürüme elle geri dönüş"

# ===== 8. Uyumsuz migration nedeniyle red =====
fresh
V3=$(commit 1.0.2 20260301000000_kolon_eklendi)
tk _otomatik || true
[ "$(st release-healthy)" = "$V3" ] && [ "$(st release-healthy-prev)" = "$V2" ] || fail "migration'lı yayın"
dlog | grep -q 'bu yayın 1 migration uygular (20260301000000_kolon_eklendi)' || fail "ön denetim migration planı"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "uyumsuz migration'da güvenli dendi"
grep -q 'MIGRATION_CHANGED' "$ROOT/rk" && grep -q '+20260301000000_kolon_eklendi' "$ROOT/rk" || fail "red gerekçesi"
bash "$TAKIP" rollback --onay "$(short "$V2")" >"$ROOT/rb" 2>&1 && fail "uyumsuz migration'da geri dönüldü"
[ "$(envtag)" = "$V3" ] && [ "$(mcount)" = 2 ] && rlog_has 'GERI_DONUS_RED elle' || fail "red sonrası durum"
ok "8. hedeften sonra migration uygulanmış: kontrol ve geri dönüş reddedildi; servis, veritabanı değişmedi"
# Checksum değişikliği (aynı ad, farklı içerik) de uyumsuzluktur
fresh
sed -i "s/ [0-9a-f]*$/ 00ff/" "$FAKE_STATE/db.migrations"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "checksum farkında güvenli dendi"
grep -q 'MIGRATION_CHANGED' "$ROOT/rk" || fail "checksum farkı"
ok "8b. migration adı aynı ama checksum farklı: uyumsuz sayılır"
fresh
echo 1 >"$FAKE_STATE/db.failed"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "yarım migration'da güvenli dendi"
grep -q 'MIGRATION_FAILED' "$ROOT/rk" || fail "yarım migration"
ok "8c. yarım kalmış migration: geri dönüş reddedilir"
fresh
touch "$FAKE_STATE/fault-probe-$V1"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "yoklama hatasında güvenli dendi"
grep -q '\[PROBE\]' "$ROOT/rk" || fail "yoklama hatası"
ok "8d. hedefin salt okunur yoklaması başarısız: geri dönüş reddedilir"

# ===== 9. Eski imaj eksik + imaj koruması =====
fresh
rm -f "$FAKE_STATE/img/$V1"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "imaj yokken güvenli dendi"
grep -q 'IMAGE_MISSING' "$ROOT/rk" || fail "imaj eksik gerekçesi"
bash "$TAKIP" rollback --onay "$(short "$V1")" >>"$ROOT/out" 2>&1 && fail "imaj yokken geri dönüldü"
[ "$(envtag)" = "$V2" ] || fail "imaj yokken servis değişti"
ok "9. hedef imaj eksik: reddedildi, servis değişmedi"
fresh
echo "sha256:baska" >"$FAKE_STATE/img/$V1-tools"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "imaj değişmişken güvenli dendi"
grep -q 'IMAGE_CHANGED' "$ROOT/rk" || fail "imaj değişti gerekçesi"
ok "9b. hedef imaj kimliği kayıttakinden farklı: reddedildi"
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-worker-down-$V3"; tk _otomatik || true
V4=$(commit 1.0.3); touch "$FAKE_STATE/fault-worker-down-$V4"; tk _otomatik || true
V5=$(commit 1.0.4); tk _otomatik || true
[ "$(st release-healthy)" = "$V5" ] && [ "$(st release-healthy-prev)" = "$V2" ] || fail "aday son sağlıklı sürüm olmalı"
for t in "$V5" "$V2" "$V4"; do [ -f "$FAKE_STATE/img/$t" ] && [ -f "$FAKE_STATE/img/$t-tools" ] || fail "korunan imaj silindi: $(short "$t")"; done
[ ! -f "$FAKE_STATE/img/$V1" ] && [ ! -f "$FAKE_STATE/img/$V3" ] || fail "korunmayan eski imaj kaldı"
ok "9c. temizlik: yayındaki, bir önceki ve geri dönüş adayı (araya giren sağlıksız yayınlara rağmen) korundu; diğerleri silindi"

# ===== 10. Eşzamanlı iki yayın =====
fresh
V3=$(commit 1.0.2)
printf '#!/usr/bin/env bash\nsleep 4\n' >"$FAKE_STATE/on-build"; chmod +x "$FAKE_STATE/on-build"
bash "$TAKIP" _otomatik >>"$ROOT/out" 2>&1 &
p1=$!
sleep 1.5
bash "$TAKIP" guncelle >"$ROOT/g2" 2>&1 || true
wait "$p1" || true
grep -q 'Başka bir güncelleme sürüyor' "$ROOT/g2" || fail "ikinci yayın kilidi beklemeliydi"
[ "$(grep -c "^build $V3\$" "$FAKE_STATE/docker.log")" = 1 ] && [ "$(grep -c "migration $V3" "$FAKE_STATE/docker.log")" = 1 ] || fail "iki yayın birlikte çalıştı"
[ "$(st release-healthy)" = "$V3" ] || fail "ilk yayın tamamlanmalıydı"
ok "10. eşzamanlı iki yayın: ikincisi kilitte durdu, tek derleme / tek migration"

# ===== 11. Yayın sırasında geri dönüş isteği =====
fresh
V3=$(commit 1.0.2)
printf '#!/usr/bin/env bash\nsleep 4\n' >"$FAKE_STATE/on-build"; chmod +x "$FAKE_STATE/on-build"
bash "$TAKIP" _otomatik >>"$ROOT/out" 2>&1 &
p1=$!
sleep 1.5
bash "$TAKIP" rollback --onay "$(short "$V1")" >"$ROOT/rb" 2>&1 && fail "yayın sürerken geri dönüldü"
bash "$TAKIP" rollback-kontrol >"$ROOT/rk" 2>&1 && fail "yayın sürerken kontrol güvenli dedi"
wait "$p1" || true
grep -q 'sürüyor' "$ROOT/rb" && grep -q '\[BUSY\]' "$ROOT/rk" && rlog_has 'GERI_DONUS_RED elle BUSY' || fail "meşgul gerekçesi"
[ "$(st release-healthy)" = "$V3" ] && [ "$(envtag)" = "$V3" ] || fail "yayın kesildi"
ok "11. yayın sürerken geri dönüş: reddedildi (kilit), yayın kesilmeden tamamlandı"

# ===== 12. İşlem ortasında kesinti =====
fresh
V3=$(commit 1.0.2)
touch "$FAKE_STATE/kill-at-up"
tk _otomatik || true
[ -s "$TAKIP_BASE/state/release-op" ] && grep -q '^op=deploy' "$TAKIP_BASE/state/release-op" || fail "kesintide işlem işareti kalmalı"
[ "$(running app)" = "$V3" ] && [ "$(running worker)" = "$V2" ] || fail "kesinti benzetimi (uygulama yeni, işçi eski)"
tk _otomatik || true
[ ! -e "$TAKIP_BASE/state/release-op" ] && dlog | grep -q 'yarıda kalmış işlem bulundu: deploy' && grep -q 'INTERRUPTED .*OP_DEPLOY' "$FAKE_STATE/alerts" || fail "yarıda kalan yayın algılanmadı"
[ "$(running app)" = "$V3" ] && [ "$(running worker)" = "$V3" ] && [ "$(st release-healthy)" = "$V3" ] || fail "yarıda kalan yayın tamamlanmadı (uygulama/işçi uyumsuz kaldı)"
ok "12. yayın ortasında kesinti: işaret kaldı → sonraki çalıştırma algıladı, alarm, yayın yeniden denendi; uygulama + işçi aynı sürüm"
fresh
touch "$FAKE_STATE/kill-at-up"
bash "$TAKIP" rollback --onay "$(short "$V1")" >>"$ROOT/out" 2>&1 || true
grep -q '^op=rollback' "$TAKIP_BASE/state/release-op" && [ "$(running app)" = "$V1" ] && [ "$(running worker)" = "$V2" ] || fail "geri dönüş kesintisi benzetimi"
tk _otomatik || true
[ ! -e "$TAKIP_BASE/state/release-op" ] && [ "$(running app)" = "$V1" ] && [ "$(running worker)" = "$V1" ] && [ "$(st deployed)" = "$V1" ] && [ "$(st release-healthy)" = "$V1" ] || fail "yarıda kalan geri dönüş tamamlanmadı"
grep -q 'INTERRUPTED .*OP_ROLLBACK' "$FAKE_STATE/alerts" && rlog_has 'GERI_DONUS_TAMAM devam' || fail "geri dönüş kesintisi kaydı"
[ "$(envtag)" = "$V1" ] && ! sed -n '/KESINTI/,$p' "$FAKE_STATE/docker.log" | grep -qE '^(migration|build)' || fail "kurtarmada migration / derleme çalıştı"
ok "12b. geri dönüş ortasında kesinti: aynı denetimlerle tamamlandı, uygulama + işçi v1, veritabanına dokunulmadı"

fresh
touch "$FAKE_STATE/kill-at-up"
bash "$TAKIP" rollback --onay "$(short "$V1")" >>"$ROOT/out" 2>&1 || true
bash "$TAKIP" rollback --onay "$(short "$V1")" >"$ROOT/rb" 2>&1 && fail "kurtarmadan sonra ikinci geri dönüş başlamamalı"
grep -q 'Yarıda kalmış bir işlem bulundu ve ele alındı' "$ROOT/rb" && [ "$(running worker)" = "$V1" ] && [ "$(st release-healthy)" = "$V1" ] || fail "elle komutla kurtarma"
[ "$(grep -c 'GERI_DONUS_TAMAM' "$TAKIP_BASE/logs/release.log")" = 1 ] || fail "tek geri dönüş olmalı"
ok "12c. yarıda kalan geri dönüş elle komutla tamamlanır; aynı komut ikinci bir geri dönüş başlatmaz"

# ===== 14. Geri dönüş başarısızlığı ve alarm =====
fresh
touch "$FAKE_STATE/fault-app-down-$V1"
bash "$TAKIP" rollback --onay "$(short "$V1")" >"$ROOT/rb" 2>&1 && fail "sağlıksız geri dönüş başarılı sayıldı"
grep -q 'ROLLBACK_FAILED .*APP_DOWN' "$FAKE_STATE/alerts" && rlog_has 'GERI_DONUS_SAGLIKSIZ elle' && grep -q 'ELLE MÜDAHALE' "$ROOT/rb" || fail "başarısız geri dönüş alarmı"
[ "$(st release-healthy)" = "$V2" ] || fail "sağlıksız geri dönüş sağlıklı kaydı değiştirdi"
ok "14. geri dönüş sonrası sağlık geçmedi: ROLLBACK_FAILED alarmı, elle müdahale, sağlıklı kayıt korunuyor"
fresh
touch "$FAKE_STATE/fault-alert"
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-worker-down-$V3"
tk _otomatik || true
rlog_has 'ALARM_GONDERILEMEDI DEPLOY_UNHEALTHY' && [ "$(st failed)" = "$V3" ] || fail "alarm gönderilemedi kaydı"
ok "14b. alarm e-postası gönderilemezse işlem kaydına düşer, sonuç değişmez"

# ===== Otomatik kip (yalnızca sahibin onayıyla açılır; burada mantığı sınanır) =====
fresh
bash "$TAKIP" rollback-modu otomatik >>"$ROOT/out" 2>&1
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-worker-down-$V3"
tk _otomatik || true
[ "$(envtag)" = "$V2" ] && [ "$(running worker)" = "$V2" ] && rlog_has 'GERI_DONUS_TAMAM otomatik' || fail "otomatik kipte güvenli geri dönüş"
ok "otomatik kip: sağlıksız yayın + güvenli → son sağlıklı sürüme dönüldü"
fresh
bash "$TAKIP" rollback-modu otomatik >>"$ROOT/out" 2>&1
V3=$(commit 1.0.2 20260401000000_yeni); touch "$FAKE_STATE/fault-worker-down-$V3"
tk _otomatik || true
[ "$(envtag)" = "$V3" ] && grep -q 'ROLLBACK_UNSAFE MIGRATION_CHANGED' "$FAKE_STATE/alerts" || fail "otomatik kipte uyumsuz migration'da dönülmemeli"
ok "otomatik kip: migration uygulanmışsa geri dönülmez, GÜVENLİ DEĞİL alarmı"
bash "$TAKIP" rollback-modu bilinmeyen >>"$ROOT/out" 2>&1 && fail "geçersiz kip kabul edildi"
ok "geçersiz kip reddedilir"

# ===== Diğer: yayın öncesi veritabanı, ilk kayıt (bootstrap), uyumsuz imaj, belge değişikliği =====
fresh
V3=$(commit 1.0.2); touch "$FAKE_STATE/fault-db"
tk _otomatik || true
grep -q "migration $V3" "$FAKE_STATE/docker.log" && fail "veritabanına erişilemezken migration"
[ "$(envtag)" = "$V2" ] && dlog | grep -q "PostgreSQL'e erişilemiyor" && [ -z "$(st failed)" ] || fail "yayın öncesi veritabanı denetimi"
ok "yayın öncesi: PostgreSQL erişilemezse yayın başlamaz (yeniden denenir)"
fresh
rm -f "$TAKIP_BASE/state/releases/"* "$TAKIP_BASE/state/release-healthy" "$TAKIP_BASE/state/release-healthy-prev"
tk _otomatik || true
[ "$(st release-healthy)" = "$V2" ] && [ "$(rec "$V2" source)" = bootstrap ] || fail "ilk kayıt (bootstrap)"
ok "kayıt yokken (3.92.0'ın ilk yayını aracın eski sürümüyle yapılır) boşta denetim yayındaki sürümü doğrulayıp kaydeder"
fresh
echo "sha256:baska" >"$FAKE_STATE/ct/worker.img"
tk _otomatik || true; tk _otomatik || true
[ "$(grep -c 'MISMATCH' "$FAKE_STATE/alerts")" = 1 ] || fail "uygulama/işçi uyumsuzluğu bir kez bildirilmeli"
ok "boşta: uygulama / işçi imaj uyumsuzluğu algılanır ve bir kez bildirilir"
fresh
D=$(commit 1.0.1 '' docs/not.md)
tk _otomatik || true
[ "$(st release-healthy)" = "$D" ] && [ "$(rec "$D" tag)" = "$V2" ] && [ "$(st release-healthy-prev)" = "$V1" ] || fail "yalnızca belge değişikliği kaydı"
ok "yalnızca belge değişikliği: aynı imajlarla kaydedilir, geri dönüş adayı değişmez"

# ===== 15. Gizli bilgiler günlüklere / duruma / alarmlara sızmaz =====
# (son ortam + bütün senaryoların çıktısı: günlükler, durum dosyaları, kayıtlar, alarm argümanları, komut çıktıları)
for s in "${SECRETS[@]}"; do
  if grep -rqF -- "$s" "$TAKIP_BASE/logs" "$TAKIP_BASE/state" "$FAKE_STATE/alerts" "$ROOT/out" "$ROOT/sd" "$ROOT/rk" "$ROOT/rb" 2>/dev/null; then fail "gizli değer sızdı: $s"; fi
done
ok "15. gizli değerler (veritabanı / SMTP / oturum / GitHub / Telegram / OpenAI) günlüklere, kayıtlara, alarmlara sızmadı"

# ===== Yalnızca root =====
if command -v setpriv >/dev/null 2>&1; then
  NB=$(mktemp -d)
  chmod 755 "$NB"
  cp "$TAKIP" "$NB/takip.sh"
  mkdir -p "$NB/base" && chown -R 65534:65534 "$NB/base"
  for c in surum-durum rollback-durum rollback-kontrol rollback 'rollback-modu otomatik' surum-dogrula; do
    # shellcheck disable=SC2086 # komut + argüman bilerek ayrı
    out=$(setpriv --reuid=65534 --regid=65534 --clear-groups env TAKIP_BASE="$NB/base" bash "$NB/takip.sh" $c 2>&1 || true)
    case $out in *'root olarak çalıştırılmalı'*) ;; *) rm -rf "$NB"; fail "root olmayan kullanıcı ($c): $out" ;; esac
  done
  [ ! -e "$NB/base/state/rollback-mode" ] || fail "root olmayan kullanıcı kipi değiştirdi"
  rm -rf "$NB"
  ok "geri dönüş / sürüm komutları yalnızca root (root olmayan kullanıcı hiçbir şey değiştiremez)"
fi

echo "✔ yayın sağlığı ve geri dönüş: $n kontrol geçti"
