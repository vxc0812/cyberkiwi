import assert from 'node:assert/strict';
import { requireAiCaller, fingerprintKey, isWellFormedGeminiKey, BYOK_HEADER, MIN_AI_TOKEN_LENGTH } from '../server/aiGuard';
import { nativeAiMode } from '../src/services/aiPolicy';
import { MemoryAiKeyStore, PassphraseAiKeyStore, SecureValueAiKeyStore, type KeyValueStorage, type SecureValuePort } from '../src/services/aiKeyStore';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

// A valid-looking Gemini key: "AIza" followed by 35 URL-safe characters.
const KEY_A = 'AIza' + 'A'.repeat(35);
const KEY_B = 'AIza' + 'B'.repeat(35);
const GOOD_TOKEN = 'd'.repeat(MIN_AI_TOKEN_LENGTH);

/**
 * A stand-in for the Prisma raw-query call used by consumeQuota. It keeps counters per identity and
 * honours the limit passed as the last SQL parameter, so the guard's quota logic runs unchanged.
 */
function fakeDb() {
  const counts = new Map<string, number>();
  return {
    counts,
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const identity = String(values[0]);
      const limit = Number(values[values.length - 1]);
      const current = counts.get(identity) ?? 0;
      if (current >= limit) return [];
      counts.set(identity, current + 1);
      return [{ count: current + 1 }];
    },
  } as any;
}

function fakeReq(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: lower,
    get: (name: string) => lower[name.toLowerCase()],
  } as any;
}

function fakeRes(locals: Record<string, unknown> = {}) {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string>, locals };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
  return res;
}

async function run(
  middleware: ReturnType<typeof requireAiCaller>,
  req: any,
  res: any
): Promise<{ called: boolean }> {
  let called = false;
  await middleware(req, res, () => { called = true; });
  return { called };
}

class MemoryStorage implements KeyValueStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  raw(key: string) { return this.data.get(key) ?? null; }
}

