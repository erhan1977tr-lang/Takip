#!/usr/bin/env bash
# Takip sunucu aracı. deploy/install.sh bunu /usr/local/bin/takip olarak kurar.
#
#   takip durum                      yayındaki sürüm, son güncellemeler, servisler
#   takip guncelle                   GitHub'da testlerden geçmiş yeni sürüm varsa hemen yayınla
#   takip smtp                       e-posta (SMTP) ayarlarını gir ve deneme e-postası gönder
#   takip yonetici E-POSTA "AD"     YENİ yönetici hesabı aç → tek kullanımlık kod (var olan hesabın rolü / şifresi değişmez)
#   takip yonetici-kurtar E-POSTA    VAR OLAN yönetici hesabına acil erişim: yeni şifre (gizli girilir), oturumlar kapanır
#   takip yedek                      veritabanı + dosya yedeği, Google Drive'a kopya (her gün 03:00'te kendiliğinden)
#   takip yedek-kontrol [durum]      yedek bekçisi: sorun / 26 saattir başarılı yedek yoksa e-posta alarmı (saatte bir kendiliğinden)
#   takip restore TARİH|yesterday    o günün yedeğine geri dön (önce güvenlik yedeği; onay ister)
#   takip restore-test [TARİH]       yedeği canlıya dokunmadan geçici veritabanına yükleyip dener
#   takip yedek-sifreleme [kur|yenile]   Google Drive'a giden yedeklerin şifrelenmesi: durum / kurulum / anahtar yenileme
#   takip log [SATIR]                uygulamanın son günlük satırları
#   takip cache [temizle]            Docker derleme önbelleği boyutu, disk kullanımı; temizle: sınır aşıldıysa şimdi temizle
#   takip dal [AD]                   otomatik güncellemenin izlediği GitHub dalı (varsayılan: backend)
#   takip github                     GitHub erişim anahtarını (token) yenile
#   takip antivirus                  antivirüs (ClamAV) çalışıyor ve test virüsünü yakalıyor mu
#   takip kur [ADRES]                Banca Transilvania EUR satış kuru sunucudan okunabiliyor mu (FGO)
#   takip surum-durum                yayındaki / son sağlıklı sürüm, imaj kimlikleri, geri dönüş adayı, yedek durumu (salt okunur)
#   takip surum-dogrula              yayındaki sürümü sağlık denetiminden geçirip sağlıklı sürüm olarak kaydet
#   takip rollback-durum             geri dönüş hedefi, imajları, ön değerlendirme, geçmiş (salt okunur)
#   takip rollback-kontrol           geri dönüş güvenli mi: imajlar, migration listesi, Caddyfile, salt okunur yoklama (değiştirmez)
#   takip rollback [--onay KISA_SHA] son sağlıklı sürüme dön — YALNIZCA uygulama + işçi; veritabanına dokunmaz (onay ister)
#   takip rollback-modu [gozlem|otomatik]  yayın sonrası sağlık sorununda davranış (varsayılan: gözlem — yalnızca bildirir)
#
# Otomatik güncelleme (systemd: takip-deploy.timer, 2 dakikada bir → takip _otomatik):
#   izlenen dalın GÜNCEL ucu, YALNIZCA o dalın kendi GitHub koşularında CI'dan (ve deploy/ vb. değiştiyse sunucu
#   kurulum testinden) geçtiyse sunucuda derlenir (başka dalın sonucu sayılmaz; derleme sonrası uç ve kapı yeniden denetlenir),
#   veritabanı yedeklenir, migration uygulanır ve yeni sürüm başlatılır. Açılmazsa — migration uygulanmadıysa — önceki sürüme
#   dönülür. Sonra tam sağlık denetimi: geçerse "son sağlıklı sürüm" kaydı yazılır; geçmezse gözlem kipinde yalnızca bildirilir
#   (karar 287; docs/geri-donus.md).
#   Testlerden geçmeyen commit hiç yayınlanmaz. Depo özel: GitHub'a /opt/takip/github-token ile bağlanılır.
set -Eeuo pipefail

# Güncelleme sırasında bu dosya git tarafından değiştirilebilir; bash betiği satır satır okuduğu için
# önce geçici bir kopyaya geçilir.
if [ -z "${TAKIP_REEXEC:-}" ]; then
  tmp=$(mktemp /tmp/takip.XXXXXX)
  cp "$(readlink -f "$0")" "$tmp"
  TAKIP_REEXEC="$tmp" exec bash "$tmp" "$@"
fi
WORK_DIR=''
cleanup() {
  rm -f "$TAKIP_REEXEC"
  # Şifreli yedeğin indirildiği / çözüldüğü geçici klasör (yalnızca kendi oluşturduğumuz klasör silinir)
  case $WORK_DIR in */backups/.gecici.*) rm -rf -- "$WORK_DIR" ;; esac
}
trap cleanup EXIT

BASE=${TAKIP_BASE:-/opt/takip}
SRC=$BASE/src
ENV_FILE=$BASE/.env
STATE=$BASE/state
LOGS=$BASE/logs
BACKUPS=$BASE/backups
REPO_SLUG=${TAKIP_REPO:-erhan1977tr-lang/Takip}
API=https://api.github.com/repos/$REPO_SLUG
TOKEN_FILE=$BASE/github-token
# Yayın kapısının zorunlu iş akışları — DOSYA YOLUYLA tanınır (ad değişebilir, yol depodaki kimliktir; karar 276)
CI_WORKFLOW_PATH=.github/workflows/ci.yml
INSTALL_WORKFLOW_PATH=.github/workflows/deploy-test.yml
# Sunucu kurulum testinin (deploy-test.yml) tetiklendiği yollar — o dosyadaki "paths" listesiyle AYNI olmalı
# (test/deploy-gate.test.js karşılaştırır). Bu yollardan biri değiştiyse yayın kurulum testini de bekler.
INSTALL_TEST_PATHS=(deploy Dockerfile .dockerignore app/surum .github/workflows/deploy-test.yml)
# Demo ortamı testi (demo-env.yml) — tetiklendiği yollar o dosyadaki "paths" ile AYNI olmalı (test/deploy-gate.test.js). Bu yollardan
# biri (sürüm numarası dahil: package.json) değiştiyse yayın, backend'deki demo testinin de başarıyla bitmesini bekler (karar 287).
DEMO_WORKFLOW_PATH=.github/workflows/demo-env.yml
DEMO_TEST_PATHS=(.devcontainer scripts/demo server/demo next.config.mjs package.json package-lock.json .github/workflows/demo-env.yml)
VERBOSE=${VERBOSE:-0}

mkdir -p "$STATE" "$LOGS"
# Günlükler yalnızca root ve grubuna açıktır (karar 289; önceden 0755)
if [ "$(id -u)" = 0 ]; then chmod 0750 "$LOGS" 2>/dev/null || true; fi
# Yedek klasörü yalnızca root'a açıktır (0700; kurulum da böyle açar). Yoksa bu izinle oluşturulur; var olan klasörün izni değiştirilmez.
[ -d "$BACKUPS" ] || (umask 077 && mkdir -p "$BACKUPS")

say() { echo "$*"; }
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOGS/deploy.log"; }
info() { if [ "$VERBOSE" = 1 ]; then echo "$*"; fi; }
compose() { docker compose -p takip --env-file "$ENV_FILE" -f "$SRC/deploy/docker-compose.yml" "$@"; }
# GATE_BRANCH yalnızca salt okunur tanı komutu "takip _ci SHA DAL" içindir; yayın her zaman izlenen dalı kullanır
branch() { if [ -n "${GATE_BRANCH:-}" ]; then echo "$GATE_BRANCH"; else cat "$STATE/branch" 2>/dev/null || echo backend; fi; }
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

# ---------- CI kontrolü (yayın kapısı, karar 276) ----------
# Bir commit YALNIZCA izlenen dalın (backend) KENDİ koşularıyla yayınlanabilir: GitHub'daki koşu
#   head_sha = commit · head_branch = izlenen dal · event = push · path = iş akışı dosyası · depo = bu depo
# olmalıdır. Başka dalda (çalışma dalı, PR) aynı commit için geçmiş başarılı koşu ASLA yeterli sayılmaz. Aynı commit + dal
# için birden çok koşu varsa EN YENİSİ geçerlidir. Koşu yoksa, sürüyorsa, API okunamazsa → bekle (pending); başarı dışındaki
# her sonuç (failure, cancelled, timed_out, skipped, …) → failure. Hiçbir durumda "bilinmiyor" başarı sayılmaz.

# run_state SHA İŞ_AKIŞI_YOLU DAL → success | failure | pending | none (stdout'a yalnızca sonuç)
run_state() {
  local sha=$1 wf=$2 b=$3 resp code run st co
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo pending; return; }
  resp=$(gh_curl "/actions/runs?head_sha=$sha&branch=$b&event=push&per_page=100") || { echo pending; return; }
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
  run=$(jq -ce --arg s "$sha" --arg b "$b" --arg p "$wf" --arg r "$REPO_SLUG" '
    [ .workflow_runs[]
      | select(.head_sha == $s and .head_branch == $b and .event == "push" and .path == $p
          and ((.repository.full_name // "") | ascii_downcase) == ($r | ascii_downcase)
          and ((.head_repository.full_name // "") | ascii_downcase) == ($r | ascii_downcase)) ]
    | sort_by(.created_at, .run_number) | last // {}' <<<"$resp" 2>/dev/null) || { echo pending; return; }
  [ "$run" = '{}' ] && { echo none; return; }
  st=$(jq -r '.status // ""' <<<"$run")
  co=$(jq -r '.conclusion // ""' <<<"$run")
  if [ "$st" != completed ]; then echo pending
  elif [ "$co" = success ]; then echo success
  else echo failure; fi
}

# ci_state SHA [DAL] — izlenen daldaki "CI" (ci.yml) koşusunun sonucu: success | failure | pending | none
ci_state() { run_state "$1" "$CI_WORKFLOW_PATH" "${2:-$(branch)}"; }

# ci_gate SHA DAL — commit'in KENDİ backend koşusu (karar 289). Yazar adı / e-postası ve commit konusu taklit edilebildiği
# için hiçbir commit'e istisna yoktur ("CI: …" konulu, github-actions yazarlı commit'ler dahil): koşusu olmayan commit
# yayınlanmaz. CI, izlenen dala hiçbir şey geri yazmaz (ci.yml); oluşturulan dosyalar çalışma dallarında üretilir.
ci_gate() { # ci_gate SHA DAL
  local s
  s=$(ci_state "$1" "$2")
  case $s in success | failure) echo "$s" ;; *) echo pending ;; esac
}

# Yola bağlı iş akışları (sunucu kurulum testi: deploy-test.yml · demo ortamı: demo-env.yml) yalnızca kendi yolları değişince
# çalışır. Yayın onları şu durumda bekler:
#  · yayındaki commit (TABAN) bilinir ve TABAN..SHA aralığında bu yollar değiştiyse: değişikliği içeren EN YENİ commit
#    (L) ile SHA arasındaki commit'lerden, izlenen dalda o iş akışının koşusu olan EN YENİSİ başarılı olmalı (koşu yoksa
#    henüz oluşmamıştır → bekle); bu yollar değişmediyse test gerekmez. Hiçbir commit'e yazar / konu istisnası yoktur
#    (karar 289): "CI: …" konulu commit'in değişikliği de L sayılır;
#  · TABAN bilinmiyorsa (ilk kurulum): SHA ve önceki 20 commit'ten o iş akışının koşusu olan en yenisi başarılı olmalı.
paths_gate() { # paths_gate SHA DAL TABAN İŞ_AKIŞI_YOLU YOL…
  local sha=$1 b=$2 base=$3 wf=$4 last='' c s list changed; shift 4
  if [ -n "$base" ] && git -C "$SRC" merge-base --is-ancestor "$base" "$sha" 2>/dev/null; then
    [ "$base" = "$sha" ] && { echo success; return; }
    if git -C "$SRC" diff --quiet "$base" "$sha" -- "$@" 2>/dev/null; then echo success; return; fi
    changed=$(git -C "$SRC" log --first-parent --format=%H "$base..$sha" -- "$@" 2>/dev/null) || { echo pending; return; }
    last=${changed%%$'\n'*}
    list=$(git -C "$SRC" rev-list --first-parent "$base..$sha" 2>/dev/null) || { echo pending; return; }
    # Birinci üst zincirde değişiklik bulunamadıysa (birleştirme dışı bir yol): en temkinli seçim — SHA'nın kendisi
    [ -n "$last" ] || last=$sha
  else
    list=$(git -C "$SRC" rev-list --first-parent -n 21 "$sha" 2>/dev/null) || { echo pending; return; }
  fi
  for c in $list; do
    s=$(run_state "$c" "$wf" "$b")
    case $s in
      none) ;;
      *) echo "$s"; return ;;
    esac
    [ -n "$last" ] && [ "$c" = "$last" ] && break
  done
  echo pending
}
install_gate() { paths_gate "$1" "$2" "${3:-}" "$INSTALL_WORKFLOW_PATH" "${INSTALL_TEST_PATHS[@]}"; } # install_gate SHA DAL [TABAN]
demo_gate() { paths_gate "$1" "$2" "${3:-}" "$DEMO_WORKFLOW_PATH" "${DEMO_TEST_PATHS[@]}"; }          # demo_gate SHA DAL [TABAN]

# gate SHA [TABAN] — yayınlanabilir mi: izlenen daldaki CI VE (gerekiyorsa) sunucu kurulum testi VE (gerekiyorsa) demo testi başarılı.
# Sonuç: success | failure | pending. Biri failure ise failure; biri bekliyorsa / okunamıyorsa pending.
gate() {
  local sha=$1 base=${2:-} b ci inst
  if [ "${TAKIP_SKIP_CI_GATE:-0}" = 1 ]; then
    # Yalnızca kurulum testleri (CI makinesi) ve bilinçli elle kullanım içindir; zamanlayıcı bu değişkeni vermez
    echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠ TAKIP_SKIP_CI_GATE=1: yayın kapısı ATLANDI ($(short "$sha"))" >>"$LOGS/deploy.log"
    echo success
    return
  fi
  b=$(branch)
  ci=$(ci_gate "$sha" "$b")
  [ "$ci" = success ] || { echo "$ci"; return; }
  inst=$(install_gate "$sha" "$b" "$base")
  [ "$inst" = success ] || { echo "$inst"; return; }
  demo_gate "$sha" "$b" "$base"
}

# İzlenen dalın GitHub'daki güncel ucu hâlâ SHA mı (yayının son adımlarından önce; karar 276). Okunamazsa "hayır".
head_is() { # head_is SHA
  local b; b=$(branch)
  git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$b:refs/remotes/origin/$b" 2>/dev/null || return 1
  [ "$(git -C "$SRC" rev-parse "origin/$b" 2>/dev/null || true)" = "$1" ]
}

# ---------- yedek ----------
# Gece yedeği (takip-backup.timer, 03:00 Romanya saati → takip yedek): ortak zaman damgalı çift
#   db-YYYY-MM-DD_HHMMSS.dump (pg_dump -Fc)  ·  dosyalar-YYYY-MM-DD_HHMMSS.tgz (yüklenen dosyalar)
# Her ikisi yerelde doğrulanır (dump geçici bir veritabanına gerçekten geri yüklenir, arşiv okunur), sonra Google
# Drive'a (rclone, BACKUP_REMOTE; varsayılan gkhdrive:GKH_TAKIP_BACKUPS) kopyalanır ve md5 ile doğrulanır.
# Saklama (karar 279): yerel 14 gün, Google Drive 60 gün — birbirinden bağımsız (.env: BACKUP_KEEP_LOCAL_DAYS /
# BACKUP_KEEP_DRIVE_DAYS); yalnızca bu adlandırmaya uyan, TAM ve DOĞRULANMIŞ çiftler silinir. Yayından önce alınan
# güvenlik yedekleri eski adla kalır (db-YYYYMMDD-HHMMSS-etiket). .env, github-token ve rclone ayarı yedeğe girmez.
# İzinler: yedek klasörü 0700, içindeki her yedek dosyası (geçici / indirilen / şifreli ara dosya dahil) oluşturulduğu andan
# itibaren 0600 — umask 077 yalnızca dosyayı oluşturan komutun çevresinde verilir (aracın geri kalanını etkilemez).
#
# Şifreleme (güvenlik denetimi SEC-02; ayrıntı: docs/adr/0013-yedek-sifreleme.md, deploy/README.md):
#   Varsayılan KAPALI — sunucu sahibi "takip yedek-sifreleme kur" ile açana kadar akış yukarıdaki gibidir.
#   Açıkken Google Drive'a YALNIZCA şifreli kopya gider (age, X25519: db-….dump.age, dosyalar-….tgz.age). Yerel kopyalar
#   (yalnızca root okur, /opt/takip/backups 0700) açık kalır: canlı veritabanıyla aynı diskte, anahtarsız kullanılabilen
#   güvenlik ağıdır. Anahtar: $BACKUP_KEY (0600) — yedeğe, Drive'a, git'e, günlüklere GİRMEZ; sahibi sunucu DIŞINDA saklar.
#   Şifresiz eski Drive yedekleri bu aşamada silinmez (şifreleme açıkken Drive temizliği yalnızca .age dosyalarına bakar).
BACKUP_KEEP_LOCAL_DEFAULT=14
BACKUP_KEEP_DRIVE_DEFAULT=60
BACKUP_KEEP_MIN=7
BACKUP_KEEP_MAX=400
# Doğrulanmış çift defterleri (karar 279): gece yedeği bir çifti (veritabanı + dosyalar) o yerde doğruladığında zaman damgasını
# ekler. İlk satır "since ZAMAN": bu defterden önceki (eski sürümün aldığı) çiftler eski kurala göre doğrulanmış sayılır.
LEDGER_LOCAL=$STATE/backup-verified-local
LEDGER_DRIVE=$STATE/backup-verified-drive
BACKUP_TZ=Europe/Bucharest
BACKUP_KEY=$BASE/backup-key.txt
ENC_STATE=$STATE/backup-encryption # etkin alıcı (age açık anahtarı); dosya varsa Drive'a yalnızca şifreli kopya gider
local_names() { find "$BACKUPS" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null || true; }
remote_root() { local r; r=$(env_get BACKUP_REMOTE); echo "${r:-gkhdrive:GKH_TAKIP_BACKUPS}"; }
blog() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOGS/backup.log" >&2; }

backup_db() { # backup_db ETİKET [DOSYA]  → yedeğin yolu (veritabanı çalışmıyorsa boş)
  if ! compose ps --status running -q db 2>/dev/null | grep -q .; then return 0; fi
  local f; f=${2:-"$BACKUPS/db-$(date +%Y%m%d-%H%M%S)-$1.dump"}
  # Yedek dosyaları oluşturulduğu andan itibaren yalnızca root'a açıktır (0600; geçici dosya dahil): umask yalnızca bu satırda
  if (umask 077 && compose exec -T db pg_dump -U takip -d takip -Fc >"$f.tmp") && [ -s "$f.tmp" ]; then
    mv "$f.tmp" "$f"
    # Eski adlı (yayın öncesi / elle) yedekler 14 günden eskiyse silinir. Günlük çiftler: backup_retention
    find "$BACKUPS" -name 'db-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*.dump' -mtime +14 -delete
    echo "$f"
  else
    rm -f "${f:?}.tmp"
    return 1
  fi
}
backup_files() { # backup_files [DOSYA] → arşivin yolu (uygulama imajı yoksa boş)
  local tag; tag=$(env_get APP_TAG)
  [ -n "$tag" ] && docker image inspect "takip:$tag" >/dev/null 2>&1 || return 0
  local f; f=${1:-"$BACKUPS/dosyalar-$(date +%Y%m%d-%H%M%S).tgz"}
  # Arşivi kapsayıcıdaki tar yazar: sunucunun umask'ı oraya geçmez, bu yüzden 0600 izni kapsayıcının İÇİNDE verilir
  if ! docker run --rm --user 0 -v takip_uploads:/u:ro -v "$BACKUPS":/b "takip:$tag" sh -c 'umask 077 && exec tar czf "$1" -C /u .' sh "/b/$(basename "$f").tmp"; then
    rm -f "${f:?}.tmp"
    return 1
  fi
  mv "$f.tmp" "$f"
  find "$BACKUPS" -name 'dosyalar-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*.tgz' -mtime +7 -delete
  echo "$f"
}

db_sql() { compose exec -T -e PGOPTIONS='-c client_min_messages=warning' db psql -U takip -d "${2:-postgres}" -v ON_ERROR_STOP=1 -qtAc "$1"; }
# Dump'ı verilen (yeni, boş) veritabanına yükler ve uygulamanın tablolarıyla dolu olduğunu kontrol eder.
# Başarısızsa o veritabanı silinir. Canlı "takip" veritabanına dokunmaz.
restore_into() { # restore_into VERİTABANI DOSYA
  db_sql "DROP DATABASE IF EXISTS \"$1\"" >/dev/null && db_sql "CREATE DATABASE \"$1\"" >/dev/null || return 1
  if ! compose exec -T db pg_restore -U takip -d "$1" --no-owner --exit-on-error <"$2" >/dev/null 2>>"$LOGS/backup.log"; then
    db_sql "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1 || true
    return 1
  fi
  local n; n=$(db_sql 'SELECT count(*) FROM "_prisma_migrations"' "$1" 2>/dev/null || echo 0)
  if ! [ "${n:-0}" -gt 0 ] 2>/dev/null; then
    db_sql "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1 || true
    return 1
  fi
}
# Yedeğin gerçekten geri yüklenebildiği geçici veritabanında denenir
verify_dump() { # verify_dump DOSYA
  restore_into takip_yedek_dene "$1" || return 1
  db_sql 'DROP DATABASE IF EXISTS "takip_yedek_dene"' >/dev/null
}
verify_archive() { [ -s "$1" ] && gzip -t "$1" 2>/dev/null && tar -tzf "$1" >/dev/null 2>&1; }

# ---------- yedek şifreleme (age) ----------
enc_recipient() { if [ -s "$ENC_STATE" ]; then head -1 "$ENC_STATE"; fi; }
enc_tools() { command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1; }
key_recipients() { age-keygen -y "$BACKUP_KEY" 2>/dev/null || true; }
# Şifrelemeye hazır mı: age kurulu, anahtar dosyası var ve verilen alıcının gizli anahtarı o dosyada
# (çözemeyeceğimiz bir anahtara asla şifrelenmez)
enc_ready() { # enc_ready ALICI
  enc_tools && [ -s "$BACKUP_KEY" ] && [ -n "$1" ] && key_recipients | grep -qxF "$1"
}
# Dosyayı şifreler (DOSYA.age) ve hemen çözerek doğrular: çözülen içeriğin özeti aslıyla aynı olmalı. Açık dosya yerinde kalır.
encrypt_one() { # encrypt_one DOSYA ALICI
  local a b
  rm -f "${1:?}.age" "${1:?}.age.tmp"
  if ! (umask 077 && age -r "$2" -o "$1.age.tmp" "$1" 2>>"$LOGS/backup.log"); then rm -f "${1:?}.age.tmp"; return 1; fi
  a=$(sha256sum <"$1" | cut -d' ' -f1 || true)
  b=$(age -d -i "$BACKUP_KEY" "$1.age.tmp" 2>>"$LOGS/backup.log" | sha256sum | cut -d' ' -f1 || true)
  if [ -n "$a" ] && [ "$a" = "$b" ]; then mv -f "$1.age.tmp" "$1.age"; else rm -f "${1:?}.age.tmp"; return 1; fi
}
# Şifreli dosyayı çözer (yalnızca root'un okuyabildiği dosya olarak). Anahtar ekrana / günlüğe yazılmaz.
decrypt_one() { # decrypt_one DOSYA.age HEDEF
  enc_tools && [ -s "$BACKUP_KEY" ] || return 1
  if (umask 077 && age -d -i "$BACKUP_KEY" -o "$2.tmp" "$1" 2>>"$LOGS/backup.log"); then mv -f "$2.tmp" "$2"; else rm -f "${2:?}.tmp"; return 1; fi
}

# Drive'a kopyalar ve md5 ile doğrular
upload_one() { # upload_one DOSYA ALT_KLASÖR
  local dst l r
  dst="$(remote_root)/$2/$(basename "$1")"
  rclone copyto "$1" "$dst" --retries 3 --low-level-retries 10 >>"$LOGS/backup.log" 2>&1 || return 1
  l=$(md5sum "$1" | cut -d' ' -f1)
  r=$(rclone md5sum "$dst" 2>>"$LOGS/backup.log" | cut -d' ' -f1)
  # 2: yüklendi ama Drive'daki kopya doğrulanamadı (bütünlük)
  [ -n "$r" ] && [ "$l" = "$r" ] || return 2
}

# Doğrulanmış yerel yedeği Drive'a koyar (ALICI doluysa önce şifreleyip çözerek doğrular). Sorun kodunu yazar (boş = tamam).
drive_copy() { # drive_copy DOSYA ALT_KLASÖR ETİKET [ALICI]
  local src=$1 rc=0
  if [ -n "${4:-}" ]; then
    if ! encrypt_one "$1" "$4"; then blog "✘ Google Drive: $3 yedeği şifrelenemedi/doğrulanamadı — Drive'a gönderilmedi (yerel yedek duruyor)"; echo ENCRYPT; return 0; fi
    src=$1.age
  fi
  upload_one "$src" "$2" || rc=$?
  case $rc in
    0) blog "✔ Google Drive: $2/$(basename "$src") yüklendi$([ -n "${4:-}" ] && echo ' (şifreli; çözülerek ve md5 ile doğrulandı)' || echo ', md5 doğrulandı')" ;;
    2) blog "✘ Google Drive: $3 yedeği yüklendi ama doğrulanamadı (md5) (yerel yedek duruyor)"; echo DRIVE_VERIFY ;;
    *) blog "✘ Google Drive: $3 yedeği yüklenemedi (yerel yedek duruyor)"; echo DRIVE_UPLOAD ;;
  esac
  return 0
}

