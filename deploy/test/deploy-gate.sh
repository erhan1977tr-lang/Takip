#!/usr/bin/env bash
# Yayın kapısı (deploy/takip.sh, karar 276) — mantık testi: SAHTE GitHub API (curl), SAHTE docker, geçici git deposu.
# Gerçek GitHub'a, Docker'a, veritabanına ya da sunucudaki hiçbir dosyaya dokunulmaz: araç geçici bir klasörde (TAKIP_BASE)
# çalışır, "origin" geçici bir çıplak (bare) depodur. "Yayınlandı" ölçütü: do_deploy veritabanı güncellemesine (migration =
# sahte "compose run --rm tools") ulaştı — sahte docker o adımı başarısız döndürür, yani hiçbir şey gerçekten başlatılmaz.
# Kullanım:  bash deploy/test/deploy-gate.sh
set -Eeuo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TAKIP=$HERE/../takip.sh
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
FAKE=$ROOT/bin
export FAKE_STATE=$ROOT/fake TAKIP_BASE=$ROOT/base TAKIP_REPO=gkh/Takip
STATE=$TAKIP_BASE/state
ORIGIN=$ROOT/origin.git
WORK=$ROOT/work
mkdir -p "$FAKE" "$FAKE_STATE" "$TAKIP_BASE/state" "$TAKIP_BASE/logs"
# Kullanıcının / makinenin git ayarlarından yalıtılmış
export GIT_CONFIG_GLOBAL=$ROOT/gitconfig GIT_CONFIG_NOSYSTEM=1
: >"$GIT_CONFIG_GLOBAL"
printf 'APP_TAG=eski\nAPP_DOMAIN=gkh.test\n' >"$TAKIP_BASE/.env"
: >"$FAKE_STATE/runs.jsonl"

# ---------- sahte GitHub API: yalnızca /actions/runs. Dal / olay süzgecini BİLEREK uygulamaz (en kötü durum: API aynı
# commit'in başka dallardaki koşularını da döndürür) → süzgeci aracın kendisi uygulamalı.
cat >"$FAKE/curl" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
url=''
for a in "$@"; do case $a in http*) url=$a ;; esac; done
case $url in
  https://api.github.com/repos/*/actions/runs\?*)
    echo "$url" >>"$S/api-calls"
    if [ -x "$S/on-api" ]; then mv "$S/on-api" "$S/on-api.ran"; "$S/on-api.ran"; fi
    [ -f "$S/api-down" ] && exit 7
    if [ -f "$S/api-500" ]; then printf 'sunucu hatası\n500'; exit 0; fi
    if [ -f "$S/api-garbage" ]; then printf '<html>bozuk\n200'; exit 0; fi
    sha=$(sed -n 's/.*head_sha=\([0-9a-f]*\).*/\1/p' <<<"$url")
    jq -cs --arg s "$sha" '{ workflow_runs: [ .[] | select(.head_sha == $s) ] }' "$S/runs.jsonl"
    printf '200'
    ;;
  *) exit 7 ;; # site denetimi (edge_ok) vb.: ağ yok
esac
SH
# ---------- sahte docker: derleme başarılı (kayıt + isteğe bağlı kanca), migration BAŞARISIZ (hiçbir şey başlamaz)
cat >"$FAKE/docker" <<'SH'
#!/usr/bin/env bash
S=$FAKE_STATE
case "$1 ${2:-}" in
  'build '*)
    echo build >>"$S/docker"
    if [ -x "$S/on-build" ]; then mv "$S/on-build" "$S/on-build.ran"; "$S/on-build.ran"; fi
    exit 0 ;;
  'compose '*)
    case " $* " in
      *' run --rm tools '*) echo migration >>"$S/docker"; exit 1 ;;
      *' ps '*) exit 0 ;;
      # yayın öncesi denetim (karar 287): veritabanı erişilebilir, yarım migration yok, uygulanmış migration listesi boş
      *' exec '*'SELECT 1'*) echo 1; exit 0 ;;
      *' exec '*'count(*)'*) echo 0; exit 0 ;;
      *' exec '*) exit 0 ;;
      *) echo "compose $*" >>"$S/docker"; exit 0 ;;
    esac ;;
  # derlenen imaj onaylanan commit'i taşır (GIT_SHA = etiketteki commit)
  'image inspect') for a in "$@"; do case $a in takip:*) t=${a#takip:}; echo "GIT_SHA=${t%-tools}" ;; esac; done; exit 0 ;;
  *) exit 0 ;;
