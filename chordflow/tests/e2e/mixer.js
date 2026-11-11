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
  // fader by mouse: drag the cap to the bottom of its track
  const f = p.locator('[data-fader]').first();
  const fb = await f.boundingBox();
  console.log('fader size:', Math.round(fb.width) + 'x' + Math.round(fb.height));
  if (fb.height < 250) console.log('FAILED fader too small');
  const hist0 = await p.evaluate(() => ChordFlowApp.state.history.length);
  const cap = await p.locator('[data-fader] .mx-cap').first().boundingBox();
  await p.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2); await p.mouse.down();
  await p.mouse.move(cap.x + cap.width / 2, fb.y + fb.height + 40, { steps: 6 }); await p.mouse.up();
  const low = await p.evaluate(() => ChordFlowApp.state.project.tracks[0].volume);
  console.log('dragged to the bottom:', low);
  if (low !== 0) console.log('FAILED drag down should reach 0');
  // keyboard: End = top (1.0), PageDown x5 = 0.5, one undo step per gesture
  await f.focus(); await p.keyboard.press('End');
  for (let i = 0; i < 5; i++) await p.keyboard.press('PageDown');
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => ({ vol: ChordFlowApp.state.project.tracks[0].volume, hist: ChordFlowApp.state.history.length }));
  r.hist -= 1; // the mouse gesture above
  console.log('track 1 volume:', r.vol, '| undo steps added:', r.hist - hist0, '| label:', await p.textContent('[data-db]'));
  if (r.vol !== 0.5 || r.hist - hist0 !== 1) console.log('FAILED fader');
  await p.focus('#mxMasterFader'); await p.keyboard.press('PageUp'); await p.keyboard.press('PageUp'); await p.waitForTimeout(600);
  // pan: dragging toward the left side of the screen must give L
  const pan = p.locator('[data-pan]').first(); const pb = await pan.boundingBox();
  await p.mouse.click(pb.x + 3, pb.y + pb.height / 2);
  const pv = await p.evaluate(() => ChordFlowApp.state.project.tracks[0].pan);
  console.log('pan after clicking its left end:', pv, await p.textContent('[data-pan-out]'));
  if (!(pv < -0.8)) console.log('FAILED pan direction');
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
