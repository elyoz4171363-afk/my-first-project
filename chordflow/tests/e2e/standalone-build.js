const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1366, height: 768 } });
  p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('file://' + process.argv[2]); await p.waitForSelector('.chord-block');
  await p.waitForFunction(() => ChordFlowApp.state.project.tracks.every((t) => ['ready', 'error'].includes(CF.Sampler.state(t.instrument))), null, { timeout: 60000 });
  console.log('modules:', await p.evaluate(() => ['Sheet', 'Melody', 'Sampler', 'Articulations'].map((k) => k + ':' + !!CF[k]).join(' ')));
  console.log('sounds:', await p.textContent('#soundStatus'), '| sections:', await p.locator('.sec-block').count(), '| guide:', await p.isVisible('.guide'));
  await p.click('#guideOk');
  await p.click('#playBtn'); await p.waitForTimeout(1500); await p.click('#playBtn');
  console.log('page scroll', await p.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'arr inner', await p.evaluate(() => { const a = document.getElementById('arr'); return a.scrollHeight - a.clientHeight; }));
  await p.screenshot({ path: process.argv[3] });
  console.log('errors', errors.length ? errors : 'none'); await b.close();
})();
