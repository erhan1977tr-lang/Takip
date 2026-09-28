/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['nodemailer'],
  experimental: {
    serverActions: { bodySizeLimit: '250mb' },
  },
};
export default nextConfig;
