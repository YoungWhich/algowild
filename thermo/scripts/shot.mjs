/* 截图脚本：node scripts/shot.mjs [baseUrl] */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = process.env.PW_PATH || 'C:/Users/JM/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const BASE = process.argv[2] || 'http://127.0.0.1:8899/';
const OUT = new URL('../shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT, { recursive: true });

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: true });

async function shot(name, { w = 1440, h = 900, mobile = false, act } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (act) { await act(page); await page.waitForTimeout(900); }
  await page.screenshot({ path: OUT + name + '.png', fullPage: false });
  console.log('✓', name, errs.length ? '\n   ' + errs.join('\n   ') : '');
  await ctx.close();
  return errs;
}

const all = [];
all.push(...await shot('01-dash', {}));
all.push(...await shot('02-add', { act: p => p.click('#fab2') }));
all.push(...await shot('03-flow', { act: p => p.click('.navitem[data-view="flow"]') }));
all.push(...await shot('04-stats', { act: p => p.click('.navitem[data-view="stats"]') }));
all.push(...await shot('05-report', { act: p => p.click('.navitem[data-view="report"]') }));
all.push(...await shot('06-mobile-dash', { w: 390, h: 844, mobile: true }));
all.push(...await shot('07-mobile-add', {
  w: 390, h: 844, mobile: true,
  act: async p => { await p.click('.tab-add'); await p.click('#a-keys button[data-k="4"]'); }
}));

await browser.close();
console.log(all.length ? '\n❌ 有报错' : '\n✅ 无控制台错误');
