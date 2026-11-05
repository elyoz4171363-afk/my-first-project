const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('file://' + process.argv[2]); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('.chord-block');
  // record scheduled clicks
  await p.evaluate(() => {
    window.__clicks = [];
    const orig = CF.AudioVoices.click;
    CF.AudioVoices.click = function (ac, out, pitch, vel, t) { window.__clicks.push({ pitch, t }); return orig.apply(this, arguments); };
  });
  console.log('group field hidden in 4/4:', await p.isHidden('#groupField'));
  await p.selectOption('#timeSigSelect', '7/8');
  console.log('group options in 7/8:', await p.$$eval('#groupSelect option', (o) => o.map((x) => x.value).join(' | ')));
  await p.selectOption('#groupSelect', '3+2+2');
  await p.fill('#bpmInput', '120'); await p.press('#bpmInput', 'Enter');
  await p.click('#metroBtn');
  await p.click('#playBtn'); await p.waitForTimeout(2300); await p.click('#stopBtn');
  const seq = await p.evaluate(() => { const c = window.__clicks; const t0 = c[0].t; return c.slice(0, 14).map((x) => ({ 1760: 'X', 1318: 'x', 988: '.' }[x.pitch]) ).join(''); });
  console.log('7/8 (3+2+2) clicks, X=downbeat x=beat .=eighth:', seq);
  await p.selectOption('#timeSigSelect', '6/8');
  await p.evaluate(() => { window.__clicks = []; });
  await p.click('#playBtn'); await p.waitForTimeout(1700); await p.click('#stopBtn');
  console.log('6/8 clicks:', await p.evaluate(() => window.__clicks.slice(0, 12).map((x) => ({ 1760: 'X', 1318: 'x', 988: '.' }[x.pitch])).join('')));
  // volume
  await p.fill('#metroVol', '0.2'); await p.dispatchEvent('#metroVol', 'input'); await p.dispatchEvent('#metroVol', 'change');
  await p.click('#playBtn'); await p.waitForTimeout(300);
  console.log('metro volume saved:', await p.evaluate(() => ChordFlowApp.state.project.metro.volume), 'click gain in engine:', await p.evaluate(() => ChordFlowApp.player.session.click.gain.value.toFixed(3)));
  await p.fill('#metroVol', '1'); await p.dispatchEvent('#metroVol', 'input'); await p.waitForTimeout(200);
  console.log('live gain at 100:', await p.evaluate(() => ChordFlowApp.player.session.click.gain.value.toFixed(3)));
  await p.click('#stopBtn');
  await p.selectOption('#timeSigSelect', '7/8');
  await p.locator('.console').screenshot({ path: process.argv[3] });
  await p.reload(); await p.waitForSelector('.chord-block');
  console.log('after reload: meter', await p.inputValue('#timeSigSelect'), 'grouping', await p.inputValue('#groupSelect'), 'vol', await p.inputValue('#metroVol'));
  console.log('errors:', errors.length ? errors : 'none');
  await b.close();
})();
