#!/usr/bin/env node
/*
 * Keyboard scan: walks the page with Tab (reading view, editing view, and every dialog) and
 * checks each stop for (a) a visible focus mark, measured from pixels (focused vs. not focused),
 * (b) an accessible name, and (c) that it is on screen. Also checks Escape closes dialogs and
 * focus stays inside an open dialog.
 *
 *   NODE_PATH=$(npm root -g) node chordflow/tools/keyboard-scan.js http://localhost:8096
 */
'use strict';
const { chromium } = require('playwright');
const { PNG } = (() => { try { return require('pngjs'); } catch (e) { return {}; } })();
const URL = (process.argv[2] || 'http://localhost:8096') + '/index.html';

function diffPixels(a, b) {
  if (!PNG) return a.equals(b) ? 0 : 999;
  const x = PNG.sync.read(a), y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return 999;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 60) n++;
  }
  return n;
}

async function walk(p, label, max, scope) {
  const seen = new Set();
  const stops = [];
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab');
    const info = await p.evaluate((sc) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (sc && !el.closest(sc)) return { outside: true };
      const r = el.getBoundingClientRect();
      const lab = el.labels && el.labels[0] ? el.labels[0].textContent : '';
      const name = (el.getAttribute('aria-label') || lab || el.textContent || el.title || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim();
      if (!el.id) el.dataset.scanId = el.dataset.scanId || ('s' + Math.random().toString(36).slice(2, 8));
      return { key: el.id || el.dataset.scanId, tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''), name: name.slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height, onScreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
    }, scope || null);
    if (!info) continue;
    if (info.outside) { stops.push({ trapBroken: true }); break; }
    if (seen.has(info.key)) break;
    seen.add(info.key);
    let visible = null;
    if (info.onScreen) {
      const clip = { x: Math.max(0, info.x - 6), y: Math.max(0, info.y - 6), width: Math.min(info.w + 12, 1440), height: Math.min(info.h + 12, 900) };
      const on = await p.screenshot({ clip });
      await p.evaluate(() => { window.__f = document.activeElement; document.activeElement.blur(); });
      const off = await p.screenshot({ clip });
      await p.evaluate(() => window.__f && window.__f.focus());
      visible = diffPixels(on, off) > 8;
    }
    stops.push(Object.assign(info, { visible }));
  }
  const noFocus = stops.filter((s) => s.visible === false);
  const noName = stops.filter((s) => s.tag && !s.name);
  const off = stops.filter((s) => s.tag && !s.onScreen);
  return { label, stops: stops.filter((s) => s.tag).length, trapBroken: stops.some((s) => s.trapBroken), noVisibleFocus: noFocus.map((s) => s.tag + ' ' + s.name), noName: noName.map((s) => s.tag), offScreen: off.map((s) => s.tag) };
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => { try { localStorage.setItem('chordflow.guideSeen', '1'); localStorage.setItem('chordflow.mode', 'read'); } catch (e) { /* */ } });
  await p.goto(URL); await p.waitForSelector('.chord-block'); await p.waitForTimeout(300);
  const out = [];
  out.push(await walk(p, 'reading view', 120));
  await p.evaluate(() => { document.getElementById('modeBtn').click(); });
  await p.waitForTimeout(200);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  out.push(await walk(p, 'editing view', 260));
  for (const [btn, modal] of [['#exportBtn', '#exportModal'], ['#helpBtn', '#helpModal'], ['#midiBtn', '#midiModal'], [null, '#creditsModal'], [null, '#projectsModal']]) {
    if (btn) await p.click(btn);
    else await p.evaluate((m) => { document.getElementById('moreBtn').click(); document.getElementById(m === '#creditsModal' ? 'creditsBtn' : 'projectsBtn').click(); }, modal);
    await p.waitForTimeout(250);
    const r = await walk(p, 'dialog ' + modal, 120, modal);
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
    r.escapeCloses = await p.isHidden(modal);
    out.push(r);
  }
  out.forEach((r) => console.log(JSON.stringify(r)));
  console.log('page errors:', errs.length ? errs : 'none');
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
