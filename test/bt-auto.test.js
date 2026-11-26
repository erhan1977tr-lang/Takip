// Günün BT kurunun otomatik alınması (4.2.30): sayfa ayrıştırma, saatler, anahtar, gelen sayfanın işlenmesi, gözetim ve
// yedek kural. Ağa çıkılmaz (sayfa test/fixtures/bt-curs-valutar.html — 26.11.2026'daki gerçek sayfanın kısaltılmış kopyası).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BT_AUTO_SLOTS, applyBtPage, btAutoWatchTick, endedSlot, getBtAutoSettings, newBtToken, parseBtUnitsPage, saveBtAutoSettings,
  slotFor, tokenMatches,
} from '../server/fx/bt-auto.js';
import { FX_CARRY_DAYS, btRateFor, dailyRateFor, getDailyRate, saveDailyRate } from '../server/fx/bt.js';
import { fxDocumentText, resolveExchangeRate } from '../server/fx/resolve.js';
import { renderInApp } from '../server/notifications/inapp.js';

const PAGE = fs.readFileSync(new URL('./fixtures/bt-curs-valutar.html', import.meta.url), 'utf8');
const TODAY = '2026-11-26';
const TZ = 'Europe/Bucharest';
/** Bükreş saati (kış: UTC+2) → Date */
const at = (day, hm) => new Date(`${day}T${hm}:00+02:00`);

// ---------- sahte veritabanı: IntegrationSetting + denetim + kuyruk + bildirim ----------
function fakeDb(rows = {}) {
  const settings = new Map(Object.entries(rows));
  const audits = [];
  const nudges = [];
  const notes = [];
  const integrationSetting = {
    findUnique: async ({ where }) => (settings.has(where.key) ? { key: where.key, value: structuredClone(settings.get(where.key)) } : null),
    upsert: async ({ where, create, update }) => {
      settings.set(where.key, structuredClone(settings.has(where.key) ? update.value : create.value));
      return {};
    },
  };
  const db = {
    settings, audits, nudges, notes,
    integrationSetting,
    notificationOutbox: { updateMany: async (q) => { nudges.push(q); return { count: 0 }; } },
    user: { findMany: async () => [{ id: 'u-admin', appRole: 'ADMIN', type: 'STAFF', customerId: null }] },
    notification: { createMany: async ({ data }) => { notes.push(...data); return { count: data.length }; } },
    order: { findUnique: async () => null },
    $transaction: async (fn) => fn(db),
  };
  return db;
}
const writeAudit = (tx, entry) => { tx.audits.push(entry); return Promise.resolve(); };
const admin = { id: 'u-admin', role: 'ADMIN' };

// ---------- ayrıştırma ----------

test('gerçek sayfa: "În unitățile BT" EUR Vânzare okunur (alış / BNR / sayfa günü ile)', () => {
  assert.deepEqual(parseBtUnitsPage(PAGE, { today: TODAY }), { ok: true, sell: 5.435, buy: 5.245, bnr: 5.3428, pageDay: '2026-11-26' });
});

test('ayrıştırma: çevirici ("1 EUR = 5.2450 RON") ve başka satırlar asla okunmaz', () => {
  // EUR satırı yoksa çeviricideki EUR'a düşülmez
  const noEur = PAGE.replace(/<div class="bt-exhange-rate-table-body-row"><div class="bt-exhange-rate-table-body-row-cell"><span class="bt-exhange-rate-table-body-row-cell-currency"><img\s+src="[^"]*eur\.svg"[\s\S]*?<\/div><\/div>(?=<div class="bt-exhange-rate-table-body-row">)/, '');
  assert.notEqual(noEur, PAGE, 'deneme sayfası değişti');
  assert.deepEqual(parseBtUnitsPage(noEur, { today: TODAY }), { ok: false, code: 'NO_EUR_ROW' });
  // USD / GBP satırının değeri EUR yerine gelmez
  assert.equal(parseBtUnitsPage(PAGE, { today: TODAY }).sell, 5.435);
});