DAILY_RE='^(db|dosyalar)-([0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6})\.(dump|tgz)$'
DAILY_AGE_RE='^(db|dosyalar)-([0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6})\.(dump|tgz)\.age$'

# keep_days yerel|uzak → saklama günü. .env: BACKUP_KEEP_LOCAL_DAYS (varsayılan 14) / BACKUP_KEEP_DRIVE_DAYS (varsayılan 60).
# Boş ya da geçersiz (sayı değil, 7'den küçük, 400'den büyük) değer → varsayılan (temizlik asla daha sert olmaz).
keep_days() {
  local v d
  if [ "$1" = yerel ]; then v=$(env_get BACKUP_KEEP_LOCAL_DAYS); d=$BACKUP_KEEP_LOCAL_DEFAULT
  else v=$(env_get BACKUP_KEEP_DRIVE_DAYS); d=$BACKUP_KEEP_DRIVE_DEFAULT; fi
  case $v in '' | *[!0-9]*) echo "$d"; return 0 ;; esac
  [ ${#v} -le 4 ] || { echo "$d"; return 0; }
  v=$((10#$v))
  if [ "$v" -lt "$BACKUP_KEEP_MIN" ] || [ "$v" -gt "$BACKUP_KEEP_MAX" ]; then echo "$d"; else echo "$v"; fi
}
# keep_days_note yerel|uzak → .env'deki değer geçersizse kısa uyarı (yoksa boş)
keep_days_note() {
  local k v; if [ "$1" = yerel ]; then k=BACKUP_KEEP_LOCAL_DAYS; else k=BACKUP_KEEP_DRIVE_DAYS; fi
  v=$(env_get "$k")
  [ -n "$v" ] || return 0
  [ "$(keep_days "$1")" = "$v" ] || echo "$k geçersiz ($BACKUP_KEEP_MIN–$BACKUP_KEEP_MAX gün olmalı) — varsayılan kullanılıyor"
}

# ledger_add DEFTER ZAMAN — doğrulanan çifti deftere yazar (defter yoksa "since ZAMAN" satırıyla açılır)
ledger_add() {
  if [ ! -s "$1" ]; then echo "since $2" >"$1"; fi
  echo "$2" >>"$1"
}
# ledger_ok DEFTER ZAMAN — çift doğrulanmış mı: defterde var ya da defterin açılışından eski (eski sürümün kuralı:
# çiftler yalnızca gece yedeği tamamen başarılıyken temizliğe girdi). Defter yoksa: hiçbir çift doğrulanmış sayılmaz.
ledger_ok() {
  local since
  [ -s "$1" ] || return 1
  since=$(sed -n '1s/^since //p' "$1")
  grep -qxF "$2" "$1" && return 0
  [ -n "$since" ] && [[ "$2" < "$since" ]]
}

# Eski çiftlerin temizliği (karar 279). Bir zaman damgasının dosyaları YALNIZCA şu koşulların hepsi tutunca silinir:
#   1. çift TAMDIR (db-ZAMAN ve dosyalar-ZAMAN ikisi de var; adlandırmaya uymayan dosyaya hiç dokunulmaz),
#   2. çift o yerde DOĞRULANMIŞTIR (ledger_ok) — eksik ya da doğrulanmamış çift ASLA silinmez, yalnızca günlükte sayılır,
#   3. tarihi saklama süresinden eskidir (bugün − GÜN; bugünün dosyaları asla),
#   4. kendisinden YENİ en az GÜN tane doğrulanmış tam çift vardır (yedekler uzun süre alınamasa da son çiftler kalır).
# Drive listesi alınamazsa hiçbir şey silinmez. Şifreleme açıkken Drive'da yalnızca şifreli (.age) çiftlere bakılır.
backup_retention() { # backup_retention yerel | backup_retention uzak [DESEN]
  local where=$1 re=${2:-$DAILY_RE} days ledger today limit dbs ups pairs good anchor ts day f dir
  local unverified=0 incomplete=0 note
  days=$(keep_days "$where")
  note=$(keep_days_note "$where"); [ -z "$note" ] || blog "⚠ yedek saklama: $note"
  if [ "$where" = yerel ]; then ledger=$LEDGER_LOCAL; else ledger=$LEDGER_DRIVE; fi
  today=$(TZ=$BACKUP_TZ date +%F)
  limit=$(TZ=$BACKUP_TZ date -d "$today -$days days" +%F) || return 0
  if [ "$where" = yerel ]; then
    dbs=$(local_names | grep -E "$re" | grep '^db-' || true)
    ups=$(local_names | grep -E "$re" | grep '^dosyalar-' || true)
  else
    if ! dbs=$(rclone lsf --files-only "$(remote_root)/database" 2>>"$LOGS/backup.log") ||
      ! ups=$(rclone lsf --files-only "$(remote_root)/uploads" 2>>"$LOGS/backup.log"); then
      blog "⚠ Google Drive listesi alınamadı — Drive temizliği atlandı (hiçbir şey silinmedi)"
      return 0
    fi
    dbs=$(echo "$dbs" | grep -E "$re" | grep '^db-' || true)
    ups=$(echo "$ups" | grep -E "$re" | grep '^dosyalar-' || true)
  fi
  pairs=$(comm -12 <(echo "$dbs" | sed -nE "s/$re/\2/p" | sort -u) <(echo "$ups" | sed -nE "s/$re/\2/p" | sort -u))
  # Eksik çiftler (yalnızca biri var): saklama süresinden eskiyse bile silinmez, sayılır
  incomplete=$(comm -3 <(echo "$dbs" | sed -nE "s/$re/\2/p" | sort -u) <(echo "$ups" | sed -nE "s/$re/\2/p" | sort -u) |
    tr -d '\t' | grep -c . || true)
  good=''
  for ts in $pairs; do ledger_ok "$ledger" "$ts" && good="$good$ts"$'\n'; done
  anchor=$(echo "$good" | grep . | sort -r | sed -n "${days}p" || true)
  if [ -n "$anchor" ]; then
    for ts in $pairs; do
      [[ "$ts" < "$anchor" ]] || continue
      day=${ts%%_*}
      case $day in "$today") continue ;; esac
      [[ "$day" < "$limit" ]] || continue
      if ! ledger_ok "$ledger" "$ts"; then unverified=$((unverified + 1)); continue; fi
      for f in $(printf '%s\n%s\n' "$ups" "$dbs" | grep -E "^(db|dosyalar)-${ts}\." | grep -E "$re" || true); do
        if [ "$where" = yerel ]; then
          rm -f -- "${BACKUPS:?}/${f:?}" && blog "  eski yerel yedek silindi: $f"
        else
          case $f in db-*) dir=database ;; *) dir=uploads ;; esac
          rclone deletefile "$(remote_root)/$dir/$f" >>"$LOGS/backup.log" 2>&1 && blog "  eski Drive yedeği silindi: $dir/$f"
        fi
      done
    done
  fi
  if [ "$unverified" -gt 0 ] || [ "$incomplete" -gt 0 ]; then
    blog "  $([ "$where" = yerel ] && echo yerel || echo 'Google Drive'): $incomplete eksik, $unverified doğrulanmamış çift korundu (silinmedi)"
  fi
  return 0
}

# Sunucudaki yedek zamanlayıcısı depodakinden farklıysa güncellenir (her gün 03:00 Europe/Bucharest)
sync_backup_timer() {
  local u synced=0
  for u in takip-backup.service takip-backup.timer takip-backup-check.service takip-backup-check.timer; do
    [ -f "$SRC/deploy/systemd/$u" ] && [ -d /etc/systemd/system ] || continue
    if ! cmp -s "$SRC/deploy/systemd/$u" "/etc/systemd/system/$u"; then
      cp "$SRC/deploy/systemd/$u" "/etc/systemd/system/$u" 2>/dev/null && synced=1
    fi
  done
  if [ $synced = 1 ]; then
    systemctl daemon-reload && systemctl restart takip-backup.timer && blog "  yedek zamanlayıcısı güncellendi: her gün 03:00 (Europe/Bucharest)"
  fi
  # Bekçi zamanlayıcısı (karar 249) kurulu ama etkin değilse etkinleştirilir (ilk kez gelen sürüm)
  if [ -f /etc/systemd/system/takip-backup-check.timer ] && command -v systemctl >/dev/null 2>&1 && ! systemctl is-enabled --quiet takip-backup-check.timer 2>/dev/null; then
    systemctl daemon-reload && systemctl enable --now takip-backup-check.timer >/dev/null 2>&1 && blog "  yedek bekçisi etkinleştirildi: saatte bir (takip-backup-check.timer)"
  fi
  return 0
}

wait_healthy() { # wait_healthy SANİYE (TAKIP_HEALTHY_WAIT: yalnızca mantık testleri kısaltır)
  local end=$((SECONDS + ${TAKIP_HEALTHY_WAIT:-${1:-180}})) id s
  while [ $SECONDS -lt $end ]; do
    id=$(compose ps -q app 2>/dev/null || true)
    s=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo yok)
    [ "$s" = healthy ] && return 0
    sleep 5
  done
  return 1
}

# ---------- ön sunucu (Caddy) denetimi ----------
# Yayın yalnızca uygulama kapsayıcısının sağlığına bakıyordu; Caddy'ye bakmıyordu. Caddyfile'ı bozan bir yayın siteyi
# kapatıp yine de "başarılı" görünebilirdi (karar 142). İki küçük denetim:
#   1. Caddyfile değiştiyse yeni dosya, hiçbir şeye dokunulmadan ÖNCE, çalışan Caddy'nin kendi sürümüyle doğrulanır
#      (caddy validate). Geçersizse yayın başlamadan başarısız sayılır; site olduğu gibi çalışır.
#   2. Yayından sonra sitenin HTTPS üzerinden, Caddy içinden YENİ sürüme ulaştığına bakılır (/surum). Yayından önce
#      yanıt veren site yayından sonra yanıt vermiyorsa yayın başarısızdır: önceki sürüme ve önceki Caddyfile'a dönülür.
# Kayıtlara Caddy'nin günlük satırları YAZILMAZ (istek adresleri depo bağlantısı anahtarı taşıyabilir).
caddy_id() { compose ps -q caddy 2>/dev/null | head -n 1 || true; }
caddy_state() { docker inspect -f 'durum={{.State.Status}} yeniden-başlatma={{.RestartCount}}' "$(caddy_id)" 2>/dev/null || echo 'kapsayıcı yok'; }

# Yeni Caddyfile'ı ÇALIŞAN Caddy'nin sürümüyle doğrular (dosya kapsayıcıya geçici bir yola kopyalanır; yayındaki ayara
# ve çalışan sürece dokunulmaz). 0: geçerli · 1: geçersiz (hata çıktıda) · 2: Caddy çalışmadığı için denetlenemedi
caddy_validate() { # caddy_validate DOSYA
  local id out
  id=$(caddy_id)
  if [ -z "$id" ] || [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" != true ]; then return 2; fi
  if out=$(docker exec -i "$id" sh -c 'f=/tmp/Caddyfile.denetim; cat >"$f"; caddy validate --config "$f" --adapter caddyfile; rc=$?; rm -f "$f"; exit $rc' <"$1" 2>&1); then
    return 0
  fi
  echo "$out" | tail -n 3
  return 1
}

# Site HTTPS üzerinden, Caddy içinden uygulamaya ulaşıyor mu. İstek sunucunun kendisine gider (DNS'e bağlı değildir);
# sertifikanın güvenilirliğine değil yönlendirmeye bakılır (-k). KISA_SHA verilirse yanıt o sürümden gelmelidir.
edge_ok() { # edge_ok [KISA_SHA]
  local domain out
  domain=$(env_get APP_DOMAIN)
  if [ -z "$domain" ] || ! command -v curl >/dev/null 2>&1; then return 1; fi
  out=$(curl -fsSk --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/surum" 2>/dev/null) || return 1
  case $out in *'"version"'*) ;; *) return 1 ;; esac
  if [ -z "${1:-}" ]; then return 0; fi
  case $out in *"\"build\":\"$1\""*) return 0 ;; esac
  return 1
}
wait_edge() { # wait_edge SANİYE [KISA_SHA]
  local end=$((SECONDS + $1))
  while [ $SECONDS -lt $end ]; do
    if edge_ok "${2:-}"; then return 0; fi
    sleep 3
  done
  return 1
}

# Önceki sürüme dönüş: imaj etiketi, kaynak ve — Caddyfile bu yayında değiştiyse — Caddy'nin ayarı
revert_release() { # revert_release SHA ÖNCEKİ_SHA ÖNCEKİ_ETİKET DERLEME_GÜNLÜĞÜ CADDY_DEĞİŞTİ
  local sha=$1 prev=$2 prev_tag=$3 blog=$4 caddy_changed=$5
  if [ -n "$prev_tag" ] && [ "$prev_tag" != "$sha" ]; then
    env_set APP_TAG "$prev_tag"
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    compose up -d --remove-orphans >>"$blog" 2>&1 || true
    # Caddy yeni dosyayla yeniden başlatılmıştı: önceki dosyaya dönmesi için bir kez daha başlatılır
    if [ "$caddy_changed" = 1 ]; then compose restart caddy >>"$blog" 2>&1 || true; fi
  fi
  echo "$sha" >"$STATE/failed"
}

