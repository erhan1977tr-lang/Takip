// Sabit tahmini yükleme tarihi (4.2.34) — saf kurallar + yapı. Tarih / saat hep ENJEKTE edilir; DB yok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_MAX_DAYS, LOADING_DATE_SETTING_KEY, activeFixedDay, glassShipDate, parseKindInput, parseLoadingDateSetting,
  profilePickupFloor, saveLoadingDateSetting, validDay,
} from '../server/orders/loading-date-setting.js';
import { glassLoadingDate } from '../server/orders/rules.js';
import { depotReadyDay, earliestPickup, pickupProblem } from '../server/profile/dates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const key = (d) => d.toISOString().slice(0, 10);
const D = (k) => new Date(`${k}T12:00:00.000Z`);
const TZ = 'Europe/Bucharest';
const NOW = new Date('2026-11-26T09:00:00Z'); // Perşembe 11:00 Bükreş
const FIXED = (date) => ({ mode: 'FIXED', date });

test('varsayılan: ayar yok / bozuk → iki tür de otomatik (bugünkü davranış değişmez)', () => {
  for (const v of [undefined, null, {}, [], 'x', { glass: 'FIXED' }, { glass: { mode: 'FIXED', date: '2027-02-30' } }, { profile: { mode: 'NOPE', date: '2027-01-15' } }]) {
    const s = parseLoadingDateSetting(v);
    assert.equal(s.glass.mode, 'AUTO');
    assert.equal(s.profile.mode, 'AUTO');
    assert.equal(activeFixedDay(s, 'glass', '2026-11-26'), null);
    assert.equal(activeFixedDay(s, 'profile', '2026-11-26'), null);
    assert.equal(key(glassShipDate(s, NOW, TZ)), key(glassLoadingDate(NOW, TZ)), 'otomatik = tek hesap');
    assert.equal(profilePickupFloor(s, NOW), null);
  }
  assert.equal(LOADING_DATE_SETTING_KEY, 'loading-date');
});

test('cam: sabit gün seçiliyse yeni siparişin tarihi o gün; profil ayarı camı etkilemez', () => {
  const s = parseLoadingDateSetting({ glass: FIXED('2027-01-15'), profile: { mode: 'AUTO', date: null } });
  assert.equal(key(glassShipDate(s, NOW, TZ)), '2027-01-15');
  assert.equal(glassShipDate(s, NOW, TZ).toISOString(), '2027-01-15T12:00:00.000Z', 'gün ortası UTC (diğer tarihlerle aynı gösterim)');
  assert.equal(profilePickupFloor(s, NOW), null);
  // Sabit gün otomatik günden önce olsa da kullanılır (yöneticinin bilinçli seçimi), bugün de olabilir
  const early = parseLoadingDateSetting({ glass: FIXED('2026-11-26') });
  assert.equal(key(glassShipDate(early, NOW, TZ)), '2026-11-26');
});

test('sabit gün geçince kendiliğinden otomatik hesaba döner (eski tarih asla yazılmaz)', () => {
  const s = parseLoadingDateSetting({ glass: FIXED('2027-01-15'), profile: FIXED('2027-01-15') });
  const after = new Date('2027-01-16T08:00:00Z');
  assert.equal(activeFixedDay(s, 'glass', '2027-01-15'), '2027-01-15', 'günün kendisi geçerli');
  assert.equal(activeFixedDay(s, 'glass', '2027-01-16'), null);
  assert.equal(key(glassShipDate(s, after, TZ)), key(glassLoadingDate(after, TZ)));
  assert.equal(profilePickupFloor(s, after), null);
  // Gün sınırı işletmenin saat diliminde: 15.01 23:30 Bükreş hâlâ 15.01
  assert.equal(key(glassShipDate(s, new Date('2027-01-15T21:30:00Z'), TZ)), '2027-01-15');
  assert.equal(key(glassShipDate(s, new Date('2027-01-15T22:30:00Z'), TZ)), key(glassLoadingDate(new Date('2027-01-15T22:30:00Z'), TZ)));
});