test('ayrıştırma: sekme / başlık / tarih / sayı denetimi tutmazsa kur YOK (hata kodu sabit)', () => {
  const cases = [
    ['seçili sekme "În cont"', PAGE.replace('data-value="in-unitatile-bt" selected', 'data-value="in-unitatile-bt"').replace('data-value="in-cont"', 'data-value="in-cont" selected'), 'NOT_UNITS_TAB'],
    ['başlık başka tablo', PAGE.replace('efectuate în unitățile BT.', 'efectuate prin BT Pay.'), 'NOT_UNITS_TAB'],
    ['tablo yok', PAGE.replaceAll('bt-exhange-rate-table', 'xx-table'), 'NO_TABLE'],
    ['sütun sırası değişti', PAGE.replace('<div class="bt-exhange-rate-table-body-row-cell">Cumpărare</div><div class="bt-exhange-rate-table-body-row-cell">Vânzare</div>', '<div class="bt-exhange-rate-table-body-row-cell">Vânzare</div><div class="bt-exhange-rate-table-body-row-cell">Cumpărare</div>'), 'NO_TABLE'],
    ['tarih yok', PAGE.replace('Actualizare: 26-11-2026', 'Actualizare: —'), 'NO_DATE'],
    ['tarih 5 gün eski', PAGE.replace('Actualizare: 26-11-2026', 'Actualizare: 21-11-2026'), 'OLD_DATE'],
    ['tarih gelecekte', PAGE.replace('Actualizare: 26-11-2026', 'Actualizare: 27-11-2026'), 'OLD_DATE'],
    ['vânzare boş', PAGE.replace('>5.4350<', '><'), 'BAD_NUMBERS'],
    ['vânzare metin', PAGE.replace('>5.4350<', '>n/a<'), 'BAD_NUMBERS'],
    ['vânzare ≤ cumpărare', PAGE.replace('>5.4350<', '>5.2000<'), 'SELL_NOT_ABOVE_BUY'],
    ['BNR\'den %6\'dan fazla uzak', PAGE.replace('>5.4350<', '>5.7350<'), 'FAR_FROM_BNR'],
    ['makul aralık dışı', PAGE.replace('>5.3428<', '>53.428<').replace('>5.2450<', '>52.450<').replace('>5.4350<', '>54.350<'), 'OUT_OF_RANGE'],
    ['engel sayfası', '<html><h1>Acces blocat / Access denied</h1></html>', 'NOT_UNITS_TAB'],
    ['boş', '   ', 'EMPTY'],
    ['çok büyük', PAGE + ' '.repeat(2_000_000), 'TOO_LARGE'],
  ];
  for (const [name, html, code] of cases) assert.deepEqual(parseBtUnitsPage(html, { today: TODAY }), { ok: false, code }, name);
});

test('ayrıştırma: hafta sonu / tatil — en çok 4 gün eski sayfa kabul; virgüllü sayı ve entity yazımı okunur', () => {
  assert.equal(parseBtUnitsPage(PAGE, { today: '2026-11-30' }).ok, true, '4 gün');
  const ro = PAGE.replace('>5.4350<', '>5,4350<').replace('în unitățile BT.', 'în unit&#259;&#539;ile BT.');
  assert.equal(parseBtUnitsPage(ro, { today: TODAY }).sell, 5.435);
});

// ---------- saatler ----------

test('saatler: 07:00 / 12:30 / 15:00 (Bükreş); sayfa başlamış en son saate sayılır, pencere 1 saat', () => {
  assert.deepEqual([...BT_AUTO_SLOTS], ['07:00', '12:30', '15:00']);
  assert.equal(slotFor(at(TODAY, '06:59'), TZ), null);
  assert.equal(slotFor(at(TODAY, '07:00'), TZ), '07:00');
  assert.equal(slotFor(at(TODAY, '08:40'), TZ), '07:00', 'bilgisayar geç açıldı');
  assert.equal(slotFor(at(TODAY, '12:30'), TZ), '12:30');
  assert.equal(slotFor(at(TODAY, '23:00'), TZ), '15:00');
  assert.equal(endedSlot(at(TODAY, '07:59'), TZ), null);
  assert.deepEqual(endedSlot(at(TODAY, '08:00'), TZ), { key: `${TODAY}@07:00`, slot: '07:00', day: TODAY });
  assert.equal(endedSlot(at(TODAY, '13:29'), TZ).slot, '07:00');
  assert.equal(endedSlot(at(TODAY, '13:30'), TZ).slot, '12:30');
  assert.equal(endedSlot(at(TODAY, '16:00'), TZ).slot, '15:00');
  // Yaz saati (UTC+3): yerel saat esas
  assert.equal(slotFor(new Date('2026-07-01T04:00:00Z'), TZ), '07:00');
});

// ---------- anahtar ----------

