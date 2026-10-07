#!/usr/bin/env bash
# İşçi (worker) root olmadan ve ayrıcalıksız çalışır — gerçek Docker ile sunucu kurulumu testi (SEC-12; karar 137: kullanıcı
# 1001:1001, karar 138: cap_drop ALL + no-new-privileges, yalnızca işçide).
# .github/workflows/deploy-test.yml çalıştırır; kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi).
# GERÇEK SUNUCUDA ÇALIŞTIRILMAZ: deneme siparişi / dosyası üretir, .env'e geçici MAIL_OUTBOX_DIR yazar, deneme yayını yapar.
#
#   bash deploy/test/worker-nonroot.sh        kurulumdan / güncellemeden sonra (deponun çalışma klasöründen)
#   bash deploy/test/worker-nonroot.sh son    yedekten geri yüklemeden sonra (yalnızca sahiplik + işçi denetimi)
#
# Dış istek yok: FGO kapalı, e-postalar gönderilmez (kapsayıcıda dosyaya yazılır), depo alıcısı deneme adresi,
# virüs dosyası zararsız EICAR test dizgisi.
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
SITE=${SITE:-https://localhost}
ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
OWNER=1001:1001
compose() { sudo docker compose -p takip --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
sql() { compose exec -T db psql -U takip -d takip -Atc "$1"; }
VOL=$(sudo docker volume inspect -f '{{.Mountpoint}}' takip_uploads)
T=$(mktemp -d)

# Birimde sahibi 1001:1001 OLMAYAN kayıtlar (uploads-init'in düzelttiğiyle aynı ölçüt)
foreign() { sudo find "$VOL" -xdev ! \( -uid 1001 -gid 1001 \) -printf '%U:%G %y %m %P\n' | sort -k4; }
owner() { sudo stat -c '%u:%g' "$VOL/$1"; }
sha() { sudo sha256sum "$1" | cut -d' ' -f1; }
worker() { compose ps -q worker | head -n 1; }
note() { echo "::notice title=$1::$(sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"; }

# Hata olursa: hangi satır / komut + kapsayıcılar, işçinin durumu ve günlüğü, birimdeki yabancı kayıtlar not olarak
# yayınlanır (günlük dosyası indirilemeyen ortamlar için)
diag() { # diag SATIR ÇIKIŞ KOMUT
  trap - ERR
  set +ex
  {
    echo "satır $1 (çıkış $2): $3"
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' || true
    echo "--- işçi"; sudo docker inspect -f 'kullanıcı={{.Config.User}} durum={{.State.Status}} yeniden={{.RestartCount}}' "$(worker || true)" || true
    echo "--- 1001:1001 olmayan kayıtlar"; foreign | head -n 15 || true
    echo "--- uploads-init"; compose logs --no-log-prefix --tail 5 uploads-init || true
    echo "--- işçi günlüğü"; compose logs --no-log-prefix --tail 25 worker || true
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=İşçi root değil testi::/'
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR

# ---------- denetimler ----------
# İşçi: kapsayıcı 1001:1001 ile tanımlı, içindeki HER süreç gerçekten UID/GID 1001, çalışıyor, yeniden başlatılmamış;
# ayrıcalıksız (karar 138): ayrıcalıklı değil, eklenen yetenek yok, TÜM yetenekler bırakılmış, no-new-privileges açık —
# hem kapsayıcının ayarında hem çekirdeğin süreç için gösterdiğinde
worker_is_nonroot() {
  local id pid p
  id=$(worker)
  [ "$(sudo docker inspect -f '{{.Config.User}}' "$id")" = "$OWNER" ]
  [ "$(sudo docker inspect -f '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}}' "$id")" = "running false 0" ]
  pid=$(sudo docker inspect -f '{{.State.Pid}}' "$id")
  # Gerçek, etkin, kayıtlı ve dosya sistemi kimliklerinin dördü de 1001
  sudo awk '/^(Uid|Gid):/ { n++; if ($2 != 1001 || $3 != 1001 || $4 != 1001 || $5 != 1001) bad = 1 } END { exit (bad || n != 2) }' "/proc/$pid/status"
  sudo docker top "$id" -eo pid,uid,gid,args | awk 'NR > 1 { n++; if ($2 != 1001 || $3 != 1001) bad = 1 } END { exit (bad || n < 1) }'
  [ "$(sudo docker exec "$id" id -u):$(sudo docker exec "$id" id -g)" = "$OWNER" ]
  [ "$(sudo docker inspect -f '{{.HostConfig.Privileged}}' "$id")" = false ]
  [ "$(sudo docker inspect -f '{{len .HostConfig.CapAdd}}' "$id")" = 0 ]
  sudo docker inspect -f '{{json .HostConfig.CapDrop}}' "$id" | jq -e 'map(ascii_upcase) | index("ALL") != null' >/dev/null
  sudo docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$id" | jq -e 'map(select(test("^no-new-privileges(:true)?$"))) | length == 1' >/dev/null
  # Çekirdeğin gördüğü (kapsayıcıdaki her süreç): beş yetenek kümesinin hepsi boş, yeni ayrıcalık edinilemez
  for p in $(sudo docker top "$id" -eo pid | awk 'NR > 1 { print $1 }'); do
    sudo awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { n++; if ($2 !~ /^0+$/) bad = 1 } /^NoNewPrivs:/ { nnp = $2 } END { exit (bad || n != 5 || nnp != 1) }' "/proc/$p/status"
  done
  # Kapsayıcıda sonradan başlatılan süreç de aynı kısıtlarla başlar
  sudo docker exec "$id" cat /proc/self/status | awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { n++; if ($2 !~ /^0+$/) bad = 1 } /^NoNewPrivs:/ { nnp = $2 } END { exit (bad || n != 5 || nnp != 1) }'
}
# Not için: işçinin ayrıcalık ayarları (Docker) ve çekirdeğin süreç için gösterdiği değerler
hardening() {
  local id pid
  id=$(worker); pid=$(sudo docker inspect -f '{{.State.Pid}}' "$id")
  sudo docker inspect -f 'User={{.Config.User}} Privileged={{.HostConfig.Privileged}} CapAdd={{json .HostConfig.CapAdd}} CapDrop={{json .HostConfig.CapDrop}} SecurityOpt={{json .HostConfig.SecurityOpt}} RestartCount={{.RestartCount}} Status={{.State.Status}}' "$id"
  sudo awk '/^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/ { printf "%s%s", $1, $2 " " } END { print "" }' "/proc/$pid/status"
}
# Bu karar yalnızca işçide: diğer kapsayıcıların ayrıcalık ayarları olduğu gibi (ayar yok)
others_unchanged() {
  local s c
  for s in app db caddy clamav uploads-init; do
    c=$(compose ps -a -q "$s" | head -n 1)
    [ -n "$c" ]
    [ "$(sudo docker inspect -f '{{.HostConfig.Privileged}} {{len .HostConfig.CapAdd}} {{len .HostConfig.CapDrop}} {{len .HostConfig.SecurityOpt}}' "$c")" = "false 0 0 0" ]
  done
}
# Birim: kökü dahil hiçbir kayıt başka kullanıcıya ait değil
all_owned() {
  local l
  l=$(foreign)
  [ -z "$l" ] || { echo "1001:1001 olmayan kayıtlar:"; echo "$l" | head -n 20; return 1; }
  [ "$(sudo stat -c '%u:%g' "$VOL")" = "$OWNER" ]
}
# İşçi döngüsü yaşıyor: tarama turunun zamanı ilerliyor (en az bir yeni tur)
worker_ticks() {
  local a b
  a=$(sql "select value->>'lastRun' from \"IntegrationSetting\" where key = 'antivirus.status'")
  for _ in $(seq 1 40); do
    b=$(sql "select value->>'lastRun' from \"IntegrationSetting\" where key = 'antivirus.status'")
    if [ -n "$b" ] && [ "$b" != "$a" ]; then return 0; fi
    sleep 5
  done
  echo "işçi yeni tur atmadı (son: $a)"; return 1
}
# İşçi izin hatası almadı
no_permission_errors() {
  if compose logs --no-log-prefix worker | grep -E 'EACCES|EPERM|[Pp]ermission denied|[Oo]peration not permitted'; then echo "işçi günlüğünde izin hatası"; return 1; fi
}
site_up() {
  for _ in $(seq 1 60); do
    if curl -fsSk "$SITE/login" 2>/dev/null | grep -q 'GKH Digital'; then return 0; fi
    sleep 3
  done
  echo "site açılmadı"; return 1
}
wait_sql() { # wait_sql SORGU BEKLENEN [SANİYE]
  local got=''
  for _ in $(seq 1 $((${3:-240} / 5))); do
    got=$(sql "$1")
    if [ "$got" = "$2" ]; then return 0; fi
    sleep 5
  done
  echo "beklenen '$2', gelen '$got': $1"; return 1
}

# Veritabanındaki her dosya kaydı (virüslüler hariç: onlar karantinada) aynı anahtarla diskte ve 1001:1001
db_files_present() {
  local key n=0
  while IFS= read -r key <&3; do
    [ -n "$key" ] || continue
    sudo test -f "$VOL/$key" || { echo "veritabanındaki dosya diskte yok: $key"; return 1; }
    [ "$(owner "$key")" = "$OWNER" ] || { echo "dosya 1001:1001 değil: $key"; return 1; }
    n=$((n + 1))
  done 3< <(sql "select \"storageKey\" from \"OrderFile\" where \"scanStatus\" <> 'INFECTED' order by 1")
  [ "$n" -ge "${1:-1}" ]
}

if [ "${1:-}" = son ]; then
  # Yedekten geri yüklemeden sonra: dosyalar 1001:1001, işçi yine root değil ve çalışıyor
  site_up
  all_owned
  worker_is_nonroot
  worker_ticks
  no_permission_errors
  # Deneme dosyaları (3 temiz dosya + 3 depo PDF'i) yedekten aynı anahtarlarla geri geldi; karantinadakiler de yerinde
  db_files_present 6
  [ "$(sudo find "$VOL/.karantina" -type f -name '*virus*' | wc -l)" -ge 3 ]
  sudo takip durum | tee "$T/durum.txt"
  grep -q 'İşçi     : kullanıcı 1001:1001 (root değil)' "$T/durum.txt"
  grep -q 'Dosyalar : tüm kayıtların sahibi 1001:1001' "$T/durum.txt"
  { echo "geri yüklemeden sonra: $(sudo find "$VOL" -mindepth 1 | wc -l) kayıt, hepsi 1001:1001; işçi 1001:1001 ile, ayrıcalıksız çalışıyor"; hardening; } | note "İşçi root değil — geri yüklemeden sonra"
  exit 0
fi

# Deneme verisi: çalışan işçi kapsayıcısının içinde, uygulamanın kullanıcısıyla (dosyaları uygulama yüklemiş gibi)
fixtures() { cat "$HERE/worker-fixtures.mjs" | sudo docker exec -i -u "$OWNER" -e TAKIP_TEST_FIXTURES=1 "$(worker)" node --input-type=module - "$1" | tail -n 1 >"$T/$1.json"; jq -e .virusKey "$T/$1.json" >/dev/null; }
field() { jq -r ".$2" "$T/$1.json"; }
# Depo e-postası turu (karar 151). Gerçek sunucu işaretiyle çalışan — uzun ömürlü — işçi .env'deki MAIL_OUTBOX_DIR'ı YOK
# SAYAR ve bu makinede SMTP yoktur: o işçi depo e-postasını göndermez, iş kuyrukta bekler. E-postayı (ve Comanda Depozit
# PDF'ini) işaretin BİLEREK kaldırıldığı TEK SEFERLİK bir işçi kapsayıcısı üretir: "compose run -e TAKIP_DEPLOYMENT=" — komut
# satırı seçeneği; .env ile yapılamaz (Compose'daki sabit değer .env'den önce gelir). Servis tanımı aynıdır: 1001:1001,
# cap_drop ALL, no-new-privileges, aynı yükleme birimi. E-posta, kapsayıcıdaki /tmp/outbox'a bağlanan $T/outbox'a düşer.
mail_tour() {
  mkdir -p "$T/outbox"
  chmod 777 "$T/outbox"
  compose run --rm --no-deps -T -e TAKIP_DEPLOYMENT= -v "$T/outbox:/tmp/outbox" worker node scripts/worker.mjs --once >"$T/tur.log" 2>&1 || { cat "$T/tur.log"; return 1; }
}
# İşçi deneme verisini işledi: temiz dosya CLEAN, virüs INFECTED, depo e-postası SENT; depo PDF'inin anahtarı yazdırılır.
# "tur" verilirse (gerçek sunucu işaretli düzen): uzun ömürlü işçi taramayı yapar ama depo e-postasını GÖNDERMEZ ve diske
# yazmaz (yok sayılan MAIL_OUTBOX_DIR) — bu bir tam tur beklenerek doğrulanır; e-posta turunu tek seferlik işçi atar.
processed() { # processed ETİKET [tur]
  local job
  job="select status || ' ' || attempts from \"NotificationOutbox\" where type = 'WAREHOUSE_EMAIL' and \"orderId\" = '$(field "$1" profileId)'"
  wait_sql "select \"scanStatus\" from \"OrderFile\" where id = '$(field "$1" cleanId)'" CLEAN
  wait_sql "select \"scanStatus\" from \"OrderFile\" where id = '$(field "$1" virusId)'" INFECTED
  if [ "${2:-}" = tur ]; then
    worker_ticks
    [ "$(sql "$job")" = "PENDING 0" ]
    sudo docker exec "$(worker)" sh -c 'test ! -e /tmp/outbox'
    mail_tour
  fi
  wait_sql "select status from \"NotificationOutbox\" where type = 'WAREHOUSE_EMAIL' and \"orderId\" = '$(field "$1" profileId)'" SENT
  sql "select \"storageKey\" from \"OrderFile\" where \"orderId\" = '$(field "$1" profileId)' and source = 'WAREHOUSE_FORM'" >"$T/$1.depo"
  [ "$(wc -l <"$T/$1.depo")" = 1 ]
}
# Dosyalar yerinde ve doğru: temiz dosya değişmedi; virüs indirilemez yerde (karantina) ama KAYBOLMADI (aynı içerik);
# depo PDF'i gerçek bir PDF
files_intact() { # files_intact ETİKET
  local ck vk dk q
  ck=$(field "$1" cleanKey); vk=$(field "$1" virusKey); dk=$(cat "$T/$1.depo"); q=".karantina/${vk//\//_}"
  [ "$(sha "$VOL/$ck")" = "$(field "$1" cleanSha)" ]
  sudo test ! -e "$VOL/$vk"
  [ "$(sha "$VOL/$q")" = "$(field "$1" virusSha)" ]
  [ "$(sudo head -c 5 "$VOL/$dk")" = '%PDF-' ]
  [ "$(sudo stat -c %s "$VOL/$dk")" -gt 1000 ]
}

set -x
MONTH=$(date -u +%Y/%m)

# ---------- 1. Kurulu sistem: işçi root değil, uygulama ve migration araçları değişmedi ----------
site_up
worker_is_nonroot
[ "$(sudo docker exec takip-app-1 id -u)" = 1001 ]
# tools imajı (migration, yönetici, antivirüs / kur denetimi) root kalır: imaj değişmedi, yalnızca işçi servisi 1001
[ "$(compose run --rm --no-deps -T tools id -u | tail -n 1)" = 0 ]
# Sahiplik servisi: root, ağsız, yalnızca yükleme birimi bağlı, bir kez çalışıp 0 ile bitmiş
init=$(compose ps -a -q uploads-init | head -n 1)
[ "$(sudo docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.Config.User}} {{.HostConfig.NetworkMode}}' "$init")" = "exited 0 0:0 none" ]
[ "$(sudo docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}:{{.RW}} {{end}}' "$init")" = "volume:takip_uploads:/data/uploads:true " ]
others_unchanged
all_owned
sudo takip antivirus

# ---------- 2. E-postalar gönderilmez, dosyaya yazılır (depo e-postası işçinin PDF üretmesi için gerekli) ----------
# .env'e test ayarı yazılır. Gerçek sunucu işaretli düzende (bugünkü Compose) bu satır YOK SAYILIR (karar 151): uzun ömürlü
# uygulama ve işçi onu kullanmaz; e-posta turunu processed … tur içindeki tek seferlik işçi atar (mail_tour). Satır yalnızca
# 4. bölümdeki ÖNCEKİ Compose dosyasında (işaret yok, işçi root) eskisi gibi geçerlidir.
echo 'MAIL_OUTBOX_DIR=/tmp/outbox' | sudo tee -a "$ENV_FILE" >/dev/null
compose up -d
site_up
worker_is_nonroot
# İşaret kapsayıcılarda sabit; .env'deki test ayarı işçinin açılış günlüğünde "yok sayıldı" olarak görünür (değeri yazılmaz)
[ "$(sudo docker exec "$(worker)" printenv TAKIP_DEPLOYMENT)" = server ]
[ "$(sudo docker exec takip-app-1 printenv TAKIP_DEPLOYMENT)" = server ]
[ "$(sudo docker exec "$(worker)" printenv MAIL_OUTBOX_DIR)" = /tmp/outbox ]
for _ in $(seq 1 20); do
  compose logs --no-log-prefix worker >"$T/isci-acilis.log" 2>&1
  if grep -q 'işçi başladı' "$T/isci-acilis.log"; then break; fi
  sleep 3
done
grep -q 'MAIL_OUTBOX_DIR: gerçek sunucuda yok sayıldı' "$T/isci-acilis.log"
if grep -q '/tmp/outbox' "$T/isci-acilis.log"; then echo "işçi günlüğünde ayarın değeri var"; exit 1; fi
# Tek seferlik işçi de aynı servis tanımıyla başlar: 1001:1001, tüm yetenekler bırakılmış, yeni ayrıcalık edinemez
compose run --rm --no-deps -T -e TAKIP_DEPLOYMENT= worker sh -c 'id -u; id -g; cat /proc/self/status' | tr -d '\r' >"$T/tek-seferlik.txt"
[ "$(head -n 2 "$T/tek-seferlik.txt" | paste -sd: -)" = "$OWNER" ]
awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { n++; if ($2 !~ /^0+$/) bad = 1 } /^NoNewPrivs:/ { nnp = $2 } END { exit (bad || n != 5 || nnp != 1) }' "$T/tek-seferlik.txt"

# ---------- 3. İşçi 1001 ile: tarama, karantina, depo PDF'i, ay klasörü ----------
sudo find "$VOL" -mindepth 1 -type d -printf '%P\n' | sort >"$T/dirs.once"
if grep -qx -e "$MONTH" -e '.karantina' "$T/dirs.once"; then echo "ay klasörü / karantina zaten var: işçinin oluşturduğu kanıtlanamaz"; exit 1; fi
fixtures a
processed a tur
files_intact a
depo=$(cat "$T/a.depo")
[ "${depo%/*}" = "$MONTH" ]
# İşçinin OLUŞTURDUĞU her şey 1001:1001: yıl ve ay klasörü, depo PDF'i, karantina klasörü ve içindeki dosya
for p in "${MONTH%/*}" "$MONTH" "$depo" .karantina ".karantina/$(field a virusKey | tr / _)"; do [ "$(owner "$p")" = "$OWNER" ]; done
[ "$(sudo stat -c %a "$VOL/$depo")" = 644 ]
# Uygulama aynı ay klasörüne ve karantinaya yazabiliyor, işçinin dosyasını okuyabiliyor
sudo docker exec takip-app-1 sh -c "echo uygulama > '/data/uploads/$MONTH/uygulama-yazdi.txt' && head -c 5 '/data/uploads/$depo' | grep -q '%PDF-' && : > /data/uploads/.karantina/uygulama-yazdi"
[ "$(owner "$MONTH/uygulama-yazdi.txt")" = "$OWNER" ]
# Depo e-postası gerçek adrese gitmedi: dosyaya yazıldı (tek seferlik işçi → $T/outbox), alıcı deneme adresi, eki işçinin
# ürettiği PDF; uzun ömürlü (gerçek sunucu işaretli) işçinin kapsayıcısında e-posta klasörü hiç oluşmadı
sudo sh -c "cat '$T'/outbox/*.json" | cat >"$T/posta.json"
sudo docker exec "$(worker)" sh -c 'test ! -e /tmp/outbox'
grep -q 'depo@kurulum.test' "$T/posta.json"
grep -q 'Comanda-Depozit-ISCP' "$T/posta.json"
if grep -q 'partnertrans\|enis@gkh' "$T/posta.json"; then echo "gerçek depo adresi kullanıldı"; exit 1; fi
all_owned
worker_ticks
worker_is_nonroot
no_permission_errors

# ---------- 4. Önceki sürüm (işçi root): geri dönüş uyumu + sunucudaki başlangıç durumu ----------
# Bu değişiklikten önceki docker-compose.yml (git geçmişinden) ile "up --remove-orphans": takip.sh'in geri dönüşte yaptığı
intro=$(git log --format=%H --reverse -S'uploads-init:' -- deploy/docker-compose.yml | head -n 1)
git show "$intro^:deploy/docker-compose.yml" >"$T/onceki-compose.yml"
if grep -q 'uploads-init\|user:' "$T/onceki-compose.yml"; then echo "önceki compose dosyası beklenen gibi değil"; exit 1; fi
sudo docker compose -p takip --env-file "$ENV_FILE" --project-directory /opt/takip/src/deploy -f "$T/onceki-compose.yml" up -d --remove-orphans
# Eski düzen: sahiplik servisi yok (artık tanımlı olmadığı için kaldırıldı), işçi root; site açık
[ -z "$(compose ps -a -q uploads-init)" ]
[ "$(sudo docker exec "$(worker)" id -u)" = 0 ]
site_up
# Root işçi, 1001'e ait dosyalarla sorunsuz çalışır (geri dönüş güvenli) ve yazdıkları root'a ait olur (sunucudaki durum)
fixtures b
processed b
files_intact b
depo_b=$(cat "$T/b.depo")
[ "$(owner "$depo_b")" = 0:0 ]
# Eski sürümlerden kalabilecek her tür kayıt: root'a ait birim kökü, yıl / ay klasörü, karantina klasörü ve dosyası,
# root'un açtığı eski bir ay klasörü ve dosyaları (farklı izinlerle), yalnızca grubu farklı dosya, sembolik bağlantı
sudo mkdir -p "$VOL/2024/12/ic"
echo eski-pdf | sudo tee "$VOL/2024/12/eski.pdf" >/dev/null
echo gizli | sudo tee "$VOL/2024/12/ic/gizli.pdf" >/dev/null
sudo chmod 600 "$VOL/2024/12/ic/gizli.pdf"
sudo chmod 700 "$VOL/2024/12/ic"
echo karantina | sudo tee "$VOL/.karantina/eski_virus" >/dev/null
echo grup | sudo tee "$VOL/2025/01/yalniz-grup.pdf" >/dev/null
sudo ln -s /etc/passwd "$VOL/2024/12/baglanti"
sudo chown -h 0:0 "$VOL" "$VOL/${MONTH%/*}" "$VOL/$MONTH" "$VOL/.karantina" "$VOL/2024" "$VOL/2024/12" "$VOL/2024/12/ic" "$VOL/2024/12/eski.pdf" "$VOL/2024/12/ic/gizli.pdf" "$VOL/.karantina/eski_virus" "$VOL/2024/12/baglanti"
sudo chown 1001:0 "$VOL/2025/01/yalniz-grup.pdf"
foreign >"$T/yabanci.txt"
n=$(wc -l <"$T/yabanci.txt")
[ "$n" -ge 12 ]
grep -q '^0:0 f 644 .*\.pdf$' "$T/yabanci.txt"
# Geçişten önceki döküm: tür, izin, boyut, değişiklik zamanı, bağlantı hedefi ve dosya içerikleri (özet)
manifest() { sudo find "$VOL" -mindepth 1 -printf '%P|%y|%m|%s|%T@|%l\n' | sort >"$T/$1.kayit"; sudo find "$VOL" -type f -print0 | sort -z | sudo xargs -0 sha256sum | sort -k2 >"$T/$1.ozet"; }
manifest once

# ---------- 5. Gerçek yayın (takip guncelle): sahiplik işçi başlamadan düzeltilir ----------
echo "// işçi testi $(date +%s)" >>app/surum/route.ts
git commit -qam "işçi testi: root işçiden geçiş"
new=$(git rev-parse HEAD)
sudo env TAKIP_SKIP_CI_GATE=1 takip guncelle
curl -fsSk "$SITE/surum" | jq -e --arg b "${new::7}" '.build == $b'
worker_is_nonroot
# Sahiplik servisi yabancı kayıtların TAMAMINI düzeltti (kendi sayımı = önceden sayılan), uyarı yok
init=$(compose ps -a -q uploads-init | head -n 1)
[ "$(sudo docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$init")" = "exited 0" ]
compose logs --no-log-prefix uploads-init | tee "$T/init.log"
[ "$(head -n 1 "$T/init.log")" = "yükleme birimi: sahipliği 1001:1001 yapılan kayıt: $n" ]
if grep -q UYARI "$T/init.log"; then echo "sahiplik servisi uyarı verdi"; exit 1; fi
all_owned
# Yalnızca sahiplik değişti: hiçbir kayıt silinmedi / eklenmedi / taşınmadı / yeniden adlandırılmadı; tür, izin, boyut,
# değişiklik zamanı, bağlantı hedefi ve içerik birebir aynı; bağlantının hedefine (birimin dışı) dokunulmadı
manifest sonra
diff "$T/once.kayit" "$T/sonra.kayit"
diff "$T/once.ozet" "$T/sonra.ozet"
[ "$(sudo readlink "$VOL/2024/12/baglanti")" = /etc/passwd ]
[ "$(owner 2024/12/baglanti)" = "$OWNER" ]
# Sahiplik servisi kendi dosya sisteminde hiçbir şeyi değiştirmedi: bağlantının hedefi (/etc/passwd) izlenmedi (chown -h),
# birimin dışında hiçbir dosyaya dokunulmadı
sudo docker diff "$init" | tee "$T/init.diff"
if grep -q . "$T/init.diff"; then echo "sahiplik servisi birimin dışında bir şey değiştirdi"; exit 1; fi
db_files_present 4
[ "$(sudo stat -c '%u:%g %a' "$VOL/2024/12/ic/gizli.pdf")" = "$OWNER 600" ]
# Veritabanı kayıtları ve adresler aynı: uygulama eski root dosyasını (depo PDF'i) aynı anahtarla okuyabiliyor
[ "$(sql "select \"storageKey\" from \"OrderFile\" where \"orderId\" = '$(field b profileId)' and source = 'WAREHOUSE_FORM'")" = "$depo_b" ]
sudo docker exec takip-app-1 sh -c "head -c 5 '/data/uploads/$depo_b' | grep -q '%PDF-'"
{ echo "geçişten önce 1001:1001 olmayan kayıt: $n (root işçinin yazdığı depo PDF'i dahil)"; cat "$T/yabanci.txt"; echo "---"; cat "$T/init.log"; echo "geçişten sonra 1001:1001 olmayan kayıt: 0 · kayıt dökümü ve içerik özetleri birebir aynı ($(wc -l <"$T/sonra.kayit") kayıt, $(wc -l <"$T/sonra.ozet") dosya)"; } | note "İşçi root değil — sahiplik geçişi (gerçek yayın)"

# ---------- 6. Geçişten sonra çalışma root'a bağlı değil ----------
# Eskiden root'a ait olan ay klasörüne depo PDF'i, eskiden root'a ait olan karantinaya virüs: işçi 1001 ile yazar
fixtures c
processed c tur
files_intact c
depo_c=$(cat "$T/c.depo")
[ "${depo_c%/*}" = "$MONTH" ]
for p in "$depo_c" ".karantina/$(field c virusKey | tr / _)"; do [ "$(owner "$p")" = "$OWNER" ]; done
sudo docker exec takip-app-1 sh -c "echo uygulama > '/data/uploads/$MONTH/uygulama-yazdi-2.txt' && echo uygulama > /data/uploads/2024/12/uygulama-yazdi.txt"
all_owned
db_files_present 6
worker_ticks
worker_is_nonroot
no_permission_errors
sudo takip antivirus

# ---------- 7. Yinelenebilir: düzeltilecek kayıt yokken hiçbir şeye dokunulmaz, işçi yeniden kurulmaz ----------
sudo find "$VOL" -printf '%C@ %P\n' | sort -k2 >"$T/c.once"
compose run --rm --no-deps -T uploads-init | tee "$T/init2.log"
grep -qx 'yükleme birimi: sahipliği 1001:1001 yapılan kayıt: 0' "$T/init2.log"
wid=$(worker)
compose up -d
compose up -d
[ "$(worker)" = "$wid" ]
sudo find "$VOL" -printf '%C@ %P\n' | sort -k2 >"$T/c.sonra"
diff "$T/c.once" "$T/c.sonra"
all_owned
worker_is_nonroot

# ---------- 8. Temizlik: geçici e-posta ayarı kaldırılır (deneme siparişleri ve dosyaları kalır; sonraki yedek adımları kullanır) ----------
sudo sed -i '/^MAIL_OUTBOX_DIR=/d' "$ENV_FILE"
compose up -d
site_up
worker_is_nonroot
worker_ticks
all_owned
others_unchanged
sudo takip durum | tee "$T/durum.txt"
grep -q 'İşçi     : kullanıcı 1001:1001 (root değil)' "$T/durum.txt"
grep -q 'Dosyalar : tüm kayıtların sahibi 1001:1001' "$T/durum.txt"
set +x
{
  echo "işçi: kullanıcı $(sudo docker inspect -f '{{.Config.User}}' "$(worker)"), yeniden başlatma $(sudo docker inspect -f '{{.RestartCount}}' "$(worker)"), süreçler:"
  hardening
  echo "diğer kapsayıcılar (app, db, caddy, clamav, uploads-init): Privileged=false, CapAdd / CapDrop / SecurityOpt boş (değişmedi)"
  sudo docker top "$(worker)" -eo pid,uid,gid,args | cut -c1-80
  echo "tools (migration / yönetim): uid 0 · uygulama: uid 1001 · uploads-init: 0:0, ağ yok, yalnızca yükleme birimi"
  echo "temiz dosya CLEAN, EICAR INFECTED + karantinada (içerik aynı), depo PDF'i üretildi — 3 kez (1001 işçi, root işçi, geçişten sonra 1001 işçi)"
  echo "birimde $(sudo find "$VOL" -mindepth 1 | wc -l) kayıt, 1001:1001 olmayan: $(foreign | wc -l)"
} | note "İşçi root değil — sonuç"
echo "✔ işçi root değil: tüm denetimler geçti"
