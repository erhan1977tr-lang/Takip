#!/usr/bin/env bash
# DWG / DXF önizleme hizmeti (karar 283) — gerçek Docker ile sunucu kurulumu testi.
# .github/workflows/deploy-test.yml çalıştırır; kurulu ve yayında bir Takip ister (GitHub'ın tek kullanımlık test makinesi).
# GERÇEK SUNUCUDA ÇALIŞTIRILMAZ.
#
# Denetlenen:
#  1. "cad" kapsayıcısı: nobody (65534), salt okunur kök, bütün yetenekler bırakılmış, no-new-privileges, bellek / işlemci /
#     süreç sınırı, yalnızca iç ağ (internal) — internete, veritabanına, antivirüse ulaşamaz; yükleme birimi bağlı değil.
#  2. Uygulama hizmete iç ağdan ulaşır; imajdaki dwg2dxf sabit sürüm (0.14), GPL lisans metni ve kaynak adresi imajda.
#  3. GERÇEK DWG örnekleri: LibreDWG'nin sabit sürümlü kaynak paketinin kendi test dosyaları (SHA-256 doğrulanır; müşteri
#     dosyası değil). Hepsi dönüştürülür; AutoCAD'in kendi DXF'i olan örneklerde çizim kapsamı birebir aynı olmalı ya da
#     fark önizlemede "gösterilemeyen nesne" olarak bildirilmeli (sessizce eksik çizim yok). Çizgi / yay / polyline / blok /
#     yazı / ölçülendirme / katman içeren örnekler ayrıca nesne nesne denetlenir.
#  4. Bozuk / kesik / rastgele DWG ve sahte içerik sabit kodla reddedilir; hizmet ayakta kalır; geçici dosya kalmaz.
set -Eeuo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "Yalnızca GitHub Actions'taki kurulum testinde çalışır."; exit 2; }