test('profil: sabit gün en erken alış gününe alt sınırdır; depo kuralı daha geçse o kazanır; kapalı gün ileri kayar', () => {
  const ready = key(depotReadyDay(NOW));
  assert.equal(key(earliestPickup({ now: NOW })), ready, 'floor yok = bugünkü kural');
  assert.equal(key(earliestPickup({ now: NOW, floor: null })), ready);
  assert.equal(key(earliestPickup({ now: NOW, floor: '2027-01-15' })), '2027-01-15', '15.01.2027 Cuma, açık gün');
  assert.equal(key(earliestPickup({ now: NOW, floor: '2026-11-20' })), ready, 'geçmiş / erken alt sınır etkisiz');
  assert.equal(key(earliestPickup({ now: NOW, floor: '2027-01-16' })), '2027-01-18', 'Cumartesi → Pazartesi');
  assert.equal(key(earliestPickup({ now: NOW, floor: '2026-12-25' })), '2026-12-28', 'Noel (RO tatili) + hafta sonu');
});

test('profil: müşteri sabit günden önce seçemez (PICKUP_TOO_EARLY); yönetici etkilenmez; floor yoksa eski sonuç', () => {
  const floor = '2027-01-15';
  assert.equal(pickupProblem(D('2026-12-03'), { now: NOW }), null, 'floor yok: eski kural');
  assert.equal(pickupProblem(D('2026-12-03'), { now: NOW, floor }), 'PICKUP_TOO_EARLY');
  assert.equal(pickupProblem(D('2027-01-14'), { now: NOW, floor }), 'PICKUP_TOO_EARLY');
  assert.equal(pickupProblem(D('2027-01-15'), { now: NOW, floor }), null);
  assert.equal(pickupProblem(D('2027-01-20'), { now: NOW, floor }), null);
  assert.equal(pickupProblem(D('2026-12-03'), { now: NOW, floor, staff: true }), null, 'yönetici en erken kurala bağlı değil');
});

test('form doğrulaması: sabit seçiliyken gün zorunlu, geçmiş olamaz, en fazla 366 gün ileri; otomatikte gün saklanır ama kullanılmaz', () => {
  const today = '2026-11-26';
  assert.deepEqual(parseKindInput({ fixed: false, date: '' }, today), { ok: true, value: { mode: 'AUTO', date: null } });
  assert.deepEqual(parseKindInput({ fixed: false, date: '2027-01-15' }, today), { ok: true, value: { mode: 'AUTO', date: '2027-01-15' } });
  assert.deepEqual(parseKindInput({ fixed: true, date: '2027-01-15' }, today), { ok: true, value: { mode: 'FIXED', date: '2027-01-15' } });
  assert.deepEqual(parseKindInput({ fixed: true, date: today }, today), { ok: true, value: { mode: 'FIXED', date: today } });
  assert.equal(parseKindInput({ fixed: true, date: '' }, today).code, 'BAD_DATE');
  assert.equal(parseKindInput({ fixed: true, date: '15/01/2027' }, today).code, 'BAD_DATE');
  assert.equal(parseKindInput({ fixed: true, date: '2027-02-29' }, today).code, 'BAD_DATE');
  assert.equal(parseKindInput({ fixed: true, date: '2026-11-25' }, today).code, 'PAST_DATE');
  assert.equal(parseKindInput({ fixed: true, date: '2027-11-28' }, today).code, 'TOO_FAR');
  assert.equal(parseKindInput({ fixed: true, date: '2027-11-27' }, today).ok, true, 'tam 366 gün');
  assert.equal(FIXED_MAX_DAYS, 366);
  assert.equal(validDay('2028-02-29'), true);
  assert.equal(validDay('2027-13-01'), false);
});

