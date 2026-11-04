/*
 * ChordFlow — application controller (UI, editing, persistence, export).
 */
(function () {
  'use strict';
  const CF = window.CF;
  const T = CF.Theory, P = CF.Project, Store = CF.Store;
  const $ = (id) => document.getElementById(id);
  const EPS = 1e-6;

  const state = {
    project: null,
    arr: null,
    selectedId: null,
    zoom: 34,          // pixels per quarter note
    snap: 'beat',
    position: 0,
    history: [],
    future: [],
    inputDirty: false,
    saveTimer: null,
    storageOk: true,
    playingChordId: null,
    volStart: {},
  };
  let player;

  // ================================================================ utils

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round = (n, d = 4) => +(+n).toFixed(d);
  const barLen = () => T.barLength(state.project.timeSig);
  const beatUnit = () => 4 / state.project.timeSig.den;
  const sortedChords = () => state.project.chords.slice().sort((a, b) => a.start - b.start);
  const chordEnd = () => state.project.chords.reduce((m, c) => Math.max(m, c.start + c.length), 0);

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
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
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

  function safeFileBase(name) {
    return String(name || 'ChordFlow').replace(/[\\/:*?"<>|]+/g, '').trim() || 'ChordFlow';
  }

  function noteLabel(p) {
    return T.noteName(p % 12, state.project.key) + (Math.floor(p / 12) - 1);
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ---------------------------------------------------------- modals
  let lastFocus = null;
  function openModal(id) {
    lastFocus = document.activeElement;
    const m = $(id);
    m.hidden = false;
    const f = m.querySelector('input, button:not([data-close]), select');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal(id) {
    $(id).hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function openModalId() {
    const m = document.querySelector('.modal:not([hidden])');
    return m ? m.id : null;
  }

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

  function recompute() {
    state.arr = CF.Arranger.arrange(state.project);
  }

  function setProject(p) {
    if (player && player.playing) player.halt();
    state.project = p;
    state.history = [];
    state.future = [];
    state.selectedId = null;
    state.position = 0;
    state.inputDirty = false;
    if (player) player.position = 0;
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
    if (state.selectedId && !p.chords.some((c) => c.id === state.selectedId)) state.selectedId = null;
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
    renderTimeline();
    renderInspector();
    renderTracks();
  }

  function renderHeader() {
    const name = $('projectName');
    if (document.activeElement !== name) name.value = state.project.name;
    $('undoBtn').disabled = !state.history.length;
    $('redoBtn').disabled = !state.future.length;
    document.title = state.project.name + ' · ChordFlow';
  }

  function renderTransport() {
    const p = state.project;
    if (document.activeElement !== $('bpmInput')) $('bpmInput').value = p.bpm;
    $('timeSigSelect').value = p.timeSig.num + '/' + p.timeSig.den;
    if (![...$('timeSigSelect').options].some((o) => o.value === $('timeSigSelect').value)) {
      const o = document.createElement('option');
      o.value = o.textContent = p.timeSig.num + '/' + p.timeSig.den;
      $('timeSigSelect').appendChild(o);
      $('timeSigSelect').value = o.value;
    }
    const tonics = T.KEY_TONICS[p.key.mode];
    const ks = $('keyTonic');
    ks.innerHTML = tonics.map((t) => `<option value="${t}">${t}</option>`).join('');
    if (!tonics.includes(p.key.tonic)) {
      ks.insertAdjacentHTML('beforeend', `<option value="${esc(p.key.tonic)}">${esc(p.key.tonic)}</option>`);
    }
    ks.value = p.key.tonic;
    $('keyMode').value = p.key.mode;
    $('swingInput').value = p.swing;
    $('swingOut').textContent = Math.round(p.swing) + '%';
    $('loopBtn').setAttribute('aria-pressed', String(p.loop.enabled));
    $('loopRange').classList.toggle('disabled', !p.loop.enabled);
    if (document.activeElement !== $('loopStart')) $('loopStart').value = p.loop.startBar;
    if (document.activeElement !== $('loopEnd')) $('loopEnd').value = p.loop.endBar || '';
    $('metroBtn').setAttribute('aria-pressed', String(!!p.metronome));
    $('humanBtn').setAttribute('aria-pressed', String(!!p.humanize));
  }

  function renderPalette() {
    const p = state.project;
    const sev = $('seventhToggle').checked;
    $('paletteKey').textContent = T.keyLabel(p.key);
    $('paletteChips').innerHTML = T.diatonicChords(p.key, sev).map((c) =>
      `<button class="chip" data-symbol="${esc(c.symbol)}" title="הוספת ${esc(c.symbol)} בסוף הרצף"><span class="chip-sym">${esc(c.symbol)}</span><span class="chip-num">${esc(c.numeral)}</span></button>`
    ).join('');
    const dl = document.getElementById('chordSuggestions') || document.body.appendChild(Object.assign(document.createElement('datalist'), { id: 'chordSuggestions' }));
    dl.innerHTML = T.diatonicChords(p.key, false).concat(T.diatonicChords(p.key, true)).map((c) => `<option value="${esc(c.symbol)}">`).join('');
  }

  function syncProgressionText(force) {
    const ta = $('progressionInput');
    if (!force && state.inputDirty) return;
    ta.value = P.serializeProgression(state.project.chords, state.project.timeSig);
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
      fb.innerHTML = `תיבה ${e.bar}: ${esc(e.error)}` + (res.errors.length > 1 ? ` (ועוד ${res.errors.length - 1})` : '');
    } else {
      ta.classList.remove('invalid');
      fb.className = 'progression-feedback ' + (state.inputDirty ? 'ok' : '');
      const bars = Math.ceil(res.end / barLen() - EPS);
      fb.textContent = state.inputDirty
        ? `✓ ${res.chords.length} אקורדים · ${bars} תיבות — לחצו "החלה" (Ctrl+Enter)`
        : `${res.chords.length} אקורדים · ${bars} תיבות`;
    }
    return res;
  }

  // --------------------------------------------------------- timeline

  function renderTimeline() {
    const p = state.project, arr = state.arr, ppq = state.zoom, bl = arr.barLen;
    const scroll = $('timelineScroll');
    const contentBars = Math.ceil(Math.max(chordEnd(), arr.songEnd) / bl - EPS) + 2;
    const minBars = Math.ceil((scroll.clientWidth || 800) / (bl * ppq));
    const bars = Math.max(contentBars, minBars, 4);
    const width = Math.round(bars * bl * ppq);
    const tl = $('timeline');
    tl.style.width = width + 'px';

    // ruler + grid
    let ruler = '', grid = '';
    const offs = arr.offsets;
    for (let b = 0; b < bars; b++) {
      const x = b * bl * ppq;
      ruler += `<div class="tl-tick bar" style="left:${x}px"></div><div class="tl-bar-label${b % 4 === 0 ? ' strong' : ''}" style="left:${x}px">${b + 1}</div>`;
      grid += `<div class="tl-gridline bar" style="left:${x}px"></div>`;
      offs.slice(1).forEach((o) => {
        const bx = x + o * ppq;
        ruler += `<div class="tl-tick" style="left:${bx}px"></div>`;
        grid += `<div class="tl-gridline" style="left:${bx}px"></div>`;
      });
    }
    const L = loopRangeQ();
    ruler += `<div class="tl-loop${p.loop.enabled ? '' : ' off'}" style="left:${L.start * ppq}px;width:${(L.end - L.start) * ppq}px"></div>`;
    $('tlRuler').innerHTML = ruler;

    // chord blocks
    const key = p.key;
    let blocks = `<div class="tl-grid">${grid}</div>`;
    if (p.loop.enabled) blocks += `<div class="tl-loop-shade" style="left:${L.start * ppq}px;width:${(L.end - L.start) * ppq}px"></div>`;
    sortedChords().forEach((c) => {
      const parsed = T.parseChord(c.symbol);
      const rn = parsed.ok ? T.romanNumeral(parsed, key) : '?';
      const cls = ['chord-block'];
      if (c.id === state.selectedId) cls.push('selected');
      if (!parsed.ok) cls.push('invalid');
      if (c.id === state.playingChordId) cls.push('playing');
      const w = Math.max(14, c.length * ppq - 3);
      blocks += `<div class="${cls.join(' ')}" data-id="${c.id}" style="left:${c.start * ppq + 1}px;width:${w}px" title="${esc(c.symbol)}">
        <span class="cb-sym">${esc(c.symbol)}</span><span class="cb-num">${esc(rn)}</span><span class="cb-handle" data-resize="1"></span></div>`;
    });
    if (!p.chords.length) blocks += `<div class="tl-empty">אין עדיין אקורדים. כתבו רצף למעלה, או לחצו פעמיים כאן.</div>`;
    $('tlChords').innerHTML = blocks;

    // notes
    const notesLane = $('tlNotes');
    notesLane.innerHTML = `<div class="tl-grid">${grid}</div><div class="lane-labels"><span class="lane-label piano">${esc(trackById('piano').name)}</span><span class="lane-label bass">${esc(trackById('bass').name)}</span></div>`;
    const canvas = document.createElement('canvas');
    const h = notesLane.clientHeight || 150;
    const dpr = Math.min(window.devicePixelRatio || 1, 30000 / Math.max(1, width), 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = h + 'px';
    notesLane.appendChild(canvas);
    drawNotes(canvas.getContext('2d'), dpr, h);

    updatePlayhead();
  }

  function drawNotes(ctx, dpr, h) {
    ctx.scale(dpr, dpr);
    const ppq = state.zoom;
    const regions = { piano: [6, h * 0.58 - 4], bass: [h * 0.58 + 14, h - 6] };
    const anySolo = state.project.tracks.some((t) => t.solo);
    state.arr.tracks.forEach((at) => {
      const [top, bottom] = regions[at.track.role] || regions.piano;
      if (!at.notes.length) return;
      let lo = Infinity, hi = -Infinity;
      at.notes.forEach((n) => { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); });
      lo -= 2; hi += 2;
      const range = Math.max(12, hi - lo);
      const nh = Math.max(2.5, Math.min(6, (bottom - top) / range));
      const silent = at.track.mute || (anySolo && !at.track.solo);
      const color = at.track.role === 'bass' ? [95, 185, 149] : [212, 180, 106];
      at.notes.forEach((n) => {
        const x = n.t * ppq;
        const w = Math.max(2, n.dur * ppq - 1);
        const y = bottom - ((n.pitch - lo) / range) * (bottom - top - nh) - nh;
        const a = silent ? 0.18 : 0.35 + 0.65 * (n.vel / 127);
        ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${a})`;
        ctx.fillRect(x, y, w, nh);
      });
    });
  }

  function loopRangeQ() {
    const p = state.project, bl = state.arr.barLen;
    const start = Math.min((p.loop.startBar - 1) * bl, Math.max(0, state.arr.songEnd - bl));
    let end = p.loop.endBar ? p.loop.endBar * bl : state.arr.songEnd;
    if (end <= start) end = start + bl;
    return { start, end };
  }

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
    updatePlayhead();
  }

  function updatePlayhead() {
    const x = state.position * state.zoom;
    const ph = $('tlPlayhead');
    ph.style.transform = `translateX(${x}px)`;
    // highlight sounding chord
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
      const sc = $('timelineScroll');
      if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 60) sc.scrollLeft = Math.max(0, x - 60);
    }
  }

  // -------------------------------------------------------- inspector

  function selectedChord() {
    return state.project.chords.find((c) => c.id === state.selectedId) || null;
  }

  function renderInspector() {
    const body = $('inspectorBody');
    const c = selectedChord();
    const p = state.project;
    if (!c) {
      const secs = state.arr.songEnd * 60 / p.bpm;
      body.innerHTML = `<div class="insp-empty">
        <div class="stats">
          <div class="stat"><b>${p.chords.length}</b><span>אקורדים</span></div>
          <div class="stat"><b>${Math.round(state.arr.songEnd / state.arr.barLen)}</b><span>תיבות</span></div>
          <div class="stat"><b>${fmtTime(secs)}</b><span>משך</span></div>
        </div>
        <p>בחרו אקורד בציר הזמן כדי לשנות אותו, להזיז, לקבוע אורך והיפוך, או לשכפל ולמחוק.</p>
      </div>`;
      return;
    }
    const parsed = T.parseChord(c.symbol);
    const bl = barLen(), unit = beatUnit();
    const bar = Math.floor(c.start / bl + EPS);
    const beat = round((c.start - bar * bl) / unit + 1, 3);
    const lenBeats = round(c.length / unit, 3);
    const unitName = p.timeSig.den === 8 ? 'שמיניות' : p.timeSig.den === 2 ? 'חצאים' : 'רבעים';
    const coreLen = parsed.ok ? parsed.core.length : 3;
    const invNames = ['מצב יסודי', 'היפוך ראשון', 'היפוך שני', 'היפוך שלישי'];
    let invOptions = `<option value="auto">אוטומטי</option>`;
    for (let i = 0; i < Math.min(4, coreLen); i++) {
      const pcName = parsed.ok ? T.noteName(parsed.root + parsed.core[i], p.key) : '';
      invOptions += `<option value="${i}">${invNames[i]}${pcName ? ' (' + pcName + ' בבס)' : ''}</option>`;
    }
    const voiced = state.arr.voicings[c.id] || [];
    const bassPitch = parsed.ok ? CF.Voicing.bassPitchFor(CF.Voicing.bassPc(parsed, c.inversion), trackById('bass').octave) : null;
    const tones = (bassPitch != null ? `<span class="tone bass" title="בס">${noteLabel(bassPitch)}</span>` : '') +
      voiced.map((n) => `<span class="tone">${noteLabel(n)}</span>`).join('');
    const slashNote = parsed.ok && parsed.bass != null ? `<div class="hint">אקורד עם בס (/${esc(parsed.bassName)}): הבס מנגן ${esc(parsed.bassName)}.</div>` : '';

    body.innerHTML = `
      <div class="insp-head">
        <label class="insp-symbol"><span class="sr-only">סימול האקורד</span>
          <input type="text" id="inspSymbol" value="${esc(c.symbol)}" list="chordSuggestions" autocomplete="off" spellcheck="false" dir="ltr"></label>
        <div class="insp-num" title="תפקיד בסולם">${parsed.ok ? esc(T.romanNumeral(parsed, p.key)) : '?'}</div>
      </div>
      <div class="insp-err" id="inspErr">${parsed.ok ? '' : esc(parsed.error)}</div>
      <div class="insp-grid">
        <label class="field"><span>תיבה</span><input type="number" id="inspBar" min="1" step="1" value="${bar + 1}"></label>
        <label class="field"><span>פעמה</span><input type="number" id="inspBeat" min="1" step="0.5" value="${beat}"></label>
        <label class="field"><span>אורך (${unitName})</span><input type="number" id="inspLen" min="0.25" step="0.5" value="${lenBeats}"></label>
        <label class="field"><span>היפוך</span><select id="inspInv" ${parsed.ok && parsed.bass != null && CF.Voicing.resolveInversion(parsed, 'auto') == null ? 'disabled' : ''}>${invOptions}</select></label>
      </div>
      ${slashNote}
      <div class="tones" aria-label="צלילים">${tones}</div>
      <div class="insp-actions">
        <button class="btn small" data-act="audition"><svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>השמעה</button>
        <button class="btn small" data-act="loop"><svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>לולאה כאן</button>
        <button class="btn small" data-act="earlier" title="הזזה מוקדם יותר"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>מוקדם</button>
        <button class="btn small" data-act="later" title="הזזה מאוחר יותר">מאוחר<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        <button class="btn small" data-act="duplicate"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>שכפול</button>
        <button class="btn small" data-act="delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>מחיקה</button>
      </div>`;
    $('inspInv').value = String(c.inversion == null ? 'auto' : c.inversion);
  }

  // ----------------------------------------------------------- tracks

  function trackById(id) {
    return state.project.tracks.find((t) => t.id === id);
  }

  function renderTracks() {
    const p = state.project;
    const html = p.tracks.map((tr) => {
      const patterns = CF.Patterns.list(tr.role);
      const pat = CF.Patterns.get(tr.role, tr.pattern);
      const insts = CF.Instruments.forRole(tr.role);
      const octs = tr.role === 'bass' ? [0, 1, 2, 3] : [2, 3, 4, 5, 6];
      const octLabel = (o) => tr.role === 'bass' ? ['נמוך מאוד', 'נמוך (רגיל)', 'בינוני', 'גבוה'][o] : `${o} ${o === 4 ? '(אמצע)' : ''}`;
      return `<div class="track ${tr.role}${tr.mute ? ' muted' : ''}" data-track="${tr.id}">
        <div class="track-head">
          <h3><span class="dot"></span>${esc(tr.name)} <span class="ch">ערוץ MIDI ${tr.channel + 1}</span></h3>
          <div class="ms">
            <button class="m" data-ms="mute" aria-pressed="${tr.mute}" title="השתקה">M</button>
            <button class="s" data-ms="solo" aria-pressed="${tr.solo}" title="סולו">S</button>
          </div>
        </div>
        <div class="track-grid">
          <label class="field full"><span>תבנית נגינה</span>
            <select data-k="pattern">${patterns.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
            <span class="pattern-desc">${esc(pat.desc || '')}</span>
          </label>
          <label class="field"><span>צליל</span>
            <select data-k="instrument">${insts.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
          ${tr.role === 'piano' ? `<label class="field"><span>פריסה (Voicing)</span>
            <select data-k="voicing">${CF.Voicings.available().map((v) => `<option value="${v.id}" title="${esc(v.desc)}">${esc(v.name)}</option>`).join('')}</select></label>` : ''}
          <label class="field"><span>אוקטבה</span>
            <select data-k="octave">${octs.map((o) => `<option value="${o}">${octLabel(o)}</option>`).join('')}</select></label>
          <label class="field"><span>עוצמה <output>${Math.round(tr.volume * 100)}</output></span>
            <input type="range" data-k="volume" min="0" max="1" step="0.01" value="${tr.volume}"></label>
          <label class="field"><span>דינמיקה (Velocity) <output>${tr.velocity}</output></span>
            <input type="range" data-k="velocity" min="20" max="127" step="1" value="${tr.velocity}"></label>
        </div>
      </div>`;
    }).join('');
    $('tracksBody').innerHTML = html;
    p.tracks.forEach((tr) => {
      const el = document.querySelector(`.track[data-track="${tr.id}"]`);
      el.querySelector('[data-k="pattern"]').value = tr.pattern;
      el.querySelector('[data-k="instrument"]').value = tr.instrument;
      el.querySelector('[data-k="octave"]').value = String(tr.octave);
      const v = el.querySelector('[data-k="voicing"]');
      if (v) v.value = tr.voicing;
    });
  }

  // ===================================================== chord editing

  function selectChord(id, opts) {
    state.selectedId = id;
    document.querySelectorAll('.chord-block').forEach((b) => b.classList.toggle('selected', b.dataset.id === id));
    renderInspector();
    if (id && opts && opts.audition) auditionChord(id);
    if (id && opts && opts.scroll) {
      const el = document.querySelector(`.chord-block[data-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function auditionChord(id) {
    const c = state.project.chords.find((x) => x.id === id);
    if (!c) return;
    const parsed = T.parseChord(c.symbol);
    if (!parsed.ok || (player && player.playing)) return;
    try {
      const notes = state.arr.voicings[id] || CF.Voicing.voicePiano(parsed, { voicing: trackById('piano').voicing, octave: trackById('piano').octave, inversion: c.inversion });
      const bass = CF.Voicing.bassPitchFor(CF.Voicing.bassPc(parsed, c.inversion), trackById('bass').octave);
      player.audition(notes, bass, state.project);
    } catch (e) { /* audio not available */ }
  }

  function neighbors(id) {
    const list = sortedChords();
    const i = list.findIndex((c) => c.id === id);
    return { list, i, prev: list[i - 1] || null, next: list[i + 1] || null, chord: list[i] };
  }

  /** Appends chords at the end of the song (next bar line). */
  function appendChords(chords) {
    const bl = barLen();
    const startAt = Math.ceil(chordEnd() / bl - EPS) * bl;
    return chords.map((c) => Object.assign({}, c, { id: P.uid('c'), start: round(c.start + startAt, 6) }));
  }

  function addChordAt(t, symbol) {
    const bl = barLen();
    const list = sortedChords();
    const inside = list.find((c) => t >= c.start - EPS && t < c.start + c.length - EPS);
    if (inside) return;
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

  // ------------------------------------------------------------ drag

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
        nl = Math.max(snapStep(), snapRound(orig.start + orig.length + dq) - orig.start);
        if (nl < 0.25) nl = 0.25;
        if (!ripple && next) nl = Math.min(nl, next.start - orig.start);
        block.style.width = Math.max(14, nl * ppq - 3) + 'px';
        const delta = nl - orig.length;
        if (ripple) later.forEach(({ c, el }) => { if (el) el.style.left = ((c.start + delta) * ppq + 1) + 'px'; });
      } else {
        const min = prev ? prev.start + prev.length : 0;
        const max = next ? next.start - orig.length : Infinity;
        ns = snapRound(orig.start + dq);
        ns = Math.max(min, Math.min(max, ns));
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
        if (Math.abs(nl - orig.length) > EPS) setChordLength(id, nl, ripple);
        else renderTimeline();
      } else if (Math.abs(ns - orig.start) > EPS) {
        commit((p) => { p.chords.find((x) => x.id === id).start = round(ns, 6); });
      } else renderTimeline();
    };
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
    block.addEventListener('pointercancel', onUp);
  }

  function timeFromEvent(e) {
    const rect = $('timeline').getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left) / state.zoom);
  }

  // ============================================================ actions

  function applyProgression(append) {
    const res = validateProgressionInput();
    if (!res) { toast('אין אקורדים להחלה', 'error'); return; }
    if (!res.ok) { toast('יש אקורד שלא זוהה — תקנו את המסומן באדום', 'error'); $('progressionInput').focus(); return; }
    if (!res.chords.length) { toast('אין אקורדים להחלה', 'error'); return; }
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
    const tonic = T.parseNote(p.key.tonic);
    const newPc = (tonic.pc + semis + 12) % 12;
    const tonicNames = T.KEY_TONICS[p.key.mode];
    const newTonic = tonicNames.find((n) => T.parseNote(n).pc === newPc);
    const newKey = { tonic: newTonic, mode: p.key.mode };
    commit((pr) => {
      pr.key = newKey;
      pr.chords.forEach((c) => { c.symbol = T.transposeSymbol(c.symbol, semis, newKey); });
    }, { syncText: true });
    toast(`הועבר ל-${T.keyLabel(newKey)}`);
  }

  function changeTimeSig(value) {
    const [num, den] = value.split('/').map(Number);
    const oldBar = barLen();
    const newBar = (num * 4) / den;
    const scale = newBar / oldBar;
    commit((p) => {
      p.timeSig = { num, den };
      if (Math.abs(scale - 1) > EPS) {
        p.chords.forEach((c) => { c.start = round(c.start * scale, 6); c.length = round(c.length * scale, 6); });
      }
    }, { syncText: true });
  }

  let taps = [];
  function tapTempo() {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 2500);
    taps.push(now);
    const b = $('tapBtn');
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 90);
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

  // ------------------------------------------------------------ projects

  function newProject() {
    saveNow();
    const n = Store.list().length + 1;
    const p = P.create({ name: 'פרויקט ' + n });
    p.key = Object.assign({}, state.project.key);
    p.chords = P.parseProgression(T.templateText(T.TEMPLATES[0], p.key), p.timeSig).chords;
    setProject(p);
    toast('נוצר פרויקט חדש');
  }

  function renderProjectList() {
    const list = Store.list();
    const ul = $('projectList');
    $('storageNote').textContent = state.storageOk
      ? 'הפרויקטים נשמרים אוטומטית בדפדפן הזה בלבד. מומלץ לייצא גיבוי מדי פעם.'
      : 'האחסון בדפדפן חסום (למשל בגלישה פרטית) — השתמשו בייצוא/ייבוא גיבוי.';
    if (!list.length) { ul.innerHTML = '<li class="project-empty">אין עדיין פרויקטים שמורים.</li>'; return; }
    ul.innerHTML = list.map((raw) => {
      const p = raw;
      const date = new Date(p.updatedAt);
      const when = isNaN(date) ? '' : date.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
      const chords = (p.chords || []).slice(0, 12).map((c) => c.symbol).join('  ');
      const key = p.key ? T.keyLabel(p.key) : '';
      return `<li class="project-item${p.id === state.project.id ? ' current' : ''}" data-id="${esc(p.id)}">
        <div class="pi-main" data-act="open" role="button" tabindex="0">
          <div class="pi-name">${esc(p.name)}</div>
          <div class="pi-meta">${esc(when)} · ${(p.chords || []).length} אקורדים · ${esc(p.bpm)} BPM · ${esc(key)}</div>
          <div class="pi-chords">${esc(chords)}</div>
        </div>
        <div class="pi-actions">
          <button class="btn small primary" data-act="open">פתיחה</button>
          <button class="btn small" data-act="dup">שכפול</button>
          <button class="btn small" data-act="backup">גיבוי</button>
          <button class="btn small" data-act="delete" aria-label="מחיקת ${esc(p.name)}"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
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
      const copy = P.normalize(Object.assign({}, p, { id: P.uid('p'), name: p.name + ' (עותק)', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      try { Store.save(copy); } catch (e) { toast('השמירה נכשלה', 'error'); return; }
      Store.save(state.project); // keep current project as "last opened"
      renderProjectList();
      toast('הפרויקט שוכפל');
    } else if (act === 'backup') {
      saveNow();
      const p = Store.get(id);
      if (!p) return;
      download(JSON.stringify(P.backupOf([p]), null, 2), safeFileBase(p.name) + '.chordflow.json', 'application/json');
    } else if (act === 'delete') {
      const p = Store.get(id);
      if (!p) return;
      const ok = await confirmDialog(`למחוק את "${p.name}"? לא ניתן לשחזר (אלא מגיבוי).`, 'מחיקה');
      if (!ok) { openModal('projectsModal'); return; }
      Store.remove(id);
      if (id === state.project.id) {
        const rest = Store.list();
        if (rest.length) setProject(Store.get(rest[0].id));
        else setProject(P.create({ name: 'פרויקט חדש' }));
      }
      openModal('projectsModal');
      renderProjectList();
      toast('הפרויקט נמחק');
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
        renderProjectList();
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
    $('exportTracks').innerHTML = '<legend>ערוצים לייצוא</legend>' + p.tracks.map((tr) => {
      const n = (state.arr.tracks.find((a) => a.id === tr.id) || { notes: [] }).notes.length;
      const inst = CF.Instruments.get(tr.instrument);
      return `<label class="switch"><input type="checkbox" data-track="${tr.id}" ${tr.mute ? '' : 'checked'}><span>${esc(tr.name)} — ${esc(inst ? inst.name : '')} · ערוץ ${tr.channel + 1} · ${n} תווים</span></label>`;
    }).join('');
    const secs = state.arr.songEnd * 60 / p.bpm;
    $('exportSummary').innerHTML = `${p.chords.length} אקורדים · ${Math.round(state.arr.songEnd / state.arr.barLen)} תיבות · ${p.bpm} BPM · ${p.timeSig.num}/${p.timeSig.den} · ${esc(T.keyLabel(p.key))} · ${fmtTime(secs)}`;
    openModal('exportModal');
  }

  function doExport() {
    const ids = [...document.querySelectorAll('#exportTracks input[data-track]')].filter((i) => i.checked).map((i) => i.dataset.track);
    if (!ids.length) { toast('בחרו לפחות ערוץ אחד', 'error'); return; }
    const bytes = CF.Midi.build(state.project, state.arr, { trackIds: ids, markers: $('exportMarkers').checked });
    const name = safeFileBase($('exportName').value) + '.mid';
    download(new Blob([bytes], { type: 'audio/midi' }), name);
    closeModal('exportModal');
    toast(`הקובץ ${name} ירד ✓`, 'gold');
  }

  // ============================================================ events

  function bind() {
    // header
    $('projectName').addEventListener('change', (e) => {
      const v = e.target.value.trim() || 'ללא שם';
      commit((p) => { p.name = v.slice(0, 120); });
    });
    $('projectName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('projectsBtn').addEventListener('click', () => { saveNow(); renderProjectList(); openModal('projectsModal'); });
    $('newBtn').addEventListener('click', newProject);
    $('modalNewBtn').addEventListener('click', () => { newProject(); closeModal('projectsModal'); });
    $('helpBtn').addEventListener('click', () => openModal('helpModal'));
    $('syntaxHelpBtn').addEventListener('click', () => openModal('helpModal'));
    $('exportBtn').addEventListener('click', openExport);
    $('exportConfirm').addEventListener('click', doExport);
    $('exportName').addEventListener('keydown', (e) => { if (e.key === 'Enter') doExport(); });

    document.querySelectorAll('.modal').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) {
          if (m.id === 'confirmModal') $('confirmNo').click();
          else closeModal(m.id);
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
    $('importFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });
    $('backupAllBtn').addEventListener('click', () => {
      saveNow();
      const all = Store.list().map((p) => { try { return P.normalize(p); } catch (err) { return null; } }).filter(Boolean);
      if (!all.length) all.push(state.project);
      const d = new Date().toISOString().slice(0, 10);
      download(JSON.stringify(P.backupOf(all), null, 2), `ChordFlow-backup-${d}.json`, 'application/json');
      toast(`גובו ${all.length} פרויקטים`);
    });

    // transport
    $('playBtn').addEventListener('click', togglePlay);
    $('stopBtn').addEventListener('click', () => { player.stop(); });
    $('loopBtn').addEventListener('click', () => commit((p) => { p.loop.enabled = !p.loop.enabled; }));
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
      const v = Math.round(Math.max(20, Math.min(300, parseFloat(e.target.value) || state.project.bpm)));
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
    $('metroBtn').addEventListener('click', () => commit((p) => { p.metronome = !p.metronome; }));
    $('humanBtn').addEventListener('click', () => commit((p) => { p.humanize = !p.humanize; }));

    // progression input
    const ta = $('progressionInput');
    ta.addEventListener('input', () => { state.inputDirty = true; validateProgressionInput(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyProgression(false); }
    });
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
      const sym = chip.dataset.symbol;
      const bl = barLen();
      const start = Math.ceil(chordEnd() / bl - EPS) * bl;
      const id = P.uid('c');
      commit((p) => { p.chords.push({ id, symbol: sym, start, length: bl, inversion: 'auto' }); }, { syncText: true });
      selectChord(id, { audition: true, scroll: true });
    });

    // timeline
    $('snapSelect').addEventListener('change', (e) => { state.snap = e.target.value; });
    $('zoomIn').addEventListener('click', () => { state.zoom = Math.min(120, Math.round(state.zoom * 1.25)); renderTimeline(); });
    $('zoomOut').addEventListener('click', () => { state.zoom = Math.max(10, Math.round(state.zoom / 1.25)); renderTimeline(); });
    $('tlRuler').addEventListener('pointerdown', (e) => {
      const t = Math.floor(timeFromEvent(e) / snapStep() + EPS) * snapStep();
      player.seek(t);
      setPosition(t);
    });
    const lane = $('tlChords');
    lane.addEventListener('pointerdown', (e) => {
      const block = e.target.closest('.chord-block');
      if (block) startBlockDrag(e, block);
      else if (state.selectedId) selectChord(null);
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
      const sym = last ? last.symbol : T.diatonicChords(state.project.key, false)[0].symbol;
      addChordAt(t, sym);
    });

    // inspector (delegated)
    const insp = $('inspectorBody');
    insp.addEventListener('input', (e) => {
      if (e.target.id === 'inspSymbol') {
        const r = T.parseChord(e.target.value);
        e.target.classList.toggle('invalid', !r.ok);
        $('inspErr').textContent = r.ok ? '' : r.error;
      }
    });
    insp.addEventListener('keydown', (e) => {
      if (e.target.id === 'inspSymbol' && e.key === 'Enter') e.target.blur();
    });
    insp.addEventListener('change', (e) => {
      const c = selectedChord();
      if (!c) return;
      const id = c.id, bl = barLen(), unit = beatUnit();
      if (e.target.id === 'inspSymbol') {
        const r = T.parseChord(e.target.value);
        if (!r.ok) { toast(r.error, 'error'); return; }
        commit((p) => { const x = p.chords.find((y) => y.id === id); x.symbol = r.symbol; if (r.bass != null) x.inversion = 'auto'; });
        auditionChord(id);
      } else if (e.target.id === 'inspBar' || e.target.id === 'inspBeat') {
        const bar = Math.max(1, parseInt($('inspBar').value, 10) || 1);
        const beat = Math.max(1, parseFloat($('inspBeat').value) || 1);
        const start = Math.max(0, (bar - 1) * bl + (beat - 1) * unit);
        commit((p) => { p.chords.find((y) => y.id === id).start = round(start, 6); });
      } else if (e.target.id === 'inspLen') {
        const v = parseFloat(e.target.value);
        if (!(v > 0)) { renderInspector(); return; }
        setChordLength(id, v * unit, true);
      } else if (e.target.id === 'inspInv') {
        commit((p) => { p.chords.find((y) => y.id === id).inversion = e.target.value; });
        auditionChord(id);
      }
    });
    insp.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const c = selectedChord();
      if (!btn || !c) return;
      const act = btn.dataset.act;
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

    // tracks (delegated)
    const tb = $('tracksBody');
    tb.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (k !== 'volume' && k !== 'velocity') return;
      const out = e.target.parentElement.querySelector('output');
      if (out) out.textContent = k === 'volume' ? Math.round(e.target.value * 100) : e.target.value;
      if (k === 'volume') {
        const id = e.target.closest('.track').dataset.track;
        trackById(id).volume = +e.target.value; // live preview; committed on change
        player.updateMix();
      }
    });
    tb.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const id = e.target.closest('.track').dataset.track;
      let v = e.target.value;
      if (k === 'octave' || k === 'velocity') v = parseInt(v, 10);
      if (k === 'volume') v = +v;
      if (k === 'volume') {
        // the slider already changed the value live; record the pre-drag value for undo
        const before = JSON.parse(JSON.stringify(state.project));
        const startVol = state.volStart[id];
        delete state.volStart[id];
        before.tracks.find((t) => t.id === id).volume = startVol != null ? startVol : v;
        trackById(id).volume = v;
        if (startVol == null || Math.abs(startVol - v) > 1e-9) {
          state.history.push(JSON.stringify(before));
          state.future = [];
        }
        afterChange();
        return;
      }
      commit((p) => { p.tracks.find((t) => t.id === id)[k] = v; });
    });
    const rememberVolume = (e) => {
      if (e.target.dataset && e.target.dataset.k === 'volume') {
        const id = e.target.closest('.track').dataset.track;
        if (state.volStart[id] == null) state.volStart[id] = trackById(id).volume;
      }
    };
    tb.addEventListener('pointerdown', rememberVolume);
    tb.addEventListener('focusin', rememberVolume);
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ms]');
      if (!b) return;
      const id = b.closest('.track').dataset.track;
      commit((p) => { const t = p.tracks.find((x) => x.id === id); t[b.dataset.ms] = !t[b.dataset.ms]; });
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      const modal = openModalId();
      if (e.key === 'Escape' && modal) {
        if (modal === 'confirmModal') $('confirmNo').click(); else closeModal(modal);
        return;
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
      const c = selectedChord();
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
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderTimeline, 120); });
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
    if (!p) p = P.create({ name: 'השיר הראשון שלי', progression: 'Am | F | C | G' });
    setProject(p);
    if (!state.storageOk) toast('האחסון בדפדפן חסום — הפרויקט לא יישמר אוטומטית. השתמשו בגיבוי.', 'error');

    // test hook (used by automated tests; harmless in production)
    window.ChordFlowApp = { state, player, commit, setProject, recompute };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
