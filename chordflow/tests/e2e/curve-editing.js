const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(process.argv[2]); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('.chord-block');
  console.log('guide shown:', await p.isVisible('.guide'), '| page scroll with guide:', await p.evaluate(() => document.documentElement.scrollHeight - innerHeight));
  await p.click('#guideOk');
  const n = () => p.evaluate(() => ChordFlowApp.state.project.dynamics.points.length);
  const pt = async (i) => { const c = p.locator('.dyn-pt').nth(i); const bb = await c.boundingBox(); return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }; };
  console.log('start points', await n());
  // click 8px away from point 1 -> should grab, not add
  const p1 = await pt(1);
  await p.mouse.click(p1.x + 8, p1.y + 5);
  console.log('click near point -> points', await n(), '(should stay 3), label shown:', await p.isVisible('.dyn-label'));
  // repeated clicks at same spot on empty area: adds once, then grabs
  const lane = await p.locator('#laneDyn').boundingBox();
  for (let i = 0; i < 4; i++) await p.mouse.click(lane.x + 90, lane.y + 30);
  console.log('4 clicks same empty spot -> points', await n(), '(should be 4)');
  // Delete key on selected
  await p.keyboard.press('Delete');
  console.log('Delete -> points', await n());
  // right-click on a point
  const p2 = await pt(1); await p.mouse.click(p2.x, p2.y, { button: 'right' });
  console.log('right-click -> points', await n());
  // drag point 0 and check readout
  const p0 = await pt(0); await p.mouse.move(p0.x, p0.y); await p.mouse.down(); await p.mouse.move(p0.x + 3, p0.y - 25, { steps: 4 });
  console.log('readout while dragging:', await p.textContent('.dyn-label text'));
  await p.mouse.up();
  // long press (touch-like) on a point
  const before = await n(); const p3 = await pt(0); await p.mouse.move(p3.x, p3.y); await p.mouse.down(); await p.waitForTimeout(800); await p.mouse.up();
  console.log('long-press -> points', before, '->', await n());
  await p.click('#curveReset'); console.log('reset -> points', await n(), 'preset', await p.inputValue('#curvePreset'));
  await p.click('#undoBtn'); console.log('undo reset -> points', await n());
  console.log('errors', errors.length ? errors : 'none');
  await b.close();
})();
