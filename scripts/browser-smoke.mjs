// Browser smoke test for the web app: sign-in, session persistence, BYOK save/reject and no key in storage,
// sign-out, and a story link opened cold on the web. Usage (dev server running, test user created):
//   SMOKE_BASE=http://127.0.0.1:3070 SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/browser-smoke.mjs
import puppeteer from 'puppeteer-core';

const BASE = process.env.SMOKE_BASE;
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STORY = '3f2c9a10-7b1e-4c55-9d2a-0a1b2c3d4e5f';

const results = [];
const pageErrors = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err).slice(0, 240) });
  }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
// Feed loading fans out to dozens of external feeds and can stall the dev server. The smoke test is about
// accounts and keys, so feed requests are answered locally with an empty list.
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/rss') || url.includes('/api/article/extract')) {
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, items: [] }) });
  } else {
    req.continue();
  }
});

const bodyHas = (text, timeout = 20000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
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

await step('app loads', () => page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 }));
await step('settings opens', openSettings);
await step('account panel renders sign-in form', () => page.waitForSelector('#auth-email', { timeout: 15000 }));

await step('sign in succeeds and shows the account', async () => {
  await page.type('#auth-email', EMAIL);
  await page.type('#auth-password', PASSWORD);
  // Scope to the account form: the first form on the page is the keyword form.
  await page.evaluate(() => document.getElementById('auth-email').closest('form').querySelector('button[type="submit"]').click());
  await bodyHas('Signed in as');
});

await step('session persists across a reload (cookie session)', async () => {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await openSettings();
  await bodyHas('Signed in as');
});

await step('BYOK: a key the server rejects is refused and never stored', async () => {
  await page.type('#ai-key-input', 'AIza' + 'X'.repeat(35));
  await clickByText('Save and check key');
  await page.waitForFunction(() => {
    const s = document.querySelector('[role="status"]');
    return s && s.innerText.trim().length > 0 && !s.innerText.includes('Checking');
  }, { timeout: 60000 });
  const message = await page.$eval('[role="status"]', (el) => el.innerText.trim());
  if (/saved/i.test(message)) throw new Error(`a rejected key was reported saved: ${message}`);
  const configured = await page.evaluate(() => document.body.innerText.includes('Key configured'));
  if (configured) throw new Error('a rejected key shows as configured');
});

// Valid-key path: needs a real Gemini key in SMOKE_GEMINI_KEY. Skipped (and reported) without one.
if (process.env.SMOKE_GEMINI_KEY) {
  await step('BYOK: a valid key is saved, checked, removed, and gone after reload', async () => {
    await page.evaluate(() => { document.getElementById('ai-key-input').focus(); });
    await page.type('#ai-key-input', process.env.SMOKE_GEMINI_KEY);
    await clickByText('Save and check key');
    await bodyHas('Key configured', 60000);
    await clickByText('Check key');
    await page.waitForFunction(() => /Key works/.test(document.querySelector('[role="status"]')?.innerText ?? ''), { timeout: 60000 });
    await clickByText('Remove');
    await bodyHas('Key removed from this device', 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await openSettings();
    await bodyHas('Signed in as');
    const configured = await page.evaluate(() => document.body.innerText.includes('Key configured'));
    if (configured) throw new Error('key still configured after remove and reload');
  });
} else {
  results.push({ name: 'BYOK valid-key path', ok: true, skipped: 'set SMOKE_GEMINI_KEY to run it' });
}

await step('no API key or session token is written to browser storage', async () => {
  const dump = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  if (dump.includes('AIza')) throw new Error('an AIza key appears in browser storage');
  if (/refresh-token|accessToken|csrfToken/i.test(dump)) throw new Error('an auth token appears in browser storage');
});

await step('sign out returns to the sign-in tabs', async () => {
  await clickByText('Sign out');
  await bodyHas('Create account');
});

await step('story link opened cold on the web does not crash the app', async () => {
  await page.goto(`${BASE}/story/${STORY}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('body');
});

const shot = process.env.SMOKE_SHOT;
if (shot) await page.screenshot({ path: shot, fullPage: false });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, pageErrors }, null, 2));
process.exit(failed.length ? 1 : 0);