esac
SH
chmod +x "$FAKE/curl" "$FAKE/docker"
export PATH="$FAKE:$PATH"

# ---------- geçici depo: origin (backend) + sunucu kopyası (SRC)
git init -q --bare "$ORIGIN"
git init -q -b backend "$WORK"
git -C "$WORK" config user.email dev@gkh.test
git -C "$WORK" config user.name dev
commit() { # commit DOSYA [YAZAR_EPOSTA] [KONU] → yeni commit'i backend'e iter, SHA'yı yazar
  mkdir -p "$WORK/$(dirname "$1")"
  date +%s%N >>"$WORK/$1"
  echo '{"version":"9.9.9"}' >"$WORK/package.json"
  git -C "$WORK" add -A
  if [ -n "${2:-}" ]; then git -C "$WORK" -c user.email="$2" commit -qm "${3:-iş}"; else git -C "$WORK" commit -qm "${3:-iş}"; fi
  git -C "$WORK" push -q "$ORIGIN" HEAD:backend
  git -C "$WORK" rev-parse HEAD
}
B0=$(commit app/a.ts)
git clone -q -b backend "$ORIGIN" "$TAKIP_BASE/src"
echo "$B0" >"$STATE/deployed"

CI=.github/workflows/ci.yml INST=.github/workflows/deploy-test.yml
n=0 seq=0
run() { # run SHA DAL YOL DURUM SONUÇ [OLAY] [DEPO]
  seq=$((seq + 1))
  jq -cn --arg s "$1" --arg b "$2" --arg p "$3" --arg st "$4" --arg co "$5" --arg e "${6:-push}" --arg r "${7:-gkh/Takip}" --argjson n "$seq" \
    '{ name: (if ($p | endswith("deploy-test.yml")) then "Sunucu kurulumu" else "CI" end), head_sha: $s, head_branch: $b, path: $p, status: $st, conclusion: (if $co == "" then null else $co end), event: $e,
       run_number: $n, created_at: ("2026-10-14T18:00:" + (($n + 10) | tostring) + "Z"),
       repository: { full_name: $r }, head_repository: { full_name: $r } }' >>"$FAKE_STATE/runs.jsonl"
}
reset() { : >"$FAKE_STATE/runs.jsonl"; rm -f "$FAKE_STATE"/{docker,api-calls,api-down,api-500,api-garbage,on-api,on-build} "$STATE/failed"; : >"$TAKIP_BASE/logs/deploy.log" 2>/dev/null || true; }
tick() { bash "$TAKIP" _otomatik >>"$ROOT/out" 2>&1 || true; }
deployed_attempt() { grep -qx migration "$FAKE_STATE/docker" 2>/dev/null; }
built() { grep -qx build "$FAKE_STATE/docker" 2>/dev/null; }
fail() { echo "✘ $*"; echo "--- deploy.log"; cat "$TAKIP_BASE/logs/deploy.log" 2>/dev/null || true; echo "--- docker"; cat "$FAKE_STATE/docker" 2>/dev/null || true; echo "--- runs"; cat "$FAKE_STATE/runs.jsonl"; exit 1; }
ok() { n=$((n + 1)); echo "✔ $*"; }
blocked() { # blocked AÇIKLAMA [failed] — yayın denemesi YOK; "failed" verilirse commit başarısız işaretlenmeli, yoksa işaretlenmemeli
  if built || deployed_attempt; then fail "$1: yayın denendi"; fi
  [ "$(cat "$STATE/deployed")" = "$B0" ] || fail "$1: yayındaki sürüm değişti"
  if [ "${2:-}" = failed ]; then [ "$(cat "$STATE/failed" 2>/dev/null)" = "$X" ] || fail "$1: başarısız işaretlenmedi"
  else [ ! -e "$STATE/failed" ] || fail "$1: yanlışlıkla başarısız işaretlendi"; fi
  ok "$1 → yayın yok"
}
allowed() { deployed_attempt || fail "$1: yayın yapılmadı"; ok "$1 → yayına geçti (migration adımına ulaştı)"; }

