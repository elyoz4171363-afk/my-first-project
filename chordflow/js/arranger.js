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
      return CF.Dynamics.valueAt(track.dyn, CF.Dynamics.curveAt(points, t), pos);
    };
  }

  function arrangeTrack(track, chords, time, project, dynOf) {
    const family = familyOf(track);
    const inst = instrumentOf(track);
    const role = family.role;
    const pattern = CF.Patterns.get(role, track.pattern);
    const rng = mulberry32(hashString(project.id + ':' + track.id));
    const notes = [];
    let prevVoicing = null;
    const register = track.register || 0;
    const center = inst.center + 12 * register;
    const range = [Math.max(0, inst.range[0] + (register < 0 ? 12 * register : 0)), Math.min(127, inst.range[1] + (register > 0 ? 12 * register : 0))];

    const bassFor = (ch) => CF.Voicing.foldPitch(CF.Voicing.bassPitchFor(CF.Voicing.bassPc(ch.parsed, ch.src.inversion), 1 + register), range);
    const BASE_VEL = 100;

    chords.forEach((ch, idx) => {
      const chord = ch.parsed;
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
        start: ch.start, end: ch.end, chord, notes: voicing || [],
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
          });
        });
      });
    });

    let out = notes;
    if (pattern.legato) out = tieCommonTones(out);
    applySwing(out, project.swing || 0);
    return cleanOverlaps(out);
  }

  /** Controller curves (CC1 / CC11 / CC2) sampled across the song, de-duplicated. */
  function ccCurves(track, songEnd, dynOf) {
    const dyn = track.dyn;
    const step = Math.max(0.0625, dyn.ccRes || 0.25);
    const curve = [];
    for (let t = 0; t < songEnd - EPS; t += step) curve.push({ t: +t.toFixed(6), d: dynOf(track, t) });
    const events = [];
    [1, 11, 2].forEach((cc) => {
      if (!dyn['cc' + cc]) return;
      let last = -1;
      curve.forEach((p) => {
        const v = CF.Dynamics.ccFromD[cc](p.d);
        if (v !== last) { events.push({ t: p.t, cc, v }); last = v; }
      });
    });
    events.sort((a, b) => a.t - b.t || a.cc - b.cc);
    return { curve, events };
  }

  function arrange(project) {
    const time = makeTime(project.timeSig);
    const chords = prepareChords(project);
    const songEnd = songEndOf(project);
    const dynOf = makeDynamics(project, chords, time);
    const tracks = project.tracks.map((track) => {
      const notes = arrangeTrack(track, chords, time, project, dynOf);
      const cc = ccCurves(track, songEnd, dynOf);
      return { id: track.id, track, notes, cc: cc.events, curve: cc.curve };
    });
    const markers = chords.map((c) => ({ t: c.start, text: c.parsed.symbol, id: c.src.id }));

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
    const beatGrid = [];
    for (let b = 0; b < songEnd - EPS; b += time.barLen) {
      time.offsets.forEach((o, i) => beatGrid.push({ t: b + o, down: i === 0 }));
    }
    return { barLen: time.barLen, offsets: time.offsets, songEnd, tracks, markers, voicings, beatGrid, chords };
  }

  CF.Arranger = { arrange, songEndOf, makeTime, familyOf, instrumentOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Arranger;
})(typeof globalThis !== 'undefined' ? globalThis : this);
