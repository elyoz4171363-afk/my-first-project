#!/usr/bin/env node
/*
 * Pixel contrast, step 1: for each skin and each view (main screen in reading and editing mode,
 * and every dialog) takes two screenshots, with text and with all text made transparent, and
 * saves the text boxes and border probes. Step 2: python3 analyze.py <out dir>.
 *
 *   CHORDFLOW_URL=http://localhost:8096 NODE_PATH=$(npm root -g) node capture.js <out dir>
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
const BASE = process.env.CHORDFLOW_URL || 'http://localhost:8096';

const VIEWS = [
  { id: 'read', mode: 'read' },
  { id: 'edit', mode: 'edit' },
  { id: 'export', mode: 'edit', open: (p) => p.click('#exportBtn'), scope: '#exportModal' },
  { id: 'export-ks', mode: 'edit', open: async (p) => { await p.click('#exportBtn'); await p.click('#ksBox summary'); }, scope: '#exportModal' },
  { id: 'export-audio', mode: 'edit', open: async (p) => { await p.click('#exportBtn'); await p.click('[data-exp="audio"]'); }, scope: '#exportModal' },
  { id: 'export-sheet', mode: 'edit', open: async (p) => { await p.click('#exportBtn'); await p.click('[data-exp="sheet"]'); }, scope: '#exportModal' },
  { id: 'help', mode: 'edit', open: (p) => p.click('#helpBtn'), scope: '#helpModal' },
  { id: 'midi', mode: 'edit', open: (p) => p.click('#midiBtn'), scope: '#midiModal' },
  { id: 'credits', mode: 'edit', open: async (p) => { await p.click('#moreBtn'); await p.click('#creditsBtn'); await p.click('.license-text summary'); }, scope: '#creditsModal' },
  { id: 'projects', mode: 'edit', open: async (p) => { await p.click('#moreBtn'); await p.click('#projectsBtn'); }, scope: '#projectsModal' },
];

(async () => {
  const b = await chromium.launch();
  for (const skin of ['graphite', 'ivory']) {
    for (const v of VIEWS) {
      const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
      await p.addInitScript((a) => { localStorage.setItem('chordflow.guideSeen', '1'); localStorage.setItem('chordflow.skin', a.skin); localStorage.setItem('chordflow.mode', a.mode); }, { skin, mode: v.mode });
      await p.goto(BASE + '/index.html'); await p.waitForSelector('.chord-block'); await p.evaluate(() => document.fonts.ready);
      if (v.open) await v.open(p);
      await p.waitForTimeout(500);
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      const name = `${skin}-${v.id}`;
      await p.screenshot({ path: `${OUT}/${name}-text.png` });
      const data = await p.evaluate((scope) => {
        const inScope = (el) => (scope ? !!el.closest(scope) : !el.closest('.modal'));
        const vis = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden],script,style,.sr-only,.ctx-menu,.toast,details:not([open]) > :not(summary)') && inScope(el); };
        const boxes = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) {
          const n = walk.currentNode; if (!n.textContent.trim()) continue;
          const el = n.parentElement; if (!vis(el)) continue;
          const r = document.createRange(); r.selectNodeContents(n); const rc = r.getBoundingClientRect();
          if (rc.width < 3 || rc.height < 6 || rc.bottom < 0 || rc.top > innerHeight || rc.right < 0 || rc.left > innerWidth) continue;
          // skip text hidden under a scroll container's edge
          const hit = document.elementFromPoint(Math.min(innerWidth - 1, rc.left + Math.min(rc.width / 2, 8)), rc.top + rc.height / 2);
          if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
          boxes.push({ x: Math.max(0, Math.floor(rc.left)), y: Math.max(0, Math.floor(rc.top)), w: Math.ceil(rc.width), h: Math.ceil(rc.height), t: n.textContent.trim().slice(0, 24), fs: parseFloat(getComputedStyle(el).fontSize), sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') });
        }
        document.querySelectorAll('svg text').forEach((el) => { if (!inScope(el)) return; const rc = el.getBoundingClientRect(); if (rc.width > 3) boxes.push({ x: Math.floor(rc.left), y: Math.floor(rc.top), w: Math.ceil(rc.width), h: Math.ceil(rc.height), t: el.textContent.slice(0, 24), fs: parseFloat(getComputedStyle(el).fontSize), sel: 'svg-text' }); });
        const lines = [...document.querySelectorAll('.panel, .console-inner, .modal-card, .btn, .icon-btn, input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea, .chord-block, .play-btn, .seg, .brand-logo, .midi-state, .mv-card')]
          .filter((el) => { const cs = getComputedStyle(el); return el.offsetParent && !el.disabled && inScope(el) && parseFloat(cs.borderTopWidth) >= 1 && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs.borderTopColor); })
          .map((el) => { const r = el.getBoundingClientRect(); const px = Math.round(r.left + Math.min(r.width / 2, 40)); const hit = document.elementFromPoint(px, r.top + 4); if (!hit || !(hit === el || el.contains(hit))) return { y: -1 }; return { x: px, y: Math.floor(r.top), bw: Math.round(parseFloat(getComputedStyle(el).borderTopWidth)), sel: el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] }; })
          .filter((l) => l.y > 3 && l.y < innerHeight - 6 && l.x < innerWidth);
        return { boxes, lines };
      }, v.scope || null);
      await p.addStyleTag({ content: '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } svg text { fill: transparent !important; } ::placeholder { color: transparent !important; } ::-webkit-details-marker { color: transparent !important; }' });
      await p.waitForTimeout(150);
      await p.screenshot({ path: `${OUT}/${name}-notext.png` });
      fs.writeFileSync(`${OUT}/${name}-boxes.json`, JSON.stringify(data));
      await p.close();
    }
  }
  await b.close();
})();
