/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['nodemailer'],
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
};
export default nextConfig;
