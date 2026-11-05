const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  for (const [w, h, skin] of [[1366, 768, 'graphite'], [1440, 900, 'graphite'], [1920, 1080, 'ivory']]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.5 });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto('file://' + process.argv[2]); await p.evaluate((s) => { localStorage.clear(); localStorage.setItem('chordflow.skin', s); }, skin); await p.reload(); await p.waitForSelector('.chord-block');
    await p.locator('.th').nth(1).click(); await p.click('#tab-dyn'); await p.waitForTimeout(300);
    const r = await p.evaluate(() => {
      const de = document.documentElement;
      const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return Math.round(r.bottom); };
      const arr = document.getElementById('arr');
      return { pageScroll: de.scrollHeight - innerHeight, hScroll: de.scrollWidth - innerWidth, console: box('.console'), composer: box('.composer'), arrange: box('.arrange'), inspector: box('.inspector'),
        arrInnerScroll: arr.scrollHeight - arr.clientHeight, trackRow: getComputedStyle(document.querySelector('.th')).height, insScroll: (() => { const e = document.getElementById('inspectorBody'); return e.scrollHeight - e.clientHeight; })() };
    });
    console.log(`${w}x${h}:`, JSON.stringify(r));
    await p.screenshot({ path: `${process.argv[3]}/fit-${w}x${h}.png` });
    // with 9 instruments
    await p.evaluate(() => ChordFlowApp.commit((pr) => { for (let i = 0; i < 4; i++) pr.tracks.push(CF.Project.makeTrack(['violins', 'flute', 'trumpets', 'choir'][i], pr.tracks)); }));
    await p.waitForTimeout(200);
    console.log('   9 instruments:', JSON.stringify(await p.evaluate(() => ({ pageScroll: document.documentElement.scrollHeight - innerHeight, arrInnerScroll: document.getElementById('arr').scrollHeight - document.getElementById('arr').clientHeight, trackRow: getComputedStyle(document.querySelector('.th')).height }))));
    await p.close();
  }
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
})();
