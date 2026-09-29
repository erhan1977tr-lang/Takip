#!/usr/bin/env bash
# Takip sunucu aracı. deploy/install.sh bunu /usr/local/bin/takip olarak kurar.
#
#   takip durum                      yayındaki sürüm, son güncellemeler, servisler
#   takip guncelle                   GitHub'da testlerden geçmiş yeni sürüm varsa hemen yayınla
#   takip smtp                       e-posta (SMTP) ayarlarını gir ve deneme e-postası gönder
#   takip yonetici E-POSTA "AD" [--reset]   yönetici hesabı aç (ya da şifresini sıfırla) → tek kullanımlık kod
#   takip yedek                      veritabanı ve dosyaların yedeğini al (her gece kendiliğinden de alınır)
#   takip log [SATIR]                uygulamanın son günlük satırları
#   takip dal [AD]                   otomatik güncellemenin izlediği GitHub dalı (varsayılan: backend)
#   takip github                     GitHub erişim anahtarını (token) yenile
#
# Otomatik güncelleme (systemd: takip-deploy.timer, 2 dakikada bir → takip _otomatik):
#   izlenen daldaki son commit GitHub'daki CI testlerinden geçtiyse sunucuda derlenir,
#   veritabanı yedeklenir, migration uygulanır ve yeni sürüm başlatılır. Açılmazsa önceki sürüme dönülür.
#   Testlerden geçmeyen commit hiç yayınlanmaz. Depo özel: GitHub'a /opt/takip/github-token ile bağlanılır.
set -Eeuo pipefail

# Güncelleme sırasında bu dosya git tarafından değiştirilebilir; bash betiği satır satır okuduğu için
# önce geçici bir kopyaya geçilir.
if [ -z "${TAKIP_REEXEC:-}" ]; then
  tmp=$(mktemp /tmp/takip.XXXXXX)
  cp "$(readlink -f "$0")" "$tmp"
  TAKIP_REEXEC="$tmp" exec bash "$tmp" "$@"
fi
trap 'rm -f "$TAKIP_REEXEC"' EXIT

BASE=${TAKIP_BASE:-/opt/takip}
SRC=$BASE/src
ENV_FILE=$BASE/.env
STATE=$BASE/state
LOGS=$BASE/logs
BACKUPS=$BASE/backups
REPO_SLUG=${TAKIP_REPO:-erhan1977tr-lang/Takip}
API=https://api.github.com/repos/$REPO_SLUG
TOKEN_FILE=$BASE/github-token
CI_WORKFLOW=CI
VERBOSE=${VERBOSE:-0}

mkdir -p "$STATE" "$LOGS" "$BACKUPS"

say() { echo "$*"; }
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOGS/deploy.log"; }
info() { if [ "$VERBOSE" = 1 ]; then echo "$*"; fi; }
compose() { docker compose -p takip --env-file "$ENV_FILE" -f "$SRC/deploy/docker-compose.yml" "$@"; }
branch() { cat "$STATE/branch" 2>/dev/null || echo backend; }
short() { echo "${1:0:7}"; }
version_of() { git -C "$SRC" show "$1:package.json" 2>/dev/null | jq -r .version 2>/dev/null || echo '?'; }
tty_read() { # tty_read DEĞİŞKEN "soru" [gizli]
  local __v
  if [ "${3:-}" = gizli ]; then read -rsp "$2" __v </dev/tty; echo >/dev/tty; else read -rp "$2" __v </dev/tty; fi
  printf -v "$1" '%s' "$__v"
}

