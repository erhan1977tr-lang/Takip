// Gizlilik politikası metni (herkese açık /privacy sayfası). Metin uygulamanın gerçekte işlediği verileri anlatır;
// yeni bir veri, dış hizmet ya da saklama süresi eklenirse burası da güncellenir (üç dil birlikte).

export type PolicySection = { h: string; p?: string[]; li?: string[] };
export type Policy = { title: string; updatedLabel: string; intro: string; sections: PolicySection[] };

/** Son güncelleme (sayfada gösterilir) */
export const POLICY_UPDATED = '12.10.2026';

const CONTACT = 'info@gkh.ro · +40 736 947 797';

export const POLICY: Record<'ro' | 'tr' | 'en', Policy> = {
  ro: {
    title: 'Politica de confidențialitate',
    updatedLabel: 'Ultima actualizare',
    intro:
      'Această politică explică ce date personale prelucrează aplicația TAKİP (https://takip.gkh.ro), portalul de comenzi și producție al GKH TRADING INVEST SRL, de ce, cât timp le păstrăm și ce drepturi aveți conform Regulamentului (UE) 2016/679 (GDPR).',
    sections: [
      {
        h: '1. Operatorul de date',
        p: [`GKH TRADING INVEST SRL, România. Contact pentru protecția datelor: ${CONTACT}.`],
      },
      {
        h: '2. Ce date prelucrăm',
        li: [
          'Date de cont: nume, adresă de e-mail, telefon (opțional), limba preferată, rolul în aplicație, parola (stocată doar ca hash) și codurile de activare (stocate doar ca hash).',
          'Date despre firma client: denumire, persoană de contact, e-mail, e-mail de facturare, telefon, adresă, cod fiscal.',
          'Date despre comenzi: comenzi, oferte, prețuri, desene și fișiere încărcate, note și mesaje, documente de livrare, date de încărcare și ridicare (inclusiv telefonul și numărul de înmatriculare al vehiculului, dacă le introduceți).',
          'Documente financiare: proforme, facturi și plăți legate de comenzi.',
          'Date tehnice și de securitate: jurnal de autentificare (cont, reușită/eșec, adresă IP, țara determinată din IP, data și ora) și jurnal de audit al acțiunilor din aplicație.',
        ],
      },
      {
        h: '3. Scopuri și temei legal',
        li: [
          'Executarea contractului și a comenzilor (art. 6 alin. 1 lit. b GDPR): gestionarea conturilor, comenzilor, desenelor, ofertelor, producției și livrărilor.',
          'Obligații legale (art. 6 alin. 1 lit. c): emiterea și păstrarea documentelor contabile și fiscale.',
          'Interes legitim (art. 6 alin. 1 lit. f): securitatea aplicației (jurnale de autentificare, limitarea încercărilor, scanarea antivirus a fișierelor), copii de rezervă și prevenirea fraudei.',
        ],
      },
      {
        h: '4. Cookie-uri',
        p: [
          'Folosim doar cookie-uri strict necesare: cookie-ul de sesiune (takip_session), cookie-ul temporar pentru setarea parolei (takip_setup) și cookie-ul de limbă (păstrat 1 an). Nu folosim cookie-uri de analiză, publicitate sau urmărire și nu încărcăm scripturi terțe.',
        ],
      },
      {
        h: '5. Cui transmitem datele',
        p: ['Nu vindem și nu închiriem date personale. Folosim următorii furnizori, strict pentru funcționarea aplicației:'],
        li: [
          'Contabo GmbH: serverul pe care rulează aplicația și baza de date.',
          'Google (Google Drive): copii de rezervă zilnice ale bazei de date și fișierelor.',
          'Google Cloud Translation: textul notelor din comenzi, pentru traducerea automată între română și turcă.',
          'FGO (fgo.ro): emiterea proformelor și facturilor, cu datele de facturare ale clientului.',
          'Furnizorul nostru de e-mail (SMTP): trimiterea notificărilor, codurilor de activare și documentelor pe e-mail.',
          'Autorități publice, atunci când legea ne obligă.',
        ],
      },
      {
        h: '6. Transferuri în afara SEE',
        p: [
          'Unii furnizori (de exemplu Google) pot prelucra date în afara Spațiului Economic European. În aceste cazuri transferul se face pe baza garanțiilor prevăzute de GDPR (clauze contractuale standard sau decizia de adecvare UE-SUA).',
        ],
      },
      {
        h: '7. Cât timp păstrăm datele',
        li: [
          'Datele de cont și de comenzi: pe durata relației comerciale și ulterior cât este necesar pentru obligațiile legale.',
          'Documente contabile: 10 ani, conform legislației din România.',
          'Jurnalul de autentificare: 365 de zile, apoi se șterge automat.',
          'Copii de rezervă: ultimele 14 zile.',
        ],
      },
      {
        h: '8. Securitate',
        p: [
          'Conexiune criptată (HTTPS), parole și coduri stocate doar ca hash, acces pe roluri verificat pe server, deconectare automată după 30 de minute de inactivitate, scanare antivirus a fișierelor încărcate și copii de rezervă zilnice.',
        ],
      },
      {
        h: '9. Drepturile dumneavoastră',
        p: [
          `Aveți dreptul de acces, rectificare, ștergere, restricționare, portabilitate și opoziție. Pentru exercitarea lor scrieți-ne la ${CONTACT}. Aveți și dreptul de a depune o plângere la Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP, www.dataprotection.ro).`,
        ],
      },
      {
        h: '10. Modificări',
        p: ['Putem actualiza această politică; versiunea curentă este întotdeauna publicată la https://takip.gkh.ro/privacy.'],
      },
    ],
  },
  tr: {
    title: 'Gizlilik Politikası',
    updatedLabel: 'Son güncelleme',
    intro:
      'Bu politika, GKH TRADING INVEST SRL’nin sipariş ve üretim portalı TAKİP (https://takip.gkh.ro) uygulamasının hangi kişisel verileri, neden işlediğini, ne kadar sakladığını ve (AB) 2016/679 Genel Veri Koruma Tüzüğü (GDPR) kapsamındaki haklarınızı açıklar.',
    sections: [
      {
        h: '1. Veri sorumlusu',
        p: [`GKH TRADING INVEST SRL, Romanya. Veri koruma iletişimi: ${CONTACT}.`],
      },
      {
        h: '2. Hangi verileri işliyoruz',
        li: [
          'Hesap bilgileri: ad, e-posta adresi, telefon (isteğe bağlı), dil tercihi, uygulamadaki rol, şifre (yalnızca özet/hash olarak) ve etkinleştirme kodları (yalnızca özet olarak).',
          'Müşteri firma bilgileri: firma adı, yetkili kişi, e-posta, fatura e-postası, telefon, adres, vergi numarası.',
          'Sipariş bilgileri: siparişler, teklifler, fiyatlar, çizimler ve yüklenen dosyalar, notlar ve mesajlar, teslim belgeleri, yükleme ve teslim alma bilgileri (girerseniz aracın telefonu ve plakası dahil).',
          'Mali belgeler: siparişlere bağlı proforma, fatura ve ödemeler.',
          'Teknik ve güvenlik bilgileri: giriş kaydı (hesap, başarılı/başarısız, IP adresi, IP’den belirlenen ülke, tarih ve saat) ve uygulamadaki işlemlerin denetim kaydı.',
        ],
      },
      {
        h: '3. Amaçlar ve hukuki dayanak',
        li: [
          'Sözleşmenin ve siparişlerin yerine getirilmesi (GDPR md. 6/1-b): hesap, sipariş, çizim, teklif, üretim ve yükleme yönetimi.',
          'Yasal yükümlülükler (md. 6/1-c): muhasebe ve vergi belgelerinin düzenlenmesi ve saklanması.',
          'Meşru menfaat (md. 6/1-f): uygulama güvenliği (giriş kayıtları, deneme sınırı, yüklenen dosyaların virüs taraması), yedekleme ve dolandırıcılığın önlenmesi.',
        ],
      },
      {
        h: '4. Çerezler',
        p: [
          'Yalnızca zorunlu çerezler kullanılır: oturum çerezi (takip_session), şifre belirleme sırasındaki geçici çerez (takip_setup) ve dil çerezi (1 yıl). Analiz, reklam veya takip çerezi kullanılmaz; üçüncü taraf betik yüklenmez.',
        ],
      },
      {
        h: '5. Veriler kimlerle paylaşılır',
        p: ['Kişisel veriler satılmaz veya kiralanmaz. Yalnızca uygulamanın çalışması için şu hizmet sağlayıcılar kullanılır:'],
        li: [
          'Contabo GmbH: uygulamanın ve veritabanının çalıştığı sunucu.',
          'Google (Google Drive): veritabanı ve dosyaların günlük yedekleri.',
          'Google Cloud Translation: Romence ile Türkçe arasında otomatik çeviri için sipariş notlarının metni.',
          'FGO (fgo.ro): müşterinin fatura bilgileriyle proforma ve fatura düzenlenmesi.',
          'E-posta (SMTP) sağlayıcımız: bildirimlerin, etkinleştirme kodlarının ve belgelerin e-postayla gönderilmesi.',
          'Kanunen zorunlu olduğunda resmi makamlar.',
        ],
      },
      {
        h: '6. AEA dışına aktarım',
        p: [
          'Bazı sağlayıcılar (örneğin Google) verileri Avrupa Ekonomik Alanı dışında işleyebilir. Bu durumda aktarım GDPR’nin öngördüğü güvencelere (standart sözleşme maddeleri veya AB-ABD yeterlilik kararı) dayanır.',
        ],
      },
      {
        h: '7. Saklama süreleri',
        li: [
          'Hesap ve sipariş bilgileri: ticari ilişki süresince ve sonrasında yasal yükümlülükler için gerektiği kadar.',
          'Muhasebe belgeleri: Romanya mevzuatı gereği 10 yıl.',
          'Giriş kaydı: 365 gün, sonra kendiliğinden silinir.',
          'Yedekler: son 14 gün.',
        ],
      },
      {
        h: '8. Güvenlik',
        p: [
          'Şifreli bağlantı (HTTPS), şifre ve kodların yalnızca özet olarak saklanması, sunucuda denetlenen rol bazlı yetki, 30 dakika işlem yapılmayınca otomatik çıkış, yüklenen dosyalarda virüs taraması ve günlük yedek.',
        ],
      },
      {
        h: '9. Haklarınız',
        p: [
          `Erişim, düzeltme, silme, kısıtlama, veri taşınabilirliği ve itiraz haklarına sahipsiniz. Bunun için ${CONTACT} adresinden bize yazın. Romanya veri koruma otoritesine (ANSPDCP, www.dataprotection.ro) şikâyette bulunma hakkınız da vardır.`,
        ],
      },
      {
        h: '10. Değişiklikler',
        p: ['Bu politika güncellenebilir; güncel sürüm her zaman https://takip.gkh.ro/privacy adresindedir.'],
      },
    ],
  },
  en: {
    title: 'Privacy Policy',
    updatedLabel: 'Last updated',
    intro:
      'This policy explains which personal data the TAKİP application (https://takip.gkh.ro), the order and production portal of GKH TRADING INVEST SRL, processes, why, how long we keep it and what rights you have under Regulation (EU) 2016/679 (GDPR).',
    sections: [
      {
        h: '1. Data controller',
        p: [`GKH TRADING INVEST SRL, Romania. Data protection contact: ${CONTACT}.`],
      },
      {
        h: '2. Data we process',
        li: [
          'Account data: name, e-mail address, phone (optional), preferred language, role in the application, password (stored only as a hash) and activation codes (stored only as a hash).',
          'Customer company data: company name, contact person, e-mail, billing e-mail, phone, address, tax ID.',
          'Order data: orders, offers, prices, drawings and uploaded files, notes and messages, delivery documents, loading and pickup details (including the vehicle phone and plate number if you enter them).',
          'Financial documents: proforma invoices, invoices and payments related to orders.',
          'Technical and security data: login log (account, success/failure, IP address, country derived from the IP, date and time) and an audit log of actions in the application.',
        ],
      },
      {
        h: '3. Purposes and legal basis',
        li: [
          'Performance of the contract and orders (Art. 6(1)(b) GDPR): managing accounts, orders, drawings, offers, production and deliveries.',
          'Legal obligations (Art. 6(1)(c)): issuing and keeping accounting and tax documents.',
          'Legitimate interest (Art. 6(1)(f)): application security (login logs, attempt limits, antivirus scanning of uploaded files), backups and fraud prevention.',
        ],
      },
      {
        h: '4. Cookies',
        p: [
          'We use strictly necessary cookies only: the session cookie (takip_session), a temporary cookie while setting a password (takip_setup) and the language cookie (kept for 1 year). We use no analytics, advertising or tracking cookies and load no third-party scripts.',
        ],
      },
      {
        h: '5. Who we share data with',
        p: ['We do not sell or rent personal data. We use the following providers, only to run the application:'],
        li: [
          'Contabo GmbH: the server that runs the application and its database.',
          'Google (Google Drive): daily backups of the database and files.',
          'Google Cloud Translation: the text of order notes, for automatic translation between Romanian and Turkish.',
          'FGO (fgo.ro): issuing proforma invoices and invoices with the customer’s billing data.',
          'Our e-mail (SMTP) provider: sending notifications, activation codes and documents by e-mail.',
          'Public authorities, where the law requires it.',
        ],
      },
      {
        h: '6. Transfers outside the EEA',
        p: [
          'Some providers (for example Google) may process data outside the European Economic Area. Such transfers rely on the safeguards provided by the GDPR (standard contractual clauses or the EU-US adequacy decision).',
        ],
      },
      {
        h: '7. Retention',
        li: [
          'Account and order data: for the duration of the business relationship and afterwards as long as legal obligations require.',
          'Accounting documents: 10 years, as required by Romanian law.',
          'Login log: 365 days, then deleted automatically.',
          'Backups: the last 14 days.',
        ],
      },
      {
        h: '8. Security',
        p: [
          'Encrypted connection (HTTPS), passwords and codes stored only as hashes, role-based access checked on the server, automatic sign-out after 30 minutes of inactivity, antivirus scanning of uploaded files and daily backups.',
        ],
      },
      {
        h: '9. Your rights',
        p: [
          `You have the right of access, rectification, erasure, restriction, portability and objection. To exercise them, write to us at ${CONTACT}. You may also lodge a complaint with the Romanian data protection authority (ANSPDCP, www.dataprotection.ro).`,
        ],
      },
      {
        h: '10. Changes',
        p: ['We may update this policy; the current version is always published at https://takip.gkh.ro/privacy.'],
      },
    ],
  },
};
