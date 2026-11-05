const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2], URL = process.argv[3];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const log = (...a) => console.log('•', ...a);
  await page.goto(URL); await page.evaluate(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); }); await page.reload();
  await page.waitForSelector('.chord-block');
  log('tracks', await page.locator('.th').count(), 'chords', await page.locator('.chord-block').count());
  await page.screenshot({ path: OUT + '/n1-initial.png' });
  // play with orchestral preview
  await page.click('#playBtn'); await page.waitForTimeout(1200);
  log('playing', await page.evaluate(() => [ChordFlowApp.player.playing, ChordFlowApp.state.position.toFixed(2)]));
  await page.click('#playBtn');
  // select strings track, dynamics tab
  await page.locator('.th').nth(1).click();
  await page.click('#tab-dyn');
  await page.screenshot({ path: OUT + '/n2-dyn.png' });
  await page.click('#dynLevel [data-level="ff"]');
  await page.click('.shape[data-shape="cresc"]');
  await page.fill('#dynEmotion', '90'); await page.dispatchEvent('#dynEmotion', 'change');
  await page.click('#dynAdv summary'); await page.uncheck('.cc input[data-cc="11"]'); await page.check('.cc input[data-cc="2"]');
  const t1 = await page.evaluate(() => { const t = ChordFlowApp.state.project.tracks[1]; return JSON.stringify(t.dyn); });
  log('strings dyn', t1);
  log('caption', await page.textContent('#dynCaption'));
  // track tab: pattern + instrument change
  await page.click('#tab-track');
  await page.click('.pat[data-pattern="tremolo"]');
  await page.selectOption('#trInstrument', 'flute');
  log('track after change', await page.evaluate(() => { const t = ChordFlowApp.state.project.tracks[1]; return [t.family, t.instrument, t.pattern, t.name, t.dyn.level].join(' '); }));
  await page.click('#trRegister [data-reg="1"]');
  // add a track via menu
  await page.click('#addTrackBtn'); await page.click('#addTrackMenu [data-inst="horns"]');
  log('tracks after add', await page.locator('.th').count(), 'channels', (await page.evaluate(() => ChordFlowApp.state.project.tracks.map(t => t.channel))).join(','));
  // song curve: preset + drag point
  await page.selectOption('#curvePreset', 'build');
  const dl = await page.locator('#laneDyn').boundingBox();
  await page.mouse.move(dl.x + 300, dl.y + 70); await page.mouse.down(); await page.mouse.move(dl.x + 320, dl.y + 15, { steps: 5 }); await page.mouse.up();
  log('curve', await page.evaluate(() => JSON.stringify(ChordFlowApp.state.project.dynamics)));
  // ensemble
  await page.selectOption('#ensembleSelect', 'quartet'); await page.click('#confirmYes');
  log('quartet tracks', (await page.evaluate(() => ChordFlowApp.state.project.tracks.map(t => t.name + ':' + t.pattern))).join(' | '));
  await page.click('#undoBtn');
  log('after undo tracks', await page.locator('.th').count());
  // chord inspector
  await page.locator('.chord-block').nth(2).click();
  log('chord tab', await page.inputValue('#inspSymbol'), '| tones', (await page.textContent('.tones')).replace(/\s+/g, ' ').trim());
  // mute + export
  await page.locator('.th').first().locator('.m').click();
  await page.click('#exportBtn');
  await page.screenshot({ path: OUT + '/n3-export.png' });
  const [d] = await Promise.all([page.waitForEvent('download'), page.click('#exportConfirm')]);
  await d.saveAs(OUT + '/export.mid'); log('exported', d.suggestedFilename());
  // reload persistence
  await page.waitForTimeout(600); await page.reload(); await page.waitForSelector('.chord-block');
  log('after reload tracks', await page.locator('.th').count(), 'curve preset', await page.inputValue('#curvePreset'));
  await page.screenshot({ path: OUT + '/n4-full.png', fullPage: true });
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage(); mp.on('pageerror', (e) => errors.push('mobile ' + e.message));
  await mp.goto(URL); await mp.waitForSelector('.chord-block');
  log('mobile overflow', await mp.evaluate(() => [document.documentElement.scrollWidth, innerWidth].join('/')));
  await mp.screenshot({ path: OUT + '/n5-mobile.png', fullPage: true });
  log('ERRORS', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