test('anahtar: yalnızca özeti saklanır, denetim kaydında yok; eşleşme sabit süreli ve sıkı', async () => {
  const db = fakeDb();
  const { token } = await saveBtAutoSettings(db, { enabled: true, rotate: true }, admin, writeAudit);
  assert.match(token, /^btk_[A-Za-z0-9_-]{43}$/);
  const stored = JSON.stringify(db.settings.get('fx.btAutoOn'));
  assert.ok(!stored.includes(token), 'anahtar veritabanında açık durmaz');
  assert.ok(!JSON.stringify(db.audits).includes(token) && !JSON.stringify(db.audits).includes(db.settings.get('fx.btAutoOn').tokenHash), 'denetimde anahtar / özet yok');
  const s = await getBtAutoSettings(db);
  assert.equal(s.enabled, true);
  assert.equal(s.hasToken, true);
  assert.equal(tokenMatches(token, s.tokenHash), true);
  for (const bad of [undefined, '', 'btk_', token.slice(0, -1), `${token}x`, token.replace('btk_', 'xxx_'), newBtToken(), 'btk_'.padEnd(300, 'a')]) {
    assert.equal(tokenMatches(bad, s.tokenHash), false, String(bad).slice(0, 20));
  }
  assert.equal(tokenMatches(token, null), false, 'anahtar oluşturulmamışsa hiçbir şey eşleşmez');
  // Kapatmak anahtarı korur; yenisi eskisini geçersiz kılar
  await saveBtAutoSettings(db, { enabled: false }, admin, writeAudit);
  assert.equal(tokenMatches(token, (await getBtAutoSettings(db)).tokenHash), true);
  const { token: t2 } = await saveBtAutoSettings(db, { enabled: true, rotate: true }, admin, writeAudit);
  const s2 = await getBtAutoSettings(db);
  assert.equal(tokenMatches(token, s2.tokenHash), false);
  assert.equal(tokenMatches(t2, s2.tokenHash), true);
});

// ---------- gelen sayfa ----------

test('gelen sayfa: kur "Günün BT kuru" kaydına AUTO olarak yazılır, kur bekleyen işler öne alınır', async () => {
  const db = fakeDb();
  const r = await applyBtPage(db, { html: PAGE, now: at(TODAY, '07:02'), timeZone: TZ, writeAudit });
  assert.deepEqual(r, { ok: true, rate: 5.435, applied: true });
  assert.deepEqual(await getDailyRate(db), { day: TODAY, rate: 5.435, source: 'AUTO', at: at(TODAY, '07:02').toISOString(), slot: '07:00' });
  assert.equal(await dailyRateFor(db, TODAY), 5.435, 'mevcut okuyucu aynı kaydı görür');
  assert.equal(db.audits.at(-1).action, 'FX_DAILY_RATE_AUTO');
  assert.equal(db.audits.at(-1).userId, null);
  assert.equal(db.nudges.length, 1, 'kur bekleyen FGO işleri öne alındı');
  // Aynı kur yeniden gelirse yazılmaz
  const again = await applyBtPage(db, { html: PAGE, now: at(TODAY, '12:31'), timeZone: TZ, writeAudit });
  assert.deepEqual(again, { ok: true, rate: 5.435, applied: false, reason: 'SAME' });
  assert.equal(db.audits.length, 1);
  // Öğlen kur değişirse günün kuru güncellenir (kesilmiş belgelerin kur kaydı ayrıdır, etkilenmez)
  const noon = await applyBtPage(db, { html: PAGE.replace('>5.4350<', '>5.4410<'), now: at(TODAY, '12:35'), timeZone: TZ, writeAudit });
  assert.equal(noon.applied, true);
  assert.equal((await getDailyRate(db)).rate, 5.441);
});

test('gelen sayfa: yöneticinin bugün elle girdiği kur ezilmez; hatalı sayfa hiçbir şey yazmaz', async () => {
  const db = fakeDb();
  await saveDailyRate(db, { day: TODAY, rate: 5.44 }, admin, writeAudit);
  const r = await applyBtPage(db, { html: PAGE, now: at(TODAY, '07:01'), timeZone: TZ, writeAudit });
  assert.deepEqual(r, { ok: true, rate: 5.435, applied: false, reason: 'MANUAL' });
  assert.deepEqual(await getDailyRate(db), { day: TODAY, rate: 5.44 }, 'elle girilen kayıt aynen');

  const db2 = fakeDb({ 'fx.daily': { day: TODAY, rate: 5.43, source: 'AUTO' } });
  const bad = await applyBtPage(db2, { html: '<h1>Acces blocat</h1>', now: at(TODAY, '12:30'), timeZone: TZ, writeAudit });
  assert.deepEqual(bad, { ok: false, code: 'NOT_UNITS_TAB' });
  assert.equal((await getDailyRate(db2)).rate, 5.43, 'gün içindeki son doğru kur yerinde');
  assert.equal(db2.audits.length, 0);
  assert.equal(db2.settings.get('fx.btAuto').lastError.code, 'NOT_UNITS_TAB');
  assert.ok(!JSON.stringify(db2.settings.get('fx.btAuto')).includes('Acces'), 'gönderilen metin saklanmaz');
});