# ---------- .env ----------
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e "s/^'\(.*\)'$/\1/" -e 's/^"\(.*\)"$/\1/'; }
# Değer olduğu gibi yazılır (tırnaklama çağıranın işi); sed kullanılmaz ki şifredeki özel karakterler bozulmasın.
env_set() {
  local tmp; tmp=$(mktemp "$ENV_FILE.XXXX")
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Aynı hata her 2 dakikada bir tekrar yazılmasın: yalnızca değişince kayda geçer (stdout'a yazmaz).
note_error() {
  if [ "$*" != "$(cat "$STATE/last_error" 2>/dev/null || true)" ]; then
    echo "$*" >"$STATE/last_error"
    echo "$(date '+%Y-%m-%d %H:%M:%S') ✘ $*" >>"$LOGS/deploy.log"
  fi
  echo "✘ $*" >&2
}
clear_error() { rm -f "$STATE/last_error"; }

# ---------- GitHub ----------
# Depo özel (private): sunucu, yalnızca okuma izinli bir erişim anahtarıyla (fine-grained token) bağlanır.
# Anahtar yalnızca $TOKEN_FILE dosyasında durur (chmod 600); uygulamanın ortamına girmez.
token() { if [ -n "${GITHUB_TOKEN:-}" ]; then echo "$GITHUB_TOKEN"; else cat "$TOKEN_FILE" 2>/dev/null || true; fi; }
gh_curl() { # gh_curl YOL → gövde + son satırda HTTP kodu
  local t a=(-sS --max-time 20 -w '\n%{http_code}' -H 'Accept: application/vnd.github+json')
  t=$(token)
  if [ -n "$t" ]; then a+=(-H "Authorization: Bearer $t"); fi
  curl "${a[@]}" "$API$1"
}

# ---------- CI kontrolü ----------
# Bir commit'in GitHub Actions'taki "CI" iş akışı sonucu: success | failure | pending | none | cancelled
# (stdout'a yalnızca sonuç yazılır)
ci_state() {
  local resp code run st co
  resp=$(gh_curl "/actions/runs?head_sha=$1&per_page=30") || { echo pending; return; }
  code=${resp##*$'\n'}
  resp=${resp%$'\n'*}
  case $code in
    200) ;;
    401 | 403 | 404)
      note_error "GitHub anahtarı geçersiz, süresi dolmuş ya da izni eksik (HTTP $code). Yenilemek için: takip github"
      echo pending
      return
      ;;
    *) echo pending; return ;;
  esac
  run=$(jq -c --arg n "$CI_WORKFLOW" '[.workflow_runs[] | select(.name == $n)] | sort_by(.created_at) | last // empty' <<<"$resp")
  if [ -z "$run" ]; then echo none; return; fi
  st=$(jq -r .status <<<"$run")
  co=$(jq -r .conclusion <<<"$run")
  if [ "$st" != completed ]; then echo pending
  elif [ "$co" = success ]; then echo success
  elif [ "$co" = cancelled ]; then echo cancelled
  else echo failure; fi
}

# Commit yayınlanabilir mi? CI'nin kendisinin yazdığı commit'ler (kilit dosyası, migration) CI başlatmaz;
# onların içeriğini bir önceki commit'in CI koşusu üretip test ettiği için o koşunun sonucu geçerlidir.
gate() {
  local sha=$1 s info email subject parents
  if [ "${TAKIP_SKIP_CI_GATE:-0}" = 1 ]; then echo success; return; fi
  for _ in 1 2 3 4 5; do
    s=$(ci_state "$sha")
    case $s in success | pending | failure) echo "$s"; return ;; esac
    info=$(git -C "$SRC" log -1 --format='%ae%x09%s%x09%P' "$sha")
    email=${info%%$'\t'*}; info=${info#*$'\t'}; subject=${info%%$'\t'*}; parents=${info#*$'\t'}
    if [[ $email == *github-actions* && $subject == CI:* && -n $parents ]]; then
      sha=${parents%% *}
      continue
    fi
    if [ "$s" = cancelled ]; then echo failure; else echo pending; fi
    return
  done
  echo pending
}

# ---------- yedek ----------
backup_db() { # backup_db ETİKET
  if ! compose ps --status running -q db 2>/dev/null | grep -q .; then return 0; fi
  local f; f="$BACKUPS/db-$(date +%Y%m%d-%H%M%S)-$1.dump"
  if compose exec -T db pg_dump -U takip -d takip -Fc >"$f.tmp"; then
    mv "$f.tmp" "$f"
    find "$BACKUPS" -name 'db-*.dump' -mtime +14 -delete
    echo "$f"
  else
    rm -f "$f.tmp"
    return 1
  fi
}
backup_files() {
  local tag; tag=$(env_get APP_TAG)
  [ -n "$tag" ] && docker image inspect "takip:$tag" >/dev/null 2>&1 || return 0
  local f; f="$BACKUPS/dosyalar-$(date +%Y%m%d-%H%M%S).tgz"
  docker run --rm --user 0 -v takip_uploads:/u:ro -v "$BACKUPS":/b "takip:$tag" tar czf "/b/$(basename "$f")" -C /u .
  find "$BACKUPS" -name 'dosyalar-*.tgz' -mtime +7 -delete
  echo "$f"
}

