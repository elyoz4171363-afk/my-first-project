// Piano roll: open by double-click on a track lane, add / move / resize / delete notes, velocity,
// right-click menu, controller drawing, undo, and the edited notes reach the MIDI file.
const { chromium } = require('playwright');
const URL = process.argv[2], OUT = process.argv[3];
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.addInitScript(() => { localStorage.clear(); localStorage.setItem('chordflow.guideSeen', '1'); });
  await p.goto(URL); await p.waitForSelector('.chord-block');
  const lane = p.locator('.lane-track').first();
  await lane.dblclick({ position: { x: 60, y: 20 } });
  await p.waitForSelector('#pianoRoll:not([hidden])');
  const S = () => p.evaluate(() => { const s = CF.PianoRoll._state; return { notes: s.notes.length, sel: s.sel.size, edited: s.edited, proj: !!ChordFlowApp.state.project.tracks[0].edit }; });
  console.log('opened:', JSON.stringify(await S()), '| title:', await p.textContent('#prTitle'));
  if (OUT) await p.screenshot({ path: OUT + '/piano-roll.png' });
  // geometry helper: page coordinates of (t, pitch)
  const at = (t, pitch) => p.evaluate(([t, pitch]) => { const sc = document.getElementById('prScroll'); const r = sc.getBoundingClientRect(); const s = CF.PianoRoll._state; return { x: r.left + t * s.ppq - sc.scrollLeft + 3, y: r.top + (127 - pitch) * s.rh - sc.scrollTop + s.rh / 2 }; }, [t, pitch]);
  // add a note by double-click on an empty spot
  // an empty row in view (no notes within 2 semitones), so the test edits its own note
  const free = await p.evaluate(() => { const s = CF.PianoRoll._state; const sc = document.getElementById('prScroll'); const top = 127 - Math.floor(sc.scrollTop / s.rh) - 2; const bot = 127 - Math.floor((sc.scrollTop + sc.clientHeight) / s.rh) + 4; for (let q = top - 3; q > bot; q--) if (!s.notes.some((n) => Math.abs(n.pitch - q) <= 2 || Math.abs(n.pitch - (q + 2)) <= 1 || n.pitch === q + 3)) return { t: 2.5, pitch: q }; return { t: 2.5, pitch: top - 3 }; });
  console.log('free row:', free.pitch);
  let pt = await at(free.t, free.pitch);
  await p.mouse.dblclick(pt.x + 4, pt.y);
  await p.waitForTimeout(700);
  let s = await S();
  console.log('after add:', JSON.stringify(s));
  if (!s.edited || !s.proj) console.log('FAILED first edit should freeze the track');
  const added = await p.evaluate((pitch) => CF.PianoRoll._state.notes.find((n) => n.pitch === pitch && Math.abs(n.t - 2.5) < 1e-6), free.pitch);
  if (!added) console.log('FAILED note not added at 2.5');
  // drag it up 2 semitones and right one beat
  pt = await at(2.5, free.pitch);
  await p.mouse.move(pt.x + 4, pt.y); await p.mouse.down(); await p.mouse.move(pt.x + 4 + 72, pt.y - 2 * 14, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(700);
  const moved = await p.evaluate(() => { const n = [...CF.PianoRoll._state.sel][0]; return n && { t: n.t, pitch: n.pitch, dur: n.dur }; });
  console.log('moved to:', moved && moved.t, moved && moved.pitch);
  if (!moved || Math.abs(moved.t - 3.5) > 1e-6) console.log('FAILED move');
  // resize from the right edge
  const len0 = moved.dur;
  pt = await at(3.5 + moved.dur, free.pitch + 2);
  await p.mouse.move(pt.x - 6, pt.y); await p.mouse.down(); await p.mouse.move(pt.x - 6 + 36, pt.y, { steps: 4 }); await p.mouse.up(); await p.waitForTimeout(700);
  const len1 = await p.evaluate(() => [...CF.PianoRoll._state.sel][0].dur);
  console.log('length', len0, '->', len1);
  if (!(len1 > len0)) console.log('FAILED resize');
  // right-click menu on the note
  pt = await at(3.6, free.pitch + 2);
  await p.mouse.click(pt.x, pt.y, { button: 'right' });
  await p.waitForSelector('#prMenu:not([hidden])');
  console.log('menu items:', await p.locator('#prMenu .prm-item').count(), '| rows:', await p.locator('#prMenu .prm-row').count());
  if (OUT) await p.screenshot({ path: OUT + '/piano-roll-menu.png' });
  await p.click('#prMenu .prm-row button:has-text("ff")');
  console.log('velocity after ff:', await p.evaluate(() => [...CF.PianoRoll._state.sel][0].vel));
  // keyboard: up arrow transposes, Delete removes
  await p.keyboard.press('ArrowUp');
  console.log('after ArrowUp pitch:', await p.evaluate(() => [...CF.PianoRoll._state.sel][0].pitch), '(was', free.pitch + 2, ')');
  // CC11 lane drawing
  await p.selectOption('#prLaneSel', '11');
  const lb = await p.locator('#prLane').boundingBox();
  await p.mouse.move(lb.x + 20, lb.y + lb.height - 10); await p.mouse.down(); await p.mouse.move(lb.x + 300, lb.y + 10, { steps: 10 }); await p.mouse.up();
  const cc = await p.evaluate(() => (ChordFlowApp.state.project.tracks[0].edit.cc[11] || []).length);
  console.log('CC11 points drawn:', cc);
  if (cc < 5) console.log('FAILED CC drawing');
  // undo through the app history
  const before = await p.evaluate(() => CF.PianoRoll._state.notes.length);
  await p.keyboard.press('Delete');
  const afterDel = await p.evaluate(() => CF.PianoRoll._state.notes.length);
  await p.keyboard.press('Control+z');
  const afterUndo = await p.evaluate(() => CF.PianoRoll._state.notes.length);
  console.log('notes before/after delete/after undo:', before, afterDel, afterUndo);
  if (!(afterDel === before - 1 && afterUndo === before)) console.log('FAILED delete/undo');
  // the file carries the edit
  const midi = await p.evaluate(() => { const a = ChordFlowApp.state.arr; return a.tracks[0].notes.some((n) => n.vel === 120); });
  console.log('arrangement (=> MIDI/preview) carries edited ff note:', midi);
  if (!midi) console.log('FAILED edit not in arrangement');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  console.log('closed:', await p.isHidden('#pianoRoll'));
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
