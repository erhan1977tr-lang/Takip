#!/usr/bin/env bash
# Yedek saklama (deploy/takip.sh, karar 279) — mantık testi: SAHTE docker, SAHTE rclone, SAHTE systemctl.
# Yerel 14 gün / Google Drive 60 gün, bağımsız ayar (.env: BACKUP_KEEP_LOCAL_DAYS / BACKUP_KEEP_DRIVE_DAYS); yalnızca TAM ve
# DOĞRULANMIŞ çiftler silinir; eksik / doğrulanmamış çift, adlandırmaya uymayan dosya ve bugünün yedeği asla silinmez; Drive
# listesi alınamazsa hiçbir şey silinmez. Gerçek Docker'a, veritabanına, Google Drive'a ya da sunucudaki hiçbir dosyaya
# dokunulmaz: takip aracı geçici bir klasörde (TAKIP_BASE) çalışır, "Drive" geçici bir klasördür (:local:).
# Kullanım (root olarak):  bash deploy/test/backup-retention.sh
set -Eeuo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TAKIP=$HERE/../takip.sh
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
FAKE=$ROOT/bin
export FAKE_STATE=$ROOT/state TAKIP_BASE=$ROOT/base TAKIP_ASSUME_SYSTEMD=1
STATE=$TAKIP_BASE/state
BACKUPS=$TAKIP_BASE/backups
DRIVE=$ROOT/drive
mkdir -p "$FAKE" "$FAKE_STATE" "$TAKIP_BASE" "$ROOT/uploads"
echo "yüklenen dosya" >"$ROOT/uploads/a.pdf"
export FAKE_UPLOADS=$ROOT/uploads FAKE_BACKUPS=$BACKUPS

[ "$(id -u)" = 0 ] || { echo "✘ bu test root olarak çalıştırılmalı"; exit 1; }

# Sahte docker: pg_dump / pg_restore / psql / tar (yedeğin kendisi gerçek dosya olarak oluşur)
cat >"$FAKE/docker" <<'SH'
#!/usr/bin/env bash
if [ "$1" = compose ]; then
  args=" $* "
  case $args in
    *' ps --status running -q db '*) echo dbkapsayici ;;
    *' pg_dump '*) printf 'PGDMP sahte %s\n' "$(date +%s%N)" ;;
    *' pg_restore '*) cat >/dev/null ;;
    *' psql '*) case $args in *'count(*)'*) echo 3 ;; esac ;;
    *) : ;;
  esac
  exit 0
fi
case "$1 ${2:-}" in
  'image inspect') exit 0 ;;
  'run --rm')
    script='' target=''
    while [ $# -gt 0 ]; do if [ "$1" = -c ]; then script=$2; target=${4:-}; break; fi; shift; done
    script=${script//\/u/$FAKE_UPLOADS}; target=${target/#\/b\//$FAKE_BACKUPS/}
    sh -c "$script" sh "$target" ;;
  *) echo "sahte docker: beklenmeyen komut: $*" >&2; exit 97 ;;
esac
SH
# Sahte rclone (":local:/yol"). upload-fail: kopyalama hata · lsf-fail: listeleme hata · her silme $FAKE_STATE/deleted'a yazılır
cat >"$FAKE/rclone" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
p() { echo "${1#:local:}"; }
case $1 in
  copyto) [ -f "$S/upload-fail" ] && exit 1; mkdir -p "$(dirname "$(p "$3")")"; cat "$(p "$2")" >"$(p "$3")" ;;
  md5sum) f=$(p "$2"); [ -f "$f" ] && md5sum "$f" ;;
  lsf) [ -f "$S/lsf-fail" ] && exit 1; d=$(p "${*: -1}"); [ -d "$d" ] && ls -1 "$d" ;;
  deletefile) echo "$2" >>"$S/deleted"; rm -f "$(p "$2")" ;;
  *) : ;;
esac
SH
cat >"$FAKE/systemctl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKE/docker" "$FAKE/rclone" "$FAKE/systemctl"
export PATH="$FAKE:$PATH"

