// Mixer: opens with X, one strip per track + master, faders change sound live and commit one undo
// step on release, M/S, master volume reaches CC7, meters move while playing.
const { chromium } = require('playwright');
const URL = process.argv[2], OUT = process.argv[3];
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.addInitScript(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); });
  await p.goto(URL); await p.waitForSelector('.chord-block');
  await p.keyboard.press('x');
  await p.waitForSelector('#mixer:not([hidden])');
  const n = await p.locator('#mxStrips .mx-strip').count();
  console.log('strips:', n, 'tracks:', await p.evaluate(() => ChordFlowApp.state.project.tracks.length));
  // fader: set first track to 50 with the keyboard
  const f = p.locator('[data-fader]').first();
  await f.focus();
  const hist0 = await p.evaluate(() => ChordFlowApp.state.history.length);
  await f.fill('50'); await f.dispatchEvent('input'); await f.dispatchEvent('change');
  const r = await p.evaluate(() => ({ vol: ChordFlowApp.state.project.tracks[0].volume, hist: ChordFlowApp.state.history.length }));
  console.log('track 1 volume:', r.vol, '| undo steps added:', r.hist - hist0, '| label:', await p.textContent('[data-db]'));
  if (r.vol !== 0.5 || r.hist - hist0 !== 1) console.log('FAILED fader');
  await p.locator('#mxMasterFader').fill('120'); await p.dispatchEvent('#mxMasterFader', 'input'); await p.dispatchEvent('#mxMasterFader', 'change');
  console.log('master:', await p.evaluate(() => ChordFlowApp.state.project.master.volume), await p.textContent('#mxMasterDb'));
  await p.click('#mxStrips [data-act="solo"] >> nth=1');
  console.log('solo on track 2:', await p.evaluate(() => ChordFlowApp.state.project.tracks[1].solo));
  await p.click('#mxStrips [data-act="solo"] >> nth=1');
  // meters while playing
  await p.click('#playBtn'); await p.waitForTimeout(2500);
  const m = await p.evaluate(() => [...document.querySelectorAll('[data-meter]')].map((x) => parseFloat(x.style.height) || 0));
  console.log('meter heights while playing:', m.map((x) => Math.round(x)).join(' '));
  if (!m.some((x) => x > 10)) console.log('FAILED meters do not move');
  if (OUT) await p.screenshot({ path: OUT + '/mixer.png' });
  await p.click('#stopBtn');
  await p.keyboard.press('Escape');
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
