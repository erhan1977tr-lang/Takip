// Çalışma takvimleri ve profil teslim günü (Paket 8, karar 192–194, 197) — saf kurallar. Tarih ve saat hep ENJEKTE edilir
// (gerçek saat beklenmez); dış servis yoktur (tatil verisi kodla gelir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLIDAYS, HOLIDAY_DATA_VERSION } from '../server/calendar/holidays.js';
import {
  CALENDARS, addDaysKey, coverageGaps, dayStatus, hasYearData, holidayOf, holidaysBetween, isDayKey, localClock, missingYears,
  monthDays, nextOpenDay, orthodoxEaster, parseOverride, weekdayOf,
} from '../server/calendar/rules.js';
import { DEPOT_CUTOFF_MINUTES, NoOpenDayError, depotPhase, depotReadyDay, pickupOnForward } from '../server/profile/dates.js';
import { glassLoadingDate } from '../server/orders/rules.js';
import { ETA_REMIND_DAYS, etaCalendarWarning, etaReminderDue, etaReminderKey } from '../server/suppliers/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const key = (d) => d.toISOString().slice(0, 10);
const ready = (iso, overrides = null) => key(depotReadyDay(new Date(iso), overrides));

// ---------- tatil verisi ----------

test('tatil verisi: geçerli günler, yıl içinde sıralı ve tekil; yarım gün yalnızca Türkiye arifesi ve 28 Ekim', () => {
  assert.match(HOLIDAY_DATA_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  for (const [country, years] of Object.entries(HOLIDAYS)) {
    for (const [year, list] of Object.entries(years)) {
      const days = list.map((h) => h.day);
      assert.deepEqual(days, [...days].sort(), `${country} ${year} sıralı`);
      assert.equal(new Set(days).size, days.length, `${country} ${year} tekil`);
      for (const h of list) {
        assert.ok(isDayKey(h.day) && h.day.startsWith(year), `${country} ${h.day}`);
        assert.ok(h.names.length >= 1);
        if (h.half) assert.ok(country === 'TR' && (h.names[0].endsWith('Eve')), `${country} ${h.day} yarım gün`);
      }
    }
  }
  assert.deepEqual(Object.keys(HOLIDAYS.RO), ['2026', '2027'], 'yalnızca doğrulanmış yıllar');
  assert.deepEqual(Object.keys(HOLIDAYS.TR), ['2026', '2027'], 'yalnızca doğrulanmış yıllar — gelecek yıl tahmin edilmez');
});

test('Romanya: sabit günler her yıl var; Paște ve Rusalii ortodoks Paskalyası hesabıyla (Julian computus) aynı', () => {
  assert.equal(orthodoxEaster(2026), '2026-04-12');
  assert.equal(orthodoxEaster(2027), '2027-05-02');
  for (const year of Object.keys(HOLIDAYS.RO)) {
    const byName = (n) => HOLIDAYS.RO[year].filter((h) => h.names.includes(n)).map((h) => h.day);
    for (const md of ['01-01', '01-02', '01-06', '01-07', '01-24', '05-01', '06-01', '08-15', '11-30', '12-01', '12-25', '12-26']) {
      assert.ok(holidayOf('RO_DEPOT', `${year}-${md}`), `${year}-${md}`);
    }
    const e = orthodoxEaster(Number(year));
    assert.deepEqual(byName('goodFriday'), [addDaysKey(e, -2)]);
    assert.deepEqual(byName('easter'), [e]);
    assert.deepEqual(byName('easterMonday'), [addDaysKey(e, 1)]);
    assert.deepEqual(byName('pentecost'), [addDaysKey(e, 49)]);
    assert.deepEqual(byName('pentecostMonday'), [addDaysKey(e, 50)]);
    assert.equal(HOLIDAYS.RO[year].length, year === '2026' ? 16 : 17, '2026: 1 Haziran hem Çocuk Bayramı hem Rusalii 2. gün');
  }
});

test('Türkiye: sabit günler her yıl var; Ramazan (arife + 3) ve Kurban (arife + 4) ardışık; doğrulanmış tarihler', () => {
  for (const year of Object.keys(HOLIDAYS.TR)) {
    for (const md of ['01-01', '04-23', '05-01', '05-19', '07-15', '08-30', '10-29']) assert.ok(holidayOf('TR_FACTORY', `${year}-${md}`), `${year}-${md}`);
    assert.equal(holidayOf('TR_FACTORY', `${year}-10-28`)?.half, true, '28 Ekim yarım gün');
    for (const [eve, n] of [['ramazanEve', 3], ['kurbanEve', 4]]) {
      const first = HOLIDAYS.TR[year].find((h) => h.names.includes(eve));
      assert.ok(first?.half, `${year} ${eve}`);
      for (let i = 1; i <= n; i++) assert.ok(holidayOf('TR_FACTORY', addDaysKey(first.day, i)) && !holidayOf('TR_FACTORY', addDaysKey(first.day, i)).half);
    }
  }
  // Diyanet takvimine dayanan, iki kaynakla karşılaştırılmış tarihler
  assert.equal(HOLIDAYS.TR[2026].find((h) => h.names.includes('ramazan1')).day, '2026-03-20');
  assert.equal(HOLIDAYS.TR[2026].find((h) => h.names.includes('kurban1')).day, '2026-05-27');
  assert.equal(HOLIDAYS.TR[2027].find((h) => h.names.includes('ramazan1')).day, '2027-03-09');
  assert.equal(HOLIDAYS.TR[2027].find((h) => h.names.includes('kurban1')).day, '2027-05-16');
  assert.deepEqual(holidayOf('TR_FACTORY', '2027-05-19').names, ['kurban4', 'youth'], 'aynı güne iki tatil');
});

// ---------- gün durumu ----------

test('iki takvim bağımsız: Romanya tatili Türkiye fabrikasında açık, Türkiye tatili Romanya deposunda açık; elle karar yalnızca kendi takviminde', () => {
  assert.deepEqual([dayStatus('RO_DEPOT', '2026-11-30').reason, dayStatus('TR_FACTORY', '2026-11-30').reason], ['HOLIDAY', 'WORKDAY']);
  assert.deepEqual([dayStatus('TR_FACTORY', '2026-07-15').reason, dayStatus('RO_DEPOT', '2026-07-15').reason], ['HOLIDAY', 'WORKDAY']);
  const roClosed = new Map([['2026-10-14', { open: false, note: 'envanter' }]]);
  assert.equal(dayStatus('RO_DEPOT', '2026-10-14', roClosed).open, false);
  assert.equal(dayStatus('TR_FACTORY', '2026-10-14', new Map()).open, true, 'Türkiye takviminin kendi kararları ayrı');
  assert.notEqual(CALENDARS.RO_DEPOT.timeZone, CALENDARS.TR_FACTORY.timeZone);
  assert.deepEqual([CALENDARS.RO_DEPOT.timeZone, CALENDARS.TR_FACTORY.timeZone], ['Europe/Bucharest', 'Europe/Istanbul']);
});

test('hafta sonu kapalı; resmî tatil kapalı; elle karar otomatik kuraldan önce gelir (açılan cumartesi / tatil, kapatılan iş günü)', () => {
  assert.equal(weekdayOf('2026-10-10'), 6);
  assert.deepEqual([dayStatus('RO_DEPOT', '2026-10-10').open, dayStatus('RO_DEPOT', '2026-10-10').reason], [false, 'WEEKEND']);
  assert.deepEqual([dayStatus('RO_DEPOT', '2026-12-01').open, dayStatus('RO_DEPOT', '2026-12-01').reason], [false, 'HOLIDAY']);
  const ov = new Map([['2026-10-10', { open: true, note: 'sezon' }], ['2026-12-01', { open: true }], ['2026-10-14', { open: false }]]);
  assert.deepEqual([dayStatus('RO_DEPOT', '2026-10-10', ov).open, dayStatus('RO_DEPOT', '2026-10-10', ov).reason, dayStatus('RO_DEPOT', '2026-10-10', ov).note], [true, 'MANUAL_OPEN', 'sezon']);
  assert.deepEqual([dayStatus('RO_DEPOT', '2026-12-01', ov).open, dayStatus('RO_DEPOT', '2026-12-01', ov).holiday?.names], [true, ['nationalDay']], 'elle açılan tatil açık; tatil adı yine görünür');
  assert.equal(dayStatus('RO_DEPOT', '2026-10-14', ov).reason, 'MANUAL_CLOSED');
  // Yarım gün tatil açık sayılır (işaretli)
  const half = dayStatus('TR_FACTORY', '2026-10-28');
  assert.deepEqual([half.open, half.half, half.reason], [true, true, 'WORKDAY']);
});

test('tatil verisi olmayan yıl: yalnızca hafta sonu ve elle karar; noData işareti; yöneticiye eksik yıl uyarısı', () => {
  assert.equal(hasYearData('RO_DEPOT', 2028), false);
  const st = dayStatus('RO_DEPOT', '2028-01-03'); // pazartesi
  assert.deepEqual([st.open, st.noData, st.holiday], [true, true, null]);
  assert.equal(dayStatus('RO_DEPOT', '2028-01-01').reason, 'WEEKEND', '2028-01-01 cumartesi');
  assert.deepEqual(missingYears('TR_FACTORY', '2026-01-01', '2029-06-01'), [2028, 2029]);
  assert.deepEqual(coverageGaps('RO_DEPOT', '2026-10-08'), [], 'bugünden 180 gün sonrasına kadar veri var');
  assert.deepEqual(coverageGaps('RO_DEPOT', '2027-08-01'), [2028], 'yıl sonuna 180 gün kala bir sonraki yıl istenir');
  assert.equal(holidaysBetween('RO_DEPOT', '2026-12-20', '2027-01-10').map((h) => h.day).join(','), '2026-12-25,2026-12-26,2027-01-01,2027-01-02,2027-01-06,2027-01-07');
  const month = monthDays('TR_FACTORY', '2027-03');
  assert.equal(month.length, 31);
  assert.equal(month.find((d) => d.day === '2027-03-09').reason, 'HOLIDAY');
});

test('yerel saat: Bükreş ve İstanbul saat dilimleri, yaz / kış saati geçişi', () => {
  assert.deepEqual(localClock(new Date('2026-10-24T09:00:00Z'), 'Europe/Bucharest'), { day: '2026-10-24', minutes: 720 }); // EEST +3
  assert.deepEqual(localClock(new Date('2026-10-26T10:00:00Z'), 'Europe/Bucharest'), { day: '2026-10-26', minutes: 720 }); // EET +2
  assert.deepEqual(localClock(new Date('2027-03-29T09:00:00Z'), 'Europe/Bucharest'), { day: '2027-03-29', minutes: 720 }); // EEST +3
  assert.deepEqual(localClock(new Date('2026-10-26T10:00:00Z'), 'Europe/Istanbul'), { day: '2026-10-26', minutes: 780 }); // TRT +3 sabit
  assert.equal(localClock(new Date('2026-10-25T21:59:00Z'), 'Europe/Bucharest').day, '2026-10-25'); // pazar 23:59
  assert.equal(localClock(new Date('2026-10-25T22:00:00Z'), 'Europe/Bucharest').day, '2026-10-26'); // pazartesi 00:00
});

// ---------- profil teslim günü: 12:00 kuralı ----------

test('teslim günü: 11:59 / 12:00 / 12:01 sınırı (12:00 dahil, 12:00:59’a kadar) — yaz ve kış saatinde', () => {
  assert.equal(DEPOT_CUTOFF_MINUTES, 720);
  // Salı 13 Ekim 2026 (EEST, UTC+3)
  assert.equal(ready('2026-10-13T08:59:00Z'), '2026-10-14', '11:59 → çarşamba');
  assert.equal(ready('2026-10-13T09:00:00Z'), '2026-10-14', '12:00 → çarşamba');
  assert.equal(ready('2026-10-13T09:00:59Z'), '2026-10-14', '12:00:59 → çarşamba');
  assert.equal(ready('2026-10-13T09:01:00Z'), '2026-10-15', '12:01 → perşembe');
  // Salı 27 Ekim 2026 (EET, UTC+2 — kış saati; aynı UTC saati bir saat erken)
  assert.equal(ready('2026-10-27T09:59:00Z'), '2026-10-28', 'kış 11:59');
  assert.equal(ready('2026-10-27T10:00:00Z'), '2026-10-28', 'kış 12:00');
  assert.equal(ready('2026-10-27T10:01:00Z'), '2026-10-29', 'kış 12:01');
  assert.equal(ready('2026-10-27T09:01:00Z'), '2026-10-28', 'kış 11:01 (yaz saatiyle olsa 12:01 olurdu)');
  // Yaz saatine geçiş haftası: pazartesi 29 Mart 2027 (EEST)
  assert.equal(ready('2027-03-29T08:59:00Z'), '2027-03-30');
  assert.equal(ready('2027-03-29T09:01:00Z'), '2027-03-31');
});

test('teslim günü: cuma, hafta sonu, pazartesi; gece yarısı sınırı', () => {
  assert.equal(ready('2026-10-09T08:59:00Z'), '2026-10-12', 'cuma 11:59 → pazartesi');
  assert.equal(ready('2026-10-09T09:01:00Z'), '2026-10-13', 'cuma 12:01 → salı');
  assert.equal(ready('2026-10-10T06:00:00Z'), '2026-10-13', 'cumartesi → pazartesi başında işlenir → salı');
  assert.equal(ready('2026-10-11T18:00:00Z'), '2026-10-13', 'pazar akşamı → salı');
  assert.equal(ready('2026-10-12T05:00:00Z'), '2026-10-13', 'pazartesi 08:00 → salı');
  assert.equal(ready('2026-10-12T12:00:00Z'), '2026-10-14', 'pazartesi 15:00 → çarşamba');
  assert.equal(ready('2026-10-25T21:59:00Z'), '2026-10-27', 'pazar 23:59 (kapalı) → salı');
  assert.equal(ready('2026-10-25T22:00:00Z'), '2026-10-27', 'pazartesi 00:00 (öğleden önce) → salı');
});

test('teslim günü: resmî tatil öncesi, tatilde verilen sipariş ve yöneticinin açtığı / kapattığı günler', () => {
  // 30 Kasım (pzt, Sf. Andrei) ve 1 Aralık (salı, Ulusal Gün) kapalı
  assert.equal(ready('2026-11-27T08:00:00Z'), '2026-12-02', 'cuma 10:00 → 30 Kasım / 1 Aralık atlanır → çarşamba');
  assert.equal(ready('2026-11-27T11:00:00Z'), '2026-12-03', 'cuma 13:00 → çarşamba işlenir → perşembe');
  assert.equal(ready('2026-11-30T07:00:00Z'), '2026-12-03', 'tatilde → ilk açık gün (çarşamba) başında işlenir → perşembe');
  assert.equal(ready('2026-12-24T08:00:00Z'), '2026-12-28', 'Noel (25–26) ve hafta sonu atlanır');
  // Yönetici kapattı: o gün atlanır; açtı: o gün sayılır
  assert.equal(ready('2026-10-13T08:00:00Z', new Map([['2026-10-14', { open: false }]])), '2026-10-15');
  assert.equal(ready('2026-10-09T09:01:00Z', new Map([['2026-10-10', { open: true }]])), '2026-10-12', 'açılan cumartesi çalışma günüdür');
  assert.equal(ready('2026-10-10T06:00:00Z', new Map([['2026-10-10', { open: true }]])), '2026-10-12', 'açık cumartesi 09:00 → pazartesi');
  assert.equal(ready('2026-11-27T08:00:00Z', new Map([['2026-11-30', { open: true }]])), '2026-11-30', 'tatil elle açıldı');
  // Hiç açık gün yoksa tahmin uydurulmaz
  const allClosed = new Map(Array.from({ length: 420 }, (_, i) => [addDaysKey('2026-10-13', i), { open: false }]));
  assert.throws(() => depotReadyDay(new Date('2026-10-13T08:00:00Z'), allClosed), NoOpenDayError);
});

test('depoya iletim: alış günü iletim anının kuralına kayar; stok durumu hesaba girmez; görünüm aşaması durum eklemez', () => {
  const r = pickupOnForward({ now: new Date('2026-10-13T10:00:00Z'), pickupDate: new Date('2026-10-14T12:00:00Z') });
  assert.deepEqual([key(r.pickupDate), r.moved, key(r.earliest)], ['2026-10-15', true, '2026-10-15']);
  assert.equal(pickupOnForward.length, 1, 'tek parametre: stok bilgisi verilmez');
  const now = new Date('2026-10-15T08:00:00Z');
  assert.equal(depotPhase({ stage: 'DEPODA', status: 'HAZIRLANIYOR', pickupDate: new Date('2026-10-16T12:00:00Z'), now }), 'PREPARING');
  assert.equal(depotPhase({ stage: 'DEPODA', status: 'HAZIRLANIYOR', pickupDate: new Date('2026-10-15T12:00:00Z'), now }), 'READY');
  assert.equal(depotPhase({ stage: 'TESLIM_EDILDI', status: 'HAZIRLANIYOR', pickupDate: null, now }), 'DELIVERED');
  assert.equal(depotPhase({ stage: 'PROFORMA', status: 'HAZIRLANIYOR', pickupDate: null, now }), null);
  assert.equal(depotPhase({ stage: 'DEPODA', status: 'IPTAL', pickupDate: null, now }), null);
});

// ---------- cam yükleme tarihi ve tedarikçi hatırlatması değişmez ----------

test('cam siparişinin tahmini yükleme formülü değişmedi ve takvimleri kullanmaz (karar 193)', () => {
  assert.equal(key(glassLoadingDate(new Date('2026-09-30T08:00:00Z'))), '2026-10-23');
  assert.equal(key(glassLoadingDate(new Date('2026-10-06T20:00:00Z'))), '2026-10-23');
  assert.equal(key(glassLoadingDate(new Date('2026-10-07T08:00:00Z'))), '2026-10-30');
  assert.equal(key(glassLoadingDate(new Date('2026-10-13T08:00:00Z'))), '2026-10-30');
  // Türkiye tatiline (29 Ekim) denk gelen dönem de yalnızca formülle (kaydırma yok)
  assert.equal(key(glassLoadingDate(new Date('2026-10-14T08:00:00Z'))), '2026-11-06');
  const src = read('server/orders/rules.js');
  assert.ok(!src.includes('calendar/'), 'cam kuralları takvim modülünü içe aktarmaz');
  assert.ok(!read('server/orders/create.js').includes('calendar/'));
});

test('tedarikçi tahmini yükleme: hatırlatma 2 TAKVİM günü önce (değişmedi); Türkiye takvimi yalnızca uyarı verir', () => {
  assert.equal(ETA_REMIND_DAYS, 2);
  // 15 Temmuz 2026 (Türkiye tatili, çarşamba): hatırlatma yine 13 Temmuz'dan itibaren; anahtar tarihe bağlı
  assert.equal(etaReminderDue({ etaDay: '2026-07-15', today: '2026-07-12' }), false);
  assert.equal(etaReminderDue({ etaDay: '2026-07-15', today: '2026-07-13' }), true);
  assert.equal(etaReminderDue({ etaDay: '2026-07-15', today: '2026-07-15' }), true);
  assert.equal(etaReminderDue({ etaDay: '2026-07-15', today: '2026-07-16' }), false);
  assert.equal(etaReminderKey('o1', '2026-07-15'), 'supplier-eta:o1:2026-07-15');
  const w = etaCalendarWarning('2026-07-15');
  assert.deepEqual([w.level, w.reason, w.holiday.names], ['closed', 'HOLIDAY', ['democracy']]);
  assert.deepEqual([etaCalendarWarning('2026-10-10').level, etaCalendarWarning('2026-10-10').reason], ['closed', 'WEEKEND']);
  assert.equal(etaCalendarWarning('2026-10-28').level, 'half');
  assert.equal(etaCalendarWarning('2028-03-01').level, 'noData');
  assert.equal(etaCalendarWarning('2026-10-14'), null);
  assert.equal(etaCalendarWarning('2026-11-30'), null, 'Romanya tatili Türkiye fabrikasını etkilemez');
  assert.equal(etaCalendarWarning('2026-10-14', new Map([['2026-10-14', { open: false }]])).reason, 'MANUAL_CLOSED');
  assert.equal(etaCalendarWarning(null), null);
});

// ---------- yönetici formu ve yapı ----------

test('elle karar formu: takvim, gün ve karar doğrulanır; açıklama sadeleştirilir', () => {
  assert.deepEqual(parseOverride({ calendar: 'RO_DEPOT', day: '2026-12-24', mode: 'CLOSED', note: '  envanter \n sayımı ' }), { ok: true, calendar: 'RO_DEPOT', day: '2026-12-24', mode: 'CLOSED', note: 'envanter sayımı' });
  assert.equal(parseOverride({ calendar: 'RO_DEPOT', day: '2026-12-24', mode: 'AUTO', note: '' }).note, null);
  assert.deepEqual(parseOverride({ calendar: 'XX', day: '2026-12-24', mode: 'OPEN' }), { ok: false, code: 'CALENDAR' });
  assert.deepEqual(parseOverride({ calendar: 'constructor', day: '2026-12-24', mode: 'OPEN' }), { ok: false, code: 'CALENDAR' });
  assert.deepEqual(parseOverride({ calendar: 'TR_FACTORY', day: '2026-02-30', mode: 'OPEN' }), { ok: false, code: 'DAY' });
  assert.deepEqual(parseOverride({ calendar: 'TR_FACTORY', day: '2026-02-03', mode: 'MAYBE' }), { ok: false, code: 'MODE' });
  assert.equal(parseOverride({ calendar: 'TR_FACTORY', day: '2026-02-03', mode: 'OPEN', note: 'x'.repeat(500) }).note.length, 200);
  assert.equal(nextOpenDay('RO_DEPOT', '2026-12-24'), '2026-12-28');
});

test('yapı: takvim kuralları dış servise bağlanmaz; tek yazar setOverride (OPS_SETTINGS_MANAGE, denetim kaydı); profil tarihi takvimden', () => {
  for (const f of ['server/calendar/holidays.js', 'server/calendar/rules.js', 'server/calendar/service.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|https?:\/\/|node:http|node:net/.test(src), `${f} dış bağlantı içermez`);
  }
  const service = read('server/calendar/service.js');
  assert.ok(/if \(!allowed\(actor\)\) return FORBIDDEN;/.test(service));
  assert.ok(service.includes("can(actor.role, 'OPS_SETTINGS_MANAGE')")); // karar 219: operasyonel ayar (yönetici + Yönetici Yardımcısı)
  assert.ok(service.includes("action: 'WORK_CALENDAR_OVERRIDE'"));
  // Takvim istisnasına başka yazar yok
  const writers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p); continue; }
      if (/\.(js|ts|tsx|mjs)$/.test(e.name) && /workCalendarOverride\.(create|update|upsert|delete)/.test(read(p))) writers.push(p);
    }
  };
  for (const d of ['app', 'lib', 'server', 'scripts', 'components']) walk(d);
  assert.deepEqual(writers, ['server/calendar/service.js']);
  assert.ok(read('server/profile/dates.js').includes("from '../calendar/rules.js'"));
  assert.ok(read('server/profile/transitions.js').includes('calendarOverrides('));
});
