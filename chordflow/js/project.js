/*
 * ChordFlow — project model, progression text parser and local storage.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const T = () => CF.Theory;
  const EPS = 1e-6;
  const FORMAT_VERSION = 1;

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function defaultTracks() {
    return [
      { id: 'piano', role: 'piano', name: 'פסנתר', midiName: 'Piano', instrument: 'grand', channel: 0,
        pattern: 'block', voicing: 'smooth', octave: 4, volume: 0.8, pan: 0, velocity: 86, mute: false, solo: false },
      { id: 'bass', role: 'bass', name: 'בס', midiName: 'Bass', instrument: 'fingerBass', channel: 1,
        pattern: 'sustain', voicing: null, octave: 1, volume: 0.85, pan: 0, velocity: 100, mute: false, solo: false },
    ];
  }

  function create(opts) {
    opts = opts || {};
    const now = new Date().toISOString();
    const p = {
      app: 'ChordFlow',
      version: FORMAT_VERSION,
      id: uid('p'),
      name: opts.name || 'פרויקט חדש',
      createdAt: now,
      updatedAt: now,
      key: { tonic: 'C', mode: 'major' },
      bpm: 96,
      timeSig: { num: 4, den: 4 },
      swing: 0,
      humanize: true,
      metronome: false,
      loop: { enabled: true, startBar: 1, endBar: null },
      chords: [],
      tracks: defaultTracks(),
    };
    const text = opts.progression != null ? opts.progression : 'C | Am | F | G';
    const parsed = parseProgression(text, p.timeSig);
    if (parsed.ok) p.chords = parsed.chords;
    return p;
  }

  const num = (v, def, min, max) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };

  /** Validates and fills defaults; used for loading, importing and migrations. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('קובץ פרויקט לא תקין');
    const base = create({ progression: '' });
    const p = Object.assign({}, base, {
      id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 120) : base.name,
      createdAt: raw.createdAt || base.createdAt,
      updatedAt: raw.updatedAt || base.updatedAt,
    });
    const tonic = raw.key && T().parseNote(raw.key.tonic || '');
    p.key = { tonic: tonic ? tonic.name : 'C', mode: raw.key && raw.key.mode === 'minor' ? 'minor' : 'major' };
    p.bpm = Math.round(num(raw.bpm, 96, 20, 300));
    const tsNum = Math.round(num(raw.timeSig && raw.timeSig.num, 4, 1, 16));
    const tsDen = [2, 4, 8].includes(raw.timeSig && +raw.timeSig.den) ? +raw.timeSig.den : 4;
    p.timeSig = { num: tsNum, den: tsDen };
    p.swing = num(raw.swing, 0, 0, 100);
    p.humanize = raw.humanize !== false;
    p.metronome = !!raw.metronome;
    const lp = raw.loop || {};
    p.loop = {
      enabled: lp.enabled !== false,
      startBar: Math.round(num(lp.startBar, 1, 1, 999)),
      endBar: lp.endBar == null ? null : Math.round(num(lp.endBar, 1, 1, 999)),
    };
    p.chords = Array.isArray(raw.chords) ? raw.chords
      .filter((c) => c && typeof c.symbol === 'string')
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id : uid('c'),
        symbol: c.symbol.slice(0, 32),
        start: num(c.start, 0, 0, 100000),
        length: num(c.length, 4, 0.125, 100000),
        inversion: c.inversion == null ? 'auto' : String(c.inversion),
      })) : [];
    p.chords.sort((a, b) => a.start - b.start);

    const defaults = defaultTracks();
    const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
    p.tracks = defaults.map((d) => {
      const r = rawTracks.find((t) => t && t.id === d.id) || {};
      const inst = CF.Instruments.get(r.instrument);
      return Object.assign({}, d, {
        name: typeof r.name === 'string' && r.name ? r.name : d.name,
        midiName: typeof r.midiName === 'string' && r.midiName ? r.midiName : d.midiName,
        instrument: inst && inst.role === d.role ? inst.id : d.instrument,
        pattern: CF.Patterns.list(d.role).some((x) => x.id === r.pattern) ? r.pattern : d.pattern,
        voicing: d.role === 'piano' ? (CF.Voicings.get(r.voicing) ? r.voicing : d.voicing) : null,
        octave: Math.round(num(r.octave, d.octave, d.role === 'bass' ? 0 : 2, d.role === 'bass' ? 3 : 6)),
        volume: num(r.volume, d.volume, 0, 1),
        pan: num(r.pan, 0, -1, 1),
        velocity: Math.round(num(r.velocity, d.velocity, 1, 127)),
        mute: !!r.mute,
        solo: !!r.solo,
      });
    });
    return p;
  }

  // -------------------------------------------------- progression text

  const CONTINUE = /^[-/.~]$|^—$/;
  const REST = /^(N\.?C\.?|x)$/i;

  /**
   * Parses progression text.
   *   "Am F C G"              → one chord per bar
   *   "C | Am | F G | G7"     → bars split by |, chords inside a bar share it equally
   *   "C - G - | F"           → "-" or "/" holds the previous chord one more slot
   *   "%"                     → repeat the previous bar,  "NC" → silence
   * Line breaks count as bar lines.
   */
  function parseProgression(text, timeSig, startAt) {
    const barLen = T().barLength(timeSig);
    const src = String(text || '').replace(/\r/g, '');
    const hasBars = /[|\n]/.test(src.trim());
    let bars;
    if (hasBars) {
      bars = src.split(/[|\n]/).map((b) => b.trim()).filter((b) => b.length).map((b) => b.split(/\s+/));
    } else {
      bars = src.trim() ? src.trim().split(/\s+/).map((tok) => [tok]) : [];
    }
    const errors = [];
    const chords = [];
    let t = startAt || 0;
    let prevBar = null;
    bars.forEach((tokens, bi) => {
      if (tokens.length === 1 && tokens[0] === '%') {
        if (!prevBar) { errors.push({ token: '%', bar: bi + 1, error: 'אין תיבה קודמת לחזור עליה' }); tokens = ['NC']; } else tokens = prevBar;
      }
      const slot = barLen / tokens.length;
      tokens.forEach((tok) => {
        if (CONTINUE.test(tok)) {
          const last = chords[chords.length - 1];
          if (last && Math.abs(last.start + last.length - t) < EPS) last.length += slot;
        } else if (REST.test(tok)) {
          // silence
        } else {
          const parsed = T().parseChord(tok);
          if (!parsed.ok) errors.push({ token: tok, bar: bi + 1, error: parsed.error });
          else chords.push({ id: uid('c'), symbol: parsed.symbol, start: +t.toFixed(6), length: +slot.toFixed(6), inversion: 'auto' });
        }
        t += slot;
      });
      prevBar = tokens;
    });
    return { ok: errors.length === 0, chords, errors, bars: bars.length, end: t };
  }

  function gcd(a, b) { return b < 1e-9 ? a : gcd(b, a % b); }

  /** Writes chords back as progression text ("C | Am | F G | -"). */
  function serializeProgression(chords, timeSig) {
    const barLen = T().barLength(timeSig);
    const list = chords.slice().sort((a, b) => a.start - b.start);
    if (!list.length) return '';
    let end = 0;
    list.forEach((c) => { end = Math.max(end, c.start + c.length); });
    const nBars = Math.max(1, Math.ceil(end / barLen - EPS));
    const out = [];
    for (let b = 0; b < nBars; b++) {
      const bs = b * barLen, be = bs + barLen;
      const points = [bs, be];
      list.forEach((c) => {
        [c.start, c.start + c.length].forEach((x) => { if (x > bs + EPS && x < be - EPS) points.push(x); });
      });
      let step = barLen;
      points.forEach((x) => { const d = Math.round((x - bs) * 48) / 48; if (d > EPS) step = gcd(step, d); });
      step = Math.max(step, barLen / 16);
      const slots = Math.round(barLen / step);
      const toks = [];
      for (let s = 0; s < slots; s++) {
        const ts = bs + s * step;
        const starting = list.find((c) => Math.abs(c.start - ts) < 1e-3);
        if (starting) { toks.push(starting.symbol); continue; }
        const covering = list.find((c) => c.start < ts - EPS && c.start + c.length > ts + EPS);
        toks.push(covering ? '-' : 'NC');
      }
      out.push(toks.join(' '));
    }
    return out.join(' | ');
  }

  // ------------------------------------------------------ local storage

  const KEY = 'chordflow.projects.v1';
  const LAST = 'chordflow.lastProject';

  function readAll() {
    try {
      const raw = root.localStorage.getItem(KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }
  function writeAll(all) {
    root.localStorage.setItem(KEY, JSON.stringify(all));
  }

  const Store = {
    available() {
      try { const k = '__cf_test'; root.localStorage.setItem(k, '1'); root.localStorage.removeItem(k); return true; } catch (e) { return false; }
    },
    list() {
      return Object.values(readAll())
        .filter((p) => p && p.id)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    get(id) {
      const p = readAll()[id];
      if (!p) return null;
      try { return normalize(p); } catch (e) { return null; }
    },
    save(project) {
      const all = readAll();
      all[project.id] = project;
      writeAll(all);
      try { root.localStorage.setItem(LAST, project.id); } catch (e) { /* ignore */ }
    },
    remove(id) {
      const all = readAll();
      delete all[id];
      writeAll(all);
    },
    lastId() {
      try { return root.localStorage.getItem(LAST); } catch (e) { return null; }
    },
  };

  // ------------------------------------------------------------ backups

  function backupOf(projects) {
    return {
      app: 'ChordFlow',
      format: 'chordflow-backup',
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      projects,
    };
  }

  /** Accepts a backup file or a single project; returns normalized projects. */
  function readBackup(json) {
    let data = json;
    if (typeof json === 'string') {
      try { data = JSON.parse(json); } catch (e) { throw new Error('הקובץ אינו JSON תקין'); }
    }
    let list;
    if (data && Array.isArray(data.projects)) list = data.projects;
    else if (data && Array.isArray(data.chords)) list = [data];
    else throw new Error('הקובץ אינו גיבוי של ChordFlow');
    return list.map(normalize);
  }

  CF.Project = { create, normalize, uid, defaultTracks, parseProgression, serializeProgression, backupOf, readBackup, FORMAT_VERSION };
  CF.Store = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Project;
})(typeof globalThis !== 'undefined' ? globalThis : this);
