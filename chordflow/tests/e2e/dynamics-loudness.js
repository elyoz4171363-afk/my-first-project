const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  await p.goto((process.env.CHORDFLOW_URL || 'http://localhost:8090/index.html')); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('.chord-block');
  const t0=Date.now(); await p.waitForFunction(() => ChordFlowApp.state.project.tracks.every((t) => CF.Sampler.state(t.instrument) !== 'loading' && CF.Sampler.state(t.instrument) !== 'idle'), null, { timeout: 60000 });
  console.log('samples', await p.evaluate(() => ChordFlowApp.state.project.tracks.map((t) => t.instrument + ':' + CF.Sampler.state(t.instrument)).join(' ')), 'loaded in', Date.now()-t0, 'ms');
  // measure RMS at master output
  async function measure(setup) {
    await p.evaluate(setup);
    return await p.evaluate(async () => {
      const app = ChordFlowApp, pl = app.player;
      pl.ensure();
      if (!pl.__an) { pl.__an = pl.ac.createAnalyser(); pl.__an.fftSize = 2048; pl.master.connect(pl.__an); }
      await pl.play(0);
      const buf = new Float32Array(2048); let sum = 0, n = 0, peak = 0;
      const t0 = performance.now();
      await new Promise((res) => { const iv = setInterval(() => { pl.__an.getFloatTimeDomainData(buf); for (const x of buf) { sum += x * x; n++; peak = Math.max(peak, Math.abs(x)); } if (performance.now() - t0 > 2500) { clearInterval(iv); res(); } }, 50); });
      pl.stop();
      await new Promise((r) => setTimeout(r, 400));
      return { dB: +(10 * Math.log10(sum / n)).toFixed(1), peak: +peak.toFixed(3) };
    });
  }
  const setLevel = (lvl, only) => `(() => { const s = ChordFlowApp.state; ChordFlowApp.commit((p) => { p.tracks.forEach((t, i) => { t.mute = ${only} != null && i !== ${only}; t.dyn.level = '${lvl}'; }); p.dynamics = { preset: 'flat', points: [{ t: 0, v: 0.5 }] }; }); })()`;
  for (const [name, idx] of [['piano', 0], ['strings', 1], ['cello', 2], ['all', null]]) {
    const pp = await measure(setLevel('pp', idx)), ff = await measure(setLevel('ff', idx));
    console.log(name.padEnd(8), 'pp', pp.dB, 'dB   ff', ff.dB, 'dB   difference', (ff.dB - pp.dB).toFixed(1), 'dB');
  }
  await b.close();
})();