wait_healthy() { # wait_healthy SANİYE
  local end=$((SECONDS + ${1:-180})) id s
  while [ $SECONDS -lt $end ]; do
    id=$(compose ps -q app 2>/dev/null || true)
    s=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo yok)
    [ "$s" = healthy ] && return 0
    sleep 5
  done
  return 1
}

# ---------- yayınlama ----------
do_deploy() { # do_deploy SHA ÖNCEKİ_SHA
  local sha=$1 prev=${2:-} s ver f prev_tag
  s=$(short "$sha"); ver=$(version_of "$sha")
  log "▶ $ver ($s) yayınlanıyor…"

  # Yalnızca test / belge değiştiyse uygulama yeniden derlenmez
  if [ -n "$prev" ] && git -C "$SRC" cat-file -e "$prev^{commit}" 2>/dev/null &&
    git -C "$SRC" diff --quiet "$prev" "$sha" -- . ':(exclude)e2e' ':(exclude)test' ':(exclude)docs' \
      ':(exclude)*.md' ':(exclude).github' ':(exclude)prototype'; then
    git -C "$SRC" checkout --quiet --force "$sha"
    echo "$sha" >"$STATE/deployed"
    log "✔ $ver ($s): yalnızca test/belge değişti, uygulama olduğu gibi çalışıyor."
    return 0
  fi

  git -C "$SRC" checkout --quiet --force "$sha"
  local blog="$LOGS/derleme-$s.log"
  if ! { docker build --build-arg GIT_SHA="$sha" --target runner -t "takip:$sha" "$SRC" &&
    docker build --build-arg GIT_SHA="$sha" --target tools -t "takip:$sha-tools" "$SRC"; } >"$blog" 2>&1; then
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    echo "$sha" >"$STATE/failed"
    log "✘ $ver ($s): derleme başarısız, önceki sürüm çalışmaya devam ediyor. Ayrıntı: $blog"
    return 1
  fi

  if ! f=$(backup_db "once-$s"); then
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    log "✘ $ver ($s): veritabanı yedeği alınamadı; güvenlik için yayınlanmadı (bir sonraki denemede tekrar denenecek)."
    return 1
  fi
  [ -n "$f" ] && log "  yedek: $f"

  prev_tag=$(env_get APP_TAG)
  env_set APP_IMAGE takip
  env_set APP_TAG "$sha"
  compose up -d db >>"$blog" 2>&1
  if ! compose run --rm tools >>"$blog" 2>&1; then
    env_set APP_TAG "$prev_tag"
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    echo "$sha" >"$STATE/failed"
    log "✘ $ver ($s): veritabanı güncellemesi (migration) başarısız; önceki sürüm çalışmaya devam ediyor."
    log "  Ayrıntı: $blog · Güncelleme öncesi yedek: ${f:-yok}"
    return 1
  fi

  compose up -d --remove-orphans >>"$blog" 2>&1
  if [ -n "$prev" ] && ! git -C "$SRC" diff --quiet "$prev" "$sha" -- deploy/Caddyfile 2>/dev/null; then
    compose restart caddy >>"$blog" 2>&1 || true
  fi

  if ! wait_healthy 240; then
    log "✘ $ver ($s): yeni sürüm açılmadı; önceki sürüme dönülüyor. Ayrıntı: takip log"
    if [ -n "$prev_tag" ] && [ "$prev_tag" != "$sha" ]; then
      env_set APP_TAG "$prev_tag"
      [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
      compose up -d --remove-orphans >>"$blog" 2>&1 || true
    fi
    echo "$sha" >"$STATE/failed"
    return 1
  fi

  echo "$sha" >"$STATE/deployed"
  rm -f "$STATE/failed"
  log "✔ $ver ($s) yayında: $(env_get APP_URL)"

  # Eski imajlar: yalnızca yayındaki ve bir önceki sürüm tutulur
  local keep1=$sha keep2=$prev_tag t
  for t in $(docker images takip --format '{{.Tag}}'); do
    case $t in "$keep1" | "$keep1-tools" | "$keep2" | "$keep2-tools") ;; *) docker rmi "takip:$t" >/dev/null 2>&1 || true ;; esac
  done
  docker image prune -f >/dev/null 2>&1 || true
}

