#!/usr/bin/env bash
# Yerel yedek dosyalarının izinleri (deploy/takip.sh, karar 136) — SAHTE docker ve SAHTE rclone ile, gerçek age ile.
# Kural: yedek klasörü 0700; içinde oluşan HER dosya (veritabanı dökümü, dosya arşivi, geçici .tmp, şifreli ara dosya,
# Drive'dan indirilen / çözülen dosya) oluşturulduğu andan itibaren 0600. Test bilerek gevşek umask (022) ile çalışır.
# Gerçek Docker'a, veritabanına, Google Drive'a ya da sunucudaki yedeklere dokunulmaz: takip aracı geçici bir klasörde
# (TAKIP_BASE) çalışır. Gerçek Docker + gerçek rclone ile uçtan uca deneme: .github/workflows/deploy-test.yml.
# Kullanım (root olarak; "yedek-sifreleme kur" root ister):  bash deploy/test/backup-permissions.sh
set -Eeuo pipefail
umask 022

HERE=$(cd "$(dirname "$0")" && pwd)
TAKIP=$HERE/../takip.sh
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
FAKE=$ROOT/bin
export FAKE_STATE=$ROOT/state TAKIP_BASE=$ROOT/base
BACKUPS=$TAKIP_BASE/backups
DRIVE=$ROOT/drive
mkdir -p "$FAKE" "$FAKE_STATE" "$TAKIP_BASE" "$ROOT/uploads/2026/10" "$ROOT/kenar"
echo "yüklenen dosya" >"$ROOT/uploads/2026/10/cizim.pdf"
printf 'APP_TAG=test\nBACKUP_REMOTE=:local:%s\n' "$DRIVE" >"$TAKIP_BASE/.env"
export FAKE_UPLOADS=$ROOT/uploads FAKE_BACKUPS=$BACKUPS

command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1 || { echo "✘ bu test gerçek 'age' ister (apt-get install -y age)"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "✘ bu test root olarak çalıştırılmalı"; exit 1; }

# Sahte docker. Kapsayıcının içi sunucunun umask'ını GÖRMEZ: "docker run" komutu her zaman umask 022 ile çalışır
# (gerçek kapsayıcıdaki gibi) — arşivin 0600 olması ancak komutun kendisi izin verirse mümkündür.
# $FAKE_STATE/modes: dosyalar OLUŞURKEN görülen izinler ("izin yol").  dump-fail: pg_dump hata versin.
cat >"$FAKE/docker" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
snapshot() { find "$FAKE_BACKUPS" -type f -printf "%m %p\n" >>"$S/modes" 2>/dev/null || true; }
if [ "$1" = compose ]; then
  args=" $* "
  case $args in
    *' ps --status running -q db '*) echo dbkapsayici ;;
    *' pg_dump '*)
      [ -f "$S/dump-fail" ] && { echo "pg_dump: bağlantı yok" >&2; exit 1; }
      snapshot # .tmp dosyası kabuk tarafından açıldı: izni şu an ne?
      printf 'PGDMP sahte döküm %s\n' "$(date +%s%N)" ;;
    *' pg_restore '*) cat >/dev/null; snapshot ;;
    *' psql '*) case $args in *'count(*)'*) echo 3 ;; esac ;;
    *) : ;;
  esac
  exit 0
