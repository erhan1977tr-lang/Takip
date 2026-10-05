#!/usr/bin/env bash
# Derleme önbelleği temizliğinin (deploy/takip.sh → cache_housekeeping, karar 134) mantık testi — SAHTE docker ile.
# Gerçek Docker'a, gerçek önbelleğe, imaja, kapsayıcıya ya da birime dokunulmaz: PATH'in başına konan sahte "docker"
# yalnızca çağrıları kaydeder ve önbellek boyutunu bir dosyadan okur. takip aracı geçici bir klasörde (TAKIP_BASE) çalışır.
# Gerçek Docker ile uçtan uca deneme: .github/workflows/deploy-test.yml.
# Kullanım: bash deploy/test/cache-housekeeping.sh
set -Eeuo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TAKIP=$HERE/../takip.sh
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
FAKE=$ROOT/bin
mkdir -p "$FAKE"

# Sahte docker. Durum dosyaları ($FAKE_STATE): size (docker system df'in göstereceği önbellek boyutu), help (prune
# yardım metni), after-keep / after-all (ilgili temizlikten sonra boyut), prune-exit (temizliğin çıkış kodu).
cat >"$FAKE/docker" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
echo "docker $*" >>"$S/calls"
case "$1 ${2:-}" in
  'system df') if [ -s "$S/size" ]; then echo "Images|1.2GB|100MB"; echo "Build Cache|$(cat "$S/size")|$(cat "$S/size")"; fi ;;
  'builder prune')
    if [ "${3:-}" = --help ]; then cat "$S/help"; exit 0; fi
    code=$(cat "$S/prune-exit" 2>/dev/null || echo 0)
    if [ "$code" != 0 ]; then echo "error during connect: daemon is busy" >&2; exit "$code"; fi
    case " $* " in
      *' --reserved-space '* | *' --keep-storage '*) [ -f "$S/after-keep" ] && cp "$S/after-keep" "$S/size" ;;
      *) [ -f "$S/after-all" ] && cp "$S/after-all" "$S/size" ;;
    esac
    echo "ID   RECLAIMABLE   SIZE"; echo "Total reclaimed space: 68.1GB"
    ;;
  'info --format') echo "$S" ;;
  *) echo "sahte docker: beklenmeyen komut: $*" >&2; echo "BEKLENMEYEN docker $*" >>"$S/calls"; exit 97 ;;
esac
SH
chmod +x "$FAKE/docker"

HELP_NEW='Usage:  docker builder prune
  -a, --all                    Remove all unused build cache, not just dangling ones
      --filter filter          Provide filter values (e.g. "until=24h")
  -f, --force                  Do not prompt for confirmation
      --max-used-space bytes   Maximum amount of disk space allowed to keep for cache
      --min-free-space bytes   Target amount of free disk space after pruning
      --reserved-space bytes   Amount of disk space always allowed to keep for cache'
HELP_OLD='Usage:  docker builder prune
  -a, --all                  Remove all unused build cache, not just dangling ones
      --filter filter        Provide filter values (e.g. "until=24h")
  -f, --force                Do not prompt for confirmation
      --keep-storage bytes   Amount of disk space to keep for cache'
HELP_NONE='Usage:  docker builder prune
  -a, --all      Remove all unused build cache, not just dangling ones
  -f, --force    Do not prompt for confirmation'

