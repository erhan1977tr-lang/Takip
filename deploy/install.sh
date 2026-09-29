#!/usr/bin/env bash
# Takip — sunucu kurulumu. Ubuntu 22.04 / 24.04 ya da Debian 12 çalışan bir sunucuda root olarak BİR KEZ çalıştırılır:
#
#   curl -fsSL https://raw.githubusercontent.com/erhan1977tr-lang/Takip/backend/deploy/install.sh | bash
#
# Yaptıkları: sistem güncellemeleri ve güvenlik (güvenlik duvarı, fail2ban, otomatik güvenlik yamaları), Docker,
# uygulamanın indirilmesi, gizli anahtarların BU SUNUCUDA üretilmesi (/opt/takip/.env), HTTPS (Caddy + Let's Encrypt),
# veritabanı, ilk yönetici hesabı, otomatik güncelleme ve gece yedeği.
# Tekrar çalıştırmak güvenlidir: mevcut anahtarlar ve veriler korunur, yalnızca eksikler tamamlanır.
#
# Seçenekler (sorulmasın diye önceden verilebilir):
#   --domain ALAN_ADI        boşsa sunucunun IP'sinden ücretsiz adres: 1-2-3-4.sslip.io
#   --admin-email E-POSTA    ilk yönetici
#   --admin-name "AD SOYAD"
#   --factory "FİRMA"        iç ekibin bağlı olduğu fabrika/şirket adı (varsayılan: GKH Trading)
#   --branch DAL             otomatik güncellemenin izlediği GitHub dalı (varsayılan: backend)
set -Eeuo pipefail

