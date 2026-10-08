// Resmî tatil verisi (Paket 8, karar 192) — Romanya deposu ve Türkiye fabrikası çalışma takvimlerinin TEK tatil kaynağı.
// Kodla birlikte gelir ve sürümlenir: sayfa açılışında, hesapta ya da işçide hiçbir dış servise bağlanılmaz. Bir yıl ancak
// iki bağımsız kaynakla doğrulandıktan sonra eklenir; doğrulanmamış yıl TAHMİN EDİLMEZ. Verisi olmayan yılda takvim
// yalnızca hafta sonunu ve yöneticinin elle girdiği açık / kapalı günleri bilir ve yöneticiye açık uyarı gösterilir
// (server/calendar/rules.js → missingYears; Ayarlar → Çalışma Takvimleri). Yeni yıl eklemek = bu dosyaya doğrulanmış
// satırları eklemek + HOLIDAY_DATA_VERSION'ı güncellemek + test/calendar.test.js'i çalıştırmak.
//
// Romanya — Codul muncii (Legea 53/2003) md. 139 (6 ve 7 Ocak Legea 17/2024 ile eklendi). Paște (Vinerea Mare, iki gün
//   Paște) ve Rusalii (iki gün) ortodoks takvimine göredir; test/calendar.test.js bu günleri Julian computus ile ayrıca
//   hesaplayıp veriyle karşılaştırır. Kaynaklar: 2026 — digi24.ro "Zile libere în 2026"; 2027 — observatornews.ro
//   "Zile libere în 2027" ve officeholidays.com/countries/romania/2027 (iki kaynak aynı 17 günü verir).
// Türkiye — 2429 sayılı Ulusal Bayram ve Genel Tatiller Hakkında Kanun. Ramazan ve Kurban Bayramı tarihleri Diyanet İşleri
//   Başkanlığı takvimine göredir. Kaynaklar: 2026 — cnnturk.com "2026'da hangi günler resmi tatil"; 2027 — cnnturk.com
//   "2027 resmi tatiller takvimi" (Diyanet takvimine dayanır) ve etstur.com "Resmi Tatil Günleri 2027" (aynı tarihler).
//   Arife günleri ve 28 Ekim YARIM gündür (13:00'ten sonra): yarım gün kapalı gün sayılmaz (half: true) — takvim ekranında
//   ve tedarikçi tahmini yükleme uyarısında ayrıca belirtilir.
//
// Satır biçimi: [gün, ad anahtarları (calendar.holiday.<ÜLKE>.<anahtar>; bir gün birden çok tatile denk gelebilir), yarım gün mü].

export const HOLIDAY_DATA_VERSION = '2026-10-08';

/** @typedef {{ day: string, names: string[], half: boolean }} Holiday */

const rows = (list) => list.map(([day, names, half = false]) => Object.freeze({ day, names: Object.freeze([...names]), half }));

export const HOLIDAYS = Object.freeze({
  RO: Object.freeze({
    2026: rows([
      ['2026-01-01', ['newYear']],
      ['2026-01-02', ['newYear2']],
      ['2026-01-06', ['epiphany']],
      ['2026-01-07', ['stJohn']],
      ['2026-01-24', ['union']],
      ['2026-04-10', ['goodFriday']],
      ['2026-04-12', ['easter']],
      ['2026-04-13', ['easterMonday']],
      ['2026-05-01', ['labour']],
      ['2026-05-31', ['pentecost']],
      ['2026-06-01', ['childrenDay', 'pentecostMonday']],
      ['2026-08-15', ['assumption']],
      ['2026-11-30', ['stAndrew']],
      ['2026-12-01', ['nationalDay']],
      ['2026-12-25', ['christmas']],
      ['2026-12-26', ['christmas2']],
    ]),
    2027: rows([
      ['2027-01-01', ['newYear']],
      ['2027-01-02', ['newYear2']],
      ['2027-01-06', ['epiphany']],
      ['2027-01-07', ['stJohn']],
      ['2027-01-24', ['union']],
      ['2027-04-30', ['goodFriday']],
      ['2027-05-01', ['labour']],
      ['2027-05-02', ['easter']],
      ['2027-05-03', ['easterMonday']],
      ['2027-06-01', ['childrenDay']],
      ['2027-06-20', ['pentecost']],
      ['2027-06-21', ['pentecostMonday']],
      ['2027-08-15', ['assumption']],
      ['2027-11-30', ['stAndrew']],
      ['2027-12-01', ['nationalDay']],
      ['2027-12-25', ['christmas']],
      ['2027-12-26', ['christmas2']],
    ]),
  }),
  TR: Object.freeze({
    2026: rows([
      ['2026-01-01', ['newYear']],
      ['2026-03-19', ['ramazanEve'], true],
      ['2026-03-20', ['ramazan1']],
      ['2026-03-21', ['ramazan2']],
      ['2026-03-22', ['ramazan3']],
      ['2026-04-23', ['sovereignty']],
      ['2026-05-01', ['labour']],
      ['2026-05-19', ['youth']],
      ['2026-05-26', ['kurbanEve'], true],
      ['2026-05-27', ['kurban1']],
      ['2026-05-28', ['kurban2']],
      ['2026-05-29', ['kurban3']],
      ['2026-05-30', ['kurban4']],
      ['2026-07-15', ['democracy']],
      ['2026-08-30', ['victory']],
      ['2026-10-28', ['republicEve'], true],
      ['2026-10-29', ['republic']],
    ]),
    2027: rows([
      ['2027-01-01', ['newYear']],
      ['2027-03-08', ['ramazanEve'], true],
      ['2027-03-09', ['ramazan1']],
      ['2027-03-10', ['ramazan2']],
      ['2027-03-11', ['ramazan3']],
      ['2027-04-23', ['sovereignty']],
      ['2027-05-01', ['labour']],
      ['2027-05-15', ['kurbanEve'], true],
      ['2027-05-16', ['kurban1']],
      ['2027-05-17', ['kurban2']],
      ['2027-05-18', ['kurban3']],
      ['2027-05-19', ['kurban4', 'youth']],
      ['2027-07-15', ['democracy']],
      ['2027-08-30', ['victory']],
      ['2027-10-28', ['republicEve'], true],
      ['2027-10-29', ['republic']],
    ]),
  }),
});