n=0
fail() { echo "✘ $*"; echo "--- günlük"; tail -n 30 "$TAKIP_BASE/logs/backup.log" 2>/dev/null || true; exit 1; }
ok() { n=$((n + 1)); echo "✔ $*"; }
takip() { bash "$TAKIP" "$@" >>"$ROOT/out" 2>&1; }
TZ_B=Europe/Bucharest
day_ago() { TZ=$TZ_B date -d "$(TZ=$TZ_B date +%F) -$1 days" +%F; }
# reset ENV_SATIRLARI… — her senaryo temiz bir yerel klasör, Drive ve defterle başlar
reset() {
  rm -rf "$DRIVE" "$BACKUPS" "$STATE" "$FAKE_STATE" "$TAKIP_BASE/logs"
  mkdir -p "$DRIVE/database" "$DRIVE/uploads" "$BACKUPS" "$FAKE_STATE" "$STATE"
  { printf 'APP_TAG=test\nBACKUP_REMOTE=:local:%s\n' "$DRIVE"; for l in "$@"; do echo "$l"; done; } >"$TAKIP_BASE/.env"
}
# pair YER GÜN_ÖNCE [EK] — o günün (03:00) çiftini yerelde ya da Drive'da oluşturur (EK: .age)
pair() {
  local ts; ts="$(day_ago "$2")_030000"
  if [ "$1" = yerel ]; then echo x >"$BACKUPS/db-$ts.dump"; echo x >"$BACKUPS/dosyalar-$ts.tgz"
  else echo x >"$DRIVE/database/db-$ts.dump${3:-}"; echo x >"$DRIVE/uploads/dosyalar-$ts.tgz${3:-}"; fi
}
# has YER GÜN_ÖNCE → o günün çiftinin İKİ dosyası da duruyor mu
has() {
  local ts; ts="$(day_ago "$2")_030000"
  if [ "$1" = yerel ]; then [ -f "$BACKUPS/db-$ts.dump" ] && [ -f "$BACKUPS/dosyalar-$ts.tgz" ]
  else [ -f "$DRIVE/database/db-$ts.dump" ] && [ -f "$DRIVE/uploads/dosyalar-$ts.tgz" ]; fi
}
gone() {
  local ts; ts="$(day_ago "$2")_030000"
  if [ "$1" = yerel ]; then [ ! -e "$BACKUPS/db-$ts.dump" ] && [ ! -e "$BACKUPS/dosyalar-$ts.tgz" ]
  else [ ! -e "$DRIVE/database/db-$ts.dump" ] && [ ! -e "$DRIVE/uploads/dosyalar-$ts.tgz" ]; fi
}
count() { if [ "$1" = yerel ]; then find "$BACKUPS" -maxdepth 1 -name 'db-*_*.dump' | wc -l; else find "$DRIVE/database" -name 'db-*_*.dump' | wc -l; fi; }
today_pair() { local t; t=$(TZ=$TZ_B date +%F); ls "$1"/db-"${t}"_*.dump* >/dev/null 2>&1; }

# 1. Varsayılan: yerel 14 gün, Drive 60 gün — 80 günlük eski çiftler (eski sürümden kalma; defter yok)
reset
for d in $(seq 1 80); do pair yerel "$d"; pair uzak "$d"; done
takip yedek || fail "yedek hata verdi"
today_pair "$BACKUPS" && today_pair "$DRIVE/database" || fail "bugünün yedeği yok"
for d in 1 14; do has yerel "$d" || fail "yerel $d gün önceki çift silindi"; done
for d in 15 16 80; do gone yerel "$d" || fail "yerel $d gün önceki çift silinmedi"; done
for d in 1 14 15 59 60; do has uzak "$d" || fail "Drive $d gün önceki çift silindi (60 gün saklanmalı)"; done
for d in 61 62 80; do gone uzak "$d" || fail "Drive $d gün önceki çift silinmedi"; done
[ "$(count yerel)" = 15 ] || fail "yerel çift sayısı $(count yerel) (bugün + 14 gün)"
[ "$(count uzak)" = 61 ] || fail "Drive çift sayısı $(count uzak) (bugün + 60 gün)"
grep -q "Saklama: yerel 14 gün, Google Drive 60 gün" <(bash "$TAKIP" durum 2>&1) || fail "durum ekranında saklama süreleri yok"
ok "yerel 14 gün, Google Drive 60 gün; daha eski çiftler silindi, bugünkü yedek duruyor"

