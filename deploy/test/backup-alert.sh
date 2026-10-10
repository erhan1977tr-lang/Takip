#!/usr/bin/env bash
# Yedek alarmı ve bekçi (deploy/takip.sh, karar 249) — mantık testi: SAHTE docker, SAHTE rclone, SAHTE systemctl.
# Gerçek e-posta GÖNDERİLMEZ: alarm, sahte docker'ın "compose run … backup-alert.mjs" çağrısı olarak kaydedilir
# (e-postanın kendisi birim testinde: test/backup-alert.test.js). Gerçek Docker'a, veritabanına, Google Drive'a ya da
# sunucudaki hiçbir dosyaya dokunulmaz: takip aracı geçici bir klasörde (TAKIP_BASE) çalışır.
# Kullanım (root olarak):  bash deploy/test/backup-alert.sh
set -Eeuo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TAKIP=$HERE/../takip.sh
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
FAKE=$ROOT/bin
export FAKE_STATE=$ROOT/state TAKIP_BASE=$ROOT/base TAKIP_ASSUME_SYSTEMD=1
STATE=$TAKIP_BASE/state
DRIVE=$ROOT/drive
mkdir -p "$FAKE" "$FAKE_STATE" "$TAKIP_BASE" "$ROOT/uploads"
echo "yüklenen dosya" >"$ROOT/uploads/a.pdf"
SECRET='SMTP-GIZLI-sifre-0123456789' TOKEN='ghp_GIZLITOKEN0123456789'
printf 'APP_TAG=test\nBACKUP_REMOTE=:local:%s\nSMTP_PASS=%s\nBACKUP_ALERT_EMAIL=yedek@alarm.test\n' "$DRIVE" "$SECRET" >"$TAKIP_BASE/.env"
echo "$TOKEN" >"$TAKIP_BASE/github-token"
export FAKE_UPLOADS=$ROOT/uploads FAKE_BACKUPS=$TAKIP_BASE/backups

[ "$(id -u)" = 0 ] || { echo "✘ bu test root olarak çalıştırılmalı"; exit 1; }

# Sahte docker: pg_dump / pg_restore / psql / tar; "compose run … backup-alert.mjs" → $FAKE_STATE/alerts (bir satır = bir
# e-posta isteği; argümanlar). dump-fail: pg_dump hata · alert-fail: e-posta gönderilemedi (çıkış 1).
cat >"$FAKE/docker" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
if [ "$1" = compose ]; then
  args=" $* "
  case $args in
    *'backup-alert.mjs '*)
      a=${args#*backup-alert.mjs }
      echo "$a" | sed 's/ *$//' >>"$S/alerts"
      [ -f "$S/alert-fail" ] && exit 1
      echo "yedek alarmı gönderildi" ;;
    *' ps --status running -q db '*) echo dbkapsayici ;;
    *' pg_dump '*) [ -f "$S/dump-fail" ] && exit 1; printf 'PGDMP sahte %s\n' "$(date +%s%N)" ;;
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
# Sahte rclone: ":local:/yol". upload-fail: kopyalama hata · md5-bad: Drive'daki kopyanın md5'i farklı
cat >"$FAKE/rclone" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
p() { echo "${1#:local:}"; }
case $1 in
  copyto) [ -f "$S/upload-fail" ] && exit 1; mkdir -p "$(dirname "$(p "$3")")"; cat "$(p "$2")" >"$(p "$3")" ;;
  md5sum) f=$(p "$2"); if [ -f "$S/md5-bad" ]; then echo "00000000000000000000000000000000  x"; elif [ -f "$f" ]; then md5sum "$f"; fi ;;
  lsf) d=$(p "${*: -1}"); [ -d "$d" ] && ls -1 "$d" ;;
  deletefile) rm -f "$(p "$2")" ;;
  *) : ;;
esac
SH
# Sahte systemctl: timer-off → takip-backup.timer çalışmıyor
cat >"$FAKE/systemctl" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
case "$*" in
  *is-active*takip-backup.timer*) [ -f "$S/timer-off" ] && exit 3; exit 0 ;;
  *) exit 0 ;;
esac
SH
chmod +x "$FAKE/docker" "$FAKE/rclone" "$FAKE/systemctl"
export PATH="$FAKE:$PATH"

n=0
fail() { echo "✘ $*"; echo "--- alarmlar"; cat "$FAKE_STATE/alerts" 2>/dev/null || true; echo "--- durum"; cat "$STATE/backup-alert" "$STATE/backup-last-run" 2>/dev/null || true; echo "--- günlük"; tail -n 20 "$TAKIP_BASE/logs/backup-alert.log" "$TAKIP_BASE/logs/backup.log" 2>/dev/null || true; exit 1; }
ok() { n=$((n + 1)); echo "✔ $*"; }
takip() { bash "$TAKIP" "$@" >>"$ROOT/out" 2>&1; }
alerts() { if [ -f "$FAKE_STATE/alerts" ]; then wc -l <"$FAKE_STATE/alerts"; else echo 0; fi; }
last_alert() { tail -n 1 "$FAKE_STATE/alerts"; }
set_flag() { : >"$FAKE_STATE/$1"; }
clear_flag() { rm -f "$FAKE_STATE/$1"; }

