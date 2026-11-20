// Browser check: invite-only story reads follow the session in the real web app.
//
//   1. Anonymous start: session restore finishes, no story request is sent, the sign-in notice shows.
//   2. Sign in through Settings: stories load with no page reload.
//   3. Reload with the session cookie: the first story request starts only after restore (/api/auth/me)
//      has answered, and no story request gets a 401.
//   4. Sign out: server stories are cleared and no further story request is sent.
//   5. A story link opened while signed out waits, then opens after sign-in. Web story links are only
//      recognised on https://cyberkiwi.app, so this step loads that origin and the browser forwards
//      its requests to FLOW_BASE (request interception); nothing is sent to the real site.
//
// Needs a production build made with VITE_CYBERKIWI_API_BASE_URL set (empty means same origin), the
// server running against a database with stories, and an active user:
//   FLOW_BASE=http://127.0.0.1:3070 FLOW_EMAIL=... FLOW_PASSWORD=... FLOW_STORY_ID=<uuid> node scripts/auth-read-flow.mjs
// Browser: CHROME_PATH, else the first Chrome or Chromium found on PATH.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.FLOW_BASE;
const EMAIL = process.env.FLOW_EMAIL;
const PASSWORD = process.env.FLOW_PASSWORD;
const STORY_ID = process.env.FLOW_STORY_ID;
if (!BASE || !EMAIL || !PASSWORD || !STORY_ID) {
  console.error('Set FLOW_BASE, FLOW_EMAIL, FLOW_PASSWORD and FLOW_STORY_ID.');
  process.exit(2);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  throw new Error('No Chrome found; set CHROME_PATH.');
}

const results = [];
const pageErrors = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err).slice(0, 300) });
  }
};

// Every request to the protected read API and to session restore, in order.
let log = [];
const isStories = (url) => /\/api\/v1\/(stories|articles)(\/|\?|$)/.test(new URL(url).pathname + new URL(url).search);
const isMe = (url) => new URL(url).pathname === '/api/auth/me';

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
page.on('request', (req) => {
  if (isStories(req.url()) || isMe(req.url())) log.push({ t: Date.now(), kind: 'request', url: req.url() });
});
page.on('response', (res) => {
  if (isStories(res.url()) || isMe(res.url())) log.push({ t: Date.now(), kind: 'response', url: res.url(), status: res.status() });
});
let navigations = 0;
page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });

const bodyHas = (text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const storyRequests = () => log.filter((e) => e.kind === 'request' && isStories(e.url));
const storyResponses = () => log.filter((e) => e.kind === 'response' && isStories(e.url));
const meResponses = () => log.filter((e) => e.kind === 'response' && isMe(e.url));
const summary = () => log.map((e) => `${e.kind === 'request' ? '>' : '<'} ${new URL(e.url).pathname}${e.status ? ' ' + e.status : ''}`).join(' | ');
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
const clickByText = (text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === t);
    if (!el) throw new Error(`no button "${t}"`);
    el.click();
  }, text);
const openSettings = async () => {
  await page.click('button[title*="Ctrl+,"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
};
const closeSettings = async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10000 });
};
const signIn = async () => {
  await openSettings();
  await page.waitForSelector('#auth-email', { timeout: 15000 });
  await page.type('#auth-email', EMAIL);
  await page.type('#auth-password', PASSWORD);
  await page.evaluate(() => document.getElementById('auth-email').closest('form').querySelector('button[type="submit"]').click());
  await bodyHas('Signed in as');
};

await step('1. anonymous start: restore finishes, no story request, sign-in notice shown', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 90000 });
  await bodyHas('Sign in to load CyberKiwi stories');
  await settle();
  if (meResponses().length === 0) throw new Error('session restore (/api/auth/me) never ran');
  if (storyRequests().length > 0) throw new Error(`story requests sent while signed out: ${storyRequests().map((e) => e.url).join(', ')}`);
});

await step('2. sign in through Settings: stories load with no page reload', async () => {
  const navBefore = navigations;
  log = [];
  await signIn();
  await closeSettings();
  await bodyHas('Server stories (', 30000);
  const ok = storyResponses().filter((e) => e.status === 200);
  if (ok.length === 0) throw new Error('no successful story response after sign-in');
  if (navigations !== navBefore) throw new Error('the page navigated; stories should load in place');
});

await step('3. reload with the session cookie: first story request waits for restore; no 401', async () => {
  log = [];
  await page.reload({ waitUntil: 'networkidle0', timeout: 90000 });
  await bodyHas('Server stories (', 30000).catch((err) => {
    throw new Error(`${err.message}; requests: ${summary()}`);
  });
  const firstStory = storyRequests()[0];
  const meDone = meResponses()[0];
  if (!firstStory) throw new Error('no story request after reload');
  if (!meDone) throw new Error('no session restore after reload');
  if (meDone.status !== 200) throw new Error(`restore answered ${meDone.status}`);
  if (firstStory.t < meDone.t) throw new Error('a story request started before session restore finished');
  const refused = storyResponses().filter((e) => e.status === 401);
  if (refused.length) throw new Error(`${refused.length} story request(s) got 401`);
});

await step('4. sign out: server stories cleared, no further story request', async () => {
  await openSettings();
  await clickByText('Sign out');
  await bodyHas('Create account');
  await closeSettings();
  log = [];
  await bodyHas('Sign in to load CyberKiwi stories');
  await settle(2000);
  const shows = await page.evaluate(() => document.body.innerText.includes('Server stories ('));
  if (shows) throw new Error('server stories still shown after sign-out');
  if (storyRequests().length > 0) throw new Error('story requests sent after sign-out');
});

const LINK_ORIGIN = 'https://cyberkiwi.app';
/** Answers every request for LINK_ORIGIN from FLOW_BASE, keeping method, body, cookies and Origin. */
async function forwardLinkOrigin() {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = new URL(req.url());
    if (url.origin !== LINK_ORIGIN) return req.continue();
    try {
      const headers = { ...req.headers() };
      delete headers.host;
      const res = await fetch(BASE + url.pathname + url.search, {
        method: req.method(),
        headers,
        body: req.postData() ?? undefined,
        redirect: 'manual',
      });
      const out = {};
      res.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'content-encoding' && k !== 'content-length') out[k] = v; });
      const cookies = res.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies.join('\n');
      await req.respond({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch (err) {
      await req.abort('failed');
    }
  });
}

await step('5. story link while signed out waits, then opens after sign-in', async () => {
  await forwardLinkOrigin();
  log = [];
  await page.goto(`${LINK_ORIGIN}/story/${STORY_ID}`, { waitUntil: 'networkidle0', timeout: 90000 });
  await bodyHas('Sign in to load CyberKiwi stories');
  await settle();
  if (storyRequests().length > 0) throw new Error('story requests sent while signed out');
  await signIn();
  await closeSettings();
  const detailPath = `/api/v1/stories/${STORY_ID}`;
  const deadline = Date.now() + 30000;
  while (!storyResponses().some((e) => e.url.includes(detailPath)) && Date.now() < deadline) await settle(250);
  const detail = storyResponses().find((e) => e.url.includes(detailPath));
  if (!detail || detail.status !== 200) throw new Error(`story detail answered ${detail?.status ?? 'nothing'}`);
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, pageErrors }, null, 2));
process.exit(failed.length ? 1 : 0);
