/**
 * Prisma client for the server. Prisma 7 requires a driver adapter; this project uses PostgreSQL.
 *
 * DATABASE_URL must be set outside development. The fallback matches docker-compose.yml
 * (host port 5433, so it does not collide with other local PostgreSQL containers).
 */
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export const DEFAULT_DATABASE_URL =
  'postgresql://cyberkiwi:cyberkiwi@localhost:5433/cyberkiwi?schema=public';

export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

const LOOPBACK_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * A database on another host must use TLS. node-postgres turns TLS on only when the URL asks for it,
 * so a remote URL without sslmode would send credentials and data in cleartext (report F36).
 */
export function assertDatabaseTransport(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (LOOPBACK_DB_HOSTS.has(parsed.hostname)) return;
  const mode = parsed.searchParams.get('sslmode') ?? '';
  if (!['require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw new Error('Remote DATABASE_URL must set sslmode=require (or verify-ca / verify-full)');
  }
}

export function createPrisma(url: string = databaseUrl()): PrismaClient {
  assertDatabaseTransport(url);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

let shared: PrismaClient | null = null;

/** Process-wide client for the API and worker. Tests create their own with createPrisma(). */
export function getPrisma(): PrismaClient {
  if (!shared) shared = createPrisma();
  return shared;
}

export async function closePrisma(): Promise<void> {
  if (shared) {
    await shared.$disconnect();
    shared = null;
  }
}

export type { PrismaClient };
