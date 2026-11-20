#!/usr/bin/env node
// Boot smoke test for the production server bundle.
//
// A successful esbuild run does not prove the bundle can start: dist/server.cjs once
// bundled cleanly yet threw on load because import.meta.url was empty in CJS output.
// This starts the real bundle, waits for /health, and fails if the process exits early.
//
// Scope: this proves the process boots and serves HTTP. It does NOT verify database
// connectivity; no DATABASE_URL is supplied, and nothing here touches PostgreSQL.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const bundle = path.join(root, 'dist', 'server.cjs');
const port = Number(process.env.SMOKE_PORT || 39123);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 20000);

if (!fs.existsSync(bundle)) {
  console.error(`[smoke] ${bundle} not found; run "npm run build" first`);
  process.exit(1);
}

const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) };
delete env.DATABASE_URL;

const child = spawn(process.execPath, [bundle], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  console.error('[smoke] server output:\n' + (output || '(none)'));
  if (exited === null) child.kill('SIGKILL');
  process.exit(1);
}

async function main() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return fail(`server exited before becoming healthy (code ${exited.code}, signal ${exited.signal})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      if (res.status !== 200 || body.status !== 'ok' || body.service !== 'cyberkiwi-api') {
        return fail(`unexpected /health response ${res.status} ${JSON.stringify(body)}`);
      }
      console.log(`[smoke] PASS: production bundle booted and /health returned ok on port ${port}`);
      console.log('[smoke] NOTE: database connectivity was not exercised and remains unverified');
      child.kill('SIGTERM');
      return process.exit(0);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  fail(`no healthy response within ${timeoutMs}ms`);
}

main();