# Uygulama değişikliği (sunucu kurulum testi gerekmez)
X=$(commit app/b.ts)

# 1. OLAY: aynı commit çalışma dalında CI'dan geçmiş, backend'de koşu henüz yok → BEKLE
reset; run "$X" fix/dal "$CI" completed success; run "$X" fix/dal "$INST" completed success
tick; blocked "yarış: yalnızca çalışma dalında başarılı CI"
grep -q "branch=backend" "$FAKE_STATE/api-calls" && grep -q "event=push" "$FAKE_STATE/api-calls" || fail "API sorgusu dal / olay süzmüyor"
ok "API sorgusu head_sha + branch=backend + event=push ile yapılıyor"

# 2. backend CI sürüyor (çalışma dalında başarılı) → BEKLE
reset; run "$X" fix/dal "$CI" completed success; run "$X" backend "$CI" in_progress ""
tick; blocked "backend CI sürüyor"
reset; run "$X" backend "$CI" queued ""; tick; blocked "backend CI sırada"

# 3. backend CI başarısız / iptal / zaman aşımı → YAYIN YOK, commit başarısız işaretlenir (yeni commit gelene dek)
for co in failure cancelled timed_out skipped neutral action_required; do
  reset; run "$X" fix/dal "$CI" completed success; run "$X" backend "$CI" completed "$co"
  tick; blocked "backend CI: $co" failed
done

# 4. API okunamıyor → BEKLE (başarı sayılmaz)
for m in api-down api-500 api-garbage; do
  reset; run "$X" backend "$CI" completed success; : >"$FAKE_STATE/$m"
  tick; blocked "GitHub API: $m"
done

# 5. Kimliği tutmayan koşular sayılmaz: başka iş akışı dosyası (adı CI olsa bile), PR olayı, başka depo (fork), başka commit
reset; run "$X" backend .github/workflows/sahte-ci.yml completed success; tick; blocked "başka iş akışı dosyası"
reset; run "$X" backend "$CI" completed success pull_request; tick; blocked "pull_request olayı"
reset; run "$X" backend "$CI" completed success push baskasi/Takip; tick; blocked "başka depo (fork)"
reset; run "$B0" backend "$CI" completed success; tick; blocked "başka commit'in başarılı koşusu"

# 6. Aynı commit + dal için birden çok koşu: EN YENİSİ geçerli
reset; run "$X" backend "$CI" completed success; run "$X" backend "$CI" in_progress ""; tick; blocked "eski başarılı + yeni süren koşu"
reset; run "$X" backend "$CI" completed failure; run "$X" backend "$CI" completed success; tick; allowed "eski başarısız + yeni başarılı koşu"

# 7. Başarılı senaryo: backend CI başarılı, deploy/ değişmedi → kurulum testi gerekmez
reset; run "$X" backend "$CI" completed success; tick; allowed "backend CI başarılı (kurulum testi gerekmez)"

# 8. deploy/ değişti → sunucu kurulum testi de ZORUNLU
X=$(commit deploy/ornek.txt)
reset; run "$X" backend "$CI" completed success; tick; blocked "deploy/ değişti, kurulum testi koşusu yok"
reset; run "$X" backend "$CI" completed success; run "$X" fix/dal "$INST" completed success; tick; blocked "kurulum testi yalnızca çalışma dalında"
reset; run "$X" backend "$CI" completed success; run "$X" backend "$INST" in_progress ""; tick; blocked "kurulum testi sürüyor"
reset; run "$X" backend "$CI" completed success; run "$X" backend "$INST" completed failure; tick; blocked "kurulum testi başarısız" failed
reset; run "$X" backend "$CI" completed success; run "$X" backend "$INST" completed success; tick; allowed "CI + kurulum testi başarılı"
grep -q "head_sha=$X&branch=backend&event=push" "$FAKE_STATE/api-calls" || fail "kurulum testi sorgusu"

