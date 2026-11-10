#!/usr/bin/env node
/*
 * Measures the numbers we report: first-load weight and time on emulated 4G, horizontal
 * overflow at 360px, console errors, and the delay from a click (or an incoming MIDI note)
 * to the scheduled sound.
 *
 *   python3 -m http.server 8096 --directory chordflow &
 *   NODE_PATH=$(npm root -g) node chordflow/tools/measure.js [http://localhost:8096]
 *
 * Latency = (handler start - input event) + (scheduled start - audio clock now) + baseLatency
 * + outputLatency. Headless Chromium reports outputLatency 0, so the real device adds its own
 * output buffer on top (status: estimate for the device part).
 */
'use strict';
const { chromium } = require('playwright');
const URL = (process.argv[2] || 'http://localhost:8096') + '/index.html';

(async () => {
  const b = await chromium.launch();
  const res = { date: new Date().toISOString().slice(0, 10), url: URL };

  // 1. first load on emulated networks (cache off): bytes + time until the UI is usable
  for (const [label, down, rtt] of [['4G 9Mbps 85ms', 9e6, 85], ['slow 4G 1.6Mbps 150ms', 1.6e6, 150]]) {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: down / 8, uploadThroughput: 750000 / 8 });
    let bytes = 0, samples = 0;
    const urls = new Map();
    cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; if (/\/samples\//.test(urls.get(e.requestId) || '')) samples += e.encodedDataLength; });
    await p.addInitScript(() => { try { localStorage.setItem('chordflow.guideSeen', '1'); } catch (e) { /* */ } });
    const t0 = Date.now();
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await p.waitForSelector('.chord-block', { timeout: 180000 });
    const ui = Date.now() - t0;
    await p.waitForLoadState('networkidle', { timeout: 180000 }).catch(() => {});
    res[label] = { uiReadyMs: ui, firstLoadMB: +(bytes / 1e6).toFixed(3), samplesMB: +(samples / 1e6).toFixed(3) };
    // then the first play: how long until the recorded instruments are ready
    const t1 = Date.now();
    await p.evaluate(() => ChordFlowApp.player.ensure());
    await p.waitForFunction(() => ChordFlowApp.state.project.tracks.every((t) => ['ready', 'error'].includes(CF.Sampler.state(t.instrument))), null, { timeout: 300000 });
    res[label].firstPlaySoundsMs = Date.now() - t1;
    res[label].afterFirstPlayMB = +(bytes / 1e6).toFixed(2);
    await ctx.close();
  }

  // 2. 360px: horizontal overflow + console errors
  const m = await b.newPage({ viewport: { width: 360, height: 740 } });
  const errs = [];
  m.on('console', (x) => x.type() === 'error' && errs.push(x.text()));
  m.on('pageerror', (e) => errs.push(e.message));
  await m.goto(URL); await m.waitForSelector('.mv-bar');
  res.w360 = await m.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  res.consoleErrors360 = errs.length;

  // 3. click -> sound
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('console', (x) => x.type() === 'error' && errs.push(x.text()));
  await p.addInitScript(() => { try { localStorage.setItem('chordflow.guideSeen', '1'); } catch (e) { /* */ } });
  await p.goto(URL); await p.waitForSelector('.chord-block');
  await p.evaluate(() => ChordFlowApp.player.ensure());
  await p.waitForFunction(() => ChordFlowApp.state.project.tracks.every((t) => ['ready', 'error'].includes(CF.Sampler.state(t.instrument))), null, { timeout: 60000 });
  await p.evaluate(() => {
    window.__lat = [];
    const orig = CF.Sampler.play;
    CF.Sampler.play = function (ac, out, id, pitch, vel, t) {
      const ok = orig.apply(this, arguments);
      if (window.__evt != null) {
        window.__lat.push((performance.now() - window.__evt) + (t - ac.currentTime) * 1000 + (ac.baseLatency || 0) * 1000 + (ac.outputLatency || 0) * 1000);
        window.__evt = null;
      }
      return ok;
    };
    document.addEventListener('pointerdown', (e) => { window.__evt = e.timeStamp; }, true);
  });
  const blocks = p.locator('.chord-block');
  for (let i = 0; i < 6; i++) { await blocks.nth(i % 4).click(); await p.waitForTimeout(250); }
  const lat = await p.evaluate(() => window.__lat);
  res.clickToSoundMs = { samples: lat.length, median: +median(lat).toFixed(1), max: +Math.max(...lat).toFixed(1) };
  res.audio = await p.evaluate(() => ({ baseLatencyMs: +(ChordFlowApp.player.ac.baseLatency * 1000).toFixed(1), outputLatencyMs: +((ChordFlowApp.player.ac.outputLatency || 0) * 1000).toFixed(1) }));
  if (CFHasLive(await p.evaluate(() => !!(window.CF && CF.MidiLive)))) {
    res.midiInToSoundMs = await p.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const ts = performance.now();
        const r = CF.MidiLive.handleMessage({ data: new Uint8Array([0x90, 60 + i, 100]), timeStamp: ts });
        if (r && r.when != null) out.push((performance.now() - ts) + (r.when - r.now) * 1000 + (r.base || 0) * 1000);
        CF.MidiLive.handleMessage({ data: new Uint8Array([0x80, 60 + i, 0]), timeStamp: performance.now() });
        await new Promise((z) => setTimeout(z, 80));
      }
      out.sort((a, b) => a - b);
      return { samples: out.length, median: out.length ? +out[Math.floor(out.length / 2)].toFixed(1) : null };
    });
  }
  res.consoleErrors = errs.length;
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });

function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; }
function CFHasLive(x) { return x; }
