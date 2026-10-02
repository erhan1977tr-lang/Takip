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
    serverActions: { bodySizeLimit: '250mb', ...(codespaceOrigins ? { allowedOrigins: codespaceOrigins } : {}) },
  },
};
export default nextConfig;