fi
case "$1 ${2:-}" in
  'image inspect') exit 0 ;;
  'run --rm')
    # … -v takip_uploads:/u[:ro] -v YEDEK:/b takip:etiket sh -c BETİK sh /b/AD
    script='' target=''
    while [ $# -gt 0 ]; do
      if [ "$1" = -c ]; then script=$2; target=${4:-}; break; fi
      shift
    done
    [ -n "$script" ] || { echo "sahte docker: beklenmeyen run" >&2; exit 97; }
    script=${script//\/u/$FAKE_UPLOADS}
    target=${target/#\/b\//$FAKE_BACKUPS/}
    umask 022
    sh -c "$script" sh "$target"
    code=$?
    snapshot
    exit $code ;;
  *) echo "sahte docker: beklenmeyen komut: $*" >&2; exit 97 ;;
esac
SH
# Sahte rclone: ":local:/yol" → /yol. Gerçek rclone gibi hedefi yeni dosya olarak yazar (izin = 0666 & ~umask;
# kaynağın izni taşınmaz). upload-fail: Drive'a kopyalama hata versin.
cat >"$FAKE/rclone" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
p() { echo "${1#:local:}"; }
case $1 in
  copyto)
    src=$(p "$2"); dst=$(p "$3")
    case $dst in "$FAKE_BACKUPS"/*) ;; *) [ -f "$S/upload-fail" ] && { echo "sahte rclone: Drive'a ulaşılamadı" >&2; exit 1; } ;; esac
    case $src in "$FAKE_BACKUPS"/*) stat -c '%a %n' "$src" >>"$S/modes" ;; esac
    mkdir -p "$(dirname "$dst")"
    cat "$src" >"$dst" || exit 1
    case $dst in "$FAKE_BACKUPS"/*) stat -c '%a %n' "$dst" >>"$S/modes" ;; esac ;;
  md5sum) f=$(p "$2"); [ -f "$f" ] && md5sum "$f" | sed "s# .*#  $(basename "$f")#" ;;
  lsf) d=$(p "${*: -1}"); [ -d "$d" ] && ls -1 "$d" ;;
  deletefile) rm -f "$(p "$2")" ;;
  *) : ;;
esac
SH
chmod +x "$FAKE/docker" "$FAKE/rclone"
export PATH="$FAKE:$PATH"

n=0
fail() { echo "✘ $*"; echo "--- izin kayıtları"; cat "$FAKE_STATE/modes" 2>/dev/null || true; echo "--- yedek klasörü"; ls -la "$BACKUPS" 2>/dev/null || true; echo "--- günlük"; tail -n 25 "$TAKIP_BASE/logs/backup.log" 2>/dev/null || true; exit 1; }
ok() { n=$((n + 1)); echo "✔ $*"; }
takip() { bash "$TAKIP" "$@"; }
# Yedek klasöründe (alt klasörler dahil) 0600 OLMAYAN dosya; "eski" ile başlayan ad bilerek hariç (var olan dosya)
loose() { find "$BACKUPS" -type f ! -perm 600 ! -name 'eski-*' -printf '%m %p\n'; }
all_private() { local l; l=$(loose); [ -z "$l" ] || fail "$1 — 0600 olmayan yedek dosyası: $l"; }
# Oluşurken görülen izinlerin hepsi 600 olmalı; verilen desenlerin her biri kayıtta geçmeli
seen_private() {
  local what=$1 pat; shift
  if grep -v '/eski-' "$FAKE_STATE/modes" | grep -qv '^600 '; then fail "$what — oluşurken 0600 olmayan dosya görüldü"; fi
  for pat in "$@"; do grep -qE "^600 .*$pat" "$FAKE_STATE/modes" || fail "$what — izin kaydında beklenen dosya yok: $pat"; done
}
day=$(TZ=Europe/Bucharest date +%F)

# 0. Sahte ortam gerçekten ayırt ediyor mu: izin verilmezse sahte kapsayıcı 0644 yazar, kabuk da (umask 022) 0644
mkdir -p "$ROOT/kontrol"
FAKE_BACKUPS=$ROOT/kontrol docker run --rm --user 0 -v takip_uploads:/u:ro -v "$ROOT/kontrol":/b takip:test sh -c 'exec tar czf "$1" -C /u .' sh /b/izinsiz.tgz
[ "$(stat -c %a "$ROOT/kontrol/izinsiz.tgz")" = 644 ] || fail "sahte kapsayıcı umask 022 ile çalışmıyor"
: >"$ROOT/kontrol/kabuk"; [ "$(stat -c %a "$ROOT/kontrol/kabuk")" = 644 ] || fail "test umask 022 ile çalışmıyor"
rm -f "$FAKE_STATE/modes"
ok "sahte ortam: izin verilmeyen dosya 0644 olur (test eski davranışı yakalar)"

# 1. Yedek klasörü yoksa 0700 ile oluşur
[ ! -e "$BACKUPS" ] || fail "yedek klasörü baştan var"
takip durum >/dev/null 2>&1 || true
[ "$(stat -c '%a' "$BACKUPS")" = 700 ] || fail "yedek klasörü 0700 değil: $(stat -c '%a' "$BACKUPS")"
ok "yedek klasörü 0700 ile oluştu"
# Var olan (eski) dosyaya dokunulmaz
echo eski >"$BACKUPS/eski-yedek.dump"; chmod 644 "$BACKUPS/eski-yedek.dump"

# 2. Şifresiz gece yedeği: döküm ve arşiv (geçici .tmp dahil) 0600; Drive'a yüklenir
takip yedek >"$ROOT/out1" 2>&1 || { cat "$ROOT/out1"; fail "yedek (şifresiz) tamamlanmadı"; }
db=$(ls "$BACKUPS"/db-"$day"_*.dump); up=$(ls "$BACKUPS"/dosyalar-"$day"_*.tgz)
[ "$(stat -c '%a %U' "$db")" = "600 root" ] || fail "veritabanı yedeği: $(stat -c '%a %U' "$db")"
[ "$(stat -c '%a %U' "$up")" = "600 root" ] || fail "dosya yedeği: $(stat -c '%a %U' "$up")"
all_private "şifresiz yedek"
seen_private "şifresiz yedek" 'db-.*\.dump\.tmp$' 'dosyalar-.*\.tgz\.tmp$'
tar -tzf "$up" | grep -q 'cizim.pdf' || fail "arşivde yüklenen dosya yok"
head -c 5 "$db" | grep -q PGDMP || fail "döküm içeriği bozuk"
[ "$(ls "$DRIVE/database" | wc -l)" = 1 ] && [ "$(ls "$DRIVE/uploads" | wc -l)" = 1 ] || fail "Drive kopyası yok"
[ "$(stat -c '%a' "$BACKUPS")" = 700 ] || fail "yedek klasörü izni değişti"
[ -z "$(find "$BACKUPS" -name '*.tmp')" ] || fail "geçici dosya kaldı"
ok "şifresiz yedek: döküm, arşiv ve geçici dosyaları 0600; Drive kopyası ve doğrulama eskisi gibi"

# 3. Drive'dan indirilen (şifresiz) yedek de yerelde 0600 yazılır
mv "$db" "$up" "$ROOT/kenar/"
: >"$FAKE_STATE/modes"
takip restore-test "$day" >"$ROOT/out2" 2>&1 || { cat "$ROOT/out2"; fail "restore-test (Drive, şifresiz) başarısız"; }
grep -q 'Kaynak             : GOOGLE DRIVE' "$ROOT/out2" || fail "kaynak Drive olmalıydı"
grep -q '✔ Veritabanı geçici veritabanına yüklendi' "$ROOT/out2" || fail "geri yükleme denemesi"
[ -s "$db" ] && [ -s "$up" ] || fail "indirilen yedek yok"
all_private "Drive'dan indirilen yedek"
seen_private "Drive'dan indirilen yedek" 'db-.*\.dump$' 'dosyalar-.*\.tgz$'
ok "Drive'dan indirilen yedek dosyaları 0600"

# 4. Şifreleme (gerçek age): şifreli ara dosyalar, Drive'dan inen ve çözülen geçici dosyalar 0600
sleep 1
: >"$FAKE_STATE/modes"
TAKIP_ASSUME_KEY_SAVED=1 takip yedek-sifreleme kur >"$ROOT/out3" 2>&1 || { cat "$ROOT/out3"; fail "yedek-sifreleme kur başarısız"; }
grep -q '✔ Yedek şifreleme AÇIK' "$ROOT/out3" || fail "şifreleme açılmadı"
grep -q 'Kaynak             : GOOGLE DRIVE (şifreli)' "$ROOT/out3" || fail "şifreli Drive kopyası sınanmadı"
[ "$(stat -c '%a' "$TAKIP_BASE/backup-key.txt")" = 600 ] || fail "anahtar dosyası izni"
all_private "şifreli yedek"
seen_private "şifreli yedek" 'db-.*\.dump\.tmp$' 'dosyalar-.*\.tgz\.tmp$' 'db-.*\.dump\.age$' 'dosyalar-.*\.tgz\.age$' \
  '\.gecici\.[A-Za-z0-9]+/db\.age$' '\.gecici\.[A-Za-z0-9]+/dosyalar\.age$' '\.gecici\.[A-Za-z0-9]+/db-.*\.dump$' '\.gecici\.[A-Za-z0-9]+/dosyalar-.*\.tgz$'
[ -z "$(find "$BACKUPS" \( -name '*.age' -o -name '*.tmp' -o -name '.gecici.*' \))" ] || fail "şifreli / geçici dosya yerelde kaldı"
[ "$(find "$DRIVE/database" -name '*.age' | wc -l)" = 1 ] || fail "Drive'da şifreli kopya yok"
head -c 21 "$(find "$DRIVE/database" -name '*.age' | head -1)" | grep -q 'age-encryption.org/v1' || fail "Drive kopyası şifreli değil"
sleep 1
: >"$FAKE_STATE/modes"
takip yedek >"$ROOT/out4" 2>&1 || { cat "$ROOT/out4"; fail "şifreli gece yedeği tamamlanmadı"; }
all_private "şifreli gece yedeği"
seen_private "şifreli gece yedeği" 'db-.*\.dump\.tmp$' 'dosyalar-.*\.tgz\.tmp$' 'db-.*\.dump\.age$' 'dosyalar-.*\.tgz\.age$'
[ "$(find "$DRIVE/database" -name '*.age' | wc -l)" = 2 ] || fail "şifreli gece yedeği Drive'a gitmedi"
ok "şifreli yedek: şifreli ara dosyalar, Drive'dan indirilen ve çözülen geçici dosyalar 0600; şifreleme, yükleme, deneme eskisi gibi"

# 5. Hata davranışı değişmedi: Drive'a gidemeyen yedek yerelde durur (0600); döküm alınamazsa yarım dosya kalmaz
sleep 1
before=$(find "$DRIVE" -type f | wc -l)
: >"$FAKE_STATE/upload-fail"
if takip yedek >"$ROOT/out5" 2>&1; then cat "$ROOT/out5"; fail "Drive'a gidemeyen yedek 'tamam' dememeliydi"; fi
rm -f "$FAKE_STATE/upload-fail"
grep -q 'yerel yedek duruyor' "$ROOT/out5" || fail "Drive hatası kayda geçmedi"
grep -q 'yerel: tamam, Google Drive: HATA' "$ROOT/out5" || fail "özet satırı değişti"
[ "$(find "$DRIVE" -type f | wc -l)" = "$before" ] || fail "Drive'a dosya gitmiş"
[ "$(ls "$BACKUPS"/db-"$day"_*.dump | wc -l)" = 4 ] || fail "yerel yedek alınmadı: $(ls "$BACKUPS")"
all_private "Drive hatasında yerel yedek"
sleep 1
: >"$FAKE_STATE/dump-fail"
if takip yedek >"$ROOT/out6" 2>&1; then cat "$ROOT/out6"; fail "dökümü alınamayan yedek 'tamam' dememeliydi"; fi
rm -f "$FAKE_STATE/dump-fail"
grep -q 'veritabanı yedeği BAŞARISIZ' "$ROOT/out6" || fail "döküm hatası kayda geçmedi"
[ -z "$(find "$BACKUPS" -name '*.tmp')" ] || fail "yarım döküm (.tmp) kaldı"
[ "$(ls "$BACKUPS"/db-"$day"_*.dump | wc -l)" = 4 ] || fail "başarısız döküm dosya bırakmış"
all_private "döküm hatası"
ok "hata davranışı aynı: Drive hatasında yerel yedek durur, döküm hatasında yarım dosya kalmaz; dosyalar 0600"

# 6. Var olan dosyalara ve klasöre dokunulmadı
[ "$(stat -c '%a' "$BACKUPS/eski-yedek.dump")" = 644 ] || fail "var olan dosyanın izni değiştirilmiş"
[ "$(stat -c '%a' "$BACKUPS")" = 700 ] || fail "yedek klasörü izni değişti"
ok "var olan yedek dosyasının izni değiştirilmedi; klasör 0700"

# 7. Kaynak: umask aracın tamamına değil, yalnızca dosya oluşturan komutların çevresine verilir
if grep -nE '^\s*umask ' "$TAKIP"; then fail "takip.sh içinde genel (alt kabuk dışı) umask var"; fi
[ "$(grep -c 'umask 077' "$TAKIP")" -ge 6 ] || fail "beklenen umask 077 satırları yok"
grep -q "sh -c 'umask 077 && exec tar czf" "$TAKIP" || fail "arşiv izni kapsayıcının içinde verilmiyor"
ok "umask yalnızca alt kabuklarda (genel yan etki yok)"

echo
echo "✔ yedek izinleri: $n durum geçti"
