#!/usr/bin/env node
/*
 * Renders the demo song to a WAV file with the app's own audio engine
 * (headless Chromium + OfflineAudioContext), for the tester package.
 *
 *   NODE_PATH=$(npm root -g) node chordflow/tools/render-demo.js <out.wav>
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || path.join(__dirname, '..', 'dist', 'ChordFlow-demo.wav');
  const index = 'file://' + path.join(__dirname, '..', 'index.html');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(index);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); });
  await page.reload();
  await page.waitForSelector('.chord-block');
  await page.evaluate(() => ChordFlowApp.player.ensure()); // sounds load on first use
  await page.waitForFunction(() => ChordFlowApp.state.project.tracks.every((t) => ['ready', 'error'].includes(CF.Sampler.state(t.instrument))), null, { timeout: 60000 });
  const b64 = await page.evaluate(async () => {
    const app = ChordFlowApp;
    const buf = await app.player.render(app.state.project, app.state.arr, { mode: 'mix', countIn: false });
    const blob = CF.encodeWav(buf);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(out, Math.round(fs.statSync(out).size / 1e5) / 10, 'MB');
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