main() {
  local REPO_URL=${TAKIP_REPO_URL:-https://github.com/erhan1977tr-lang/Takip.git}
  local BASE=/opt/takip
  local BRANCH=backend DOMAIN="" ADMIN_EMAIL="" ADMIN_NAME="" FACTORY=""
  while [ $# -gt 0 ]; do
    case $1 in
      --domain) DOMAIN=$2; shift 2 ;;
      --admin-email) ADMIN_EMAIL=$2; shift 2 ;;
      --admin-name) ADMIN_NAME=$2; shift 2 ;;
      --factory) FACTORY=$2; shift 2 ;;
      --branch) BRANCH=$2; shift 2 ;;
      *) die "Bilinmeyen seçenek: $1" ;;
    esac
  done

  [ "$(id -u)" = 0 ] || die "Bu komut root olarak çalıştırılmalı (önce: sudo -i)."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID:$VERSION_ID" in
    ubuntu:22.04 | ubuntu:24.04 | debian:12 | debian:13) ok "İşletim sistemi: $PRETTY_NAME" ;;
    *) die "Desteklenmeyen işletim sistemi: $PRETTY_NAME. Ubuntu 22.04/24.04 ya da Debian 12 gerekli." ;;
  esac

  # ---------- sorular ----------
  if [ -f "$BASE/.env" ]; then
    ok "Önceki kurulum bulundu; anahtarlar ve veriler korunacak."
  fi
  if ! admin_exists_quick "$BASE"; then
    [ -n "$ADMIN_EMAIL" ] || ask ADMIN_EMAIL "İlk yöneticinin e-posta adresi"
    [[ $ADMIN_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "Geçerli bir e-posta adresi gerekli."
    [ -n "$ADMIN_NAME" ] || ask ADMIN_NAME "Yöneticinin adı soyadı"
  fi
  if [ ! -f "$BASE/.env" ]; then
    [ -n "$FACTORY" ] || ask FACTORY "Şirketinizin (fabrika) adı" "GKH Trading"
  fi

  # ---------- 1. sistem ----------
  step "Sistem paketleri güncelleniyor"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
  apt-get update -qq
  if [ "${TAKIP_SKIP_UPGRADE:-0}" != 1 ]; then
    apt-get upgrade -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold >/dev/null
  fi
  apt-get install -y -qq ca-certificates curl git jq ufw fail2ban unattended-upgrades openssl gzip >/dev/null
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
  ok "Otomatik güvenlik güncellemeleri ve fail2ban (SSH saldırılarına karşı) açık"

  if [ "${TAKIP_NO_FIREWALL:-0}" != 1 ]; then
    local sc=${SSH_CONNECTION:-}
    local ssh_port=${sc##* }
    ufw allow "${ssh_port:-22}/tcp" >/dev/null
    ufw allow 22/tcp >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
    ufw --force enable >/dev/null
    ok "Güvenlik duvarı: yalnızca SSH (${ssh_port:-22}), HTTP ve HTTPS açık"
  fi

  local mem_mb; mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  if [ "$mem_mb" -lt 6000 ] && [ -z "$(swapon --show --noheadings)" ] && [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    echo '/swapfile none swap sw 0 0' >>/etc/fstab
    ok "2 GB takas alanı eklendi (bellek: ${mem_mb} MB)"
  fi

  # ---------- 2. docker ----------
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1
  docker compose version >/dev/null 2>&1 || die "docker compose bulunamadı."
  ok "$(docker --version)"

  # ---------- 3. uygulama ----------
  step "Uygulama indiriliyor ($BRANCH dalı)"
  mkdir -p "$BASE/state" "$BASE/logs" "$BASE/backups"
  chmod 700 "$BASE/backups"
  if [ -d "$BASE/src/.git" ]; then
    git -C "$BASE/src" remote set-url origin "$REPO_URL"
    git -C "$BASE/src" fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  else
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$BASE/src"
  fi
  echo "$BRANCH" >"$BASE/state/branch"
  ok "Kaynak: $BASE/src"

  # ---------- 4. ayarlar ve gizli anahtarlar ----------
  step "Ayarlar"
  if [ -z "$DOMAIN" ]; then
    if [ -f "$BASE/.env" ]; then DOMAIN=$(grep -E '^APP_DOMAIN=' "$BASE/.env" | cut -d= -f2-); fi
    [ -n "$DOMAIN" ] || DOMAIN="$(public_ip | tr . -).sslip.io"
  fi
  if [ ! -f "$BASE/.env" ]; then
    umask 077
    cat >"$BASE/.env" <<EOF
# Takip sunucu ayarları — yalnızca bu sunucuda durur. Kimseyle paylaşmayın, sohbete/e-postaya yapıştırmayın.
# Değiştirdikten sonra: cd $BASE/src/deploy && docker compose up -d   (ya da: takip smtp)
APP_DOMAIN=$DOMAIN
APP_URL=https://$DOMAIN
AUTH_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
INVITE_CODE_TTL_HOURS=24
APP_TIMEZONE=Europe/Bucharest
FACTORY_NAME=${FACTORY:-GKH Trading}
APP_IMAGE=takip
APP_TAG=
# E-posta (davet kodları): "takip smtp" komutuyla doldurulur.
EOF
    umask 022
    ok "Gizli anahtarlar bu sunucuda üretildi: $BASE/.env"
  else
    set_env "$BASE/.env" APP_DOMAIN "$DOMAIN"
    set_env "$BASE/.env" APP_URL "https://$DOMAIN"
  fi
  chmod 600 "$BASE/.env"
  ln -sfn "$BASE/.env" "$BASE/src/deploy/.env"
  ok "Adres: https://$DOMAIN"

  chmod +x "$BASE/src/deploy/takip.sh"
  ln -sfn "$BASE/src/deploy/takip.sh" /usr/local/bin/takip
  cp "$BASE/src/deploy/systemd/"takip-*.{service,timer} /etc/systemd/system/
  systemctl daemon-reload

  # ---------- 5. ilk yayın ----------
  step "Uygulama derleniyor ve başlatılıyor (ilk seferde 5–10 dakika sürebilir)"
  if ! takip _ilk </dev/null; then
    die "Uygulama başlatılamadı. Ayrıntı: $BASE/logs/ (son satırlar: tail -50 $BASE/logs/derleme-*.log)"
  fi

  step "HTTPS sertifikası bekleniyor"
  local curl_k=""; [ "$DOMAIN" = localhost ] && curl_k="-k"
  local ready=0
  for _ in $(seq 1 36); do
    if curl -fsS $curl_k --max-time 10 -o /dev/null "https://$DOMAIN/login"; then ready=1; break; fi
    sleep 5
  done
  if [ "$ready" = 1 ]; then ok "https://$DOMAIN açılıyor"; else warn "HTTPS henüz hazır değil (sertifika birkaç dakika sürebilir). Sonra deneyin: takip durum"; fi

  # ---------- 6. yönetici ----------
  local code=""
  if admin_exists "$BASE"; then
    ok "Yönetici hesabı zaten var (unutulursa: takip yonetici E-POSTA \"AD\" --reset)"
  else
    step "İlk yönetici hesabı"
    local out
    out=$(takip yonetici "$ADMIN_EMAIL" "$ADMIN_NAME" </dev/null 2>&1) || { echo "$out"; die "Yönetici hesabı açılamadı."; }
    code=$(sed -n 's/^CODE=\([0-9]\{6\}\)$/\1/p' <<<"$out" | tail -1)
    ok "Yönetici: $ADMIN_EMAIL"
  fi

  # ---------- 7. otomatik güncelleme ve yedek ----------
  systemctl enable --now takip-deploy.timer takip-backup.timer >/dev/null 2>&1
  ok "Otomatik güncelleme (2 dakikada bir kontrol) ve gece yedeği açık"

  printf '\n\033[1;32m══════════════════════ Kurulum tamamlandı ══════════════════════\033[0m\n'
  echo "  Adres        : https://$DOMAIN"
  if [ -n "$code" ]; then
    echo "  Yönetici     : $ADMIN_EMAIL"
    printf '  Tek kullanımlık kod: \033[1m%s\033[0m   (24 saat geçerli)\n' "$code"
    echo
    echo "  İlk giriş: adresi açın → e-postanızı yazın → şifre alanını BOŞ bırakıp Giriş'e basın →"
    echo "             bu kodu girin → kendi şifrenizi belirleyin."
  fi
  echo
  echo "  Faydalı komutlar (bu sunucuda):"
  echo "    takip durum     yayındaki sürüm ve son güncellemeler"
  echo "    takip smtp      e-posta ayarları (kullanıcılara davet kodu gidebilmesi için gerekli)"
  echo "    takip yedek     hemen yedek al (her gece kendiliğinden alınır)"
  echo "    takip log       uygulama günlüğü"
  echo
  echo "  GitHub'daki '$BRANCH' dalına gelen ve testlerden geçen her sürüm birkaç dakika içinde otomatik yayınlanır."
  echo
}

# ---------- yardımcılar ----------
step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() {
  printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2
  exit 1
}
trap 'die "Kurulum bir hatayla durdu (satır $LINENO). Ekrandaki son satırları Claude ile paylaşın; komutu yeniden çalıştırmak güvenlidir."' ERR

ask() { # ask DEĞİŞKEN "soru" [varsayılan]
  local __v=""
  if ! { exec 3</dev/tty; } 2>/dev/null; then die "$2 gerekli (etkileşimsiz çalıştırmada --admin-email gibi seçeneklerle verin)."; fi
  read -rp "$2${3:+ [$3]}: " __v <&3 || true
  exec 3<&-
  printf -v "$1" '%s' "${__v:-${3:-}}"
}

set_env() { # set_env DOSYA ANAHTAR DEĞER
  local tmp; tmp=$(mktemp "$1.XXXX")
  K="$2" V="$3" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; d = 0 }
    index($0, k "=") == 1 { if (!d) { print k "=" v; d = 1 }; next } { print } END { if (!d) print k "=" v }' "$1" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$1"
}

public_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')
  if [ -z "$ip" ] || [[ $ip =~ ^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
    ip=$(curl -4 -fsS --max-time 10 https://api.ipify.org)
  fi
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Sunucunun genel IP adresi bulunamadı; --domain ile bir adres verin."
  echo "$ip"
}

admin_count() { # veritabanı çalışıyorsa yönetici sayısı, değilse boş
  local base=$1
  [ -f "$base/.env" ] && command -v docker >/dev/null 2>&1 || return 0
  docker compose -p takip --env-file "$base/.env" -f "$base/src/deploy/docker-compose.yml" exec -T db \
    psql -U takip -d takip -tAc "SELECT count(*) FROM \"User\" WHERE \"appRole\" = 'ADMIN'" </dev/null 2>/dev/null || true
}
admin_exists() { [ "$(admin_count "$1" | tr -d '[:space:]')" -gt 0 ] 2>/dev/null; }
admin_exists_quick() { [ -f "$1/.env" ] && admin_exists "$1"; }

# Betik "curl | bash" ile çalışırken tamamı okunmadan komutlar stdin'i tüketmesin diye her şey main içinde.
main "$@"
