const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto((process.env.CHORDFLOW_URL || 'http://localhost:8090/index.html')); await p.evaluate(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); }); await p.reload(); await p.waitForSelector('.chord-block');
  await p.fill('#progressionInput', 'C | Am | F | G'); await p.click('#applyBtn');
  const chords = () => p.evaluate(() => ChordFlowApp.state.project.chords.map((c) => c.symbol + '@' + c.start + '/' + c.length).join(' '));
  const blocks = p.locator('.chord-block');
  // ctrl-click multi
  await blocks.nth(0).click(); await blocks.nth(2).click({ modifiers: ['Control'] });
  console.log('multi:', await p.evaluate(() => [...ChordFlowApp.state.multi].length), '| inspector:', (await p.textContent('#inspectorBody .group-title')).trim());
  // shift range
  await blocks.nth(0).click(); await blocks.nth(3).click({ modifiers: ['Shift'] });
  console.log('shift range:', await p.evaluate(() => ChordFlowApp.state.multi.size));
  // copy + paste at bar 3 (playhead)
  await p.keyboard.press('Control+c');
  await p.evaluate(() => { ChordFlowApp.player.seek(8); });
  await p.keyboard.press('Escape');
  await p.keyboard.press('Control+v');
  console.log('after paste:', await chords());
  await p.keyboard.press('Control+z');
  // transpose selection
  await blocks.nth(1).click(); await p.keyboard.press('Control+ArrowUp');
  console.log('transpose Am+1:', await chords());
  // split at playhead inside chord 0
  await blocks.nth(0).click(); await p.evaluate(() => ChordFlowApp.player.seek(2)); await p.keyboard.press('s');
  console.log('split:', await chords());
  // join both halves (selected after split)
  await p.keyboard.press('j');
  console.log('join:', await chords());
  // rubber band select first two
  const lane = await p.locator('#laneChords').boundingBox();
  const b0 = await blocks.nth(0).boundingBox(), b1 = await blocks.nth(1).boundingBox();
  await p.evaluate(() => { const c = ChordFlowApp.state.project.chords; }); 
  // need empty space: delete bar 2 region? use right-click insert bar first
  await p.mouse.click(b1.x + 20, b1.y + 20, { button: 'right' });
  console.log('menu items:', (await p.$$eval('#ctxMenu button', (e) => e.length)));
  await p.click('#ctxMenu button:has-text("הוספת תיבה ריקה כאן")');
  console.log('insert bar:', await chords());
  const lb = await p.locator('#laneChords').boundingBox();
  const zoom = await p.evaluate(() => ChordFlowApp.state.zoom);
  await p.mouse.move(lb.x + 4 * zoom + 10, lb.y + 30); await p.mouse.down(); await p.mouse.move(lb.x + 4 * zoom + 60, lb.y + 30, { steps: 3 }); await p.mouse.move(lb.x + 13 * zoom, lb.y + 30, { steps: 5 }); await p.mouse.up();
  console.log('rubber band selected:', await p.evaluate(() => [...ChordFlowApp.state.multi].map((id) => ChordFlowApp.state.project.chords.find((c) => c.id === id).symbol).join(',')));
  await p.keyboard.press('Delete'); console.log('delete selection:', await chords());
  // delete bar via menu
  const bb = await blocks.nth(0).boundingBox();
  await p.mouse.click(bb.x + 20, bb.y + 20, { button: 'right' }); await p.click('#ctxMenu button:has-text("מחיקת התיבה הזו")');
  console.log('delete bar:', await chords());
  // ruler drag loop
  const r = await p.locator('#laneRuler').boundingBox();
  await p.mouse.move(r.x + 5, r.y + 10); await p.mouse.down(); await p.mouse.move(r.x + 9 * zoom, r.y + 10, { steps: 6 }); await p.mouse.up();
  console.log('loop:', JSON.stringify(await p.evaluate(() => ChordFlowApp.state.project.loop)));
  await p.click('#zoomFit'); console.log('zoom fit:', await p.evaluate(() => ChordFlowApp.state.zoom));
  console.log('errors', errors.length ? errors : 'none'); await b.close();
})();
