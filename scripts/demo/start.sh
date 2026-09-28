#!/usr/bin/env bash
# Demo ortamını başlatır / günceller — her açılışta çalışır, elle de çalıştırılabilir:  npm run demo
#  1. (Codespaces'te) son sürümü çeker
#  2. veritabanını günceller ve ilk seferde örnek verileri yükler
#  3. kod değiştiyse yeniden derler
#  4. uygulamayı 3000 portunda arka planda (yeniden) başlatır
set -euo pipefail
cd "$(dirname "$0")/../.."
LOG=/tmp/takip.log

if [ ! -f .env ]; then bash scripts/demo/setup.sh; fi

if [ "${CODESPACES:-}" = "true" ] && git diff --quiet && git diff --cached --quiet; then
  echo "▶ Son sürüm çekiliyor…"
  git pull --ff-only -q || echo "  (güncelleme çekilemedi, mevcut sürümle devam ediliyor)"
fi
if ! sha256sum -c --status node_modules/.demo-lock 2>/dev/null; then
  echo "▶ Paketler güncelleniyor…"
  npm ci --no-audit --no-fund
  sha256sum package-lock.json > node_modules/.demo-lock
fi

set -a; . ./.env; set +a
if [ -n "${CODESPACE_NAME:-}" ]; then
  export APP_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  export APP_URL="${APP_URL:-http://localhost:3000}"
fi

echo "▶ Veritabanı hazırlanıyor…"
for i in $(seq 1 30); do
  if npx prisma migrate deploy > /tmp/takip-migrate.log 2>&1; then break; fi
  if [ "$i" = 30 ]; then cat /tmp/takip-migrate.log; exit 1; fi
  sleep 2
done
node scripts/demo/seed.mjs

rev=$(git rev-parse HEAD 2>/dev/null || echo yok)
if [ "$(cat .next/.demo-build 2>/dev/null)" != "$rev" ] || [ ! -f .next/standalone/server.js ]; then
  echo "▶ Uygulama derleniyor (1-3 dakika)…"
  npm run build > /tmp/takip-build.log 2>&1 || { tail -50 /tmp/takip-build.log; exit 1; }
  rm -rf .next/standalone/.next/static
  cp -r .next/static .next/standalone/.next/static
  echo "$rev" > .next/.demo-build
fi

pkill -f ".next/standalone/server.js" 2>/dev/null || true
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
echo "Uygulama açılamadı. Günlük:"; tail -50 "$LOG"; exit 1
