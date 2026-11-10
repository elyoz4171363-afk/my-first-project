/*
 * ChordFlow - melody input.
 *   parse(text, timeSig)   typed melody, same feel as the chord line:
 *                          "E D C D | E E E -"  (| = bar, notes share the bar, - holds, r = rest)
 *                          "E4 D C D E E E -"   (no bar lines: one note per beat)
 *                          octave optional (C4 = middle C); without it the nearest note to the previous one is used
 *   readMidi(arrayBuffer)  standard MIDI file -> tracks with notes (quarters)
 *   pickMelody(tracks)     the most melody-like track, reduced to its top voice
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const EPS = 1e-6;
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function nearestTo(pc, ref) {
    const d = ((pc - ref) % 12 + 12) % 12;
    return d > 6 ? ref + d - 12 : ref + d;
  }

  function parse(text, ts) {
    const barLen = CF.Theory.barLength(ts);
    const src = String(text || '').replace(/\r/g, '').trim();
    if (!src) return { ok: true, notes: [], errors: [], end: 0 };
    const hasBars = /[|\n]/.test(src);
    const bars = hasBars
      ? src.split(/[|\n]/).map((b) => b.trim()).filter(Boolean).map((b) => b.split(/\s+/))
      : null;
    const notes = [];
    const errors = [];
    let t = 0;
    let prev = 72;
    const one = (tok, dur, barNo) => {
      if (/^[-~.]$/.test(tok)) { const last = notes[notes.length - 1]; if (last && Math.abs(last.t + last.dur - t) < EPS) last.dur += dur; t += dur; return; }
      if (/^(r|R|_|x)$/.test(tok)) { t += dur; return; }
      const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)?$/.exec(tok);
      if (!m) { errors.push({ token: tok, bar: barNo, error: `"${tok}" אינו תו (למשל C, F#, Bb4)` }); t += dur; return; }
      const pc = (LETTER[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0) + 12) % 12;
      const pitch = m[3] != null ? (parseInt(m[3], 10) + 1) * 12 + pc : nearestTo(pc, prev);
      notes.push({ t: +t.toFixed(6), dur: +dur.toFixed(6), pitch: Math.max(0, Math.min(127, pitch)), vel: 90 });
      prev = pitch;
      t += dur;
    };
    if (bars) bars.forEach((toks, bi) => { const slot = barLen / toks.length; toks.forEach((tok) => one(tok, slot, bi + 1)); });
    else src.split(/\s+/).forEach((tok, i) => one(tok, 4 / ts.den, Math.floor(i / ts.num) + 1));
    return { ok: !errors.length, notes, errors, end: t };
  }

  // ------------------------------------------------------------- MIDI in

  function readMidi(arrayBuffer) {
    const d = new DataView(arrayBuffer);
    let o = 0;
    const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(o + i)); o += n; return s; };
    if (str(4) !== 'MThd') throw new Error('זה לא קובץ MIDI');
    const hlen = d.getUint32(o); o += 4;
    const ntrks = d.getUint16(o + 2), division = d.getUint16(o + 4);
    o += hlen;
    if (division & 0x8000) throw new Error('קובץ MIDI בתזמון SMPTE לא נתמך');
    let bpm = null, ts = null;
    const tracks = [];
    for (let k = 0; k < ntrks && o < d.byteLength; k++) {
      const id = str(4);
      const len = d.getUint32(o); o += 4;
      const end = o + len;
      if (id !== 'MTrk') { o = end; continue; }
      let tick = 0, running = 0, name = '';
      const open = {};
      const notes = [];
      const vlq = () => { let v = 0, b; do { b = d.getUint8(o++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
      while (o < end) {
        tick += vlq();
        let st = d.getUint8(o);
        if (st & 0x80) { o++; if (st < 0xf0) running = st; } else st = running;
        if (st === 0xff) {
          const type = d.getUint8(o++); const l = vlq();
          if (type === 0x03) { name = ''; for (let i = 0; i < l; i++) name += String.fromCharCode(d.getUint8(o + i)); }
          if (type === 0x51 && bpm == null) bpm = Math.round(60000000 / ((d.getUint8(o) << 16) | (d.getUint8(o + 1) << 8) | d.getUint8(o + 2)));
          if (type === 0x58 && ts == null) ts = { num: d.getUint8(o), den: Math.pow(2, d.getUint8(o + 1)) };
          o += l;
        } else if (st === 0xf0 || st === 0xf7) { o += vlq(); }
        else {
          const hi = st & 0xf0, ch = st & 15;
          const a = d.getUint8(o++), b = hi === 0xc0 || hi === 0xd0 ? 0 : d.getUint8(o++);
          const key = ch * 128 + a;
          if (hi === 0x90 && b > 0) { (open[key] = open[key] || []).push({ tick, vel: b }); }
          else if (hi === 0x80 || (hi === 0x90 && b === 0)) {
            const on = open[key] && open[key].shift();
            if (on) notes.push({ t: on.tick / division, dur: Math.max(1, tick - on.tick) / division, pitch: a, vel: on.vel, ch });
          }
        }
      }
      o = end;
      notes.sort((x, y) => x.t - y.t || y.pitch - x.pitch);
      if (notes.length) tracks.push({ name: name || `Track ${k + 1}`, notes, drums: notes.every((n) => n.ch === 9) });
    }
    return { tracks, bpm, ts };
  }

  /** Top voice (skyline) of a possibly polyphonic part. */
  function skyline(notes) {
    const out = [];
    notes.slice().sort((a, b) => a.t - b.t || b.pitch - a.pitch).forEach((n) => {
      const last = out[out.length - 1];
      if (last && Math.abs(last.t - n.t) < 0.02) return;            // same onset: keep the higher note
      if (last && last.t + last.dur > n.t) last.dur = Math.max(0.05, n.t - last.t);
      out.push(Object.assign({}, n));
    });
    return out;
  }

  /** Picks the most melody-like track: not drums, mostly single notes, highest register. */
  function pickMelody(tracks) {
    const cands = tracks.filter((t) => !t.drums && t.notes.length >= 3);
    if (!cands.length) return null;
    const score = (t) => {
      const onsets = new Set(t.notes.map((n) => Math.round(n.t * 48))).size;
      const mono = onsets / t.notes.length;
      const avg = t.notes.reduce((a, n) => a + n.pitch, 0) / t.notes.length;
      return mono * 2 + avg / 24 + Math.min(1, t.notes.length / 40);
    };
    const best = cands.slice().sort((a, b) => score(b) - score(a))[0];
    return { name: best.name, notes: skyline(best.notes).map((n) => ({ t: +n.t.toFixed(4), dur: +n.dur.toFixed(4), pitch: n.pitch, vel: n.vel })) };
  }

  CF.Melody = { parse, readMidi, pickMelody, skyline };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Melody;
})(typeof globalThis !== 'undefined' ? globalThis : this);
