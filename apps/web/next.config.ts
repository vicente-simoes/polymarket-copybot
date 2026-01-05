import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Mark packages as external for server-side rendering
  serverExternalPackages: ['pg'],

  // Transpile the Prisma client package
  transpilePackages: ['@polymarket-bot/db'],

  webpack: (config, { isServer }) => {
    if (isServer) {
      // Fix Prisma 7 ESM resolution - map .js imports to .ts files
      config.resolve.extensionAlias = {
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
      };
    }

    // Add aliases for the generated Prisma files
    config.resolve.alias = {
      ...config.resolve.alias,
    };

    return config;
  },
};

export default nextConfig;
