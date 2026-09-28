#!/usr/bin/env bash
# Kullanım: scripts/ci-step.sh "Adım adı" komut [argümanlar...]
# Komutu çalıştırır; başarısız olursa çıktının son 80 satırını tek bir ::error:: notu olarak yayınlar
# (GitHub check-run annotation'ı olarak API'den okunabilir).
set -uo pipefail
name="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  tail -n 80 "$log" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' > "$log.tail"
  msg="$(python3 -c 'import sys,urllib.parse; t=open(sys.argv[1],encoding="utf-8",errors="replace").read(); print(t.replace("%","%25").replace("\r","").replace("\n","%0A"))' "$log.tail")"
  echo "::error title=${name} (exit ${status})::${msg}"
fi
exit "$status"
