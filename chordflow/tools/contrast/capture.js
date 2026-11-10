const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch();
  for (const skin of ['graphite', 'ivory']) {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.addInitScript((sk) => { localStorage.setItem('chordflow.guideSeen', '1'); localStorage.setItem('chordflow.skin', sk); }, skin);
    await p.goto('' + (process.env.CHORDFLOW_URL || 'http://localhost:8095') + '/index.html'); await p.waitForSelector('.chord-block'); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(600);
    await p.screenshot({ path: `${process.argv[2]}/${skin}-text.png` });
    // text boxes: leaf elements with own text
    const boxes = await p.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const n = walk.currentNode; if (!n.textContent.trim()) continue;
        const el = n.parentElement; const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[hidden],.modal,script,style,.sr-only,.ctx-menu,.toast')) continue;
        const r = document.createRange(); r.selectNodeContents(n); const rc = r.getBoundingClientRect();
        if (rc.width < 3 || rc.height < 6 || rc.bottom < 0 || rc.top > innerHeight || rc.right < 0 || rc.left > innerWidth) continue;
        out.push({ x: Math.max(0, Math.floor(rc.left)), y: Math.max(0, Math.floor(rc.top)), w: Math.ceil(rc.width), h: Math.ceil(rc.height), t: n.textContent.trim().slice(0, 24), fs: parseFloat(cs.fontSize), sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') });
      }
      // svg text too
      document.querySelectorAll('svg text').forEach((el) => { const rc = el.getBoundingClientRect(); if (rc.width > 3) out.push({ x: Math.floor(rc.left), y: Math.floor(rc.top), w: Math.ceil(rc.width), h: Math.ceil(rc.height), t: el.textContent.slice(0, 24), fs: parseFloat(getComputedStyle(el).fontSize), sel: 'svg-text' }); });
      // input values and placeholders
      return out;
    });
    const lines = await p.evaluate(() => [...document.querySelectorAll('.panel, .console-inner, .btn, .icon-btn, input:not([type=range]), select, textarea, .chord-block, .play-btn, .seg, .brand-logo')].filter((el) => { const cs = getComputedStyle(el); return el.offsetParent && parseFloat(cs.borderTopWidth) >= 1 && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs.borderTopColor); }).map((el) => { const r = el.getBoundingClientRect(); const px = Math.round(r.left + Math.min(r.width / 2, 40)); const hit = document.elementFromPoint(px, r.top + 4); if (!hit || !(hit === el || el.contains(hit))) return { y: -1 }; return { x: px, y: Math.floor(r.top), bw: Math.round(parseFloat(getComputedStyle(el).borderTopWidth)), sel: el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] }; }).filter((l) => l.y > 3 && l.y < innerHeight - 6 && l.x < innerWidth));
    await p.addStyleTag({ content: '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } svg text { fill: transparent !important; } ::placeholder { color: transparent !important; }' });
    await p.waitForTimeout(200);
    await p.screenshot({ path: `${process.argv[2]}/${skin}-notext.png` });
    fs.writeFileSync(`${process.argv[2]}/${skin}-boxes.json`, JSON.stringify({ boxes, lines }));
    await p.close();
  }
  await b.close();
})();
