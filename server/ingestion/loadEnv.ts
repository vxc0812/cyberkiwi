/**
 * Loads local environment files for the ingestion entry points.
 *
 * Precedence, highest first:
 *   1. the real process environment (for example CI secrets)
 *   2. `.env.local`
 *   3. `.env`
 *
 * Import the side-effect call below before anything that reads process.env at load time (such as
 * db/client). Secret values are never printed here.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parse(readFileSync(file));
}

export function loadLocalEnv(
  root: string = process.cwd(),
  target: NodeJS.ProcessEnv = process.env,
): void {
  const fromBase = readEnvFile(path.join(root, '.env'));
  const fromLocal = readEnvFile(path.join(root, '.env.local'));
  const merged = { ...fromBase, ...fromLocal };
  for (const [key, value] of Object.entries(merged)) {
    if (target[key] === undefined) target[key] = value;
  }
}

loadLocalEnv();
