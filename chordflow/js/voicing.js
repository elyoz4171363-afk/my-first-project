/*
 * ChordFlow — voicing engine.
 * Turns a parsed chord into concrete MIDI pitches for the piano and the bass.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const mod12 = (n) => ((n % 12) + 12) % 12;

  /** Pitch with class `pc` closest to `center` (range center-5 … center+6). */
  function nearest(pc, center) {
    const d = mod12(pc - center);
    return d > 6 ? center + d - 12 : center + d;
  }
  /** Lowest pitch with class `pc` that is >= min. */
  function atOrAbove(pc, min) {
    return min + mod12(pc - min);
  }
  function stackUp(pcs, first) {
    const out = [first];
    for (let i = 1; i < pcs.length; i++) out.push(atOrAbove(pcs[i], out[out.length - 1] + 1));
    return out;
  }
  function rotate(arr, n) {
    const k = ((n % arr.length) + arr.length) % arr.length;
    return arr.slice(k).concat(arr.slice(0, k));
  }

  /**
   * Core tones (root/3rd/5th/7th as pitch classes, in that order) and extensions.
   * Very dense chords drop the unaltered 5th so the voicing stays clear.
   */
  function chordTones(chord) {
    let core = chord.core.map((iv) => ({ iv, pc: mod12(chord.root + iv) }));
    const ext = chord.ext.map((iv) => mod12(chord.root + iv));
    if (core.length + ext.length > 5 && core.length > 2) {
      const fifthIdx = core.findIndex((t) => t.iv === 7);
      if (fifthIdx > 0) core = core.filter((_, i) => i !== fifthIdx);
    }
    return { core: core.map((t) => t.pc), ext };
  }

  /** Inversion index (into chord.core) or null for automatic. */
  function resolveInversion(chord, inversion) {
    const core = chord.core.map((iv) => mod12(chord.root + iv));
    if (inversion === 'auto' || inversion == null || inversion === '') {
      if (chord.bass != null) {
        const idx = core.indexOf(chord.bass);
        if (idx >= 0) return idx;
      }
      return null;
    }
    const n = Math.max(0, Math.min(core.length - 1, parseInt(inversion, 10) || 0));
    return n;
  }

  /** Map the requested inversion onto the (possibly thinned) core list. */
  function bottomIndex(chord, tones, inv) {
    if (inv == null) return 0;
    const pc = mod12(chord.root + chord.core[inv]);
    const idx = tones.core.indexOf(pc);
    return idx >= 0 ? idx : 0;
  }

  function closeVoicing(tones, rot, center) {
    const pcs = rotate(tones.core, rot).concat(tones.ext);
    return stackUp(pcs, nearest(pcs[0], center));
  }

  function movement(a, b) {
    let cost = 0;
    a.forEach((n) => { cost += Math.min(...b.map((m) => Math.abs(n - m))); });
    b.forEach((n) => { cost += Math.min(...a.map((m) => Math.abs(n - m))); });
    return cost / 2;
  }

  /**
   * @param chord   parsed chord (Theory.parseChord)
   * @param opts    { voicing, octave, inversion, prev }
   * @returns ascending MIDI pitches
   */
  function voicePiano(chord, opts) {
    const octave = opts.octave != null ? opts.octave : 4;
    const center = 12 * (octave + 1) + 3;
    const tones = chordTones(chord);
    const inv = resolveInversion(chord, opts.inversion);
    const bottom = bottomIndex(chord, tones, inv);
    const n = tones.core.length;
    let notes;

    switch (opts.voicing) {
      case 'close':
        notes = closeVoicing(tones, bottom, center);
        break;

      case 'drop2': {
        if (n < 3) { notes = closeVoicing(tones, bottom, center); break; }
        // choose the rotation whose dropped voice ends up as the requested bass tone
        const rot = (((bottom - (n - 2)) % n) + n) % n;
        const close = stackUp(rotate(tones.core, rot), nearest(tones.core[rot], center));
        close[n - 2] -= 12;
        close.sort((a, b) => a - b);
        notes = close;
        tones.ext.forEach((pc) => notes.push(atOrAbove(pc, notes[notes.length - 1] + 1)));
        break;
      }

      case 'spread': {
        const lowPc = tones.core[bottom];
        const low = nearest(lowPc, center - 12);
        const lh = [low];
        const rootPc = mod12(chord.root);
        const fifthPc = chord.info.fifth != null ? mod12(chord.root + chord.info.fifth) : null;
        let usedFifth = false;
        if (lowPc === rootPc && fifthPc != null && tones.core.includes(fifthPc)) {
          lh.push(atOrAbove(fifthPc, low + 1));
          usedFifth = true;
        }
        let rhPcs = tones.core.filter((pc, i) => i !== bottom && !(usedFifth && pc === fifthPc));
        rhPcs = rhPcs.concat(tones.ext);
        if (!rhPcs.length) rhPcs = [lowPc];
        const rhStart = Math.max(lh[lh.length - 1] + 1, center - 2);
        notes = lh.concat(stackUp(rhPcs, atOrAbove(rhPcs[0], rhStart)));
        break;
      }

      case 'shell': {
        const lowPc = tones.core[bottom];
        const low = nearest(lowPc, center - 10);
        const i = chord.info;
        const guide = [];
        if (i.third != null) guide.push(mod12(chord.root + i.third));
        if (i.seventh != null) guide.push(mod12(chord.root + i.seventh));
        else if (i.six) guide.push(mod12(chord.root + 9));
        else if (i.fifth != null) guide.push(mod12(chord.root + i.fifth));
        const upper = guide.filter((pc) => pc !== lowPc);
        if (lowPc !== mod12(chord.root)) upper.unshift(mod12(chord.root));
        if (tones.ext.length) upper.push(tones.ext[tones.ext.length - 1]);
        notes = [low];
        upper.forEach((pc) => notes.push(atOrAbove(pc, notes[notes.length - 1] + 1)));
        break;
      }

      case 'smooth':
      default: {
        const rots = inv != null ? [bottom] : tones.core.map((_, i) => i);
        const candidates = [];
        rots.forEach((rot) => {
          const base = closeVoicing(tones, rot, center);
          [-12, 0, 12].forEach((shift) => {
            const v = base.map((p) => p + shift);
            if (v[0] < center - 10 || v[v.length - 1] > center + 24) return;
            candidates.push({ v, rot });
          });
        });
        if (!candidates.length) { notes = closeVoicing(tones, bottom, center); break; }
        const mid = center + 5;
        let best = null;
        candidates.forEach((c) => {
          const avg = c.v.reduce((a, b) => a + b, 0) / c.v.length;
          let cost;
          if (opts.prev && opts.prev.length) cost = movement(c.v, opts.prev) + Math.abs(avg - mid) * 0.35;
          else cost = Math.abs(avg - mid) * 0.5 + (c.rot === 0 ? 0 : 4);
          if (!best || cost < best.cost) best = { cost, v: c.v };
        });
        notes = best.v;
      }
    }
    return notes.map((p) => Math.max(0, Math.min(127, p))).sort((a, b) => a - b);
  }

  /** Bass window starts at E so octave 1 spans E1 (28) … D#2 (39). */
  function bassLow(octave) {
    return 12 * ((octave != null ? octave : 1) + 1) + 4;
  }
  function bassPitchFor(pc, octave) {
    return atOrAbove(pc, bassLow(octave));
  }

  /** The note the bass plays: slash bass, explicit inversion, or the root. */
  function bassPc(chord, inversion) {
    if (chord.bass != null) return chord.bass;
    const inv = resolveInversion(chord, inversion);
    if (inv != null) return mod12(chord.root + chord.core[inv]);
    return chord.root;
  }

  CF.Voicing = { voicePiano, bassPitchFor, bassPc, bassLow, resolveInversion, nearest, atOrAbove };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Voicing;
})(typeof globalThis !== 'undefined' ? globalThis : this);
