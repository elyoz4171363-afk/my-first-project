/*
 * ChordFlow - piano roll: a floating window that edits every note and controller of one track.
 *
 * Opening the roll does not change anything. The first edit "freezes" the track: its notes and
 * the edited controller lanes are stored in track.edit, and from then on the arranger plays them
 * exactly (preview, live MIDI, MIDI file and WAV). "חזרה לעיבוד האוטומטי" clears track.edit.
 * Every edit goes through the app's commit(), so Ctrl+Z / Ctrl+Shift+Z work as everywhere else.
 *
 * Mouse: click selects, drag moves (Alt+drag copies), edges change length, empty drag = rubber band,
 * double-click adds / deletes, right-click opens the editing menu (on a note, on empty space, on the
 * controller lane). Keys: arrows move/transpose, Delete, Ctrl+A/C/X/V/D, Q quantise, V/P/E tools.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const EPS = 1e-6;
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK = [1, 3, 6, 8, 10];
  const noteName = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 2); // Cubase naming, C3 = 60
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const LANES = [
    { id: 'vel', name: 'Velocity' },
    { id: 1, name: 'CC1 Modulation (דינמיקה)' },
    { id: 11, name: 'CC11 Expression' },
    { id: 64, name: 'CC64 פדל' },
    { id: 2, name: 'CC2 Breath' },
  ];
  const SNAPS = [
    { v: 'bar', name: 'תיבה' }, { v: 1, name: '1/4' }, { v: 0.5, name: '1/8' }, { v: 0.25, name: '1/16' },
    { v: 0.125, name: '1/32' }, { v: 1 / 3, name: '1/8 שלישייה' }, { v: 1 / 6, name: '1/16 שלישייה' }, { v: 0, name: 'ללא' },
  ];
  const VEL_PRESETS = [['pp', 32], ['p', 48], ['mp', 64], ['mf', 80], ['f', 100], ['ff', 120]];
  const LENGTHS = [['1/32', 0.125], ['1/16', 0.25], ['1/8', 0.5], ['1/4', 1], ['1/2', 2], ['שלם', 4]];

  let app = null;
  let el = null;
  const st = {
    open: false, trackId: null, notes: [], ccEdit: {}, edited: false, sel: new Set(),
    tool: 'select', snap: 0.25, ppq: 72, rh: 14, lane: 'vel', ghosts: false, follow: true,
    lastLen: null, lastVel: 90, clip: null, cursorT: 0, hover: null, drag: null, raf: 0,
  };

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const project = () => app.getProject();
  const track = () => project().tracks.find((t) => t.id === st.trackId) || null;
  const barLen = () => CF.Theory.barLength(project().timeSig);
  const snapLen = () => (st.snap === 'bar' ? barLen() : st.snap);
  const snapT = (t) => { const s = snapLen(); return s ? Math.round(t / s + EPS) * s : t; };
  const floorT = (t) => { const s = snapLen(); return s ? Math.floor(t / s + EPS) * s : t; };
  const minLen = () => Math.max(1 / 64, snapLen() || 1 / 32);
  const songEnd = () => Math.max(CF.Arranger.songEndOf(project()), ...st.notes.map((n) => n.t + n.dur), 4);
  const color = (v, f) => app.cssVar(v, f);
  const keyOf = (n) => n.t.toFixed(4) + '|' + n.pitch;

  function famColor() {
    const t = track();
    const fam = t && CF.Families.get(t.family);
    return fam ? color('--f-' + fam.id, fam.color) : color('--gold', '#e8a548');
  }

  /** Notes as the automatic arrangement makes them, without overlap/humanising (clean grid). */
  function autoSource() {
    const p = project();
    const clean = Object.assign({}, p, { perform: Object.assign({}, p.perform, { legatoMs: 0, humanize: 0 }) });
    const at = CF.Arranger.arrange(clean).tracks.find((a) => a.id === st.trackId);
    return at || { notes: [], cc: [] };
  }

  function autoCC(k) {
    const at = (app.getArr().tracks || []).find((a) => a.id === st.trackId);
    return at ? at.cc.filter((c) => c.cc === k).map((c) => ({ t: c.t, v: c.v })) : [];
  }
  const ccPoints = (k) => st.ccEdit[k] || autoCC(k);

  /** Reload from the project (after open, undo/redo, or any outside change). */
  function load(keepSel) {
    const t = track();
    if (!t) { close(); return; }
    const keys = keepSel ? new Set([...st.sel].map(keyOf)) : null;
    if (t.edit) {
      st.notes = clone(t.edit.notes);
      st.ccEdit = clone(t.edit.cc || {});
      st.edited = true;
    } else {
      st.notes = autoSource().notes.map((n) => { const o = { t: +n.t.toFixed(6), dur: +n.dur.toFixed(6), pitch: n.pitch, vel: n.vel }; if (n.art) o.art = n.art; return o; });
      st.ccEdit = {};
      st.edited = false;
    }
    st.sel = new Set(keys ? st.notes.filter((n) => keys.has(keyOf(n))) : []);
  }

  /** Writes the working notes/controllers into the project (one undo step). */
  function save(label) {
    st.notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
    const notes = st.notes.map((n) => { const o = { t: +n.t.toFixed(6), dur: +Math.max(1 / 64, n.dur).toFixed(6), pitch: clamp(Math.round(n.pitch), 0, 127), vel: clamp(Math.round(n.vel), 1, 127) }; if (n.art) o.art = n.art; return o; });
    const cc = clone(st.ccEdit);
    st.saving = true;
    app.commit((p) => { const t = p.tracks.find((x) => x.id === st.trackId); if (t) t.edit = { notes, cc }; });
    st.saving = false;
    st.edited = true;
    if (label) status(label);
    draw();
  }

  function audition(pitch, vel) {
    try {
      const pl = app.player;
      const ac = pl.ensure();
      const t = track();
      if (!t) return;
      if (CF.Sampler.state(t.instrument) !== 'ready') CF.Sampler.load(ac, t.instrument);
      if (!CF.Sampler.play(ac, pl.liveBus(), t.instrument, pitch, (vel || 90) / 127, ac.currentTime, 0.35, t.family)) {
        const v = CF.AudioVoices[(CF.Instruments.get(t.instrument) || {}).voice] || CF.AudioVoices.grand;
        v(ac, pl.liveBus(), pitch, (vel || 90) / 127, ac.currentTime, 0.3);
      }
    } catch (e) { /* no audio */ }
  }

  // ------------------------------------------------------------------ geometry
  function view() {
    const sc = $('prScroll');
    return { sl: sc.scrollLeft, stp: sc.scrollTop, w: sc.clientWidth, h: sc.clientHeight };
  }
  const xOf = (t) => t * st.ppq;
  const yOf = (p) => (127 - p) * st.rh;
  function pointer(e) {
    const sc = $('prScroll');
    const r = sc.getBoundingClientRect();
    const x = e.clientX - r.left + sc.scrollLeft, y = e.clientY - r.top + sc.scrollTop;
    return { x, y, t: Math.max(0, x / st.ppq), pitch: clamp(127 - Math.floor(y / st.rh), 0, 127) };
  }
  function hit(pt) {
    for (let i = st.notes.length - 1; i >= 0; i--) {
      const n = st.notes[i];
      const x0 = xOf(n.t), x1 = xOf(n.t + n.dur);
      if (n.pitch === pt.pitch && pt.x >= x0 - 1 && pt.x <= x1 + 1) {
        const w = x1 - x0;
        const part = pt.x > x1 - Math.min(7, w / 3) ? 'end' : pt.x < x0 + Math.min(5, w / 4) && w > 14 ? 'start' : 'body';
        return { n, part };
      }
    }
    return null;
  }
  function sizeCanvas(c, w, h) {
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // ------------------------------------------------------------------ drawing
  function draw() {
    if (!st.open) return;
    const v = view();
    const end = songEnd() + barLen() * 4;
    const sp = $('prSpacer');
    sp.style.width = Math.ceil(xOf(end)) + 'px';
    sp.style.height = Math.ceil(128 * st.rh) + 'px';
    drawGrid(v, end);
    drawKeys(v);
    drawRuler(v);
    drawLane(v);
    renderInfo();
  }

  function drawGrid(v) {
    const c = $('prGrid');
    const ctx = sizeCanvas(c, v.w, v.h);
    const bg = color('--ink-1', '#171310'), alt = color('--ink-2', '#201c16');
    const line = color('--rule-soft', '#6b5c48'), bar = color('--rule', '#756957');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, v.w, v.h);
    // rows (black keys darker)
    const p0 = clamp(127 - Math.floor((v.stp + v.h) / st.rh), 0, 127), p1 = clamp(127 - Math.floor(v.stp / st.rh), 0, 127);
    for (let p = p0; p <= p1; p++) {
      const y = yOf(p) - v.stp;
      if (BLACK.includes(p % 12)) { ctx.fillStyle = alt; ctx.fillRect(0, y, v.w, st.rh); }
      if (p % 12 === 0) { ctx.fillStyle = line; ctx.fillRect(0, y + st.rh - 1, v.w, 1); }
    }
    // chord spans (light bands) so you see the harmony under the notes
    const P = project();
    // time grid
    const bl = barLen();
    const s = snapLen() && snapLen() * st.ppq >= 6 ? snapLen() : bl / project().timeSig.num;
    const t0 = Math.floor(v.sl / st.ppq / s) * s, t1 = (v.sl + v.w) / st.ppq;
    for (let t = t0; t <= t1 + EPS; t += s) {
      const x = Math.round(xOf(t) - v.sl) + 0.5;
      const isBar = Math.abs(t / bl - Math.round(t / bl)) < 1e-4;
      ctx.globalAlpha = isBar ? 1 : 0.45;
      ctx.fillStyle = isBar ? bar : line;
      ctx.fillRect(x, 0, 1, v.h);
    }
    ctx.globalAlpha = 1;
    // ghost notes of the other tracks
    if (st.ghosts) {
      (app.getArr().tracks || []).forEach((at) => {
        if (at.id === st.trackId) return;
        ctx.fillStyle = color('--text', '#efe7d8');
        ctx.globalAlpha = 0.12;
        at.notes.forEach((n) => {
          const x = xOf(n.t) - v.sl, w = Math.max(2, n.dur * st.ppq), y = yOf(n.pitch) - v.stp;
          if (x + w < 0 || x > v.w || y + st.rh < 0 || y > v.h) return;
          ctx.fillRect(x, y + 2, w, st.rh - 4);
        });
      });
      ctx.globalAlpha = 1;
    }
    // notes
    const fc = famColor(), gold = color('--gold', '#e8a548'), ink = color('--ink-1', '#171310');
    ctx.font = '600 10px Heebo, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    st.notes.forEach((n) => {
      const x = xOf(n.t) - v.sl, w = Math.max(3, n.dur * st.ppq - 1), y = yOf(n.pitch) - v.stp;
      if (x + w < 0 || x > v.w || y + st.rh < 0 || y > v.h) return;
      const sel = st.sel.has(n);
      ctx.globalAlpha = 0.45 + 0.55 * (n.vel / 127);
      ctx.fillStyle = sel ? gold : fc;
      roundRect(ctx, x, y + 1, w, st.rh - 2, 3); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = sel ? color('--text', '#efe7d8') : ink;
      ctx.lineWidth = sel ? 1.5 : 1;
      roundRect(ctx, x + 0.5, y + 1.5, w - 1, st.rh - 3, 3); ctx.stroke();
      if (w > 34 && st.rh >= 12) {
        ctx.fillStyle = ink;
        ctx.fillText(noteName(n.pitch) + (n.art ? ' · ' + n.art.slice(0, 4) : ''), x + 4, y + st.rh / 2);
      }
    });
    // rubber band
    const d = st.drag;
    if (d && d.kind === 'band') {
      ctx.strokeStyle = gold; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(d.x0, d.x1) - v.sl + 0.5, Math.min(d.y0, d.y1) - v.stp + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    }
    // playhead
    const px = xOf(app.getPosition()) - v.sl;
    if (px >= 0 && px <= v.w) { ctx.fillStyle = gold; ctx.fillRect(Math.round(px), 0, 2, v.h); }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawKeys(v) {
    const c = $('prKeys');
    const w = c.parentElement.clientWidth;
    const ctx = sizeCanvas(c, w, v.h);
    ctx.fillStyle = color('--ink-2', '#201c16'); ctx.fillRect(0, 0, w, v.h);
    ctx.font = '400 10px Heebo, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const p0 = clamp(127 - Math.floor((v.stp + v.h) / st.rh), 0, 127), p1 = clamp(127 - Math.floor(v.stp / st.rh), 0, 127);
    const used = new Set(st.notes.map((n) => n.pitch));
    for (let p = p0; p <= p1; p++) {
      const y = yOf(p) - v.stp;
      const black = BLACK.includes(p % 12);
      ctx.fillStyle = black ? color('--ink-1', '#171310') : color('--text', '#efe7d8');
      ctx.globalAlpha = black ? 1 : 0.86;
      ctx.fillRect(black ? 0 : 0, y, black ? w * 0.62 : w, st.rh - 0.5);
      ctx.globalAlpha = 1;
      if (used.has(p)) { ctx.fillStyle = color('--gold', '#e8a548'); ctx.fillRect(w - 4, y + 2, 3, st.rh - 4); }
      if (p % 12 === 0 && st.rh >= 9) { ctx.fillStyle = color('--ink-1', '#171310'); ctx.fillText(noteName(p), w * 0.66, y + st.rh / 2); }
    }
  }

  function drawRuler(v) {
    const c = $('prRuler');
    const h = c.parentElement.clientHeight;
    const ctx = sizeCanvas(c, v.w, h);
    ctx.fillStyle = color('--ink-2', '#201c16'); ctx.fillRect(0, 0, v.w, h);
    const bl = barLen();
    ctx.font = '400 12px Heebo, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const b0 = Math.floor(v.sl / st.ppq / bl), b1 = Math.ceil((v.sl + v.w) / st.ppq / bl);
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(xOf(b * bl) - v.sl) + 0.5;
      ctx.fillStyle = color('--rule', '#756957'); ctx.fillRect(x, 0, 1, h);
      ctx.fillStyle = color('--text', '#efe7d8'); ctx.fillText(String(b + 1), x + 4, 2);
    }
    // chord names under the bar numbers
    ctx.font = '600 12px Heebo, system-ui, sans-serif';
    ctx.fillStyle = color('--gold', '#e8a548');
    (project().chords || []).forEach((ch) => {
      const x = xOf(ch.start) - v.sl;
      if (x > -60 && x < v.w) ctx.fillText(ch.symbol, x + 4, 17);
    });
    const px = xOf(app.getPosition()) - v.sl;
    if (px >= 0 && px <= v.w) { ctx.fillStyle = color('--gold', '#e8a548'); ctx.beginPath(); ctx.moveTo(px - 5, h - 7); ctx.lineTo(px + 5, h - 7); ctx.lineTo(px, h); ctx.fill(); }
  }

  function laneVal(pt, h) { return clamp(Math.round((1 - (pt.ly - 4) / (h - 8)) * 127), 0, 127); }

  function drawLane(v) {
    const c = $('prLane');
    const h = c.parentElement.clientHeight;
    const ctx = sizeCanvas(c, v.w, h);
    ctx.fillStyle = color('--ink-1', '#171310'); ctx.fillRect(0, 0, v.w, h);
    ctx.fillStyle = color('--rule-soft', '#6b5c48');
    [0.25, 0.5, 0.75].forEach((f) => ctx.fillRect(0, Math.round(4 + (h - 8) * f), v.w, 1));
    const yv = (val) => 4 + (h - 8) * (1 - val / 127);
    const gold = color('--gold', '#e8a548'), fc = famColor();
    if (st.lane === 'vel') {
      st.notes.forEach((n) => {
        const x = xOf(n.t) - v.sl;
        if (x < -4 || x > v.w + 4) return;
        const sel = st.sel.has(n);
        ctx.fillStyle = sel ? gold : fc;
        ctx.fillRect(Math.round(x), yv(n.vel), 2, h - 4 - yv(n.vel));
        ctx.beginPath(); ctx.arc(x + 1, yv(n.vel), 3, 0, Math.PI * 2); ctx.fill();
      });
    } else {
      const pts = ccPoints(st.lane);
      const edited = !!st.ccEdit[st.lane];
      ctx.strokeStyle = edited ? gold : fc;
      ctx.globalAlpha = edited ? 1 : 0.6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let prevY = null;
      pts.forEach((p, i) => {
        const x = xOf(p.t) - v.sl, y = yv(p.v);
        if (i === 0) ctx.moveTo(Math.max(-2, x), y); else { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
        prevY = y;
      });
      if (pts.length) ctx.lineTo(v.w + 2, prevY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (!pts.length) { ctx.fillStyle = color('--text', '#efe7d8'); ctx.font = '400 12px Heebo, sans-serif'; ctx.fillText('אין נקודות. גררו כאן כדי לצייר', 8, h / 2); }
    }
  }

  function renderInfo() {
    const t = track();
    if (!t) return;
    $('prTitle').textContent = 'פיאנו רול · ' + t.name;
    $('prBadge').textContent = st.edited ? 'נערך ידנית' : 'אוטומטי';
    $('prBadge').className = 'pr-badge' + (st.edited ? ' on' : '');
    $('prRevert').hidden = !st.edited;
    const sel = [...st.sel];
    const hv = st.hover;
    const pos = hv ? `${Math.floor(hv.t / barLen() + EPS) + 1}.${Math.floor((hv.t % barLen()) / (barLen() / project().timeSig.num) + EPS) + 1} · ${noteName(hv.pitch)}` : '';
    $('prInfo').textContent = `${st.notes.length} תווים${sel.length ? ` · ${sel.length} נבחרו` : ''}${pos ? ' · ' + pos : ''}`;
    document.querySelectorAll('#pianoRoll [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === st.tool)));
    $('prPlay').classList.toggle('playing', !!app.player.playing);
  }

  let statusTimer = 0;
  function status(text) {
    const s = $('prStatus');
    s.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { s.textContent = 'לחיצה כפולה: תו חדש · גרירה: הזזה · קצה: אורך · Alt+גרירה: העתקה · קליק ימני: אפשרויות'; }, 2500);
  }

  // ------------------------------------------------------------------ edit operations
  const selected = () => [...st.sel];
  const targets = () => (st.sel.size ? selected() : st.notes);

  function edit(fn, label) { fn(); save(label); }

  function del(list) { const s = new Set(list || selected()); if (!s.size) return; edit(() => { st.notes = st.notes.filter((n) => !s.has(n)); st.sel.clear(); }, `נמחקו ${s.size} תווים`); }
  function transposeSel(semi) {
    const list = targets();
    if (!list.length) return;
    edit(() => list.forEach((n) => { n.pitch = clamp(n.pitch + semi, 0, 127); }), `טרנספוזיציה ${semi > 0 ? '+' : ''}${semi} ל-${list.length} תווים`);
    if (list.length <= 4) list.forEach((n) => audition(n.pitch, n.vel));
  }
  function moveSel(dt) {
    const list = selected();
    if (!list.length) return;
    const minT = Math.min(...list.map((n) => n.t));
    if (minT + dt < -EPS) dt = -minT;
    edit(() => list.forEach((n) => { n.t = Math.max(0, n.t + dt); }));
  }
  function lengthSel(d, abs) {
    const list = selected();
    if (!list.length) return;
    edit(() => list.forEach((n) => { n.dur = Math.max(minLen(), abs ? d : n.dur + d); }), abs ? 'אורך עודכן' : null);
  }
  function velSel(v, rel) {
    const list = targets();
    if (!list.length) return;
    edit(() => list.forEach((n) => { n.vel = clamp(Math.round(rel ? n.vel + v : v), 1, 127); }), `Velocity ${rel ? (v > 0 ? '+' : '') + v : v}`);
  }
  function quantize(lengths) {
    const list = targets();
    const s = snapLen();
    if (!list.length || !s) { status('בחרו הצמדה כדי לקוונטז'); return; }
    edit(() => list.forEach((n) => {
      if (lengths) n.dur = Math.max(s, Math.round(n.dur / s) * s);
      else { const e = n.t + n.dur; n.t = snapT(n.t); n.dur = Math.max(minLen(), lengths ? n.dur : n.dur); if (e - n.t < minLen()) n.dur = minLen(); }
    }), lengths ? 'אורכים יושרו להצמדה' : 'התחלות יושרו להצמדה');
  }
  function legatoToNext() {
    const list = targets();
    edit(() => list.forEach((n) => {
      const next = st.notes.filter((m) => m.t > n.t + EPS).sort((a, b) => a.t - b.t)[0];
      if (next) n.dur = Math.max(minLen(), next.t - n.t);
    }), 'כל תו נמשך עד התו הבא');
  }
  function humanize() {
    const list = targets();
    const q = project().bpm / 60000;
    edit(() => list.forEach((n) => {
      n.t = Math.max(0, n.t + (Math.random() * 2 - 1) * 12 * q);
      n.vel = clamp(Math.round(n.vel + (Math.random() * 2 - 1) * 8), 1, 127);
    }), 'הומניזציה: עד 12ms ו-8 Velocity');
  }
  function ramp(up) {
    const list = targets().slice().sort((a, b) => a.t - b.t);
    if (list.length < 2) { status('בחרו לפחות שני תווים'); return; }
    const a = Math.min(...list.map((n) => n.vel)), b = Math.max(...list.map((n) => n.vel));
    const lo = Math.min(a, 40), hi = Math.max(b, 110);
    const t0 = list[0].t, t1 = list[list.length - 1].t || 1;
    edit(() => list.forEach((n) => { const f = (n.t - t0) / Math.max(EPS, t1 - t0); n.vel = Math.round(up ? lo + (hi - lo) * f : hi - (hi - lo) * f); }), up ? 'קרשנדו על הבחירה' : 'דימינואנדו על הבחירה');
  }
  function splitSel() {
    const list = selected();
    if (!list.length) return;
    const add = [];
    edit(() => list.forEach((n) => { const h = n.dur / 2; n.dur = h; add.push(Object.assign({}, n, { t: n.t + h })); st.notes.push(add[add.length - 1]); }), `${list.length} תווים פוצלו לשניים`);
    add.forEach((n) => st.sel.add(n));
  }
  function mergeSel() {
    const list = selected().sort((a, b) => a.pitch - b.pitch || a.t - b.t);
    const gone = new Set();
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (gone.has(a)) continue;
      if (a.pitch === b.pitch && b.t <= a.t + a.dur + 1e-3) { a.dur = Math.max(a.dur, b.t + b.dur - a.t); gone.add(b); list[i] = a; }
    }
    if (!gone.size) { status('אין תווים צמודים באותו צליל לאחד'); return; }
    edit(() => { st.notes = st.notes.filter((n) => !gone.has(n)); gone.forEach((n) => st.sel.delete(n)); }, `אוחדו ${gone.size} תווים`);
  }
  function octaveDouble(dir) {
    const list = selected();
    if (!list.length) return;
    const add = list.map((n) => Object.assign({}, n, { pitch: clamp(n.pitch + 12 * dir, 0, 127) }));
    edit(() => { st.notes.push(...add); }, `הוכפל אוקטבה ${dir > 0 ? 'למעלה' : 'למטה'}`);
  }
  function setArt(art) {
    const list = targets();
    edit(() => list.forEach((n) => { if (art) n.art = art; else delete n.art; }), art ? 'ארטיקולציה: ' + CF.Articulations.get(art).name : 'ארטיקולציה הוסרה');
  }
  function copy(cut) {
    const list = selected();
    if (!list.length) return;
    const t0 = Math.min(...list.map((n) => n.t));
    st.clip = list.map((n) => Object.assign({}, n, { t: n.t - t0 }));
    if (cut) del(list); else status(`הועתקו ${list.length} תווים`);
  }
  function paste(at) {
    if (!st.clip) return;
    const t = snapT(at != null ? at : st.cursorT);
    const add = st.clip.map((n) => Object.assign({}, n, { t: n.t + t }));
    edit(() => { st.notes.push(...add); st.sel = new Set(add); }, `הודבקו ${add.length} תווים`);
  }
  function duplicate() {
    const list = selected();
    if (!list.length) return;
    const t0 = Math.min(...list.map((n) => n.t)), t1 = Math.max(...list.map((n) => n.t + n.dur));
    const len = snapLen() ? Math.ceil((t1 - t0) / snapLen() - EPS) * snapLen() : t1 - t0;
    const add = list.map((n) => Object.assign({}, n, { t: n.t + len }));
    edit(() => { st.notes.push(...add); st.sel = new Set(add); }, 'שוכפל אחרי הבחירה');
  }
  function addNote(t, pitch, len) {
    const n = { t: floorT(t), dur: len || st.lastLen || snapLen() || 1, pitch, vel: st.lastVel };
    st.notes.push(n);
    st.sel = new Set([n]);
    audition(pitch, n.vel);
    return n;
  }
  function insertTime(t, len, remove) {
    edit(() => {
      if (remove) st.notes = st.notes.filter((n) => !(n.t >= t - EPS && n.t < t + len - EPS));
      st.notes.forEach((n) => { if (n.t >= t - EPS) n.t = Math.max(0, n.t + (remove ? -len : len)); });
      Object.keys(st.ccEdit).forEach((k) => { st.ccEdit[k] = st.ccEdit[k].filter((p) => !remove || !(p.t >= t && p.t < t + len)).map((p) => (p.t >= t - EPS ? { t: Math.max(0, p.t + (remove ? -len : len)), v: p.v } : p)); });
    }, remove ? 'נמחקה תיבה' : 'נוספה תיבה ריקה');
  }
  function selectAll() { st.sel = new Set(st.notes); draw(); }
  function revert() {
    app.confirm('להחזיר את הכלי לעיבוד האוטומטי? כל העריכות הידניות שלו יימחקו (אפשר לבטל עם Ctrl+Z).', 'חזרה לאוטומטי').then((ok) => {
      if (!ok) return;
      app.commit((p) => { const t = p.tracks.find((x) => x.id === st.trackId); if (t) t.edit = null; });
      load(false); draw(); status('הכלי חזר לעיבוד האוטומטי');
    });
  }

  // controller lane edits
  function ccSet(k, t0, t1, v0, v1) {
    if (!st.ccEdit[k]) st.ccEdit[k] = autoCC(k);
    const a = Math.min(t0, t1), b = Math.max(t0, t1);
    const step = 1 / 16;
    const pts = st.ccEdit[k].filter((p) => p.t < a - EPS || p.t > b + EPS);
    for (let t = Math.floor(a / step) * step; t <= b + EPS; t += step) {
      const f = b - a > EPS ? (t - t0) / (t1 - t0) : 1;
      pts.push({ t: +Math.max(0, t).toFixed(6), v: clamp(Math.round(v0 + (v1 - v0) * clamp(f, 0, 1)), 0, 127) });
    }
    // thin: keep a point only when the value changes
    pts.sort((x, y) => x.t - y.t);
    st.ccEdit[k] = pts.filter((p, i) => i === 0 || p.v !== pts[i - 1].v);
  }

  // ------------------------------------------------------------------ menu (rich, with rows)
  function menu(x, y, groups) {
    const m = $('prMenu');
    m.innerHTML = groups.map((g, gi) => {
      if (g === '-') return '<hr>';
      if (g.row) return `<div class="prm-row"><span class="prm-label">${g.label}</span><span class="prm-chips" dir="ltr">${g.row.map((it, i) => `<button type="button" data-g="${gi}" data-i="${i}" ${it.on ? 'aria-pressed="true"' : ''}>${it.label}</button>`).join('')}</span></div>`;
      if (g.slider) return `<div class="prm-row"><label class="prm-label" for="prmSlider">${g.label} <output id="prmOut">${g.value}</output></label><input type="range" id="prmSlider" min="${g.min}" max="${g.max}" value="${g.value}" data-g="${gi}"></div>`;
      if (g.head) return `<div class="prm-head">${g.head}</div>`;
      return `<button type="button" class="prm-item" data-g="${gi}" ${g.disabled ? 'disabled' : ''}><span>${g.label}</span>${g.key ? `<kbd>${g.key}</kbd>` : ''}</button>`;
    }).join('');
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
    m.style.top = clamp(y, 8, innerHeight - r.height - 8) + 'px';
    m.onclick = (e) => {
      const b = e.target.closest('button[data-g]');
      if (!b) return;
      const g = groups[+b.dataset.g];
      const it = g.row ? g.row[+b.dataset.i] : g;
      if (!g.keep) { m.hidden = true; $('prScroll').focus({ preventScroll: true }); }
      it.run();
      if (g.keep) b.parentElement.querySelectorAll('button').forEach((x) => x.removeAttribute('aria-pressed'));
    };
    const sl = $('prmSlider');
    if (sl) {
      const g = groups[+sl.dataset.g];
      sl.oninput = () => { $('prmOut').textContent = sl.value; g.preview(+sl.value); };
      sl.onchange = () => { g.run(+sl.value); };
    }
    const f = m.querySelector('button, input');
    if (f) f.focus();
  }
  const hideMenu = () => { $('prMenu').hidden = true; };

  function noteMenu(e, h) {
    if (!st.sel.has(h.n)) st.sel = new Set([h.n]);
    const list = selected();
    const n = h.n;
    const avg = Math.round(list.reduce((a, x) => a + x.vel, 0) / list.length);
    const arts = CF.Articulations.list;
    menu(e.clientX, e.clientY, [
      { head: list.length > 1 ? `${list.length} תווים נבחרו` : `${noteName(n.pitch)} · תיבה ${Math.floor(n.t / barLen() + EPS) + 1} · Velocity ${n.vel}` },
      { slider: true, label: 'Velocity', min: 1, max: 127, value: avg, preview: (v) => { list.forEach((x) => { x.vel = v; }); draw(); }, run: (v) => { st.lastVel = v; velSel(v); } },
      { row: VEL_PRESETS.map(([l, v]) => ({ label: l, run: () => velSel(v) })), label: 'עוצמה' },
      { row: LENGTHS.map(([l, v]) => ({ label: l, run: () => { st.lastLen = v; lengthSel(v, true); } })), label: 'אורך' },
      { row: [['-12', -12], ['-1', -1], ['+1', 1], ['+12', 12]].map(([l, v]) => ({ label: l, run: () => transposeSel(v) })), label: 'טרנספוזיציה', keep: true },
      { row: [{ label: 'ללא', run: () => setArt(null) }].concat(arts.map((a) => ({ label: a.name.replace(/ \(.*\)/, ''), on: list.every((x) => x.art === a.id), run: () => setArt(a.id) }))), label: 'ארטיקולציה' },
      '-',
      { label: 'קוונטיזציה של ההתחלה', key: 'Q', run: () => quantize(false) },
      { label: 'קוונטיזציה של האורך', key: 'Shift+Q', run: () => quantize(true) },
      { label: 'לגאטו: כל תו עד התו הבא', run: legatoToNext },
      { label: 'קרשנדו על הבחירה', disabled: list.length < 2, run: () => ramp(true) },
      { label: 'דימינואנדו על הבחירה', disabled: list.length < 2, run: () => ramp(false) },
      { label: 'הומניזציה קלה (זמן ועוצמה)', run: humanize },
      { label: 'פיצול לשני תווים', run: splitSel },
      { label: 'איחוד תווים צמודים באותו צליל', disabled: list.length < 2, run: mergeSel },
      { label: 'הכפלה באוקטבה מעל', run: () => octaveDouble(1) },
      { label: 'הכפלה באוקטבה מתחת', run: () => octaveDouble(-1) },
      { label: `בחירת כל ה-${noteName(n.pitch)} בכלי`, run: () => { st.sel = new Set(st.notes.filter((x) => x.pitch === n.pitch)); draw(); } },
      '-',
      { label: 'העתקה', key: 'Ctrl+C', run: () => copy(false) },
      { label: 'גזירה', key: 'Ctrl+X', run: () => copy(true) },
      { label: 'שכפול אחרי הבחירה', key: 'Ctrl+D', run: duplicate },
      { label: 'מחיקה', key: 'Delete', run: () => del() },
    ]);
  }

  function emptyMenu(e, pt) {
    st.cursorT = pt.t;
    const bar = Math.floor(pt.t / barLen() + EPS) * barLen();
    menu(e.clientX, e.clientY, [
      { head: `תיבה ${Math.floor(pt.t / barLen() + EPS) + 1} · ${noteName(pt.pitch)}` },
      { label: `הוספת ${noteName(pt.pitch)} כאן`, key: 'לחיצה כפולה', run: () => edit(() => addNote(pt.t, pt.pitch), 'נוסף תו') },
      { label: 'הדבקה כאן', key: 'Ctrl+V', disabled: !st.clip, run: () => paste(pt.t) },
      '-',
      { label: 'בחירת הכל', key: 'Ctrl+A', run: selectAll },
      { label: 'בחירה מכאן ועד הסוף', run: () => { st.sel = new Set(st.notes.filter((n) => n.t >= pt.t - EPS)); draw(); } },
      { label: `בחירת כל ה-${noteName(pt.pitch)}`, run: () => { st.sel = new Set(st.notes.filter((n) => n.pitch === pt.pitch)); draw(); } },
      '-',
      { label: `הכנסת תיבה ריקה לפני תיבה ${bar / barLen() + 1}`, run: () => insertTime(bar, barLen(), false) },
      { label: `מחיקת תיבה ${bar / barLen() + 1} בכלי הזה`, run: () => insertTime(bar, barLen(), true) },
      { row: [['-12', -12], ['-1', -1], ['+1', 1], ['+12', 12]].map(([l, v]) => ({ label: l, run: () => transposeSel(v) })), label: 'טרנספוזיציה לכל הכלי', keep: true },
      '-',
      { label: st.ghosts ? 'הסתרת שאר הכלים' : 'הצגת שאר הכלים ברקע', run: () => { st.ghosts = !st.ghosts; draw(); } },
      { label: 'כל השיר בחלון', run: fit },
      { label: 'חזרה לעיבוד האוטומטי', disabled: !st.edited, run: revert },
    ]);
  }

  /** The "⋯" button: everything that is not on the toolbar. */
  function actionsMenu(x, y) {
    const any = st.sel.size;
    const who = any ? `ל-${st.sel.size} התווים הנבחרים` : 'לכל הכלי';
    menu(x, y, [
      { head: 'פעולות ' + who },
      { row: [['-12', -12], ['-1', -1], ['+1', 1], ['+12', 12]].map(([l, v]) => ({ label: l, run: () => transposeSel(v) })), label: 'טרנספוזיציה', keep: true },
      { row: VEL_PRESETS.map(([l, v]) => ({ label: l, run: () => velSel(v) })), label: 'Velocity' },
      { row: [['-10', -10], ['-5', -5], ['+5', 5], ['+10', 10]].map(([l, v]) => ({ label: l, run: () => velSel(v, true) })), label: 'Velocity יחסי', keep: true },
      '-',
      { label: 'קוונטיזציה של ההתחלה', key: 'Q', run: () => quantize(false) },
      { label: 'קוונטיזציה של האורך', key: 'Shift+Q', run: () => quantize(true) },
      { label: 'לגאטו: כל תו עד התו הבא', run: legatoToNext },
      { label: 'קרשנדו', run: () => ramp(true) },
      { label: 'דימינואנדו', run: () => ramp(false) },
      { label: 'הומניזציה קלה', run: humanize },
      '-',
      { label: 'בחירת הכל', key: 'Ctrl+A', run: selectAll },
      { label: (st.ghosts ? '✓ ' : '') + 'שאר הכלים ברקע', run: () => { st.ghosts = !st.ghosts; draw(); } },
      { label: (st.follow ? '✓ ' : '') + 'הגלילה עוקבת אחרי הנגינה', run: () => { st.follow = !st.follow; } },
      { label: 'חזרה לעיבוד האוטומטי', disabled: !st.edited, run: revert },
    ]);
  }

  function laneMenu(e, pt) {
    const k = st.lane;
    if (k === 'vel') {
      menu(e.clientX, e.clientY, [
        { head: 'Velocity' },
        { row: VEL_PRESETS.map(([l, v]) => ({ label: l, run: () => velSel(v) })), label: st.sel.size ? 'לתווים הנבחרים' : 'לכל התווים' },
        { row: [['-10', -10], ['-5', -5], ['+5', 5], ['+10', 10]].map(([l, v]) => ({ label: l, run: () => velSel(v, true) })), label: 'שינוי יחסי', keep: true },
        { label: 'קרשנדו', run: () => ramp(true) },
        { label: 'דימינואנדו', run: () => ramp(false) },
        { label: 'הומניזציה קלה', run: humanize },
      ]);
      return;
    }
    const name = LANES.find((l) => l.id === k).name;
    menu(e.clientX, e.clientY, [
      { head: name },
      { row: [['0', 0], ['32', 32], ['64', 64], ['100', 100], ['127', 127]].map(([l, v]) => ({ label: l, run: () => edit(() => { st.ccEdit[k] = [{ t: 0, v }]; }, `${name}: קו ישר ${v}`) })), label: 'ערך קבוע לכל השיר' },
      { label: 'ריכוך הקו', disabled: !st.ccEdit[k], run: () => edit(() => { const p = st.ccEdit[k]; st.ccEdit[k] = p.map((x, i) => ({ t: x.t, v: Math.round(((p[i - 1] || x).v + x.v * 2 + (p[i + 1] || x).v) / 4) })); }, 'הקו רוכך') },
      { label: 'מחיקה מכאן ועד הסוף', disabled: !st.ccEdit[k], run: () => edit(() => { st.ccEdit[k] = st.ccEdit[k].filter((x) => x.t < pt.t); }, 'נמחק עד הסוף') },
      { label: 'חזרה לעקומה האוטומטית', disabled: !st.ccEdit[k], run: () => edit(() => { delete st.ccEdit[k]; }, `${name}: אוטומטי`) },
    ]);
  }

  // ------------------------------------------------------------------ pointer handling
  function onGridDown(e) {
    hideMenu();
    $('prScroll').focus({ preventScroll: true });
    const pt = pointer(e);
    st.cursorT = pt.t;
    if (e.button === 2) return;
    const h = hit(pt);
    if (st.tool === 'erase') { if (h) del([h.n]); st.drag = { kind: 'erase' }; return; }
    if (st.tool === 'draw' && !h) {
      const n = addNote(pt.t, pt.pitch, snapLen() || st.lastLen || 1);
      st.drag = { kind: 'resize-end', notes: [n], orig: [{ t: n.t, dur: n.dur, pitch: n.pitch }], x0: pt.x, y0: pt.y, created: true };
      draw();
      return;
    }
    if (st.tool === 'draw' && h) { del([h.n]); return; }
    if (h) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { if (st.sel.has(h.n) && (e.ctrlKey || e.metaKey)) st.sel.delete(h.n); else st.sel.add(h.n); }
      else if (!st.sel.has(h.n)) st.sel = new Set([h.n]);
      let list = selected();
      if (!list.includes(h.n)) list = [h.n];
      if (e.altKey && h.part === 'body') {
        const copies = list.map((n) => Object.assign({}, n));
        st.notes.push(...copies);
        st.sel = new Set(copies);
        list = copies;
      }
      audition(h.n.pitch, h.n.vel);
      st.lastVel = h.n.vel;
      st.drag = { kind: h.part === 'end' ? 'resize-end' : h.part === 'start' ? 'resize-start' : 'move', notes: list, anchor: h.n, orig: list.map((n) => ({ t: n.t, dur: n.dur, pitch: n.pitch })), x0: pt.x, y0: pt.y, moved: !!e.altKey };
    } else {
      if (!e.shiftKey) st.sel.clear();
      st.drag = { kind: 'band', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, base: new Set(st.sel) };
    }
    draw();
  }

  function onGridMove(e) {
    const pt = pointer(e);
    st.hover = pt;
    const d = st.drag;
    const sc = $('prScroll');
    if (!d) {
      const h = hit(pt);
      sc.style.cursor = st.tool === 'draw' ? 'crosshair' : st.tool === 'erase' ? 'not-allowed' : h ? (h.part === 'body' ? 'grab' : 'ew-resize') : 'default';
      renderInfo();
      return;
    }
    if (d.kind === 'erase') { const h = hit(pt); if (h) { st.notes = st.notes.filter((n) => n !== h.n); d.moved = true; draw(); } return; }
    if (d.kind === 'band') {
      d.x1 = pt.x; d.y1 = pt.y;
      const ta = Math.min(d.x0, d.x1) / st.ppq, tb = Math.max(d.x0, d.x1) / st.ppq;
      const pa = 127 - Math.floor(Math.max(d.y0, d.y1) / st.rh), pb = 127 - Math.floor(Math.min(d.y0, d.y1) / st.rh);
      st.sel = new Set([...d.base, ...st.notes.filter((n) => n.t < tb && n.t + n.dur > ta && n.pitch >= pa && n.pitch <= pb)]);
      draw();
      return;
    }
    const dx = (pt.x - d.x0) / st.ppq, dy = pt.y - d.y0;
    if (!d.moved && Math.abs(pt.x - d.x0) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    if (d.kind === 'move') {
      const ai = d.notes.indexOf(d.anchor);
      const a0 = d.orig[ai >= 0 ? ai : 0];
      let dt = (e.shiftKey ? 0 : snapT(a0.t + dx) - a0.t);
      if (e.shiftKey) dt = 0; // Shift = move pitch only
      const minT = Math.min(...d.orig.map((o) => o.t));
      if (minT + dt < 0) dt = -minT;
      const dp = -Math.round(dy / st.rh);
      d.notes.forEach((n, i) => { n.t = d.orig[i].t + dt; n.pitch = clamp(d.orig[i].pitch + dp, 0, 127); });
      if (dp !== d.lastDp && d.anchor) { d.lastDp = dp; audition(d.anchor.pitch, d.anchor.vel); }
    } else if (d.kind === 'resize-end') {
      d.notes.forEach((n, i) => { const end = snapT(d.orig[i].t + d.orig[i].dur + dx); n.dur = Math.max(minLen(), end - n.t); });
    } else if (d.kind === 'resize-start') {
      d.notes.forEach((n, i) => { const end = d.orig[i].t + d.orig[i].dur; const s = clamp(snapT(d.orig[i].t + dx), 0, end - minLen()); n.t = s; n.dur = end - s; });
    }
    draw();
  }

  function onGridUp() {
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    if (d.moved) st.lastDragAt = Date.now();
    if (d.kind === 'band') { draw(); return; }
    if (d.kind === 'erase') { if (d.moved) save('נמחקו תווים'); return; }
    if (d.moved || d.created) {
      if (d.kind !== 'move' && d.notes[0]) st.lastLen = d.notes[0].dur;
      save(d.created ? 'נוסף תו' : d.kind === 'move' ? 'הוזז' : 'אורך עודכן');
    }
  }

  function onGridDbl(e) {
    if (st.tool !== 'select') return;
    if (Date.now() - (st.lastDragAt || 0) < 600) return; // the second click of a drag is not a double-click
    const pt = pointer(e);
    const h = hit(pt);
    if (h) del([h.n]); else edit(() => addNote(pt.t, pt.pitch), `נוסף ${noteName(pt.pitch)}`);
  }

  function onGridContext(e) {
    e.preventDefault();
    const pt = pointer(e);
    const h = hit(pt);
    if (h) noteMenu(e, h); else emptyMenu(e, pt);
  }

  // controller lane
  function lanePoint(e) {
    const c = $('prLane');
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left + $('prScroll').scrollLeft;
    return { x, t: Math.max(0, x / st.ppq), ly: e.clientY - r.top, h: r.height };
  }
  function onLaneDown(e) {
    hideMenu();
    if (e.button === 2) return;
    const pt = lanePoint(e);
    const val = laneVal(pt, pt.h);
    if (st.lane === 'vel') {
      // nearest stem (within 6px), else "paint" velocities along the drag
      let best = null, bd = 7;
      st.notes.forEach((n) => { const dd = Math.abs(xOf(n.t) - pt.x); if (dd < bd) { bd = dd; best = n; } });
      if (best && st.sel.has(best) && st.sel.size > 1) st.drag = { kind: 'vel-rel', notes: selected(), orig: selected().map((n) => n.vel), y0: pt.ly, h: pt.h };
      else st.drag = { kind: 'vel-paint', last: pt };
      if (st.drag.kind === 'vel-paint') paintVel(pt, pt, val);
    } else {
      st.drag = { kind: 'cc', last: { t: pt.t, v: val } };
      ccSet(st.lane, pt.t, pt.t, val, val);
    }
    draw();
  }
  function paintVel(a, b, v) {
    const x0 = Math.min(a.x, b.x) - 5, x1 = Math.max(a.x, b.x) + 5;
    st.notes.forEach((n) => { const x = xOf(n.t); if (x >= x0 && x <= x1 && (!st.sel.size || st.sel.has(n))) n.vel = clamp(v, 1, 127); });
  }
  function onLaneMove(e) {
    const d = st.drag;
    if (!d || !d.kind || !/^(vel|cc)/.test(d.kind)) return;
    const pt = lanePoint(e);
    const val = laneVal(pt, pt.h);
    if (d.kind === 'vel-rel') {
      const dv = Math.round(((d.y0 - pt.ly) / (pt.h - 8)) * 127);
      d.notes.forEach((n, i) => { n.vel = clamp(d.orig[i] + dv, 1, 127); });
    } else if (d.kind === 'vel-paint') { paintVel(d.last, pt, val); d.last = pt; } else {
      ccSet(st.lane, d.last.t, pt.t, d.last.v, val);
      d.last = { t: pt.t, v: val };
    }
    d.moved = true;
    draw();
  }
  function onLaneUp() {
    const d = st.drag;
    if (!d || !/^(vel|cc)/.test(d.kind || '')) return;
    st.drag = null;
    save(d.kind === 'cc' ? LANES.find((l) => l.id === st.lane).name + ' עודכן' : 'Velocity עודכן');
  }

  // ruler and keys
  function onRulerDown(e) {
    const r = $('prRuler').getBoundingClientRect();
    const t = Math.max(0, (e.clientX - r.left + $('prScroll').scrollLeft) / st.ppq);
    app.seek(snapT(t));
    draw();
  }
  function onKeysDown(e) {
    const r = $('prKeys').getBoundingClientRect();
    const p = clamp(127 - Math.floor((e.clientY - r.top + $('prScroll').scrollTop) / st.rh), 0, 127);
    audition(p, st.lastVel);
    const same = st.notes.filter((n) => n.pitch === p);
    st.sel = new Set(e.shiftKey ? [...st.sel, ...same] : same);
    draw();
  }

  // ------------------------------------------------------------------ keyboard
  function onKey(e) {
    e.stopPropagation();
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!$('prMenu').hidden) { hideMenu(); $('prScroll').focus(); return; }
      if (st.sel.size) { st.sel.clear(); draw(); return; }
      close();
      return;
    }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); app.redo(); return; }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); app.togglePlay(); return; }
    if (mod && (k === 'a' || e.code === 'KeyA')) { e.preventDefault(); selectAll(); return; }
    if (mod && (k === 'c' || e.code === 'KeyC')) { e.preventDefault(); copy(false); return; }
    if (mod && (k === 'x' || e.code === 'KeyX')) { e.preventDefault(); copy(true); return; }
    if (mod && (k === 'v' || e.code === 'KeyV')) { e.preventDefault(); paste(app.getPosition()); return; }
    if (mod && (k === 'd' || e.code === 'KeyD')) { e.preventDefault(); duplicate(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); if (st.sel.size) transposeSel((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? barLen() : snapLen() || 0.25;
      // the editor runs left to right, like every DAW
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.altKey) lengthSel(dir * step); else moveSel(dir * step);
      return;
    }
    if (e.code === 'KeyQ') { e.preventDefault(); quantize(e.shiftKey); return; }
    if (e.code === 'KeyV' && !mod) { setTool('select'); return; }
    if (e.code === 'KeyP' && !mod) { setTool('draw'); return; }
    if (e.code === 'KeyE' && !mod) { setTool('erase'); return; }
    if (e.key === '+' || e.key === '=') { zoom(1.25); return; }
    if (e.key === '-') { zoom(0.8); return; }
  }

  // ------------------------------------------------------------------ view controls
  function setTool(t) { st.tool = t; draw(); status({ select: 'כלי בחירה (V)', draw: 'עיפרון (P): קליק מוסיף, גרירה קובעת אורך', erase: 'מחק (E): קליק או גרירה מוחקים' }[t]); }
  function zoom(f, anchorX) {
    const sc = $('prScroll');
    const ax = anchorX != null ? anchorX : sc.clientWidth / 2;
    const t = (sc.scrollLeft + ax) / st.ppq;
    st.ppq = clamp(st.ppq * f, 8, 480);
    draw();
    sc.scrollLeft = t * st.ppq - ax;
    draw();
  }
  function zoomV(f) {
    const sc = $('prScroll');
    const mid = (sc.scrollTop + sc.clientHeight / 2) / st.rh;
    st.rh = clamp(Math.round(st.rh * f), 6, 30);
    draw();
    sc.scrollTop = mid * st.rh - sc.clientHeight / 2;
    draw();
  }
  function fit() {
    const sc = $('prScroll');
    st.ppq = clamp((sc.clientWidth - 20) / songEnd(), 8, 480);
    draw();
    sc.scrollLeft = 0;
    centerNotes();
  }
  function centerNotes() {
    const sc = $('prScroll');
    const ps = st.notes.map((n) => n.pitch);
    const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
    sc.scrollTop = Math.max(0, yOf(mid) - sc.clientHeight / 2);
    draw();
  }

  function tick() {
    if (!st.open) return;
    if (app.player.playing) {
      const sc = $('prScroll');
      const x = xOf(app.getPosition());
      if (st.follow && !st.drag && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40)) sc.scrollLeft = Math.max(0, x - 40);
      draw();
    }
    st.raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ window
  function build() {
    el = document.createElement('div');
    el.className = 'pr';
    el.id = 'pianoRoll';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'prTitle');
    el.hidden = true;
    const snapOpts = SNAPS.map((s) => `<option value="${s.v}">${s.name}</option>`).join('');
    const laneOpts = LANES.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
    el.innerHTML = `
      <div class="pr-head" id="prHead">
        <h2 id="prTitle">פיאנו רול</h2>
        <span class="pr-badge" id="prBadge"></span>
        <span class="pr-spacer"></span>
        <button class="btn ghost small" id="prRevert" type="button" hidden>חזרה לעיבוד האוטומטי</button>
        <button class="icon-btn" id="prMax" type="button" aria-label="הגדלה למסך מלא" title="מסך מלא"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
        <button class="icon-btn" id="prClose" type="button" aria-label="סגירת הפיאנו רול"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="pr-tools">
        <div class="seg pr-seg" role="group" aria-label="כלי עריכה">
          <button type="button" data-tool="select" title="בחירה והזזה (V)">בחירה</button>
          <button type="button" data-tool="draw" title="עיפרון (P)">עיפרון</button>
          <button type="button" data-tool="erase" title="מחק (E)">מחק</button>
        </div>
        <label class="pr-field"><span>הצמדה</span><select id="prSnap">${snapOpts}</select></label>
        <div class="pr-group" role="group" aria-label="זום">
          <button type="button" class="icon-btn sm" id="prZoomOut" aria-label="הקטנה"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
          <button type="button" class="icon-btn sm" id="prZoomIn" aria-label="הגדלה"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
          <button type="button" class="icon-btn sm" id="prFit" aria-label="כל השיר בחלון" title="כל השיר בחלון"><svg viewBox="0 0 24 24"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/></svg></button>
          <button type="button" class="icon-btn sm" id="prTaller" aria-label="שורות גבוהות יותר" title="גובה השורות"><svg viewBox="0 0 24 24"><path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/></svg></button>
        </div>
        <button type="button" class="btn ghost small" id="prMore" aria-haspopup="menu" title="כל הפעולות">⋯ פעולות</button>
        <span class="pr-spacer"></span>
        <button type="button" class="play-btn pr-play" id="prPlay" aria-label="נגן / עצור (רווח)"><svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="i-pause" viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg></button>
      </div>
      <div class="pr-body" dir="ltr">
        <div class="pr-corner"></div>
        <div class="pr-ruler-wrap"><canvas id="prRuler" aria-label="סרגל: לחיצה מזיזה את סמן הנגינה"></canvas></div>
        <div class="pr-keys-wrap"><canvas id="prKeys" aria-label="מקלדת: לחיצה משמיעה ובוחרת את כל התווים בצליל"></canvas></div>
        <div class="pr-scroll" id="prScroll" tabindex="0" aria-label="תווים. חצים מזיזים, Delete מוחק, לחיצה כפולה מוסיפה, קליק ימני פותח אפשרויות">
          <canvas id="prGrid"></canvas><div class="pr-spacer-box" id="prSpacer"></div>
        </div>
        <div class="pr-lane-label" dir="rtl"><select id="prLaneSel" aria-label="בקר בשורה התחתונה">${laneOpts}</select></div>
        <div class="pr-lane-wrap"><canvas id="prLane" aria-label="שורת בקר: גרירה מציירת ערכים"></canvas></div>
      </div>
      <div class="pr-foot"><span id="prInfo"></span><span id="prStatus"></span></div>
      <div class="pr-menu" id="prMenu" role="menu" hidden></div>`;
    document.body.appendChild(el);

    const sc = $('prScroll');
    sc.addEventListener('scroll', () => { requestAnimationFrame(draw); hideMenu(); });
    sc.addEventListener('pointerdown', (e) => { sc.setPointerCapture && e.button === 0 && sc.setPointerCapture(e.pointerId); onGridDown(e); });
    sc.addEventListener('pointermove', onGridMove);
    sc.addEventListener('pointerup', onGridUp);
    sc.addEventListener('pointercancel', onGridUp);
    sc.addEventListener('pointerleave', () => { st.hover = null; renderInfo(); });
    sc.addEventListener('dblclick', onGridDbl);
    sc.addEventListener('contextmenu', onGridContext);
    sc.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = sc.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - r.left); } else if (e.altKey) { e.preventDefault(); zoomV(e.deltaY < 0 ? 1.15 : 0.87); }
    }, { passive: false });
    const lane = $('prLane');
    lane.addEventListener('pointerdown', (e) => { if (e.button === 0) lane.setPointerCapture(e.pointerId); onLaneDown(e); });
    lane.addEventListener('pointermove', onLaneMove);
    lane.addEventListener('pointerup', onLaneUp);
    lane.addEventListener('contextmenu', (e) => { e.preventDefault(); laneMenu(e, lanePoint(e)); });
    lane.addEventListener('wheel', (e) => { sc.scrollLeft += e.deltaY + e.deltaX; e.preventDefault(); }, { passive: false });
    $('prRuler').addEventListener('pointerdown', onRulerDown);
    $('prKeys').addEventListener('pointerdown', onKeysDown);
    $('prKeys').addEventListener('wheel', (e) => { sc.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    // while the roll is open it gets the keys (also when focus fell back to the page)
    document.addEventListener('keydown', (e) => {
      if (!st.open) return;
      const t = e.target;
      if (!(el.contains(t) || t === document.body || t === document.documentElement)) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      onKey(e);
    }, true);
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('#prMenu')) hideMenu(); });
    document.addEventListener('pointerdown', (e) => { if (st.open && !el.contains(e.target)) hideMenu(); });

    el.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('prSnap').addEventListener('change', (e) => { const v = e.target.value; st.snap = v === 'bar' ? 'bar' : +v; draw(); });
    $('prZoomIn').addEventListener('click', () => zoom(1.25));
    $('prZoomOut').addEventListener('click', () => zoom(0.8));
    $('prFit').addEventListener('click', fit);
    $('prTaller').addEventListener('click', () => zoomV(st.rh >= 22 ? 0.5 : 1.35));
    $('prPlay').addEventListener('click', () => app.togglePlay());
    $('prMore').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); actionsMenu(r.left, r.bottom + 6); });
    $('prLaneSel').addEventListener('change', (e) => { st.lane = e.target.value === 'vel' ? 'vel' : +e.target.value; draw(); $('prScroll').focus({ preventScroll: true }); });
    $('prRevert').addEventListener('click', revert);
    $('prClose').addEventListener('click', close);
    $('prMax').addEventListener('click', () => { el.classList.toggle('max'); requestAnimationFrame(draw); });

    // drag the window by its title bar
    $('prHead').addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || el.classList.contains('max')) return;
      const r = el.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = (ev) => { el.style.left = clamp(ev.clientX - ox, 0, innerWidth - 120) + 'px'; el.style.top = clamp(ev.clientY - oy, 0, innerHeight - 60) + 'px'; el.style.right = 'auto'; };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    });
    if (root.ResizeObserver) new ResizeObserver(() => { if (st.open) draw(); }).observe(el);
  }

  function open(trackId) {
    if (!el) build();
    const first = st.trackId !== trackId;
    st.trackId = trackId;
    st.open = true;
    el.hidden = false;
    if (first) { st.sel = new Set(); st.ppq = 72; }
    load(false);
    $('prSnap').value = String(st.snap);
    $('prLaneSel').value = String(st.lane);
    requestAnimationFrame(() => {
      draw();
      if (first) { const x = xOf(app.getPosition()); $('prScroll').scrollLeft = Math.max(0, x - 40); centerNotes(); }
      $('prScroll').focus({ preventScroll: true });
    });
    status(st.edited ? 'הכלי ערוך ידנית' : 'זה העיבוד האוטומטי. העריכה הראשונה תהפוך את הכלי לערוך ידנית');
    cancelAnimationFrame(st.raf);
    st.raf = requestAnimationFrame(tick);
  }

  function close() {
    if (!el) return;
    st.open = false;
    el.hidden = true;
    hideMenu();
    cancelAnimationFrame(st.raf);
    if (app.onClose) app.onClose();
  }

  /** Called by the app after every change (edit, undo, redo, other panels). */
  function sync() {
    if (!st.open || st.saving || st.drag) return;
    const t = track();
    if (!t) { close(); return; }
    const mine = JSON.stringify({ notes: st.notes, cc: st.ccEdit });
    if (t.edit && JSON.stringify(t.edit) === mine && st.edited) { draw(); return; }
    load(true);
    draw();
  }

  CF.PianoRoll = {
    init(api) { app = api; },
    open, close, sync,
    get isOpen() { return st.open; },
    get trackId() { return st.trackId; },
    // for tests
    _state: st,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
