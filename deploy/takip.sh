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
#
# Otomatik güncelleme (systemd: takip-deploy.timer, 2 dakikada bir → takip _otomatik):
#   izlenen dalın GÜNCEL ucu, YALNIZCA o dalın kendi GitHub koşularında CI'dan (ve deploy/ vb. değiştiyse sunucu
#   kurulum testinden) geçtiyse sunucuda derlenir (başka dalın sonucu sayılmaz; derleme sonrası uç ve kapı yeniden denetlenir),
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
VERBOSE=${VERBOSE:-0}

mkdir -p "$STATE" "$LOGS"
# Yedek klasörü yalnızca root'a açıktır (0700; kurulum da böyle açar). Yoksa bu izinle oluşturulur; var olan klasörün izni değiştirilmez.
[ -d "$BACKUPS" ] || (umask 077 && mkdir -p "$BACKUPS")

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

# CI'nin kendisinin yazdığı commit'ler (kilit dosyası, migration) CI başlatmaz; onların içeriğini bir önceki commit'in
# — AYNI DALDAKİ — CI koşusu üretip test ettiği için o koşunun sonucu geçerlidir.
ci_gate() { # ci_gate SHA DAL
  local sha=$1 b=$2 s info email subject parents
  for _ in 1 2 3 4 5; do
    s=$(ci_state "$sha" "$b")
    case $s in success | pending | failure) echo "$s"; return ;; esac
    info=$(git -C "$SRC" log -1 --format='%ae%x09%s%x09%P' "$sha" 2>/dev/null) || { echo pending; return; }
    email=${info%%$'\t'*}; info=${info#*$'\t'}; subject=${info%%$'\t'*}; parents=${info#*$'\t'}
    if [[ $email == *github-actions* && $subject == CI:* && -n $parents ]]; then
      sha=${parents%% *}
      continue
    fi
    echo pending
    return
  done
  echo pending
}

# Sunucu kurulum testi (deploy-test.yml) yalnızca INSTALL_TEST_PATHS değişince çalışır. Yayın onu şu durumda bekler:
#  · yayındaki commit (TABAN) bilinir ve TABAN..SHA aralığında bu yollar değiştiyse: değişikliği içeren EN YENİ commit
#    (L) ile SHA arasındaki commit'lerden, izlenen dalda kurulum testi koşusu olan EN YENİSİ başarılı olmalı (koşu yoksa
#    henüz oluşmamıştır → bekle); bu yollar değişmediyse kurulum testi gerekmez;
#  · TABAN bilinmiyorsa (ilk kurulum): SHA ve önceki 20 commit'ten kurulum testi koşusu olan en yenisi başarılı olmalı.
install_gate() { # install_gate SHA DAL [TABAN]
  local sha=$1 b=$2 base=${3:-} last c s list
  if [ -n "$base" ] && git -C "$SRC" merge-base --is-ancestor "$base" "$sha" 2>/dev/null; then
    [ "$base" = "$sha" ] && { echo success; return; }
    if git -C "$SRC" diff --quiet "$base" "$sha" -- "${INSTALL_TEST_PATHS[@]}" 2>/dev/null; then echo success; return; fi
    last=$(git -C "$SRC" log -1 --first-parent --format=%H "$base..$sha" -- "${INSTALL_TEST_PATHS[@]}" 2>/dev/null) || { echo pending; return; }
    list=$(git -C "$SRC" rev-list --first-parent "$base..$sha" 2>/dev/null) || { echo pending; return; }
    # Aralıkta yol değişikliği ancak birleştirme dışı bir yoldan geldiyse (L bulunamadı): en temkinli seçim — SHA'nın kendisi
    [ -n "$last" ] || last=$sha
  else
    list=$(git -C "$SRC" rev-list --first-parent -n 21 "$sha" 2>/dev/null) || { echo pending; return; }
    last=''
  fi
  for c in $list; do
    s=$(run_state "$c" "$INSTALL_WORKFLOW_PATH" "$b")
    case $s in
      none) ;;
      *) echo "$s"; return ;;
    esac
    [ -n "$last" ] && [ "$c" = "$last" ] && break
  done
  echo pending
}

