import type { NextConfig } from 'next';
import path from 'node:path';

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? '';
}

function resolvePlaygroundDistDir(): string | undefined {
  const configured = trimEnv(process.env.VIVENTIUM_PLAYGROUND_NEXT_DIST_DIR);
  if (!configured) {
    return undefined;
  }

  const normalized = path.posix.normalize(configured.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return undefined;
  }

  return normalized;
}

function resolveAllowedDevOrigins(): string[] {
  const values = [
    process.env.VIVENTIUM_PUBLIC_CLIENT_URL,
    process.env.VIVENTIUM_PUBLIC_SERVER_URL,
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL,
  ];
  const allowed = new Set<string>();

  for (const value of values) {
    const trimmed = trimEnv(value);
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = new URL(trimmed);
      if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        continue;
      }
      allowed.add(parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname);
    } catch {
      continue;
    }
  }

  return [...allowed];
}

const distDir = resolvePlaygroundDistDir();
const allowedDevOrigins = resolveAllowedDevOrigins();

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  ...(distDir ? { distDir } : {}),
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