n=0
fail() { echo "✘ $CASE: $*"; echo "--- çağrılar"; cat "$FAKE_STATE/calls" 2>/dev/null || true; echo "--- kayıt"; cat "$OUT" 2>/dev/null || true; exit 1; }
# setup AD BOYUT YARDIM — yeni, boş bir durum (boyut boşsa docker boyut vermez)
setup() {
  CASE=$1; n=$((n + 1))
  export FAKE_STATE=$ROOT/case$n
  mkdir -p "$FAKE_STATE"
  : >"$FAKE_STATE/calls"
  if [ -n "$2" ]; then echo "$2" >"$FAKE_STATE/size"; fi
  echo "$3" >"$FAKE_STATE/help"
  OUT=$FAKE_STATE/out
  RC=0
}
# go [ORTAM=DEĞER…] [-- KOMUT…] — takip aracını sahte docker ile çalıştırır (varsayılan: cache temizle)
go() {
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  if [ "${1:-}" = -- ]; then shift; fi
  if [ $# -eq 0 ]; then set -- cache temizle; fi
  env PATH="$FAKE:$PATH" TAKIP_BASE="$FAKE_STATE/takip" "${envs[@]}" bash "$TAKIP" "$@" >"$OUT" 2>&1 || RC=$?
}
prunes() { grep -c '^docker builder prune --all' "$FAKE_STATE/calls" || true; }
has() { grep -qF -- "$1" "$OUT" || fail "kayıtta yok: $1"; }
hasnt() { if grep -qF -- "$1" "$OUT"; then fail "kayıtta olmamalı: $1"; fi; }
called() { grep -qxF -- "docker $1" "$FAKE_STATE/calls" || fail "çağrılmadı: docker $1"; }
# Hiçbir durumda: system / volume / image / container temizliği, kapsayıcı ya da imaj silme, yaş süzgeci
safe() {
  if grep -E 'BEKLENMEYEN|docker (system prune|volume|image|container|rm|rmi|compose)|until=|--filter' "$FAKE_STATE/calls"; then fail "yasak / beklenmeyen docker çağrısı"; fi
  if grep -vE '^docker (system df --format |builder prune --help$|builder prune --all --force( --(reserved-space|keep-storage) [0-9]+)?$|info --format )' "$FAKE_STATE/calls"; then fail "izin verilenlerin dışında docker çağrısı"; fi
  [ "$RC" = 0 ] || fail "çıkış kodu $RC (temizlik hatası aracı / yayını bozmamalı)"
}

# 1. Sınır aşılmadı (tam 10 GB dahil): hiçbir şey silinmez
setup 'sınırın altında' 9.99GB "$HELP_NEW"; go
has 'derleme önbelleği: 9.99GB (sınır 10 GB aşılmadı, temizlik yok)'; [ "$(prunes)" = 0 ] || fail "temizlik yapılmamalıydı"; safe
setup 'tam sınırda' 10GB "$HELP_NEW"; go
has 'aşılmadı, temizlik yok'; [ "$(prunes)" = 0 ] || fail "temizlik yapılmamalıydı"; safe
setup 'küçük önbellek (MB)' 812.5MB "$HELP_OLD"; go
has 'aşılmadı, temizlik yok'; [ "$(prunes)" = 0 ] || fail "temizlik yapılmamalıydı"; safe

# 2. Sınır aşıldı, yeni Docker: boyuta göre tutma (--reserved-space); yaş süzgeci YOK; önce / işlem / sonuç / sonra / disk kayıtta
setup 'yeni Docker' 72.45GB "$HELP_NEW"; echo 3.9GB >"$FAKE_STATE/after-keep"; go
called 'builder prune --all --force --reserved-space 4000000000'
[ "$(prunes)" = 1 ] || fail "tek temizlik beklenirdi"
has 'derleme önbelleği (önce): 72.45GB — sınır 10 GB aşıldı'
has 'en son kullanılan 4 GB tutulur'
has 'önbellek temizliği: docker builder prune --all --force --reserved-space 4000000000'
has 'önbellek temizliği sonucu: Total reclaimed space: 68.1GB'
has 'derleme önbelleği (sonra): 3.9GB'
has '  disk ('; has 'dolu ('
hasnt 'hâlâ sınırın üstünde'; hasnt '7 gün'
safe
grep -q 'derleme önbelleği (sonra): 3.9GB' "$FAKE_STATE/takip/logs/deploy.log" || fail "yayın kaydına (deploy.log) yazılmadı"

# 3. Eski Docker: --keep-storage
setup 'eski Docker' 72.45GB "$HELP_OLD"; echo 4GB >"$FAKE_STATE/after-keep"; go
called 'builder prune --all --force --keep-storage 4000000000'
[ "$(prunes)" = 1 ] || fail "tek temizlik beklenirdi"
has 'derleme önbelleği (sonra): 4GB'; safe

# 4. Boyuta göre tutma seçeneği yok: kullanılmayan önbelleğin tamamı (yine yalnızca builder prune)
setup 'seçeneksiz Docker' 30GB "$HELP_NONE"; echo 0B >"$FAKE_STATE/after-all"; go
called 'builder prune --all --force'
[ "$(prunes)" = 1 ] || fail "tek temizlik beklenirdi"
has 'derleme önbelleği (sonra): 0B'; safe

# 5. Boyuta göre temizlik yer açmadı (eski kuralın hatası gibi: önce = sonra): ikinci adımda tamamı silinir
setup 'boyuta göre temizlik etkisiz' 72.45GB "$HELP_NEW"; echo 72.45GB >"$FAKE_STATE/after-keep"; echo 1.2GB >"$FAKE_STATE/after-all"; go
[ "$(prunes)" = 2 ] || fail "iki adım beklenirdi"
[ "$(grep '^docker builder prune --all' "$FAKE_STATE/calls" | paste -sd'|')" = 'docker builder prune --all --force --reserved-space 4000000000|docker builder prune --all --force' ] || fail "adım sırası"
has 'derleme önbelleği (sonra): 1.2GB'; hasnt 'hâlâ sınırın üstünde'; safe

# 6. Hiçbir temizlik yer açamıyor (önbellek kullanımda): uyarı; araç hata vermez; döngü yok (en çok iki adım)
setup 'yer açılamıyor' 72.45GB "$HELP_NEW"; echo 72.45GB >"$FAKE_STATE/after-keep"; echo 71GB >"$FAKE_STATE/after-all"; go
[ "$(prunes)" = 2 ] || fail "en çok iki adım"
has 'derleme önbelleği (sonra): 71GB'; has '⚠ derleme önbelleği hâlâ sınırın üstünde'; safe

# 7. Temizlik komutu hata verdi: uyarı kayda geçer, araç (ve yayın) hata vermez
setup 'temizlik başarısız' 72.45GB "$HELP_NEW"; echo 1 >"$FAKE_STATE/prune-exit"; go
has '⚠ önbellek temizliği başarısız (yayın etkilenmedi): error during connect: daemon is busy'
has 'derleme önbelleği (sonra): 72.45GB'; safe

# 8. Boyut okunamıyor (docker yanıt vermiyor): temizlik atlanır
setup 'boyut okunamadı' '' "$HELP_NEW"; go
has '⚠ derleme önbelleği: boyut okunamadı, temizlik atlandı'; [ "$(prunes)" = 0 ] || fail "temizlik yapılmamalıydı"; safe

# 9. Eşikler ortamdan (yalnızca deneme için) verilebilir; geçersiz değer varsayılanı bozmaz
setup 'küçük eşik' 900MB "$HELP_NEW"; echo 90MB >"$FAKE_STATE/after-keep"
go TAKIP_CACHE_LIMIT_BYTES=500000000 TAKIP_CACHE_KEEP_BYTES=100000000
called 'builder prune --all --force --reserved-space 100000000'
has 'sınır 500 MB aşıldı'; has 'en son kullanılan 100 MB tutulur'; has 'derleme önbelleği (sonra): 90MB'; safe
setup 'geçersiz eşik' 9GB "$HELP_NEW"; go TAKIP_CACHE_LIMIT_BYTES=abc TAKIP_CACHE_KEEP_BYTES=-5
has 'sınır 10 GB aşılmadı'; [ "$(prunes)" = 0 ] || fail "temizlik yapılmamalıydı"; safe

# 10. "takip cache" (yalnızca bilgi) hiçbir şey silmez
setup 'yalnızca bilgi' 72.45GB "$HELP_NEW"; go -- cache
has 'Derleme önbelleği   : 72.45GB'; has 'Sınır: 10 GB'; has 'Yalnızca derleme önbelleği silinir'
[ "$(prunes)" = 0 ] || fail "bilgi komutu temizlik yapmamalı"; safe

# 11. Yayın sürerken (yayın kilidi alınmış) elle temizlik başlamaz
setup 'yayın sürüyor' 72.45GB "$HELP_NEW"
mkdir -p "$FAKE_STATE/takip/state"
( exec 9>"$FAKE_STATE/takip/state/deploy.lock"; flock 9; sleep 3 ) &
sleep 0.5; go; wait
has 'Bir güncelleme sürüyor'; [ "$(prunes)" = 0 ] || fail "yayın sürerken temizlik yapılmamalı"; safe

# 12. Kaynak: araçta derleme önbelleği dışında hiçbir toplu temizlik komutu yok; eski yaş kuralı kalmadı
src() { grep -vE '^\s*#' "$TAKIP"; }
if src | grep -nE 'docker (system|volume|container|network) prune|docker volume rm|docker image prune (-a|--all)|docker rm |until=168h'; then echo "✘ araçta yasak temizlik komutu"; exit 1; fi
[ "$(src | grep -c 'docker builder prune --all --force "\$@"')" = 1 ] || { echo "✘ önbellek temizliği tek yerde olmalı"; exit 1; }
[ "$(src | grep -c 'docker builder prune')" = 3 ] || { echo "✘ builder prune yalnızca yardım okuma, kayıt satırı ve tek temizlik satırında olmalı"; exit 1; }

echo "✔ derleme önbelleği temizliği: $n durum geçti (sahte docker; gerçek hiçbir şey silinmedi)"
