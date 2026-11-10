#!/usr/bin/env node
/*
 * Counts the controls a person sees on the first screen (buttons, fields, sliders, links),
 * and the smallest text size, at a few window sizes.
 *   NODE_PATH=$(npm root -g) node chordflow/tools/count-controls.js http://localhost:8096
 */
'use strict';
const { chromium } = require('playwright');
const URL = (process.argv[2] || 'http://localhost:8096') + '/index.html';
(async () => {
  const b = await chromium.launch();
  const out = {};
  for (const [w, h] of [[1440, 900], [1366, 768], [390, 844], [360, 740]]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.addInitScript(() => { try { localStorage.setItem('chordflow.guideSeen', '1'); } catch (e) { /* */ } });
    await p.goto(URL); await p.waitForSelector('.chord-block, .mobile-view', { state: 'attached' }); await p.waitForTimeout(300);
    out[w + 'x' + h] = await p.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && cs.visibility !== 'hidden' && !el.closest('[hidden],.modal') && el.offsetParent !== null; };
      const ctl = [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [tabindex="0"]')].filter(vis);
      let minFont = 99;
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) { const el = walk.currentNode.parentElement; if (!walk.currentNode.textContent.trim() || !vis(el)) continue; minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize)); }
      return { controls: ctl.length, minFontPx: minFont, scrollWidth: document.documentElement.scrollWidth };
    });
    await p.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})();
