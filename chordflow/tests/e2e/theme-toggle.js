const { chromium } = require('playwright');
const OUT = process.argv[2], URL = 'file://' + process.argv[3];
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { try { localStorage.setItem('chordflow.mode', 'edit'); } catch (e) { /* */ } }); // editing mode
  await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('.chord-block');
  const skin = () => p.evaluate(() => [document.documentElement.dataset.skin, document.getElementById('skinLabel').textContent].join(' / '));
  console.log('fresh:', await skin());
  await p.screenshot({ path: OUT + '/home-dark.png' });
  await p.click('#moreBtn'); await p.click('#skinBtn'); await p.waitForTimeout(150);
  console.log('after click:', await skin());
  await p.reload(); await p.waitForSelector('.chord-block');
  console.log('after reload:', await skin());
  await p.screenshot({ path: OUT + '/home-light.png' });
  await p.click('#moreBtn'); await p.click('#skinBtn'); console.log('click again:', await skin());
  const m = await b.newPage({ viewport: { width: 390, height: 844 } }); await m.goto(URL); await m.waitForSelector('.mv-bar');
  console.log('phone: read-and-play view', await m.isVisible('#mobileView'), '| skin kept:', await m.evaluate(() => document.documentElement.dataset.skin), '| overflow', await m.evaluate(() => document.documentElement.scrollWidth));
  console.log('errors:', errors.length ? errors : 'none');
  await b.close();
})();
