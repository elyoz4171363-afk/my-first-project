/*
 * ChordFlow - mixer: a floating window with a channel strip per track (level meter, volume fader
 * with dB, pan, mute/solo, piano roll) and a master strip (whole-project volume, master meter).
 * Faders move the sound live while dragging; letting go writes one undo step.
 * The same values go to the MIDI file (CC7 = track volume x master, CC10 = pan).
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  let app = null;
  let el = null;
  let raf = 0;
  const peaks = {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const db = (g) => (g <= 0.0001 ? '-∞' : (20 * Math.log10(g)).toFixed(1));
  const panLabel = (v) => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));

  function build() {
    el = document.createElement('div');
    el.className = 'fwin mx';
    el.id = 'mixer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'mxTitle');
    el.hidden = true;
    el.innerHTML = `
      <div class="fwin-head" id="mxHead">
        <h2 id="mxTitle">מיקסר</h2>
        <span class="fwin-hint">גרירה משנה מיד · לחיצה כפולה מאפסת · קליק ימני על ערוץ לאפשרויות</span>
        <span class="pr-spacer"></span>
        <button class="icon-btn" id="mxClose" type="button" aria-label="סגירת המיקסר"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="mx-body" dir="ltr"><div class="mx-strips" id="mxStrips"></div><div class="mx-master" id="mxMaster"></div></div>`;
    document.body.appendChild(el);
    $('mxClose').addEventListener('click', close);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dragWindow(el, $('mxHead'));

    const body = el.querySelector('.mx-body');
    let orig = null;
    body.addEventListener('input', (e) => {
      const t = e.target;
      const p = app.getProject();
      if (t.dataset.pan != null) {
        if (!orig) orig = JSON.stringify({ tracks: p.tracks.map((x) => [x.volume, x.pan]), master: p.master.volume });
        p.tracks.find((x) => x.id === t.dataset.pan).pan = +t.value / 100;
        app.player.updateMix();
        labels();
      }
    });
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (!orig) return;
      const p = app.getProject();
      const now = { tracks: p.tracks.map((x) => [x.volume, x.pan]), master: p.master.volume };
      const o = JSON.parse(orig);
      orig = null;
      // put the old values back and commit the new ones as one undo step
      p.tracks.forEach((x, i) => { [x.volume, x.pan] = o.tracks[i]; });
      p.master.volume = o.master;
      app.commit((q) => { q.tracks.forEach((x, i) => { [x.volume, x.pan] = now.tracks[i]; }); q.master.volume = now.master; });
      t.focus();
    });
    bindFaders(body);
    body.addEventListener('dblclick', (e) => {
      const t = e.target.closest('.mx-fader') || e.target;
      if (t.dataset.fader != null) app.commit((q) => { q.tracks.find((x) => x.id === t.dataset.fader).volume = 0.8; });
      else if (t.dataset.pan != null) app.commit((q) => { q.tracks.find((x) => x.id === t.dataset.pan).pan = 0; });
      else if (t.id === 'mxMasterFader') app.commit((q) => { q.master.volume = 1; });
    });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === 'mute') app.commit((q) => { const x = q.tracks.find((y) => y.id === id); x.mute = !x.mute; });
      if (b.dataset.act === 'solo') app.commit((q) => { const x = q.tracks.find((y) => y.id === id); x.solo = !x.solo; });
      if (b.dataset.act === 'roll') app.openPianoRoll(id);
    });
    body.addEventListener('contextmenu', (e) => { const s = e.target.closest('.mx-strip[data-id]'); if (s) app.trackMenu(e, s.dataset.id); });
    if (root.ResizeObserver) new ResizeObserver(() => {}).observe(el);
  }

  function dragWindow(win, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = win.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = (ev) => { win.style.left = Math.max(0, Math.min(innerWidth - 120, ev.clientX - ox)) + 'px'; win.style.top = Math.max(0, Math.min(innerHeight - 60, ev.clientY - oy)) + 'px'; win.style.right = 'auto'; win.style.bottom = 'auto'; };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    });
  }

  // ---- fader: a drawn control (track, cap, dB marks) with role="slider"
  const MARKS = [[1, '0'], [0.5, '-6'], [0.25, '-12'], [0.063, '-24']];
  function faderHtml(attr, label, value, max) {
    const marks = MARKS.filter((m) => m[0] <= max).map((m) => `<span style="bottom:${(m[0] / max) * 100}%">${m[1]}</span>`).join('');
    return `<div class="mx-fader" ${attr} role="slider" tabindex="0" aria-label="${label}" aria-valuemin="0" aria-valuemax="${Math.round(max * 100)}" aria-valuenow="${Math.round(value * 100)}" aria-valuetext="${db(value)} dB" data-max="${max}" title="גרירה, חצים או גלגלת · לחיצה כפולה: ברירת מחדל">
      <div class="mx-scale" aria-hidden="true">${marks}</div><div class="mx-track"><i style="height:${(value / max) * 100}%"></i></div><div class="mx-rail"><div class="mx-cap" style="bottom:${(value / max) * 100}%"></div></div></div>`;
  }
  function faderValue(f) { return +f.getAttribute('aria-valuenow') / 100; }
  function paintFader(f, v) {
    const max = +f.dataset.max;
    f.setAttribute('aria-valuenow', Math.round(v * 100));
    f.setAttribute('aria-valuetext', db(v) + ' dB');
    f.querySelector('.mx-cap').style.bottom = (v / max) * 100 + '%';
    f.querySelector('.mx-track i').style.height = (v / max) * 100 + '%';
  }
  /** Moves the sound now (no undo step yet). */
  function liveSet(f, v) {
    const p = app.getProject();
    v = Math.max(0, Math.min(+f.dataset.max, Math.round(v * 100) / 100));
    if (!snapshot) snapshot = JSON.stringify({ tracks: p.tracks.map((x) => [x.volume, x.pan]), master: p.master.volume });
    if (f.id === 'mxMasterFader') p.master.volume = v; else p.tracks.find((x) => x.id === f.dataset.fader).volume = v;
    paintFader(f, v);
    app.player.updateMix();
    labels();
  }
  let snapshot = null;
  /** Writes the moved values as one undo step. */
  function commitNow() {
    if (!snapshot) return;
    const p = app.getProject();
    const now = { tracks: p.tracks.map((x) => [x.volume, x.pan]), master: p.master.volume };
    const o = JSON.parse(snapshot);
    snapshot = null;
    p.tracks.forEach((x, i) => { [x.volume, x.pan] = o.tracks[i]; });
    p.master.volume = o.master;
    app.commit((q) => { q.tracks.forEach((x, i) => { [x.volume, x.pan] = now.tracks[i]; }); q.master.volume = now.master; });
  }
  let keyTimer = 0;
  function bindFaders(body) {
    body.addEventListener('pointerdown', (e) => {
      const f = e.target.closest('.mx-fader');
      if (!f || e.button !== 0) return;
      e.preventDefault();
      f.focus();
      const tr = f.querySelector('.mx-track').getBoundingClientRect();
      const max = +f.dataset.max;
      const onCap = e.target.closest('.mx-cap');
      const start = faderValue(f), y0 = e.clientY;
      const at = (y) => (onCap ? start + ((y0 - y) / tr.height) * max : ((tr.bottom - y) / tr.height) * max);
      liveSet(f, at(e.clientY));
      const mv = (ev) => liveSet(f, at(ev.clientY) * (ev.shiftKey ? 1 : 1));
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); commitNow(); };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    });
    body.addEventListener('keydown', (e) => {
      const f = e.target.closest && e.target.closest('.mx-fader');
      if (!f) return;
      const v = faderValue(f), max = +f.dataset.max;
      const step = { ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01, PageUp: 0.1, PageDown: -0.1 }[e.key];
      let nv = null;
      if (step != null) nv = v + step; else if (e.key === 'Home') nv = 0; else if (e.key === 'End') nv = max;
      if (nv == null) return;
      e.preventDefault();
      liveSet(f, nv);
      clearTimeout(keyTimer);
      keyTimer = setTimeout(commitNow, 450);
    });
    body.addEventListener('wheel', (e) => {
      const f = e.target.closest('.mx-fader');
      if (!f) return;
      e.preventDefault();
      liveSet(f, faderValue(f) + (e.deltaY < 0 ? 0.02 : -0.02));
      clearTimeout(keyTimer);
      keyTimer = setTimeout(commitNow, 450);
    }, { passive: false });
  }

  function render() {
    const p = app.getProject();
    const anySolo = p.tracks.some((t) => t.solo);
    $('mxStrips').innerHTML = p.tracks.map((t) => {
      const silent = t.mute || (anySolo && !t.solo);
      return `<div class="mx-strip${silent ? ' silent' : ''}" data-id="${t.id}" style="--fc:${app.famCss(t)}">
        <div class="mx-name" dir="rtl" title="${esc(t.name)}">${esc(t.name)}</div>
        <div class="mx-ch" dir="rtl">ערוץ ${t.channel + 1}${t.edit ? ' · ערוך' : ''}</div>
        <label class="mx-pan"><span class="sr-only">פאן ${esc(t.name)}</span><input type="range" dir="ltr" min="-100" max="100" step="1" value="${Math.round((t.pan || 0) * 100)}" data-pan="${t.id}" title="פאן (לחיצה כפולה: מרכז)"></label>
        <div class="mx-small mx-panlr" aria-hidden="true"><span>L</span><b data-pan-out="${t.id}">${panLabel(t.pan || 0)}</b><span>R</span></div>
        <div class="mx-fader-row">
          <div class="mx-meter" aria-hidden="true"><i data-meter="${t.id}"></i></div>
          ${faderHtml('data-fader="' + t.id + '"', 'עוצמה ' + esc(t.name), t.volume, 1)}
        </div>
        <div class="mx-db" data-db="${t.id}">${db(t.volume)} dB</div>
        <div class="mx-ms">
          <button type="button" data-act="mute" data-id="${t.id}" aria-pressed="${!!t.mute}" title="השתקה">M</button>
          <button type="button" data-act="solo" data-id="${t.id}" aria-pressed="${!!t.solo}" title="סולו">S</button>
        </div>
        <button type="button" class="mx-roll" data-act="roll" data-id="${t.id}" title="פיאנו רול">תווים</button>
      </div>`;
    }).join('');
    const mv = p.master ? p.master.volume : 1;
    $('mxMaster').innerHTML = `<div class="mx-strip master">
        <div class="mx-name" dir="rtl">מאסטר</div>
        <div class="mx-ch" dir="rtl">כל הפרויקט</div>
        <div class="mx-small">&nbsp;</div><div class="mx-small">&nbsp;</div>
        <div class="mx-fader-row">
          <div class="mx-meter" aria-hidden="true"><i data-meter="master"></i></div>
          ${faderHtml('id="mxMasterFader"', 'עוצמה כללית', mv, 1.5)}
        </div>
        <div class="mx-db" id="mxMasterDb">${Math.round(mv * 100)}% · ${db(mv)} dB</div>
        <div class="mx-small" dir="rtl">נכנס גם ל-WAV ול-CC7</div>
      </div>`;
  }

  function labels() {
    const p = app.getProject();
    p.tracks.forEach((t) => {
      const d = el.querySelector(`[data-db="${t.id}"]`); if (d) d.textContent = db(t.volume) + ' dB';
      const q = el.querySelector(`[data-pan-out="${t.id}"]`); if (q) q.textContent = panLabel(t.pan || 0);
    });
    $('mxMasterDb').textContent = `${Math.round(p.master.volume * 100)}% · ${db(p.master.volume)} dB`;
  }

  function meters() {
    if (el.hidden) return;
    const p = app.getProject();
    const ids = p.tracks.map((t) => t.id).concat(['master']);
    ids.forEach((id) => {
      const lv = app.player.playing ? app.player.level(id === 'master' ? null : id) : -Infinity;
      const pct = Math.max(0, Math.min(100, ((lv + 60) / 60) * 100));
      peaks[id] = Math.max(pct, (peaks[id] || 0) - 1.5);
      const bar = el.querySelector(`[data-meter="${id}"]`);
      if (bar) { bar.style.height = peaks[id] + '%'; bar.classList.toggle('hot', lv > -1); }
    });
    raf = requestAnimationFrame(meters);
  }

  function open() {
    if (!el) build();
    el.hidden = false;
    render();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(meters);
    const f = el.querySelector('.mx-fader');
    if (f) f.focus();
  }
  function close() { if (el) { el.hidden = true; cancelAnimationFrame(raf); } }
  function sync() {
    if (!el || el.hidden) return;
    if (el.contains(document.activeElement) && document.activeElement.type === 'range') { labels(); return; }
    render();
  }

  CF.Mixer = {
    init(api) { app = api; },
    open, close, sync,
    toggle() { if (el && !el.hidden) close(); else open(); },
    get isOpen() { return !!el && !el.hidden; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