# 2. İkinci gece: zaten 60 gün içindeki çiftler silinmez; tekrar çalıştırmak yeni bir şey silmez
before=$(count uzak); takip yedek || fail "ikinci yedek hata verdi"
[ "$(count uzak)" -ge "$before" ] || fail "ikinci gece Drive'da çift azaldı"
for d in 1 60; do has uzak "$d" || fail "ikinci gece Drive $d gün önceki çift silindi"; done
ok "ikinci gece: 60 günlük pencere korunuyor"

# 3. Eksik çiftler (yalnızca veritabanı ya da yalnızca dosyalar) ne kadar eski olursa olsun silinmez
reset
for d in $(seq 1 70); do pair uzak "$d"; pair yerel "$d"; done
o1="$(day_ago 90)_030000" o2="$(day_ago 95)_030000"
echo x >"$DRIVE/database/db-$o1.dump"; echo x >"$DRIVE/uploads/dosyalar-$o2.tgz"
echo x >"$BACKUPS/db-$o1.dump"; echo x >"$BACKUPS/dosyalar-$o2.tgz"
takip yedek || fail "yedek hata verdi"
[ -f "$DRIVE/database/db-$o1.dump" ] && [ -f "$DRIVE/uploads/dosyalar-$o2.tgz" ] || fail "Drive'daki eksik çift silindi"
[ -f "$BACKUPS/db-$o1.dump" ] && [ -f "$BACKUPS/dosyalar-$o2.tgz" ] || fail "yereldeki eksik çift silindi"
gone uzak 65 || fail "eksik çift olan gecede tam eski çift de silinmedi"
grep -q "Google Drive: 2 eksik, 0 doğrulanmamış çift korundu" "$TAKIP_BASE/logs/backup.log" || fail "eksik çift günlüğe yazılmadı"
ok "eksik çiftler (tek dosya) silinmez, günlükte sayılır"

# 4. Doğrulanmamış çift (deftere girmemiş) silinmez; doğrulanmış olan silinir
reset
since="$(day_ago 200)_000000"
{ echo "since $since"; for d in $(seq 1 64) 66; do echo "$(day_ago "$d")_030000"; done; } >"$STATE/backup-verified-drive"
for d in $(seq 1 66); do pair uzak "$d"; done
takip yedek || fail "yedek hata verdi"
has uzak 65 || fail "doğrulanmamış çift (65 gün) silindi"
gone uzak 66 || fail "doğrulanmış eski çift (66 gün) silinmedi"
has uzak 60 || fail "60 gün içindeki çift silindi"
grep -q "Google Drive: 0 eksik, 1 doğrulanmamış çift korundu" "$TAKIP_BASE/logs/backup.log" || fail "doğrulanmamış çift günlüğe yazılmadı"
ok "doğrulanmamış çift silinmez; doğrulanmış eski çift silinir"

# 5. Yeterince doğrulanmış yeni çift yoksa (yedekler uzun süre alınamadı) çok eski çiftler bile silinmez
reset
for d in 200 210 220 230; do pair uzak "$d"; pair yerel "$d"; done
takip yedek || fail "yedek hata verdi"
for d in 200 210 220 230; do has uzak "$d" || fail "Drive: tek yedek kalan dönemde $d gün önceki çift silindi"; has yerel "$d" || fail "yerel: $d gün önceki çift silindi"; done
ok "60'tan az doğrulanmış çift varken hiçbir eski çift silinmez"

# 6. Drive'a yüklenemeyen gece: temizlik yapılmaz, Drive defterine yazılmaz (yerel deftere yazılır)
reset
for d in $(seq 1 70); do pair uzak "$d"; pair yerel "$d"; done
: >"$FAKE_STATE/upload-fail"
takip yedek && fail "Drive'a yüklenemeyen yedek başarılı sayıldı"
rm -f "$FAKE_STATE/upload-fail"
has uzak 70 && has yerel 70 || fail "başarısız gecede eski yedek silindi"
t=$(TZ=$TZ_B date +%F)
grep -q "^${t}_" "$STATE/backup-verified-local" || fail "yerelde doğrulanan çift yerel deftere yazılmadı"
! grep -q "^${t}_" "$STATE/backup-verified-drive" 2>/dev/null || fail "Drive'a gitmeyen çift Drive defterine yazıldı"
ok "başarısız gecede silme yok; doğrulanmayan çift Drive defterine girmez"

