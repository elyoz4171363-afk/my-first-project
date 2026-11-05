const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.goto((process.env.CHORDFLOW_URL || 'http://localhost:8090/index.html')); await p.evaluate(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); }); await p.reload(); await p.waitForSelector('.chord-block');
  await p.click('#exportBtn'); await p.click('#expTabs [data-exp="audio"]');
  for (const [mode, file] of [['mix', 'mix.wav'], ['solo', 'solo.wav'], ['minus', 'minus.wav']]) {
    await p.check(`input[name="audioMode"][value="${mode}"]`);
    if (mode !== 'mix') await p.selectOption('#audioTrack', { index: 0 });
    const t0 = Date.now();
    const [d] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click('#exportConfirm')]);
    await d.saveAs(process.argv[2] + '/' + file);
    console.log(mode, d.suggestedFilename(), 'in', Date.now() - t0, 'ms |', await p.textContent('#audioStatus'));
  }
  await p.click('#expTabs [data-exp="sheet"]');
  await p.selectOption('#sheetTrans', 'bb'); await p.check('#sheetNumerals');
  const [popup] = await Promise.all([p.waitForEvent('popup'), p.click('#exportConfirm')]);
  await popup.waitForLoadState(); await popup.setViewportSize({ width: 900, height: 1100 });
  await popup.screenshot({ path: process.argv[3], fullPage: true });
  console.log('sheet title:', await popup.title(), '| bars:', await popup.locator('.bar:not(.empty)').count());
  console.log('errors', errors.length ? errors : 'none'); await b.close();
})();
