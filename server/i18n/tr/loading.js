// Yükleme takvimi (/yuklemeler). Ay ve gün adları sözlükte değil, lib/format.ts'te (fmtMonth, weekdayNames).
export default {
  title: 'Yüklemeler',
  titleCustomer: 'Yükleme takvimim',
  intro: 'Yükleme gününe göre gruplanmış işler. Beklemeye alınanlar bu listede görünmez.',
  introCustomer: 'Siparişlerinizin hangi gün yükleneceği. Bir güne tıklayınca o günün siparişleri açılır.',
  tabs: {
    calendar: 'Takvim',
    list: 'Liste',
  },
  nav: {
    prev: '‹ Önceki ay',
    next: 'Sonraki ay ›',
    thisMonth: 'Bu ay',
    goToDay: 'Güne git',
    go: 'Git',
  },
  // {orders}: "12 sipariş" (sayı kalın)
  monthTotal: 'Ay toplamı: {orders} · {m2} m² · {kg} kg cam',
  today: 'bugün',
  list: {
    empty: 'Bu ay yükleme yok.',
    cols: {
      day: 'Yükleme günü',
      orders: 'Sipariş',
      orderList: 'Siparişler',
      customers: 'Müşteriler',
      metraj: 'Metraj',
      glass: 'Cam',
      crates: 'Sandık',
      gross: 'Brüt',
    },
  },
  day: {
    title: 'Yükleme: {date}',
    empty: 'Bu gün için yükleme yok.',
    stats: {
      orders: 'Sipariş',
      metraj: 'Toplam metraj',
      glass: 'Cam adedi',
      gross: 'Brüt ağırlık',
      crates: 'Sandık',
    },
    // {crates}: "2 sandık"
    estimate: "Planlama tahmini: brüt = cam {netKg} kg + {crates} × {tare} kg dara (cam ağırlığı müşteri başına azami {max} kg'a bölünüp yukarı yuvarlanıyor).",
    note: 'Satış siparişe sandık ölçü ve ağırlıklarını girdiyse o siparişte GERÇEK kayıtlar kullanılır ve tahminin önüne geçer. Cam ağırlığı teklifteki cam kalınlığından hesaplanır (mm başına 2,5 kg/m²).',
    cols: {
      order: 'Sipariş',
      customerOrder: 'Müşteri / sipariş',
      orders: 'Sipariş',
      glass: 'Cam',
      cnc: 'CNC',
      holes: 'Delik',
      metraj: 'Metraj',
      net: 'Net ağırlık',
      crates: 'Sandık',
      gross: 'Brüt ağırlık',
      amount: 'Teklif tutarı',
    },
    real: 'gerçek',
    estimated: 'tahmini',
  },
};