test('elle kaydetme davranışı aynı: kayıt biçimi { day, rate }, denetim FX_DAILY_RATE + kullanıcı', async () => {
  const db = fakeDb();
  await saveDailyRate(db, { day: TODAY, rate: 5.4412 }, admin, writeAudit);
  assert.deepEqual(db.settings.get('fx.daily'), { day: TODAY, rate: 5.4412 });
  assert.equal(db.audits[0].action, 'FX_DAILY_RATE');
  assert.equal(db.audits[0].userId, 'u-admin');
});

// ---------- yedek kural ----------

test('yedek kural: otomatik kur KAPALIYKEN dünün kuru kullanılmaz (bugünkü davranış aynen)', async () => {
  const db = fakeDb({ 'fx.daily': { day: '2026-11-25', rate: 5.43 } });
  assert.equal(await btRateFor(db, TODAY), null);
  await assert.rejects(
    resolveExchangeRate(db, { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: TODAY }),
    (e) => e.code === 'BT_MANUAL_REQUIRED',
  );
});

test('yedek kural: otomatik kur AÇIKKEN son doğru kur en çok 3 gün kullanılır, kaynak günü eski gün', async () => {
  const db = fakeDb({ 'fx.daily': { day: '2026-11-25', rate: 5.43, source: 'AUTO' }, 'fx.btAutoOn': { enabled: true } });
  assert.equal(FX_CARRY_DAYS, 3);
  assert.deepEqual(await btRateFor(db, TODAY), { rate: 5.43, source: 'BT_AUTO', sourceDay: '2026-11-25' });
  assert.deepEqual(await btRateFor(db, '2026-11-28'), { rate: 5.43, source: 'BT_AUTO', sourceDay: '2026-11-25' }, '3 gün');
  assert.equal(await btRateFor(db, '2026-11-29'), null, '4 gün → belge bekler');
  assert.equal(await btRateFor(db, '2026-11-24'), null, 'geçmiş gün için ileri tarihli kur kullanılmaz');
  const fx = await resolveExchangeRate(db, { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: TODAY, now: at(TODAY, '09:00') });
  assert.equal(fx.finalRate, '5.4300');
  assert.equal(fx.source, 'BT_AUTO');
  assert.equal(fx.sourceDate, '2026-11-25');
  assert.equal(fx.manual, false);
});

test('çözücü: günün kuru elle → MANUAL_DAY (elle), otomatik → BT_AUTO; belge cümlesi ikisinde de aynı', async () => {
  const manual = await resolveExchangeRate(fakeDb({ 'fx.daily': { day: TODAY, rate: 5.4412 } }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: TODAY });
  assert.deepEqual([manual.source, manual.manual, manual.finalRate, manual.sourceDate], ['MANUAL_DAY', true, '5.4412', TODAY]);
  const auto = await resolveExchangeRate(fakeDb({ 'fx.daily': { day: TODAY, rate: 5.435, source: 'AUTO' } }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: TODAY });
  assert.deepEqual([auto.source, auto.manual, auto.finalRate], ['BT_AUTO', false, '5.4350']);
  assert.equal(fxDocumentText({ fxRate: auto.finalRate, fxPolicy: 'BT_UNIT_SELL', fxSource: auto.source, fxCurrency: 'EUR' }), 'Curs de vânzare BT: 5.4350 RON/EUR');
  assert.equal(fxDocumentText({ fxRate: manual.finalRate, fxPolicy: 'BT_UNIT_SELL', fxSource: manual.source, fxCurrency: 'EUR' }), 'Curs de vânzare BT: 5.4412 RON/EUR');
  // Belge için elle girilen kur her şeyin önüne geçer (değişmedi)
  const over = await resolveExchangeRate(fakeDb({ 'fx.daily': { day: TODAY, rate: 5.435, source: 'AUTO' } }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: TODAY, manualRate: '5,5000' });
  assert.deepEqual([over.source, over.finalRate], ['MANUAL', '5.5000']);
});

