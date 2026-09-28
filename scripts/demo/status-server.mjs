// Demo ortamı hazırlanırken 3000 portunda "hazırlanıyor" sayfası gösterir (502 hatası yerine).
// Durum /tmp/takip-step.txt, hata /tmp/takip-error.txt dosyasından okunur. Uygulama açılınca start.sh bunu kapatır.
import fs from 'node:fs';
import http from 'node:http';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const started = Date.now();

http.createServer((req, res) => {
  const step = read('/tmp/takip-step.txt').trim() || 'Hazırlanıyor…';
  const error = read('/tmp/takip-error.txt');
  const min = Math.floor((Date.now() - started) / 60000);
  const body = error
    ? `<h1>Takip başlatılamadı</h1><p>Adım: <b>${esc(step)}</b></p>
       <p>Codespace'in alttaki terminaline <code>npm run demo</code> yazıp tekrar deneyin. Düzelmezse bu sayfanın ekran görüntüsünü gönderin.</p>
       <pre>${esc(error.slice(-6000))}</pre>`
    : `<h1>Takip hazırlanıyor…</h1><p><b>${esc(step)}</b></p>
       <p class="m">İlk açılışta 3–6 dakika sürer. Bu sayfa kendiliğinden yenilenir; uygulama hazır olunca giriş ekranı açılır.</p>
       <p class="m">Geçen süre: ${min} dk</p>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Takip hazırlanıyor</title>${error ? '' : '<meta http-equiv="refresh" content="5">'}
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:12vh auto;padding:0 16px;color:#1e293b}
h1{font-size:24px}.m{color:#64748b}pre{background:#f1f5f9;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:12px}</style>
</head><body>${body}</body></html>`);
}).listen(3000, '0.0.0.0');
