// Müşterinin kur politikası (Aşama 7D-1): müşteri formu ve Finans / FGO bölümü
export default {
  title: "Kur politikası",
  intro: "Bu müşterinin EUR tekliflerinde FGO belgelerinin (proforma / fatura) RON'a çevrildiği kur — cam ve profil siparişleri. Kesilmiş belgeler değişmez.",
  policyLabel: "Politika",
  policy: {
    BT_UNIT_SELL: "BT satış kuru – BT şubelerinde (în unitățile BT)",
    BNR: "BNR kuru",
    BNR_PLUS_PERCENT: "BNR kuru + %",
  },
  policyWithPercent: "BNR kuru + %{percent}",
  percent: "BNR kuruna eklenecek yüzde (%)",
  percentHint: "Ör.: 2 = %2. 0 ile {max} arası, en çok 3 ondalık.",
  todayTitle: "Bu müşteri için bugünün kuru",
  docTitle: "Belgenin kuru",
  row: {
    base: { BNR: "BNR kuru", BT: "BT kuru (în unitățile BT)", MANUAL: "Elle girilen kur" },
    percent: "Yüzde",
    final: "Uygulanan kur",
    source: "Kaynak",
    sourceDate: "Kur günü",
  },
  rate: "{rate} RON / {currency}",
  source: {
    BNR: "BNR",
    MANUAL: "ELLE — yönetici bu belge için girdi",
    MANUAL_DAY: "ELLE — günün BT kuru (Entegrasyonlar)",
  },
  manualBadge: "ELLE",
  btAutoNote: "BT „În unitățile BT → Vânzare” kuru otomatik alınamıyor. Entegrasyonlar'a elle girilen günün BT kuru kullanılır; BT'nin XML dosyasındaki kur bu politikada kullanılmaz.",
  unavailable: {
    BT_MANUAL_REQUIRED: "BT „În unitățile BT → Vânzare” kuru otomatik alınamıyor ve bugünün kuru girilmemiş. Entegrasyonlar → Günün BT kuru (elle) bölümüne girin ya da belgeyi isterken kuru elle yazın. BT'nin XML dosyasındaki kur kullanılmaz.",
    BNR_UNAVAILABLE: "BNR kuru şu an alınamadı. Belge bekler ve yeniden denenir; belgeyi isterken kuru elle de yazabilirsiniz.",
    OTHER: "Kur belirlenemedi: {error}",
  },
  integrationsLink: "Entegrasyonlar → Günün BT kuru",
  manualLabel: "Elle kur (isteğe bağlı)",
  manualHint: "Doldurursanız belge müşterinin politikası yerine bu kurla kesilir ve ELLE diye işaretli kalır.",
  unknownPolicy: "—",
  errors: {
    BAD_POLICY: "Kur politikası geçersiz.",
    BAD_PERCENT: "„BNR kuru + %” için yüzde 0 ile 20 arasında, en çok 3 ondalıklı bir sayı olmalı (ör.: 2 ya da 2,5).",
  },
};