ENV_FILE=/opt/takip/.env
COMPOSE_FILE=/opt/takip/src/deploy/docker-compose.yml
compose() { sudo docker compose -p takip --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
LIBREDWG_VERSION=0.14
LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
T=$(mktemp -d)
cad() { compose ps -q cad | head -n 1; }

diag() { # diag SATIR ÇIKIŞ KOMUT
  trap - ERR
  set +ex
  {
    echo "satır $1 (çıkış $2): $3"
    echo "--- kapsayıcılar"; compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' || true
    echo "--- cad günlüğü"; compose logs --no-log-prefix --tail 30 cad || true
    [ -f "$T/sonuc.txt" ] && { echo "--- örnekler"; tail -n 40 "$T/sonuc.txt"; }
  } 2>&1 | tail -c 6000 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g' | sed 's/^/::error title=CAD önizleme testi::/'
  exit "$2"
}
trap 'diag "$LINENO" "$?" "$BASH_COMMAND"' ERR
set -x

# ---------- 1. kapsayıcı ayarları ----------
id=$(cad)
[ -n "$id" ]
for _ in $(seq 1 30); do
  [ "$(sudo docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ] && break
  sleep 2
done
[ "$(sudo docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ]
[ "$(sudo docker inspect -f '{{.Config.User}}' "$id")" = 65534:65534 ]
[ "$(sudo docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}' "$id")" = "true false" ]
[ "$(sudo docker inspect -f '{{json .HostConfig.CapDrop}}' "$id")" = '["ALL"]' ]
sudo docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$id" | grep -q 'no-new-privileges:true'
[ "$(sudo docker inspect -f '{{.HostConfig.Memory}}' "$id")" -gt 0 ]
[ "$(sudo docker inspect -f '{{.HostConfig.NanoCpus}}' "$id")" -gt 0 ]
[ "$(sudo docker inspect -f '{{.HostConfig.PidsLimit}}' "$id")" -gt 0 ]
[ "$(sudo docker inspect -f '{{len .Mounts}}' "$id")" = 0 ]   # bağlı birim yok (yükleme birimi YOK); /tmp bellekte (aşağıda)
sudo docker inspect -f '{{json .HostConfig.Tmpfs}}' "$id" | grep -q '"/tmp"'
nets=$(sudo docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id")
[ "$nets" = "takip_cad " ]
[ "$(sudo docker network inspect -f '{{.Internal}}' takip_cad)" = true ]
# Çekirdeğin gözünden: süreç nobody, bütün yetenek kümeleri boş, NoNewPrivs 1
pid=$(sudo docker inspect -f '{{.State.Pid}}' "$id")
sudo awk '/^Uid:/ { if ($2 != 65534 || $3 != 65534) exit 1 } /^Cap(Inh|Prm|Eff|Bnd|Amb):/ { if ($2 != "0000000000000000") exit 1 } /^NoNewPrivs:/ { if ($2 != 1) exit 1 }' "/proc/$pid/status"
# Ortamda gizli ayar yok
! sudo docker inspect -f '{{json .Config.Env}}' "$id" | grep -Eq 'DATABASE_URL|AUTH_SECRET|SMTP|FGO|POSTGRES|OPENAI|TELEGRAM'

# Ağ yalıtımı: dışarı, veritabanına, antivirüse ulaşılamaz
compose exec -T cad node -e "fetch('https://github.com',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>process.exit(0))"
compose exec -T cad node -e "const s=require('net').connect(5432,'db');s.setTimeout(4000,()=>process.exit(0));s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0))"
compose exec -T cad node -e "const s=require('net').connect(3310,'clamav');s.setTimeout(4000,()=>process.exit(0));s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0))"
# Kök dosya sistemine yazılamaz; /tmp'de çalıştırılamaz (noexec)
! compose exec -T cad sh -c 'echo x > /app/cad/x' 2>/dev/null
compose exec -T cad sh -c 'cp /usr/local/bin/dwg2dxf /tmp/d && chmod +x /tmp/d && { /tmp/d --version >/dev/null 2>&1 && exit 1 || exit 0; }; rm -f /tmp/d'
compose exec -T cad sh -c 'rm -f /tmp/d'

# ---------- 2. uygulama → hizmet; dönüştürücü ve lisans ----------
compose exec -T app node -e "fetch(process.env.CAD_SERVICE_URL+'/health').then(r=>r.json()).then(j=>process.exit(j.ok&&j.dwg?0:1),()=>process.exit(1))"
compose exec -T cad dwg2dxf --version | grep -q "$LIBREDWG_VERSION"
compose exec -T cad grep -q 'GNU GENERAL PUBLIC LICENSE' /usr/share/doc/libredwg/COPYING
compose exec -T cad grep -q "$LIBREDWG_SHA256" /usr/share/doc/libredwg/SOURCE

# ---------- 3. gerçek DWG örnekleri ----------
curl -fsSL --retry 3 -o "$T/libredwg.tar.xz" "https://github.com/LibreDWG/libredwg/releases/download/$LIBREDWG_VERSION/libredwg-$LIBREDWG_VERSION.tar.xz"
echo "$LIBREDWG_SHA256  $T/libredwg.tar.xz" | sha256sum -c -
mkdir -p "$T/src" "$T/ornek"
tar -xJf "$T/libredwg.tar.xz" -C "$T/src" "libredwg-$LIBREDWG_VERSION/test/test-data"
cp -r "$T/src/libredwg-$LIBREDWG_VERSION/test/test-data/." "$T/ornek/"
# Bozuk örnekler: kesik, rastgele, bit çevrilmiş
head -c 3000 "$T/ornek/example_2000.dwg" > "$T/ornek/bozuk-kesik.dwg"
{ printf 'AC1015'; head -c 200000 /dev/urandom; } > "$T/ornek/bozuk-rastgele.dwg"
printf '%%PDF-1.7 sahte' > "$T/ornek/sahte-pdf.dwg"
sudo chmod -R a+rX "$T/ornek"

# Örnekleri iç ağdaki hizmete uygulamanın imajıyla, ayrı bir kapsayıcıdan gönder (müşteri dosyası değil; ağ yalnızca iç ağ)
img=$(sudo docker inspect -f '{{.Config.Image}}' "$id")
cat > "$T/ornekler.mjs" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { dxfToPreview } from '/app/cad/dxf.js';
import { decodeDxf } from '/app/cad/dxf-cli.mjs';
const root = '/ornek';
const files = [];
const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : n.endsWith('.dwg') && files.push(p); } };
walk(root);
const post = async (type, body) => {
  const r = await fetch(`http://cad:3311/preview?type=${type}`, { method: 'POST', body });
  return { status: r.status, body: await r.json() };
};
const stat = { ok: 0, uyarili: 0, kapsamAyni: 0, kapsamFarkBildirildi: 0 };
const fail = [];
for (const f of files) {
  const name = path.relative(root, f);
  const r = await post('dwg', fs.readFileSync(f));
  const bad = name.startsWith('bozuk-') || name.startsWith('sahte-');
  if (bad) {
    const want = name.startsWith('sahte-') ? 'MISMATCH' : 'CONVERT_FAILED';
    if (r.body.ok || r.body.code !== want) fail.push(`${name}: ${r.status} ${r.body.code ?? 'ok'} (beklenen ${want})`);
    console.log(name, r.status, r.body.code ?? 'ok');
    continue;
  }
  if (!r.body.ok) { fail.push(`${name}: ${r.status} ${r.body.code}`); continue; }
  stat.ok++;
  const n = r.body.data.notes;
  const flagged = Object.keys(n.unsupported).length > 0 || Object.keys(n.partial).length > 0 || n.converterErrors > 0 || r.body.warning;
  if (flagged) stat.uyarili++;
  const ref = f.replace(/\.dwg$/, '.dxf');
  if (fs.existsSync(ref)) {
    let refExt = null;
    try { refExt = dxfToPreview(decodeDxf(fs.readFileSync(ref))).extents; } catch { refExt = undefined; }
    if (refExt !== undefined) {
      const same = JSON.stringify(refExt) === JSON.stringify(r.body.data.extents);
      if (same) stat.kapsamAyni++;
      else if (Object.keys(n.unsupported).length > 0) stat.kapsamFarkBildirildi++;
      else fail.push(`${name}: kapsam AutoCAD DXF'inden farklı ve bildirilmedi ${JSON.stringify(refExt)} ≠ ${JSON.stringify(r.body.data.extents)}`);
    }
  }
}
// Nesne nesne: AutoCAD 2000 tek nesneli örnekler (birim inç)
const one = async (name, check) => {
  const r = await post('dwg', fs.readFileSync(path.join(root, name)));
  if (!r.body.ok) return fail.push(`${name}: ${r.body.code}`);
  const msg = check(r.body.data);
  if (msg) fail.push(`${name}: ${msg}`);
};
await one('2000/Line.dwg', (d) => (d.paths.length === 1 && d.paths[0][3][0].length === 4 && d.units === 'in' ? '' : 'tek çizgi beklenir'));
await one('2000/Arc.dwg', (d) => (d.paths.length === 1 && d.paths[0][3][0].length > 8 ? '' : 'yay beklenir'));
await one('2000/Text.dwg', (d) => (d.texts.length === 1 && d.texts[0][6].length > 0 ? '' : 'tek yazı beklenir'));
await one('example_2000.dwg', (d) => {
  const layers = d.layers.map((l) => l.name);
  if (layers.length < 2) return 'katmanlar okunmalı';
  if (!d.notes.dropped || !('ACAD_TABLE' in d.notes.dropped)) return 'dönüştürücünün düşürdüğü tablo bildirilmeli';
  if (d.texts.length === 0) return 'yazılar / ölçü metinleri okunmalı';
  return '';
});
console.log(JSON.stringify(stat));
if (stat.ok < 100) fail.push(`dönüştürülen örnek çok az: ${stat.ok}`);
if (stat.kapsamAyni < 30) fail.push(`AutoCAD DXF'iyle karşılaştırılan örnek çok az: ${stat.kapsamAyni}`);
if (fail.length) { console.log('HATALAR:\n' + fail.join('\n')); process.exit(1); }
EOF
sudo docker run --rm --network takip_cad --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
  -v "$T/ornek:/ornek:ro" -v "$T/ornekler.mjs:/ornekler.mjs:ro" "$img" node /ornekler.mjs | tee "$T/sonuc.txt"
echo "::notice title=CAD önizleme — gerçek DWG örnekleri::$(tail -n 1 "$T/sonuc.txt")"

# ---------- 4. hizmet ayakta, geçici dosya kalmadı, yeniden başlatılmadı ----------
[ "$(sudo docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$id")" = "running 0" ]
for _ in $(seq 1 20); do [ -z "$(compose exec -T cad ls -A /tmp)" ] && break; sleep 1; done
[ -z "$(compose exec -T cad ls -A /tmp)" ]
sudo rm -rf "$T"
echo "CAD önizleme testi tamam"