# ---------- Docker derleme önbelleği ----------
# Her yayın derleme önbelleğini (BuildKit) birkaç GB büyütür. Kural (karar 134):
#   önbellek <= 10 GB  → hiçbir şey yapılmaz
#   önbellek >  10 GB  → KULLANILMAYAN derleme önbelleği silinir; en son kullanılan ~4 GB tutulur (bir sonraki derleme
#                        hızlı kalsın). Yaşa bakılmaz: eski kural yalnızca 7 günden eski önbelleği siliyordu, önbellek ise
#                        birkaç günde onlarca GB'a çıktığı için hiçbir şey silinmiyordu.
# Yalnızca "docker builder prune" kullanılır: bu komut YALNIZCA derleme önbelleğini siler. Kapsayıcılara (çalışan /
# durmuş), imajlara (yayındaki ve geri dönüş imajı dahil), birimlere (veritabanı, yüklenen dosyalar, antivirüs, Caddy) ve
# yedeklere dokunmaz. "docker system prune" / "docker volume prune" bu dosyada KULLANILMAZ.
# Çalıştığı yerler (tek işlev, yayın kilidi altında): başarılı yayından sonra · derlemesi başarısız olan yayından sonra
# (disk dolduysa kendini toparlasın) · yayını aracın önceki sürümü yaptıysa bir sonraki denetimde bir kez · elle:
# takip cache temizle. Hata yayını bozmaz; yalnızca kayda uyarı düşer.
CACHE_LIMIT_BYTES=${TAKIP_CACHE_LIMIT_BYTES:-10000000000}
CACHE_KEEP_BYTES=${TAKIP_CACHE_KEEP_BYTES:-4000000000}
case $CACHE_LIMIT_BYTES in '' | *[!0-9]*) CACHE_LIMIT_BYTES=10000000000 ;; esac
case $CACHE_KEEP_BYTES in '' | *[!0-9]*) CACHE_KEEP_BYTES=4000000000 ;; esac
cache_row() { docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null | grep '^Build Cache|' | head -1 || true; }
# "73.35GB" → bayt; okunamazsa boş
to_bytes() {
  echo "$1" | awk '{
    if (match($1, /^[0-9]+(\.[0-9]+)?/) == 0) exit
    n = substr($1, 1, RLENGTH); u = toupper(substr($1, RLENGTH + 1))
    m = (u == "B") ? 1 : (u == "KB") ? 1e3 : (u == "MB") ? 1e6 : (u == "GB") ? 1e9 : (u == "TB") ? 1e12 : 0
    if (m) printf "%.0f\n", n * m
  }'
}
# bayt → "10 GB" / "512 MB" (kayıt ve ekran için)
gb() { echo "$1" | awk '{ if ($1 >= 1e9) printf "%.4g GB\n", $1 / 1e9; else printf "%.0f MB\n", $1 / 1e6 }'; }
cache_size() { cache_row | cut -d'|' -f2; }
# Kurulu Docker'ın boyuta göre önbellek tutma seçeneği: yeni sürümlerde --reserved-space, eskilerde --keep-storage
# (ikisi de "en son kullanılan bu kadar önbelleği tut, gerisini sil"). Hiçbiri yoksa boş döner.
cache_keep_flag() {
  local help
  help=$(docker builder prune --help 2>&1 || true)
  if echo "$help" | grep -q -- '--reserved-space'; then echo '--reserved-space'
  elif echo "$help" | grep -q -- '--keep-storage'; then echo '--keep-storage'
  fi
}
# cache_prune [SEÇENEK DEĞER] — yalnızca derleme önbelleği (docker builder prune); sonucu kayda yazar
cache_prune() {
  local out
  log "  önbellek temizliği: docker builder prune --all --force $*"
  if out=$(docker builder prune --all --force "$@" 2>&1); then
    log "  önbellek temizliği sonucu: $(echo "$out" | grep -iE 'reclaimed|^total' | tail -1 | tr '\t' ' ' | cut -c1-120)"
    return 0
  fi
  log "⚠ önbellek temizliği başarısız (yayın etkilenmedi): $(echo "$out" | tail -1 | cut -c1-200)"
  return 1
}
cache_housekeeping() {
  local size bytes flag after='' root
  size=$(cache_size)
  bytes=$(to_bytes "$size")
  if [ -z "$bytes" ]; then log "⚠ derleme önbelleği: boyut okunamadı, temizlik atlandı"; return 0; fi
  if [ "$bytes" -le "$CACHE_LIMIT_BYTES" ]; then
    log "  derleme önbelleği: $size (sınır $(gb "$CACHE_LIMIT_BYTES") aşılmadı, temizlik yok)"
    return 0
  fi
  log "  derleme önbelleği (önce): $size — sınır $(gb "$CACHE_LIMIT_BYTES") aşıldı; kullanılmayan derleme önbelleği siliniyor (en son kullanılan $(gb "$CACHE_KEEP_BYTES") tutulur)"
  flag=$(cache_keep_flag)
  if [ -n "$flag" ]; then
    cache_prune "$flag" "$CACHE_KEEP_BYTES" || true
    size=$(cache_size)
    after=$(to_bytes "$size")
    # Temizliğin hemen ardından boyut okunamadıysa (Docker meşgul) bir kez daha okunur; okunamayan boyut "silinmedi" sayılmaz
    if [ -z "$after" ]; then sleep 3; size=$(cache_size); after=$(to_bytes "$size"); fi
  fi
  # Boyuta göre tutma desteklenmiyorsa ya da önbellek bundan sonra da sınırın üstündeyse: kullanılmayan önbelleğin tamamı
  if [ -z "$flag" ] || { [ -n "$after" ] && [ "$after" -gt "$CACHE_LIMIT_BYTES" ]; }; then
    [ -z "$flag" ] || log "  derleme önbelleği (ilk adımdan sonra): $size — sınırın altına inmedi; kullanılmayan önbelleğin tamamı siliniyor"
    cache_prune || true
    size=$(cache_size)
    after=$(to_bytes "$size")
  fi
  log "  derleme önbelleği (sonra): ${size:-okunamadı}"
  if [ -n "$after" ] && [ "$after" -gt "$CACHE_LIMIT_BYTES" ]; then
    log "⚠ derleme önbelleği hâlâ sınırın üstünde (o anda kullanılan önbellek silinmez); bir sonraki yayında yeniden denenecek"
  fi
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -d "$root" ] || root=/
  log "  disk ($root): $(df -h "$root" | awk 'NR==2 { print $3 " / " $2 " dolu (" $5 "), boş " $4 }')"
}
# Yayın kilidi altında çalıştırır (yayın sürerken başlamaz)
cache_clean_now() {
  exec 9>"$STATE/deploy.lock"
  if ! flock -n 9; then say "Bir güncelleme sürüyor; bittiğinde önbellek kendiliğinden denetlenir."; return 0; fi
  cache_housekeeping
}
cmd_cache() {
  if [ "${1:-}" = temizle ] || [ "${1:-}" = clean ]; then cache_clean_now; return; fi
  local row; row=$(cache_row)
  if [ -z "$row" ]; then say "Docker derleme önbelleği okunamadı."; else
    say "Derleme önbelleği   : $(echo "$row" | cut -d'|' -f2)"
    say "Geri kazanılabilir  : $(echo "$row" | cut -d'|' -f3)"
  fi
  df -h / | awk 'NR==2 { print "Disk (/)            : " $3 " / " $2 " dolu (" $5 ")" }'
  say "Sınır: $(gb "$CACHE_LIMIT_BYTES") — aşılırsa yayından sonra kullanılmayan derleme önbelleği silinir (en son kullanılan $(gb "$CACHE_KEEP_BYTES") tutulur)."
  say "Yalnızca derleme önbelleği silinir; imajlara, kapsayıcılara, veritabanına, dosyalara ve yedeklere dokunulmaz. Şimdi denetlemek için: takip cache temizle"
}

# ---------- yayın kaydı, yayın sağlığı ve güvenli geri dönüş (karar 287) ----------
# Ayrıntı: docs/geri-donus.md (geri dönüş) · docs/felaket-kurtarma.md (felaket kurtarma — AYRI süreç) · ADR 0015.
#
# Son sağlıklı sürüm kaydı ($STATE/releases, yalnızca root): her yayın, sağlık denetiminin TAMAMINDAN geçince bir kayıt yazar
#   <SHA>.kayit       sürüm, tam SHA, imaj etiketi, uygulama + araç/işçi imaj kimliği (sha256:…), yayın / doğrulama zamanı,
#                     migration sayısı + son migration + listenin özeti, sağlık sonucu, kaynak (deploy | bootstrap | rollback)
#   <SHA>.migrations  o anda veritabanında UYGULANMIŞ migration'lar (ad + PostgreSQL'deki checksum) — veritabanının kendisinden
#   release-healthy / release-healthy-prev   son doğrulanmış sağlıklı sürüm ve ondan önceki (geri dönüş adayı)
# Dosyalar geçici dosyaya yazılıp taşınarak (mv) güncellenir: kesintide yarım kayıt kalmaz. Başarısız / sağlıksız yayın
# kayıt YAZMAZ ve göstergeleri değiştirmez. İmaj temizliği göstergelerdeki sürümlerin imajlarını hiçbir zaman silmez.
#
# Geri dönüş YALNIZCA uygulama + işçi imajını değiştirir (APP_TAG + compose up). Veritabanına dokunmaz: yedekten geri
# yükleme, migration geri alma, veri silme YOKTUR. Güvenli sayılması için hepsi gerekir:
#   · hedef sürümün doğrulanmış kaydı ve imajları var, imaj kimlikleri kayıttakiyle aynı;
#   · veritabanındaki uygulanmış migration listesi (ad + checksum) hedefin SAĞLIKLI DOĞRULANDIĞI andaki listeyle BİREBİR
#     aynı (hedeften sonra hiçbir migration uygulanmamış) ve yarım kalmış migration yok — dosya adına / sürüm numarasına
#     bakılarak uyumluluk VARSAYILMAZ; kanıt veritabanının kendi kaydıdır;
#   · hedefin araç imajındaki Prisma istemcisi bütün modelleri SALT OKUNUR işlemde okuyabiliyor (yoklama);
#   · hedefin Caddyfile'ı (farklıysa) çalışan Caddy'nin sürümüyle geçerli.
# Kip ($STATE/rollback-mode): "gozlem" (varsayılan) — yayın sonrası sağlık sorunu algılanır, kaydedilir, geri dönüşün güvenli
# olup olmadığı hesaplanır ve yöneticiye e-posta gider; canlı servis KENDİLİĞİNDEN eski sürüme geçirilmez. "otomatik" yalnızca
# sahibin açık onayıyla açılır (takip rollback-modu otomatik). Elle geri dönüş: takip rollback (aynı denetimler).
REL=$STATE/releases
REL_LOG=$LOGS/release.log
REL_HEALTHY=$STATE/release-healthy
REL_PREV=$STATE/release-healthy-prev
REL_OP=$STATE/release-op
REL_MODE=$STATE/rollback-mode
REL_ADOPT=$STATE/release-adopt
REL_MISMATCH=$STATE/release-mismatch
REL_KEEP_RECORDS=10
HEALTH_TRIES=${TAKIP_HEALTH_TRIES:-3}
HEALTH_GAP=${TAKIP_HEALTH_GAP:-15}
WORKER_MIN_UP=${TAKIP_WORKER_MIN_UP:-15}
case $HEALTH_TRIES in '' | *[!0-9]* | 0) HEALTH_TRIES=3 ;; esac
case $HEALTH_GAP in '' | *[!0-9]*) HEALTH_GAP=15 ;; esac
case $WORKER_MIN_UP in '' | *[!0-9]*) WORKER_MIN_UP=15 ;; esac
[ -d "$REL" ] || (umask 077 && mkdir -p "$REL")

# İşlem geçmişi (salt eklenir): zaman, işlem, sürümler, sonuç kodları. Gizli değer, komut çıktısı, adres YAZILMAZ.
rlog() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$REL_LOG"; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
rollback_mode() { if [ "$(cat "$REL_MODE" 2>/dev/null || true)" = otomatik ]; then echo otomatik; else echo gozlem; fi; }
# Dosyayı geçici dosyaya yazıp taşır (kesintide ya eski ya yeni içerik kalır; yarım dosya kalmaz)
atomic_write() { # atomic_write DOSYA < içerik
  local t; t=$(mktemp "$1.XXXXXX")
  cat >"$t"
  chmod 600 "$t"
  mv -f "$t" "$1"
}
is_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
read_ptr() { local v; v=$(head -n1 "$1" 2>/dev/null || true); if is_sha "$v"; then echo "$v"; fi; }
rec_file() { echo "$REL/$1.kayit"; }
rec_get() { # rec_get SHA ANAHTAR
  is_sha "$1" || return 0
  grep -E "^$2=" "$(rec_file "$1")" 2>/dev/null | head -n1 | cut -d= -f2- || true
}
rec_ok() { is_sha "${1:-}" && [ -s "$(rec_file "$1")" ] && [ -s "$REL/$1.migrations" ]; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
# İmaja derlemede gömülen commit (Dockerfile: ARG/ENV GIT_SHA) — yayınlanan commit ile onaylanan commit aynı mı
image_git_sha() { docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n 's/^GIT_SHA=//p' | head -n1 || true; }
cid() { compose ps -q "$1" 2>/dev/null | head -n 1 || true; }

# Veritabanında uygulanmış migration'lar: "ad checksum" satırları (sıralı). Okunamazsa 1.
mig_state() {
  local out
  out=$(db_sql 'SELECT migration_name || '"' '"' || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' takip 2>/dev/null) || return 1
  printf '%s\n' "$out" | grep -E '^[A-Za-z0-9_.-]+ [0-9a-f]+$' | LC_ALL=C sort || true
}
# Yarım kalmış (başlamış, bitmemiş, geri alınmamış) migration sayısı; okunamazsa boş
mig_failed() { db_sql 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL' takip 2>/dev/null | tr -cd '0-9' || true; }
# Commit'in kaynağındaki migration klasörleri (yalnızca yayın ÖNCESİ "bu yayın neler uygulayacak" bilgisi için)
mig_tree() { git -C "$SRC" ls-tree -d --name-only "$1:prisma/migrations" 2>/dev/null | LC_ALL=C sort || true; }
# mig_pending SHA → SHA'nın getirdiği, veritabanında henüz uygulanmamış migration adları
mig_pending() {
  local applied
  applied=$(mig_state | cut -d' ' -f1) || return 1
  LC_ALL=C comm -23 <(mig_tree "$1") <(printf '%s\n' "$applied" | LC_ALL=C sort) | grep . || true
}

# /surum yanıtı (sunucunun kendisi üzerinden HTTPS, Caddy içinden; DNS'e bağlı değil — APP_DOMAIN: takip.gkh.ro)
surum_json() {
  local domain; domain=$(env_get APP_DOMAIN)
  [ -n "$domain" ] && command -v curl >/dev/null 2>&1 || return 1
  curl -fsSk --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/surum" 2>/dev/null
}

# Salt okunur uygulama yoklaması: verilen etiketin ARAÇ imajındaki Prisma istemcisi, veritabanındaki bütün modelleri tek bir
# READ ONLY işlemde okur (findFirst). Yazma yoktur (PostgreSQL işlemi salt okunur); veri ekrana / günlüğe yazılmaz — çıktı
# yalnızca "PROBE_OK n" ya da "PROBE_FAIL MODEL KOD". Betik araca gömülüdür: yoklama, betiği içermeyen eski imajlarda da çalışır.
PROBE_RESULT=''
probe_tag() { # probe_tag ETİKET → 0 başarılı; PROBE_RESULT: son satır
  local out
  PROBE_RESULT=''
  out=$(APP_TAG="$1" compose run --rm --no-deps -T tools node - 2>/dev/null <<'JS'
const { PrismaClient, Prisma } = require('@prisma/client');
(async () => {
  const db = new PrismaClient();
  let out = 'PROBE_FAIL CLIENT';
  const code = (e) => String((e && e.code) || 'ERR').replace(/[^A-Z0-9_]/g, '').slice(0, 12) || 'ERR';
  try {
    const names = Object.values((Prisma && Prisma.ModelName) || {});
    if (!names.length) out = 'PROBE_FAIL NO_MODELS';
    else {
      out = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 8000');
        for (const n of names) {
          const k = n.charAt(0).toLowerCase() + n.slice(1);
          if (!tx[k] || typeof tx[k].findFirst !== 'function') return 'PROBE_FAIL ' + n + ' NO_DELEGATE';
          try { await tx[k].findFirst({}); } catch (e) { return 'PROBE_FAIL ' + n + ' ' + code(e); }
        }
        return 'PROBE_OK ' + names.length;
      }, { timeout: 120000, maxWait: 10000 });
    }
  } catch (e) {
    out = 'PROBE_FAIL TX ' + code(e);
  } finally {
    await db.$disconnect().catch(() => {});
  }
  process.stdout.write(out.replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 120) + '\n');
  process.exit(out.startsWith('PROBE_OK') ? 0 : 1);
})();
JS
) || true
  PROBE_RESULT=$(printf '%s\n' "$out" | grep -E '^PROBE_(OK|FAIL)' | tail -n1 | tr -cd 'A-Za-z0-9_ ' | cut -c1-120 || true)
  case $PROBE_RESULT in 'PROBE_OK '*) return 0 ;; esac
  return 1
}

# health_once ETİKET SÜRÜM SİTE(1|0) [yoklama(1|0)] → HC: sorun kodları (boş = sağlıklı). Alt kabukta çağrılmaz
# (yoklamanın sonucu PROBE_RESULT'a yazılır ve kayda geçer).
HC=''
health_once() {
  local tag=$1 ver=$2 edge=$3 probe=${4:-1} codes='' app w st started now out v b n
  app=$(cid app)
  if [ -z "$app" ] || [ "$(docker inspect -f '{{.State.Health.Status}}' "$app" 2>/dev/null || true)" != healthy ]; then codes="$codes APP_DOWN"; fi
  if [ -z "$app" ] || [ "$(docker inspect -f '{{.Image}}' "$app" 2>/dev/null || true)" != "$(image_id "takip:$tag")" ]; then codes="$codes APP_IMAGE"; fi
  w=$(cid worker)
  st=$(docker inspect -f '{{.State.Status}}|{{.State.Restarting}}|{{.State.StartedAt}}' "$w" 2>/dev/null || true)
  if [ -z "$w" ] || [ "${st%%|*}" != running ] || [ "$(echo "$st" | cut -d'|' -f2)" != false ]; then
    codes="$codes WORKER_DOWN"
  else
    # Yeni başlamış işçi henüz "ayakta" sayılmaz (çöküp yeniden başlama döngüsü yakalansın)
    started=$(date -d "$(echo "$st" | cut -d'|' -f3)" +%s 2>/dev/null || echo 0)
    now=$(date +%s)
    [ $((now - started)) -ge "$WORKER_MIN_UP" ] || codes="$codes WORKER_DOWN"
  fi
  if [ -z "$w" ] || [ "$(docker inspect -f '{{.Image}}' "$w" 2>/dev/null || true)" != "$(image_id "takip:$tag-tools")" ]; then codes="$codes WORKER_IMAGE"; fi
  if [ "$(db_sql 'SELECT 1' takip 2>/dev/null || true)" != 1 ]; then
    codes="$codes DB"
  else
    n=$(mig_failed)
    [ "$n" = 0 ] || codes="$codes MIGRATION_FAILED"
  fi
  if [ "$edge" = 1 ]; then
    if out=$(surum_json); then
      v=$(jq -r '.version // ""' <<<"$out" 2>/dev/null || true)
      b=$(jq -r '.build // ""' <<<"$out" 2>/dev/null || true)
      if [ "$v" != "$ver" ] || [ "$b" != "$(short "$tag")" ]; then codes="$codes VERSION"; fi
    else
      codes="$codes EDGE"
    fi
  fi
  if [ "$probe" = 1 ] && [ -z "$codes" ] && ! probe_tag "$tag"; then codes="$codes PROBE"; fi
  HC=$(echo "$codes" | xargs -r -n1 2>/dev/null | sort -u | xargs -r || true)
}
# release_health ETİKET SÜRÜM SİTE → 0 sağlıklı. Geçici gecikmelere karşı sınırlı tekrar: HEALTH_TRIES tur, aralarında
# HEALTH_GAP sn. HEALTH_CODES: son turun sorunları; HEALTH_NOTE: geçici sorun görüldüyse ilk turun kodları.
HEALTH_CODES='' HEALTH_NOTE=''
release_health() {
  local tag=$1 ver=$2 edge=$3 i codes
  HEALTH_CODES='' HEALTH_NOTE=''
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    health_once "$tag" "$ver" "$edge"
    codes=$HC
    if [ -z "$codes" ]; then HEALTH_CODES=''; return 0; fi
    [ -n "$HEALTH_NOTE" ] || HEALTH_NOTE=$codes
    log "  sağlık denetimi $i/$HEALTH_TRIES: $codes"
    [ "$i" -lt "$HEALTH_TRIES" ] && sleep "$HEALTH_GAP"
  done
  HEALTH_CODES=$codes
  return 1
}

