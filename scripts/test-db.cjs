#!/usr/bin/env node
/**
 * Runs the PostgreSQL integration tests against a dedicated test database.
 *
 *   TEST_DATABASE_URL  defaults to postgresql://cyberkiwi:cyberkiwi@localhost:5433/cyberkiwi_test
 *
 * Steps: create the test database if missing, apply migrations to it, then run the suite.
 * The suite itself refuses to run unless the database name ends in "_test".
 */
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const DEFAULT = 'postgresql://cyberkiwi:cyberkiwi@localhost:5433/cyberkiwi_test?schema=public';
const testUrl = process.env.TEST_DATABASE_URL || DEFAULT;
const parsed = new URL(testUrl);
const dbName = parsed.pathname.replace(/^\//, '');

if (!dbName.endsWith('_test')) {
  console.error(`Refusing to run: "${dbName}" does not end in "_test".`);
  process.exit(1);
}

async function ensureDatabase() {
  const admin = new URL(testUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
      console.log(`[test-db] created database ${dbName}`);
    }
  } finally {
    await client.end();
  }
}

function run(cmd, args, env) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

(async () => {
  await ensureDatabase();
  const env = { DATABASE_URL: testUrl };
  run('npx', ['prisma', 'migrate', 'deploy'], env);
  run('npx', ['tsx', 'tests/integration/ingestion.db.test.ts'], env);
  run('npx', ['tsx', 'tests/integration/readApi.db.test.ts'], env);
  run('npx', ['tsx', 'tests/integration/auth.db.test.ts'], env);
  run('npx', ['tsx', 'tests/integration/enrichment.db.test.ts'], env);
  run('npx', ['tsx', 'tests/integration/push.db.test.ts'], env);
})().catch((err) => {
  console.error('[test-db] failed:', err.message);
  process.exit(1);
});
