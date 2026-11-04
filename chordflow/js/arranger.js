/*
 * ChordFlow — arranger.
 * Project (chords + track settings) -> concrete notes per track, in quarter notes.
 * The same arrangement feeds both the audio preview and the MIDI export,
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

  function arrangeTrack(track, chords, time, project) {
    const pattern = CF.Patterns.get(track.role, track.pattern);
    const rng = mulberry32(hashString(project.id + ':' + track.id));
    const notes = [];
    let prevVoicing = null;

    const bassFor = (ch) => CF.Voicing.bassPitchFor(CF.Voicing.bassPc(ch.parsed, ch.src.inversion), track.octave);

    chords.forEach((ch, idx) => {
      const chord = ch.parsed;
      const voicing = track.role === 'piano'
        ? CF.Voicing.voicePiano(chord, { voicing: track.voicing, octave: track.octave, inversion: ch.src.inversion, prev: prevVoicing })
        : null;
      if (voicing) prevVoicing = voicing;

      const bass = bassFor(ch);
      const fifthIv = chord.info.fifth != null ? chord.info.fifth : 7;
      const fifthPc = (chord.root + fifthIv) % 12;
      let fifth = CF.Voicing.atOrAbove(fifthPc, bass + 1);
      if (fifth - bass > 9) fifth -= 12;
      const tones = chord.core.map((iv) => CF.Voicing.atOrAbove((chord.root + iv) % 12, bass));
      const uniqTones = [...new Set(tones)].sort((a, b) => a - b);
      const next = chords[idx + 1] && Math.abs(chords[idx + 1].start - ch.end) < EPS ? { bass: bassFor(chords[idx + 1]) } : null;

      const c = {
        start: ch.start, end: ch.end, chord, notes: voicing || [],
        bass, fifth, octave: bass + 12, tones: uniqTones, next,
        vel: track.velocity, barLen: time.barLen, ts: project.timeSig.num + '/' + project.timeSig.den,
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
        h.pitches.forEach((p, k) => {
          if (p == null || !isFinite(p)) return;
          let vel = h.vel;
          if (track.role === 'piano' && h.pitches.length > 1 && k === h.pitches.length - 1) vel += 4; // top voice sings
          if (project.humanize) vel += (rng() - 0.5) * 12;
          notes.push({
            t: +h.t.toFixed(6),
            dur: +dur.toFixed(6),
            pitch: Math.max(0, Math.min(127, Math.round(p))),
            vel: Math.max(1, Math.min(127, Math.round(vel))),
          });
        });
      });
    });

    applySwing(notes, project.swing || 0);
    return cleanOverlaps(notes);
  }

  function arrange(project) {
    const time = makeTime(project.timeSig);
    const chords = prepareChords(project);
    const songEnd = songEndOf(project);
    const tracks = project.tracks.map((track) => ({
      id: track.id,
      track,
      notes: arrangeTrack(track, chords, time, project),
    }));
    const markers = chords.map((c) => ({ t: c.start, text: c.parsed.symbol, id: c.src.id }));
    const voicings = {};
    const pianoTrack = project.tracks.find((t) => t.role === 'piano');
    if (pianoTrack) {
      let prev = null;
      chords.forEach((c) => {
        const v = CF.Voicing.voicePiano(c.parsed, { voicing: pianoTrack.voicing, octave: pianoTrack.octave, inversion: c.src.inversion, prev });
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

  CF.Arranger = { arrange, songEndOf, makeTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Arranger;
})(typeof globalThis !== 'undefined' ? globalThis : this);
