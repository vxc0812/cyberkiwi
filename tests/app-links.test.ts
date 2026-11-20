import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { appLinkRoutes, buildAppleAppSiteAssociation, buildAssetLinks, appLinkConfigFromEnv } from '../server/http/appLinks';
import { handleAppUrl } from '../src/services/deepLinkRuntime';

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

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i % 2 ? 'BB' : 'AA')).join(':');
const CONFIGURED = { appleTeamId: 'ABCDE12345', iosBundleId: 'com.cyberkiwi.client', androidPackage: 'com.cyberkiwi.client', androidSha256: FINGERPRINT };
const STORY = '3f2c9a10-7b1e-4c55-9d2a-0a1b2c3d4e5f';

async function serve(config: Parameters<typeof appLinkRoutes>[0]): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(appLinkRoutes(config));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  await check('apple association: lists the team and bundle id and claims /story/*', () => {
    const body = buildAppleAppSiteAssociation(CONFIGURED) as any;
    assert.equal(body.applinks.details[0].appID, 'ABCDE12345.com.cyberkiwi.client');
    assert.deepEqual(body.applinks.details[0].components, [{ '/': '/story/*', comment: 'Story links' }]);
  });

  await check('assetlinks: names the package and the release certificate fingerprint', () => {
    const body = buildAssetLinks(CONFIGURED) as any[];
    assert.equal(body[0].target.package_name, 'com.cyberkiwi.client');
    assert.deepEqual(body[0].target.sha256_cert_fingerprints, [FINGERPRINT]);
    assert.deepEqual(body[0].relation, ['delegate_permission/common.handle_all_urls']);
  });

  await check('not configured: no file is produced, so placeholder values can never be served as deployed', () => {
    assert.equal(buildAppleAppSiteAssociation({ ...CONFIGURED, appleTeamId: undefined }), null);
    assert.equal(buildAppleAppSiteAssociation({ ...CONFIGURED, appleTeamId: 'REPLACE_ME' }), null);
    assert.equal(buildAssetLinks({ ...CONFIGURED, androidSha256: undefined }), null);
    assert.equal(buildAssetLinks({ ...CONFIGURED, androidSha256: 'AA:BB' }), null, 'a short fingerprint is refused');
    assert.equal(buildAssetLinks({ ...CONFIGURED, androidSha256: 'REPLACE_WITH_RELEASE_SHA256' }), null);
  });

  await check('config: values come from the environment, with the bundle and package defaults', () => {
    const c = appLinkConfigFromEnv({ APPLE_TEAM_ID: 'ABCDE12345', ANDROID_CERT_SHA256: FINGERPRINT } as NodeJS.ProcessEnv);
    assert.equal(c.iosBundleId, 'com.cyberkiwi.client');
    assert.equal(c.androidPackage, 'com.cyberkiwi.client');
    assert.equal(appLinkConfigFromEnv({} as NodeJS.ProcessEnv).appleTeamId, undefined);
  });

  const unconfigured = await serve({});
  try {
    await check('routes: 404 until configured, for both files', async () => {
      assert.equal((await fetch(`${unconfigured.base}/.well-known/apple-app-site-association`)).status, 404);
      assert.equal((await fetch(`${unconfigured.base}/.well-known/assetlinks.json`)).status, 404);
    });
  } finally {
    await unconfigured.close();
  }

  const configured = await serve(CONFIGURED);
  try {
    await check('routes: JSON content type, no redirects, and the body matches the builders', async () => {
      const apple = await fetch(`${configured.base}/.well-known/apple-app-site-association`);
      assert.equal(apple.status, 200);
      assert.match(apple.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await apple.json(), buildAppleAppSiteAssociation(CONFIGURED));
      const links = await fetch(`${configured.base}/.well-known/assetlinks.json`);
      assert.equal(links.status, 200);
      assert.deepEqual(await links.json(), buildAssetLinks(CONFIGURED));
    });
  } finally {
    await configured.close();
  }

  await check('cold start: a launch URL that is a story link opens that story; any other launch URL does nothing', () => {
    const opened: string[] = [];
    assert.equal(handleAppUrl(`https://cyberkiwi.app/story/${STORY}`, (id) => opened.push(id)), true);
    assert.equal(handleAppUrl('https://cyberkiwi.app/', (id) => opened.push(id)), false);
    assert.equal(handleAppUrl(undefined, (id) => opened.push(id)), false, 'no launch URL is a normal start');
    assert.deepEqual(opened, [STORY]);
  });

  await check('foreground: a story link received while running opens that story; a bad link is ignored', () => {
    const opened: string[] = [];
    assert.equal(handleAppUrl(`cyberkiwi://story/${STORY}`, (id) => opened.push(id)), true);
    assert.equal(handleAppUrl('cyberkiwi://story/not-a-story', (id) => opened.push(id)), false);
    assert.equal(handleAppUrl('https://evil.example/story/' + STORY, (id) => opened.push(id)), false, 'other hosts are never opened');
    assert.deepEqual(opened, [STORY]);
  });

  if (failures > 0) {
    console.log(`\n${failures} app link check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