# Kayıt: release_record SHA ETİKET KAYNAK SİTE_DENETİMİ — sağlık denetimi BAŞARILI olduktan sonra çağrılır.
release_record() {
  local sha=$1 tag=$2 src=$3 edge=$4 mig app tools ver h
  app=$(image_id "takip:$tag"); tools=$(image_id "takip:$tag-tools")
  [ -n "$app" ] && [ -n "$tools" ] || { log "⚠ sağlıklı sürüm kaydı yazılamadı: imaj kimliği okunamadı"; return 1; }
  mig=$(mig_state) || { log "⚠ sağlıklı sürüm kaydı yazılamadı: migration listesi okunamadı"; return 1; }
  ver=$(version_of "$sha")
  # Yayın zamanı: yayında kaydedilirken yayının başladığı an; doğrulama / geri dönüş kaydında önceki değer korunur
  local da; da=$(rec_get "$sha" deployed_at)
  if [ "$src" = deploy ] || [ -z "$da" ]; then da=${REL_DEPLOYED_AT:-$(now_iso)}; fi
  printf '%s\n' "$mig" | grep . | atomic_write "$REL/$sha.migrations" || true
  [ -s "$REL/$sha.migrations" ] || { log "⚠ sağlıklı sürüm kaydı yazılamadı: migration listesi boş"; rm -f "$REL/$sha.migrations"; return 1; }
  {
    echo "sha=$sha"
    echo "version=$ver"
    echo "tag=$tag"
    echo "app_image=$app"
    echo "tools_image=$tools"
    echo "deployed_at=$da"
    echo "verified_at=$(now_iso)"
    echo "migrations_count=$(grep -c . "$REL/$sha.migrations")"
    echo "migrations_last=$(tail -n1 "$REL/$sha.migrations" | cut -d' ' -f1)"
    echo "migrations_sha256=$(sha256sum "$REL/$sha.migrations" | cut -c1-64)"
    echo "health=app,worker,images,db,migrations,probe$([ "$edge" = 1 ] && echo ',site' || true)"
    echo "source=$src"
  } | atomic_write "$(rec_file "$sha")"
  # Göstergeler: yeni sağlıklı sürüm; önceki sağlıklı sürüm geri dönüş adayı olur (aynı imajı kullanıyorsa aday değişmez)
  h=$(read_ptr "$REL_HEALTHY")
  if [ "$src" = rollback ]; then
    echo "$sha" | atomic_write "$REL_HEALTHY"
    rm -f "$REL_PREV"
  elif [ "$h" != "$sha" ]; then
    if [ -n "$h" ] && [ "$(rec_get "$h" tag)" != "$tag" ]; then echo "$h" | atomic_write "$REL_PREV"; fi
    echo "$sha" | atomic_write "$REL_HEALTHY"
  fi
  rm -f "$REL/pre-$sha.migrations"
  rlog "SAGLIKLI_KAYIT $ver $(short "$sha") etiket=$(short "$tag") kaynak=$src uygulama=${app:7:12} isci=${tools:7:12} migration=$(grep -c . "$REL/$sha.migrations") yoklama=${PROBE_RESULT:-yok}"
  release_prune_records
}
# Eski kayıtlar: göstergedeki / yayındaki sürümler ve en yeni REL_KEEP_RECORDS kayıt kalır; yalnızca bu klasördeki kendi dosyalarımız
release_prune_records() {
  local keep f s
  keep=" $(read_ptr "$REL_HEALTHY") $(read_ptr "$REL_PREV") $(read_ptr "$STATE/deployed") "
  # shellcheck disable=SC2012 # adlar sabit biçimlidir (SHA.kayit)
  for f in $(ls -1t "$REL"/*.kayit 2>/dev/null | tail -n +$((REL_KEEP_RECORDS + 1))); do
    s=$(basename "$f" .kayit)
    is_sha "$s" || continue
    case $keep in *" $s "*) continue ;; esac
    rm -f "$REL/$s.kayit" "$REL/$s.migrations"
  done
}
# İmaj temizliğinde korunacak etiketler: yayındaki, bir önceki (yayın sırasındaki), son sağlıklı ve geri dönüş adayı
protected_tags() { # protected_tags [EK_ETİKET …]
  local t s
  for t in "$@" "$(env_get APP_TAG)" "$(rec_get "$(read_ptr "$REL_HEALTHY")" tag)" "$(rec_get "$(read_ptr "$REL_PREV")" tag)"; do
    [ -n "$t" ] || continue
    echo "$t"; echo "$t-tools"
  done
  s=$(read_ptr "$STATE/deployed"); [ -n "$s" ] && { echo "$s"; echo "$s-tools"; }
  return 0
}
# Eski imajlar silinir; korunanlar asla (son sağlıklı sürüm ve geri dönüş adayı dahil)
release_prune_images() { # release_prune_images [EK_ETİKET …]
  local keep t
  keep=" $(protected_tags "$@" | sort -u | xargs) "
  for t in $(docker images takip --format '{{.Tag}}' 2>/dev/null || true); do
    case $keep in *" $t "*) ;; *) docker rmi "takip:$t" >/dev/null 2>&1 || true ;; esac
  done
  docker image prune -f >/dev/null 2>&1 || true
}

# Yarıda kalan işlem işareti: yayın / geri dönüş başlarken yazılır, bitince silinir. Sunucu işlem ortasında yeniden başlarsa
# bir sonraki çalıştırma (kilit alındıktan sonra) bunu görür: release_recover.
op_begin() { # op_begin TÜR KAYNAK HEDEF
  { echo "op=$1"; echo "from=$2"; echo "to=$3"; echo "started=$(now_iso)"; echo "pid=$$"; } | atomic_write "$REL_OP"
  rlog "BASLADI $1 $(short "${2:-yok}") → $(short "$3")"
}
op_end() { rm -f "$REL_OP"; }
op_get() { grep -E "^$1=" "$REL_OP" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

# Geri dönüş hedefi: yayındaki sürüm doğrulanmış sağlıklı sürüm DEĞİLSE o sağlıklı sürüm; yayındaki zaten sağlıklıysa ondan
# önceki sağlıklı sürüm (aday). Hiçbiri yoksa boş.
rollback_target() {
  local d h p
  d=$(read_ptr "$STATE/deployed"); h=$(read_ptr "$REL_HEALTHY"); p=$(read_ptr "$REL_PREV")
  if [ -n "$h" ] && [ "$h" != "$d" ] && [ "$(rec_get "$h" tag)" != "$(env_get APP_TAG)" ]; then echo "$h"
  elif [ -n "$p" ] && [ "$p" != "$d" ]; then echo "$p"
  fi
}
# rollback_verdict HEDEF [yoklama] → 0 güvenli. RB_CODES: engeller; RB_DETAIL: migration farkı (yalnızca adlar).
RB_CODES='' RB_DETAIL=''
rollback_verdict() {
  local t=$1 probe=${2:-} tag cur d n cf vrc=0
  RB_CODES='' RB_DETAIL=''
  if ! rec_ok "$t"; then RB_CODES=NO_RECORD; return 1; fi
  tag=$(rec_get "$t" tag)
  if [ -z "$(image_id "takip:$tag")" ] || [ -z "$(image_id "takip:$tag-tools")" ]; then RB_CODES="$RB_CODES IMAGE_MISSING"
  elif [ "$(image_id "takip:$tag")" != "$(rec_get "$t" app_image)" ] || [ "$(image_id "takip:$tag-tools")" != "$(rec_get "$t" tools_image)" ]; then RB_CODES="$RB_CODES IMAGE_CHANGED"
  fi
  if cur=$(mig_state); then
    n=$(mig_failed)
    [ "$n" = 0 ] || RB_CODES="$RB_CODES MIGRATION_FAILED"
    if ! d=$(LC_ALL=C diff <(cat "$REL/$t.migrations") <(printf '%s\n' "$cur" | grep .)); then
      RB_CODES="$RB_CODES MIGRATION_CHANGED"
      # Yalnızca ad ve yön: + hedeften sonra uygulanmış · - hedefte olup şimdi olmayan (checksum farkı her iki satırda görünür)
      RB_DETAIL=$(printf '%s\n' "$d" | sed -n -e 's/^> \([^ ]*\) .*/+\1/p' -e 's/^< \([^ ]*\) .*/-\1/p' | head -n 20 | xargs || true)
    fi
  else
    RB_CODES="$RB_CODES DB"
  fi
  # Hedefin Caddyfile'ı yayındakinden farklıysa çalışan Caddy'nin sürümüyle doğrulanır
  if ! git -C "$SRC" cat-file -e "$t^{commit}" 2>/dev/null; then
    RB_CODES="$RB_CODES NO_SOURCE"
  elif ! git -C "$SRC" diff --quiet HEAD "$t" -- deploy/Caddyfile 2>/dev/null; then
    cf=$(mktemp)
    git -C "$SRC" show "$t:deploy/Caddyfile" >"$cf" 2>/dev/null || true
    caddy_validate "$cf" >/dev/null || vrc=$?
    rm -f "$cf"
    [ "$vrc" = 1 ] && RB_CODES="$RB_CODES CADDY_INVALID"
  fi
  if [ -z "$RB_CODES" ] && [ "$probe" = yoklama ] && ! probe_tag "$tag"; then RB_CODES="$RB_CODES PROBE"; fi
  RB_CODES=$(echo "$RB_CODES" | xargs -r -n1 2>/dev/null | sort -u | xargs -r || true)
  [ -z "$RB_CODES" ]
}
rb_code_text() {
  case $1 in
    NO_RECORD) echo 'hedefin doğrulanmış sağlıklı sürüm kaydı yok' ;;
    NO_TARGET) echo 'geri dönülecek doğrulanmış sağlıklı sürüm yok' ;;
    IMAGE_MISSING) echo 'hedefin uygulama / işçi imajı sunucuda yok' ;;
    IMAGE_CHANGED) echo 'hedefin imaj kimliği kayıttakiyle aynı değil' ;;
    MIGRATION_CHANGED) echo 'hedeften sonra veritabanına migration uygulanmış (eski kodla uyumluluk kanıtlanamıyor)' ;;
    MIGRATION_FAILED) echo 'veritabanında yarım kalmış migration var' ;;
    DB) echo 'veritabanına erişilemedi' ;;
    NO_SOURCE) echo 'hedefin kaynağı (git) sunucuda yok' ;;
    CADDY_INVALID) echo "hedefin Caddyfile'ı çalışan Caddy'de geçersiz" ;;
    PROBE) echo "hedefin Prisma istemcisi veritabanını salt okunur okuyamadı" ;;
    BUSY) echo 'başka bir yayın / geri dönüş / geri yükleme sürüyor' ;;
    *) echo "$1" ;;
  esac
}

# Yönetici e-postası: mevcut güvenli alarm altyapısıyla (karar 249 / 275 — sabit metin, yalnızca kodlar) scripts/release-alert.mjs.
# Betiği içeren ilk imaj kullanılır (yeni sürüm, yayındaki, son sağlıklı). Gönderilemezse yalnızca kayda yazılır.
release_alert() { # release_alert TÜR KAYNAK_SÜRÜM HEDEF_SÜRÜM [KOD …]
  local kind=$1 from=$2 to=$3 host t tag='' rc=0; shift 3
  for t in "${ALERT_TAG:-}" "$(env_get APP_TAG)" "$(rec_get "$(read_ptr "$REL_HEALTHY")" tag)"; do
    [ -n "$t" ] || continue
    if git -C "$SRC" cat-file -e "$t:scripts/release-alert.mjs" 2>/dev/null && [ -n "$(image_id "takip:$t-tools")" ]; then tag=$t; break; fi
  done
  if [ -z "$tag" ]; then rlog "ALARM_GONDERILEMEDI $kind (betik içeren imaj yok) $*"; return 0; fi
  host=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9.-' | cut -c1-64)
  APP_TAG="$tag" compose run --rm --no-deps -T tools node scripts/release-alert.mjs "$kind" --host "${host:-sunucu}" \
    --from "$from" --to "$to" --mode "$(rollback_mode)" "$@" >/dev/null 2>&1 </dev/null || rc=$?
  if [ "$rc" = 0 ]; then rlog "ALARM $kind gönderildi: $*"; else rlog "ALARM_GONDERILEMEDI $kind (çıkış $rc): $*"; fi
  return 0
}

# Yayın öncesi denetim (derlemeden sonra, yedek ve migration'dan ÖNCE; hiçbir şeyi değiştirmez). 1 → yayın durdurulur.
predeploy_checks() { # predeploy_checks SHA
  local sha=$1 app w h n t age pend
  app=$(cid app); w=$(cid worker)
  log "  yayın öncesi: uygulama $(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app" 2>/dev/null || echo yok), işçi $(docker inspect -f '{{.State.Status}}' "$w" 2>/dev/null || echo yok)"
  compose up -d db >/dev/null 2>&1 || true
  local i
  for ((i = 1; i <= ${TAKIP_DB_TRIES:-6}; i++)); do [ "$(db_sql 'SELECT 1' takip 2>/dev/null || true)" = 1 ] && break; sleep "${TAKIP_DB_GAP:-5}"; done
  if [ "$(db_sql 'SELECT 1' takip 2>/dev/null || true)" != 1 ]; then
    log "✘ yayın öncesi: PostgreSQL'e erişilemiyor; yayınlanmadı (hiçbir şey değişmedi)."
    return 1
  fi
  n=$(mig_failed)
  if [ -n "$n" ] && [ "$n" != 0 ]; then
    log "✘ yayın öncesi: veritabanında yarım kalmış migration var ($n); yayınlanmadı — elle inceleme gerekir."
    return 1
  fi
  t=$(mtime "$STATE/backup-last-ok")
  if [ -n "$t" ]; then
    age=$(( ($(date +%s) - t) / 3600 ))
    if [ "$age" -le 26 ]; then log "  yayın öncesi: son tam yedek (yerel + Drive) $age saat önce"; else log "⚠ yayın öncesi: son tam yedek $age saat önce (26 saatten eski); yayından hemen önce ayrıca veritabanı yedeği alınır"; fi
  else
    log "⚠ yayın öncesi: tam yedek kaydı yok; yayından hemen önce veritabanı yedeği alınır"
  fi
  h=$(read_ptr "$REL_HEALTHY")
  if [ -n "$h" ]; then
    if [ -n "$(image_id "takip:$(rec_get "$h" tag)")" ] && [ -n "$(image_id "takip:$(rec_get "$h" tag)-tools")" ]; then
      log "  yayın öncesi: son sağlıklı sürüm $(rec_get "$h" version) ($(short "$h")) — imajları mevcut ve temizlikten korunuyor"
    else
      log "⚠ yayın öncesi: son sağlıklı sürümün ($(short "$h")) imajı sunucuda yok — bu sürüme geri dönülemez"
    fi
  else
    log "  yayın öncesi: henüz doğrulanmış sağlıklı sürüm kaydı yok (ilk kayıt bu yayından / ilk denetimden sonra yazılır)"
  fi
  # Veritabanının şu anki migration durumu saklanır: yayın yarıda kalırsa / açılmazsa "migration uygulandı mı" bundan anlaşılır
  mig_state | grep . | atomic_write "$REL/pre-$sha.migrations" || true
  pend=$(mig_pending "$sha" | xargs || true)
  if [ -z "$pend" ]; then
    log "  yayın öncesi: yeni migration yok — sorun olursa önceki sürüme güvenli dönüş mümkün"
  else
    log "  yayın öncesi: bu yayın $(echo "$pend" | wc -w) migration uygular ($(echo "$pend" | cut -c1-300)) — yayından sonra önceki sürüme otomatik dönüş MÜMKÜN OLMAYACAK"
  fi
  rlog "ON_DENETIM $(version_of "$sha") $(short "$sha") migration=$(echo "$pend" | wc -w)"
  return 0
}
# Yayın (veritabanı güncellemesinden sonra) açılmadıysa: veritabanının migration durumu yayın öncesiyle AYNIYSA önceki sürüme
# dönülür (eski davranış, kanıtlanmış güvenli); farklıysa dönülmez — eski kod yeni şemayla çalıştırılmaz, elle müdahale gerekir.
mig_unchanged_since() { # mig_unchanged_since SHA → 0: yayın öncesi durumla aynı
  local cur
  [ -f "$REL/pre-$1.migrations" ] || return 1
  cur=$(mig_state) || return 1
  [ "$(printf '%s\n' "$cur" | grep . || true)" = "$(cat "$REL/pre-$1.migrations")" ]
}

# Geri dönüşü uygular (kilit çağıranda). NASIL: elle | otomatik | devam (yarıda kalan geri dönüşü tamamlama).
# Dönüş: 0 başarılı · 1 geri dönüldü ama sağlık denetimi geçmedi · 2 reddedildi (hiçbir şey değişmedi)
do_rollback() { # do_rollback HEDEF NASIL
  local t=$1 how=$2 d tag ver caddy_changed=0 t0=$SECONDS blog secs
  d=$(read_ptr "$STATE/deployed")
  tag=$(rec_get "$t" tag); ver=$(rec_get "$t" version)
  if ! rollback_verdict "$t" yoklama; then
    log "✘ geri dönüş ($how) REDDEDİLDİ → $ver ($(short "$t")): $RB_CODES${RB_DETAIL:+ [$RB_DETAIL]} — hiçbir şey değişmedi"
    rlog "GERI_DONUS_RED $how $(short "${d:-yok}") → $(short "$t") $RB_CODES${RB_DETAIL:+ [$RB_DETAIL]}"
    return 2
  fi
  if [ -n "$d" ] && ! git -C "$SRC" diff --quiet "$d" "$t" -- deploy/Caddyfile 2>/dev/null; then caddy_changed=1; fi
  op_begin rollback "$d" "$t"
  # Geri dönülen sürüm otomatik güncellemeyle yeniden yayınlanmasın (yeni commit gelince yayın normal sürer)
  if [ -n "$d" ] && [ "$d" != "$t" ] && [ "$how" != devam ]; then echo "$d" >"$STATE/failed"; fi
  blog="$LOGS/geri-donus-$(short "$t").log"
  log "↩ $ver ($(short "$t")) sürümüne geri dönülüyor ($how; veritabanına dokunulmaz)…"
  git -C "$SRC" checkout --quiet --force "$t"
  env_set APP_TAG "$tag"
  compose up -d --remove-orphans >>"$blog" 2>&1 || true
  if [ "$caddy_changed" = 1 ]; then compose restart caddy >>"$blog" 2>&1 || true; fi
  local edge=0
  wait_healthy "${TAKIP_ROLLBACK_WAIT:-240}" || true
  if wait_edge "${TAKIP_EDGE_WAIT:-90}" "$(short "$tag")"; then edge=1; fi
  if release_health "$tag" "$ver" "$edge"; then
    echo "$t" >"$STATE/deployed"
    release_record "$t" "$tag" rollback "$edge" || true
    op_end
    secs=$((SECONDS - t0))
    log "✔ geri dönüldü: $ver ($(short "$t")) yayında — sağlık denetimi geçti ($secs sn)"
    rlog "GERI_DONUS_TAMAM $how $(short "${d:-yok}") → $(short "$t") sure=${secs}sn"
    release_alert ROLLBACK_DONE "$(version_of "${d:-$t}")" "$ver"
    return 0
  fi
  echo "$t" >"$STATE/deployed"
  op_end
  secs=$((SECONDS - t0))
  log "✘ geri dönüldü ama $ver ($(short "$t")) sağlık denetiminden geçmedi: $HEALTH_CODES — ELLE MÜDAHALE gerekir (takip surum-durum)"
  rlog "GERI_DONUS_SAGLIKSIZ $how $(short "${d:-yok}") → $(short "$t") $HEALTH_CODES sure=${secs}sn"
  release_alert ROLLBACK_FAILED "$(version_of "${d:-$t}")" "$ver" $HEALTH_CODES
  return 1
}

