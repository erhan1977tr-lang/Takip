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
port_busy() { node -e "require('net').connect(3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; }
# 3000 portundaki her şeyi durdurur. Next sunucusu süreç adını "next-server (vX)" olarak değiştirdiği için iki adla aranır.
stop_port() {
  pkill -f "scripts/demo/status-server.mjs" 2>/dev/null
  pkill -f ".next/standalone/server.js" 2>/dev/null
  pkill -f "next-server" 2>/dev/null
  for _ in $(seq 1 20); do port_busy || return 0; sleep 0.5; done
  pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f ".next/standalone/server.js" 2>/dev/null; sleep 1
}
status_page() {
  stop_port
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

if [ "${CODESPACES:-}" = "true" ]; then
  # Derleme next-env.d.ts'yi değiştirir; güncellemeyi engellemesin. Başka yerel değişiklik çakışırsa git pull güvenle vazgeçer.
  git checkout -- next-env.d.ts 2>/dev/null || true
  step "Son sürüm çekiliyor…"
  before=$(git rev-parse HEAD)
  git pull --ff-only -q || echo "  (güncelleme çekilemedi, mevcut sürümle devam ediliyor)"
  # Betiğin kendisi de güncellenmiş olabilir: yeni sürümüyle baştan çalıştır
  if [ "$(git rev-parse HEAD)" != "$before" ] && [ -z "${DEMO_REEXEC:-}" ]; then
    exec env DEMO_REEXEC=1 bash scripts/demo/start.sh
  fi
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
# Rol yetkileri her açılışta temel veriden yeniden yazılır; 3.2.x'ten kalan eski yetki satırları
# 3.3.0'daki yetki listesi değişikliğini (migration) bozmasın diye önce silinir.
npx prisma db execute --stdin --schema prisma/schema.prisma >/dev/null 2>&1 <<'SQL' || true
DO $$ BEGIN
  IF to_regclass('"RolePermission"') IS NOT NULL THEN DELETE FROM "RolePermission"; END IF;
END $$;
SQL
for i in $(seq 1 30); do
  if npx prisma migrate deploy > "$STEPLOG" 2>&1; then break; fi
  [ "$i" = 30 ] && fail "Veritabanı hazırlanamadı."
  sleep 2
done
run "Veritabanı istemcisi üretiliyor…" npx prisma generate
run "Örnek veriler yükleniyor…" node scripts/demo/seed.mjs

rev=$(git rev-parse HEAD 2>/dev/null || echo yok)
if [ "$(cat .next/.demo-build 2>/dev/null)" != "$rev" ] || [ ! -f .next/standalone/server.js ]; then
  # Derleme .next klasörünü baştan yazar; eski sunucu çalışmaya devam ederse sayfalar bozulur
  # ("Application error"). Bu yüzden derleme boyunca adreste durum sayfası gösterilir.
  status_page
  step "Uygulama güncelleniyor, derleniyor (1-3 dakika)…"
  npm run build > "$STEPLOG" 2>&1 || fail "Derleme başarısız oldu."
  rm -rf .next/standalone/.next/static
  cp -r .next/static .next/standalone/.next/static
  echo "$rev" > .next/.demo-build
fi

step "Uygulama başlatılıyor…"
stop_port
# IPv6 varsa "::" (hem IPv4 hem IPv6 bağlantılarını kabul eder), yoksa 0.0.0.0
HOST=$(node -e "const s=require('net').createServer();s.on('error',()=>{console.log('0.0.0.0')});s.listen(0,'::',()=>{console.log('::');s.close()})")
PORT=3000 HOSTNAME="$HOST" setsid nohup node .next/standalone/server.js > "$LOG" 2>&1 < /dev/null &
APP_PID=$!
echo "$APP_PID" > /tmp/takip.pid

for i in $(seq 1 60); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then status_page; fail "Uygulama açılamadı." "$LOG"; fi
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