# gate SHA [TABAN] — yayınlanabilir mi: izlenen daldaki CI VE (gerekiyorsa) sunucu kurulum testi başarılı.
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
  echo "$inst"
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
# Son 14 çift tutulur (yerel ve Drive; yalnızca bu adlandırmaya uyan dosyalar silinir). Yayından önce alınan
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
BACKUP_KEEP=14
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
# En yeni BACKUP_KEEP TAM çift (db + dosyalar) kalır; onlardan eski, bu adlandırmaya uyan dosyalar silinir.
# Bugünkü dosyalar ve adlandırmaya uymayan dosyalar asla silinmez. Tam çift sayısı BACKUP_KEEP'ten azsa hiçbir şey silinmez.
# Şifreleme açıkken Drive'da yalnızca şifreli (.age) çiftler döndürülür: şifresiz eski Drive yedeklerine dokunulmaz.
backup_retention() { # backup_retention yerel | backup_retention uzak [DESEN]
  local today dbs ups cutoff f ts dir re=${2:-$DAILY_RE}
  today=$(TZ=$BACKUP_TZ date +%F)
  if [ "$1" = yerel ]; then
    dbs=$(local_names | grep -E "$re" | grep '^db-' || true)
    ups=$(local_names | grep -E "$re" | grep '^dosyalar-' || true)
  else
    dbs=$(rclone lsf --files-only "$(remote_root)/database" 2>>"$LOGS/backup.log" | grep -E "$re" | grep '^db-' || true)
    ups=$(rclone lsf --files-only "$(remote_root)/uploads" 2>>"$LOGS/backup.log" | grep -E "$re" | grep '^dosyalar-' || true)
  fi
  cutoff=$(comm -12 <(echo "$dbs" | sed -nE "s/$re/\2/p" | sort -u) <(echo "$ups" | sed -nE "s/$re/\2/p" | sort -u) |
    sort -r | sed -n "${BACKUP_KEEP}p")
  [ -n "$cutoff" ] || return 0
  for f in $dbs $ups; do
    ts=$(echo "$f" | sed -nE "s/$re/\2/p")
    [ -n "$ts" ] || continue
    case $ts in "$today"_*) continue ;; esac
    [[ "$ts" < "$cutoff" ]] || continue
    if [ "$1" = yerel ]; then
      rm -f -- "${BACKUPS:?}/${f:?}" && blog "  eski yerel yedek silindi: $f"
    else
      case $f in db-*) dir=database ;; *) dir=uploads ;; esac
      rclone deletefile "$(remote_root)/$dir/$f" >>"$LOGS/backup.log" 2>&1 && blog "  eski Drive yedeği silindi: $dir/$f"
    fi
  done
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