# 1. Başarılı yedek: alarm yok, son başarılı yedek kaydı var, sorun listesi boş
takip yedek || fail "başarılı yedek hata verdi"
[ "$(alerts)" = 0 ] || fail "başarılı yedekte alarm gönderildi"
[ -f "$STATE/backup-last-ok" ] || fail "son başarılı yedek kaydı yok"
[ ! -s "$STATE/backup-last-run" ] || fail "sorun listesi boş değil: $(cat "$STATE/backup-last-run")"
ok "başarılı yedek: alarm yok"

# 2. Veritabanı yedeği alınamıyor → DB_DUMP alarmı (Drive için ayrıca kod yok); aynı hata yinelenince yeni e-posta yok
set_flag dump-fail
takip yedek && fail "döküm hatasında yedek başarılı sayıldı"
[ "$(alerts)" = 1 ] || fail "alarm sayısı $(alerts)"
[[ "$(last_alert)" =~ ^FAIL\ --age\ [0-9]+\ --host\ [A-Za-z0-9.-]+\ DB_DUMP$ ]] || fail "alarm biçimi: $(last_alert)"
takip yedek || true
takip yedek-kontrol
[ "$(alerts)" = 1 ] || fail "aynı sorun için ikinci e-posta gönderildi"
ok "DB_DUMP alarmı bir kez; yinelenen hata ve bekçi yeni e-posta göndermez"

# 3. Sorun değişince hemen yeni alarm: Drive'a yüklenemiyor (veritabanı düzeldi)
clear_flag dump-fail; set_flag upload-fail
takip yedek || true
[ "$(alerts)" = 2 ] && [[ "$(last_alert)" == *' DRIVE_UPLOAD' ]] || fail "DRIVE_UPLOAD alarmı yok: $(last_alert)"
# Yüklendi ama Drive'daki kopya doğrulanamıyor (bütünlük)
clear_flag upload-fail; set_flag md5-bad
takip yedek || true
[ "$(alerts)" = 3 ] && [[ "$(last_alert)" == *' DRIVE_VERIFY' ]] || fail "DRIVE_VERIFY alarmı yok: $(last_alert)"
clear_flag md5-bad
ok "sorun kümesi değişince yeni alarm (DRIVE_UPLOAD, DRIVE_VERIFY)"

# 4. Şifreleme açık ama anahtar yok → ENCRYPT; Drive'a açık dosya gitmez
echo "age1sahtealici" >"$STATE/backup-encryption"
before=$(find "$DRIVE" -type f | wc -l)
takip yedek || true
[[ "$(last_alert)" == *' ENCRYPT' ]] || fail "ENCRYPT alarmı yok: $(last_alert)"
[ "$(find "$DRIVE" -type f | wc -l)" = "$before" ] || fail "şifreleme hatasında Drive'a dosya gitti"
rm -f "$STATE/backup-encryption"
ok "şifreleme hatası: ENCRYPT alarmı, Drive'a dosya gitmedi"

# 5. Düzelme: bir kez "düzeldi" e-postası, alarm kapanır, kayda geçer; sonra sessiz
takip yedek || fail "düzelen yedek hata verdi"
[[ "$(last_alert)" =~ ^RECOVERED\ --age\ 0\ --host ]] || fail "düzeldi e-postası yok: $(last_alert)"
[ ! -e "$STATE/backup-alert" ] || fail "alarm durumu kapanmadı"
grep -q 'DÜZELDİ (önceki: ENCRYPT)' "$TAKIP_BASE/logs/backup-alert.log" || fail "iyileşme kaydı yok"
c=$(alerts); takip yedek; takip yedek-kontrol; [ "$(alerts)" = "$c" ] || fail "düzeldikten sonra gereksiz e-posta"
ok "iyileşme: tek 'düzeldi' e-postası, kayıt, sonra sessiz"

# 6. Bekçi: son başarılı yedek 26 saatten eski (gece yedeği hiç çalışmadı) → STALE (yaş saat olarak)
touch -d '27 hours ago' "$STATE/backup-last-ok"
takip yedek-kontrol
[[ "$(last_alert)" =~ ^FAIL\ --age\ 27\ --host\ [A-Za-z0-9.-]+\ STALE$ ]] || fail "STALE alarmı: $(last_alert)"
[ -f "$STATE/backup-check-last" ] || fail "bekçi çalışma kaydı yok"
# 25 saat sınırın altında: alarm yok (yeni durum)
c=$(alerts); takip yedek; [ "$(alerts)" = $((c + 1)) ] && [[ "$(last_alert)" == RECOVERED* ]] || fail "yedekle STALE düzelmedi"
touch -d '25 hours ago' "$STATE/backup-last-ok"; c=$(alerts); takip yedek-kontrol; [ "$(alerts)" = "$c" ] || fail "26 saatin altında alarm"
ok "bekçi: 26 saati aşan yedek → STALE alarmı; altında sessiz"

