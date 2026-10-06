// GitHub Codespaces'te uygulama *.app.github.dev adresinden açılır; sunucu işlemleri (server actions)
// bu adresten gelen istekleri kabul etsin. Yalnızca Codespaces içinde derlenince eklenir.
const codespaceOrigins = process.env.CODESPACES === 'true'
  ? [`*.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`, 'localhost:3000']
  : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['nodemailer'],
  // pdf.js'in standart yazı tipleri ve cMap'leri (çizim görüntüleyici) üretim çıktısına (standalone) girsin:
  // app/pdfjs/[kind]/[file]/route.ts bunları node_modules/pdfjs-dist içinden sunar.
  outputFileTracingIncludes: {
    '/pdfjs/**': ['./node_modules/pdfjs-dist/standard_fonts/**', './node_modules/pdfjs-dist/cmaps/**'],
  },
  experimental: {
    // Sunucu işlemlerinin gövde sınırı TEK ve geneldir (işlem ya da sayfa başına verilemez). 250 MB, yeni sipariş formunda
    // müşteriye yazılan kuraldır ("dosya başına en fazla 100 MB, toplam 250 MB") — düşürmek ürün kararıdır. Asıl sınır
    // vekildedir (deploy/Caddyfile, karar 141): dosya yükleme formu olmayan adreslerde 2 MB, yönetim Excel sayfalarında
    // 6 MB, yalnızca /siparisler/* ve /depo/* için 260 MB (= 260.000.000 bayt; buradaki 250mb = 262.144.000 bayttan
    // küçüktür, yani bağlayıcı olan Caddy'dir). Next gövdeyi işlem çalışmadan — yetki denetiminden — ÖNCE okur.
    serverActions: { bodySizeLimit: '250mb', ...(codespaceOrigins ? { allowedOrigins: codespaceOrigins } : {}) },
  },
};
export default nextConfig;