# ---------- yayınlama ----------
do_deploy() { # do_deploy SHA ÖNCEKİ_SHA [uc] — "uc": yalnızca dalın güncel ucu yayınlanır (otomatik / elle güncelleme)
  local sha=$1 prev=${2:-} only_head=${3:-} s ver f prev_tag
  s=$(short "$sha"); ver=$(version_of "$sha")
  # Kapıdan sonra dal ilerlediyse ESKİ commit yayınlanmaz (bir sonraki tur yeni ucu değerlendirir); çalışan sürüme dokunulmaz
  if [ "$only_head" = uc ] && ! head_is "$sha"; then
    log "⏸ $ver ($s) yayınlanmadı: '$(branch)' dalının ucu değişti ya da doğrulanamadı; çalışan sürüm aynen sürüyor."
    return 0
  fi
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

  # Caddyfile bu yayında değişiyor mu; site yayından ÖNCE Caddy üzerinden yanıt veriyor mu (sonraki denetimin ölçütü)
  local caddy_changed=0 edge_before=0 verr vrc=0
  if [ -n "$prev" ] && ! git -C "$SRC" diff --quiet "$prev" "$sha" -- deploy/Caddyfile 2>/dev/null; then caddy_changed=1; fi
  if edge_ok; then edge_before=1; fi

  git -C "$SRC" checkout --quiet --force "$sha"
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
  if [ "$caddy_changed" = 1 ]; then
    compose restart caddy >>"$blog" 2>&1 || true
  fi

  if ! wait_healthy 240; then
    log "✘ $ver ($s): yeni sürüm açılmadı; önceki sürüme dönülüyor. Ayrıntı: takip log"
    revert_release "$sha" "$prev" "$prev_tag" "$blog" "$caddy_changed"
    return 1
  fi

  # Site HTTPS üzerinden, Caddy içinden YENİ sürüme ulaşıyor mu (Caddy yeni ayarla açıldı ve uygulamaya yönlendiriyor)
  if wait_edge "${TAKIP_EDGE_WAIT:-90}" "$s"; then
    log "  ön sunucu (Caddy): site HTTPS üzerinden yeni sürümü veriyor"
  elif [ "$edge_before" = 1 ]; then
    log "✘ $ver ($s): uygulama açıldı ama site HTTPS üzerinden (Caddy) yeni sürümü vermiyor; önceki sürüme dönülüyor. Caddy: $(caddy_state)"
    revert_release "$sha" "$prev" "$prev_tag" "$blog" "$caddy_changed"
    if wait_healthy 120 && wait_edge 60; then
      log "  önceki sürüm yeniden yayında."
    else
      log "⚠ önceki sürüme dönüldü ama site HTTPS üzerinden hâlâ yanıt vermiyor. Denetleyin: takip durum · takip log"
    fi
    return 1
  else
    log "⚠ site HTTPS üzerinden doğrulanamadı (yayından önce de yanıt vermiyordu); yayın sürdürüldü. Caddy: $(caddy_state)"
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
  # Derleme önbelleği sınırı aşmışsa kullanılmayan önbellek silinir; hata yayını bozmaz
  cache_housekeeping || log "⚠ derleme önbelleği denetimi tamamlanamadı (yayın etkilenmedi)"
  echo "$sha" >"$STATE/cache-checked"
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
  if [ "$head" = "$current" ]; then
    # Bu sürümü aracın ÖNCEKİ hâli yayınladıysa (araç yayınla birlikte güncellenir) ya da yayın derleme gerektirmediyse
    # önbellek denetimi güncel kuralla bir kez yapılır; sonra bu sürüm için yinelenmez
    if [ "$(cat "$STATE/cache-checked" 2>/dev/null || true)" != "$head" ]; then
      cache_housekeeping || log "⚠ derleme önbelleği denetimi tamamlanamadı"
      echo "$head" >"$STATE/cache-checked"
    fi
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
  local b sha g
  b=$(branch)
  git -C "$SRC" fetch --quiet --prune origin "+refs/heads/$b:refs/remotes/origin/$b"
  # Sunucuda zaten yayında bir sürüm varsa ilk kurulum yolu da yalnızca dalın güncel ucunu yayınlar (karar 276)
  if [ -n "$(cat "$STATE/deployed" 2>/dev/null || true)" ]; then
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
    _ci) gate "$(git -C "$SRC" rev-parse "$1")" ;;
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
    log | logs) compose logs --no-log-prefix --tail="${1:-200}" app ;;
    dal)
      if [ -n "${1:-}" ]; then echo "$1" >"$STATE/branch"; rm -f "$STATE/failed"; say "Otomatik güncelleme artık '$1' dalını izliyor."; else branch; fi
      ;;
    *)
      sed -n '2,19p' "$TAKIP_REEXEC" | sed 's/^# \{0,1\}//'
      return 1
      ;;
  esac
}

main "$@"