test('BNR müşterileri otomatik BT kurundan etkilenmez', async () => {
  const db = fakeDb({ 'fx.daily': { day: TODAY, rate: 5.435, source: 'AUTO' }, 'fx.btAutoOn': { enabled: true } });
  const fx = await resolveExchangeRate(db, { customer: { fxPolicy: 'BNR' }, day: TODAY, bnrImpl: async () => ({ ok: true, rate: '5.3428', date: TODAY }) });
  assert.deepEqual([fx.source, fx.finalRate], ['BNR', '5.3428']);
});

// ---------- gözetim ----------

test('gözetim: pencere bitti, kur gelmedi, bugün kur yok → yöneticiye bir kez bildirim; kapalıyken hiçbir şey', async () => {
  const off = fakeDb();
  assert.deepEqual(await btAutoWatchTick(off, { now: at(TODAY, '08:05'), timeZone: TZ }), { alerted: false });

  const db = fakeDb({ 'fx.btAutoOn': { enabled: true } });
  assert.deepEqual(await btAutoWatchTick(db, { now: at(TODAY, '07:30'), timeZone: TZ }), { alerted: false }, 'pencere sürüyor');
  assert.deepEqual(await btAutoWatchTick(db, { now: at(TODAY, '08:01'), timeZone: TZ }), { alerted: true, slot: '07:00' });
  assert.deepEqual(await btAutoWatchTick(db, { now: at(TODAY, '08:02'), timeZone: TZ }), { alerted: false }, 'ikinci kez yok');
  assert.equal(db.notes.length, 1);
  assert.equal(db.notes[0].dedupeKey, `fx-auto:${TODAY}@07:00`);
  assert.equal(db.notes[0].type, 'FX_AUTO_FAILED');
  assert.equal(db.notes[0].link, '/admin/entegrasyonlar#kur');
  const tr = renderInApp('tr', db.notes[0]);
  assert.match(tr.title, /BT kuru otomatik okunamadı/);
  assert.match(tr.body, /26\.11\.2026 · saat 07:00/);
  assert.match(renderInApp('ro', db.notes[0]).title, /Cursul BT/);

  // Bugün kur varsa (elle ya da önceki okumadan) bildirim yok
  const ok = fakeDb({ 'fx.btAutoOn': { enabled: true }, 'fx.daily': { day: TODAY, rate: 5.44 } });
  assert.deepEqual(await btAutoWatchTick(ok, { now: at(TODAY, '13:31'), timeZone: TZ }), { alerted: false });
  // O saat için kur geldiyse bildirim yok
  const came = fakeDb({ 'fx.btAutoOn': { enabled: true } });
  await applyBtPage(came, { html: PAGE, now: at(TODAY, '07:05'), timeZone: TZ, writeAudit });
  assert.deepEqual(await btAutoWatchTick(came, { now: at(TODAY, '08:01'), timeZone: TZ }), { alerted: false });
});

// ---------- yapı ----------

test('yapı: /kur/bt yalnızca POST, anahtar + açık + boyut + istek sınırı ister; sunucu BT\'ye istek atmaz', () => {
  const route = fs.readFileSync(new URL('../app/kur/bt/route.ts', import.meta.url), 'utf8');
  assert.deepEqual(route.match(/export async function (\w+)/g), ['export async function POST']);
  for (const need of ['limiter.take', 'tokenMatches(token, settings.tokenHash)', "if (!settings.enabled)", 'BT_PAGE_MAX_BYTES', 'applyBtPage']) assert.ok(route.includes(need), need);
  assert.ok(!/cookies\(|getCurrentUser|requireUser/.test(route), 'tarayıcı oturumu kullanılmaz');
  const auto = fs.readFileSync(new URL('../server/fx/bt-auto.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bfetch\(/.test(auto), 'sunucu BT sayfasını kendisi istemez (IP engelli)');
  const worker = fs.readFileSync(new URL('../scripts/worker.mjs', import.meta.url), 'utf8');
  assert.ok(worker.includes('await btAutoWatchTick(db,'), 'işçi gözetimi çalıştırır');
  // Elle girme yolu ve izni değişmedi
  const actions = fs.readFileSync(new URL('../app/(panel)/admin/entegrasyonlar/actions.ts', import.meta.url), 'utf8');
  assert.ok(/export async function saveDailyRateAction\(formData: FormData\) \{\n {2}const user = await requirePermission\('OPS_SETTINGS_MANAGE'\);/.test(actions));
  assert.ok(/export async function saveBtAutoAction\([^)]*\): Promise<BtAutoState> \{\n {2}const user = await requirePermission\('SETTINGS_MANAGE'\);/.test(actions), 'otomatik ayar yalnızca yönetici');
});
