#!/usr/bin/env bash
# Demo ortamı (Codespaces / devcontainer) ilk kurulumu — konteyner oluşturulunca bir kez çalışır.
# Bu ortama özel .env dosyasını yazar ve paketleri kurar. Üretim sunucusunda KULLANILMAZ.
set -euo pipefail
cd "$(dirname "$0")/../.."

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

npm ci --no-audit --no-fund
sha256sum package-lock.json > node_modules/.demo-lock
