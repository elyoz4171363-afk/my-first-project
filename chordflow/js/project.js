/*
 * ChordFlow — project model, progression text parser and local storage.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const T = () => CF.Theory;
  const EPS = 1e-6;
  const FORMAT_VERSION = 2;

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const FAMILY_EN = { keys: 'Keys', bass: 'Bass', strings: 'Strings', brass: 'Brass', winds: 'Woodwinds', pad: 'Pad' };

  /** Lowest free MIDI channel (0-based), skipping channel 10 (index 9, drums). */
  function freeChannel(tracks) {
    const used = new Set((tracks || []).map((t) => t.channel));
    for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) return c;
    return 0;
  }

  /** Creates a track for an instrument with its family's musical defaults. */
  function makeTrack(instrumentId, existing, overrides) {
    const inst = CF.Instruments.get(instrumentId) || CF.Instruments.list[0];
    const fam = CF.Families.get(inst.family);
    const d = fam.defaults;
    const t = {
      id: uid('t'),
      family: fam.id,
      instrument: inst.id,
      name: inst.name,
      midiName: inst.en,
      channel: freeChannel(existing),
      pattern: d.pattern,
      voicing: d.voicing,
      register: 0,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      dyn: Object.assign({}, d.dyn),
    };
    if (overrides) {
      const o = Object.assign({}, overrides);
      if (o.dyn) { Object.assign(t.dyn, o.dyn); delete o.dyn; }
      Object.assign(t, o);
    }
    return t;
  }

  /** Ready-made line-ups. [instrument, overrides] */
  const ENSEMBLES = [
    { id: 'pianoBass', name: 'פסנתר ובס', tracks: [['grand', {}], ['fingerBass', {}]] },
    { id: 'ballad', name: 'בלדה תזמורתית', tracks: [
      ['grand', { pattern: 'broken', dyn: { level: 'mp' } }],
      ['stringsEns', { pattern: 'sustain', volume: 0.7 }],
      ['cellos', { pattern: 'bassLine', dyn: { level: 'mp' } }],
      ['horns', { pattern: 'innerVoices', volume: 0.6, dyn: { level: 'p' } }],
      ['upright', { pattern: 'sustain', volume: 0.7 }],
    ] },
    { id: 'cinematic', name: 'קולנועי', tracks: [
      ['stringsEns', { pattern: 'pulse8', dyn: { shape: 'cresc', emotion: 75 } }],
      ['violins', { pattern: 'topLine', dyn: { level: 'mf', emotion: 80 } }],
      ['brassEns', { pattern: 'sustain', dyn: { level: 'mp', shape: 'swell', emotion: 75 } }],
      ['cellos', { pattern: 'bassLine', dyn: { level: 'mf' } }],
      ['choir', { pattern: 'sustain', volume: 0.6 }],
    ] },
    { id: 'quartet', name: 'רביעיית כלי קשת', tracks: [
      ['violins', { pattern: 'topLine', name: 'כינור ראשון', midiName: 'Violin 1' }],
      ['violins', { pattern: 'innerVoices', name: 'כינור שני ו-ויולה', midiName: 'Violin 2', register: -1 }],
      ['cellos', { pattern: 'bassLine' }],
    ] },
    { id: 'brassBand', name: 'כלי נשיפה', tracks: [
      ['trumpets', { pattern: 'topLine' }],
      ['horns', { pattern: 'innerVoices' }],
      ['trombones', { pattern: 'bassLine' }],
      ['clarinet', { pattern: 'arpUp', volume: 0.6, dyn: { level: 'p' } }],
      ['upright', { pattern: 'beats' }],
    ] },
    { id: 'pop', name: 'פופ', tracks: [
      ['epiano', { pattern: 'pop' }],
      ['warmPad', { pattern: 'sustain', volume: 0.55 }],
      ['fingerBass', { pattern: 'popSync' }],
    ] },
    { id: 'jazz', name: 'ג׳אז', tracks: [
      ['grand', { pattern: 'stabs', voicing: 'drop2' }],
      ['clarinet', { pattern: 'topLine', dyn: { shape: 'phrase' } }],
      ['upright', { pattern: 'walking' }],
    ] },
  ];

  function ensembleTracks(id) {
    const ens = ENSEMBLES.find((e) => e.id === id) || ENSEMBLES[0];
    const tracks = [];
    ens.tracks.forEach(([inst, o]) => tracks.push(makeTrack(inst, tracks, o)));
    return tracks;
  }

  function defaultTracks() {
    return ensembleTracks('pianoBass');
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
      metronome: false,
      loop: { enabled: true, startBar: 1, endBar: null },
      dynamics: { preset: 'arc', points: [] },
      chords: [],
      tracks: opts.ensemble ? ensembleTracks(opts.ensemble) : defaultTracks(),
    };
    const text = opts.progression != null ? opts.progression : 'C | Am | F | G';
    const parsed = parseProgression(text, p.timeSig);
    if (parsed.ok) p.chords = parsed.chords;
    p.dynamics.points = CF.Dynamics.presetPoints('arc', CF.Arranger ? CF.Arranger.songEndOf(p) : 16, T().barLength(p.timeSig));
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

    // dynamics curve
    const dynRaw = raw.dynamics || {};
    p.dynamics = {
      preset: typeof dynRaw.preset === 'string' ? dynRaw.preset : 'custom',
      points: Array.isArray(dynRaw.points) ? dynRaw.points
        .filter((pt) => pt && isFinite(pt.t) && isFinite(pt.v))
        .map((pt) => ({ t: num(pt.t, 0, 0, 100000), v: num(pt.v, 0.5, 0, 1) }))
        .sort((a, b) => a.t - b.t) : [],
    };
    if (!Array.isArray(dynRaw.points)) {
      p.dynamics = { preset: 'flat', points: CF.Dynamics.presetPoints('flat', 16, 4) };
    }

    // tracks (v1 had fixed 'piano' and 'bass' tracks)
    const rawTracks = Array.isArray(raw.tracks) && raw.tracks.length ? raw.tracks : defaultTracks();
    const out = [];
    rawTracks.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      let instId = r.instrument;
      let inst = CF.Instruments.get(instId);
      if (!inst) {
        const fam = r.family || (r.role === 'bass' || r.id === 'bass' ? 'bass' : 'keys');
        inst = CF.Instruments.forFamily(fam)[0] || CF.Instruments.list[0];
      }
      const fam = CF.Families.get(inst.family);
      const role = fam.role;
      const base = makeTrack(inst.id, out);
      const legacyOct = r.octave != null && r.register == null;
      const register = legacyOct
        ? (inst.family === 'bass' ? (+r.octave || 1) - 1 : (+r.octave || 4) - 4)
        : r.register;
      const t = Object.assign(base, {
        id: typeof r.id === 'string' && r.id ? r.id : base.id,
        name: typeof r.name === 'string' && r.name ? r.name.slice(0, 60) : base.name,
        midiName: typeof r.midiName === 'string' && r.midiName ? r.midiName.slice(0, 60) : base.midiName,
        channel: Number.isInteger(r.channel) && r.channel >= 0 && r.channel < 16 ? r.channel : base.channel,
        pattern: CF.Patterns.list(role).some((x) => x.id === r.pattern) ? r.pattern : base.pattern,
        voicing: role === 'bass' ? null : (CF.Voicings.get(r.voicing) ? r.voicing : base.voicing || 'smooth'),
        register: Math.round(num(register, 0, -2, 2)),
        volume: num(r.volume, base.volume, 0, 1),
        pan: num(r.pan, 0, -1, 1),
        mute: !!r.mute,
        solo: !!r.solo,
      });
      const rd = r.dyn || {};
      const levelIds = CF.Dynamics.LEVELS.map((l) => l.id);
      const shapeIds = CF.Dynamics.SHAPES.map((x) => x.id);
      let legacyLevel = null;
      if (!r.dyn && r.velocity != null) {
        const v = +r.velocity;
        legacyLevel = v < 50 ? 'p' : v < 70 ? 'mp' : v < 95 ? 'mf' : v < 112 ? 'f' : 'ff';
      }
      t.dyn = {
        level: levelIds.includes(rd.level) ? rd.level : legacyLevel || base.dyn.level,
        shape: shapeIds.includes(rd.shape) ? rd.shape : base.dyn.shape,
        emotion: Math.round(num(rd.emotion, base.dyn.emotion, 0, 100)),
        velMin: Math.round(num(rd.velMin, base.dyn.velMin, 1, 127)),
        velMax: Math.round(num(rd.velMax, base.dyn.velMax, 1, 127)),
        accent: Math.round(num(rd.accent, base.dyn.accent, 0, 100)),
        humanize: Math.round(num(rd.humanize, raw.humanize === false ? 0 : base.dyn.humanize, 0, 100)),
        cc1: rd.cc1 != null ? !!rd.cc1 : base.dyn.cc1,
        cc11: rd.cc11 != null ? !!rd.cc11 : base.dyn.cc11,
        cc2: rd.cc2 != null ? !!rd.cc2 : base.dyn.cc2,
        ccRes: [0.125, 0.25, 0.5, 1].includes(+rd.ccRes) ? +rd.ccRes : base.dyn.ccRes,
      };
      if (t.dyn.velMax < t.dyn.velMin) t.dyn.velMax = t.dyn.velMin;
      out.push(t);
    });
    p.tracks = out.length ? out.slice(0, 16) : defaultTracks();
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

  CF.Project = { create, normalize, uid, defaultTracks, makeTrack, freeChannel, ensembleTracks, ENSEMBLES, FAMILY_EN, parseProgression, serializeProgression, backupOf, readBackup, FORMAT_VERSION };
  CF.Store = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Project;
})(typeof globalThis !== 'undefined' ? globalThis : this);