# Yayın sonrası sağlık sorunu (uygulama açıldı, Caddy yeni sürümü veriyor ama tam denetim geçmedi). Gözlem kipinde yalnızca
# algılanır, kaydedilir, geri dönüşün güvenli olup olmadığı hesaplanır ve e-posta gider; otomatik kipte güvenliyse dönülür.
post_deploy_unhealthy() { # post_deploy_unhealthy SHA
  local sha=$1 ver t mode verdict
  ver=$(version_of "$sha"); mode=$(rollback_mode)
  echo "$sha" >"$STATE/deployed"
  echo "$sha" >"$STATE/failed"
  echo "$sha" >"$REL_ADOPT"
  t=$(rollback_target)
  if [ -z "$t" ]; then
    verdict=NO_TARGET
  elif rollback_verdict "$t" yoklama; then
    verdict=SAFE
  else
    verdict=UNSAFE
  fi
  log "✘ $ver ($(short "$sha")) sağlık denetiminden GEÇMEDİ: $HEALTH_CODES — sağlıklı sürüm kaydı yazılmadı"
  case $verdict in
    SAFE) log "  geri dönüş hedefi $(rec_get "$t" version) ($(short "$t")): GÜVENLİ" ;;
    UNSAFE) log "  geri dönüş hedefi $(rec_get "$t" version) ($(short "$t")): GÜVENLİ DEĞİL — $RB_CODES${RB_DETAIL:+ [$RB_DETAIL]}" ;;
    *) log "  geri dönülecek doğrulanmış sağlıklı sürüm yok" ;;
  esac
  rlog "YAYIN_SAGLIKSIZ $ver $(short "$sha") $HEALTH_CODES kip=$mode geri_donus=$verdict${t:+ hedef=$(short "$t")} ${RB_CODES}"
  if [ "$mode" = otomatik ] && [ "$verdict" = SAFE ]; then
    ALERT_TAG=$sha release_alert DEPLOY_UNHEALTHY "$ver" "$(rec_get "$t" version)" $HEALTH_CODES ROLLBACK_AUTO
    do_rollback "$t" otomatik || true
    return 0
  fi
  if [ "$mode" = gozlem ]; then
    log "  GÖZLEM KİPİ: canlı servis kendiliğinden eski sürüme geçirilmedi. Değerlendirme: sudo takip rollback-kontrol · elle: sudo takip rollback"
  else
    log "  otomatik geri dönüş yapılamaz ($verdict): ELLE MÜDAHALE gerekir"
  fi
  # shellcheck disable=SC2086 # kodlar tek kelimeliktir
  ALERT_TAG=$sha release_alert DEPLOY_UNHEALTHY "$ver" "$(rec_get "$t" version)" $HEALTH_CODES "ROLLBACK_$verdict" $RB_CODES
}

# Yarıda kalmış işlem (sunucu / süreç işlem ortasında durdu): kilit alındıktan sonra bir kez. Yayın → işaret silinir, olağan
# akış aynı commit'i yeniden dener (yayın adımları yinelenebilir: derleme önbellekten, migration yeniden uygulanmaz).
# Geri dönüş → aynı denetimlerden geçerse tamamlanır (veritabanına dokunmaz); geçmezse durur ve e-posta gider.
REL_RECOVERED=0
release_recover() {
  [ -s "$REL_OP" ] || return 0
  local op from to
  REL_RECOVERED=1
  op=$(op_get op); from=$(op_get from); to=$(op_get to)
  log "⚠ yarıda kalmış işlem bulundu: $op $(short "${from:-yok}") → $(short "${to:-yok}") (başlangıç $(op_get started))"
  rlog "YARIDA_KALDI $op $(short "${from:-yok}") → $(short "${to:-yok}")"
  case $op in
    rollback)
      op_end
      if is_sha "$to" && rec_ok "$to"; then
        do_rollback "$to" devam || true
      fi
      ALERT_TAG='' release_alert INTERRUPTED "$(version_of "${from:-$to}")" "$(version_of "$to")" OP_ROLLBACK
      ;;
    *)
      op_end
      ALERT_TAG='' release_alert INTERRUPTED "$(version_of "${from:-$to}")" "$(version_of "$to")" OP_DEPLOY
      ;;
  esac
}

# Boşta (yeni sürüm yokken) denetim: yayındaki sürümün kaydı yoksa bir kez doğrulanır ve kaydedilir (3.92.0'ın ilk yayını aracın
# ÖNCEKİ sürümüyle yapılır; kayıt ilk denetimde yazılır). Uygulama ile işçi farklı imajlarla çalışıyorsa e-posta (bir kez).
release_idle() {
  local d tag app w sig
  d=$(read_ptr "$STATE/deployed"); tag=$(env_get APP_TAG)
  [ -n "$d" ] && [ -n "$tag" ] || return 0
  app=$(cid app); w=$(cid worker)
  if [ -n "$app" ] && [ -n "$w" ]; then
    sig="$(docker inspect -f '{{.Image}}' "$app" 2>/dev/null || true)|$(docker inspect -f '{{.Image}}' "$w" 2>/dev/null || true)"
    if [ "${sig%%|*}" != "$(image_id "takip:$tag")" ] || [ "${sig#*|}" != "$(image_id "takip:$tag-tools")" ]; then
      if [ "$(cat "$REL_MISMATCH" 2>/dev/null || true)" != "$sig" ]; then
        echo "$sig" | atomic_write "$REL_MISMATCH"
        log "⚠ uygulama / işçi imajları yayındaki sürümle ($(short "$tag")) uyuşmuyor — takip surum-durum"
        rlog "UYUMSUZ uygulama=${sig:7:12} isci=$(echo "${sig#*|}" | cut -c8-19) beklenen=$(short "$tag")"
        release_alert MISMATCH "$(version_of "$d")" "$(version_of "$d")" STACK_MISMATCH
      fi
      return 0
    fi
    rm -f "$REL_MISMATCH"
  fi
  if [ "$(read_ptr "$REL_HEALTHY")" = "$d" ] || [ "$(read_ptr "$REL_ADOPT")" = "$d" ] || [ "$(read_ptr "$STATE/failed")" = "$d" ]; then return 0; fi
  echo "$d" | atomic_write "$REL_ADOPT"
  local edge=0
  if edge_ok; then edge=1; fi
  if release_health "$tag" "$(version_of "$tag")" "$edge"; then
    release_record "$d" "$tag" bootstrap "$edge" && log "✔ yayındaki sürüm $(version_of "$d") ($(short "$d")) doğrulandı ve sağlıklı sürüm olarak kaydedildi"
  else
    log "⚠ yayındaki sürüm $(version_of "$d") ($(short "$d")) doğrulanamadı: $HEALTH_CODES — kayıt yazılmadı (yeniden: sudo takip surum-dogrula)"
    rlog "DOGRULANAMADI $(short "$d") $HEALTH_CODES"
  fi
}

require_root() { [ "$(id -u)" = 0 ] || { say "✘ Bu komut root olarak çalıştırılmalı (sudo takip $1)."; return 1; }; }
rel_line() { # rel_line ETİKET SHA
  local s=$2
  if ! rec_ok "$s"; then say "$1: —"; return 0; fi
  say "$1: $(rec_get "$s" version) ($(short "$s")) — doğrulandı $(rec_get "$s" verified_at), kaynak: $(rec_get "$s" source)"
  say "    uygulama imajı: $(rec_get "$s" app_image)"
  say "    işçi/araç imajı: $(rec_get "$s" tools_image)"
  say "    migration: $(rec_get "$s" migrations_count) (son: $(rec_get "$s" migrations_last))"
}
cmd_release_status() {
  require_root surum-durum || return 1
  local d tag app w out
  d=$(read_ptr "$STATE/deployed"); tag=$(env_get APP_TAG)
  say "Adres          : $(env_get APP_URL)"
  if out=$(surum_json); then say "/surum         : $(jq -r '"\(.version) (\(.build))"' <<<"$out" 2>/dev/null || echo okunamadı)"; else say "/surum         : ⚠ yanıt yok (sunucu üzerinden HTTPS)"; fi
  say "Yayında        : $([ -n "$d" ] && echo "$(version_of "$d") ($(short "$d"))" || echo —) · imaj etiketi: $(short "${tag:-—}")"
  app=$(cid app); w=$(cid worker)
  say "Uygulama       : $(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}} {{.Image}}' "$app" 2>/dev/null || echo yok)"
  say "İşçi           : $(docker inspect -f '{{.State.Status}} {{.Image}}' "$w" 2>/dev/null || echo yok)"
  if [ -n "$tag" ] && { [ "$(docker inspect -f '{{.Image}}' "$app" 2>/dev/null || true)" != "$(image_id "takip:$tag")" ] || [ "$(docker inspect -f '{{.Image}}' "$w" 2>/dev/null || true)" != "$(image_id "takip:$tag-tools")" ]; }; then
    say "               ⚠ uygulama / işçi yayındaki imajla çalışmıyor"
  fi
  if [ -n "$d" ] && [ "$(read_ptr "$REL_HEALTHY")" != "$d" ]; then say "               ⚠ yayındaki sürüm doğrulanmış sağlıklı sürüm DEĞİL"; fi
  [ -n "$(read_ptr "$STATE/failed")" ] && say "Başarısız      : $(version_of "$(read_ptr "$STATE/failed")") ($(short "$(read_ptr "$STATE/failed")")) — yeni commit gelene kadar yeniden yayınlanmaz"
  [ -s "$REL_OP" ] && say "⚠ Süren / yarıda kalmış işlem: $(op_get op) $(short "$(op_get from)") → $(short "$(op_get to)") (başlangıç $(op_get started))"
  say ""
  rel_line "Son sağlıklı   " "$(read_ptr "$REL_HEALTHY")"
  rel_line "Geri dönüş adayı" "$(read_ptr "$REL_PREV")"
  say ""
  say "Geri dönüş kipi: $(rollback_mode)$([ "$(rollback_mode)" = gozlem ] && echo ' (sorun algılanır ve bildirilir; canlı servis kendiliğinden eski sürüme geçirilmez)' || true)"
  say "Yedek (salt okunur): son tam yedek (yerel + Drive): $(cat "$STATE/backup-last-ok" 2>/dev/null || echo 'kayıt yok') · son yedeğin sorunları: $([ -s "$STATE/backup-last-run" ] && cat "$STATE/backup-last-run" || echo yok)"
  say "                     doğrulanmış son çift — yerel: $(tail -n1 "$LEDGER_LOCAL" 2>/dev/null | grep -v '^since' || echo —), Drive: $(tail -n1 "$LEDGER_DRIVE" 2>/dev/null | grep -v '^since' || echo —) · Drive kopyası $([ -n "$(enc_recipient)" ] && echo şifreli || echo ŞİFRESİZ)"
  say ""
  say "Son işlemler ($REL_LOG):"
  tail -n 8 "$REL_LOG" 2>/dev/null | sed 's/^/  /' || true
}
cmd_rollback_status() {
  require_root rollback-durum || return 1
  local t
  t=$(rollback_target)
  say "Geri dönüş kipi : $(rollback_mode)"
  if [ -z "$t" ]; then say "Hedef           : yok — $(rb_code_text NO_TARGET)"; else
    say "Hedef           : $(rec_get "$t" version) ($(short "$t")), doğrulandı $(rec_get "$t" verified_at)"
    say "  uygulama imajı: $(rec_get "$t" app_image) $([ -n "$(image_id "takip:$(rec_get "$t" tag)")" ] && echo '(mevcut)' || echo '(YOK)')"
    say "  işçi imajı    : $(rec_get "$t" tools_image) $([ -n "$(image_id "takip:$(rec_get "$t" tag)-tools")" ] && echo '(mevcut)' || echo '(YOK)')"
    if rollback_verdict "$t"; then say "Ön değerlendirme: güvenli görünüyor (tam denetim + yoklama: sudo takip rollback-kontrol)"
    else say "Ön değerlendirme: GÜVENLİ DEĞİL — $RB_CODES${RB_DETAIL:+ [$RB_DETAIL]}"; fi
  fi
  [ -s "$REL_OP" ] && say "⚠ Süren / yarıda kalmış işlem: $(op_get op) $(short "$(op_get from)") → $(short "$(op_get to)")"
  say ""
  say "Geçmiş:"
  grep -E 'GERI_DONUS|YAYIN_|SAGLIKLI_KAYIT|YARIDA|KONTROL' "$REL_LOG" 2>/dev/null | tail -n 12 | sed 's/^/  /' || true
}
cmd_rollback_check() {
  require_root rollback-kontrol || return 1
  local t c busy=0
  exec 7>"$STATE/deploy.lock"
  if ! flock -n 7; then busy=1; else flock -u 7; fi
  t=$(rollback_target)
  if [ -z "$t" ]; then say "✘ $(rb_code_text NO_TARGET)."; rlog "KONTROL red NO_TARGET"; return 1; fi
  say "Hedef: $(rec_get "$t" version) ($(short "$t")) · yayındaki: $(version_of "$(read_ptr "$STATE/deployed")") ($(short "$(read_ptr "$STATE/deployed")"))"
  say "  uygulama imajı: $(rec_get "$t" app_image)"
  say "  işçi imajı    : $(rec_get "$t" tools_image)"
  say "Denetleniyor (imajlar, migration listesi, yarım migration, Caddyfile, salt okunur yoklama)…"
  if rollback_verdict "$t" yoklama && [ "$busy" = 0 ]; then
    say "✔ Geri dönüş GÜVENLİ: veritabanındaki migration listesi hedefin doğrulandığı andakiyle birebir aynı; imajlar mevcut; yoklama: $PROBE_RESULT"
    say "  Uygulamak için: sudo takip rollback (onay ister) — veritabanına dokunulmaz."
    rlog "KONTROL guvenli hedef=$(short "$t")"
    return 0
  fi
  [ "$busy" = 1 ] && RB_CODES="$RB_CODES BUSY"
  say "✘ Geri dönüş GÜVENLİ DEĞİL — reddedilir:"
  for c in $RB_CODES; do say "  - $(rb_code_text "$c") [$c]"; done
  [ -n "$RB_DETAIL" ] && say "  migration farkı: $RB_DETAIL"
  say "  Veritabanı yedeğe döndürülmez, migration geri alınmaz. Seçenekler: düzeltme sürümü yayınlamak ya da docs/geri-donus.md."
  rlog "KONTROL red hedef=$(short "$t") $RB_CODES${RB_DETAIL:+ [$RB_DETAIL]}"
  return 1
}
cmd_rollback() {
  require_root rollback || return 1
  local confirm='' t ans
  if [ "${1:-}" = --onay ]; then confirm=${2:-}; fi
  exec 9>"$STATE/deploy.lock"
  if ! flock -n 9; then
    say "✘ Bir yayın / geri dönüş / geri yükleme sürüyor; geri dönüş yapılmadı."
    rlog "GERI_DONUS_RED elle BUSY"
    return 1
  fi
  release_recover
  if [ "$REL_RECOVERED" = 1 ]; then
    say "Yarıda kalmış bir işlem bulundu ve ele alındı (ayrıntı: takip surum-durum). Yeni bir geri dönüş için komutu yeniden çalıştırın."
    return 1
  fi
  t=$(rollback_target)
  if [ -z "$t" ]; then say "✘ $(rb_code_text NO_TARGET); hiçbir şey değişmedi."; rlog "GERI_DONUS_RED elle NO_TARGET"; return 1; fi
  if ! rollback_verdict "$t" yoklama; then
    say "✘ Geri dönüş reddedildi ($(rec_get "$t" version), $(short "$t")) — hiçbir şey değişmedi:"
    local c; for c in $RB_CODES; do say "  - $(rb_code_text "$c") [$c]"; done
    [ -n "$RB_DETAIL" ] && say "  migration farkı: $RB_DETAIL"
    rlog "GERI_DONUS_RED elle hedef=$(short "$t") $RB_CODES${RB_DETAIL:+ [$RB_DETAIL]}"
    return 1
  fi
  say "Yayındaki : $(version_of "$(read_ptr "$STATE/deployed")") ($(short "$(read_ptr "$STATE/deployed")"))"
  say "Hedef     : $(rec_get "$t" version) ($(short "$t")) — uygulama $(rec_get "$t" app_image), işçi $(rec_get "$t" tools_image)"
  say "Veritabanına dokunulmaz (yedekten geri yükleme / migration geri alma yok). Yalnızca uygulama ve işçi eski imaja geçer."
  if [ -z "$confirm" ]; then
    if [ ! -t 0 ] && [ ! -e /dev/tty ]; then say "✘ Onay için terminal gerekir (ya da: takip rollback --onay KISA_SHA)."; return 1; fi
    tty_read ans "Onaylamak için hedefin kısa SHA'sını yazın ($(short "$t")): "
    confirm=$ans
  fi
  if [ "$confirm" != "$(short "$t")" ] && [ "$confirm" != "$t" ]; then say "Onaylanmadı; hiçbir şey değişmedi."; rlog "GERI_DONUS_VAZGECILDI hedef=$(short "$t")"; return 1; fi
  do_rollback "$t" elle
}
cmd_release_verify() {
  require_root surum-dogrula || return 1
  exec 9>"$STATE/deploy.lock"
  if ! flock -n 9; then say "✘ Bir yayın / geri dönüş sürüyor."; return 1; fi
  local d tag edge=0
  d=$(read_ptr "$STATE/deployed"); tag=$(env_get APP_TAG)
  [ -n "$d" ] && [ -n "$tag" ] || { say "✘ Yayında sürüm yok."; return 1; }
  if edge_ok; then edge=1; fi
  if release_health "$tag" "$(version_of "$tag")" "$edge"; then
    release_record "$d" "$tag" "$([ "$(read_ptr "$STATE/failed")" = "$d" ] && echo elle-dogrulama || echo bootstrap)" "$edge"
    say "✔ $(version_of "$d") ($(short "$d")) sağlık denetiminden geçti ve sağlıklı sürüm olarak kaydedildi."
  else
    say "✘ Sağlık denetimi geçmedi: $HEALTH_CODES — kayıt yazılmadı."
    return 1
  fi
}
cmd_rollback_mode() {
  require_root rollback-modu || return 1
  case ${1:-} in
    '') say "Geri dönüş kipi: $(rollback_mode)"; return 0 ;;
    gozlem | otomatik)
      echo "$1" | atomic_write "$REL_MODE"
      rlog "KIP $1"
      log "  geri dönüş kipi: $1"
      say "Geri dönüş kipi: $1"
      ;;
    *) say 'Kullanım: takip rollback-modu [gozlem|otomatik]'; return 1 ;;
  esac
}

# ---------- yayınlama ----------
do_deploy() { # do_deploy SHA ÖNCEKİ_SHA [uc] — "uc": yalnızca dalın güncel ucu yayınlanır (otomatik / elle güncelleme)
  local sha=$1 prev=${2:-} only_head=${3:-} rc=0
  # Kapıdan sonra dal ilerlediyse ESKİ commit yayınlanmaz (bir sonraki tur yeni ucu değerlendirir); çalışan sürüme dokunulmaz
  if [ "$only_head" = uc ] && ! head_is "$sha"; then
    log "⏸ $(version_of "$sha") ($(short "$sha")) yayınlanmadı: '$(branch)' dalının ucu değişti ya da doğrulanamadı; çalışan sürüm aynen sürüyor."
    return 0
  fi
  # Yarıda kalan işlem işareti (karar 287): süreç / sunucu yayın ortasında durursa bir sonraki çalıştırma bunu görür
  op_begin deploy "$prev" "$sha"
  REL_DEPLOYED_AT=$(now_iso)
  deploy_main "$sha" "$prev" "$only_head" || rc=$?
  op_end
  return "$rc"
}

# Yayın açılmadı (uygulama sağlıksız ya da site Caddy üzerinden yeni sürümü vermiyor). Veritabanının migration durumu yayın
# öncesiyle AYNIYSA önceki sürüme dönülür (karar 142'deki davranış; eski kod aynı şemayla çalışır — kanıtlı güvenli). Migration
# uygulandıysa eski kod yeni şemayla ÇALIŞTIRILMAZ: yeni sürüm yerinde kalır, yönetici e-postayla elle müdahaleye çağrılır.
deploy_failed() { # deploy_failed SHA ÖNCEKİ_SHA ÖNCEKİ_ETİKET DERLEME_GÜNLÜĞÜ CADDY_DEĞİŞTİ KOD
  local sha=$1 prev=$2 prev_tag=$3 blog=$4 caddy_changed=$5 code=$6 ver
  ver=$(version_of "$sha")
  if mig_unchanged_since "$sha"; then
    revert_release "$sha" "$prev" "$prev_tag" "$blog" "$caddy_changed"
    log "  migration uygulanmadığı için önceki sürüme dönüldü (veritabanı değişmedi)"
    rlog "YAYIN_ACILMADI $ver $(short "$sha") $code onceki_surume_donuldu"
    ALERT_TAG=$sha release_alert DEPLOY_FAILED "$ver" "$(version_of "${prev:-$sha}")" "$code" REVERTED
    return 0
  fi
  echo "$sha" >"$STATE/failed"
  echo "$sha" >"$STATE/deployed"
  echo "$sha" >"$REL_ADOPT"
  log "✘ $ver ($(short "$sha")): bu yayında migration uygulandı — eski kod yeni şemayla çalıştırılmaz, önceki sürüme OTOMATİK DÖNÜLMEDİ. ELLE MÜDAHALE gerekir: sudo takip surum-durum · docs/geri-donus.md"
  rlog "YAYIN_ACILMADI $ver $(short "$sha") $code donulmedi=MIGRATION_CHANGED"
  ALERT_TAG=$sha release_alert DEPLOY_FAILED "$ver" "$(version_of "${prev:-$sha}")" "$code" NOT_REVERTED MIGRATION_CHANGED
  return 0
}