# 9. Kurulum testi ÖNCEKİ bir backend push'unda koştu (deploy/ o commit'te değişti), son commit yalnızca uygulama
P=$X
X=$(commit app/c.ts)
reset; run "$X" backend "$CI" completed success; run "$P" backend "$INST" completed success; tick; allowed "kurulum testi önceki backend push'unda başarılı"
reset; run "$X" backend "$CI" completed success; run "$P" backend "$INST" completed failure; tick; blocked "önceki backend push'undaki kurulum testi başarısız" failed
reset; run "$X" backend "$CI" completed success; run "$P" fix/dal "$INST" completed success; tick; blocked "önceki commit'in kurulum testi yalnızca çalışma dalında"

# 10. Kapıdan sonra dal ucu değişti (yayına başlamadan) → eski commit yayınlanmaz
reset; run "$X" backend "$CI" completed success; run "$P" backend "$INST" completed success
printf '#!/usr/bin/env bash\ncd %q && date +%%s%%N >> app/d.ts && git add -A && git commit -qm yeni && git push -q %q HEAD:backend\n' "$WORK" "$ORIGIN" >"$FAKE_STATE/on-api"
chmod +x "$FAKE_STATE/on-api"
tick; blocked "kapı sonrası dal ucu değişti"
grep -q '⏸' "$TAKIP_BASE/logs/deploy.log" || fail "uç değişikliği kayda geçmedi"
git -C "$WORK" fetch -q "$ORIGIN" backend && git -C "$WORK" reset -q --hard FETCH_HEAD
X=$(git -C "$WORK" rev-parse HEAD)

# 11. Derleme SIRASINDA dal ucu değişti → veritabanına / kapsayıcılara dokunulmadan durur, çalışan sürüm korunur
reset; run "$X" backend "$CI" completed success; run "$P" backend "$INST" completed success
printf '#!/usr/bin/env bash\ncd %q && date +%%s%%N >> app/e.ts && git add -A && git commit -qm yeni2 && git push -q %q HEAD:backend\n' "$WORK" "$ORIGIN" >"$FAKE_STATE/on-build"
chmod +x "$FAKE_STATE/on-build"
tick
built || fail "derleme beklenirdi"
if deployed_attempt; then fail "derleme sırasında uç değişti ama migration'a geçildi"; fi
[ "$(cat "$STATE/deployed")" = "$B0" ] && [ ! -e "$STATE/failed" ] || fail "yayındaki sürüm / başarısız işareti değişti"
[ "$(git -C "$TAKIP_BASE/src" rev-parse HEAD)" = "$B0" ] || fail "sunucu kopyası önceki sürüme dönmedi"
grep -q 'derleme sırasında dal ucu değişti' "$TAKIP_BASE/logs/deploy.log" || fail "kayıt yok"
ok "derleme sırasında dal ucu değişti → migration yok, kopya önceki sürümde, yayındaki sürüm korundu"
git -C "$WORK" fetch -q "$ORIGIN" backend && git -C "$WORK" reset -q --hard FETCH_HEAD
X=$(git -C "$WORK" rev-parse HEAD)

# 12. Derleme sırasında kapı bozuldu (backend CI yeniden çalıştırıldı ve sürüyor) → durur
reset; run "$X" backend "$CI" completed success; run "$P" backend "$INST" completed success
printf '#!/usr/bin/env bash\njq -cn --arg s %q %s >> %q\n' "$X" "'{name:\"CI\", head_sha:\$s, head_branch:\"backend\", path:\".github/workflows/ci.yml\", status:\"in_progress\", conclusion:null, event:\"push\", run_number:999, created_at:\"2026-10-14T19:00:00Z\", repository:{full_name:\"gkh/Takip\"}, head_repository:{full_name:\"gkh/Takip\"}}'" "$FAKE_STATE/runs.jsonl" >"$FAKE_STATE/on-build"
chmod +x "$FAKE_STATE/on-build"
tick
built || fail "derleme beklenirdi"
if deployed_attempt; then fail "kapı bozulduğu hâlde migration'a geçildi"; fi
ok "derleme sırasında backend CI yeniden çalıştı → migration yok"

