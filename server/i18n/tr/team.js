// Satışçı–çizimci bazlı sipariş sorumluluğu (4.3.0, karar 300): atama, yönlendirme, hata ve engel metinleri.
export default {
  // Müşterinin gördüğü iç ekip kişisi: ad yok, nötr rol etiketi
  staffLabel: 'GKH · {role}',
  errors: {
    NO_DRAWER: 'Bu siparişin çizimcisi yok: sorumlu satışçıya Kullanıcılar ekranında varsayılan çizimci tanımlayın, sonra yeniden deneyin.',
    SALES_UNASSIGNED: 'Bu siparişin sorumlu satışçısı yok. Önce yönetici siparişi bir satışçıya atamalıdır.',
    SALES_TARGET: 'Seçilen kullanıcı etkin bir satışçı değil.',
    SALES_SAME: 'Sipariş zaten bu satışçıda.',
    NOT_LINKED: 'Geçmiş siparişler henüz bir satış hesabına bağlanmadı; atama ve yönlendirme bağlama işleminden sonra açılır.',
    REASSIGN_BLOCKED: 'Sipariş başka satışçıya yönlendirilemez:',
  },
  // Başka satışçıya yönlendirmenin engelleri (server/orders/sales-routing.js → reassignBlocks)
  block: {
    NOT_GLASS: 'yalnızca cam siparişi yönlendirilir',
    CLOSED: 'sipariş kapanmış ya da silinmiş',
    SUBMITTED: 'teklif daha önce yöneticiye gönderildi (geri çekme sınırı sıfırlamaz)',
    DRAWING: 'çizim çalışması başladı',
    PDF_IMPORT: 'fabrika PDF\'i aktarıldı (maliyet bilgisi var)',
    CRATES: 'sandığa bağlandı',
    LOADED: 'yükleme onayında kaydı var',
    DOCUMENTS: 'mali belgesi ya da ödeme kaydı var',
    COMPENSATION: 'telafi kaydı var',
    INTERNAL_NOTES: 'önceki ekibin iç notu var (diğer ekibe açılmaması için)',
    INTERNAL_FILES: 'önceki ekibin iç dosyası var (diğer ekibe açılmaması için)',
  },
  assign: {
    title: 'Sorumlu satışçı',
    unassigned: 'Atama bekliyor — sipariş yalnızca yöneticide; satış ve çizim ekibine görev, erişim ve bildirim gitmez.',
    owner: 'Satışçı',
    drawer: 'Çizimci',
    noDrawer: 'çizimci yok',
    via: { AUTO: 'otomatik yönlendirme', MANUAL: 'yönetici ataması', REASSIGN: 'yönetici yönlendirmesi', MIGRATION: 'geçmiş veri bağlantısı' },
    pick: 'Satışçı seçin',
    submitAssign: 'Satışçıya ata',
    submitReassign: 'Başka satışçıya yönlendir',
    confirmAssign: 'Sipariş {name} satışçısına atanacak; çizimcisi {drawer} olacak. Devam edilsin mi?',
    confirmReassign: 'Sipariş {name} satışçısına yönlendirilecek: önceki ekibin erişimi kapanır, çizimci {drawer} olur, taslak satış fiyatları yeni satışçının tablosundan yeniden doldurulur. Devam edilsin mi?',
    reassignClosed: 'Başka satışçıya yönlendirilemez:',
    noSales: 'Etkin satışçı yok.',
    notLinked: 'Atama, geçmiş siparişler bir satış hesabına bağlandıktan sonra açılır.',
    ok: 'Sorumlu satışçı kaydedildi.',
  },
};