/** Ayar satırını ve denetim kaydını tutan küçük sahte DB */
function fakeDb(initial) {
  const rows = new Map(initial ? [[LOADING_DATE_SETTING_KEY, { value: initial }]] : []);
  const audits = [];
  const tx = {
    integrationSetting: {
      findUnique: async ({ where }) => rows.get(where.key) ?? null,
      upsert: async ({ where, create, update }) => { rows.set(where.key, rows.has(where.key) ? update : create); },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
  };
  return { rows, audits, db: { ...tx, $transaction: (fn) => fn(tx) } };
}
const admin = { id: 'u1', role: 'ADMIN', ip: '127.0.0.1' };

test('kayıt: yalnızca SETTINGS_MANAGE; geçersiz gün hiçbir şey yazmaz; değişiklik denetime yazılır; aynı değer yazılmaz', async () => {
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) {
    const f = fakeDb();
    assert.deepEqual(await saveLoadingDateSetting(f.db, { glass: { fixed: true, date: '2027-01-15' }, profile: { fixed: false }, actor: { id: 'x', role }, now: NOW }), { ok: false, code: 'FORBIDDEN' });
    assert.equal(f.rows.size, 0);
  }
  const bad = fakeDb();
  const r = await saveLoadingDateSetting(bad.db, { glass: { fixed: false }, profile: { fixed: true, date: '2026-01-01' }, actor: admin, now: NOW });
  assert.deepEqual(r, { ok: false, code: 'PAST_DATE', kind: 'profile' });
  assert.equal(bad.rows.size, 0);
  assert.equal(bad.audits.length, 0);

  const f = fakeDb();
  const ok = await saveLoadingDateSetting(f.db, { glass: { fixed: true, date: '2027-01-15' }, profile: { fixed: false, date: '' }, actor: admin, now: NOW });
  assert.deepEqual(ok, { ok: true, changed: true });
  const saved = parseLoadingDateSetting(f.rows.get(LOADING_DATE_SETTING_KEY).value);
  assert.deepEqual(saved, { glass: { mode: 'FIXED', date: '2027-01-15' }, profile: { mode: 'AUTO', date: null } });
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].action, 'LOADING_DATE_SETTING');
  const again = await saveLoadingDateSetting(f.db, { glass: { fixed: true, date: '2027-01-15' }, profile: { fixed: false, date: '' }, actor: admin, now: NOW });
  assert.deepEqual(again, { ok: true, changed: false });
  assert.equal(f.audits.length, 1);
});

test('yapı: sipariş oluşturma, Yeni Sipariş formu ve profil seçim noktaları aynı ayarı kullanır; ikinci formül yok', () => {
  const create = read('server/orders/create.js');
  assert.match(create, /glassShipDate\(parseLoadingDateSetting\(/);
  assert.doesNotMatch(create, /glassLoadingDate\(/, 'yeni sipariş doğrudan otomatik hesabı çağırmaz — ayar üzerinden');
  const page = read('app/(panel)/siparisler/yeni/page.tsx');
  assert.match(page, /shipDate=\{fmtDate\(glassShipDate\(await getLoadingDateSetting\(db\)/, 'formdaki bilgi = kaydedilecek tarih');
  assert.match(page, /floor: profilePickupFloor\(await getLoadingDateSetting\(db\), now\) \}\)/);
  assert.match(read('app/(panel)/siparisler/[id]/ProfileOrderView.tsx'), /earliestPickup\(\{ now, overrides, floor: pickupFloor \}\)/);
  assert.match(read('server/profile/create.js'), /pickupProblem\(day, \{ now, overrides, staff: false, floor \}\)/);
  assert.match(read('server/profile/transitions.js'), /const floor = isStaff\(h\) \? null : profilePickupFloor\(/);
  // Mevcut siparişlere dokunmaz: ayar modülü yalnızca ayar satırı + denetim yazar
  const mod = read('server/orders/loading-date-setting.js');
  assert.doesNotMatch(mod, /\.order\.|profileOrder\./);
  // Depoya iletim kuralı değişmedi (pickupOnForward alt sınır almaz)
  assert.doesNotMatch(read('server/profile/dates.js'), /export function pickupOnForward\(\{[^}]*floor/);
  // Eylem yetkisi
  assert.match(read('app/(panel)/admin/entegrasyonlar/actions.ts'), /export async function saveLoadingDateAction\(formData: FormData\) \{\n  const user = await requirePermission\('SETTINGS_MANAGE'\);/);
});