deploy_main() { # deploy_main SHA ÖNCEKİ_SHA [uc]
  local sha=$1 prev=${2:-} only_head=${3:-} s ver f prev_tag tg edge=0
  s=$(short "$sha"); ver=$(version_of "$sha")
  log "▶ $ver ($s) yayınlanıyor…"

  # Yalnızca test / belge değiştiyse uygulama yeniden derlenmez
  if [ -n "$prev" ] && git -C "$SRC" cat-file -e "$prev^{commit}" 2>/dev/null &&
    git -C "$SRC" diff --quiet "$prev" "$sha" -- . ':(exclude)e2e' ':(exclude)test' ':(exclude)docs' \
      ':(exclude)*.md' ':(exclude).github' ':(exclude)prototype'; then
    git -C "$SRC" checkout --quiet --force "$sha"
    echo "$sha" >"$STATE/deployed"
    log "✔ $ver ($s): yalnızca test/belge değişti, uygulama olduğu gibi çalışıyor."
    # Çalışan imajlar aynı: yeni commit, sağlık denetiminden geçerse aynı imajlarla sağlıklı sürüm olarak kaydedilir
    tg=$(env_get APP_TAG)
    if edge_ok; then edge=1; fi
    if [ -n "$tg" ] && release_health "$tg" "$(version_of "$tg")" "$edge"; then
      release_record "$sha" "$tg" deploy "$edge" || true
    else
      echo "$sha" >"$REL_ADOPT"
      log "⚠ çalışan sürüm sağlık denetiminden geçmedi: ${HEALTH_CODES:-imaj etiketi yok} — sağlıklı sürüm kaydı yazılmadı"
    fi
    return 0
  fi

  # Caddyfile bu yayında değişiyor mu; site yayından ÖNCE Caddy üzerinden yanıt veriyor mu (sonraki denetimin ölçütü)
  local caddy_changed=0 edge_before=0 verr vrc=0
  if [ -n "$prev" ] && ! git -C "$SRC" diff --quiet "$prev" "$sha" -- deploy/Caddyfile 2>/dev/null; then caddy_changed=1; fi
  if edge_ok; then edge_before=1; fi

  git -C "$SRC" checkout --quiet --force "$sha"
  # Derlenen kaynak, kapının onayladığı commit'in ta kendisi mi (karar 287)
  if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" != "$sha" ]; then
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    log "✘ $ver ($s): kaynak onaylanan commit'e geçirilemedi; yayınlanmadı."
    return 1
  fi
  local blog="$LOGS/derleme-$s.log"
  # Yeni Caddyfile, derleme ve veritabanı adımlarından önce çalışan Caddy'nin sürümüyle doğrulanır
  if [ "$caddy_changed" = 1 ]; then
    verr=$(caddy_validate "$SRC/deploy/Caddyfile") || vrc=$?
    if [ "$vrc" = 0 ]; then
      log "  ön sunucu (Caddy): yeni Caddyfile geçerli"
    elif [ "$vrc" = 2 ]; then
      log "  ön sunucu (Caddy) çalışmıyor: yeni Caddyfile önceden doğrulanamadı (yayından sonra site denetlenecek)"
    else
      [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
      echo "$sha" >"$STATE/failed"
      log "✘ $ver ($s): Caddyfile geçersiz (çalışan Caddy kabul etmedi); yayınlanmadı, site önceki sürümle çalışmaya devam ediyor."
      log "  $(echo "$verr" | tr '\n' ' ' | cut -c1-400)"
      return 1
    fi
  fi
  if ! { docker build --build-arg GIT_SHA="$sha" --target runner -t "takip:$sha" "$SRC" &&
    docker build --build-arg GIT_SHA="$sha" --target tools -t "takip:$sha-tools" "$SRC"; } >"$blog" 2>&1; then
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    echo "$sha" >"$STATE/failed"
    log "✘ $ver ($s): derleme başarısız, önceki sürüm çalışmaya devam ediyor. Ayrıntı: $blog"
    # Başarısız derleme de önbellek bırakır (disk dolduysa derleme bu yüzden de başarısız olabilir): sınır denetlenir
    cache_housekeeping || true
    return 1
  fi
  # Derlenen imaj onaylanan commit'i taşıyor mu (imaja gömülen GIT_SHA)
  if [ "$(image_git_sha "takip:$sha")" != "$sha" ]; then
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
    echo "$sha" >"$STATE/failed"
    log "✘ $ver ($s): derlenen imaj onaylanan commit'i taşımıyor; yayınlanmadı."
    return 1
  fi

  # Derleme uzun sürer: veritabanına / kapsayıcılara dokunmadan HEMEN ÖNCE dal ucu ve yayın kapısı yeniden denetlenir
  if [ "$only_head" = uc ]; then
    local why=''
    if ! head_is "$sha"; then why='dal ucu değişti ya da doğrulanamadı'
    elif [ "$(gate "$sha" "$prev")" != success ]; then why='yayın kapısı artık başarılı değil'
    fi
    if [ -n "$why" ]; then
      [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
      log "⏸ $ver ($s) yayınlanmadı: derleme sırasında $why; çalışan sürüm aynen sürüyor."
      return 0
    fi
  fi
  # Yayın öncesi denetim (karar 287): veritabanı erişimi, yarım migration, son yedek, geri dönüş adayı, migration planı
  if ! predeploy_checks "$sha"; then
    [ -n "$prev" ] && git -C "$SRC" checkout --quiet --force "$prev"
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
    if mig_unchanged_since "$sha"; then
      rlog "MIGRATION_BASARISIZ $ver $s veritabani_degismedi"
      ALERT_TAG=$sha release_alert DEPLOY_FAILED "$ver" "$(version_of "${prev:-$sha}")" MIGRATION_ERROR REVERTED
    else
      log "⚠ veritabanının migration durumu yayın öncesinden farklı (migration kısmen uygulanmış olabilir) — ELLE İNCELEME gerekir: sudo takip surum-durum"
      rlog "MIGRATION_BASARISIZ $ver $s veritabani_DEGISTI"
      ALERT_TAG=$sha release_alert DEPLOY_FAILED "$ver" "$(version_of "${prev:-$sha}")" MIGRATION_ERROR MIGRATION_CHANGED
    fi
    return 1
  fi

  compose up -d --remove-orphans >>"$blog" 2>&1
  if [ "$caddy_changed" = 1 ]; then
    compose restart caddy >>"$blog" 2>&1 || true
  fi

  if ! wait_healthy 240; then
    log "✘ $ver ($s): yeni sürüm açılmadı. Ayrıntı: takip log"
    deploy_failed "$sha" "$prev" "$prev_tag" "$blog" "$caddy_changed" APP_DOWN
    return 1
  fi

  # Site HTTPS üzerinden, Caddy içinden YENİ sürüme ulaşıyor mu (Caddy yeni ayarla açıldı ve uygulamaya yönlendiriyor)
  if wait_edge "${TAKIP_EDGE_WAIT:-90}" "$s"; then
    log "  ön sunucu (Caddy): site HTTPS üzerinden yeni sürümü veriyor"
    edge=1
  elif [ "$edge_before" = 1 ]; then
    log "✘ $ver ($s): uygulama açıldı ama site HTTPS üzerinden (Caddy) yeni sürümü vermiyor. Caddy: $(caddy_state)"
    deploy_failed "$sha" "$prev" "$prev_tag" "$blog" "$caddy_changed" EDGE
    if [ "$(read_ptr "$STATE/deployed")" != "$sha" ]; then
      if wait_healthy 120 && wait_edge "${TAKIP_EDGE_WAIT:-60}"; then
        log "  önceki sürüm yeniden yayında."
      else
        log "⚠ önceki sürüme dönüldü ama site HTTPS üzerinden hâlâ yanıt vermiyor. Denetleyin: takip durum · takip log"
      fi
    fi
    return 1
  else
    log "⚠ site HTTPS üzerinden doğrulanamadı (yayından önce de yanıt vermiyordu); yayın sürdürüldü. Caddy: $(caddy_state)"
  fi

  # Tam sağlık denetimi (karar 287): uygulama + işçi doğru imajla çalışıyor, veritabanı, yarım migration yok, /surum doğru
  # sürüm ve commit, salt okunur Prisma yoklaması. Geçici gecikmeye karşı sınırlı tekrar.
  if ! release_health "$sha" "$ver" "$edge"; then
    post_deploy_unhealthy "$sha"
    return 1
  fi
  [ -n "$HEALTH_NOTE" ] && log "  sağlık denetimi geçici sorunu aştı (ilk turda: $HEALTH_NOTE)"

  echo "$sha" >"$STATE/deployed"
  rm -f "$STATE/failed"
  log "✔ $ver ($s) yayında: $(env_get APP_URL)"
  release_record "$sha" "$sha" deploy "$edge" || log "⚠ sağlıklı sürüm kaydı yazılamadı (yayın etkilenmedi)"
  rlog "YAYIN_TAMAM $ver $s"

  # Eski imajlar: yayındaki, bir önceki, son sağlıklı ve geri dönüş adayı TUTULUR (karar 287); diğerleri silinir
  release_prune_images "$sha" "$prev_tag"
  # Derleme önbelleği sınırı aşmışsa kullanılmayan önbellek silinir; hata yayını bozmaz
  cache_housekeeping || log "⚠ derleme önbelleği denetimi tamamlanamadı (yayın etkilenmedi)"
  echo "$sha" >"$STATE/cache-checked"
}

auto_deploy() {
  exec 9>"$STATE/deploy.lock"
  if ! flock -n 9; then info "Başka bir güncelleme sürüyor."; return 0; fi
  release_recover || true
  local b head current g
  b=$(branch)
  if ! git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$b:refs/remotes/origin/$b" 2>"$STATE/fetch.err"; then
    note_error "GitHub'dan güncelleme alınamadı: $(tr '\n' ' ' <"$STATE/fetch.err" | cut -c1-200) — anahtarın süresi dolmuş olabilir: takip github"
    return 1
  fi
  head=$(git -C "$SRC" rev-parse "origin/$b")
  current=$(cat "$STATE/deployed" 2>/dev/null || true)
  if [ "$head" = "$current" ]; then
    # Bu sürümü aracın ÖNCEKİ hâli yayınladıysa (araç yayınla birlikte güncellenir) ya da yayın derleme gerektirmediyse
    # önbellek denetimi güncel kuralla bir kez yapılır; sonra bu sürüm için yinelenmez
    if [ "$(cat "$STATE/cache-checked" 2>/dev/null || true)" != "$head" ]; then
      cache_housekeeping || log "⚠ derleme önbelleği denetimi tamamlanamadı"
      echo "$head" >"$STATE/cache-checked"
    fi
    # Yayındaki sürümün kaydı / uygulama-işçi uyumu (karar 287); hata yayını bozmaz
    release_idle || true
    info "Güncel: $(version_of "$head") ($(short "$head"))."
    return 0
  fi
  if [ "$head" = "$(cat "$STATE/failed" 2>/dev/null || true)" ]; then
    info "$(short "$head") daha önce yayınlanamadı; yeni bir güncelleme bekleniyor."
    return 0
  fi
  g=$(gate "$head" "$current")
  [ -f "$STATE/last_error" ] && grep -q 'GitHub' "$STATE/last_error" && [ "$g" != pending ] && clear_error
  case $g in
    success) ;;
    failure)
      echo "$head" >"$STATE/failed"
      log "✘ $(version_of "$head") ($(short "$head")) '$(branch)' dalındaki testlerden geçmedi; yayınlanmadı."
      return 0
      ;;
    *) info "$(short "$head") için '$(branch)' dalındaki testler (CI / sunucu kurulumu) bekleniyor; bitince yayınlanacak."; return 0 ;;
  esac
  do_deploy "$head" "$current" uc
}

# İlk kurulum: daldaki en yeni, testlerden geçmiş commit yayınlanır.
first_deploy() {
  exec 9>"$STATE/deploy.lock"
  flock 9
  release_recover || true
  local b sha g
  b=$(branch)
  git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$b:refs/remotes/origin/$b"
  # Sunucuda zaten yayında bir sürüm varsa ilk kurulum yolu da yalnızca dalın güncel ucunu yayınlar (karar 276)
  if [ -n "$(cat "$STATE/deployed" 2>/dev/null || true)" ]; then
    sha=$(git -C "$SRC" rev-parse "origin/$b")
    if [ "$sha" = "$(cat "$STATE/deployed")" ]; then
      log "✔ $(version_of "$sha") ($(short "$sha")) zaten yayında."
      return 0
    fi
    flock -u 9
    auto_deploy
    return $?
  fi
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
# İşçi root değil (SEC-12, karar 137). Yalnızca OKUR: işçinin kullanıcısı ve yükleme biriminde sahibi uygulamanın
# kullanıcısı (1001:1001) olmayan kayıt sayısı. Sahipliği düzelten, her "compose up"ta işçiden önce çalışan
# uploads-init servisidir (deploy/docker-compose.yml); buradan hiçbir şey değiştirilmez.
worker_status() {
  local id user mp n
  id=$(compose ps -q worker 2>/dev/null | head -n 1 || true)
  [ -n "$id" ] || return 0
  user=$(docker inspect -f '{{.Config.User}}' "$id" 2>/dev/null || true)
  case $user in
    1001:1001) say "İşçi     : kullanıcı 1001:1001 (root değil)" ;;
    *) say "İşçi     : ⚠ kullanıcı ${user:-root} (1001:1001 olmalı)" ;;
  esac
  mp=$(docker volume inspect -f '{{.Mountpoint}}' takip_uploads 2>/dev/null || true)
  [ -n "$mp" ] && [ -d "$mp" ] || return 0
  n=$(find "$mp" -xdev ! \( -uid 1001 -gid 1001 \) 2>/dev/null | wc -l)
  if [ "$n" = 0 ]; then say "Dosyalar : tüm kayıtların sahibi 1001:1001"; else say "Dosyalar : ⚠ $n kayıt 1001:1001 değil (bir sonraki yayında işçi başlamadan düzeltilir)"; fi
}

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
  worker_status || true
  say ""
  df -h / | awk 'NR==2 { print "Disk     : " $3 " / " $2 " dolu (" $5 ")" }'
  say "Yedekler : $(find "$BACKUPS" -name 'db-*.dump' | wc -l) veritabanı yedeği, son: $(ls -1t "$BACKUPS"/db-*.dump 2>/dev/null | head -1 | xargs -r basename)"
  if [ -n "$(enc_recipient)" ]; then say "           Google Drive kopyası şifreli (takip yedek-sifreleme)"; else say "           Google Drive kopyası ŞİFRESİZ → takip yedek-sifreleme kur"; fi
  say "           Saklama: yerel $(keep_days yerel) gün, Google Drive $(keep_days uzak) gün"
  local h; h=$(read_ptr "$REL_HEALTHY")
  say "Sağlıklı : $(if [ -n "$h" ]; then echo "$(rec_get "$h" version) ($(short "$h"))"; else echo 'kayıt yok'; fi) · geri dönüş kipi: $(rollback_mode) — ayrıntı: takip surum-durum"
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
  # E-postayı işçi gönderir: ikisi birlikte yeni ayarlarla başlar (P7)
  compose up -d app worker >/dev/null 2>&1
  say "✔ Kaydedildi, uygulama ve arka plan işçisi yeni ayarlarla başlatıldı."
  tty_read to "Deneme e-postası gidecek adres (boş bırakırsan atlanır): "
  if [ -n "$to" ]; then compose run --rm tools node scripts/test-mail.mjs "$to" tr; fi
}

