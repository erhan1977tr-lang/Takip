// Yeni sipariş (/siparisler/yeni). form: istemci bileşenine (NewOrderForm) giden parça · errors: sunucu işlemi mesajları.
export default {
  title: 'Yeni Sipariş',
  back: '← Siparişlerim',
  // Sipariş tipi seçimi (birden çok tip etkinken)
  selector: {
    title: 'Ne sipariş etmek istiyorsunuz?',
    intro: 'Sipariş tipini seçin.',
    choose: 'Seç',
    desc: {
      GLASS_ORDER: 'Ölçüye göre cam: teknik dosya, çizim onayı ve teklif.',
      PROFILE_ORDER: 'Depodan conta, plastik, alüminyum profil ve aksesuar.',
    },
  },
  form: {
    info: {
      title: 'Sipariş bilgileri',
      shipNote: 'Siparişler haftalık yüklenir. Bu siparişin tahmini yükleme tarihi {date} olarak yazılacak; satış ekibi gerekirse günceller.',
      name: 'Sipariş adı',
      namePlaceholder: 'örn. Duş kabini camı',
      number: 'Sipariş numaranız',
      numberHint: 'Önerilen numara (son siparişinizden bir sonraki) — değiştirebilirsiniz. Sipariş kodu: {code}',
    },
    files: {
      title: 'Sipariş dosyaları (zorunlu)',
      selected: '{n} dosya seçildi',
      pick: 'Dosya seçmek için tıklayın',
      limits: 'PDF · DWG · DXF · STEP · STP · IGS · IGES · XLS · XLSX · DOC · DOCX · ZIP · JPG · PNG — dosya başına en fazla 100 MB, toplam 250 MB',
    },
    glass: {
      title: 'İstediğiniz cam kombinasyonu (zorunlu)',
      intro: 'Hangi camı istediğinizi katalogdan seçin. Ölçüleri ve fiyatı satış ekibi girecek.',
      catalogEmpty: 'Cam kataloğu henüz boş. Lütfen yöneticinize başvurun.',
      glass: 'Cam',
      pick: '— katalogdan seçin —',
      qty: 'Adet',
      remove: 'Kaldır',
      add: '+ Cam ekle',
    },
    submit: {
      needFile: 'Göndermek için en az bir dosya yüklemelisiniz.',
      needGlass: 'Cam kombinasyonu seçmelisiniz.',
      sending: 'Gönderiliyor…',
      send: 'Siparişi gönder',
    },
  },
  errors: {
    noFirm: 'Hesabınız bir müşteri firmasına bağlı değil. Yöneticinize başvurun.',
    titleRequired: 'Sipariş adı gerekli.',
    badNumber: 'Sipariş numarası pozitif bir tam sayı olmalı.',
    noFiles: 'En az bir sipariş dosyası yükleyin.',
    tooManyFiles: 'Tek seferde en fazla 20 dosya yükleyebilirsiniz.',
    noGlass: 'En az bir cam kombinasyonu seçin.',
    glassGone: 'Seçilen camlardan biri artık katalogda yok; sayfayı yenileyip tekrar seçin.',
    badQty: 'Cam adedi pozitif bir tam sayı olmalı.',
    duplicate: '{orderNo} numaralı bir sipariş zaten var; farklı bir numara girin.',
    saveFailed: 'Sipariş kaydedilemedi, lütfen tekrar deneyin.',
  },
};
