import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@lekvero/shared'],
  poweredByHeader: false,
};

export default nextConfig;