# 7. Gece yedeği zamanlayıcısı çalışmıyor → BACKUP_TIMER (yedek kendisi sağlam olsa da)
set_flag timer-off
takip yedek-kontrol
[[ "$(last_alert)" == *' BACKUP_TIMER' ]] || fail "BACKUP_TIMER alarmı yok: $(last_alert)"
clear_flag timer-off; takip yedek-kontrol
[[ "$(last_alert)" == RECOVERED* ]] || fail "zamanlayıcı düzelince düzeldi gelmedi"
ok "zamanlayıcı çalışmıyor → BACKUP_TIMER; düzelince düzeldi"

# 8. Bekçinin kendisi 3 saattir çalışmadı → yedek bunu bildirir (CHECK_TIMER); hiç kurulmamış bekçi alarm üretmez
touch -d '4 hours ago' "$STATE/backup-check-last"
takip yedek
[[ "$(last_alert)" == *' CHECK_TIMER' ]] || fail "CHECK_TIMER alarmı yok: $(last_alert)"
takip yedek-kontrol # bekçi yeniden çalıştı
[[ "$(last_alert)" == RECOVERED* ]] || fail "bekçi çalışınca düzeldi gelmedi"
ok "bekçi 3 saattir çalışmadı → CHECK_TIMER (karşılıklı denetim)"

# 9. E-posta gönderilemezse alarm 'gönderildi' sayılmaz, sonraki denetimde yeniden denenir
set_flag alert-fail; set_flag dump-fail
c=$(alerts); takip yedek || true
[ ! -e "$STATE/backup-alert" ] || fail "gönderilemeyen alarm gönderildi sayıldı"
takip yedek-kontrol
[ "$(alerts)" = $((c + 2)) ] || fail "gönderilemeyen alarm yeniden denenmedi"
grep -q 'ALARM GÖNDERİLEMEDİ' "$TAKIP_BASE/logs/backup-alert.log" || fail "gönderim hatası kayda geçmedi"
clear_flag alert-fail
takip yedek-kontrol
[ -s "$STATE/backup-alert" ] || fail "alarm gönderilince kaydedilmedi"
ok "e-posta gönderilemezse yeniden denenir, gönderilince kaydedilir"

# 10. 24 saat dolunca aynı alarm bir kez yinelenir
codes=$(cut -d'|' -f1 "$STATE/backup-alert")
echo "$codes|$(( $(date +%s) - 25 * 3600 ))" >"$STATE/backup-alert"
c=$(alerts); takip yedek-kontrol; [ "$(alerts)" = $((c + 1)) ] || fail "24 saat sonra hatırlatma yok"
takip yedek-kontrol; [ "$(alerts)" = $((c + 1)) ] || fail "hatırlatma yinelendi"
clear_flag dump-fail; takip yedek
ok "24 saat sonra bir hatırlatma, sonra sessiz"

# 11. Sırlar: alarm argümanlarında, alarm / yedek günlüğünde ve çıktıda SMTP şifresi, GitHub token'ı, .env içeriği yok
for f in "$FAKE_STATE/alerts" "$TAKIP_BASE/logs/backup-alert.log" "$TAKIP_BASE/logs/backup.log" "$ROOT/out"; do
  if grep -qF -e "$SECRET" -e "$TOKEN" -e 'yedek@alarm.test' "$f"; then fail "sır sızdı: $f"; fi
done
# Alarm argümanları yalnızca sabit biçim: tür, yaş, sunucu adı, bilinen kodlar
bad=$(grep -vE '^(FAIL|RECOVERED) --age [0-9]+ --host [A-Za-z0-9.-]+( (DB_DUMP|DB_VERIFY|FILES|FILES_VERIFY|RCLONE_MISSING|ENCRYPT|DRIVE_UPLOAD|DRIVE_VERIFY|STALE|BACKUP_TIMER|CHECK_TIMER))*$' "$FAKE_STATE/alerts" || true)
[ -z "$bad" ] || fail "beklenmeyen alarm argümanı: $bad"
ok "sır yok; alarm yalnızca sabit kodlar taşır"

# 12. durum: salt okunur, gönderim yok
c=$(alerts); bash "$TAKIP" yedek-kontrol durum >"$ROOT/durum" 2>&1; [ "$(alerts)" = "$c" ] || fail "durum e-posta gönderdi"
grep -q 'Şu anki sorunlar' "$ROOT/durum" || fail "durum çıktısı"
ok "yedek-kontrol durum yalnızca okur"

echo "✔ yedek alarmı: $n kontrol geçti"
