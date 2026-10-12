/* Offline acceptance check: no application server or external requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function main() {
  const executablePath = process.env.GRAPHIFY_CHROMIUM_PATH;
  if (executablePath) assert.ok(fs.existsSync(executablePath), 'Browser path must exist');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const externalRequests = [];
    const scriptErrors = [];
    await context.route(/^https?:/, async (route) => {
      externalRequests.push(route.request().url());
      await route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => scriptErrors.push(error.message));
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    assert.match(await page.locator('#summary').innerText(), /^5552 matching files;/);
    assert.equal(await page.locator('#files li').count(), 150);
    await page.locator('#search').fill('proxy.ts');
    assert.ok((await page.locator('#files li').count()) > 0, 'Search must find the proxy');
    for (const text of await page.locator('#files li').allTextContents()) {
      assert.ok(text.toLowerCase().includes('proxy.ts'), 'Search results must match');
    }
    await page.locator('#reset').click();
    await page.locator('#group').selectOption('0');
    assert.match(await page.locator('#summary').innerText(), /^886 matching files;/);
    await page.locator('#reset').click();
    assert.match(await page.locator('#summary').innerText(), /^5552 matching files;/);
    assert.deepEqual(scriptErrors, [], 'Explorer must have no script errors');
    assert.deepEqual(externalRequests, [], 'Explorer must make no external requests');
    process.stdout.write(JSON.stringify({ passed: true, checks: 8, external_requests: 0 }) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