async function main(): Promise<void> {
  const savedToken = process.env.AI_ACCESS_TOKEN;
  process.env.AI_ACCESS_TOKEN = GOOD_TOKEN;

  await check('key format: only "AIza" plus 35 URL-safe characters is accepted', () => {
    assert.equal(isWellFormedGeminiKey(KEY_A), true);
    assert.equal(isWellFormedGeminiKey('AIza' + 'A'.repeat(34)), false, 'too short');
    assert.equal(isWellFormedGeminiKey('AIza' + 'A'.repeat(36)), false, 'too long');
    assert.equal(isWellFormedGeminiKey('sk-' + 'A'.repeat(35)), false, 'wrong prefix');
    assert.equal(isWellFormedGeminiKey(KEY_A + ' '), false, 'trailing space');
    assert.equal(isWellFormedGeminiKey('AIza' + 'A'.repeat(34) + '/'), false, 'unsafe character');
  });

  await check('fingerprint: stable, 64 hex characters, and it does not contain the key', () => {
    const fp = fingerprintKey(KEY_A);
    assert.equal(fp, fingerprintKey(KEY_A));
    assert.notEqual(fp, fingerprintKey(KEY_B));
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.equal(fp.includes(KEY_A), false);
  });

  await check('BYOK: a valid key is redacted from the request before any later code runs, and identifies the caller by fingerprint', async () => {
    const db = fakeDb();
    const mw = requireAiCaller({ db, platformKeyConfigured: () => true });
    const req = fakeReq({ [BYOK_HEADER]: KEY_A, Origin: 'https://cyberkiwi.app' });
    const res = fakeRes();
    const { called } = await run(mw, req, res);
    assert.equal(called, true);
    assert.equal(req.headers[BYOK_HEADER], undefined, 'header removed from req.headers');
    assert.equal(res.locals.aiCaller.kind, 'byok');
    assert.equal(res.locals.aiCaller.userKey, KEY_A, 'the handler receives the key only through the caller');
    assert.equal(res.locals.aiCaller.identity, `byok:${fingerprintKey(KEY_A)}`);
    assert.equal(JSON.stringify(res.locals).includes(`byok:${KEY_A}`), false, 'identity never contains the key');
  });

  await check('BYOK: a malformed key gets 400 and the header is still removed', async () => {
    const mw = requireAiCaller({ db: fakeDb(), platformKeyConfigured: () => true });
    const req = fakeReq({ [BYOK_HEADER]: 'not-a-key' });
    const res = fakeRes();
    const { called } = await run(mw, req, res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 400);
    assert.equal(req.headers[BYOK_HEADER], undefined);
  });

  await check('BYOK: the per-key daily quota stops calls with 429', async () => {
    const db = fakeDb();
    const mw = requireAiCaller({ db, platformKeyConfigured: () => false, limits: { byokPerDay: 2 } });
    for (let i = 0; i < 2; i++) {
      assert.equal((await run(mw, fakeReq({ [BYOK_HEADER]: KEY_A }), fakeRes())).called, true);
    }
    const res = fakeRes();
    assert.equal((await run(mw, fakeReq({ [BYOK_HEADER]: KEY_A }), res)).called, false);
    assert.equal(res.statusCode, 429);
    assert.equal((await run(mw, fakeReq({ [BYOK_HEADER]: KEY_B }), fakeRes())).called, true, 'another key has its own quota');
  });

  await check('BYOK works without the platform key configured', async () => {
    const mw = requireAiCaller({ db: fakeDb(), platformKeyConfigured: () => false });
    assert.equal((await run(mw, fakeReq({ [BYOK_HEADER]: KEY_A }), fakeRes())).called, true);
  });

  await check('platform key: no credentials gets 401 with a Bearer challenge and never reaches the model', async () => {
    const mw = requireAiCaller({ db: fakeDb(), platformKeyConfigured: () => true });
    const res = fakeRes();
    const { called } = await run(mw, fakeReq({}), res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['WWW-Authenticate'], 'Bearer');
  });

  await check('platform key: the desktop token passes and is counted against the desktop and platform budgets', async () => {
    const db = fakeDb();
    const mw = requireAiCaller({ db, platformKeyConfigured: () => true, limits: { desktopPerDay: 1, platformPerDay: 10 } });
    const res = fakeRes();
    assert.equal((await run(mw, fakeReq({ Authorization: `Bearer ${GOOD_TOKEN}` }), res)).called, true);
    assert.equal(res.locals.aiCaller.kind, 'desktop');
    const second = fakeRes();
    assert.equal((await run(mw, fakeReq({ Authorization: `Bearer ${GOOD_TOKEN}` }), second)).called, false);
    assert.equal(second.statusCode, 429);
  });

  await check('platform key: a wrong bearer token is refused', async () => {
    const mw = requireAiCaller({ db: fakeDb(), platformKeyConfigured: () => true });
    const res = fakeRes();
    assert.equal((await run(mw, fakeReq({ Authorization: `Bearer ${'x'.repeat(MIN_AI_TOKEN_LENGTH)}` }), res)).called, false);
    assert.equal(res.statusCode, 401);
  });

  await check('platform key: a signed-in user is counted per user and refused with 503 when no platform key exists', async () => {
    const principal = { sessionId: 's', userId: 'user-1', email: 'a@b.co', role: 'USER', kind: 'WEB' };
    const db = fakeDb();
    const mw = requireAiCaller({ db, platformKeyConfigured: () => true, limits: { userPerDay: 1, platformPerDay: 10 } });
    assert.equal((await run(mw, fakeReq({}), fakeRes({ principal }))).called, true);
    const again = fakeRes({ principal });
    assert.equal((await run(mw, fakeReq({}), again)).called, false);
    assert.equal(again.statusCode, 429);
    assert.equal(db.counts.get('user:user-1'), 1);

    const off = requireAiCaller({ db: fakeDb(), platformKeyConfigured: () => false });
    const res = fakeRes({ principal });
    assert.equal((await run(off, fakeReq({}), res)).called, false);
    assert.equal(res.statusCode, 503);
  });

  await check('native AI: the server is used only with a user key and a configured API address', () => {
    assert.equal(nativeAiMode({ hasUserKey: true, apiBase: 'https://api.cyberkiwi.app' }), 'server');
    assert.equal(nativeAiMode({ hasUserKey: false, apiBase: 'https://api.cyberkiwi.app' }), 'fallback');
    assert.equal(nativeAiMode({ hasUserKey: true, apiBase: null }), 'fallback');
  });

  await check('memory key store: holds the key only in memory and clears it', async () => {
    const store = new MemoryAiKeyStore();
    assert.equal(await store.get(), null);
    await store.set(KEY_A);
    assert.equal(await store.get(), KEY_A);
    await store.clear();
    assert.equal(await store.get(), null);
    await assert.rejects(() => store.set('short'), /does not look like a Gemini API key/);
  });

  await check('secure key store: reads and writes through the port, and a failed read returns null', async () => {
    const values = new Map<string, string>();
    const port: SecureValuePort = {
      get: async (k) => values.get(k) ?? null,
      set: async (k, v) => { values.set(k, v); },
      remove: async (k) => { values.delete(k); },
    };
    const store = new SecureValueAiKeyStore(port, 'test-key');
    await store.set(KEY_A);
    assert.equal(values.get('test-key'), KEY_A);
    assert.equal(await store.get(), KEY_A);
    await store.clear();
    assert.equal(await store.get(), null);

    const broken = new SecureValueAiKeyStore({
      get: async () => { throw new Error('keychain locked'); },
      set: async () => {},
      remove: async () => {},
    });
    assert.equal(await broken.get(), null);
  });

  await check('passphrase store: the stored value is encrypted and needs the passphrase to read', async () => {
    const storage = new MemoryStorage();
    const store = new PassphraseAiKeyStore(storage, 'k', 1_000);
    assert.equal(store.isLocked(), true);
    assert.equal(await store.get(), null, 'locked store returns nothing');
    await assert.rejects(() => store.set(KEY_A), /Unlock/);

    await store.unlock('correct horse battery');
    await store.set(KEY_A);
    const stored = storage.raw('k') ?? '';
    assert.ok(stored.length > 0);
    assert.equal(stored.includes(KEY_A), false, 'plain key must not appear in storage');

    const reopened = new PassphraseAiKeyStore(storage, 'k', 1_000);
    await assert.rejects(() => reopened.unlock('wrong passphrase!!'), /Wrong passphrase/);
    await reopened.unlock('correct horse battery');
    assert.equal(await reopened.get(), KEY_A);
  });

  await check('passphrase store: a short passphrase is refused and clear removes the stored key', async () => {
    const storage = new MemoryStorage();
    const store = new PassphraseAiKeyStore(storage, 'k', 1_000);
    await assert.rejects(() => store.unlock('short'), /at least 12/);
    await store.unlock('long enough passphrase');
    await store.set(KEY_B);
    await store.clear();
    assert.equal(storage.raw('k'), null);
    assert.equal(store.isLocked(), true);
  });

  if (savedToken === undefined) delete process.env.AI_ACCESS_TOKEN; else process.env.AI_ACCESS_TOKEN = savedToken;

  if (failures > 0) {
    console.log(`\n${failures} BYOK check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
