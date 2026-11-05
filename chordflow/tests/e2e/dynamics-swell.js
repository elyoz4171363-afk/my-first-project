const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  await p.goto(process.argv[2]); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('.chord-block');
  await p.waitForFunction(() => ChordFlowApp.state.project.tracks.every((t) => ['ready', 'error'].includes(CF.Sampler.state(t.instrument))), null, { timeout: 60000 });
  async function envelope(shape, idx, noSamples) {
    return await p.evaluate(async ([shape, idx, noSamples]) => {
      ChordFlowApp.commit((pr) => { pr.bpm = 60; pr.loop.enabled = false; pr.dynamics = { preset: 'flat', points: [{ t: 0, v: 0.5 }] };
        pr.tracks.forEach((t, i) => { t.mute = idx >= 0 && i !== idx; t.dyn.shape = shape; t.dyn.emotion = 65; }); });
      const pl = ChordFlowApp.player; pl.ensure();
      if (noSamples) { window.__origPlay = window.__origPlay || CF.Sampler.play; CF.Sampler.play = () => false; } else if (window.__origPlay) CF.Sampler.play = window.__origPlay;
      if (!pl.__an) { pl.__an = pl.ac.createAnalyser(); pl.__an.fftSize = 2048; pl.master.connect(pl.__an); }
      await pl.play(0);
      const buf = new Float32Array(2048), out = []; const t0 = performance.now();
      await new Promise((res) => { const iv = setInterval(() => { pl.__an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; out.push(10 * Math.log10(s / buf.length + 1e-12)); if (performance.now() - t0 > 4000) { clearInterval(iv); res(); } }, 250); });
      pl.stop(); await new Promise((r) => setTimeout(r, 300));
      return out.map((x) => x.toFixed(0)).join(' ');
    }, [shape, idx, noSamples]);
  }
  console.log('strings flat :', await envelope('flat', 1));
  console.log('strings swell:', await envelope('swell', 1));
  console.log('piano   swell:', await envelope('swell', 0));
  console.log('ALL     swell:', await envelope('swell', -1));
  console.log('synth strings swell (no samples):', await envelope('swell', 1, true));
  // UI: listen + compare buttons
  await p.evaluate(() => { if (window.__origPlay) CF.Sampler.play = window.__origPlay; });
  await p.reload(); await p.waitForSelector('.chord-block');
  await p.locator('.th').nth(1).click(); await p.click('#tab-dyn');
  await p.click('#dynListen'); await p.waitForTimeout(800);
  console.log('listen mode:', await p.evaluate(() => [ChordFlowApp.player.playing, ChordFlowApp.player.listenTrack === ChordFlowApp.state.project.tracks[1].id].join(',')), 'button:', (await p.textContent('#dynListen')).trim());
  const gains = await p.evaluate(() => Object.values(ChordFlowApp.player.session.tracks).map((n) => n.gain.gain.value.toFixed(2)).join(' '));
  console.log('track gains while listening:', gains);
  await p.click('#dynListen'); await p.waitForTimeout(200);
  console.log('after stop:', await p.evaluate(() => ChordFlowApp.player.playing), (await p.textContent('#dynListen')).trim());
  await p.click('#dynCompare'); await p.waitForTimeout(500);
  console.log('sound status:', await p.textContent('#soundStatus'));
  await b.close();
})();
