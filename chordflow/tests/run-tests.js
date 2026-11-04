#!/usr/bin/env node
/* ChordFlow — engine tests. Run: node chordflow/tests/run-tests.js */
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
