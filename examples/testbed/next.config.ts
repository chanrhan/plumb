import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Prisma 엔진 바이너리는 번들하지 않는다
  serverExternalPackages: ['@prisma/client'],
};

export default nextConfig;
