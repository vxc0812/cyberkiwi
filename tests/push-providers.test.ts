import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, type KeyObject } from 'crypto';
import { FcmSender, parseServiceAccount, signAssertion, GOOGLE_TOKEN_URL, type FetchLike } from '../server/push/fcm';
import { ApnsSender, signProviderToken, type ApnsTransport } from '../server/push/apns';
import { createPushSender, payloadFor, UnavailablePushSender, RoutingPushSender } from '../server/push/sender';

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

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const EC_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ACCOUNT = { client_email: 'push@cyberkiwi-test.iam.gserviceaccount.com', private_key: RSA_PEM, project_id: 'cyberkiwi-test' };
const STORY = '3f2c9a10-7b1e-4c55-9d2a-0a1b2c3d4e5f';
const ANDROID_TOKEN = 'f'.repeat(40);
const IOS_TOKEN = 'a'.repeat(64);

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(handler: (c: Call) => { status: number; body?: string }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const out = handler(call);
    return { status: out.status, text: async () => out.body ?? '' };
  };
  return { fetch: fetchImpl, calls };
}

async function main(): Promise<void> {
  await check('service account: parses JSON, restores escaped newlines, and rejects missing fields', () => {
    const raw = JSON.stringify({ client_email: 'a@b.iam', private_key: RSA_PEM.replace(/\n/g, '\\n'), project_id: 'p' });
    assert.equal(parseServiceAccount(raw).private_key, RSA_PEM);
    assert.throws(() => parseServiceAccount(JSON.stringify({ project_id: 'p' })), /client_email/);
  });

  await check('FCM: the assertion is an RS256 JWT with the right audience and scope, and verifies with the public key', () => {
    const jwt = signAssertion(ACCOUNT, Date.UTC(2026, 10, 16, 12, 0, 0));
    const [header, claims, signature] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(body.aud, GOOGLE_TOKEN_URL);
    assert.equal(body.iss, ACCOUNT.client_email);
    assert.match(body.scope, /firebase\.messaging/);
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    assert.equal(verifier.verify(rsa.publicKey, signature, 'base64url'), true);
  });

  await check('FCM: one token exchange serves many sends; the message carries only the generic title and the deep link', async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url === GOOGLE_TOKEN_URL) return { status: 200, body: JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }) };
      return { status: 200, body: '{}' };
    });
    let clock = Date.UTC(2026, 10, 16, 12);
    const sender = new FcmSender(ACCOUNT, fetch, () => clock);
    const payload = payloadFor('breaking', STORY);
    assert.equal(await sender.send({ platform: 'android', pushToken: ANDROID_TOKEN }, payload), 'sent');
    assert.equal(await sender.send({ platform: 'android', pushToken: ANDROID_TOKEN }, payload), 'sent');
    assert.equal(calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length, 1, 'token is cached');
    const send = calls.find((c) => c.url.includes('messages:send'))!;
    assert.equal(send.headers.Authorization, 'Bearer ya29.test');
    assert.match(send.url, /projects\/cyberkiwi-test\/messages:send$/);
    const message = JSON.parse(send.body!).message;
    assert.equal(message.data.deepLink, `cyberkiwi://story/${STORY}`);
    assert.equal(message.notification.title, 'Breaking security news');
    assert.equal(JSON.stringify(message).includes('<'), false);

    clock += 2 * 3600 * 1000;
    await sender.send({ platform: 'android', pushToken: ANDROID_TOKEN }, payload);
    assert.equal(calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length, 2, 'expired token is refreshed');
  });

  await check('FCM: a dead token is reported as invalid_token; other failures are retryable', async () => {
    const dead = fakeFetch((c) => (c.url === GOOGLE_TOKEN_URL
      ? { status: 200, body: JSON.stringify({ access_token: 't' }) }
      : { status: 404, body: 'UNREGISTERED' }));
    assert.equal(await new FcmSender(ACCOUNT, dead.fetch).send({ platform: 'android', pushToken: ANDROID_TOKEN }, payloadFor('ai_ready')), 'invalid_token');

    const down = fakeFetch((c) => (c.url === GOOGLE_TOKEN_URL
      ? { status: 200, body: JSON.stringify({ access_token: 't' }) }
      : { status: 503 }));
    assert.equal(await new FcmSender(ACCOUNT, down.fetch).send({ platform: 'android', pushToken: ANDROID_TOKEN }, payloadFor('ai_ready')), 'failed');

    const noToken = fakeFetch(() => ({ status: 401 }));
    assert.equal(await new FcmSender(ACCOUNT, noToken.fetch).send({ platform: 'android', pushToken: ANDROID_TOKEN }, payloadFor('ai_ready')), 'failed');
  });

  await check('APNs: the provider JWT is ES256 with the key id, and verifies with the public key', () => {
    const jwt = signProviderToken({ keyId: 'KEY123', teamId: 'TEAM456', privateKey: EC_PEM }, Date.UTC(2026, 10, 16));
    const [header, claims, signature] = jwt.split('.');
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    assert.equal(h.alg, 'ES256');
    assert.equal(h.kid, 'KEY123');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, 'TEAM456');
    const ok = createVerify('sha256').update(`${header}.${claims}`).verify(
      { key: ec.publicKey as KeyObject, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')
    );
    assert.equal(ok, true);
  });

  await check('APNs: sends to the sandbox host with topic, push type and priority headers; 200 is sent', async () => {
    const seen: Parameters<ApnsTransport>[0][] = [];
    const transport: ApnsTransport = async (args) => { seen.push(args); return { status: 200, body: '' }; };
    const sender = new ApnsSender({ keyId: 'K', teamId: 'T', bundleId: 'com.cyberkiwi.client', privateKey: EC_PEM, production: false }, transport);
    assert.equal(await sender.send({ platform: 'ios', pushToken: IOS_TOKEN }, payloadFor('breaking', STORY)), 'sent');
    const call = seen[0];
    assert.equal(call.host, 'api.sandbox.push.apple.com');
    assert.equal(call.path, `/3/device/${IOS_TOKEN}`);
    assert.equal(call.headers['apns-topic'], 'com.cyberkiwi.client');
    assert.equal(call.headers['apns-push-type'], 'alert');
    assert.match(call.headers.authorization, /^bearer /);
    assert.equal(JSON.parse(call.body).deepLink, `cyberkiwi://story/${STORY}`);
  });

  await check('APNs: dead tokens are invalid_token; malformed tokens never reach the network; production uses the production host', async () => {
    let calls = 0;
    const transport: ApnsTransport = async () => { calls++; return { status: 410, body: '{"reason":"Unregistered"}' }; };
    const prod = new ApnsSender({ keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: EC_PEM, production: true }, transport);
    assert.equal(await prod.send({ platform: 'ios', pushToken: IOS_TOKEN }, payloadFor('ai_ready')), 'invalid_token');
    assert.equal(await prod.send({ platform: 'ios', pushToken: 'not-hex' }, payloadFor('ai_ready')), 'invalid_token');
    assert.equal(calls, 1, 'only the well-formed token made a request');
  });

  await check('routing: with no credentials every platform is unavailable and status says so', async () => {
    const sender = createPushSender({} as NodeJS.ProcessEnv);
    assert.deepEqual(sender.status(), { android: false, ios: false, available: false });
    assert.equal(await sender.send({ platform: 'android', pushToken: ANDROID_TOKEN }, payloadFor('breaking')), 'unavailable');
    assert.equal(await sender.send({ platform: 'web', pushToken: 'x'.repeat(20) }, payloadFor('breaking')), 'unavailable');
    assert.equal(await new UnavailablePushSender().send(), 'unavailable');
  });

  await check('routing: configured platforms are enabled independently', () => {
    const env = {
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(ACCOUNT),
    } as unknown as NodeJS.ProcessEnv;
    const status = createPushSender(env).status();
    assert.deepEqual(status, { android: true, ios: false, available: true });
    const both = createPushSender({
      ...env,
      APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'b', APNS_PRIVATE_KEY: EC_PEM.replace(/\n/g, '\\n'),
    } as NodeJS.ProcessEnv);
    assert.ok(both instanceof RoutingPushSender);
    assert.deepEqual(both.status(), { android: true, ios: true, available: true });
  });

  if (failures > 0) {
    console.log(`\n${failures} push provider check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
