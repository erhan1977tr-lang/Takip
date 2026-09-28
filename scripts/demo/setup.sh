#!/usr/bin/env bash
# Demo ortamı (Codespaces / devcontainer) ilk kurulumu — konteyner oluşturulunca bir kez çalışır.
# Bu ortama özel .env dosyasını yazar ve paketleri kurar. Üretim sunucusunda KULLANILMAZ.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Kurulum sürerken adreste 502 yerine "hazırlanıyor" sayfası görünsün
rm -f /tmp/takip-error.txt
echo "Paketler kuruluyor (ilk açılışta birkaç dakika sürer)…" > /tmp/takip-step.txt
if ! node -e "fetch('http://127.0.0.1:3000/').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
  setsid nohup node scripts/demo/status-server.mjs > /dev/null 2>&1 < /dev/null &
fi

if [ ! -f .env ]; then
  secret=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  cat > .env <<ENV
# Demo ortamı — scripts/demo/setup.sh tarafından üretildi (git'e yüklenmez)
DATABASE_URL=postgresql://takip:takip@localhost:5432/takip?schema=public
AUTH_SECRET=${secret}
MAIL_OUTBOX_DIR=${PWD}/.outbox
UPLOAD_DIR=${PWD}/.uploads
DEMO_MODE=1
NEXT_TELEMETRY_DISABLED=1
ENV
  echo ".env oluşturuldu."
fi

if ! npm ci --no-audit --no-fund 2>&1 | tee /tmp/takip-npm.log; then
  tail -40 /tmp/takip-npm.log > /tmp/takip-error.txt
  exit 1
fi
sha256sum package-lock.json > node_modules/.demo-lock