auto_deploy() {
  exec 9>"$STATE/deploy.lock"
  if ! flock -n 9; then info "Başka bir güncelleme sürüyor."; return 0; fi
  local b head current g
  b=$(branch)
  if ! git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$b:refs/remotes/origin/$b" 2>"$STATE/fetch.err"; then
    note_error "GitHub'dan güncelleme alınamadı: $(tr '\n' ' ' <"$STATE/fetch.err" | cut -c1-200) — anahtarın süresi dolmuş olabilir: takip github"
    return 1
  fi
  head=$(git -C "$SRC" rev-parse "origin/$b")
  current=$(cat "$STATE/deployed" 2>/dev/null || true)
  if [ "$head" = "$current" ]; then info "Güncel: $(version_of "$head") ($(short "$head"))."; return 0; fi
  if [ "$head" = "$(cat "$STATE/failed" 2>/dev/null || true)" ]; then
    info "$(short "$head") daha önce yayınlanamadı; yeni bir güncelleme bekleniyor."
    return 0
  fi
  g=$(gate "$head")
  [ -f "$STATE/last_error" ] && grep -q 'GitHub' "$STATE/last_error" && [ "$g" != pending ] && clear_error
  case $g in
    pending) info "$(short "$head") için testler sürüyor; bitince yayınlanacak."; return 0 ;;
    failure)
      echo "$head" >"$STATE/failed"
      log "✘ $(version_of "$head") ($(short "$head")) testlerden geçmedi; yayınlanmadı."
      return 0
      ;;
  esac
  do_deploy "$head" "$current"
}

# İlk kurulum: daldaki en yeni, testlerden geçmiş commit yayınlanır.
first_deploy() {
  exec 9>"$STATE/deploy.lock"
  flock 9
  local b sha g
  b=$(branch)
  git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$b:refs/remotes/origin/$b"
  for sha in $(git -C "$SRC" rev-list --first-parent -n 30 "origin/$b"); do
    # Bu araçtan önceki sürümler bu düzenle yayınlanamaz
    git -C "$SRC" cat-file -e "$sha:deploy/takip.sh" 2>/dev/null || break
    g=$(gate "$sha")
    if [ "$g" = success ]; then
      if [ "$sha" = "$(cat "$STATE/deployed" 2>/dev/null || true)" ]; then
        log "✔ $(version_of "$sha") ($(short "$sha")) zaten yayında."
        return 0
      fi
      do_deploy "$sha" "$(cat "$STATE/deployed" 2>/dev/null || true)"
      return $?
    fi
  done
  log "✘ '$b' dalında testlerden geçmiş commit bulunamadı."
  return 1
}

# ---------- komutlar ----------
cmd_status() {
  local d; d=$(cat "$STATE/deployed" 2>/dev/null || true)
  if [ -s "$STATE/last_error" ]; then say "⚠ Son hata: $(cat "$STATE/last_error")"; say ""; fi
  say "Adres    : $(env_get APP_URL)"
  say "Dal      : $(branch)"
  if [ -n "$d" ]; then
    say "Yayında  : $(version_of "$d") ($(short "$d")) — $(git -C "$SRC" log -1 --format='%cd' --date=format:'%d.%m.%Y %H:%M' "$d")"
  else
    say "Yayında  : —"
  fi
  if grep -qE '^SMTP_HOST=.+' "$ENV_FILE"; then say "E-posta  : $(env_get SMTP_HOST) ($(env_get SMTP_USER))"; else say "E-posta  : ayarlanmadı → takip smtp"; fi
  say ""
  say "Son olaylar:"
  tail -n 10 "$LOGS/deploy.log" 2>/dev/null | sed 's/^/  /' || true
  say ""
  compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || true
  say ""
  df -h / | awk 'NR==2 { print "Disk     : " $3 " / " $2 " dolu (" $5 ")" }'
  say "Yedekler : $(find "$BACKUPS" -name 'db-*.dump' | wc -l) veritabanı yedeği, son: $(ls -1t "$BACKUPS"/db-*.dump 2>/dev/null | head -1 | xargs -r basename)"
}

