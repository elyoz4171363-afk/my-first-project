#!/usr/bin/env node
/* ChordFlow - engine tests. Run: node chordflow/tests/run-tests.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CF = require('./load.js');
const T = CF.Theory, P = CF.Project;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}
const pcs = (sym) => { const c = T.parseChord(sym); assert.ok(c.ok, sym + ': ' + c.error); return [...new Set(T.chordPitchClasses(c))].sort((a, b) => a - b); };

// ------------------------------------------------------------------ MIDI reader (independent of the writer)
function readMidi(buf) {
  let o = 0;
  const str = (n) => { const s = buf.toString('latin1', o, o + n); o += n; return s; };
  const u32 = () => { const v = buf.readUInt32BE(o); o += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(o); o += 2; return v; };
  assert.strictEqual(str(4), 'MThd');
  assert.strictEqual(u32(), 6);
  const format = u16(), ntrks = u16(), division = u16();
  const tracks = [];
  for (let t = 0; t < ntrks; t++) {
    assert.strictEqual(str(4), 'MTrk', 'track header ' + t);
    const len = u32();
    const end = o + len;
    const events = [];
    let tick = 0, running = null, sawEnd = false;
    const vlq = () => { let v = 0, b; let n = 0; do { b = buf[o++]; v = (v << 7) | (b & 0x7f); n++; assert.ok(n <= 4, 'vlq too long'); } while (b & 0x80); return v; };
    while (o < end) {
      tick += vlq();
      let status = buf[o];
      if (status & 0x80) { o++; running = status < 0xf0 ? status : running; } else { assert.ok(running, 'running status without status'); status = running; }
      if (status === 0xff) {
        const type = buf[o++]; const l = vlq(); const data = buf.slice(o, o + l); o += l;
        events.push({ tick, meta: type, data });
        if (type === 0x2f) { sawEnd = true; assert.strictEqual(o, end, 'End of Track must be last'); }
      } else if (status === 0xf0 || status === 0xf7) {
        const l = vlq(); o += l;
      } else {
        const hi = status & 0xf0, ch = status & 0x0f;
        const d1 = buf[o++];
        const d2 = hi === 0xc0 || hi === 0xd0 ? null : buf[o++];
        assert.ok(d1 < 128 && (d2 == null || d2 < 128), 'data byte out of range');
        events.push({ tick, type: hi, ch, d1, d2 });
      }
    }
    assert.ok(sawEnd, 'missing End of Track');
    tracks.push(events);
  }
  assert.strictEqual(o, buf.length, 'trailing bytes');
  return { format, ntrks, division, tracks };
}

console.log('\nTheory');
test('basic triads', () => {
  assert.deepStrictEqual(pcs('C'), [0, 4, 7]);
  assert.deepStrictEqual(pcs('Am'), [0, 4, 9]);
  assert.deepStrictEqual(pcs('Bdim'), [2, 5, 11]);
  assert.deepStrictEqual(pcs('Caug'), [0, 4, 8]);
  assert.deepStrictEqual(pcs('Dsus4'), [2, 7, 9]);
  assert.deepStrictEqual(pcs('Dsus2'), [2, 4, 9]);
  assert.deepStrictEqual(pcs('E5'), [4, 11]);
});
test('sevenths and extensions', () => {
  assert.deepStrictEqual(pcs('G7'), [2, 5, 7, 11]);
  assert.deepStrictEqual(pcs('Cmaj7'), [0, 4, 7, 11]);
  assert.deepStrictEqual(pcs('CΔ'), [0, 4, 7, 11]);
  assert.deepStrictEqual(pcs('Dm7'), [0, 2, 5, 9]);
  assert.deepStrictEqual(pcs('Bm7b5'), [2, 5, 9, 11]);
  assert.deepStrictEqual(pcs('Bø'), [2, 5, 9, 11]);
  assert.deepStrictEqual(pcs('Bdim7'), [2, 5, 8, 11]);
  assert.deepStrictEqual(pcs('CmMaj7'), [0, 3, 7, 11]);
  assert.deepStrictEqual(pcs('Cm(maj7)'), [0, 3, 7, 11]);
  assert.deepStrictEqual(pcs('C9'), [0, 2, 4, 7, 10]);
  assert.deepStrictEqual(pcs('Cmaj9'), [0, 2, 4, 7, 11]);
  assert.deepStrictEqual(pcs('C13'), [0, 2, 4, 7, 9, 10]);
  assert.deepStrictEqual(pcs('C6'), [0, 4, 7, 9]);
  assert.deepStrictEqual(pcs('C6/9'), [0, 2, 4, 7, 9]);
  assert.deepStrictEqual(pcs('C7b9'), [0, 1, 4, 7, 10]);
  assert.deepStrictEqual(pcs('C7#9'), [0, 3, 4, 7, 10]);
  assert.deepStrictEqual(pcs('C7(b9,#11)'), [0, 1, 4, 6, 7, 10]);
  assert.deepStrictEqual(pcs('Cadd9'), [0, 2, 4, 7]);
  assert.deepStrictEqual(pcs('C7sus4'), [0, 5, 7, 10]);
  assert.deepStrictEqual(pcs('C7#5'), [0, 4, 8, 10]);
});
test('accidentals and slash chords', () => {
  assert.deepStrictEqual(pcs('F#m'), [1, 6, 9]);
  assert.deepStrictEqual(pcs('Bbmaj7'), [2, 5, 9, 10]);
  assert.deepStrictEqual(pcs('E♭'), [3, 7, 10]);
  const c = T.parseChord('C/E');
  assert.strictEqual(c.bass, 4);
  assert.strictEqual(T.parseChord('Am/G').bass, 7);
  assert.strictEqual(T.parseChord('am').symbol, 'Am');
});
test('invalid symbols are rejected', () => {
  ['H7', 'Cxyz', '', '7', 'Cm5'].forEach((s) => assert.ok(!T.parseChord(s).ok, s));
});
test('key signatures', () => {
  assert.deepStrictEqual(T.keySignature({ tonic: 'C', mode: 'major' }), { sf: 0, mi: 0 });
  assert.deepStrictEqual(T.keySignature({ tonic: 'Bb', mode: 'major' }), { sf: -2, mi: 0 });
  assert.deepStrictEqual(T.keySignature({ tonic: 'E', mode: 'major' }), { sf: 4, mi: 0 });
  assert.deepStrictEqual(T.keySignature({ tonic: 'A', mode: 'minor' }), { sf: 0, mi: 1 });
  assert.deepStrictEqual(T.keySignature({ tonic: 'C', mode: 'minor' }), { sf: -3, mi: 1 });
  assert.deepStrictEqual(T.keySignature({ tonic: 'F#', mode: 'minor' }), { sf: 3, mi: 1 });
});
test('roman numerals and transposition', () => {
  const key = { tonic: 'C', mode: 'major' };
  assert.strictEqual(T.romanNumeral(T.parseChord('Am'), key), 'vi');
  assert.strictEqual(T.romanNumeral(T.parseChord('G7'), key), 'V7');
  assert.strictEqual(T.romanNumeral(T.parseChord('Dm7'), key), 'ii7');
  assert.strictEqual(T.romanNumeral(T.parseChord('Bm7b5'), key), 'viiø7');
  assert.strictEqual(T.transposeSymbol('Am7/G', 2, { tonic: 'D', mode: 'major' }), 'Bm7/A');
  assert.strictEqual(T.transposeSymbol('C', -2, { tonic: 'Bb', mode: 'major' }), 'Bb');
});
test('meters', () => {
  assert.deepStrictEqual(T.beatOffsets({ num: 4, den: 4 }), [0, 1, 2, 3]);
  assert.deepStrictEqual(T.beatOffsets({ num: 6, den: 8 }), [0, 1.5]);
  assert.deepStrictEqual(T.beatOffsets({ num: 7, den: 8 }), [0, 1, 2]);
  assert.strictEqual(T.barLength({ num: 6, den: 8 }), 3);
});

test('odd-meter groupings', () => {
  assert.deepStrictEqual(T.beatOffsets({ num: 7, den: 8, groups: [3, 2, 2] }), [0, 1.5, 2.5]);
  assert.deepStrictEqual(T.beatOffsets({ num: 7, den: 8, groups: [2, 3, 2] }), [0, 1, 2.5]);
  assert.deepStrictEqual(T.beatOffsets({ num: 5, den: 8, groups: [3, 2] }), [0, 1.5]);
  assert.deepStrictEqual(T.beatOffsets({ num: 7, den: 8, groups: [3, 3] }), [0, 1, 2], 'invalid grouping falls back');
  assert.deepStrictEqual(T.beatOffsets({ num: 11, den: 8 }), [0, 1, 2, 3, 4]);
});
test('metronome follows the meter', () => {
  const grid = (ts, mode) => {
    const p = P.create({ progression: 'C' });
    p.timeSig = ts; p.metro = { volume: 0.7, mode };
    p.chords = P.parseProgression('C', ts).chords;
    return CF.Arranger.arrange(p).beatGrid.map((g) => g.t + ':' + g.level).join(' ');
  };
  assert.strictEqual(grid({ num: 6, den: 8 }, 'auto'), '0:0 0.5:2 1:2 1.5:1 2:2 2.5:2');
  assert.strictEqual(grid({ num: 7, den: 8 }, 'auto'), '0:0 0.5:2 1:1 1.5:2 2:1 2.5:2 3:2');
  assert.strictEqual(grid({ num: 7, den: 8, groups: [3, 2, 2] }, 'auto'), '0:0 0.5:2 1:2 1.5:1 2:2 2.5:1 3:2');
  assert.strictEqual(grid({ num: 6, den: 8 }, 'beats'), '0:0 1.5:1');
  assert.strictEqual(grid({ num: 4, den: 4 }, 'auto'), '0:0 1:1 2:1 3:1');
  assert.strictEqual(grid({ num: 3, den: 4 }, 'subdiv'), '0:0 0.5:2 1:1 1.5:2 2:1 2.5:2');
});
test('grouping and metronome survive save/load', () => {
  const p = P.create({});
  p.timeSig = { num: 7, den: 8, groups: [2, 3, 2] };
  p.metro = { volume: 0.25, mode: 'beats' };
  const n = P.normalize(JSON.parse(JSON.stringify(p)));
  assert.deepStrictEqual(n.timeSig, { num: 7, den: 8, groups: [2, 3, 2] });
  assert.deepStrictEqual(n.metro, { volume: 0.25, mode: 'beats' });
  assert.deepStrictEqual(P.normalize({ chords: [] }).metro, { volume: 0.7, mode: 'auto' });
});

console.log('\nProgression text');
test('one chord per bar without bar lines', () => {
  const r = P.parseProgression('Am F C G', { num: 4, den: 4 });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.chords.map((c) => [c.symbol, c.start, c.length]), [['Am', 0, 4], ['F', 4, 4], ['C', 8, 4], ['G', 12, 4]]);
});
test('bar lines, splits, holds, repeat, rest', () => {
  const r = P.parseProgression('C - - G | F | - | % | NC | Dm7', { num: 4, den: 4 });
  const r2 = P.parseProgression('Am | % | F', { num: 4, den: 4 });
  assert.deepStrictEqual(r2.chords.map((c) => [c.symbol, c.start]), [['Am', 0], ['Am', 4], ['F', 8]]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.chords.map((c) => [c.symbol, c.start, c.length]),
    [['C', 0, 3], ['G', 3, 1], ['F', 4, 12], ['Dm7', 20, 4]]);
});
test('errors report the bar', () => {
  const r = P.parseProgression('C | Hm | G', { num: 4, den: 4 });
  assert.ok(!r.ok);
  assert.strictEqual(r.errors[0].bar, 2);
});
test('serialize round-trip', () => {
  const ts = { num: 4, den: 4 };
  ['C | Am | F G | G7', 'C - - G | F | - | Dm7', 'Am | NC | E7'].forEach((txt) => {
    const a = P.parseProgression(txt, ts).chords;
    const b = P.parseProgression(P.serializeProgression(a, ts), ts).chords;
    assert.deepStrictEqual(b.map((c) => [c.symbol, c.start, c.length]), a.map((c) => [c.symbol, c.start, c.length]), txt);
  });
});
test('normalize repairs bad data', () => {
  const p = P.normalize({ name: 'x', bpm: 9999, timeSig: { num: 3, den: 5 }, chords: [{ symbol: 'C', start: -3, length: 0 }],
    tracks: [{ id: 'a', instrument: 'violins', pattern: 'nope', register: 99, dyn: { level: 'zz', velMin: 120, velMax: 10 } }] });
  assert.strictEqual(p.bpm, 300);
  assert.strictEqual(p.timeSig.den, 4);
  assert.strictEqual(p.chords[0].start, 0);
  assert.ok(p.chords[0].length > 0);
  const t = p.tracks[0];
  assert.strictEqual(t.family, 'strings');
  assert.strictEqual(t.pattern, 'sustain');
  assert.strictEqual(t.register, 2);
  assert.strictEqual(t.dyn.level, 'mp');
  assert.ok(t.dyn.velMax >= t.dyn.velMin);
});
test('version 1 projects migrate (piano/bass tracks)', () => {
  const p = P.normalize({ name: 'old', chords: [{ symbol: 'C', start: 0, length: 4 }], humanize: false,
    tracks: [{ id: 'piano', role: 'piano', instrument: 'grand', pattern: 'arpUp', voicing: 'drop2', octave: 5, velocity: 60 },
      { id: 'bass', role: 'bass', instrument: 'upright', pattern: 'walking', octave: 1, velocity: 110 }] });
  assert.deepStrictEqual(p.tracks.map((t) => [t.id, t.family, t.pattern, t.register, t.dyn.level]),
    [['piano', 'keys', 'arpUp', 1, 'mp'], ['bass', 'bass', 'walking', 0, 'f']]);
  assert.strictEqual(p.tracks[0].dyn.humanize, 0);
  assert.ok(p.dynamics && Array.isArray(p.dynamics.points));
});
test('version 2 projects get the wider velocity defaults', () => {
  const p = P.normalize({ version: 2, chords: [], tracks: [{ id: 'a', instrument: 'grand', family: 'keys', dyn: { level: 'mf', velMin: 38, velMax: 112 } },
    { id: 'b', instrument: 'grand', family: 'keys', dyn: { level: 'mf', velMin: 50, velMax: 90 } }] });
  assert.deepStrictEqual([p.tracks[0].dyn.velMin, p.tracks[0].dyn.velMax], [20, 120]);
  assert.deepStrictEqual([p.tracks[1].dyn.velMin, p.tracks[1].dyn.velMax], [50, 90], 'custom ranges stay');
});
test('every ensemble builds valid tracks on separate channels', () => {
  P.ENSEMBLES.forEach((e) => {
    const tracks = P.ensembleTracks(e.id);
    assert.ok(tracks.length >= 2, e.id);
    const ch = tracks.map((t) => t.channel);
    assert.strictEqual(new Set(ch).size, ch.length, e.id + ' channels unique');
    assert.ok(!ch.includes(9), e.id + ' avoids drum channel');
    tracks.forEach((t) => assert.ok(CF.Patterns.list(CF.Families.get(t.family).role).some((x) => x.id === t.pattern), e.id + ' ' + t.pattern));
  });
});
test('backup read/write', () => {
  const p = P.create({ name: 'גיבוי' });
  const list = P.readBackup(JSON.stringify(P.backupOf([p])));
  assert.strictEqual(list[0].name, 'גיבוי');
  assert.strictEqual(list[0].chords.length, p.chords.length);
  assert.throws(() => P.readBackup('{"x":1}'));
  assert.throws(() => P.readBackup('not json'));
});

console.log('\nVoicing & arranging');
test('voicings contain the chord tones', () => {
  ['C', 'Am7', 'G7', 'Fmaj7', 'Bm7b5', 'E7#9', 'Dm9', 'C/E'].forEach((s) => {
    const c = T.parseChord(s);
    ['smooth', 'close', 'drop2', 'spread'].forEach((v) => {
      const notes = CF.Voicing.voicePiano(c, { voicing: v, octave: 4, inversion: 'auto' });
      const got = new Set(notes.map((n) => n % 12));
      const want = new Set(c.core.map((iv) => (c.root + iv) % 12));
      if (c.core.length + c.ext.length > 5) want.delete((c.root + 7) % 12);
      want.forEach((pc) => assert.ok(got.has(pc), `${s} ${v} missing pc ${pc}: ${notes}`));
      notes.forEach((n) => assert.ok(n >= 36 && n <= 96, `${s} ${v} out of range ${n}`));
    });
  });
});
test('inversions put the right note on the bottom', () => {
  const c = T.parseChord('C');
  assert.strictEqual(CF.Voicing.voicePiano(c, { voicing: 'close', octave: 4, inversion: '1' })[0] % 12, 4);
  assert.strictEqual(CF.Voicing.voicePiano(c, { voicing: 'close', octave: 4, inversion: '2' })[0] % 12, 7);
  assert.strictEqual(CF.Voicing.voicePiano(c, { voicing: 'drop2', octave: 4, inversion: '1' })[0] % 12, 4);
  assert.strictEqual(CF.Voicing.voicePiano(T.parseChord('C/G'), { voicing: 'smooth', octave: 4, inversion: 'auto' })[0] % 12, 7);
  assert.strictEqual(CF.Voicing.bassPc(T.parseChord('C'), '1'), 4);
  assert.strictEqual(CF.Voicing.bassPc(T.parseChord('Am/G'), 'auto'), 7);
});
test('every pattern produces valid notes in every meter', () => {
  ['4/4', '3/4', '6/8', '7/8', '12/8', '5/4'].forEach((tsStr) => {
    const [num, den] = tsStr.split('/').map(Number);
    CF.Patterns.list('piano').forEach((pp) => CF.Patterns.list('bass').forEach((bp) => {
      const p = P.create({ progression: 'Am7 | D7 G7 | Cmaj7 | Bm7b5 E7#9 | Am/G' });
      p.timeSig = { num, den };
      p.chords = P.parseProgression('Am7 | D7 G7 | Cmaj7 | Bm7b5 E7#9 | Am/G', p.timeSig).chords;
      p.tracks[0].pattern = pp.id;
      p.tracks[1].pattern = bp.id;
      p.swing = 50;
      const arr = CF.Arranger.arrange(p);
      arr.tracks.forEach((t) => {
        assert.ok(t.notes.length > 0, `${tsStr} ${pp.id}/${bp.id} ${t.id} produced no notes`);
        t.notes.forEach((n) => {
          assert.ok(n.t >= 0 && n.t < arr.songEnd + 1e-6, 'note start in song');
          assert.ok(n.dur > 0 && n.t + n.dur <= arr.songEnd + 0.2, `${tsStr} ${pp.id}/${bp.id} note end ${n.t + n.dur} > ${arr.songEnd}`);
          assert.ok(n.pitch >= 0 && n.pitch <= 127 && n.vel >= 1 && n.vel <= 127);
        });
        const byPitch = {};
        t.notes.forEach((n) => {
          const prev = byPitch[n.pitch];
          if (prev) assert.ok(prev.t + prev.dur <= n.t + 1e-6, `overlap on pitch ${n.pitch} ${tsStr} ${pp.id}/${bp.id}`);
          byPitch[n.pitch] = n;
        });
      });
    }));
  });
});
test('notes stay inside their chord span', () => {
  const p = P.create({ progression: 'C - G | Am' });
  p.tracks[0].pattern = 'arpUp';
  const arr = CF.Arranger.arrange(p);
  arr.tracks[0].notes.forEach((n) => {
    const ch = p.chords.find((c) => n.t >= c.start - 1e-6 && n.t < c.start + c.length);
    assert.ok(ch, 'note at ' + n.t + ' has a chord');
    assert.ok(n.t + n.dur <= ch.start + ch.length + 1e-6, 'note crosses chord end');
  });
});
test('arrangement is deterministic (preview == export)', () => {
  const p = P.create({});
  const a = JSON.stringify(CF.Arranger.arrange(p).tracks.map((t) => t.notes));
  const b = JSON.stringify(CF.Arranger.arrange(p).tracks.map((t) => t.notes));
  assert.strictEqual(a, b);
});

console.log('\nDynamics & expression');
const dynOf = (p, id) => CF.Arranger.arrange(p).tracks.find((t) => t.id === id);
test('louder level gives higher velocities', () => {
  const p = P.create({ progression: 'C | Am | F | G' });
  p.dynamics = { preset: 'flat', points: [{ t: 0, v: 0.5 }] };
  const t = p.tracks[0];
  const avg = (lvl) => { t.dyn.level = lvl; const n = dynOf(p, t.id).notes; return n.reduce((a, x) => a + x.vel, 0) / n.length; };
  const vals = ['pp', 'p', 'mp', 'mf', 'f', 'ff'].map(avg);
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] > vals[i - 1], 'level ' + i + ': ' + vals.join(','));
});
test('velocities stay inside the chosen range', () => {
  const p = P.create({ progression: 'C | Am | F | G | C' });
  const t = p.tracks[0];
  t.dyn = Object.assign(t.dyn, { velMin: 50, velMax: 70, humanize: 0, accent: 0, level: 'ff', emotion: 100 });
  dynOf(p, t.id).notes.forEach((n) => assert.ok(n.vel >= 50 && n.vel <= 70, 'vel ' + n.vel));
});
test('song curve drives a crescendo', () => {
  const p = P.create({ progression: 'C | C | C | C | C | C | C | C' });
  const t = p.tracks[0];
  t.dyn.shape = 'flat'; t.dyn.humanize = 0; t.dyn.emotion = 80;
  p.dynamics = { preset: 'build', points: CF.Dynamics.presetPoints('build', 32, 4) };
  const notes = dynOf(p, t.id).notes;
  const first = notes.filter((n) => n.t < 4), last = notes.filter((n) => n.t >= 28);
  const avg = (a) => a.reduce((s, n) => s + n.vel, 0) / a.length;
  assert.ok(avg(last) - avg(first) > 20, `crescendo ${avg(first)} -> ${avg(last)}`);
});
test('swell shape writes rising and falling CC1 inside each chord', () => {
  const p = P.create({ progression: 'C | F', ensemble: 'ballad' });
  p.dynamics = { preset: 'flat', points: [{ t: 0, v: 0.5 }] };
  const strings = p.tracks.find((t) => t.family === 'strings' && t.pattern === 'sustain');
  strings.dyn.shape = 'swell';
  const at = dynOf(p, strings.id);
  const cc1 = at.cc.filter((c) => c.cc === 1);
  const valAt = (t) => cc1.filter((c) => c.t <= t + 1e-9).pop().v;
  assert.ok(valAt(2) > valAt(0) + 10 && valAt(2) > valAt(3.75) + 5, `swell ${valAt(0)} ${valAt(2)} ${valAt(3.75)}`);
  assert.ok(at.cc.some((c) => c.cc === 11), 'CC11 present');
  assert.ok(!at.cc.some((c) => c.cc === 2), 'CC2 off by default');
  at.cc.forEach((c) => assert.ok(c.v >= 0 && c.v <= 127));
});
test('legato ties common tones across chords', () => {
  const p = P.create({ progression: 'C | Am', ensemble: 'ballad' });
  const strings = p.tracks.find((t) => t.family === 'strings' && t.pattern === 'sustain');
  const notes = dynOf(p, strings.id).notes;
  const tied = notes.filter((n) => n.t === 0 && n.dur > 4);
  assert.ok(tied.length >= 1, 'C and E are shared by C and Am: ' + JSON.stringify(notes));
});
test('orchestral lines stay in their instrument range', () => {
  const p = P.create({ progression: 'Am7 | D9 | Gmaj7 | Cmaj7 | F#m7b5 | B7b9 | Em9 | E7#9', ensemble: 'cinematic' });
  const arr = CF.Arranger.arrange(p);
  arr.tracks.forEach((at) => {
    const inst = CF.Instruments.get(at.track.instrument);
    at.notes.forEach((n) => assert.ok(n.pitch >= inst.range[0] - 2 && n.pitch <= inst.range[1] + 2, `${inst.id} ${n.pitch}`));
  });
});

console.log('\nMIDI export');
const outDir = process.env.CHORDFLOW_MIDI_OUT || path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
function exportProject(p, name, opts) {
  const arr = CF.Arranger.arrange(p);
  const bytes = CF.Midi.build(p, arr, opts);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(bytes));
  return { arr, midi: readMidi(Buffer.from(bytes)), file };
}
test('valid SMF type 1 with conductor + 2 tracks', () => {
  const p = P.create({ name: 'בדיקה Test', progression: 'Am7 | D7 | Gmaj7 | Cmaj7 | F#m7b5 | B7b9 | Em | E7' });
  p.bpm = 123; p.key = { tonic: 'E', mode: 'minor' };
  p.tracks[0].pattern = 'pop'; p.tracks[1].pattern = 'walking';
  const { midi, arr } = exportProject(p, 'test-4-4.mid');
  assert.strictEqual(midi.format, 1);
  assert.strictEqual(midi.ntrks, 3);
  assert.strictEqual(midi.division, 480);
  const cond = midi.tracks[0];
  const tempo = cond.find((e) => e.meta === 0x51).data;
  assert.strictEqual((tempo[0] << 16) | (tempo[1] << 8) | tempo[2], Math.round(60000000 / 123));
  assert.deepStrictEqual([...cond.find((e) => e.meta === 0x58).data], [4, 2, 24, 8]);
  const ks = cond.find((e) => e.meta === 0x59).data;
  assert.strictEqual(ks[0], 1); assert.strictEqual(ks[1], 1); // E minor: 1 sharp, minor
  const markers = cond.filter((e) => e.meta === 0x06).map((e) => e.data.toString('latin1'));
  assert.deepStrictEqual(markers, ['Am7', 'D7', 'Gmaj7', 'Cmaj7', 'F#m7b5', 'B7b9', 'Em', 'E7']);
  const endTick = arr.songEnd * 480;
  midi.tracks.forEach((tr) => assert.strictEqual(tr[tr.length - 1].tick, endTick, 'track length = song length'));
  [[1, 0, 'Piano', 0], [2, 1, 'Electric Bass', 33]].forEach(([ti, ch, name, prog]) => {
    const tr = midi.tracks[ti];
    assert.strictEqual(tr.find((e) => e.meta === 0x03).data.toString('latin1'), name);
    const pc = tr.find((e) => e.type === 0xc0);
    assert.strictEqual(pc.ch, ch); assert.strictEqual(pc.d1, prog);
    const ons = tr.filter((e) => e.type === 0x90 && e.d2 > 0);
    const offs = tr.filter((e) => e.type === 0x80 || (e.type === 0x90 && e.d2 === 0));
    assert.ok(ons.length > 0);
    assert.strictEqual(ons.length, offs.length, 'balanced note on/off');
    tr.filter((e) => e.type).forEach((e) => assert.strictEqual(e.ch, ch, 'channel separation'));
    const open = {};
    tr.forEach((e) => {
      if (e.type === 0x90 && e.d2 > 0) { assert.ok(!open[e.d1], `note ${e.d1} retriggered while on at ${e.tick}`); open[e.d1] = true; }
      if (e.type === 0x80) { assert.ok(open[e.d1], `note-off without note-on ${e.d1}`); open[e.d1] = false; }
    });
    assert.ok(Object.values(open).every((v) => !v), 'all notes closed');
  });
});
test('compound meter, flat key, track selection, no markers', () => {
  const p = P.create({ name: 'Waltz', progression: 'Bb | Gm | Eb | F7' });
  p.timeSig = { num: 6, den: 8 };
  p.chords = P.parseProgression('Bb | Gm | Eb | F7', p.timeSig).chords;
  p.key = { tonic: 'Bb', mode: 'major' };
  p.tracks[0].instrument = 'epiano';
  const { midi } = exportProject(p, 'test-6-8.mid', { trackIds: [p.tracks[0].id], markers: false });
  assert.strictEqual(midi.ntrks, 2);
  assert.deepStrictEqual([...midi.tracks[0].find((e) => e.meta === 0x58).data], [6, 3, 36, 8]);
  assert.strictEqual(midi.tracks[0].find((e) => e.meta === 0x59).data[0], 0xfe); // -2 flats
  assert.strictEqual(midi.tracks[0].filter((e) => e.meta === 0x06).length, 0);
  assert.strictEqual(midi.tracks[1].find((e) => e.type === 0xc0).d1, 4);
});
test('orchestral export carries CC1/CC11 on each channel, before notes', () => {
  const p = P.create({ name: 'Orchestra', progression: 'Dm | Bb | F | C | Gm | A7', ensemble: 'cinematic' });
  const { midi, arr } = exportProject(p, 'test-orchestra.mid');
  assert.strictEqual(midi.ntrks, 1 + p.tracks.length);
  p.tracks.forEach((tr, i) => {
    const ev = midi.tracks[i + 1];
    const ccs = ev.filter((e) => e.type === 0xb0 && (e.d1 === 1 || e.d1 === 11));
    assert.ok(ccs.length > 4, tr.name + ' has CC curve');
    ev.filter((e) => e.type).forEach((e) => assert.strictEqual(e.ch, tr.channel, 'channel'));
    const firstNote = ev.findIndex((e) => e.type === 0x90);
    const firstCC1 = ev.findIndex((e) => e.type === 0xb0 && e.d1 === 1);
    assert.ok(firstCC1 >= 0 && firstCC1 < firstNote, 'CC1 set before first note');
    const at = arr.tracks[i];
    assert.strictEqual(ccs.length, at.cc.filter((c) => c.cc === 1 || c.cc === 11).length);
  });
  const noCC = CF.Midi.build(p, arr, { cc: false });
  const parsed = readMidi(Buffer.from(noCC));
  assert.ok(!parsed.tracks.slice(1).some((tr) => tr.some((e) => e.type === 0xb0 && (e.d1 === 1 || e.d1 === 11))), 'cc:false removes curves');
});
test('every pattern exports a clean file', () => {
  CF.Patterns.list('piano').forEach((pp, i) => {
    const bp = CF.Patterns.list('bass')[i % CF.Patterns.list('bass').length];
    const p = P.create({ progression: 'C | Am7 | Dm7 G7 | C - Cmaj7/E' });
    p.tracks[0].pattern = pp.id; p.tracks[1].pattern = bp.id; p.swing = 33;
    exportProject(p, `pattern-${pp.id}-${bp.id}.mid`);
  });
});

console.log('\nSong form');
test('section labels parse, survive round trip and attach to the right bars', () => {
  const ts = { num: 4, den: 4 };
  const r = P.parseProgression('[פתיחה] Am | F | [בית] C G | Am | [פזמון 2] F | G [גשר] | Em', ts);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.sections.map((x) => [x.label, x.start]), [['פתיחה', 0], ['בית', 8], ['פזמון 2', 16], ['גשר', 24]]);
  const secs = r.sections.map((x) => P.makeSection(x.label, x.start));
  assert.deepStrictEqual(secs.map((x) => x.type), ['intro', 'verse', 'chorus', 'bridge']);
  const back = P.parseProgression(P.serializeProgression(r.chords, ts, secs), ts);
  assert.deepStrictEqual(back.sections.map((x) => [x.label, x.start]), r.sections.map((x) => [x.label, x.start]));
  assert.deepStrictEqual(P.parseProgression('[Verse] Am F [Chorus] C G', ts).sections.map((x) => x.start), [0, 8]);
});
test('sections rest, re-pattern and re-level instruments', () => {
  const p = P.create({ ensemble: 'ballad', progression: '[בית] Am | F | C | G | [פזמון] F | G | Em | Am' });
  const strings = p.tracks.find((t) => t.instrument === 'stringsEns'), horns = p.tracks.find((t) => t.instrument === 'horns');
  p.sections[0].tracks[horns.id] = { on: false };
  p.sections[0].tracks[strings.id] = { on: true, level: 'pp' };
  p.sections[1].tracks[strings.id] = { on: true, pattern: 'pulse8', level: 'ff' };
  const arr = CF.Arranger.arrange(p);
  const at = (id) => arr.tracks.find((t) => t.id === id).notes;
  assert.strictEqual(at(horns.id).filter((n) => n.t < 16).length, 0, 'horns rest in the verse');
  assert.ok(at(horns.id).filter((n) => n.t >= 16).length > 0, 'horns play in the chorus');
  const v = at(strings.id).filter((n) => n.t < 16), c = at(strings.id).filter((n) => n.t >= 16);
  assert.ok(c.length > v.length * 4, 'chorus uses the eighth-note pattern');
  const avg = (a) => a.reduce((x, n) => x + n.vel, 0) / a.length;
  assert.ok(avg(c) - avg(v) > 25, `chorus louder: ${avg(v)} -> ${avg(c)}`);
});
test('section markers in the MIDI file and saved projects keep sections', () => {
  const p = P.create({ progression: '[בית] C | G | [פזמון] F | C | [Bridge] Am | G' });
  const midi = readMidi(Buffer.from(CF.Midi.build(p, CF.Arranger.arrange(p))));
  const marks = midi.tracks[0].filter((e) => e.meta === 0x06).map((e) => e.data.toString('latin1'));
  ['[Verse 1]', '[Chorus 1]', '[Bridge]'].forEach((m) => assert.ok(marks.includes(m), m + ' in ' + marks.join(',')));
  const n = P.normalize(JSON.parse(JSON.stringify(p)));
  assert.deepStrictEqual(n.sections.map((x) => [x.type, x.name, x.start]), p.sections.map((x) => [x.type, x.name, x.start]));
});
test('full-song templates parse with their sections', () => {
  T.TEMPLATES.filter((t) => t.id.startsWith('song')).forEach((tpl) => {
    const r = P.parseProgression(T.templateText(tpl, { tonic: 'D', mode: 'major' }), { num: 4, den: 4 });
    assert.ok(r.ok && r.sections.length >= 2, tpl.id + ' ' + JSON.stringify(r.errors));
  });
});

console.log('\nArticulations & keyswitches');
test('notes carry articulations from patterns and instruments', () => {
  const p = P.create({ ensemble: 'cinematic', progression: 'Dm | Bb | F | C' });
  p.tracks.find((t) => t.instrument === 'stringsEns').pattern = 'tremolo';
  p.tracks.push(P.makeTrack('pizz', p.tracks));
  const arr = CF.Arranger.arrange(p);
  const arts = (inst) => [...new Set(arr.tracks.find((t) => t.track.instrument === inst).notes.map((n) => n.art))];
  assert.deepStrictEqual(arts('stringsEns'), ['tremolo']);
  assert.deepStrictEqual(arts('violins'), ['legato']);
  assert.deepStrictEqual(arts('pizz'), ['pizzicato']);
  const trem = arr.tracks.find((t) => t.track.instrument === 'stringsEns').notes;
  assert.ok(trem.every((n) => n.dur >= 3.9), 'tremolo is one held note per chord');
});
test('keyswitch notes are written before each articulation change', () => {
  const p = P.create({ ensemble: 'cinematic', progression: '[בית] Dm | Bb | [פזמון] F | C' });
  const strings = p.tracks.find((t) => t.instrument === 'stringsEns');
  strings.pattern = 'sustain';
  p.sections[1].tracks[strings.id] = { on: true, pattern: 'pulse8' };
  const map = CF.Articulations.defaultMap(); map.spiccato = 40;
  const arr = CF.Arranger.arrange(p);
  const idx = p.tracks.indexOf(strings) + 1;
  const midi = readMidi(Buffer.from(CF.Midi.build(p, arr, { keyswitch: { enabled: true, map, trackIds: [strings.id] } })));
  const ons = midi.tracks[idx].filter((e) => e.type === 0x90);
  const ksOn = ons.filter((e) => e.d1 === map.legato || e.d1 === 40);
  assert.deepStrictEqual(ksOn.map((e) => e.d1), [map.legato, 40], 'legato at the start, remapped spiccato at the chorus');
  const firstMusic = ons.find((e) => e.d1 !== map.legato && e.d1 !== 40);
  assert.ok(ksOn[0].tick <= firstMusic.tick, 'keyswitch before the first note');
  const chorusTick = 8 * 480;
  assert.ok(ksOn[1].tick < chorusTick && ksOn[1].tick > chorusTick - 30, 'spiccato keyswitch just before the chorus');
  // other tracks get no keyswitches
  const other = midi.tracks[idx === 1 ? 2 : 1].filter((e) => e.type === 0x90 && e.d1 < 31);
  assert.strictEqual(other.length, 0);
});
test('without keyswitches a tremolo is written as measured repeats', () => {
  const p = P.create({ ensemble: 'cinematic', progression: 'Dm' });
  const strings = p.tracks.find((t) => t.instrument === 'stringsEns');
  strings.pattern = 'tremolo';
  const arr = CF.Arranger.arrange(p);
  const held = arr.tracks.find((t) => t.id === strings.id).notes.length;
  const midi = readMidi(Buffer.from(CF.Midi.build(p, arr)));
  const ons = midi.tracks[p.tracks.indexOf(strings) + 1].filter((e) => e.type === 0x90).length;
  assert.ok(ons >= held * 15, `16th repeats: ${held} held notes -> ${ons} note-ons`);
});

console.log('\nChord sheet');
test('chord sheet: sections, repeats, numerals and transposing instruments', () => {
  const p = P.create({ name: 'שיר לבדיקה', progression: '[בית] C | Am | Am | F | [פזמון] G | C' });
  const concert = CF.Sheet.build(p, { numerals: true });
  assert.ok(concert.includes('<h2>בית</h2>') && concert.includes('<h2>פזמון</h2>'), 'section headings');
  assert.ok(concert.includes('class="rpt">%'), 'repeated bar shown as %');
  assert.ok(/<span class="ch">Am<small>vi<\/small>/.test(concert), 'roman numerals');
  const bb = CF.Sheet.build(p, { transposition: 'bb' });
  assert.ok(/<span class="ch">D<\/span>/.test(bb) && /<span class="ch">Bm<\/span>/.test(bb), 'Bb instruments read C as D, Am as Bm');
  assert.ok(bb.includes('D מז׳ור'), 'written key');
  const f = CF.Sheet.build(p, { transposition: 'f' });
  assert.ok(/<span class="ch">G<\/span>/.test(f), 'horn in F reads C as G');
});

console.log('\nMelody');
test('typed melody: bars, holds, rests, octaves and nearest-note contour', () => {
  const ts = { num: 4, den: 4 };
  const r = CF.Melody.parse('E D C D | E E E - | r G4 G -', ts);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.notes.map((n) => [n.pitch, n.t, n.dur]), [[76, 0, 1], [74, 1, 1], [72, 2, 1], [74, 3, 1], [76, 4, 1], [76, 5, 1], [76, 6, 2], [67, 9, 1], [67, 10, 2]]);
  assert.deepStrictEqual(CF.Melody.parse('C4 E G C5', ts).notes.map((n) => [n.pitch, n.dur]), [[60, 1], [64, 1], [67, 1], [72, 1]]);
  assert.ok(!CF.Melody.parse('C H', ts).ok);
});
test('melody MIDI import picks the melodic line', () => {
  const p = P.create({ ensemble: 'quartet', progression: 'C | Am | F | G' });
  const bytes = Buffer.from(CF.Midi.build(p, CF.Arranger.arrange(p)));
  const midi = CF.Melody.readMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  assert.strictEqual(midi.bpm, p.bpm);
  const pick = CF.Melody.pickMelody(midi.tracks);
  assert.strictEqual(pick.name, 'Violin 1', 'the top line wins');
  for (let i = 1; i < pick.notes.length; i++) assert.ok(pick.notes[i].t >= pick.notes[i - 1].t + pick.notes[i - 1].dur - 1e-6, 'monophonic');
});
test('the accompaniment stays under the melody and the melody is exported', () => {
  const p = P.create({ ensemble: 'ballad', progression: 'C | Am | F | G' });
  p.melody.notes = CF.Melody.parse('E4 D C D | E E E - | D D D - | E G G -', p.timeSig).notes;
  const mt = P.makeTrack('violins', p.tracks, { melody: true, name: 'מלודיה', midiName: 'Melody' });
  p.tracks.push(mt);
  const arr = CF.Arranger.arrange(p);
  const mel = arr.tracks.find((t) => t.id === mt.id).notes;
  assert.strictEqual(mel.length, 13);
  let bad = 0;
  arr.tracks.filter((t) => !t.track.melody && t.track.family !== 'bass').forEach((t) => t.notes.forEach((n) => {
    const m = mel.filter((x) => x.t < n.t + n.dur - 1e-6 && x.t + x.dur > n.t + 1e-6);
    if (m.length && n.pitch >= Math.min(...m.map((x) => x.pitch))) bad++;
  }));
  assert.strictEqual(bad, 0, 'no accompaniment note at or above the melody');
  const midi = readMidi(Buffer.from(CF.Midi.build(p, arr)));
  const melTrack = midi.tracks.find((tr) => tr.some((e) => e.meta === 0x03 && e.data.toString('latin1') === 'Melody'));
  assert.ok(melTrack && melTrack.filter((e) => e.type === 0x90).length === 13);
  // switching the protection off lets the voicing go where it wants
  p.melody.avoid = false;
  assert.ok(P.normalize(JSON.parse(JSON.stringify(p))).melody.notes.length === 13, 'melody survives save/load');
});

console.log('\nOrchestration & golden files');
test('section voicing: bass line plays the real bass, top line sits above inner voices', () => {
  const p = P.create({ ensemble: 'quartet', progression: 'C | Am/E | F | G7 | Em7 | A7 | Dm7 | G7sus4 G7' });
  p.perform = { pedal: false, legatoMs: 0, humanize: 0 };
  const arr = CF.Arranger.arrange(p);
  const by = (pat) => arr.tracks.find((t) => t.track.pattern === pat);
  const cello = by('bassLine'), vln = by('topLine'), mid = by('innerVoices');
  p.chords.forEach((c) => {
    const parsed = T.parseChord(c.symbol);
    const want = CF.Voicing.bassPc(parsed, c.inversion);
    const n = cello.notes.find((x) => x.t <= c.start + 1e-6 && x.t + x.dur > c.start + 1e-6);
    assert.ok(n, 'cello note at ' + c.start);
    assert.strictEqual(n.pitch % 12, want, `${c.symbol}: cello plays ${n.pitch % 12}, bass is ${want}`);
    const top = vln.notes.find((x) => x.t <= c.start + 1e-6 && x.t + x.dur > c.start + 1e-6);
    const inner = mid.notes.filter((x) => x.t <= c.start + 1e-6 && x.t + x.dur > c.start + 1e-6);
    assert.ok(inner.length >= 1 && inner.length <= 2, 'one or two inner parts, got ' + inner.length);
    inner.forEach((x) => assert.ok(top.pitch >= x.pitch, `${c.symbol}: violin ${top.pitch} below inner ${x.pitch}`));
  });
});
test('performance: CC64 pedal on keys, up at each chord change and down after it', () => {
  const p = P.create({ ensemble: 'pianoBass', progression: 'C | Am | F | G' });
  const arr = CF.Arranger.arrange(p);
  const keys = arr.tracks.find((t) => t.track.family === 'keys');
  const bass = arr.tracks.find((t) => t.track.family === 'bass');
  const ped = keys.cc.filter((c) => c.cc === 64);
  assert.ok(ped.length >= 8, 'pedal events: ' + ped.length);
  [4, 8, 12].forEach((t) => {
    assert.ok(ped.some((c) => Math.abs(c.t - t) < 1e-6 && c.v === 0), 'pedal up at ' + t);
    assert.ok(ped.some((c) => c.t > t && c.t < t + 0.2 && c.v === 127), 'pedal down after ' + t);
  });
  assert.strictEqual(ped[ped.length - 1].v, 0, 'pedal released at the end');
  assert.ok(!bass.cc.some((c) => c.cc === 64), 'no pedal on bass');
  const bytes = CF.Midi.build(p, arr);
  const m = readMidi(Buffer.from(bytes));
  const cc64 = m.tracks.flat().filter((e) => e.type === 0xb0 && e.d1 === 64);
  assert.strictEqual(cc64.length, ped.length, 'CC64 written to the file');
  p.perform.pedal = false;
  assert.ok(!CF.Arranger.arrange(p).tracks.some((t) => t.cc.some((c) => c.cc === 64)), 'pedal can be turned off');
});
test('performance: legato notes overlap the next note; off leaves them touching', () => {
  const p = P.create({ ensemble: 'quartet', progression: 'C | F | G | C' });
  const lineOf = (arr) => arr.tracks.find((t) => t.track.pattern === 'topLine').notes.filter((n) => n.art === 'legato');
  p.perform = { pedal: false, legatoMs: 0, humanize: 0 };
  const flat = lineOf(CF.Arranger.arrange(p));
  p.perform.legatoMs = 60;
  const ov = lineOf(CF.Arranger.arrange(p));
  const q = 60 * p.bpm / 60000;
  let overlapped = 0;
  ov.forEach((n, i) => {
    const d = n.dur - flat[i].dur;
    assert.ok(Math.abs(d) < 1e-6 || Math.abs(d - q) < 1e-6, 'overlap is 0 or 60 ms');
    if (d > 1e-6) { overlapped++; const next = ov.find((m) => Math.abs(m.t - (flat[i].t + flat[i].dur)) < 1e-6); assert.ok(next && next.pitch !== n.pitch, 'overlap only into a different pitch'); }
  });
  assert.ok(overlapped >= 1, 'at least one legato overlap');
});
test('performance: timing humanisation stays within +-18 ms, is repeatable, and 0 is exact', () => {
  const p = P.create({ ensemble: 'ballad', progression: 'Am | F | C | G | Dm | E7' });
  p.perform = { pedal: false, legatoMs: 0, humanize: 0 };
  const exact = CF.Arranger.arrange(p);
  p.perform.humanize = 100;
  const a = CF.Arranger.arrange(p), b = CF.Arranger.arrange(p);
  const lim = (18 * 1.25 + 0.01) * p.bpm / 60000;
  let moved = 0;
  a.tracks.forEach((at, ti) => {
    const ref = exact.tracks[ti].notes.slice().sort((x, y) => x.t - y.t || x.pitch - y.pitch);
    const got = at.notes.slice().sort((x, y) => x.t - y.t || x.pitch - y.pitch);
    assert.strictEqual(got.length, ref.length);
    got.forEach((n) => { const r = ref.reduce((best, x) => (x.pitch === n.pitch && Math.abs(x.t - n.t) < Math.abs(best.t - n.t) ? x : best), { t: 1e9 }); assert.ok(Math.abs(r.t - n.t) <= lim, `moved ${(n.t - r.t) / p.bpm * 60000} ms`); if (Math.abs(r.t - n.t) > 1e-9) moved++; });
    assert.deepStrictEqual(at.notes.map((n) => n.t), b.tracks[ti].notes.map((n) => n.t), 'same result twice');
  });
  assert.ok(moved > 10, 'notes actually move: ' + moved);
});
test('project v4 -> v5: older projects open with pedal and overlap off (sound unchanged)', () => {
  const old = JSON.parse(JSON.stringify(P.create({ progression: 'C | G' })));
  old.version = 4; delete old.perform;
  const p = P.normalize(old);
  assert.deepStrictEqual(p.perform, { pedal: false, legatoMs: 0, humanize: 0 });
  assert.deepStrictEqual(P.normalize(JSON.parse(JSON.stringify(P.create({})))).perform, { pedal: true, legatoMs: 40, humanize: 0 });
  assert.strictEqual(P.normalize({ version: 5, perform: { legatoMs: 999, humanize: -4 } }).perform.legatoMs, 120);
});
test('Expression Map: well-formed XML, one slot per articulation, keyswitch notes from the map', () => {
  const p = P.create({ progression: 'C' });
  p.keyswitch.map.legato = 36;
  const x = CF.Midi.expressionMap(p);
  assert.ok(x.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  // tag balance (a small XML check without a parser)
  const stack = [];
  x.replace(/<\?[^>]*\?>/, '').replace(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g, (m, close, name, self) => {
    if (self) return m;
    if (close) assert.strictEqual(stack.pop(), name, 'closing ' + name);
    else stack.push(name);
    return m;
  });
  assert.strictEqual(stack.length, 0, 'all tags closed');
  assert.strictEqual((x.match(/class="PSoundSlot"/g) || []).length, CF.Articulations.list.length);
  const remotes = [...x.matchAll(/name="remote"[^>]*>\s*<int name="status" value="144"\/>\s*<int name="data1" value="(\d+)"/g)].map((m) => +m[1]);
  assert.deepStrictEqual(remotes, CF.Articulations.list.map((a) => p.keyswitch.map[a.id]));
  assert.ok(remotes[0] === 36 && /value="Legato"/.test(x));
  const ids = [...x.matchAll(/ID="(\d+)"/g)].map((m) => m[1]);
  const defs = [...x.matchAll(/<obj class="[A-Za-z]+"[^>]*ID="(\d+)"[^/]*?>/g)].map((m) => m[1]);
  assert.strictEqual(new Set(defs).size, defs.length, 'each object defined once');
  assert.ok(!/\u2014|\u2013/.test(x), 'no long dashes');
  assert.ok(ids.length > 40);
});
test('piano roll edit: a hand-edited track plays exactly its notes, in the preview data and in the file', () => {
  const p = P.create({ ensemble: 'pianoBass', progression: 'C | G | Am | F' });
  const tr = p.tracks[0];
  tr.edit = { notes: [{ t: 0, dur: 1, pitch: 60, vel: 100 }, { t: 1.5, dur: 0.5, pitch: 64, vel: 40, art: 'staccato' }, { t: 20, dur: 2, pitch: 67, vel: 127 }], cc: { 11: [{ t: 0, v: 30 }, { t: 2, v: 120 }] } };
  const arr = CF.Arranger.arrange(p);
  const at = arr.tracks[0];
  assert.deepStrictEqual(at.notes.map((n) => [n.t, n.dur, n.pitch, n.vel]), [[0, 1, 60, 100], [1.5, 0.5, 64, 40], [20, 2, 67, 127]]);
  assert.ok(arr.songEnd >= 22, 'song end covers edited notes: ' + arr.songEnd);
  assert.deepStrictEqual(at.cc.filter((c) => c.cc === 11).map((c) => [c.t, c.v]), [[0, 30], [2, 120]], 'edited CC11 replaces the generated one');
  assert.ok(Math.abs(at.curve[1].d - 120 / 127) < 1e-3, 'preview expression follows edited CC11');
  assert.ok(at.cc.some((c) => c.cc === 64), 'automatic pedal still there when CC64 is not edited');
  // other tracks are untouched
  const auto = CF.Arranger.arrange(Object.assign({}, p, { tracks: [Object.assign({}, tr, { edit: null }), p.tracks[1]] }));
  assert.deepStrictEqual(arr.tracks[1].notes.map((n) => n.pitch), auto.tracks[1].notes.map((n) => n.pitch).concat([]).slice(0, arr.tracks[1].notes.length));
  // file
  const m = readMidi(Buffer.from(CF.Midi.build(p, arr)));
  const ons = m.tracks[1].filter((e) => e.type === 0x90 && e.d2 > 0);
  assert.deepStrictEqual(ons.map((e) => [e.tick, e.d1, e.d2]), [[0, 60, 100], [720, 64, 40], [9600, 67, 127]]);
  // edited CC64 decides the preview sustain
  tr.edit.cc[64] = [{ t: 0, v: 127 }, { t: 3, v: 0 }];
  const a2 = CF.Arranger.arrange(p).tracks[0];
  assert.deepStrictEqual(a2.pedalUps, [3]);
  assert.strictEqual(a2.cc.filter((c) => c.cc === 64).length, 2);
});
test('project v5 -> v6: no edits, master volume 1; edits are cleaned and kept through save/load', () => {
  const old = JSON.parse(JSON.stringify(P.create({ progression: 'C | G' })));
  old.version = 5; delete old.master; old.tracks.forEach((t) => delete t.edit);
  const p = P.normalize(old);
  assert.deepStrictEqual(p.master, { volume: 1 });
  assert.ok(p.tracks.every((t) => t.edit === null));
  old.tracks[0].edit = { notes: [{ t: 2, dur: 1, pitch: 200, vel: 0, art: 'bogus' }, { t: 'x' }, { t: 0, dur: 0.5, pitch: 60, vel: 90, art: 'legato' }], cc: { 1: [{ t: 0, v: 300 }], 7: [{ t: 0, v: 1 }] } };
  old.master = { volume: 9 };
  const q = P.normalize(JSON.parse(JSON.stringify(old)));
  assert.deepStrictEqual(q.tracks[0].edit.notes, [{ t: 0, dur: 0.5, pitch: 60, vel: 90, art: 'legato' }, { t: 2, dur: 1, pitch: 127, vel: 1 }]);
  assert.deepStrictEqual(q.tracks[0].edit.cc, { 1: [{ t: 0, v: 127 }] });
  assert.strictEqual(q.master.volume, 1.5);
  assert.deepStrictEqual(P.normalize(JSON.parse(JSON.stringify(q))).tracks[0].edit, q.tracks[0].edit, 'round trip');
});
test('master volume scales CC7 in the file', () => {
  const p = P.create({ ensemble: 'pianoBass', progression: 'C' });
  p.tracks[0].volume = 0.8; p.master.volume = 0.5;
  const m = readMidi(Buffer.from(CF.Midi.build(p, CF.Arranger.arrange(p))));
  const cc7 = m.tracks[1].find((e) => e.type === 0xb0 && e.d1 === 7);
  assert.strictEqual(cc7.d2, Math.round(0.4 * 127));
});
test('no close intervals in the low register', () => {
  ['C', 'Am7', 'G7', 'Fmaj9', 'Dm7b5'].forEach((s) => ['close', 'smooth', 'drop2', 'spread', 'shell'].forEach((v) => {
    const notes = CF.Voicing.voicePiano(T.parseChord(s), { voicing: v, center: 50, inversion: 'auto' });
    for (let i = 1; i < notes.length; i++) if (notes[i] < 52) assert.ok(notes[i] - notes[i - 1] >= 7, `${s} ${v}: ${notes}`);
  }));
});
test('song curve: duplicates merge, order kept', () => {
  const out = CF.Dynamics.tidyCurve([{ t: 4, v: 0.2 }, { t: 0, v: 0.5 }, { t: 4.01, v: 0.9 }, { t: 8, v: 0.4 }]);
  assert.deepStrictEqual(out, [{ t: 0, v: 0.5 }, { t: 4.01, v: 0.9 }, { t: 8, v: 0.4 }]);
});
test('CC11 is the slow layer, CC1 carries the per-chord shape (smoothed)', () => {
  const p = P.create({ ensemble: 'ballad', progression: 'C | F | G | C' });
  p.dynamics = { preset: 'flat', points: [{ t: 0, v: 0.5 }] };
  const tr = p.tracks.find((t) => t.family === 'strings' && t.pattern === 'sustain');
  tr.dyn.shape = 'cresc';
  const at = CF.Arranger.arrange(p).tracks.find((t) => t.id === tr.id);
  const cc1 = at.cc.filter((c) => c.cc === 1).map((c) => c.v), cc11 = at.cc.filter((c) => c.cc === 11).map((c) => c.v);
  assert.ok(new Set(cc11).size <= 2, 'flat song curve -> CC11 constant: ' + cc11.join(','));
  assert.ok(Math.max(...cc1) - Math.min(...cc1) > 20, 'CC1 moves with the shape');
  for (let i = 1; i < cc1.length; i++) assert.ok(Math.abs(cc1[i] - cc1[i - 1]) <= 25, 'no sudden CC1 jump: ' + cc1[i - 1] + '->' + cc1[i]);
});

// Golden MIDI files: any engine change that alters exports must be deliberate.
// Regenerate after an intended change with:  CHORDFLOW_UPDATE_GOLDEN=1 node chordflow/tests/run-tests.js
const GOLDEN = path.join(__dirname, 'golden');
[['ballad', 'Am | F | C | G | Dm7 | E7sus4 E7 | Am | -', { num: 4, den: 4 }],
 ['cinematic', 'Dm | Bb | F | C | Gm | A7', { num: 4, den: 4 }],
 ['quartet', 'Em | C | G | D/F# | Am7 | B7', { num: 6, den: 8 }]].forEach(([ens, prog, ts]) => {
  test(`golden MIDI: ${ens} ${ts.num}/${ts.den}`, () => {
    const p = P.create({ name: 'Golden ' + ens, ensemble: ens, progression: '' });
    p.id = 'golden-' + ens;
    p.tracks.forEach((t, i) => { t.id = 't' + i; });
    p.timeSig = ts;
    p.chords = P.parseProgression(prog, ts).chords.map((c, i) => Object.assign(c, { id: 'c' + i }));
    p.dynamics = { preset: 'arc', points: CF.Dynamics.presetPoints('arc', CF.Arranger.songEndOf(p), T.barLength(ts)) };
    const bytes = Buffer.from(CF.Midi.build(p, CF.Arranger.arrange(p)));
    readMidi(bytes);
    const file = path.join(GOLDEN, `${ens}.mid`);
    if (process.env.CHORDFLOW_UPDATE_GOLDEN || !fs.existsSync(file)) { fs.mkdirSync(GOLDEN, { recursive: true }); fs.writeFileSync(file, bytes); }
    assert.ok(Buffer.compare(fs.readFileSync(file), bytes) === 0, `export of ${ens} changed (run with CHORDFLOW_UPDATE_GOLDEN=1 if intended)`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
