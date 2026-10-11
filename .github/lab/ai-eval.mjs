// Runs ai-eval.html in headless Chromium and writes eval.json. Usage: node ai-eval.mjs <port> <out.json>
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [port, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${port}/ai-eval.html`);
await page.waitForFunction(() => window.__result, null, { timeout: 40 * 60 * 1000 });
const result = await page.evaluate(() => window.__result);
result.consoleTail = logs.slice(-20);
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.average || result, null, 1));
await browser.close();