# 7. Drive listesi alınamazsa Drive'da hiçbir şey silinmez
reset
for d in $(seq 1 70); do pair uzak "$d"; done
: >"$FAKE_STATE/lsf-fail"
takip yedek || fail "yedek hata verdi"
rm -f "$FAKE_STATE/lsf-fail"
[ ! -s "$FAKE_STATE/deleted" ] || fail "liste alınamadığı halde Drive'da silme: $(cat "$FAKE_STATE/deleted")"
has uzak 70 || fail "liste alınamadığı halde silindi"
grep -q "Google Drive listesi alınamadı — Drive temizliği atlandı" "$TAKIP_BASE/logs/backup.log" || fail "uyarı günlükte yok"
ok "Drive listesi alınamazsa hiçbir şey silinmez"

# 8. Adlandırmaya uymayan dosyalar, şifreli (.age) çiftler (şifreleme kapalıyken) ve yayın öncesi yedekler silinmez
reset
for d in $(seq 1 70); do pair uzak "$d"; done
pair uzak 90 .age
echo x >"$DRIVE/database/db-20200101-120000-once.dump"; echo x >"$DRIVE/database/notlar.txt"
echo x >"$DRIVE/uploads/dosyalar-2020-01-01_030000.tgz.bozuk"
takip yedek || fail "yedek hata verdi"
ts90="$(day_ago 90)_030000"
[ -f "$DRIVE/database/db-$ts90.dump.age" ] && [ -f "$DRIVE/uploads/dosyalar-$ts90.tgz.age" ] || fail "şifreli eski çift (başka düzen) silindi"
[ -f "$DRIVE/database/db-20200101-120000-once.dump" ] && [ -f "$DRIVE/database/notlar.txt" ] && [ -f "$DRIVE/uploads/dosyalar-2020-01-01_030000.tgz.bozuk" ] ||
  fail "adlandırmaya uymayan dosya silindi"
gone uzak 70 || fail "eski şifresiz çift silinmedi"
ok "adlandırmaya uymayan dosyalar ve başka düzendeki (.age) çiftler korunur"

# 9. Bağımsız ayar: Drive 30, yerel 21 gün; geçersiz değerler varsayılana döner (temizlik asla sertleşmez)
reset BACKUP_KEEP_DRIVE_DAYS=30 BACKUP_KEEP_LOCAL_DAYS=21
for d in $(seq 1 70); do pair uzak "$d"; pair yerel "$d"; done
takip yedek || fail "yedek hata verdi"
has uzak 30 && gone uzak 31 || fail "Drive 30 gün ayarı uygulanmadı"
has yerel 21 && gone yerel 22 || fail "yerel 21 gün ayarı uygulanmadı"
for bad in abc 3 0 401 -5 99999; do
  reset "BACKUP_KEEP_DRIVE_DAYS=$bad" "BACKUP_KEEP_LOCAL_DAYS=$bad"
  for d in $(seq 1 70); do pair uzak "$d"; pair yerel "$d"; done
  takip yedek || fail "yedek hata verdi ($bad)"
  has uzak 60 && gone uzak 61 || fail "geçersiz Drive değeri ($bad) varsayılan 60'a dönmedi"
  has yerel 14 && gone yerel 15 || fail "geçersiz yerel değeri ($bad) varsayılan 14'e dönmedi"
  grep -q "BACKUP_KEEP_DRIVE_DAYS geçersiz" "$TAKIP_BASE/logs/backup.log" || fail "geçersiz değer ($bad) günlükte uyarılmadı"
done
ok "yerel ve Drive süreleri bağımsız ayarlanır; geçersiz değer varsayılana döner"

# 10. Bugünün yedekleri asla silinmez (aynı gün birden çok yedek)
reset BACKUP_KEEP_DRIVE_DAYS=7 BACKUP_KEEP_LOCAL_DAYS=7
for d in $(seq 1 20); do pair uzak "$d"; pair yerel "$d"; done
t=$(TZ=$TZ_B date +%F)
echo x >"$DRIVE/database/db-${t}_000100.dump"; echo x >"$DRIVE/uploads/dosyalar-${t}_000100.tgz"
takip yedek || fail "yedek hata verdi"
[ -f "$DRIVE/database/db-${t}_000100.dump" ] || fail "bugünün eski yedeği silindi"
gone uzak 8 && has uzak 7 || fail "7 günlük ayar uygulanmadı"
ok "bugünün yedekleri silinmez"

echo "✔ yedek saklama testi: $n / $n"
