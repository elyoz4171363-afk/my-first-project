// Phone (< 768 px): a designed read-and-play screen. No horizontal scroll, chord chart, playback marks the bar.
const { chromium, devices } = require('playwright');
(async () => { const b = await chromium.launch(); const errs = [];
 for (const [name, vp] of [['360', { viewport: { width: 360, height: 740 } }], ['iphone', devices['iPhone 13']]]) {
  const ctx = await b.newContext(vp); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(process.argv[2]); await p.waitForSelector('.mv-bar'); await p.waitForTimeout(300);
  console.log(name, await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bars: document.querySelectorAll('.mv-bar[data-bar]').length, secs: [...document.querySelectorAll('.mv-sec')].map((x) => x.textContent).join(','), meta: document.getElementById('mvMeta').textContent })));
  await p.screenshot({ path: process.argv[3] + '/phone-' + name + '.png', fullPage: true });
  await p.click('#mvPlay'); await p.waitForTimeout(4500);
  const pl = await p.evaluate(() => ({ playing: ChordFlowApp.player.playing, now: document.querySelector('.mv-bar.now') && document.querySelector('.mv-bar.now').dataset.bar, pos: document.getElementById('mvPos').textContent }));
  console.log(' playing', JSON.stringify(pl)); if (!pl.playing || pl.now == null) console.log('FAILED playback on phone');
  await p.click('#mvStop'); await ctx.close(); }
 console.log('errors', errs.length ? errs : 'none'); await b.close(); })();
