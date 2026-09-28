#!/usr/bin/env bash
# Demo ortamını başlatır / günceller — her açılışta çalışır, elle de çalıştırılabilir:  npm run demo
#  1. (Codespaces'te) son sürümü çeker
#  2. veritabanını günceller ve ilk seferde örnek verileri yükler
#  3. kod değiştiyse yeniden derler
#  4. uygulamayı 3000 portunda arka planda (yeniden) başlatır
# Hazırlık sırasında 3000 portunda durum sayfası (status-server.mjs) çalışır; hata olursa orada görünür.
set -uo pipefail
cd "$(dirname "$0")/../.."
LOG=/tmp/takip.log
STEPLOG=/tmp/takip-steplog.txt

step() { echo "▶ $1"; echo "$1" > /tmp/takip-step.txt; }
status_page() {
  pkill -f "scripts/demo/status-server.mjs" 2>/dev/null
  pkill -f ".next/standalone/server.js" 2>/dev/null
  sleep 1
  setsid nohup node scripts/demo/status-server.mjs > /dev/null 2>&1 < /dev/null &
}
fail() {
  { echo "$1"; echo; tail -60 "${2:-$STEPLOG}" 2>/dev/null; } > /tmp/takip-error.txt
  echo ""; echo "✘ $1"; tail -30 "${2:-$STEPLOG}" 2>/dev/null
  echo "Ayrıntı tarayıcıdaki sayfada da görünür. Tekrar denemek için: npm run demo"
  exit 1
}
# run "adım" komut… — çıktıyı hem terminale hem adım günlüğüne yazar; hata olursa durdurur
run() {
  local name="$1"; shift
  step "$name"
  "$@" 2>&1 | tee "$STEPLOG"
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail "$name başarısız oldu."
}

rm -f /tmp/takip-error.txt
if ! node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
  status_page
fi

if [ ! -f .env ]; then bash scripts/demo/setup.sh || fail "Kurulum başarısız oldu." /tmp/takip-npm.log; fi

if [ "${CODESPACES:-}" = "true" ] && git diff --quiet && git diff --cached --quiet; then
  step "Son sürüm çekiliyor…"
  git pull --ff-only -q || echo "  (güncelleme çekilemedi, mevcut sürümle devam ediliyor)"
fi
if ! sha256sum -c --status node_modules/.demo-lock 2>/dev/null; then
  run "Paketler güncelleniyor…" npm ci --no-audit --no-fund
  sha256sum package-lock.json > node_modules/.demo-lock
fi

set -a; . ./.env; set +a
if [ -n "${CODESPACE_NAME:-}" ]; then
  export APP_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  export APP_URL="${APP_URL:-http://localhost:3000}"
fi

step "Veritabanı hazırlanıyor…"
for i in $(seq 1 30); do
  if npx prisma migrate deploy > "$STEPLOG" 2>&1; then break; fi
  [ "$i" = 30 ] && fail "Veritabanı hazırlanamadı."
  sleep 2
done
run "Veritabanı istemcisi üretiliyor…" npx prisma generate
run "Örnek veriler yükleniyor…" node scripts/demo/seed.mjs

rev=$(git rev-parse HEAD 2>/dev/null || echo yok)
if [ "$(cat .next/.demo-build 2>/dev/null)" != "$rev" ] || [ ! -f .next/standalone/server.js ]; then
  step "Uygulama derleniyor (1-3 dakika)…"
  npm run build > "$STEPLOG" 2>&1 || fail "Derleme başarısız oldu."
  rm -rf .next/standalone/.next/static
  cp -r .next/static .next/standalone/.next/static
  echo "$rev" > .next/.demo-build
fi

step "Uygulama başlatılıyor…"
pkill -f "scripts/demo/status-server.mjs" 2>/dev/null
pkill -f ".next/standalone/server.js" 2>/dev/null
sleep 1
PORT=3000 HOSTNAME=0.0.0.0 setsid nohup node .next/standalone/server.js > "$LOG" 2>&1 < /dev/null &

for i in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    echo ""
    echo "✔ Takip çalışıyor: ${APP_URL}"
    echo "  Giriş bilgileri: DEMO-GIRIS.txt"
    echo ""
    cat DEMO-GIRIS.txt 2>/dev/null || true
    exit 0
  fi
  sleep 1
done
status_page
fail "Uygulama açılamadı." "$LOG"