cmd_admin() {
  local email=${1:-} name=${2:-} factory
  if [ $# -ge 2 ]; then shift 2; else shift $#; fi
  [ "$(id -u)" = 0 ] || { say "✘ Bu komut root olarak çalıştırılmalı (sudo takip yonetici …)."; return 1; }
  if [ -z "$email" ]; then say 'Kullanım: takip yonetici E-POSTA "Ad Soyad"   (şifresini unutan yönetici: sudo takip yonetici-kurtar E-POSTA)'; return 1; fi
  factory=$(env_get FACTORY_NAME); factory=${factory:-GKH Trading}
  compose run --rm tools node scripts/create-admin.mjs "$email" "$name" --factory "$factory" "$@"
}

# Yönetici acil erişim kurtarma (karar 246). Yalnızca root, yalnızca etkileşimli terminal (SSH). Şifre bu kabukta OKUNMAZ:
# araç konteynerindeki komut terminalden görünmeden sorar — komut satırına, ortam değişkenine, geçmişe ya da günlüğe düşmez.
# Operatör etiketi (SSH / sudo kullanıcı adı) denetim kaydına yazılır; gizli değildir.
cmd_admin_recover() {
  [ "$(id -u)" = 0 ] || { say "✘ Bu komut root olarak çalıştırılmalı (sudo takip yonetici-kurtar …)."; return 1; }
  if [ $# -ne 1 ] || [ -z "${1:-}" ] || [ "${1#-}" != "$1" ]; then
    say 'Kullanım: takip yonetici-kurtar E-POSTA   (şifre komut satırından verilmez; komut sorar)'
    return 1
  fi
  if [ ! -t 0 ] || [ ! -t 1 ]; then say "✘ Bu komut yalnızca etkileşimli terminalde (SSH oturumu) çalışır."; return 1; fi
  local op=${SUDO_USER:-$(logname 2>/dev/null || id -un)}
  op=$(printf '%s' "$op" | tr -cd 'A-Za-z0-9._@-' | cut -c1-64)
  compose run --rm -e TAKIP_OPERATOR="${op:-unknown}" tools node scripts/admin-recover.mjs "$1"
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
  exec 8>"$STATE/backup.lock"
  if ! flock -n 8; then say "✘ Başka bir yedek ya da geri yükleme sürüyor."; return 1; fi
  run_backup "$(enc_recipient)"
}

LAST_TS=''
# run_backup [ALICI] — ALICI doluysa Drive'a yalnızca şifreli kopya gider (kilit çağıranda alınmıştır)
run_backup() {
  sync_backup_timer
  local ts f g c ok_local=1 ok_remote=1 enc=${1:-} bad=''
  # Bu yedeğin sorun kodları (yedek alarmı — karar 249); sonunda $STATE/backup-last-run'a yazılır
  ts=$(TZ=$BACKUP_TZ date +%Y-%m-%d_%H%M%S)
  LAST_TS=$ts
  blog "▶ yedek $ts$([ -n "$enc" ] && echo ' (Google Drive kopyası şifreli)' || true)"

  f=$(backup_db gunluk "$BACKUPS/db-$ts.dump" || true)
  if [ -n "$f" ] && verify_dump "$f"; then
    blog "✔ veritabanı yedeği: $(basename "$f") ($(du -h "$f" | cut -f1)) — geçici veritabanına geri yüklenerek doğrulandı"
  else
    blog "✘ veritabanı yedeği BAŞARISIZ (alınamadı ya da geri yüklenemedi)"
    ok_local=0
    if [ -n "$f" ]; then mv -f "$f" "$f.bozuk"; bad="$bad DB_VERIFY"; else bad="$bad DB_DUMP"; fi
    f=
  fi

  g=$(backup_files "$BACKUPS/dosyalar-$ts.tgz" || true)
  if [ -n "$g" ] && verify_archive "$g"; then
    blog "✔ dosya yedeği: $(basename "$g") ($(du -h "$g" | cut -f1))"
  else
    blog "✘ dosya yedeği BAŞARISIZ"
    ok_local=0
    if [ -n "$g" ]; then mv -f "$g" "$g.bozuk"; bad="$bad FILES_VERIFY"; else bad="$bad FILES"; fi
    g=
  fi

  # Drive: yalnızca doğrulanmış yerel dosyalar gider
  if ! command -v rclone >/dev/null 2>&1; then
    blog "✘ Google Drive: rclone kurulu değil; yedek yalnızca yerelde"
    ok_remote=0; bad="$bad RCLONE_MISSING"
  elif [ -n "$enc" ] && ! enc_ready "$enc"; then
    # Şifreleme açık: Drive'a açık (şifresiz) dosya ASLA gönderilmez. Şifrelenemiyorsa yerel yedek durur, Drive adımı hata verir.
    blog "✘ Google Drive: yedek şifreleme açık ama age ya da anahtar ($BACKUP_KEY) kullanılamıyor — Drive'a hiçbir şey gönderilmedi (yerel yedek duruyor)"
    ok_remote=0; bad="$bad ENCRYPT"
  else
    # Yerel yedeği alınamayan parça Drive'a gidemez (kodu yukarıda yazıldı); Drive adımı yine eksik sayılır
    if [ -n "$f" ]; then c=$(drive_copy "$f" database veritabanı "$enc"); else c=''; ok_remote=0; fi
    if [ -n "$c" ]; then ok_remote=0; bad="$bad $c"; fi
    if [ -n "$g" ]; then c=$(drive_copy "$g" uploads dosya "$enc"); else c=''; ok_remote=0; fi
    if [ -n "$c" ]; then ok_remote=0; bad="$bad $c"; fi
    # Şifreli kopya yalnızca Drive içindir; yerelde açık kopya tutulur
    if [ -n "$enc" ]; then
      if [ -n "$f" ]; then rm -f "${f:?}.age" "${f:?}.age.tmp"; fi
      if [ -n "$g" ]; then rm -f "${g:?}.age" "${g:?}.age.tmp"; fi
    fi
  fi

  # Doğrulanan çift deftere yazılır (karar 279): yerelde ikisi de doğrulandıysa yerel deftere; Drive'a ikisi de yüklenip
  # md5 (şifreliyse ayrıca çözülerek) doğrulandıysa Drive defterine. Temizlik yalnızca deftere girmiş çiftleri siler.
  if [ $ok_local = 1 ]; then ledger_add "$LEDGER_LOCAL" "$ts" || true; fi
  if [ $ok_local = 1 ] && [ $ok_remote = 1 ]; then ledger_add "$LEDGER_DRIVE" "$ts" || true; fi
  # Eskiler yalnızca bu gece her şey tamamsa silinir (Drive'a gidemeyen günlerde yerel kopyalar korunur)
  if [ $ok_local = 1 ] && [ $ok_remote = 1 ]; then
    backup_retention yerel
    if [ -n "$enc" ]; then backup_retention uzak "$DAILY_AGE_RE"; else backup_retention uzak; fi
    echo "$ts" >"$STATE/backup-last-ok"
  fi
  # Pazar günleri antivirüs motorunun yeni sürümü alınır (virüs tanımları zaten sürekli güncellenir)
  if [ "$(date +%u)" = 7 ]; then compose build --pull clamav >/dev/null 2>&1 && compose up -d clamav >/dev/null 2>&1 || true; fi
  # Yedek alarmı (karar 249): bu yedeğin sonucu kaydedilir ve değerlendirilir (alarm / iyileşme e-postası). Alarm hatası
  # yedeğin sonucunu değiştirmez.
  echo "$bad" | xargs -r -n1 2>/dev/null | sort -u | xargs -r >"$STATE/backup-last-run" || true
  backup_evaluate || true
  if [ $ok_local = 1 ] && [ $ok_remote = 1 ]; then blog "✔ yedek $ts tamam (yerel + Google Drive)"; return 0; fi
  blog "✘ yedek $ts EKSİK (yerel: $([ $ok_local = 1 ] && echo tamam || echo HATA), Google Drive: $([ $ok_remote = 1 ] && echo tamam || echo HATA))"
  return 1
}

# ---------- yedek alarmı ve bekçi (karar 249) ----------
# Sorunlar: son yedeğin kodları ($STATE/backup-last-run) + son TAM başarılı yedek (yerel + Drive, $STATE/backup-last-ok)
# 26 saatten eski (STALE) + gece yedeği zamanlayıcısı çalışmıyor (BACKUP_TIMER) + bekçi zamanlayıcısı çalışmıyor ya da
# 3 saattir çalışmadı (CHECK_TIMER). Aynı sorun kümesi için e-posta en çok 24 saatte bir; küme değişince hemen; sorunlar
# bitince bir kez "düzeldi". Durum: $STATE/backup-alert ("KODLAR|ZAMAN|ANAHTARLAR" — aşağıda), geçmiş: $LOGS/backup-alert.log.
# E-postaya / günlüğe yalnızca kodlar yazılır — komut çıktısı, yol, token, anahtar, şifre YAZILMAZ (alıcıların tek yönlü
# anahtarları — adres değil — yalnızca durum dosyasına yazılır, karar 275).
BACKUP_STALE_SECONDS=$((26 * 3600))
BACKUP_CHECK_STALE_SECONDS=$((3 * 3600))
BACKUP_ALERT_REPEAT_SECONDS=$((24 * 3600))
alog() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOGS/backup-alert.log"; }
mtime() { stat -c %Y "$1" 2>/dev/null || echo ''; }
# TAKIP_ASSUME_SYSTEMD=1: yalnızca mantık testi (deploy/test/backup-alert.sh, sahte systemctl)
has_systemd() { command -v systemctl >/dev/null 2>&1 && { [ -d /run/systemd/system ] || [ "${TAKIP_ASSUME_SYSTEMD:-}" = 1 ]; }; }
# Son başarılı yedeğin yaşı (sn). Hiç yoksa bekçinin ilk gördüğü an esas alınır (kurulumdan hemen sonra alarm verilmez).
backup_age() {
  local now t; now=$(date +%s)
  t=$(mtime "$STATE/backup-last-ok")
  if [ -z "$t" ]; then
    [ -e "$STATE/backup-watch-since" ] || : >"$STATE/backup-watch-since"
    t=$(mtime "$STATE/backup-watch-since")
  fi
  echo $((now - ${t:-$now}))
}
backup_problems() {
  local codes='' age t now
  now=$(date +%s)
  if [ -s "$STATE/backup-last-run" ]; then codes=$(cat "$STATE/backup-last-run"); fi
  age=$(backup_age)
  [ "$age" -le "$BACKUP_STALE_SECONDS" ] || codes="$codes STALE"
  if has_systemd; then
    systemctl is-active --quiet takip-backup.timer || codes="$codes BACKUP_TIMER"
    if [ -f /etc/systemd/system/takip-backup-check.timer ]; then
      systemctl is-active --quiet takip-backup-check.timer || codes="$codes CHECK_TIMER"
    fi
  fi
  # Bekçinin kendisi: son çalışma 3 saatten eskiyse (yedek de bekçiyi denetler — karşılıklı)
  t=$(mtime "$STATE/backup-check-last")
  if [ -n "$t" ] && [ $((now - t)) -gt "$BACKUP_CHECK_STALE_SECONDS" ]; then codes="$codes CHECK_TIMER"; fi
  echo "$codes" | xargs -r -n1 2>/dev/null | sort -u | xargs -r || true
}
# backup_alert FAIL|RECOVERED SAAT ATLA [KOD …] → 0 hepsi aldı · 3 kısmen · diğer: gönderilemedi.
# ATLA: bu alarmı daha önce almış alıcıların anahtarları (virgülle; adres değil — karar 275). Alarmı alanların anahtarları
# ALERT_DELIVERED'a yazılır; "TESLIM" satırı günlüğe yazılmaz.
ALERT_DELIVERED=''
backup_alert() {
  local kind=$1 hours=$2 skip=$3 host out rc=0; shift 3
  host=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9.-' | cut -c1-64)
  out=$(compose run --rm --no-deps -T tools node scripts/backup-alert.mjs "$kind" --age "$hours" --host "${host:-sunucu}" ${skip:+--skip "$skip"} "$@" 2>>"$LOGS/backup-alert.log") || rc=$?
  ALERT_DELIVERED=$(printf '%s\n' "$out" | sed -n 's/^TESLIM //p' | tail -n 1 | tr -cd 'a-f0-9,')
  printf '%s\n' "$out" | grep -v '^TESLIM ' >>"$LOGS/backup-alert.log" || true
  return "$rc"
}
# Durum dosyası backup-alert: "KODLAR|ZAMAN|ANAHTARLAR". ZAMAN = alarmın HERKESE ulaştığı an (24 saatlik yineleme bundan sayılır);
# 0 = kısmen gönderildi (ANAHTARLAR: alanlar) → sonraki denetim yalnızca almayanlara gönderir. Eski biçim "KODLAR|ZAMAN" = tamamlanmış.
# backup-alert-recovered: "düzeldi" e-postasını almış alıcıların anahtarları (kısmi gönderimde).
backup_evaluate() {
  local codes prev='' sent=0 keys='' skip='' now hours line rc
  codes=$(backup_problems)
  now=$(date +%s)
  hours=$(( $(backup_age) / 3600 ))
  if [ -s "$STATE/backup-alert" ]; then
    line=$(head -1 "$STATE/backup-alert"); prev=${line%%|*}; line=${line#*|}; sent=${line%%|*}
    [ "$line" != "$sent" ] && keys=${line#*|}
  fi
  [[ $sent =~ ^[0-9]+$ ]] || sent=0
  keys=$(printf '%s' "$keys" | tr -cd 'a-f0-9,')
  if [ -n "$codes" ]; then
    rm -f "$STATE/backup-alert-recovered"
    if [ "$codes" = "$prev" ]; then
      if [ "$sent" -gt 0 ] && [ $((now - sent)) -lt "$BACKUP_ALERT_REPEAT_SECONDS" ]; then
        return 0 # aynı alarm 24 saat içinde herkese gönderildi
      fi
      [ "$sent" = 0 ] && skip=$keys # kısmi gönderim sürüyor: alanlara yeniden gönderilmez
    fi
    rc=0
    # shellcheck disable=SC2086 # kodlar tek kelimeliktir; bilerek ayrı argüman
    backup_alert FAIL "$hours" "$skip" $codes || rc=$?
    if [ "$rc" = 0 ]; then
      echo "$codes|$now|" >"$STATE/backup-alert"
      alog "ALARM gönderildi: $codes"
      blog "✘ yedek alarmı e-postası gönderildi: $codes"
    elif [ "$rc" = 3 ] && [ -n "$ALERT_DELIVERED" ]; then
      echo "$codes|0|$ALERT_DELIVERED" >"$STATE/backup-alert"
      alog "ALARM KISMEN gönderildi: $codes — gönderilemeyen alıcılara bir sonraki denetimde yeniden denenecek"
      blog "✘ yedek alarmı e-postası kısmen gönderildi: $codes"
    else
      alog "ALARM GÖNDERİLEMEDİ (e-posta): $codes — bir sonraki denetimde yeniden denenecek"
      blog "✘ yedek alarmı e-postası gönderilemedi: $codes"
    fi
  elif [ -n "$prev" ]; then
    if [ -s "$STATE/backup-alert-recovered" ]; then skip=$(head -1 "$STATE/backup-alert-recovered" | tr -cd 'a-f0-9,'); fi
    rc=0
    backup_alert RECOVERED "$hours" "$skip" || rc=$?
    if [ "$rc" = 0 ]; then
      rm -f "$STATE/backup-alert" "$STATE/backup-alert-recovered"
      alog "DÜZELDİ (önceki: $prev)"
      blog "✔ yedek alarmı kapandı (düzeldi; önceki sorun: $prev)"
    elif [ "$rc" = 3 ] && [ -n "$ALERT_DELIVERED" ]; then
      echo "$ALERT_DELIVERED" >"$STATE/backup-alert-recovered"
      alog "DÜZELDİ ama e-posta kısmen gönderildi (önceki: $prev) — gönderilemeyen alıcılara yeniden denenecek"
    else
      alog "DÜZELDİ ama e-posta gönderilemedi (önceki: $prev) — yeniden denenecek"
    fi
  fi
  return 0
}
# Bekçi: takip-backup-check.timer saatte bir çalıştırır (takip yedek-kontrol). Yedekle aynı kilidi BEKLEMEZ (yedek saatlerce
# sürebilir); yalnızca durum dosyalarını okur ve gerekirse e-posta gönderir.
cmd_backup_check() {
  case ${1:-} in
    durum | status)
      local codes; codes=$(backup_problems)
      say "Son başarılı yedek (yerel + Drive): $([ -f "$STATE/backup-last-ok" ] && echo "$(( $(backup_age) / 3600 )) saat önce ($(cat "$STATE/backup-last-ok"))" || echo 'kayıt yok')"
      say "Son yedeğin sorunları : $([ -s "$STATE/backup-last-run" ] && cat "$STATE/backup-last-run" || echo yok)"
      say "Şu anki sorunlar      : ${codes:-yok}"
      say "Açık alarm            : $([ -s "$STATE/backup-alert" ] && cut -d'|' -f1 "$STATE/backup-alert" || echo yok)"
      say "Bekçi son çalışma     : $([ -f "$STATE/backup-check-last" ] && date -d "@$(mtime "$STATE/backup-check-last")" '+%F %T' || echo 'hiç')"
      return 0 ;;
    '') ;;
    *) say 'Kullanım: takip yedek-kontrol [durum]'; return 1 ;;
  esac
  [ "$(id -u)" = 0 ] || { say "✘ Bu komut root olarak çalıştırılmalı."; return 1; }
  sync_backup_timer
  : >"$STATE/backup-check-last"
  backup_evaluate
}

# ---------- geri yükleme ----------
# O günün en son TAM yedek çifti (veritabanı + dosyalar): önce yerel, yoksa Google Drive.
PAIR_TS='' PAIR_SRC='' PAIR_ENC=0
# PAIR_PREFER=sifreli → yerel kopya olsa da Drive'daki ŞİFRELİ çift seçilir (restore-test: asıl sınanması gereken odur)
PAIR_PREFER=''
pair_time() { echo "$PAIR_TS" | sed -E 's/_([0-9]{2})([0-9]{2})([0-9]{2})$/ \1:\2:\3/'; }
# Drive'da o günün en yeni tam çifti: remote_pair GÜN UZANTI_EKİ ('' ya da '\.age')
remote_pair() {
  local dbs ups
  dbs=$(rclone lsf --files-only "$(remote_root)/database" 2>/dev/null | sed -nE "s/^db-(${1}_[0-9]{6})\.dump${2}$/\1/p" || true)
  ups=$(rclone lsf --files-only "$(remote_root)/uploads" 2>/dev/null | sed -nE "s/^dosyalar-(${1}_[0-9]{6})\.tgz${2}$/\1/p" || true)
  comm -12 <(echo "$dbs" | sort -u) <(echo "$ups" | sort -u) | grep . | sort -r | head -1 || true
}
find_pair() { # find_pair YYYY-MM-DD
  local day=$1 ts plain enc
  PAIR_ENC=0
  if [ "$PAIR_PREFER" = sifreli ] && command -v rclone >/dev/null 2>&1; then
    enc=$(remote_pair "$day" '\.age')
    if [ -n "$enc" ]; then PAIR_TS=$enc PAIR_SRC="GOOGLE DRIVE (şifreli)" PAIR_ENC=1; return 0; fi
  fi
  for ts in $(local_names | grep -E "^db-${day}_[0-9]{6}\.dump$" | sed -nE "s/$DAILY_RE/\2/p" | sort -r); do
    if [ -s "$BACKUPS/dosyalar-$ts.tgz" ]; then PAIR_TS=$ts PAIR_SRC=LOCAL; return 0; fi
  done
  command -v rclone >/dev/null 2>&1 || return 1
  # Drive: o günün en yeni tam çifti — şifresiz (eski düzen) ya da şifreli; aynı saatliyse şifresiz olan
  plain=$(remote_pair "$day" '')
  enc=$(remote_pair "$day" '\.age')
  [ -n "$plain" ] || [ -n "$enc" ] || return 1
  if [ -n "$enc" ] && [[ "$enc" > "$plain" ]]; then PAIR_TS=$enc PAIR_SRC="GOOGLE DRIVE (şifreli)" PAIR_ENC=1
  else PAIR_TS=$plain PAIR_SRC="GOOGLE DRIVE"; fi
}
resolve_day() { # resolve_day yesterday|YYYY-MM-DD → YYYY-MM-DD
  case ${1:-} in
    yesterday | dun | dün) TZ=$BACKUP_TZ date -d yesterday +%F ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) echo "$1" ;;
    *) return 1 ;;
  esac
}
# Çifti bulur, gerekiyorsa Drive'dan indirir, ikisini de doğrular. Hata → 1 (canlı veriye hiç dokunulmaz)
fetch_pair() { # fetch_pair YYYY-MM-DD
  local dir
  find_pair "$1" || { say "✘ $1 için tam yedek çifti (veritabanı + dosyalar) bulunamadı (yerel ya da Google Drive)."; return 1; }
  PAIR_DB="$BACKUPS/db-$PAIR_TS.dump"; PAIR_UP="$BACKUPS/dosyalar-$PAIR_TS.tgz"
  say "Yedek tarihi/saati : $(pair_time) (Europe/Bucharest)"
  say "Veritabanı yedeği  : $(basename "$PAIR_DB")"
  say "Dosya yedeği       : $(basename "$PAIR_UP")"
  say "Kaynak             : $PAIR_SRC"
  if [ "$PAIR_ENC" = 1 ]; then
    # Şifreli çift: yalnızca root'un okuyabildiği geçici klasöre iner; çıkışta silinir (cleanup). Çözülen dosyalar
    # denemede (PAIR_PREFER=sifreli) o geçici klasörde kalır; gerçek geri yüklemede yerel yedek klasörüne yazılır.
    enc_tools || { say "✘ Bu yedek şifreli; çözmek için 'age' kurulu olmalı: apt-get install -y age"; return 1; }
    [ -s "$BACKUP_KEY" ] || { say "✘ Bu yedek şifreli; anahtar dosyası yok: $BACKUP_KEY (sunucu dışında sakladığınız anahtarı bu dosyaya koyun, chmod 600)."; return 1; }
    WORK_DIR=$(mktemp -d "$BACKUPS/.gecici.XXXXXX")
    dir=$BACKUPS
    if [ "$PAIR_PREFER" = sifreli ]; then dir=$WORK_DIR; fi
    PAIR_DB="$dir/db-$PAIR_TS.dump"; PAIR_UP="$dir/dosyalar-$PAIR_TS.tgz"
    say "Google Drive'dan indiriliyor ve şifresi çözülüyor…"
    if ! (umask 077 && rclone copyto "$(remote_root)/database/db-$PAIR_TS.dump.age" "$WORK_DIR/db.age" >>"$LOGS/backup.log" 2>&1 &&
      rclone copyto "$(remote_root)/uploads/dosyalar-$PAIR_TS.tgz.age" "$WORK_DIR/dosyalar.age" >>"$LOGS/backup.log" 2>&1); then
      say "✘ Google Drive'dan indirilemedi."; return 1
    fi
    if ! { decrypt_one "$WORK_DIR/db.age" "$PAIR_DB" && decrypt_one "$WORK_DIR/dosyalar.age" "$PAIR_UP"; }; then
      say "✘ Yedeğin şifresi çözülemedi (anahtar bu yedeğe ait değil ya da dosya bozuk). Ayrıntı: $LOGS/backup.log"; return 1
    fi
    rm -f "${WORK_DIR:?}/db.age" "${WORK_DIR:?}/dosyalar.age"
    say "✔ Şifre çözüldü"
  elif [ "$PAIR_SRC" != LOCAL ]; then
    say "Google Drive'dan indiriliyor…"
    # İndirilen yedek yerel yedek klasörüne yazılır: o da 0600
    if ! (umask 077 && rclone copyto "$(remote_root)/database/$(basename "$PAIR_DB")" "$PAIR_DB" >>"$LOGS/backup.log" 2>&1 &&
      rclone copyto "$(remote_root)/uploads/$(basename "$PAIR_UP")" "$PAIR_UP" >>"$LOGS/backup.log" 2>&1); then
      say "✘ Google Drive'dan indirilemedi."; return 1
    fi
  fi
  [ -s "$PAIR_DB" ] && [ -s "$PAIR_UP" ] || { say "✘ Yedek dosyalarından biri eksik."; return 1; }
  verify_archive "$PAIR_UP" || { say "✘ Dosya arşivi bozuk."; return 1; }
}