# 13. CI'nin kendi yazdığı "CI:" commit'i: üst commit'in AYNI DALDAKİ koşusu geçerli; başka dalınki değil
U=$X
X=$(commit app/f.ts github-actions@github.com 'CI: kilit dosyası')
reset; run "$U" fix/dal "$CI" completed success; run "$P" backend "$INST" completed success; tick; blocked "CI commit'i: üstün koşusu yalnızca çalışma dalında"
reset; run "$U" backend "$CI" completed success; run "$P" backend "$INST" completed success; tick; allowed "CI commit'i: üstün backend koşusu başarılı"

# 15. Demo ortamı testi (demo-env.yml, karar 287): demo yolları (sürüm numarası: package.json) değiştiyse backend'deki demo
# testinin de başarıyla bitmesi ZORUNLU; başka daldaki demo koşusu sayılmaz. CI'nin kendi commit'i (kilit dosyası) yeni demo
# koşusu gerektirmez (içeriğini üst commit'in koşusu üretmiş ve sınamıştır).
DEMO=.github/workflows/demo-env.yml
commit_pkg() { # commit_pkg SÜRÜM [YAZAR_EPOSTA] [KONU] [DOSYA] — demo yolunu değiştiren commit
  if [ -n "${4:-}" ]; then date +%s%N >>"$WORK/$4"; else echo "{\"version\":\"$1\"}" >"$WORK/package.json"; fi
  git -C "$WORK" add -A
  if [ -n "${2:-}" ]; then git -C "$WORK" -c user.email="$2" commit -qm "${3:-sürüm}"; else git -C "$WORK" commit -qm "${3:-sürüm}"; fi
  git -C "$WORK" push -q "$ORIGIN" HEAD:backend
  git -C "$WORK" rev-parse HEAD
}
X=$(commit_pkg 9.9.10)
base_runs() { run "$X" backend "$CI" completed success; run "$P" backend "$INST" completed success; }
reset; base_runs; tick; blocked "sürüm değişti, demo testi koşusu yok"
reset; base_runs; run "$X" fix/dal "$DEMO" completed success; tick; blocked "demo testi yalnızca çalışma dalında"
reset; base_runs; run "$X" backend "$DEMO" in_progress ""; tick; blocked "demo testi sürüyor"
reset; base_runs; run "$X" backend "$DEMO" completed failure; tick; blocked "demo testi başarısız" failed
reset; base_runs; run "$X" backend "$DEMO" completed cancelled; tick; blocked "demo testi iptal edildi" failed
reset; base_runs; run "$X" backend "$DEMO" completed success; tick; allowed "CI + kurulum + demo testi başarılı"
grep -q "head_sha=$X&branch=backend&event=push" "$FAKE_STATE/api-calls" || fail "demo testi sorgusu"
# CI commit'i (kilit dosyası) demo yolunu değiştirdi: üstteki insan commit'inin demo koşusu geçerli
D=$X
X=$(commit_pkg '' github-actions@github.com 'CI: package-lock.json' package-lock.json)
reset; run "$D" backend "$CI" completed success; run "$P" backend "$INST" completed success; run "$D" backend "$DEMO" completed success
tick; allowed "CI commit'i yalnızca kilit dosyasını değiştirdi → üst commit'in demo koşusu geçerli"
# Yalnızca CI commit'i demo yolunu değiştirdiyse (taban: üst commit yayında) yeni demo koşusu gerekmez
echo "$D" >"$STATE/deployed"
reset; run "$D" backend "$CI" completed success; tick; allowed "taban sonrası demo yolunu yalnızca CI commit'i değiştirdi → demo koşusu gerekmez"
echo "$B0" >"$STATE/deployed"

# 14. Atlama değişkeni kayda geçer (zamanlayıcı vermez)
reset; TAKIP_SKIP_CI_GATE=1 bash "$TAKIP" _otomatik >>"$ROOT/out" 2>&1 || true
grep -q 'TAKIP_SKIP_CI_GATE=1: yayın kapısı ATLANDI' "$TAKIP_BASE/logs/deploy.log" || fail "atlama kayda geçmedi"
grep -q 'TAKIP_SKIP_CI_GATE' "$HERE/../systemd/takip-deploy.service" && fail "zamanlayıcı kapıyı atlıyor"
ok "TAKIP_SKIP_CI_GATE kayda geçer; zamanlayıcı servisi kullanmaz"

echo "✔ yayın kapısı: $n kontrol geçti"
