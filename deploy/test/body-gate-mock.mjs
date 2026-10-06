// YALNIZCA test içindir (deploy/test/body-gate.sh, karar 143): Caddy'nin arkasında uygulamanın YERİNE duran sahte sunucu.
// Gerçek Caddy + depodaki Caddyfile ile gövde kapısının davranışını ölçer: Caddy kapıya ne soruyor, kapı ne derse ne
// oluyor ve — en önemlisi — uygulamaya kaç bayt GÖVDE ulaşıyor. Uygulamanın hiçbir parçasını kullanmaz; dış istek yok.
//
//   node body-gate-mock.mjs [UYGULAMA_PORTU=3000] [DENETİM_PORTU=3001]
//
// Uygulama portu (Caddy buraya bağlanır):
//   GET /oturum/govde-izni → kapı; yanıtı "mod" belirler (aşağıda)
//   başka her istek        → gövdenin tamamını okur, 200 "govde <bayt>" yanıtlar
// Denetim portu (yalnızca test betiği; Caddy'den geçmez):
//   POST /mod/<ad>  kapının modunu değiştirir ve kaydı sıfırlar
//   GET  /kayit     { mod, istekler: [{ kapi, yontem, yol, bayt, bitti, ... }] }
//
// Modlar — "izin" dışındaki HİÇBİRİ büyük gövdeye izin vermemelidir:
//   izin            204 + X-Takip-Govde: izin                      (tek geçerli izin yanıtı)
//   ret             401                                            (uygulamanın "izin yok" yanıtı)
//   cerez           istekte "takip_session=gecerli" çerezi varsa izin, yoksa ret (çerezin kapıya ulaştığını gösterir)
//   basliksiz       204, başlık yok                                (bozuk yanıt)
//   yanlis-deger    204 + X-Takip-Govde: hayir                     (bozuk yanıt)
//   iki-yuz         200 + X-Takip-Govde: izin                      (bozuk yanıt: durum 204 değil)
//   yonlendirme     302 + X-Takip-Govde: izin
//   hata            500
//   bulunamadi      404                                            (kapısı olmayan eski uygulama sürümü)
//   kopar           yanıt vermeden bağlantıyı kapatır
//   as              hiç yanıt vermez                               (zaman aşımı)
import http from 'node:http';

const APP_PORT = Number(process.argv[2] ?? 3000);
const CONTROL_PORT = Number(process.argv[3] ?? 3001);
const GATE = '/oturum/govde-izni';
const MODES = ['izin', 'ret', 'cerez', 'basliksiz', 'yanlis-deger', 'iki-yuz', 'yonlendirme', 'hata', 'bulunamadi', 'kopar', 'as'];

let mode = 'ret';
/** @type {Array<Record<string, unknown>>} */
let requests = [];
/** Yanıtsız bırakılan bağlantılar (mod "as"): mod değişince kapatılır */
const hanging = new Set();

function gate(req, res, entry) {
  const allow = () => res.writeHead(204, { 'X-Takip-Govde': 'izin', 'Cache-Control': 'no-store' }).end();
  const deny = () => res.writeHead(401, { 'Cache-Control': 'no-store' }).end();
  entry.karar = mode;
  switch (mode) {
    case 'izin': return allow();
    case 'ret': return deny();
    case 'cerez': return /(^|;\s*)takip_session=gecerli(;|$)/.test(String(req.headers.cookie ?? '')) ? allow() : deny();
    case 'basliksiz': return res.writeHead(204).end();
    case 'yanlis-deger': return res.writeHead(204, { 'X-Takip-Govde': 'hayir' }).end();
    case 'iki-yuz': return res.writeHead(200, { 'X-Takip-Govde': 'izin', 'Content-Type': 'text/plain' }).end('izin');
    case 'yonlendirme': return res.writeHead(302, { 'X-Takip-Govde': 'izin', Location: '/login' }).end();
    case 'hata': return res.writeHead(500, { 'Content-Type': 'text/plain' }).end('hata');
    case 'bulunamadi': return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('yok');
    case 'kopar': return req.socket.destroy();
    case 'as': hanging.add(req.socket); return undefined;
    default: return deny();
  }
}

const app = http.createServer((req, res) => {
  const path = String(req.url ?? '').split('?')[0];
  const entry = {
    kapi: path === GATE,
    yontem: req.method,
    yol: req.url,
    bayt: 0,
    bitti: false,
    // Caddy'nin kapıya yazdığı özgün istek bilgisi ve gövdeyle ilgili başlıklar
    ozgunAdres: req.headers['x-forwarded-uri'] ?? null,
    ozgunYontem: req.headers['x-forwarded-method'] ?? null,
    boy: req.headers['content-length'] ?? null,
    aktarim: req.headers['transfer-encoding'] ?? null,
    expect: req.headers.expect ?? null,
    cerezVar: typeof req.headers.cookie === 'string',
    sahteIp: ['cf-connecting-ip', 'cf-ipcountry', 'true-client-ip', 'x-real-ip'].filter((h) => h in req.headers),
  };
  requests.push(entry);
  req.on('data', (chunk) => { entry.bayt += chunk.length; });
  req.on('error', () => undefined);
  if (entry.kapi) {
    // Kapı isteği gövdesizdir; yine de gelen bayt olursa sayılır (yukarıda) ve yanıt hemen verilir
    gate(req, res, entry);
    return;
  }
  req.on('end', () => {
    entry.bitti = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`govde ${entry.bayt}`);
  });
});
app.on('clientError', (_e, socket) => socket.destroy());

const control = http.createServer((req, res) => {
  const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const m = /^\/mod\/([a-z-]+)$/.exec(String(req.url));
  if (req.method === 'POST' && m && MODES.includes(m[1])) {
    mode = m[1];
    requests = [];
    for (const s of hanging) s.destroy();
    hanging.clear();
    return json(200, { mod: mode });
  }
  if (req.method === 'GET' && req.url === '/kayit') return json(200, { mod: mode, istekler: requests });
  return json(404, { hata: 'bilinmeyen denetim isteği' });
});

app.listen(APP_PORT, '0.0.0.0', () => control.listen(CONTROL_PORT, '0.0.0.0', () => console.log(`sahte uygulama :${APP_PORT} · denetim :${CONTROL_PORT}`)));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
