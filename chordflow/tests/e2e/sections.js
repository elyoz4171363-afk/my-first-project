const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  await p.addInitScript(() => { try { localStorage.setItem('chordflow.mode', 'edit'); } catch (e) { /* */ } }); // editing mode
  p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(process.argv[2]); await p.evaluate(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); }); await p.reload(); await p.waitForSelector('.chord-block');
  console.log('demo sections:', await p.$$eval('.sec-block', (e) => e.map((x) => x.textContent.trim()).join(' | ')), '| text:', (await p.inputValue('#progressionInput')).slice(0, 60));
  await p.locator('.sec-block').nth(1).click();
  console.log('tab:', await p.evaluate(() => ChordFlowApp.state.tab), 'rows', await p.locator('.sec-row').count());
  await p.screenshot({ path: process.argv[3] });
  // turn piano off in chorus
  const pianoRow = p.locator('.sec-row').first();
  await pianoRow.locator('input[data-sec-on]').uncheck();
  const pianoNotes = await p.evaluate(() => { const s = ChordFlowApp.state; const ch = s.project.sections[1]; const pid = s.project.tracks[0].id; return s.arr.tracks.find((t) => t.id === pid).notes.filter((n) => n.t >= ch.start).length; });
  console.log('piano notes in chorus after off:', pianoNotes);
  await pianoRow.locator('select[data-sec-lvl]').isDisabled().then((d) => console.log('level disabled when off:', d));
  // rename + type
  await p.fill('#secName', 'פזמון גדול'); await p.press('#secName', 'Enter');
  console.log('text has new label:', (await p.inputValue('#progressionInput')).includes('[פזמון גדול]'));
  // add section via button at bar 5 (seek)
  await p.evaluate(() => { ChordFlowApp.player.seek(16 * 0 + 4 * 4); });
  await p.click('#addSectionBtn');
  console.log('sections now:', await p.$$eval('.sec-block', (e) => e.map((x) => x.textContent.trim()).join(' | ')));
  // typed labels via composer
  await p.fill('#progressionInput', '[פתיחה] Dm | Bb | [בית] F | C | [פזמון] Gm | A7');
  await p.click('#applyBtn');
  console.log('after apply:', await p.$$eval('.sec-block', (e) => e.map((x) => x.textContent.trim()).join(' | ')));
  await p.click('#undoBtn'); console.log('undo:', await p.$$eval('.sec-block', (e) => e.length));
  console.log('page scroll', await p.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'arr inner', await p.evaluate(() => { const a = document.getElementById('arr'); return a.scrollHeight - a.clientHeight; }));
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
})();
