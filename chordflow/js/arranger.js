/*
 * ChordFlow — arranger.
 * Project (chords + tracks + dynamics) -> concrete notes and controller curves per track,
 * in quarter notes. The same arrangement feeds the audio preview and the MIDI export,
 * so what you hear is exactly what you export.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const EPS = 1e-6;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function makeTime(ts) {
    const barLen = CF.Theory.barLength(ts);
    const offsets = CF.Theory.beatOffsets(ts);
    const barStartOf = (t) => Math.floor(t / barLen + EPS) * barLen;

    function inRange(list, start, end) {
      const out = list.filter((t) => t >= start - EPS && t < end - EPS);
      if (!out.length || out[0] > start + EPS) out.unshift(start);
      return out;
    }
    function bars(start, end) {
      const list = [];
      for (let b = barStartOf(start); b < end - EPS; b += barLen) list.push(b);
      return inRange(list, start, end);
    }
    function barRelative(start, end, offs) {
      const list = [];
      for (let b = barStartOf(start); b < end - EPS; b += barLen) offs.forEach((o) => list.push(b + o));
      return inRange(list, start, end);
    }
    function beats(start, end) { return barRelative(start, end, offsets); }
    function grid(start, end, step) {
      const list = [];
      for (let t = Math.ceil(start / step - EPS) * step; t < end - EPS; t += step) list.push(+t.toFixed(6));
      return inRange(list, start, end);
    }
    function offbeats(start, end) {
      const list = [];
      for (let t = Math.floor(start) + 0.5; t < end - EPS; t += 1) if (t >= start - EPS) list.push(t);
      return list.length ? list : [start];
    }
    function accent(t) {
      const rel = t - barStartOf(t);
      if (Math.abs(rel) < EPS) return 1;
      if (offsets.some((o) => Math.abs(o - rel) < EPS)) return 0.86;
      return 0.74;
    }
    return { barLen, offsets, barStartOf, bars, beats, grid, offbeats, accent, barRelative };
  }

  /** Sorted, parsed chords with their effective end (cut at the next chord). */
  function prepareChords(project) {
    const list = (project.chords || [])
      .map((c) => ({ src: c, parsed: CF.Theory.parseChord(c.symbol) }))
      .filter((c) => c.parsed.ok && c.src.length > EPS)
      .sort((a, b) => a.src.start - b.src.start);
    list.forEach((c, i) => {
      const next = list[i + 1];
      c.start = c.src.start;
      c.end = next ? Math.min(c.src.start + c.src.length, next.src.start) : c.src.start + c.src.length;
    });
    return list.filter((c) => c.end - c.start > EPS);
  }

  function songEndOf(project) {
    const barLen = CF.Theory.barLength(project.timeSig);
    let end = 0;
    (project.chords || []).forEach((c) => { end = Math.max(end, c.start + c.length); });
    return Math.max(barLen, Math.ceil(end / barLen - EPS) * barLen);
  }

  function applySwing(notes, amount) {
    if (!amount) return;
    const shift = (amount / 100) * (1 / 6); // 100% = triplet feel
    notes.forEach((n) => {
      const frac = n.t - Math.floor(n.t + EPS);
      if (Math.abs(frac - 0.5) < EPS) {
        n.t += shift;
        n.dur = Math.max(0.05, n.dur - shift);
      } else if (Math.abs(frac) < EPS && Math.abs(n.dur - 0.5) < 0.1) {
        n.dur += shift * 0.9;
      }
    });
  }

  /** Joins a note with the next note of the same pitch that starts exactly when it ends. */
  function tieCommonTones(notes) {
    notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
    const open = new Map();
    const out = [];
    notes.forEach((n) => {
      const prev = open.get(n.pitch);
      if (prev && Math.abs(prev.t + prev.dur - n.t) < 0.02) {
        prev.dur = n.t + n.dur - prev.t;
        return;
      }
      open.set(n.pitch, n);
      out.push(n);
    });
    return out;
  }

  /** No overlapping notes of the same pitch (keeps MIDI note on/off pairs clean). */
  function cleanOverlaps(notes) {
    const byPitch = new Map();
    notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
    const out = [];
    notes.forEach((n) => {
      const prev = byPitch.get(n.pitch);
      if (prev) {
        if (Math.abs(prev.t - n.t) < 0.01) { prev.vel = Math.max(prev.vel, n.vel); prev.dur = Math.max(prev.dur, n.dur); return; }
        if (prev.t + prev.dur > n.t - 0.01) prev.dur = Math.max(0.02, n.t - prev.t - 0.01);
      }
      byPitch.set(n.pitch, n);
      out.push(n);
    });
    return out;
  }

  function familyOf(track) {
    return (CF.Families && CF.Families.get(track.family)) || { role: 'piano', id: 'keys' };
  }
  function instrumentOf(track) {
    return CF.Instruments.get(track.instrument) || CF.Instruments.forFamily(track.family)[0] || CF.Instruments.list[0];
  }

  /** Dynamic value d(t) for a track — shared by velocities, CC curves and the preview. */
  function makeDynamics(project, chords, time) {
    const points = (project.dynamics && project.dynamics.points) || [];
    const phraseLen = time.barLen * 4;
    function chordAt(t) {
      for (let i = chords.length - 1; i >= 0; i--) if (chords[i].start <= t + EPS) return chords[i];
      return null;
    }
    return function d(track, t, chordSpan) {
      const span = chordSpan || chordAt(t);
      const pos = {
        chord: span ? Math.max(0, Math.min(1, (t - span.start) / Math.max(EPS, span.end - span.start))) : 0,
        phrase: (t % phraseLen) / phraseLen,
        bar: (t - time.barStartOf(t)) / time.barLen,
      };
      return CF.Dynamics.valueAt(dynAt(project, track, t), CF.Dynamics.curveAt(points, t), pos);
    };
  }

  /** Section settings for a track at time t: { on, pattern, level } (null = the track's own setting). */
  function sectionSettings(project, track, t) {
    if (!project.sections || !project.sections.length || !CF.Project) return { on: true, pattern: null, level: null };
    return CF.Project.sectionTrack(CF.Project.sectionAt(project.sections, t), track.id);
  }

  /** The track's dynamics with the section's level applied. */
  function dynAt(project, track, t) {
    const lv = sectionSettings(project, track, t).level;
    return lv ? Object.assign({}, track.dyn, { level: lv }) : track.dyn;
  }

  /**
   * Section voicing: ONE master voicing per chord (real bass + upper structure with smooth
   * voice leading), shared by every orchestral line so parts don't cross or double by accident.
   * Line patterns (top line / inner voices / bass line / low ostinato) take their notes from it.
   */
  function sectionVoicings(chords) {
    let prev = null;
    return chords.map((ch) => {
      const upper = CF.Voicing.voicePiano(ch.parsed, { voicing: 'smooth', center: 66, inversion: 'auto', prev });
      prev = upper;
      return { upper, bassPc: CF.Voicing.bassPc(ch.parsed, ch.src.inversion) };
    });
  }

  /** One octave shift for a whole line, so it sits in the instrument's range without jumping around. */
  function lineShift(pitches, center) {
    if (!pitches.length) return 0;
    const avg = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    return Math.round((center - avg) / 12) * 12;
  }

  function arrangeTrack(track, chords, time, project, dynOf, master) {
    const family = familyOf(track);
    const inst = instrumentOf(track);
    const role = family.role;
    const basePattern = CF.Patterns.get(role, track.pattern);
    const rng = mulberry32(hashString(project.id + ':' + track.id));
    const notes = [];
    let prevVoicing = null;
    const register = track.register || 0;
    const center = inst.center + 12 * register;
    const range = [Math.max(0, inst.range[0] + (register < 0 ? 12 * register : 0)), Math.min(127, inst.range[1] + (register > 0 ? 12 * register : 0))];

    const bassFor = (ch) => CF.Voicing.foldPitch(CF.Voicing.bassPitchFor(CF.Voicing.bassPc(ch.parsed, ch.src.inversion), 1 + register), range);
    const BASE_VEL = 100;

    // orchestral lines: notes come from the shared master voicing, shifted once per track into range
    const bassCenter = Math.max(range[0] + 5, center - 5);
    const shifts = {};
    const upperShiftFor = (pat) => {
      if (shifts[pat.id] == null) {
        shifts[pat.id] = pat.id === 'topLine'
          ? lineShift(master.map((m) => m.upper[m.upper.length - 1]), center)
          : lineShift([].concat(...master.map((m) => m.upper)), center);
      }
      return shifts[pat.id];
    };
    const sectionNotes = (idx, pat) => {
      const upperShift = upperShiftFor(pat);
      const m = master[idx];
      const bass = CF.Voicing.foldPitch(CF.Voicing.nearest(m.bassPc, bassCenter), range);
      const upper = m.upper.map((p) => CF.Voicing.foldPitch(p + upperShift, range));
      return [bass].concat([...new Set(upper)].sort((a, b) => a - b).filter((p) => p > bass));
    };

    chords.forEach((ch, idx) => {
      const chord = ch.parsed;
      // song form: the section may rest this instrument or give it another pattern
      const sec = sectionSettings(project, track, ch.start);
      if (!sec.on) { prevVoicing = null; return; }
      const pattern = sec.pattern ? CF.Patterns.get(role, sec.pattern) : basePattern;
      const useSection = role === 'ensemble' && pattern.section && master;
      const voicing = role !== 'bass'
        ? CF.Voicing.voicePiano(chord, { voicing: track.voicing, center, inversion: ch.src.inversion, prev: prevVoicing, range })
        : null;
      if (voicing) prevVoicing = voicing;

      const bass = bassFor(ch);
      const fifthIv = chord.info.fifth != null ? chord.info.fifth : 7;
      let fifth = CF.Voicing.atOrAbove((chord.root + fifthIv) % 12, bass + 1);
      if (fifth - bass > 9) fifth -= 12;
      const tones = chord.core.map((iv) => CF.Voicing.atOrAbove((chord.root + iv) % 12, bass));
      const uniqTones = [...new Set(tones)].sort((a, b) => a - b);
      const next = chords[idx + 1] && Math.abs(chords[idx + 1].start - ch.end) < EPS ? { bass: bassFor(chords[idx + 1]) } : null;

      const c = {
        start: ch.start, end: ch.end, chord, notes: useSection ? sectionNotes(idx, pattern) : (voicing || []),
        bass, fifth, octave: bass + 12, tones: uniqTones, next,
        vel: BASE_VEL, barLen: time.barLen, ts: project.timeSig.num + '/' + project.timeSig.den,
        bars: () => time.bars(ch.start, ch.end),
        beats: () => time.beats(ch.start, ch.end),
        grid: (step) => time.grid(ch.start, ch.end, step),
        offbeats: () => time.offbeats(ch.start, ch.end),
        barHits: (map) => (map[c.ts] ? time.barRelative(ch.start, ch.end, map[c.ts]) : time.beats(ch.start, ch.end)),
        accent: time.accent,
        rng,
      };
      const hits = pattern.generate(c) || [];
      hits.forEach((h) => {
        const dur = Math.max(0.03, Math.min(h.dur, ch.end - h.t));
        const d = dynOf(track, h.t, ch);
        h.pitches.forEach((p, k) => {
          if (p == null || !isFinite(p)) return;
          let accentFactor = h.vel / BASE_VEL;
          if (role === 'piano' && h.pitches.length > 1 && k === h.pitches.length - 1) accentFactor += 0.05; // top voice sings
          notes.push({
            t: +h.t.toFixed(6),
            dur: +dur.toFixed(6),
            pitch: Math.max(0, Math.min(127, Math.round(p))),
            vel: CF.Dynamics.velocityFor(track.dyn, d, accentFactor, rng),
            leg: !!pattern.legato,
          });
        });
      });
    });

    // tie common tones only between notes of legato patterns
    let out = tieCommonTones(notes.filter((n) => n.leg)).concat(notes.filter((n) => !n.leg));
    out.forEach((n) => { delete n.leg; });
    applySwing(out, project.swing || 0);
    return cleanOverlaps(out);
  }

  /**
   * Controller curves sampled across the song.
   *   CC1 (and CC2) carry the phrasing: level + song curve + shape, smoothed so chord changes glide.
   *   CC11 is the slow layer: level + song curve only (a mix/section ceiling, like in orchestral templates).
   */
  function ccCurves(track, songEnd, dynOf) {
    const dyn = track.dyn;
    const step = Math.max(0.0625, dyn.ccRes || 0.25);
    const flatTrack = Object.assign({}, track, { dyn: Object.assign({}, dyn, { shape: 'flat' }) });
    const raw = [], slow = [];
    for (let t = 0; t < songEnd - EPS; t += step) {
      raw.push({ t: +t.toFixed(6), d: dynOf(track, t) });
      slow.push(dynOf(flatTrack, t));
    }
    // one-pole smoothing (about a beat) turns chord-boundary drops into short ramps
    const alpha = 1 - Math.exp(-step / 0.8);
    const curve = [];
    raw.forEach((p, i) => {
      const prev = i ? curve[i - 1].d : p.d;
      curve.push({ t: p.t, d: +(prev + (p.d - prev) * alpha).toFixed(4) });
    });
    const events = [];
    [1, 11, 2].forEach((cc) => {
      if (!dyn['cc' + cc]) return;
      let last = -1;
      curve.forEach((p, i) => {
        const v = CF.Dynamics.ccFromD[cc](cc === 11 ? slow[i] : p.d);
        if (last < 0 || Math.abs(v - last) >= 2 || (v !== last && (v === 0 || v === 127))) { events.push({ t: p.t, cc, v }); last = v; }
      });
    });
    events.sort((a, b) => a.t - b.t || a.cc - b.cc);
    return { curve, events };
  }

  /**
   * Metronome clicks. level 0 = downbeat, 1 = beat (group start), 2 = subdivision.
   * mode 'auto': /8 meters click every eighth (so 6/8 and 7/8 are felt), others click beats.
   * mode 'beats': beats only.  mode 'subdiv': every eighth (or the beat unit's half).
   */
  function metronomeGrid(project, time, songEnd) {
    const ts = project.timeSig;
    const mode = (project.metro && project.metro.mode) || 'auto';
    const subdiv = mode === 'subdiv' || (mode === 'auto' && ts.den === 8);
    const step = ts.den === 8 ? 0.5 : (4 / ts.den) / 2;
    const out = [];
    for (let b = 0; b < songEnd - EPS; b += time.barLen) {
      if (!subdiv) {
        time.offsets.forEach((o, i) => out.push({ t: b + o, level: i === 0 ? 0 : 1, down: i === 0 }));
        continue;
      }
      for (let o = 0; o < time.barLen - EPS; o += step) {
        const isBeat = time.offsets.some((x) => Math.abs(x - o) < EPS);
        const level = o < EPS ? 0 : isBeat ? 1 : 2;
        out.push({ t: +(b + o).toFixed(6), level, down: level === 0 });
      }
    }
    return out;
  }

  function arrange(project) {
    const time = makeTime(project.timeSig);
    const chords = prepareChords(project);
    const songEnd = songEndOf(project);
    const dynOf = makeDynamics(project, chords, time);
    const master = sectionVoicings(chords);
    const tracks = project.tracks.map((track) => {
      const notes = arrangeTrack(track, chords, time, project, dynOf, master);
      const cc = ccCurves(track, songEnd, dynOf);
      return { id: track.id, track, notes, cc: cc.events, curve: cc.curve };
    });
    const markers = chords.map((c) => ({ t: c.start, text: c.parsed.symbol, id: c.src.id }));
    // song-form markers ("Verse 1", "Chorus 2" ...) for Cubase's marker track
    const counts = {};
    const sectionMarkers = (project.sections || []).map((sec) => {
      const type = (CF.Project && CF.Project.SECTION_TYPES.find((x) => x.id === sec.type)) || { en: 'Section' };
      const ascii = /^[\x20-\x7e]+$/.test(sec.name) ? sec.name : null;
      counts[type.en] = (counts[type.en] || 0) + 1;
      return { t: sec.start, text: ascii || `${type.en} ${counts[type.en]}`, section: true };
    });

    // reference voicing (first harmony track) for the chord inspector
    const voicings = {};
    const ref = project.tracks.find((t) => familyOf(t).role !== 'bass');
    if (ref) {
      const inst = instrumentOf(ref);
      const center = inst.center + 12 * (ref.register || 0);
      let prev = null;
      chords.forEach((c) => {
        const v = CF.Voicing.voicePiano(c.parsed, { voicing: ref.voicing, center, inversion: c.src.inversion, prev, range: inst.range });
        voicings[c.src.id] = v;
        prev = v;
      });
    }
    const beatGrid = metronomeGrid(project, time, songEnd);
    return { barLen: time.barLen, offsets: time.offsets, songEnd, tracks, markers, sectionMarkers, voicings, beatGrid, chords };
  }

  CF.Arranger = { arrange, songEndOf, makeTime, familyOf, instrumentOf, metronomeGrid };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Arranger;
})(typeof globalThis !== 'undefined' ? globalThis : this);