cmd_restore() {
  local day tag safe_db safe_up answer stamp
  day=$(resolve_day "${1:-}") || { say "Kullanım: takip restore YYYY-MM-DD | takip restore yesterday   (canlıya dokunmadan deneme: takip restore-test TARİH)"; return 1; }
  exec 8>"$STATE/backup.lock"
  if ! flock -n 8; then say "✘ Bir yedek ya da geri yükleme sürüyor; sonra tekrar deneyin."; return 1; fi

  # A–D: çift bulunur, indirilir, doğrulanır; veritabanı yedeği ayrı bir veritabanına (takip_restore) yüklenir
  fetch_pair "$day" || { say "Hiçbir şey değişmedi."; return 1; }
  say "Doğrulanıyor (veritabanı yedeği ayrı bir veritabanına yükleniyor)…"
  restore_into takip_restore "$PAIR_DB" || { say "✘ Veritabanı yedeği geri yüklenemiyor; hiçbir şey değişmedi."; return 1; }
  tag=$(env_get APP_TAG)
  if ! docker image inspect "takip:$tag" >/dev/null 2>&1; then
    db_sql 'DROP DATABASE IF EXISTS "takip_restore"' >/dev/null
    say "✘ Uygulama imajı bulunamadı; hiçbir şey değişmedi."; return 1
  fi

  # F: açık onay
  say ""
  say "⚠ DİKKAT: canlı veritabanı ve yüklenen dosyalar bu yedekle DEĞİŞTİRİLECEK. Yedekten sonraki tüm kayıtlar kaybolur."
  say "  Önce şu anki durumun güvenlik yedeği alınır."
  tty_read answer "Onaylamak için yedeğin tarihini yazın ($day): "
  if [ "$answer" != "$day" ]; then
    db_sql 'DROP DATABASE IF EXISTS "takip_restore"' >/dev/null
    say "Vazgeçildi; hiçbir şey değişmedi."; return 1
  fi

  # Bu sırada otomatik güncelleme çalışmasın
  exec 9>"$STATE/deploy.lock"
  flock 9

  # E: şu anki durumun güvenlik yedeği (veritabanı + dosyalar)
  stamp=$(date +%Y%m%d-%H%M%S)
  safe_db=$(backup_db geri-yukleme-oncesi "$BACKUPS/db-$stamp-geri-yukleme-oncesi.dump" || true)
  safe_up=$(backup_files "$BACKUPS/dosyalar-$stamp-geri-yukleme-oncesi.tgz" || true)
  if [ -z "$safe_db" ] || [ -z "$safe_up" ] || ! verify_archive "$safe_up"; then
    db_sql 'DROP DATABASE IF EXISTS "takip_restore"' >/dev/null
    say "✘ Güvenlik yedeği alınamadı; hiçbir şey değişmedi."; return 1
  fi
  blog "▶ geri yükleme $PAIR_TS ($PAIR_SRC) — güvenlik yedeği: $(basename "$safe_db"), $(basename "$safe_up")"

  # Yalnızca veritabanını ve dosyaları kullanan servisler durur (db, caddy, clamav çalışmaya devam eder)
  compose stop app worker >/dev/null 2>&1 || true

  # G: doğrulanmış takip_restore canlı veritabanının yerine geçer; eskisi takip_onceki olarak kalır
  if ! { db_sql 'DROP DATABASE IF EXISTS "takip_onceki"' >/dev/null &&
    db_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'takip' AND pid <> pg_backend_pid()" >/dev/null &&
    db_sql 'ALTER DATABASE "takip" RENAME TO "takip_onceki"' >/dev/null &&
    db_sql 'ALTER DATABASE "takip_restore" RENAME TO "takip"' >/dev/null; }; then
    if ! db_sql "SELECT datname FROM pg_database WHERE datname = 'takip'" | grep -q takip; then
      db_sql 'ALTER DATABASE "takip_onceki" RENAME TO "takip"' >/dev/null || true
    fi
    compose up -d app worker >/dev/null 2>&1 || true
    blog "✘ geri yükleme: veritabanı değiştirilemedi; eski durum korundu"
    say "✘ Veritabanı değiştirilemedi; eski durum korundu."; return 1
  fi

  # H, I: dosyalar (sahiplik: uygulamanın kullanıcısı 1001)
  if ! docker run --rm --user 0 -v takip_uploads:/u -v "$BACKUPS":/b "takip:$tag" sh -c \
    "find /u -mindepth 1 -delete && tar -xzpf '/b/$(basename "$PAIR_UP")' -C /u && chown -R 1001:1001 /u" >>"$LOGS/backup.log" 2>&1; then
    blog "✘ geri yükleme: dosyalar açılamadı; her şey eski hâline döndürülüyor"
    docker run --rm --user 0 -v takip_uploads:/u -v "$BACKUPS":/b "takip:$tag" sh -c \
      "find /u -mindepth 1 -delete && tar -xzpf '/b/$(basename "$safe_up")' -C /u && chown -R 1001:1001 /u" >>"$LOGS/backup.log" 2>&1 || true
    db_sql 'ALTER DATABASE "takip" RENAME TO "takip_hatali"' >/dev/null &&
      db_sql 'ALTER DATABASE "takip_onceki" RENAME TO "takip"' >/dev/null &&
      db_sql 'DROP DATABASE IF EXISTS "takip_hatali"' >/dev/null || true
    compose up -d app worker >/dev/null 2>&1 || true
    say "✘ Dosyalar geri yüklenemedi; eski duruma dönüldü. Ayrıntı: $LOGS/backup.log"; return 1
  fi

  # Yedek eski bir sürümdense şema bu sürüme taşınır (migration); sonra yalnızca durdurulan servisler başlar
  compose run --rm tools >>"$LOGS/backup.log" 2>&1 || blog "⚠ geri yükleme: migration uyarısı (ayrıntı: $LOGS/backup.log)"
  compose up -d app worker >/dev/null 2>&1
  # K: sağlık kontrolü
  if wait_healthy 240; then
    blog "✔ geri yükleme $PAIR_TS tamam — sipariş: $(db_sql 'SELECT count(*) FROM "Order"' takip), kullanıcı: $(db_sql 'SELECT count(*) FROM "User"' takip)"
    say "✔ Geri yüklendi: $(pair_time). Uygulama açık: $(env_get APP_URL)"
    say "  Önceki veritabanı 'takip_onceki' olarak, güvenlik yedekleri $BACKUPS içinde duruyor."
  else
    blog "✘ geri yükleme sonrası uygulama açılmadı (takip log). Güvenlik yedeği: $(basename "$safe_db")"
    say "✘ Uygulama açılmadı: takip log. Önceki veritabanı 'takip_onceki', güvenlik yedekleri $BACKUPS içinde."
    return 1
  fi
}

# Canlı veriye dokunmadan: çifti bulur (gerekirse Drive'dan indirir) ve geçici veritabanına yükleyerek dener
# Şifreleme açıksa Google Drive'daki ŞİFRELİ kopya sınanır: geçici klasöre indirilir, anahtarla çözülür, sınanır, silinir.
cmd_restore_test() {
  local day
  day=$(resolve_day "${1:-yesterday}") || { say "Kullanım: takip restore-test YYYY-MM-DD | yesterday"; return 1; }
  if [ -n "$(enc_recipient)" ]; then PAIR_PREFER=sifreli; fi
  restore_test_day "$day"
}
restore_test_day() { # restore_test_day YYYY-MM-DD
  local day=$1
  fetch_pair "$day" || return 1
  say "✔ Dosya arşivi okunuyor ($(tar -tzf "$PAIR_UP" | grep -vc '/$' || true) dosya)"
  if restore_into takip_yedek_dene "$PAIR_DB"; then
    say "✔ Veritabanı geçici veritabanına yüklendi — sipariş: $(db_sql 'SELECT count(*) FROM "Order"' takip_yedek_dene), kullanıcı: $(db_sql 'SELECT count(*) FROM "User"' takip_yedek_dene)"
    db_sql 'DROP DATABASE IF EXISTS "takip_yedek_dene"' >/dev/null
  else
    say "✘ Veritabanı yedeği geri yüklenemedi."; return 1
  fi
}

# ---------- yedek şifreleme: durum / kurulum / anahtar yenileme ----------
# Şifreleme ancak sunucu sahibi bu komutu çalıştırıp anahtarı SUNUCU DIŞINA kaydettiğini onaylayınca ve şifreli bir
# yedek baştan sona denenince açılır (yedek → şifrele → çözerek doğrula → Drive'a yükle → md5 → Drive'dan indir → çöz →
# arşivi oku → geçici veritabanına geri yükle). Deneme başarısızsa hiçbir şey değişmez: yedekler eskisi gibi çalışır.
drive_count() { # drive_count DESEN → Drive'daki günlük yedek dosyası sayısı
  { rclone lsf --files-only "$(remote_root)/database" 2>/dev/null || true; rclone lsf --files-only "$(remote_root)/uploads" 2>/dev/null || true; } | grep -cE "$1" || true
}
enc_status() {
  local r; r=$(enc_recipient)
  if [ -n "$r" ]; then
    say "Yedek şifreleme  : AÇIK — Google Drive'a yalnızca şifreli kopya gider"
    say "Etkin açık anahtar: $r"
  else
    say "Yedek şifreleme  : KAPALI — Google Drive'a şifresiz kopya gidiyor (açmak için: takip yedek-sifreleme kur)"
  fi
  if enc_tools; then say "age              : $(age --version 2>/dev/null | head -1)"; else say "age              : kurulu değil → apt-get update && apt-get install -y age"; fi
  if [ -s "$BACKUP_KEY" ]; then
    say "Anahtar dosyası  : $BACKUP_KEY (izin $(stat -c '%a' "$BACKUP_KEY"), $(key_recipients | grep -c . || true) anahtar)"
  else
    say "Anahtar dosyası  : yok ($BACKUP_KEY)"
  fi
  if [ -n "$r" ] && ! enc_ready "$r"; then
    say "✘ DİKKAT: etkin anahtarın gizli kısmı anahtar dosyasında yok ya da age kurulu değil — gece yedeği Drive'a GİDEMEZ (yerel yedek alınır)."
  fi
  if command -v rclone >/dev/null 2>&1; then
    say "Google Drive     : $(drive_count "$DAILY_AGE_RE") şifreli, $(drive_count "$DAILY_RE") ŞİFRESİZ günlük yedek dosyası ($(remote_root))"
    say "                   Şifresiz eski yedekler kendiliğinden silinmez; ne yapılacağına siz karar verirsiniz."
  fi
  say "Yerel yedekler   : $BACKUPS (yalnızca root okur; şifresiz — sunucudaki canlı veriyle aynı korumada)"
  say "Saklama          : yerel $(keep_days yerel) gün, Google Drive $(keep_days uzak) gün (yalnızca tam ve doğrulanmış çiftler silinir)"
}

enc_setup() { # enc_setup kur | yenile
  local mode=$1 pub secret answer tmp
  [ "$(id -u)" = 0 ] || { say "✘ Bu komut root olarak çalıştırılmalı."; return 1; }
  enc_tools || { say "✘ 'age' kurulu değil. Önce: apt-get update && apt-get install -y age"; return 1; }
  command -v rclone >/dev/null 2>&1 || { say "✘ rclone kurulu değil; Google Drive yedeği çalışmadan şifreleme açılamaz."; return 1; }
  if [ "$mode" = yenile ] && { [ -z "$(enc_recipient)" ] || [ ! -s "$BACKUP_KEY" ]; }; then
    say "✘ Şifreleme açık değil; önce: takip yedek-sifreleme kur"; return 1
  fi
  if [ "${TAKIP_ASSUME_KEY_SAVED:-0}" != 1 ] && ! { : >/dev/tty; } 2>/dev/null; then
    say "✘ Bu komut etkileşimli (terminalde) çalıştırılmalı: anahtarı sunucu dışına kaydettiğinizi onaylamanız gerekir."; return 1
  fi
  exec 8>"$STATE/backup.lock"
  if ! flock -n 8; then say "✘ Bir yedek ya da geri yükleme sürüyor; sonra tekrar deneyin."; return 1; fi

  # Anahtar: yoksa üretilir; "yenile"de yeni anahtar dosyanın BAŞINA eklenir, eskiler kalır (eski yedekler açılabilsin)
  if [ "$mode" = yenile ] || [ ! -s "$BACKUP_KEY" ]; then
    tmp=$(mktemp -u "$BASE/.backup-key.XXXXXX")
    (umask 077 && age-keygen -o "$tmp" >/dev/null 2>&1) || { say "✘ Anahtar üretilemedi."; rm -f "${tmp:?}"; return 1; }
    if [ -s "$BACKUP_KEY" ]; then
      if ! (umask 077 && cat "$tmp" "$BACKUP_KEY" >"$tmp.yeni") || ! mv -f "$tmp.yeni" "$BACKUP_KEY"; then
        rm -f "${tmp:?}" "${tmp:?}.yeni"
        say "✘ Anahtar dosyası güncellenemedi; hiçbir şey değişmedi."; return 1
      fi
      rm -f "${tmp:?}"
    else
      mv -f "$tmp" "$BACKUP_KEY"
    fi
  fi
  chmod 600 "$BACKUP_KEY"
  pub=$(key_recipients | head -1)
  secret=$(grep -m1 '^AGE-SECRET-KEY-' "$BACKUP_KEY" || true)
  if [ -z "$pub" ] || [ -z "$secret" ]; then say "✘ Anahtar dosyası okunamadı: $BACKUP_KEY"; return 1; fi

  # Anahtar yalnızca ekrana (terminale) yazılır; günlüğe, yedeğe, Drive'a gitmez
  if [ "${TAKIP_ASSUME_KEY_SAVED:-0}" != 1 ]; then
    {
      echo
      echo "════ YEDEK ŞİFRELEME ANAHTARI — şimdi SUNUCU DIŞINA kaydedin ════"
      echo "Bu anahtar olmadan Google Drive'daki şifreli yedekler AÇILAMAZ. Sunucu tamamen kaybolursa tek kurtarma yolu budur."
      echo "  • Şifre yöneticinize kaydedin VE kâğıda yazdırıp güvenli bir yerde saklayın (iki ayrı yer)."
      echo "  • Google Drive'a (yedeklerin yanına), e-postaya, sohbete ya da git'e KOYMAYIN."
      echo
      echo "  Açık anahtar : $pub"
      echo "  Gizli anahtar: $secret"
      echo
    } >/dev/tty
    tty_read answer "Kaydettiğinizi doğrulamak için gizli anahtarın SON 6 karakterini yazın: "
    if [ "${answer^^}" != "${secret: -6}" ]; then
      say "✘ Eşleşmedi; şifreleme açılmadı (değişmedi). Yedekler eskisi gibi çalışmaya devam ediyor. Anahtar dosyası: $BACKUP_KEY"
      return 1
    fi
  fi

  say "Deneme: yedek alınıyor, şifreleniyor, Google Drive'a yükleniyor; sonra Drive'dan indirilip çözülerek geri yükleme deneniyor…"
  if ! run_backup "$pub"; then
    say "✘ Şifreli yedek tamamlanamadı; şifreleme durumu DEĞİŞMEDİ (ayrıntı: $LOGS/backup.log). Yedekler eskisi gibi çalışmaya devam ediyor."
    return 1
  fi
  PAIR_PREFER=sifreli
  if ! restore_test_day "${LAST_TS%%_*}" || [ "$PAIR_ENC" != 1 ] || [ "$PAIR_TS" != "$LAST_TS" ]; then
    say "✘ Şifreli yedek Google Drive'dan geri yüklenemedi; şifreleme durumu DEĞİŞMEDİ (ayrıntı: $LOGS/backup.log)."
    return 1
  fi
  echo "$pub" >"$ENC_STATE"
  blog "✔ yedek şifreleme AÇIK (açık anahtar: $pub) — şifreli yedek Drive'dan indirilip çözülerek geri yüklendi"
  say ""
  say "✔ Yedek şifreleme AÇIK. Bundan sonra Google Drive'a yalnızca şifreli kopya gider."
  say "  Anahtar (sunucuda)      : $BACKUP_KEY — sunucu dışındaki kopyasını KAYBETMEYİN."
  say "  Şifresiz eski Drive yedeği: $(drive_count "$DAILY_RE") dosya — silinmedi; ne yapılacağına siz karar verirsiniz."
}

enc_disable() {
  local answer
  [ -n "$(enc_recipient)" ] || { say "Yedek şifreleme zaten kapalı."; return 0; }
  tty_read answer "Google Drive'a yeniden ŞİFRESİZ yedek gidecek. Onaylamak için KAPAT yazın: "
  if [ "$answer" != KAPAT ]; then say "Vazgeçildi."; return 1; fi
  rm -f "${ENC_STATE:?}"
  blog "⚠ yedek şifreleme KAPATILDI (anahtar dosyası duruyor: eski şifreli yedekler için gerekli)"
}

cmd_backup_encryption() {
  case ${1:-durum} in
    durum | status) enc_status ;;
    kur | setup) enc_setup kur ;;
    yenile | rotate) enc_setup yenile ;;
    kapat | disable) enc_disable ;;
    *) say "Kullanım: takip yedek-sifreleme [durum | kur | yenile | kapat]"; return 1 ;;
  esac
}

main() {
  local cmd=${1:-durum}
  shift || true
  case $cmd in
    durum | status) cmd_status ;;
    guncelle | update) VERBOSE=1 auto_deploy ;;
    _otomatik) auto_deploy ;;
    _ilk) first_deploy ;;
    # Salt okunur tanı: takip _ci SHA [DAL] [TABAN] — yayın kapısının sonucu (success | failure | pending); hiçbir şey yayınlanmaz
    _ci) GATE_BRANCH=${2:-} gate "$(git -C "$SRC" rev-parse "$1")" "${3:+$(git -C "$SRC" rev-parse "$3")}" ;;
    github) cmd_github ;;
    antivirus | av) compose run --rm tools node scripts/av-check.mjs ;;
    kur | fx) compose run --rm tools node scripts/fx-check.mjs "$@" ;;
    smtp) cmd_smtp ;;
    yonetici | admin) cmd_admin "$@" ;;
    yonetici-kurtar | admin-recover) cmd_admin_recover "$@" ;;
    yedek | backup) cmd_backup ;;
    yedek-kontrol | backup-check) cmd_backup_check "$@" ;;
    restore | geri-yukle) cmd_restore "$@" ;;
    restore-test | yedek-dene) cmd_restore_test "$@" ;;
    yedek-sifreleme | backup-encryption) cmd_backup_encryption "$@" ;;
    cache | onbellek) cmd_cache "$@" ;;
    surum-durum | release-status) cmd_release_status ;;
    surum-dogrula | release-verify) cmd_release_verify ;;
    rollback-durum | geri-donus-durum) cmd_rollback_status ;;
    rollback-kontrol | geri-donus-kontrol) cmd_rollback_check ;;
    rollback | geri-don) cmd_rollback "$@" ;;
    rollback-modu | geri-donus-kipi) cmd_rollback_mode "$@" ;;
    log | logs) compose logs --no-log-prefix --tail="${1:-200}" app ;;
    dal)
      # İzlenen dalı değiştirmek yalnızca root'a açıktır (karar 289): dal koruması yalnızca backend'dedir
      if [ -n "${1:-}" ]; then
        require_root dal || return 1
        [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ && $1 != *..* ]] || { say "✘ Geçersiz dal adı."; return 1; }
        echo "$1" >"$STATE/branch"; rm -f "$STATE/failed"; say "Otomatik güncelleme artık '$1' dalını izliyor."
      else branch; fi
      ;;
    *)
      sed -n '2,25p' "$TAKIP_REEXEC" | sed 's/^# \{0,1\}//'
      return 1
      ;;
  esac
}

main "$@"