cmd_smtp() {
  say "E-posta (SMTP) ayarları. Şifre ekranda görünmez ve yalnızca bu sunucudaki $ENV_FILE dosyasına yazılır."
  say "Örnekler: Gmail/Google Workspace → smtp.gmail.com 587 (uygulama şifresi gerekir) · Microsoft 365 → smtp.office365.com 587"
  local host port user pass from to
  tty_read host "SMTP sunucusu: "
  tty_read port "Port [587]: "; port=${port:-587}
  tty_read user "Kullanıcı (genelde e-posta adresi): "
  tty_read pass "Şifre: " gizli
  tty_read from "Gönderen [Takip <$user>]: "; from=${from:-"Takip <$user>"}
  if [ -z "$host" ] || [ -z "$user" ] || [ -z "$pass" ]; then say "Sunucu, kullanıcı ve şifre gerekli; hiçbir şey değişmedi."; return 1; fi
  if [[ $pass == *"'"* ]]; then say "Şifrede ' (tek tırnak) karakteri olamaz; hiçbir şey değişmedi."; return 1; fi
  if [[ $from == *'"'* || $from == *'$'* ]]; then say "Gönderen adında \" ya da \$ olamaz; hiçbir şey değişmedi."; return 1; fi
  env_set SMTP_HOST "$host"
  env_set SMTP_PORT "$port"
  env_set SMTP_USER "$user"
  env_set SMTP_PASS "'$pass'"
  env_set MAIL_FROM "\"$from\""
  compose up -d app >/dev/null 2>&1
  say "✔ Kaydedildi, uygulama yeni ayarlarla başlatıldı."
  tty_read to "Deneme e-postası gidecek adres (boş bırakırsan atlanır): "
  if [ -n "$to" ]; then compose run --rm tools node scripts/test-mail.mjs "$to" tr; fi
}

cmd_admin() {
  local email=${1:-} name=${2:-} factory
  if [ $# -ge 2 ]; then shift 2; else shift $#; fi
  if [ -z "$email" ]; then say 'Kullanım: takip yonetici E-POSTA "Ad Soyad" [--reset]'; return 1; fi
  factory=$(env_get FACTORY_NAME); factory=${factory:-GKH Trading}
  compose run --rm tools node scripts/create-admin.mjs "$email" "$name" --factory "$factory" "$@"
}

cmd_github() {
  say "GitHub erişim anahtarı (fine-grained token): yalnızca Takip deposu; izinler: Contents → Read-only, Actions → Read-only."
  say "Oluşturmak için: github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens."
  local t code
  tty_read t "Anahtar (yazarken görünmez): " gizli
  [ -n "$t" ] || { say "Boş bırakıldı; hiçbir şey değişmedi."; return 1; }
  code=$(GITHUB_TOKEN=$t gh_curl "" | tail -n1 || true)
  [ "$code" = 200 ] || { say "✘ Anahtar Takip deposunu okuyamıyor (HTTP $code). Depo erişimi ve Contents: Read iznini kontrol edin."; return 1; }
  code=$(GITHUB_TOKEN=$t gh_curl "/actions/runs?per_page=1" | tail -n1 || true)
  [ "$code" = 200 ] || { say "✘ Anahtarda 'Actions: Read-only' izni eksik (HTTP $code)."; return 1; }
  (umask 077 && printf '%s\n' "$t" >"$TOKEN_FILE")
  clear_error
  say "✔ Anahtar kaydedildi ($TOKEN_FILE). Otomatik güncelleme bununla devam edecek."
}

cmd_backup() {
  local f g
  f=$(backup_db elle) || { say "✘ Veritabanı yedeği alınamadı."; return 1; }
  g=$(backup_files) || { say "✘ Dosya yedeği alınamadı."; return 1; }
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  say "✔ Yedek: ${f:-—}"
  say "✔ Dosyalar: ${g:-—}"
  say "Not: yedekler bu sunucuda duruyor ($BACKUPS). Sunucu dışına kopyalanması ayrıca ayarlanacak."
}

main() {
  local cmd=${1:-durum}
  shift || true
  case $cmd in
    durum | status) cmd_status ;;
    guncelle | update) VERBOSE=1 auto_deploy ;;
    _otomatik) auto_deploy ;;
    _ilk) first_deploy ;;
    _ci) gate "$(git -C "$SRC" rev-parse "$1")" ;;
    github) cmd_github ;;
    smtp) cmd_smtp ;;
    yonetici | admin) cmd_admin "$@" ;;
    yedek | backup) cmd_backup ;;
    log | logs) compose logs --no-log-prefix --tail="${1:-200}" app ;;
    dal)
      if [ -n "${1:-}" ]; then echo "$1" >"$STATE/branch"; rm -f "$STATE/failed"; say "Otomatik güncelleme artık '$1' dalını izliyor."; else branch; fi
      ;;
    *)
      sed -n '2,11p' "$TAKIP_REEXEC" | sed 's/^# \{0,1\}//'
      return 1
      ;;
  esac
}

main "$@"
