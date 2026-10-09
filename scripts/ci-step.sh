#!/usr/bin/env bash
# Kullanım: scripts/ci-step.sh "Adım adı" komut [argümanlar...]
# Komutu çalıştırır; başarısız olursa çıktının son 80 satırını tek bir ::error:: notu olarak yayınlar
# (GitHub check-run annotation'ı olarak API'den okunabilir).
# Çıktıda test toplamları varsa (node --test: "# tests / pass / fail / skipped"; Playwright: "N passed / skipped / failed")
# bunlar adım başarılı olsa da ::notice:: notu olarak yayınlanır: yeşil çalışmanın kesin test sayıları API'den okunabilir.
set -uo pipefail
name="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
summary="$(sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' "$log" \
  | grep -E '^(#|ℹ) (tests|pass|fail|cancelled|skipped) [0-9]+ *$|^ +[0-9]+ (passed|failed|skipped|flaky|interrupted|did not run)' \
  | sed -e 's/^[# ℹ]*//' -e 's/ *$//' | paste -sd ';' - | sed 's/;/; /g' | cut -c1-400)"
if [ -n "$summary" ]; then echo "::notice title=${name} — test sonucu (exit ${status})::${summary}"; fi
if [ "$status" -ne 0 ]; then
  tail -n 80 "$log" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' > "$log.tail"
  msg="$(python3 -c 'import sys,urllib.parse; t=open(sys.argv[1],encoding="utf-8",errors="replace").read(); print(t.replace("%","%25").replace("\r","").replace("\n","%0A"))' "$log.tail")"
  echo "::error title=${name} (exit ${status})::${msg}"
  # node --test (TAP) çıktısında başarısız testler sonda olmayabilir: "not ok" blokları ayrı bir notta yayınlanır
  fails="$(python3 - "$log" <<'PY'
import re, sys
out, take = [], 0
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', line.rstrip('\n'))
    if line.startswith('not ok'):
        take = 45
    elif re.match(r'(ok |# Subtest)', line):
        take = 0
    if take > 0:
        out.append(line)
        take -= 1
text = '\n'.join(out)[:6000]
print(text.replace('%', '%25').replace('\r', '').replace('\n', '%0A'))
PY
)"
  [ -n "$fails" ] && echo "::error title=${name} — başarısız testler::${fails}"
  # Ayrıntılı not 6000 karakterde kesilir: başarısız testlerin TAMAMININ kısa listesi (başlık + ilk test dosyası satırı) ayrı notta
  index="$(python3 - "$log" <<'PY'
import re, sys
out, want = [], False
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', line.rstrip('\n'))
    if line.startswith('not ok'):
        out.append(line[:240]); want = True
    elif want and re.search(r'(?:test|e2e)/[\w./-]+\.(?:test|spec)\.(?:js|ts):\d+', line):
        out.append('    ' + re.search(r'(?:test|e2e)/[\w./-]+\.(?:test|spec)\.(?:js|ts):\d+(?::\d+)?', line).group(0)); want = False
    elif re.match(r'(ok |# Subtest)', line):
        want = False
text = '\n'.join(out)[:6000]
print(text.replace('%', '%25').replace('\r', '').replace('\n', '%0A'))
PY
)"
  [ -n "$index" ] && echo "::error title=${name} — başarısız test listesi::${index}"
fi
exit "$status"
