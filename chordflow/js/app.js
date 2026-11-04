/*
 * ChordFlow — application controller (UI, editing, persistence, export).
 */
(function () {
  'use strict';
  const CF = window.CF;
  const T = CF.Theory, P = CF.Project, Store = CF.Store, D = CF.Dynamics;
  const $ = (id) => document.getElementById(id);
  const EPS = 1e-6;

  const state = {
    project: null,
    arr: null,
    selectedId: null,     // chord
    trackId: null,        // track shown in the inspector
    tab: 'track',
    zoom: 34,             // pixels per quarter note
    snap: 'beat',
    position: 0,
    history: [],
    future: [],
    inputDirty: false,
    saveTimer: null,
    storageOk: true,
    playingChordId: null,
  };
  let player;

  // ================================================================ utils

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round = (n, d = 4) => +(+n).toFixed(d);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const barLen = () => T.barLength(state.project.timeSig);
  const beatUnit = () => 4 / state.project.timeSig.den;
  const sortedChords = () => state.project.chords.slice().sort((a, b) => a.start - b.start);
  const chordEnd = () => state.project.chords.reduce((m, c) => Math.max(m, c.start + c.length), 0);
  const famOf = (tr) => CF.Families.get(tr.family) || CF.Families.list[0];
  const instOf = (tr) => CF.Instruments.get(tr.instrument) || CF.Instruments.list[0];
  const roleOf = (tr) => famOf(tr).role;
  const trackById = (id) => state.project.tracks.find((t) => t.id === id) || null;
  const currentTrack = () => trackById(state.trackId) || state.project.tracks[0];

  function snapStep() {
    if (state.snap === 'bar') return barLen();
    if (state.snap === 'beat') return beatUnit();
    return parseFloat(state.snap) || 1;
  }
  const snapRound = (x) => { const s = snapStep(); return Math.round(x / s + EPS) * s; };

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const safeFileBase = (name) => String(name || 'ChordFlow').replace(/[\\/:*?"<>|]+/g, '').trim() || 'ChordFlow';
  const noteLabel = (p) => T.noteName(p % 12, state.project.key) + (Math.floor(p / 12) - 1);
  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ------------------------------------------------------------- icons

  const ICONS = {
    keys: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v8M12 5v8M16 5v8M8 13v6M12 13v6M16 13v6"/></svg>',
    bass: '<svg viewBox="0 0 24 24"><path d="M5 9a5.5 5.5 0 0 1 11 0c0 5.5-5 9.5-11 11"/><circle cx="5.5" cy="9" r="1.6"/><path d="M19.5 7.5v.01M19.5 11.5v.01" stroke-width="2.6"/></svg>',
    strings: '<svg viewBox="0 0 24 24"><path d="M12 2v5"/><path d="M10 4h4"/><path d="M9.5 7.5c-2.2 1-2.2 3.4 0 4.3-3.5 1.1-3.5 7.4 2.5 8.7 6-1.3 6-7.6 2.5-8.7 2.2-.9 2.2-3.3 0-4.3z"/><path d="M12 11v6M10.3 12.5v.01M13.7 12.5v.01"/><path d="M3 21 21 9" opacity=".55"/></svg>',
    brass: '<svg viewBox="0 0 24 24"><path d="M3 10.5h8.5L20 5v14l-8.5-5.5H3z"/><path d="M6 13.5V17h4"/><path d="M8 10.5v-2M10 10.5v-2"/></svg>',
    winds: '<svg viewBox="0 0 24 24"><path d="M3.5 19 19 5.5"/><path d="M17.5 4l2.5 2.5"/><path d="M8.2 15.2v.01M10.7 13v.01M13.2 10.8v.01" stroke-width="2.8"/></svg>',
    pad: '<svg viewBox="0 0 24 24"><path d="M2 12c2.5-4.5 4.5-4.5 7 0s4.5 4.5 7 0 3.5-4 6-2"/><path d="M2 17c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0 3.5-2 6-1" opacity=".5"/><path d="M2 7c2.5-2 4.5-2 7 0s4.5 2 7 0 3.5-2 6-1" opacity=".5"/></svg>',
  };
  const SHAPE_ICONS = {
    flat: 'M2 12H58',
    swell: 'M2 20Q16 0 30 20Q44 0 58 20',
    phrase: 'M2 21C20-2 40-2 58 21',
    cresc: 'M2 20L28 5M32 20L58 5',
    dim: 'M2 5L28 20M32 5L58 20',
    pulse: 'M2 4L14 19M16 4L28 19M30 4L42 19M44 4L56 19',
  };
  const famIcon = (fam) => ICONS[fam] || ICONS.keys;
  const cssVar = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
  /** Family colour as a CSS value (follows the colour skin). */
  const famCss = (fam) => `var(--f-${fam.id}, ${fam.color})`;

  // ---------------------------------------------------------- colour skins
  const SKINS = [
    { id: 'emerald', name: 'ירוק בית ליוצרים', sw: ['#0a1d16', '#1a3d30', '#d9b866'] },
    { id: 'midnight', name: 'כחול לילה וזהב', sw: ['#08101f', '#1a2b52', '#d9b866'] },
    { id: 'bordeaux', name: 'בורדו וזהב', sw: ['#1b090c', '#421b21', '#ddb86a'] },
    { id: 'graphite', name: 'גרפיט וענבר', sw: ['#111113', '#2b2b30', '#f0a23a'] },
    { id: 'ivory', name: 'בהיר: שמנת וירוק', sw: ['#fbf8f1', '#2f6e57', '#a57a20'] },
  ];
  function currentSkin() { return document.documentElement.getAttribute('data-skin') || 'emerald'; }
  function applySkin(id, save) {
    if (!SKINS.some((s) => s.id === id)) id = 'emerald';
    if (id === 'emerald') document.documentElement.removeAttribute('data-skin');
    else document.documentElement.setAttribute('data-skin', id);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', cssVar('--ink-1', '#0a1d16'));
    if (save) { try { localStorage.setItem('chordflow.skin', id); } catch (e) { /* ignore */ } }
    renderSkinMenu();
    if (state.project) { renderArrangement(); renderInspector(); }
  }
  function renderSkinMenu() {
    const cur = currentSkin();
    $('skinMenu').innerHTML = SKINS.map((s) => `<button class="skin-opt" role="menuitemradio" data-skin="${s.id}" aria-checked="${s.id === cur}">
      <span class="swatch">${s.sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${esc(s.name)}</button>`).join('');
  }
  function toggleSkinMenu(open) {
    const m = $('skinMenu');
    const show = open != null ? open : m.hidden;
    m.hidden = !show;
    $('skinBtn').setAttribute('aria-expanded', String(show));
  }

  // ---------------------------------------------------------- modals
  let lastFocus = null;
  function openModal(id) {
    lastFocus = document.activeElement;
    $(id).hidden = false;
    const f = $(id).querySelector('input:not([type=checkbox]), button:not([data-close])');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal(id) {
    $(id).hidden = true;
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) lastFocus.focus();
  }
  const openModalId = () => { const m = document.querySelector('.modal:not([hidden])'); return m ? m.id : null; };

  function confirmDialog(text, yesLabel) {
    return new Promise((resolve) => {
      $('confirmText').textContent = text;
      $('confirmYes').textContent = yesLabel || 'אישור';
      openModal('confirmModal');
      const done = (v) => {
        closeModal('confirmModal');
        $('confirmYes').onclick = $('confirmNo').onclick = null;
        resolve(v);
      };
      $('confirmYes').onclick = () => done(true);
      $('confirmNo').onclick = () => done(false);
      setTimeout(() => $('confirmYes').focus(), 40);
    });
  }

  // ============================================================ project

  function fitCurveToSong(p) {
    if (p.dynamics.preset && p.dynamics.preset !== 'custom') {
      p.dynamics.points = D.presetPoints(p.dynamics.preset, CF.Arranger.songEndOf(p), T.barLength(p.timeSig));
    }
  }

  function recompute() {
    state.arr = CF.Arranger.arrange(state.project);
  }

  function setProject(p) {
    if (player && player.playing) player.halt();
    state.project = p;
    state.history = [];
    state.future = [];
    state.selectedId = null;
    state.trackId = p.tracks[0] ? p.tracks[0].id : null;
    state.position = 0;
    state.inputDirty = false;
    if (player) player.position = 0;
    fitCurveToSong(p);
    recompute();
    syncProgressionText(true);
    renderAll();
    setPosition(0);
    saveNow();
  }

  /** Every edit goes through commit(): undo history, re-arrange, save, re-render, live audio refresh. */
  function commit(mutator, opts) {
    const before = JSON.stringify(state.project);
    mutator(state.project);
    if (JSON.stringify(state.project) === before) return false;
    state.history.push(before);
    if (state.history.length > 150) state.history.shift();
    state.future = [];
    afterChange(opts);
    return true;
  }

  function afterChange(opts) {
    opts = opts || {};
    const p = state.project;
    p.updatedAt = new Date().toISOString();
    p.chords.sort((a, b) => a.start - b.start);
    fitCurveToSong(p);
    if (state.selectedId && !p.chords.some((c) => c.id === state.selectedId)) state.selectedId = null;
    if (!trackById(state.trackId)) state.trackId = p.tracks[0] ? p.tracks[0].id : null;
    recompute();
    scheduleSave();
    if (!state.inputDirty || opts.syncText) syncProgressionText(true);
    renderAll();
    if (player) player.refresh();
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(JSON.stringify(state.project));
    state.project = JSON.parse(state.history.pop());
    afterChange({ syncText: true });
    toast('בוטל');
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(JSON.stringify(state.project));
    state.project = JSON.parse(state.future.pop());
    afterChange({ syncText: true });
  }

  // ------------------------------------------------------------ saving

  function setSaveStatus(text, error) {
    const el = $('saveStatus');
    el.textContent = text;
    el.classList.toggle('error', !!error);
  }
  function scheduleSave() {
    setSaveStatus('שומר…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 450);
  }
  function saveNow() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.storageOk) { setSaveStatus('לא נשמר (אחסון חסום) — ייצאו גיבוי', true); return; }
    try {
      Store.save(state.project);
      setSaveStatus('נשמר ✓');
    } catch (e) {
      setSaveStatus('השמירה נכשלה — ייצאו גיבוי', true);
      toast('לא ניתן לשמור בדפדפן (ייתכן שהאחסון מלא). מומלץ לייצא גיבוי.', 'error');
    }
  }

  // ======================================================== rendering

  function renderAll() {
    renderHeader();
    renderTransport();
    renderPalette();
    renderArrangement();
    renderInspector();
  }

  function renderHeader() {
    if (document.activeElement !== $('projectName')) $('projectName').value = state.project.name;
    $('undoBtn').disabled = !state.history.length;
    $('redoBtn').disabled = !state.future.length;
    document.title = state.project.name + ' · ChordFlow';
  }

  function renderTransport() {
    const p = state.project;
    if (document.activeElement !== $('bpmInput')) $('bpmInput').value = p.bpm;
    const tsVal = p.timeSig.num + '/' + p.timeSig.den;
    const tsSel = $('timeSigSelect');
    if (![...tsSel.options].some((o) => o.value === tsVal)) tsSel.insertAdjacentHTML('beforeend', `<option value="${tsVal}">${tsVal}</option>`);
    tsSel.value = tsVal;
    const tonics = T.KEY_TONICS[p.key.mode].slice();
    if (!tonics.includes(p.key.tonic)) tonics.push(p.key.tonic);
    $('keyTonic').innerHTML = tonics.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    $('keyTonic').value = p.key.tonic;
    $('keyMode').value = p.key.mode;
    $('swingInput').value = p.swing;
    $('swingOut').textContent = Math.round(p.swing) + '%';
    $('loopBtn').setAttribute('aria-pressed', String(p.loop.enabled));
    $('loopRange').classList.toggle('disabled', !p.loop.enabled);
    if (document.activeElement !== $('loopStart')) $('loopStart').value = p.loop.startBar;
    if (document.activeElement !== $('loopEnd')) $('loopEnd').value = p.loop.endBar || '';
    $('metroBtn').setAttribute('aria-pressed', String(!!p.metronome));
    $('lengthDisplay').textContent = fmtTime(state.arr.songEnd * 60 / p.bpm);
  }

  function renderPalette() {
    const p = state.project;
    const sev = $('seventhToggle').checked;
    $('paletteKey').textContent = T.keyLabel(p.key);
    $('paletteChips').innerHTML = T.diatonicChords(p.key, sev).map((c) =>
      `<button class="chip" data-symbol="${esc(c.symbol)}" title="הוספת ${esc(c.symbol)} בסוף הרצף"><span class="chip-sym">${esc(c.symbol)}</span><span class="chip-num">${esc(c.numeral)}</span></button>`
    ).join('');
    let dl = $('chordSuggestions');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'chordSuggestions'; document.body.appendChild(dl); }
    dl.innerHTML = T.diatonicChords(p.key, false).concat(T.diatonicChords(p.key, true)).map((c) => `<option value="${esc(c.symbol)}">`).join('');
  }

  function syncProgressionText(force) {
    if (!force && state.inputDirty) return;
    $('progressionInput').value = P.serializeProgression(state.project.chords, state.project.timeSig);
    state.inputDirty = false;
    validateProgressionInput();
  }

  function validateProgressionInput() {
    const ta = $('progressionInput');
    const fb = $('progressionFeedback');
    const text = ta.value.trim();
    if (!text) {
      ta.classList.remove('invalid');
      fb.className = 'progression-feedback';
      fb.textContent = 'כתבו אקורדים, למשל: Am | F | C | G7';
      return null;
    }
    const res = P.parseProgression(text, state.project.timeSig);
    if (!res.ok) {
      ta.classList.add('invalid');
      fb.className = 'progression-feedback error';
      const e = res.errors[0];
      fb.textContent = `תיבה ${e.bar}: ${e.error}` + (res.errors.length > 1 ? ` (ועוד ${res.errors.length - 1})` : '');
    } else {
      ta.classList.remove('invalid');
      const bars = Math.ceil(res.end / barLen() - EPS);
      fb.className = 'progression-feedback ' + (state.inputDirty ? 'ok' : '');
      fb.textContent = state.inputDirty
        ? `✓ ${res.chords.length} אקורדים · ${bars} תיבות — לחצו "החלה" (Ctrl+Enter)`
        : `${res.chords.length} אקורדים · ${bars} תיבות`;
    }
    return res;
  }

  // ------------------------------------------------------ arrangement

  function canvasWidth() {
    const bl = state.arr.barLen, ppq = state.zoom;
    const contentBars = Math.ceil(Math.max(chordEnd(), state.arr.songEnd) / bl - EPS) + 2;
    const minBars = Math.ceil(($('arrScroll').clientWidth || 800) / (bl * ppq));
    const bars = Math.max(contentBars, minBars, 4);
    return { bars, width: Math.round(bars * bl * ppq) };
  }

  function loopRangeQ() {
    const p = state.project, bl = state.arr.barLen;
    const start = Math.min((p.loop.startBar - 1) * bl, Math.max(0, state.arr.songEnd - bl));
    let end = p.loop.endBar ? p.loop.endBar * bl : state.arr.songEnd;
    if (end <= start) end = start + bl;
    return { start, end };
  }

  function gridHtml(bars) {
    const bl = state.arr.barLen, ppq = state.zoom;
    let g = '';
    for (let b = 0; b < bars; b++) {
      const x = b * bl * ppq;
      g += `<i class="gl bar" style="left:${x}px"></i>`;
      state.arr.offsets.slice(1).forEach((o) => { g += `<i class="gl" style="left:${x + o * ppq}px"></i>`; });
    }
    return `<div class="grid-layer">${g}</div>`;
  }

  function renderArrangement() {
    const p = state.project, ppq = state.zoom, bl = state.arr.barLen;
    const { bars, width } = canvasWidth();
    $('arrCanvas').style.width = width + 'px';
    const grid = gridHtml(bars);
    const L = loopRangeQ();

    // ruler
    let ruler = '';
    for (let b = 0; b < bars; b++) {
      const x = b * bl * ppq;
      ruler += `<i class="rl-tick bar" style="left:${x}px"></i><span class="rl-label${b % 4 === 0 ? ' strong' : ''}" style="left:${x}px">${b + 1}</span>`;
      state.arr.offsets.slice(1).forEach((o) => { ruler += `<i class="rl-tick" style="left:${x + o * ppq}px"></i>`; });
    }
    ruler += `<i class="rl-loop${p.loop.enabled ? '' : ' off'}" style="left:${L.start * ppq}px;width:${(L.end - L.start) * ppq}px"></i>`;
    $('laneRuler').innerHTML = ruler;

    // chords
    let blocks = grid;
    if (p.loop.enabled) blocks += `<div class="loop-shade" style="left:${L.start * ppq}px;width:${(L.end - L.start) * ppq}px"></div>`;
    sortedChords().forEach((c) => {
      const parsed = T.parseChord(c.symbol);
      const cls = ['chord-block'];
      if (c.id === state.selectedId) cls.push('selected');
      if (!parsed.ok) cls.push('invalid');
      if (c.id === state.playingChordId) cls.push('playing');
      blocks += `<div class="${cls.join(' ')}" data-id="${c.id}" style="left:${c.start * ppq + 1}px;width:${Math.max(14, c.length * ppq - 3)}px" title="${esc(c.symbol)}">
        <span class="cb-sym">${esc(c.symbol)}</span><span class="cb-num">${parsed.ok ? esc(T.romanNumeral(parsed, p.key)) : '?'}</span><span class="cb-handle" data-resize="1"></span></div>`;
    });
    if (!p.chords.length) blocks += '<div class="lane-empty">אין עדיין אקורדים. כתבו רצף למעלה, או לחצו כאן פעמיים.</div>';
    $('laneChords').innerHTML = blocks;

    // song dynamics curve
    $('curvePreset').innerHTML = D.CURVE_PRESETS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') +
      '<option value="custom">מותאם אישית</option>';
    $('curvePreset').value = p.dynamics.preset || 'custom';
    $('laneDyn').innerHTML = grid + '<svg id="dynSvg"></svg>';
    drawDynCurve(p.dynamics.points);

    // track headers and lanes
    $('trackHeads').innerHTML = p.tracks.map((tr) => {
      const fam = famOf(tr);
      const pat = CF.Patterns.get(fam.role, tr.pattern);
      return `<div class="th${tr.id === state.trackId ? ' selected' : ''}${tr.mute ? ' muted' : ''}" data-track="${tr.id}" style="--fc:${famCss(fam)}" tabindex="0" role="button" aria-label="${esc(tr.name)}">
        <span class="fam-badge">${famIcon(fam.id)}</span>
        <span class="th-text"><span class="th-name">${esc(tr.name)}</span><span class="th-sub"><span class="mk">${esc(tr.dyn.level)}</span> · ${esc(pat.name)}</span></span>
        <span class="ms"><button class="m" data-ms="mute" aria-pressed="${tr.mute}" title="השתקה">M</button><button class="s" data-ms="solo" aria-pressed="${tr.solo}" title="סולו">S</button></span>
      </div>`;
    }).join('');
    $('laneTracks').innerHTML = p.tracks.map((tr) =>
      `<div class="lane lane-track${tr.id === state.trackId ? ' selected' : ''}" data-track="${tr.id}" style="--fc:${famCss(famOf(tr))}">${grid}</div>`
    ).join('');
    p.tracks.forEach((tr) => drawTrackLane(tr, width));
    updatePlayhead();
  }

  function drawTrackLane(tr, width) {
    const lane = document.querySelector(`.lane-track[data-track="${tr.id}"]`);
    const at = state.arr.tracks.find((a) => a.id === tr.id);
    if (!lane || !at) return;
    const h = lane.clientHeight || 66;
    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 30000 / Math.max(1, width), 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = h + 'px';
    lane.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const ppq = state.zoom;
    const color = cssVar('--f-' + famOf(tr).id, famOf(tr).color);
    const anySolo = state.project.tracks.some((t) => t.solo);
    const silent = tr.mute || (anySolo && !tr.solo);
    // dynamics curve (what CC1/CC11 will carry)
    if (at.curve.length && (tr.dyn.cc1 || tr.dyn.cc11 || tr.dyn.cc2)) {
      ctx.beginPath();
      at.curve.forEach((pt, i) => {
        const x = pt.t * ppq, y = h - 4 - pt.d * (h - 8);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.lineTo(state.arr.songEnd * ppq, h - 4 - at.curve[at.curve.length - 1].d * (h - 8));
      ctx.strokeStyle = color;
      ctx.globalAlpha = silent ? 0.15 : 0.4;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!at.notes.length) return;
    let lo = Infinity, hi = -Infinity;
    at.notes.forEach((n) => { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); });
    lo -= 2; hi += 2;
    const range = Math.max(12, hi - lo);
    const nh = Math.max(2.5, Math.min(5, (h - 12) / range));
    ctx.fillStyle = color;
    at.notes.forEach((n) => {
      const x = n.t * ppq;
      const w = Math.max(2, n.dur * ppq - 1);
      const y = h - 6 - ((n.pitch - lo) / range) * (h - 12 - nh) - nh;
      ctx.globalAlpha = silent ? 0.16 : 0.3 + 0.7 * (n.vel / 127);
      ctx.fillRect(x, y, w, nh);
    });
    ctx.globalAlpha = 1;
  }

  // ---- song curve lane
  const DYN_PAD = 10;
  function dynY(v, h) { return DYN_PAD + (1 - v) * (h - 2 * DYN_PAD); }
  function drawDynCurve(points, activeIdx) {
    const svg = $('dynSvg');
    if (!svg) return;
    const w = $('arrCanvas').clientWidth || 800;
    const h = $('laneDyn').clientHeight || 92;
    const ppq = state.zoom;
    const pts = points.length ? points : [{ t: 0, v: 0.5 }];
    const xy = pts.map((p) => [p.t * ppq, dynY(p.v, h)]);
    const line = [[0, xy[0][1]]].concat(xy, [[w, xy[xy.length - 1][1]]]);
    const d = line.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
    const guides = [0.25, 0.5, 0.75].map((v) => `<line class="dyn-guide" x1="0" x2="${w}" y1="${dynY(v, h)}" y2="${dynY(v, h)}"/>`).join('');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<defs><linearGradient id="dynFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${cssVar('--gold', '#d9b866')}" stop-opacity=".34"/><stop offset="1" stop-color="${cssVar('--gold', '#d9b866')}" stop-opacity="0"/></linearGradient></defs>
      ${guides}<path class="dyn-area" d="${d} L${w} ${h} L0 ${h} Z"/><path class="dyn-line" d="${d}"/>
      ${xy.map((q, i) => `<circle class="dyn-pt${i === activeIdx ? ' active' : ''}" data-i="${i}" cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="6"><title>לחיצה כפולה למחיקה</title></circle>`).join('')}`;
  }

  // ---- playhead
  function setPosition(pos) {
    state.position = pos;
    const bl = state.arr.barLen;
    const bar = Math.floor(pos / bl + EPS);
    const inBar = pos - bar * bl;
    let beat = 0;
    state.arr.offsets.forEach((o, i) => { if (inBar >= o - EPS) beat = i; });
    const d = $('positionDisplay');
    d.querySelector('.pos-bar').textContent = bar + 1;
    d.querySelector('.pos-beat').textContent = beat + 1;
    $('timeDisplay').textContent = fmtTime(pos * 60 / state.project.bpm);
    updatePlayhead();
  }

  function updatePlayhead() {
    const x = state.position * state.zoom;
    $('playhead').style.transform = `translateX(${x}px)`;
    let id = null;
    if (player && player.playing) {
      const c = state.project.chords.find((ch) => state.position >= ch.start - EPS && state.position < ch.start + ch.length - EPS);
      id = c ? c.id : null;
    }
    if (id !== state.playingChordId) {
      const prev = state.playingChordId && document.querySelector(`.chord-block[data-id="${state.playingChordId}"]`);
      if (prev) prev.classList.remove('playing');
      const cur = id && document.querySelector(`.chord-block[data-id="${id}"]`);
      if (cur) cur.classList.add('playing');
      state.playingChordId = id;
    }
    if (player && player.playing) {
      const sc = $('arrScroll');
      if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 60) sc.scrollLeft = Math.max(0, x - 60);
    }
  }

  // ======================================================== inspector

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    renderInspector();
  }

  function renderInspector() {
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    if (state.tab === 'chord') renderChordInspector();
    else if (state.tab === 'dyn') renderDynInspector();
    else renderTrackInspector();
  }

  function insHead(tr, sub) {
    const fam = famOf(tr);
    return `<div class="ins-head" style="--fc:${famCss(fam)}">
      <span class="fam-badge">${famIcon(fam.id)}</span>
      <div class="ins-head-text">
        <label class="sr-only" for="trName">שם הערוץ</label>
        <input class="ins-name" id="trName" type="text" value="${esc(tr.name)}" maxlength="60">
        <span class="ins-sub">${esc(sub)}</span>
      </div>
    </div>`;
  }

  function renderTrackInspector() {
    const tr = currentTrack();
    const body = $('inspectorBody');
    if (!tr) { body.innerHTML = '<p class="empty-note">אין כלים. הוסיפו כלי מהכפתור "הוספת כלי".</p>'; return; }
    const fam = famOf(tr);
    const role = fam.role;
    const pats = CF.Patterns.list(role);
    const cur = CF.Patterns.get(role, tr.pattern);
    const instOptions = CF.Families.list.map((f) =>
      `<optgroup label="${esc(f.name)}">${CF.Instruments.forFamily(f.id).map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</optgroup>`
    ).join('');
    const channels = Array.from({ length: 16 }, (_, i) => `<option value="${i}">${i + 1}${i === 9 ? ' (תופים)' : ''}</option>`).join('');
    body.innerHTML = `
      ${insHead(tr, `${fam.name} · ערוץ MIDI ${tr.channel + 1}`)}
      <div class="group">
        <div class="group-title">צליל</div>
        <label class="field"><span>כלי</span><select id="trInstrument">${instOptions}</select></label>
      </div>
      <div class="group" style="--fc:${famCss(fam)}">
        <div class="group-title">תבנית נגינה <small>${esc(cur.name)}</small></div>
        <div class="pattern-list">${pats.map((pt) => `<button class="pat" data-pattern="${pt.id}" aria-pressed="${pt.id === cur.id}" title="${esc(pt.desc)}"><b>${esc(pt.name)}</b><span>${esc(pt.desc)}</span></button>`).join('')}</div>
      </div>
      <div class="group">
        <div class="group-title">פריסה ומנעד</div>
        ${role !== 'bass' ? `<label class="field"><span>פריסת אקורד (Voicing)</span><select id="trVoicing">${CF.Voicings.available().map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>` : ''}
        <div class="field"><span>אוקטבה <span class="val">${tr.register > 0 ? '+' : ''}${tr.register}</span></span>
          <div class="seg" id="trRegister">${[-2, -1, 0, 1, 2].map((r) => `<button data-reg="${r}" aria-pressed="${r === tr.register}">${r > 0 ? '+' + r : r}</button>`).join('')}</div>
        </div>
      </div>
      <div class="group">
        <div class="group-title">מיקס</div>
        <div class="grid-2">
          <label class="field"><span>עוצמה <output>${Math.round(tr.volume * 100)}</output></span><input type="range" id="trVolume" min="0" max="1" step="0.01" value="${tr.volume}"></label>
          <label class="field"><span>פאן <output>${panLabel(tr.pan)}</output></span><input type="range" id="trPan" min="-1" max="1" step="0.05" value="${tr.pan}"></label>
        </div>
      </div>
      <div class="group">
        <div class="group-title">MIDI</div>
        <div class="grid-2">
          <label class="field"><span>ערוץ</span><select id="trChannel">${channels}</select></label>
          <label class="field"><span>שם הטרק בקובץ</span><input type="text" id="trMidiName" dir="ltr" maxlength="40" value="${esc(tr.midiName)}"></label>
        </div>
      </div>
      <div class="ins-actions">
        <button class="btn small" id="trAudition"><svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>השמעה</button>
        <button class="btn small" id="trDuplicate"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>שכפול</button>
        <button class="btn small danger-ghost" id="trDelete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>הסרה</button>
      </div>`;
    $('trInstrument').value = tr.instrument;
    $('trChannel').value = String(tr.channel);
    if ($('trVoicing')) $('trVoicing').value = tr.voicing || 'smooth';
  }

  function panLabel(v) {
    v = +v;
    if (Math.abs(v) < 0.03) return 'מרכז';
    return (v < 0 ? 'שמאל ' : 'ימין ') + Math.round(Math.abs(v) * 100);
  }

  function renderDynInspector() {
    const tr = currentTrack();
    const body = $('inspectorBody');
    if (!tr) { body.innerHTML = '<p class="empty-note">אין כלים.</p>'; return; }
    const dyn = tr.dyn;
    const lvl = D.LEVELS.find((l) => l.id === dyn.level) || D.LEVELS[3];
    const shape = D.SHAPES.find((s) => s.id === dyn.shape) || D.SHAPES[0];
    const ccRow = (cc, title, sub) => `<label class="cc"><span class="cc-tag">CC${cc}</span><span class="cc-text">${title}<small>${sub}</small></span>
      <span class="switch"><input type="checkbox" data-cc="${cc}" ${dyn['cc' + cc] ? 'checked' : ''} aria-label="CC${cc}"></span></label>`;
    body.innerHTML = `
      ${insHead(tr, `דינמיקה ואקספרשן · ${instOf(tr).name}`)}
      <div class="group">
        <div class="group-title">רמת עוצמה <small>${esc(lvl.name)} · ${esc(lvl.he)}</small></div>
        <div class="seg dyn" id="dynLevel">${D.LEVELS.map((l) => `<button data-level="${l.id}" aria-pressed="${l.id === dyn.level}" title="${esc(l.he)}">${l.id}</button>`).join('')}</div>
      </div>
      <div class="group">
        <div class="group-title">כמה מרגש <small><output id="dynEmotionOut">${dyn.emotion}</output></small></div>
        <input type="range" id="dynEmotion" min="0" max="100" step="1" value="${dyn.emotion}" aria-label="רגש">
        <div class="emotion-scale"><span>מאופק ויציב</span><span>דרמטי ונושם</span></div>
      </div>
      <div class="group">
        <div class="group-title">צורת התנועה</div>
        <div class="shape-list">${D.SHAPES.map((s) => `<button class="shape" data-shape="${s.id}" aria-pressed="${s.id === dyn.shape}" title="${esc(s.desc)}"><svg viewBox="0 0 60 24" preserveAspectRatio="none"><path d="${SHAPE_ICONS[s.id]}"/></svg>${esc(s.name)}</button>`).join('')}</div>
        <p class="hint">${esc(shape.desc)}. עקומת השיר בציר הזמן משפיעה על כל הכלים.</p>
      </div>
      <div class="group">
        <div class="group-title">Velocity <small>עוצמת התקפה של כל תו</small></div>
        <div class="grid-2">
          <label class="field"><span>מינימום <output id="velMinOut">${dyn.velMin}</output></span><input type="range" id="dynVelMin" min="1" max="127" value="${dyn.velMin}"></label>
          <label class="field"><span>מקסימום <output id="velMaxOut">${dyn.velMax}</output></span><input type="range" id="dynVelMax" min="1" max="127" value="${dyn.velMax}"></label>
        </div>
        <div class="vel-range" aria-hidden="true"><i id="velBar" style="left:${dyn.velMin / 127 * 100}%;right:${100 - dyn.velMax / 127 * 100}%"></i></div>
        <div class="grid-2">
          <label class="field"><span>הדגשות מטריות <output>${dyn.accent}</output></span><input type="range" id="dynAccent" min="0" max="100" value="${dyn.accent}"></label>
          <label class="field"><span>הומניזציה <output>${dyn.humanize}</output></span><input type="range" id="dynHumanize" min="0" max="100" value="${dyn.humanize}"></label>
        </div>
      </div>
      <div class="group">
        <div class="group-title">בקרי MIDI <small>נכתבים לקובץ</small></div>
        <div class="cc-list">
          ${ccRow(1, 'Modulation — דינמיקה', 'שכבות pp–ff בספריות קשת ונשיפה')}
          ${ccRow(11, 'Expression — עוצמה', 'נשימה וקרשנדו בתוך התו')}
          ${ccRow(2, 'Breath — נשיפה', 'לספריות נשיפה שקוראות CC2')}
        </div>
        <label class="field"><span>רזולוציית בקרים</span>
          <select id="dynRes"><option value="0.5">שמינית</option><option value="0.25">שש-עשרית</option><option value="0.125">שלושים-ושתיים</option></select></label>
      </div>
      <figure class="dyn-preview" style="margin:0">
        <canvas id="dynCanvas"></canvas>
        <figcaption id="dynCaption"></figcaption>
      </figure>
      <div class="ins-actions">
        <button class="btn small" id="dynCopyAll"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>העתקה לכל הכלים</button>
      </div>`;
    $('dynRes').value = String(dyn.ccRes);
    drawDynPreview(tr);
  }

  /** Mini chart of what will be written to MIDI for this track: curve (CC) + velocity dots. */
  function drawDynPreview(tr) {
    const canvas = $('dynCanvas');
    const at = state.arr.tracks.find((a) => a.id === tr.id);
    if (!canvas || !at) return;
    const w = canvas.clientWidth || 320, h = 96;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const end = state.arr.songEnd || 1;
    const X = (t) => 6 + (t / end) * (w - 12);
    const Y = (v) => h - 8 - v * (h - 16);
    ctx.strokeStyle = cssVar('--rule-soft', 'rgba(120,170,140,0.14)');
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach((v) => { ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(w, Y(v)); ctx.stroke(); });
    const color = cssVar('--f-' + famOf(tr).id, famOf(tr).color);
    // velocity dots
    ctx.fillStyle = color;
    at.notes.forEach((n) => { ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(X(n.t), Y(n.vel / 127), 2, 0, Math.PI * 2); ctx.fill(); });
    ctx.globalAlpha = 1;
    // curve
    ctx.beginPath();
    at.curve.forEach((p, i) => { const x = X(p.t), y = Y(p.d); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = cssVar('--gold-2', '#f0d899');
    ctx.lineWidth = 2;
    ctx.stroke();
    const vels = at.notes.map((n) => n.vel);
    const ccCount = at.cc.length;
    const ccs = [1, 11, 2].filter((c) => tr.dyn['cc' + c]).map((c) => 'CC' + c).join(' + ');
    $('dynCaption').textContent = at.notes.length
      ? `${at.notes.length} תווים · Velocity ${Math.min(...vels)}–${Math.max(...vels)}` + (ccs ? ` · ${ccs}: ${ccCount} נקודות` : ' · ללא בקרים')
      : 'אין תווים בערוץ הזה';
  }

  function renderChordInspector() {
    const body = $('inspectorBody');
    const c = state.project.chords.find((x) => x.id === state.selectedId);
    const p = state.project;
    if (!c) {
      const secs = state.arr.songEnd * 60 / p.bpm;
      body.innerHTML = `
        <div class="stats">
          <div class="stat"><b>${p.chords.length}</b><span>אקורדים</span></div>
          <div class="stat"><b>${Math.round(state.arr.songEnd / state.arr.barLen)}</b><span>תיבות</span></div>
          <div class="stat"><b>${fmtTime(secs)}</b><span>משך</span></div>
        </div>
        <p class="empty-note">בחרו אקורד בציר הזמן כדי לשנות אותו, להזיז, לקבוע אורך והיפוך, לשכפל או למחוק.</p>`;
      return;
    }
    const parsed = T.parseChord(c.symbol);
    const bl = barLen(), unit = beatUnit();
    const bar = Math.floor(c.start / bl + EPS);
    const beat = round((c.start - bar * bl) / unit + 1, 3);
    const unitName = p.timeSig.den === 8 ? 'שמיניות' : p.timeSig.den === 2 ? 'חצאים' : 'רבעים';
    const coreLen = parsed.ok ? parsed.core.length : 3;
    const invNames = ['מצב יסודי', 'היפוך ראשון', 'היפוך שני', 'היפוך שלישי'];
    let inv = '<option value="auto">אוטומטי</option>';
    for (let i = 0; i < Math.min(4, coreLen); i++) {
      const n = parsed.ok ? T.noteName(parsed.root + parsed.core[i], p.key) : '';
      inv += `<option value="${i}">${invNames[i]}${n ? ' (' + n + ' בבס)' : ''}</option>`;
    }
    const sounding = soundingAt(c.start);
    const tones = sounding.map(({ track, notes }) => notes.map((n) => `<span class="tone${roleOf(track) === 'bass' ? ' bass' : ''}" title="${esc(track.name)}">${noteLabel(n)}</span>`).join('')).join('');
    const slashLocked = parsed.ok && parsed.bass != null && CF.Voicing.resolveInversion(parsed, 'auto') == null;
    body.innerHTML = `
      <div class="chord-big">
        <label class="sr-only" for="inspSymbol">סימול האקורד</label>
        <input type="text" id="inspSymbol" value="${esc(c.symbol)}" list="chordSuggestions" autocomplete="off" spellcheck="false">
        <span class="rn" title="תפקיד בסולם">${parsed.ok ? esc(T.romanNumeral(parsed, p.key)) : '?'}</span>
      </div>
      <div class="err" id="inspErr">${parsed.ok ? '' : esc(parsed.error)}</div>
      <div class="group">
        <div class="group-title">מיקום ואורך</div>
        <div class="grid-2">
          <label class="field"><span>תיבה</span><input type="number" id="inspBar" min="1" step="1" value="${bar + 1}"></label>
          <label class="field"><span>פעמה</span><input type="number" id="inspBeat" min="1" step="0.5" value="${beat}"></label>
          <label class="field"><span>אורך (${unitName})</span><input type="number" id="inspLen" min="0.25" step="0.5" value="${round(c.length / unit, 3)}"></label>
          <label class="field"><span>היפוך</span><select id="inspInv" ${slashLocked ? 'disabled' : ''}>${inv}</select></label>
        </div>
        ${parsed.ok && parsed.bass != null ? `<p class="hint">אקורד עם בס (/${esc(parsed.bassName)}): הבס מנגן ${esc(parsed.bassName)}.</p>` : ''}
      </div>
      <div class="group">
        <div class="group-title">מה נשמע ברגע הזה</div>
        <div class="tones">${tones || '<span class="tone">—</span>'}</div>
      </div>
      <div class="ins-actions">
        <button class="btn small" data-act="audition"><svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>השמעה</button>
        <button class="btn small" data-act="loop"><svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>לולאה כאן</button>
        <button class="btn small" data-act="earlier" title="הזזה מוקדם יותר"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>מוקדם</button>
        <button class="btn small" data-act="later" title="הזזה מאוחר יותר">מאוחר<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        <button class="btn small" data-act="duplicate"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>שכפול</button>
        <button class="btn small danger-ghost" data-act="delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>מחיקה</button>
      </div>`;
    $('inspInv').value = String(c.inversion == null ? 'auto' : c.inversion);
  }

  // ===================================================== chord editing

  /** Notes of every audible track that sound at time t (used for audition and the inspector). */
  function soundingAt(t) {
    const anySolo = state.project.tracks.some((x) => x.solo);
    return state.arr.tracks
      .filter((at) => !at.track.mute && !(anySolo && !at.track.solo))
      .map((at) => ({ track: at.track, notes: [...new Set(at.notes.filter((n) => n.t <= t + 0.01 && n.t + n.dur > t + 0.01).map((n) => n.pitch))].sort((a, b) => a - b) }))
      .filter((x) => x.notes.length);
  }

  function selectChord(id, opts) {
    state.selectedId = id;
    document.querySelectorAll('.chord-block').forEach((b) => b.classList.toggle('selected', b.dataset.id === id));
    if (id) state.tab = 'chord';
    renderInspector();
    if (id && opts && opts.audition) auditionChord(id);
    if (id && opts && opts.scroll) {
      const el = document.querySelector(`.chord-block[data-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function selectTrack(id) {
    state.trackId = id;
    if (state.tab === 'chord') state.tab = 'track';
    document.querySelectorAll('.th, .lane-track').forEach((el) => el.classList.toggle('selected', el.dataset.track === id));
    renderInspector();
  }

  function auditionChord(id) {
    const c = state.project.chords.find((x) => x.id === id);
    if (!c || (player && player.playing)) return;
    try { player.audition(soundingAt(c.start), state.project); } catch (e) { /* audio unavailable */ }
  }

  function neighbors(id) {
    const list = sortedChords();
    const i = list.findIndex((c) => c.id === id);
    return { list, i, prev: list[i - 1] || null, next: list[i + 1] || null, chord: list[i] };
  }

  function appendChords(chords) {
    const bl = barLen();
    const startAt = Math.ceil(chordEnd() / bl - EPS) * bl;
    return chords.map((c) => Object.assign({}, c, { id: P.uid('c'), start: round(c.start + startAt, 6) }));
  }

  function addChordAt(t, symbol) {
    const bl = barLen();
    const list = sortedChords();
    if (list.find((c) => t >= c.start - EPS && t < c.start + c.length - EPS)) return;
    const next = list.find((c) => c.start > t + EPS);
    let len = bl - ((t % bl) + bl) % bl;
    if (len < EPS) len = bl;
    if (next) len = Math.min(len, next.start - t);
    if (len < 0.24) { toast('אין מקום לאקורד כאן', 'error'); return; }
    const id = P.uid('c');
    commit((p) => { p.chords.push({ id, symbol, start: round(t, 6), length: round(len, 6), inversion: 'auto' }); });
    selectChord(id, { audition: true });
    setTimeout(() => { const s = $('inspSymbol'); if (s) { s.focus(); s.select(); } }, 30);
  }

  function deleteChord(id) {
    const { next, prev } = neighbors(id);
    commit((p) => { p.chords = p.chords.filter((c) => c.id !== id); });
    selectChord(next ? next.id : prev ? prev.id : null);
  }

  function duplicateChord(id) {
    const c = state.project.chords.find((x) => x.id === id);
    if (!c) return;
    const nid = P.uid('c');
    const at = c.start + c.length;
    commit((p) => {
      p.chords.forEach((x) => { if (x.start >= at - EPS) x.start = round(x.start + c.length, 6); });
      p.chords.push({ id: nid, symbol: c.symbol, start: round(at, 6), length: c.length, inversion: c.inversion });
    });
    selectChord(nid, { scroll: true });
  }

  function moveChord(id, delta) {
    const { prev, next, chord } = neighbors(id);
    if (!chord) return;
    const min = prev ? prev.start + prev.length : 0;
    const max = next ? next.start - chord.length : Infinity;
    const ns = Math.max(min, Math.min(max, chord.start + delta));
    if (Math.abs(ns - chord.start) < EPS) { toast('אין מקום להזיז — קצרו או הזיזו את האקורד השכן', 'error'); return; }
    commit((p) => { p.chords.find((x) => x.id === id).start = round(ns, 6); });
  }

  /** Changes a chord's length and shifts every later chord by the same amount (ripple). */
  function setChordLength(id, newLen, ripple) {
    newLen = Math.max(0.25, newLen);
    commit((p) => {
      const c = p.chords.find((x) => x.id === id);
      const end = c.start + c.length;
      const delta = newLen - c.length;
      if (ripple !== false) {
        p.chords.forEach((x) => { if (x.id !== id && x.start >= end - EPS) x.start = round(Math.max(0, x.start + delta), 6); });
      } else {
        const next = p.chords.filter((x) => x.start > c.start + EPS).sort((a, b) => a.start - b.start)[0];
        if (next) newLen = Math.min(newLen, next.start - c.start);
      }
      c.length = round(newLen, 6);
    });
  }

  function startBlockDrag(e, block) {
    if (e.button !== undefined && e.button !== 0) return;
    const id = block.dataset.id;
    const resize = !!e.target.closest('[data-resize]');
    const { prev, next, chord, list, i } = neighbors(id);
    if (!chord) return;
    e.preventDefault();
    const ppq = state.zoom;
    const x0 = e.clientX;
    const orig = { start: chord.start, length: chord.length };
    const later = list.slice(i + 1).map((c) => ({ c, el: document.querySelector(`.chord-block[data-id="${c.id}"]`) }));
    let moved = false, ns = orig.start, nl = orig.length;
    const ripple = !e.altKey;
    try { block.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) { moved = true; block.classList.add('dragging'); }
      const dq = dx / ppq;
      if (resize) {
        nl = Math.max(snapStep(), snapRound(orig.start + orig.length + dq) - orig.start, 0.25);
        if (!ripple && next) nl = Math.min(nl, next.start - orig.start);
        block.style.width = Math.max(14, nl * ppq - 3) + 'px';
        const delta = nl - orig.length;
        if (ripple) later.forEach(({ c, el }) => { if (el) el.style.left = ((c.start + delta) * ppq + 1) + 'px'; });
      } else {
        const min = prev ? prev.start + prev.length : 0;
        const max = next ? next.start - orig.length : Infinity;
        ns = Math.max(min, Math.min(max, snapRound(orig.start + dq)));
        if (max < min) ns = orig.start;
        block.style.left = (ns * ppq + 1) + 'px';
      }
    };
    const onUp = () => {
      block.removeEventListener('pointermove', onMove);
      block.removeEventListener('pointerup', onUp);
      block.removeEventListener('pointercancel', onUp);
      block.classList.remove('dragging');
      if (!moved) { selectChord(id, { audition: true }); return; }
      state.selectedId = id;
      if (resize) {
        if (Math.abs(nl - orig.length) > EPS) setChordLength(id, nl, ripple); else renderArrangement();
      } else if (Math.abs(ns - orig.start) > EPS) {
        commit((p) => { p.chords.find((x) => x.id === id).start = round(ns, 6); });
      } else renderArrangement();
    };
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
    block.addEventListener('pointercancel', onUp);
  }

  const timeFromEvent = (e) => Math.max(0, (e.clientX - $('arrCanvas').getBoundingClientRect().left) / state.zoom);

  // ---- song curve editing
  function startCurveEdit(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const svg = $('dynSvg');
    if (!svg) return;
    e.preventDefault();
    const h = $('laneDyn').clientHeight || 92;
    const rect = svg.getBoundingClientRect();
    const pts = state.project.dynamics.points.map((p) => ({ t: p.t, v: p.v }));
    const vFromY = (y) => clamp(1 - (y - rect.top - DYN_PAD) / (h - 2 * DYN_PAD), 0, 1);
    let idx;
    const hit = e.target.closest('.dyn-pt');
    if (hit) idx = +hit.dataset.i;
    else {
      const t = clamp(snapRound(timeFromEvent(e)), 0, state.arr.songEnd);
      pts.push({ t, v: round(vFromY(e.clientY), 3) });
      pts.sort((a, b) => a.t - b.t);
      idx = pts.findIndex((p) => p.t === t);
    }
    drawDynCurve(pts, idx);
    const target = $('laneDyn');
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const onMove = (ev) => {
      const prevT = idx > 0 ? pts[idx - 1].t : 0;
      const nextT = idx < pts.length - 1 ? pts[idx + 1].t : state.arr.songEnd;
      pts[idx].t = round(clamp(snapRound(timeFromEvent(ev)), prevT, nextT), 4);
      pts[idx].v = round(vFromY(ev.clientY), 3);
      drawDynCurve(pts, idx);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      commit((p) => { p.dynamics = { preset: 'custom', points: pts }; });
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  // ============================================================ actions

  function applyProgression(append) {
    const res = validateProgressionInput();
    if (!res || !res.chords.length) { toast('אין אקורדים להחלה', 'error'); return; }
    if (!res.ok) { toast('יש אקורד שלא זוהה — תקנו את המסומן באדום', 'error'); $('progressionInput').focus(); return; }
    state.inputDirty = false;
    commit((p) => {
      if (append) p.chords = p.chords.concat(appendChords(res.chords));
      else p.chords = res.chords;
    }, { syncText: true });
    syncProgressionText(true);
    toast(append ? `נוספו ${res.chords.length} אקורדים` : `הרצף עודכן: ${res.chords.length} אקורדים`);
  }

  function transpose(semis) {
    const p = state.project;
    const newPc = (T.parseNote(p.key.tonic).pc + semis + 12) % 12;
    const newKey = { tonic: T.KEY_TONICS[p.key.mode].find((n) => T.parseNote(n).pc === newPc), mode: p.key.mode };
    commit((pr) => {
      pr.key = newKey;
      pr.chords.forEach((c) => { c.symbol = T.transposeSymbol(c.symbol, semis, newKey); });
    }, { syncText: true });
    toast(`הועבר ל-${T.keyLabel(newKey)}`);
  }

  function changeTimeSig(value) {
    const [num, den] = value.split('/').map(Number);
    const scale = ((num * 4) / den) / barLen();
    commit((p) => {
      p.timeSig = { num, den };
      if (Math.abs(scale - 1) > EPS) {
        p.chords.forEach((c) => { c.start = round(c.start * scale, 6); c.length = round(c.length * scale, 6); });
        p.dynamics.points.forEach((pt) => { pt.t = round(pt.t * scale, 4); });
      }
    }, { syncText: true });
  }

  let taps = [];
  function tapTempo() {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 2500);
    taps.push(now);
    $('tapBtn').classList.add('flash');
    setTimeout(() => $('tapBtn').classList.remove('flash'), 90);
    if (taps.length >= 2) {
      const ints = [];
      for (let i = 1; i < taps.length; i++) ints.push(taps[i] - taps[i - 1]);
      const recent = ints.slice(-4);
      const bpm = Math.round(60000 / (recent.reduce((a, x) => a + x, 0) / recent.length));
      if (bpm >= 20 && bpm <= 300) commit((p) => { p.bpm = bpm; });
    }
  }

  function togglePlay() {
    if (!player.supported) { toast('הדפדפן הזה לא תומך בהשמעת אודיו', 'error'); return; }
    if (player.playing) player.pause();
    else {
      if (!state.project.chords.length) { toast('הוסיפו אקורדים כדי לשמוע', 'error'); return; }
      try { player.play(state.position); } catch (e) { toast('לא ניתן להפעיל אודיו: ' + e.message, 'error'); }
    }
  }

  // ---- tracks
  function updateTrack(id, fn) {
    commit((p) => { const t = p.tracks.find((x) => x.id === id); if (t) fn(t, p); });
  }

  function addTrack(instId) {
    if (state.project.tracks.length >= 16) { toast('אפשר עד 16 כלים בפרויקט', 'error'); return; }
    const t = P.makeTrack(instId, state.project.tracks);
    commit((p) => { p.tracks.push(t); });
    state.trackId = t.id;
    state.tab = 'track';
    renderInspector();
    toast(`נוסף: ${t.name}`);
  }

  function changeInstrument(tr, instId) {
    const inst = CF.Instruments.get(instId);
    if (!inst) return;
    const oldInst = instOf(tr);
    updateTrack(tr.id, (t) => {
      const famChanged = inst.family !== t.family;
      if (t.name === oldInst.name) t.name = inst.name;
      if (t.midiName === oldInst.en) t.midiName = inst.en;
      t.instrument = inst.id;
      if (famChanged) {
        const d = CF.Families.get(inst.family).defaults;
        t.family = inst.family;
        t.pattern = d.pattern;
        t.voicing = d.voicing;
        t.dyn = Object.assign({}, d.dyn);
        t.register = 0;
      }
    });
  }

  async function deleteTrack(id) {
    const tr = trackById(id);
    if (!tr) return;
    if (state.project.tracks.length <= 1) { toast('צריך לפחות כלי אחד', 'error'); return; }
    const ok = await confirmDialog(`להסיר את "${tr.name}"? אפשר לבטל עם Ctrl+Z.`, 'הסרה');
    if (!ok) return;
    commit((p) => { p.tracks = p.tracks.filter((t) => t.id !== id); });
    toast('הכלי הוסר');
  }

  function duplicateTrack(id) {
    const tr = trackById(id);
    if (!tr || state.project.tracks.length >= 16) return;
    const copy = JSON.parse(JSON.stringify(tr));
    copy.id = P.uid('t');
    copy.name = tr.name + ' 2';
    copy.channel = P.freeChannel(state.project.tracks);
    copy.solo = false;
    commit((p) => { p.tracks.splice(p.tracks.findIndex((t) => t.id === id) + 1, 0, copy); });
    state.trackId = copy.id;
    renderAll();
  }

  async function applyEnsemble(id) {
    const ens = P.ENSEMBLES.find((e) => e.id === id);
    if (!ens) return;
    const ok = await confirmDialog(`להחליף את הכלים בהרכב "${ens.name}"? האקורדים נשארים, ואפשר לבטל עם Ctrl+Z.`, 'החלפה');
    if (!ok) return;
    const tracks = P.ensembleTracks(id);
    commit((p) => { p.tracks = tracks; });
    state.trackId = tracks[0].id;
    state.tab = 'track';
    renderInspector();
    toast(`הרכב: ${ens.name}`);
  }

  function renderAddMenu() {
    $('addTrackMenu').innerHTML = CF.Families.list.map((f) => `
      <div class="menu-fam" style="--fc:${famCss(f)}">
        <h4>${famIcon(f.id)}${esc(f.name)}</h4>
        ${CF.Instruments.forFamily(f.id).map((i) => `<button data-inst="${i.id}">${esc(i.name)}</button>`).join('')}
      </div>`).join('');
  }
  function toggleAddMenu(open) {
    const m = $('addTrackMenu');
    const show = open != null ? open : m.hidden;
    m.hidden = !show;
    $('addTrackBtn').setAttribute('aria-expanded', String(show));
  }

  // ------------------------------------------------------------ projects

  function newProject() {
    saveNow();
    const n = Store.list().length + 1;
    const p = P.create({ name: 'פרויקט ' + n });
    p.key = Object.assign({}, state.project.key);
    p.chords = P.parseProgression(T.templateText(T.TEMPLATES[0], p.key), p.timeSig).chords;
    p.tracks = JSON.parse(JSON.stringify(state.project.tracks)).map((t) => Object.assign(t, { id: P.uid('t'), mute: false, solo: false }));
    setProject(p);
    toast('נוצר פרויקט חדש (עם אותם כלים)');
  }

  function renderProjectList() {
    const list = Store.list();
    $('storageNote').textContent = state.storageOk
      ? 'הפרויקטים נשמרים אוטומטית בדפדפן הזה. מומלץ לייצא גיבוי מדי פעם.'
      : 'האחסון בדפדפן חסום (למשל בגלישה פרטית). השתמשו בייצוא ובייבוא גיבוי.';
    const ul = $('projectList');
    if (!list.length) { ul.innerHTML = '<li class="project-empty">אין עדיין פרויקטים שמורים.</li>'; return; }
    ul.innerHTML = list.map((p) => {
      const date = new Date(p.updatedAt);
      const when = isNaN(date) ? '' : date.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
      const chords = (p.chords || []).slice(0, 12).map((c) => c.symbol).join('  ');
      const fams = (p.tracks || []).map((t) => { const f = CF.Families.get(t.family) || (t.role === 'bass' || t.id === 'bass' ? CF.Families.get('bass') : CF.Families.get('keys')); return `<i style="--fc:${famCss(f)}" title="${esc(t.name || '')}"></i>`; }).join('');
      return `<li class="project-item${p.id === state.project.id ? ' current' : ''}" data-id="${esc(p.id)}">
        <div class="pi-main" data-act="open" role="button" tabindex="0">
          <div class="pi-name">${esc(p.name)}</div>
          <div class="pi-meta">${esc(when)} · ${(p.chords || []).length} אקורדים · ${esc(p.bpm)} BPM · ${p.key ? esc(T.keyLabel(p.key)) : ''}</div>
          <div class="pi-chords">${esc(chords)}</div>
          <div class="pi-fams">${fams}</div>
        </div>
        <div class="pi-actions">
          <button class="btn small primary" data-act="open">פתיחה</button>
          <button class="btn small" data-act="dup">שכפול</button>
          <button class="btn small" data-act="backup">גיבוי</button>
          <button class="btn small danger-ghost" data-act="delete" aria-label="מחיקת ${esc(p.name)}"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
        </div>
      </li>`;
    }).join('');
  }

  async function projectAction(act, id) {
    if (act === 'open') {
      if (id !== state.project.id) {
        saveNow();
        const p = Store.get(id);
        if (!p) { toast('לא ניתן לפתוח את הפרויקט', 'error'); return; }
        setProject(p);
        toast(`נפתח: ${p.name}`);
      }
      closeModal('projectsModal');
    } else if (act === 'dup') {
      saveNow();
      const p = Store.get(id);
      if (!p) return;
      const now = new Date().toISOString();
      const copy = P.normalize(Object.assign({}, p, { id: P.uid('p'), name: p.name + ' (עותק)', createdAt: now, updatedAt: now }));
      try { Store.save(copy); Store.save(state.project); } catch (e) { toast('השמירה נכשלה', 'error'); return; }
      renderProjectList();
      toast('הפרויקט שוכפל');
    } else if (act === 'backup') {
      saveNow();
      const p = Store.get(id);
      if (p) download(JSON.stringify(P.backupOf([p]), null, 2), safeFileBase(p.name) + '.chordflow.json', 'application/json');
    } else if (act === 'delete') {
      const p = Store.get(id);
      if (!p) return;
      const ok = await confirmDialog(`למחוק את "${p.name}"? לא ניתן לשחזר (אלא מגיבוי).`, 'מחיקה');
      if (ok) {
        Store.remove(id);
        if (id === state.project.id) {
          const rest = Store.list();
          setProject(rest.length ? Store.get(rest[0].id) : P.create({ name: 'פרויקט חדש' }));
        }
        toast('הפרויקט נמחק');
      }
      renderProjectList();
      openModal('projectsModal');
    }
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const projects = P.readBackup(String(reader.result));
        if (!projects.length) throw new Error('אין פרויקטים בקובץ');
        const existing = new Set(Store.list().map((p) => p.id));
        projects.forEach((p) => {
          if (existing.has(p.id)) { p.id = P.uid('p'); p.name += ' (מיובא)'; }
          if (state.storageOk) Store.save(p);
        });
        setProject(projects[0]);
        closeModal('projectsModal');
        toast(projects.length === 1 ? `יובא: ${projects[0].name}` : `יובאו ${projects.length} פרויקטים`);
      } catch (e) {
        toast('הייבוא נכשל: ' + e.message, 'error');
      }
    };
    reader.onerror = () => toast('לא ניתן לקרוא את הקובץ', 'error');
    reader.readAsText(file);
  }

  // ------------------------------------------------------------- export

  function openExport() {
    const p = state.project;
    if (!p.chords.length) { toast('אין אקורדים לייצוא', 'error'); return; }
    $('exportName').value = CF.Midi.fileName(p).replace(/\.mid$/, '');
    $('exportTracks').innerHTML = state.arr.tracks.map((at) => {
      const tr = at.track;
      const fam = famOf(tr);
      const vels = at.notes.map((n) => n.vel);
      const ccs = [1, 11, 2].filter((c) => tr.dyn['cc' + c]).map((c) => `<span class="cc-badge">CC${c}</span>`).join('') || '<span class="mono">—</span>';
      return `<tr>
        <td><label class="switch"><input type="checkbox" data-track="${tr.id}" ${tr.mute ? '' : 'checked'} aria-label="${esc(tr.name)}"></label></td>
        <td class="mono">${tr.channel + 1}</td>
        <td><span class="et-name" style="--fc:${famCss(fam)}"><i></i>${esc(tr.name)} <span class="mono">${esc(tr.midiName)}</span></span></td>
        <td><span class="mono">${vels.length ? Math.min(...vels) + '–' + Math.max(...vels) : '—'}</span></td>
        <td>${ccs}</td>
        <td class="mono">${at.notes.length}</td>
      </tr>`;
    }).join('');
    const secs = state.arr.songEnd * 60 / p.bpm;
    const chans = p.tracks.map((t) => t.channel);
    const dup = chans.length !== new Set(chans).size;
    $('exportSummary').innerHTML = `${p.chords.length} אקורדים · ${Math.round(state.arr.songEnd / state.arr.barLen)} תיבות · ${p.bpm} BPM · ${p.timeSig.num}/${p.timeSig.den} · ${esc(T.keyLabel(p.key))} · ${fmtTime(secs)}` +
      (dup ? '<br><b style="color:var(--danger)">שימו לב: יש כלים שחולקים ערוץ MIDI. אפשר לשנות בלשונית "כלי".</b>' : '');
    openModal('exportModal');
  }

  function doExport() {
    const ids = [...document.querySelectorAll('#exportTracks input[data-track]')].filter((i) => i.checked).map((i) => i.dataset.track);
    if (!ids.length) { toast('בחרו לפחות ערוץ אחד', 'error'); return; }
    const bytes = CF.Midi.build(state.project, state.arr, { trackIds: ids, markers: $('exportMarkers').checked, cc: $('exportCC').checked });
    const name = safeFileBase($('exportName').value) + '.mid';
    download(new Blob([bytes], { type: 'audio/midi' }), name);
    closeModal('exportModal');
    toast(`הקובץ ${name} ירד ✓`, 'gold');
  }

  // ============================================================ events

  function bind() {
    // header
    $('projectName').addEventListener('change', (e) => { const v = e.target.value.trim() || 'ללא שם'; commit((p) => { p.name = v.slice(0, 120); }); });
    $('projectName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('projectsBtn').addEventListener('click', () => { saveNow(); renderProjectList(); openModal('projectsModal'); });
    $('newBtn').addEventListener('click', newProject);
    $('modalNewBtn').addEventListener('click', () => { newProject(); closeModal('projectsModal'); });
    $('helpBtn').addEventListener('click', () => openModal('helpModal'));
    renderSkinMenu();
    $('skinBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleSkinMenu(); });
    $('skinMenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-skin]');
      if (!b) return;
      applySkin(b.dataset.skin, true);
      toggleSkinMenu(false);
      toast('ערכת צבע: ' + SKINS.find((x) => x.id === b.dataset.skin).name);
    });
    document.addEventListener('click', (e) => { if (!$('skinMenu').hidden && !e.target.closest('.skin-wrap')) toggleSkinMenu(false); });
    $('syntaxHelpBtn').addEventListener('click', () => openModal('helpModal'));
    $('exportBtn').addEventListener('click', openExport);
    $('exportConfirm').addEventListener('click', doExport);
    $('exportName').addEventListener('keydown', (e) => { if (e.key === 'Enter') doExport(); });

    document.querySelectorAll('.modal').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) {
          if (m.id === 'confirmModal') $('confirmNo').click(); else closeModal(m.id);
        }
      });
    });
    $('projectList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const li = e.target.closest('.project-item');
      if (btn && li) projectAction(btn.dataset.act, li.dataset.id);
    });
    $('projectList').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.pi-main')) projectAction('open', e.target.closest('.project-item').dataset.id);
    });
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
    $('backupAllBtn').addEventListener('click', () => {
      saveNow();
      const all = Store.list().map((p) => { try { return P.normalize(p); } catch (err) { return null; } }).filter(Boolean);
      if (!all.length) all.push(state.project);
      download(JSON.stringify(P.backupOf(all), null, 2), `ChordFlow-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      toast(`גובו ${all.length} פרויקטים`);
    });

    // transport
    $('playBtn').addEventListener('click', togglePlay);
    $('stopBtn').addEventListener('click', () => player.stop());
    $('loopBtn').addEventListener('click', () => commit((p) => { p.loop.enabled = !p.loop.enabled; }));
    $('metroBtn').addEventListener('click', () => commit((p) => { p.metronome = !p.metronome; }));
    $('loopStart').addEventListener('change', (e) => {
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      commit((p) => { p.loop.startBar = v; if (p.loop.endBar && p.loop.endBar < v) p.loop.endBar = v; p.loop.enabled = true; });
    });
    $('loopEnd').addEventListener('change', (e) => {
      const raw = e.target.value.trim();
      const v = raw ? Math.max(1, parseInt(raw, 10) || 1) : null;
      commit((p) => { p.loop.endBar = v; if (v && v < p.loop.startBar) p.loop.startBar = v; p.loop.enabled = true; });
    });
    $('bpmInput').addEventListener('change', (e) => {
      const v = Math.round(clamp(parseFloat(e.target.value) || state.project.bpm, 20, 300));
      e.target.value = v;
      commit((p) => { p.bpm = v; });
    });
    ['bpmInput', 'loopStart', 'loopEnd'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); }));
    $('tapBtn').addEventListener('click', tapTempo);
    $('timeSigSelect').addEventListener('change', (e) => changeTimeSig(e.target.value));
    $('keyTonic').addEventListener('change', (e) => commit((p) => { p.key.tonic = e.target.value; }));
    $('keyMode').addEventListener('change', (e) => commit((p) => {
      p.key.mode = e.target.value;
      const pc = T.parseNote(p.key.tonic).pc;
      p.key.tonic = T.KEY_TONICS[p.key.mode].find((n) => T.parseNote(n).pc === pc);
    }));
    $('transposeDown').addEventListener('click', () => transpose(-1));
    $('transposeUp').addEventListener('click', () => transpose(1));
    $('swingInput').addEventListener('input', (e) => { $('swingOut').textContent = e.target.value + '%'; });
    $('swingInput').addEventListener('change', (e) => commit((p) => { p.swing = +e.target.value; }));

    // composer
    const ta = $('progressionInput');
    ta.addEventListener('input', () => { state.inputDirty = true; validateProgressionInput(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyProgression(false); } });
    $('applyBtn').addEventListener('click', () => applyProgression(false));
    $('appendBtn').addEventListener('click', () => applyProgression(true));
    $('templateSelect').innerHTML = '<option value="">התחלה מהירה…</option>' + T.TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('templateSelect').addEventListener('change', (e) => {
      const tpl = T.TEMPLATES.find((t) => t.id === e.target.value);
      e.target.value = '';
      if (!tpl) return;
      ta.value = T.templateText(tpl, state.project.key);
      state.inputDirty = true;
      applyProgression(false);
    });
    $('seventhToggle').addEventListener('change', renderPalette);
    $('paletteChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const bl = barLen();
      const start = Math.ceil(chordEnd() / bl - EPS) * bl;
      const id = P.uid('c');
      commit((p) => { p.chords.push({ id, symbol: chip.dataset.symbol, start, length: bl, inversion: 'auto' }); }, { syncText: true });
      selectChord(id, { audition: true, scroll: true });
    });

    // arrangement toolbar
    $('ensembleSelect').innerHTML = '<option value="">בחירת הרכב…</option>' + P.ENSEMBLES.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    $('ensembleSelect').addEventListener('change', (e) => { const id = e.target.value; e.target.value = ''; if (id) applyEnsemble(id); });
    renderAddMenu();
    $('addTrackBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleAddMenu(); });
    $('addTrackMenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-inst]');
      if (!b) return;
      toggleAddMenu(false);
      addTrack(b.dataset.inst);
    });
    document.addEventListener('click', (e) => { if (!$('addTrackMenu').hidden && !e.target.closest('.menu-wrap')) toggleAddMenu(false); });
    $('snapSelect').addEventListener('change', (e) => { state.snap = e.target.value; });
    $('zoomIn').addEventListener('click', () => { state.zoom = Math.min(120, Math.round(state.zoom * 1.25)); renderArrangement(); });
    $('zoomOut').addEventListener('click', () => { state.zoom = Math.max(10, Math.round(state.zoom / 1.25)); renderArrangement(); });
    $('curvePreset').addEventListener('change', (e) => {
      const id = e.target.value;
      if (id === 'custom') return;
      commit((p) => { p.dynamics = { preset: id, points: D.presetPoints(id, state.arr.songEnd, barLen()) }; });
    });

    // lanes
    $('laneRuler').addEventListener('pointerdown', (e) => {
      const t = Math.floor(timeFromEvent(e) / snapStep() + EPS) * snapStep();
      player.seek(t);
      setPosition(t);
    });
    const lane = $('laneChords');
    lane.addEventListener('pointerdown', (e) => {
      const block = e.target.closest('.chord-block');
      if (block) startBlockDrag(e, block);
      else if (state.selectedId) { state.selectedId = null; document.querySelectorAll('.chord-block.selected').forEach((b) => b.classList.remove('selected')); renderInspector(); }
    });
    lane.addEventListener('dblclick', (e) => {
      const block = e.target.closest('.chord-block');
      if (block) {
        selectChord(block.dataset.id);
        const s = $('inspSymbol');
        if (s) { s.focus(); s.select(); }
        return;
      }
      const t = Math.floor(timeFromEvent(e) / snapStep() + EPS) * snapStep();
      const last = sortedChords().filter((c) => c.start < t).pop();
      addChordAt(t, last ? last.symbol : T.diatonicChords(state.project.key, false)[0].symbol);
    });
    $('laneDyn').addEventListener('pointerdown', startCurveEdit);
    $('laneDyn').addEventListener('dblclick', (e) => {
      const pt = e.target.closest('.dyn-pt');
      if (!pt) return;
      const i = +pt.dataset.i;
      if (state.project.dynamics.points.length <= 1) return;
      commit((p) => { p.dynamics = { preset: 'custom', points: p.dynamics.points.filter((_, k) => k !== i) }; });
    });
    $('laneTracks').addEventListener('click', (e) => { const l = e.target.closest('.lane-track'); if (l) selectTrack(l.dataset.track); });
    $('trackHeads').addEventListener('click', (e) => {
      const th = e.target.closest('.th');
      if (!th) return;
      const ms = e.target.closest('[data-ms]');
      if (ms) { updateTrack(th.dataset.track, (t) => { t[ms.dataset.ms] = !t[ms.dataset.ms]; }); return; }
      selectTrack(th.dataset.track);
    });
    $('trackHeads').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.th')) { e.preventDefault(); selectTrack(e.target.dataset.track); } });

    // inspector tabs
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

    // inspector content (delegated)
    const ib = $('inspectorBody');
    ib.addEventListener('input', (e) => {
      const el = e.target;
      if (el.id === 'inspSymbol') {
        const r = T.parseChord(el.value);
        el.classList.toggle('invalid', !r.ok);
        $('inspErr').textContent = r.ok ? '' : r.error;
        return;
      }
      if (el.type === 'range') {
        const out = el.closest('.field, .group') && el.closest('.field, .group').querySelector('output');
        if (out) out.textContent = el.id === 'trVolume' ? Math.round(el.value * 100) : el.id === 'trPan' ? panLabel(el.value) : el.value;
        if (el.id === 'dynVelMin' || el.id === 'dynVelMax') {
          const lo = +$('dynVelMin').value, hi = +$('dynVelMax').value;
          $('velBar').style.left = (Math.min(lo, hi) / 127 * 100) + '%';
          $('velBar').style.right = (100 - Math.max(lo, hi) / 127 * 100) + '%';
        }
        const tr = currentTrack();
        if (tr && (el.id === 'trVolume' || el.id === 'trPan')) {
          // live mix preview; committed on change
          if (state.volStart == null) state.volStart = { volume: tr.volume, pan: tr.pan };
          if (el.id === 'trVolume') tr.volume = +el.value; else tr.pan = +el.value;
          player.updateMix();
        }
      }
    });
    ib.addEventListener('keydown', (e) => { if ((e.target.id === 'inspSymbol' || e.target.id === 'trName' || e.target.id === 'trMidiName') && e.key === 'Enter') e.target.blur(); });
    ib.addEventListener('change', (e) => {
      const el = e.target;
      const tr = currentTrack();
      const chord = state.project.chords.find((x) => x.id === state.selectedId);
      switch (el.id) {
        case 'trName': updateTrack(tr.id, (t) => { t.name = el.value.trim().slice(0, 60) || instOf(t).name; }); return;
        case 'trMidiName': updateTrack(tr.id, (t) => { t.midiName = el.value.trim().slice(0, 40) || instOf(t).en; }); return;
        case 'trInstrument': changeInstrument(tr, el.value); return;
        case 'trVoicing': updateTrack(tr.id, (t) => { t.voicing = el.value; }); return;
        case 'trChannel': updateTrack(tr.id, (t) => { t.channel = +el.value; }); return;
        case 'trVolume': case 'trPan': {
          const start = state.volStart || { volume: tr.volume, pan: tr.pan };
          state.volStart = null;
          const val = +el.value;
          const key = el.id === 'trVolume' ? 'volume' : 'pan';
          tr[key] = start[key];
          updateTrack(tr.id, (t) => { t[key] = val; });
          return;
        }
        case 'dynEmotion': updateTrack(tr.id, (t) => { t.dyn.emotion = +el.value; }); return;
        case 'dynVelMin': case 'dynVelMax': {
          const lo = +$('dynVelMin').value, hi = +$('dynVelMax').value;
          updateTrack(tr.id, (t) => { t.dyn.velMin = Math.min(lo, hi); t.dyn.velMax = Math.max(lo, hi); });
          return;
        }
        case 'dynAccent': updateTrack(tr.id, (t) => { t.dyn.accent = +el.value; }); return;
        case 'dynHumanize': updateTrack(tr.id, (t) => { t.dyn.humanize = +el.value; }); return;
        case 'dynRes': updateTrack(tr.id, (t) => { t.dyn.ccRes = +el.value; }); return;
        default: break;
      }
      if (el.dataset.cc) { updateTrack(tr.id, (t) => { t.dyn['cc' + el.dataset.cc] = el.checked; }); return; }
      if (!chord) return;
      const id = chord.id, bl = barLen(), unit = beatUnit();
      if (el.id === 'inspSymbol') {
        const r = T.parseChord(el.value);
        if (!r.ok) { toast(r.error, 'error'); return; }
        commit((p) => { const x = p.chords.find((y) => y.id === id); x.symbol = r.symbol; if (r.bass != null) x.inversion = 'auto'; });
        auditionChord(id);
      } else if (el.id === 'inspBar' || el.id === 'inspBeat') {
        const bar = Math.max(1, parseInt($('inspBar').value, 10) || 1);
        const beat = Math.max(1, parseFloat($('inspBeat').value) || 1);
        commit((p) => { p.chords.find((y) => y.id === id).start = round(Math.max(0, (bar - 1) * bl + (beat - 1) * unit), 6); });
      } else if (el.id === 'inspLen') {
        const v = parseFloat(el.value);
        if (v > 0) setChordLength(id, v * unit, true); else renderInspector();
      } else if (el.id === 'inspInv') {
        commit((p) => { p.chords.find((y) => y.id === id).inversion = el.value; });
        auditionChord(id);
      }
    });
    ib.addEventListener('click', (e) => {
      const tr = currentTrack();
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.pattern) { updateTrack(tr.id, (t) => { t.pattern = b.dataset.pattern; }); return; }
      if (b.dataset.reg != null && b.closest('#trRegister')) { updateTrack(tr.id, (t) => { t.register = +b.dataset.reg; }); return; }
      if (b.dataset.level) { updateTrack(tr.id, (t) => { t.dyn.level = b.dataset.level; }); return; }
      if (b.dataset.shape) { updateTrack(tr.id, (t) => { t.dyn.shape = b.dataset.shape; }); return; }
      if (b.id === 'trDelete') { deleteTrack(tr.id); return; }
      if (b.id === 'trDuplicate') { duplicateTrack(tr.id); return; }
      if (b.id === 'trAudition') {
        const c = state.project.chords.find((x) => x.id === state.selectedId) || sortedChords()[0];
        if (c && !player.playing) {
          const parts = soundingAt(c.start).filter((x) => x.track.id === tr.id);
          const solo = parts.length ? parts : [{ track: tr, notes: (state.arr.tracks.find((a) => a.id === tr.id) || { notes: [] }).notes.filter((n) => n.t <= c.start + 0.01 && n.t + n.dur > c.start).map((n) => n.pitch) }];
          try { player.audition(solo.map((x) => ({ track: Object.assign({}, x.track, { mute: false, solo: false }), notes: x.notes })), Object.assign({}, state.project, { tracks: [Object.assign({}, tr, { mute: false, solo: false })] })); } catch (err) { /* ignore */ }
        }
        return;
      }
      if (b.id === 'dynCopyAll') {
        const src = JSON.parse(JSON.stringify(tr.dyn));
        commit((p) => { p.tracks.forEach((t) => { if (t.id !== tr.id) Object.assign(t.dyn, { level: src.level, shape: src.shape, emotion: src.emotion, accent: src.accent, humanize: src.humanize }); }); });
        toast('הרמה, הצורה והרגש הועתקו לכל הכלים');
        return;
      }
      const act = b.dataset.act;
      const c = state.project.chords.find((x) => x.id === state.selectedId);
      if (!act || !c) return;
      if (act === 'audition') auditionChord(c.id);
      else if (act === 'delete') deleteChord(c.id);
      else if (act === 'duplicate') duplicateChord(c.id);
      else if (act === 'earlier') moveChord(c.id, -snapStep());
      else if (act === 'later') moveChord(c.id, snapStep());
      else if (act === 'loop') {
        const bl = barLen();
        const s = Math.floor(c.start / bl + EPS) + 1;
        const en = Math.max(s, Math.ceil((c.start + c.length) / bl - EPS));
        commit((p) => { p.loop = { enabled: true, startBar: s, endBar: en }; });
        if (!player.playing) togglePlay();
      }
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      const modal = openModalId();
      if (e.key === 'Escape') {
        if (modal) { if (modal === 'confirmModal') $('confirmNo').click(); else closeModal(modal); return; }
        if (!$('addTrackMenu').hidden) { toggleAddMenu(false); return; }
        if (!$('skinMenu').hidden) { toggleSkinMenu(false); return; }
      }
      if (modal) return;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'l' || e.key === 'L' || e.key === 'ך') { commit((p) => { p.loop.enabled = !p.loop.enabled; }); return; }
      const c = state.project.chords.find((x) => x.id === state.selectedId);
      if ((e.key === 'Delete' || e.key === 'Backspace') && c) { e.preventDefault(); deleteChord(c.id); return; }
      if (mod && e.key.toLowerCase() === 'd' && c) { e.preventDefault(); duplicateChord(c.id); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const list = sortedChords();
        if (!list.length) return;
        e.preventDefault();
        let i = c ? list.findIndex((x) => x.id === c.id) : -1;
        i = e.key === 'ArrowRight' ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
        selectChord(list[i].id, { audition: true, scroll: true });
      }
    });

    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderArrangement(); if (state.tab === 'dyn') drawDynPreview(currentTrack()); }, 120); });
    window.addEventListener('beforeunload', () => { if (state.saveTimer) saveNow(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.saveTimer) saveNow(); });
  }

  // ============================================================== init

  function init() {
    state.storageOk = Store.available();
    player = new CF.Player({
      getProject: () => state.project,
      getArrangement: () => state.arr,
      onPosition: (pos) => setPosition(pos),
      onState: (playing) => {
        $('playBtn').classList.toggle('playing', playing);
        $('playBtn').setAttribute('aria-label', playing ? 'השהיה' : 'נגן');
        if (!playing) updatePlayhead();
      },
    });
    bind();

    let p = null;
    if (state.storageOk) {
      const last = Store.lastId();
      p = last && Store.get(last);
      if (!p) { const list = Store.list(); if (list.length) p = Store.get(list[0].id); }
    }
    if (!p) p = P.create({ name: 'השיר הראשון שלי', progression: 'Am | F | C | G | Dm7 | E7sus4 E7 | Am', ensemble: 'ballad' });
    setProject(p);
    if (!state.storageOk) toast('האחסון בדפדפן חסום — הפרויקט לא יישמר אוטומטית. השתמשו בגיבוי.', 'error');

    window.ChordFlowApp = { state, player, commit, setProject, recompute, applySkin };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
