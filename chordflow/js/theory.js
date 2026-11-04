/*
 * ChordFlow — music theory core.
 * Note names, keys, chord-symbol parsing, roman numerals and transposition.
 * No DOM access: this file is shared by the browser app and the Node tests.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});

  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NEUTRAL_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  const mod12 = (n) => ((n % 12) + 12) % 12;

  function normalizeAccidentals(s) {
    return String(s).replace(/♯/g, '#').replace(/♭/g, 'b');
  }

  /** Parses a note name at the start of a string ("Bb", "f#", "E"). */
  function parseNote(str) {
    const m = /^([A-Ga-g])([#b]?)/.exec(normalizeAccidentals(str));
    if (!m) return null;
    const pc = LETTER_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return { pc: mod12(pc), name: m[1].toUpperCase() + m[2], length: m[0].length };
  }

  // ---------------------------------------------------------------- keys

  const KEY_TONICS = {
    major: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
    minor: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
  };
  // Number of sharps (+) / flats (-) of the major key whose tonic has this pitch class.
  const SF_MAJOR_BY_PC = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];

  function keySignature(key) {
    const t = parseNote(key.tonic) || { pc: 0, name: 'C' };
    if (key.mode === 'minor') {
      if (t.name === 'Eb') return { sf: -6, mi: 1 };
      if (t.name === 'D#') return { sf: 6, mi: 1 };
      if (t.name === 'A#') return { sf: 7, mi: 1 };
      return { sf: SF_MAJOR_BY_PC[mod12(t.pc + 3)], mi: 1 };
    }
    if (t.name === 'Gb') return { sf: -6, mi: 0 };
    if (t.name === 'C#') return { sf: 7, mi: 0 };
    if (t.name === 'Cb') return { sf: -7, mi: 0 };
    return { sf: SF_MAJOR_BY_PC[t.pc], mi: 0 };
  }

  function spellingFor(key) {
    if (!key) return NEUTRAL_NAMES;
    const { sf } = keySignature(key);
    return sf > 0 ? SHARP_NAMES : sf < 0 ? FLAT_NAMES : NEUTRAL_NAMES;
  }

  function noteName(pc, key) {
    return spellingFor(key)[mod12(pc)];
  }

  function keyLabel(key) {
    return key.tonic + (key.mode === 'minor' ? ' מינור' : ' מז׳ור');
  }

  // ------------------------------------------------------------- chords

  function fail(input, message) {
    return { ok: false, input, error: message };
  }

  /**
   * Parses a chord symbol into pitch-class data.
   * Supports triads, sus, power, 6, 6/9, 7ths, 9/11/13, alterations (b5 #5 b9 #9 #11 b13),
   * add-tones, alt, omit, half-diminished, diminished-7th, minor-major and slash chords.
   */
  function parseChord(input) {
    if (typeof input !== 'string') return fail(String(input), 'אקורד ריק');
    const s = normalizeAccidentals(input.trim()).replace(/\s+/g, '');
    if (!s) return fail(input, 'אקורד ריק');
    const root = parseNote(s);
    if (!root) return fail(input, `"${input}" צריך להתחיל בשם תו (A–G)`);

    let rest = s.slice(root.length);
    let bass = null;
    const slash = /\/([A-Ga-g][#b]?)$/.exec(rest);
    if (slash) {
      bass = parseNote(slash[1]);
      rest = rest.slice(0, slash.index);
    }
    const suffix = rest;
    let r = rest.replace(/[(),]/g, '');

    const eat = (re) => {
      const m = re.exec(r);
      if (m) r = r.slice(m[0].length);
      return m;
    };

    let quality = 'maj'; // maj | min | dim | hdim | aug | power
    let majSeventh = false;
    let ext = 0;
    let six = false;
    let sus = null;
    let omit3 = false;
    let omit5 = false;
    const adds = [];
    const alters = new Set();
    let m;

    // quality prefix
    if (eat(/^(?:min|mi|m|-)(?:maj|Maj|MAJ|ma|M|Δ|△)/)) {
      quality = 'min';
      majSeventh = true;
      if (!/^\d/.test(r)) ext = 7;
    } else if ((m = eat(/^(?:maj|Maj|MAJ|ma|Ma|M|Δ|△)/))) {
      majSeventh = true;
      if (/[Δ△]/.test(m[0]) && !/^\d/.test(r)) ext = 7;
    } else if (eat(/^(?:min|mi|m|-)/)) {
      quality = 'min';
    } else if (eat(/^(?:dim|°|º|o)/)) {
      quality = 'dim';
    } else if (eat(/^(?:ø|Ø)/)) {
      quality = 'hdim';
    } else if (eat(/^(?:aug|\+)/)) {
      quality = 'aug';
    }

    // main number
    if (eat(/^(?:6\/9|69)/)) {
      six = true;
      adds.push(14);
    } else if ((m = eat(/^(13|11|9|7|6|5|4|2)/))) {
      const n = +m[1];
      if (n === 6) six = true;
      else if (n === 5) {
        if (quality !== 'maj' || majSeventh) return fail(input, `"${input}": ספרה 5 מתאימה רק לאקורד קווינטה (למשל C5)`);
        quality = 'power';
      } else if (n === 4) sus = 4;
      else if (n === 2) adds.push(14);
      else ext = n;
    }

    // modifiers
    while (r.length) {
      if ((m = eat(/^sus(2|4)?/))) { sus = m[1] ? +m[1] : 4; continue; }
      if ((m = eat(/^add(b9|#9|#11|b13|9|11|13|2|4|6)/))) {
        const map = { b9: 13, '#9': 15, '#11': 18, b13: 20, 9: 14, 11: 17, 13: 21, 2: 14, 4: 17, 6: 21 };
        adds.push(map[m[1]]);
        continue;
      }
      if ((m = eat(/^(?:b|-)(5|9|13)/))) { alters.add('b' + m[1]); continue; }
      if ((m = eat(/^(?:#|\+)(5|9|11)/))) { alters.add('#' + m[1]); continue; }
      if (eat(/^alt/)) { alters.add('alt'); if (ext < 7) ext = 7; continue; }
      if ((m = eat(/^(?:no|omit)(3|5)/))) { if (m[1] === '3') omit3 = true; else omit5 = true; continue; }
      if ((m = eat(/^(?:maj|Maj|M|Δ|△)(7|9|11|13)/))) { majSeventh = true; ext = Math.max(ext, +m[1]); continue; }
      if ((m = eat(/^(13|11|9|7)/))) { ext = Math.max(ext, +m[1]); continue; }
      return fail(input, `לא הצלחתי לפענח את "${input}"`);
    }

    // build
    let third = quality === 'min' || quality === 'dim' || quality === 'hdim' ? 3 : 4;
    if (quality === 'power') third = null;
    if (sus === 2) third = 2;
    else if (sus === 4) third = 5;
    if (omit3) third = null;

    let fifth = quality === 'dim' || quality === 'hdim' ? 6 : quality === 'aug' ? 8 : 7;
    if (alters.has('b5')) fifth = 6;
    if (alters.has('#5')) fifth = 8;
    if (omit5) fifth = null;

    if (quality === 'hdim' && ext < 7) ext = 7;
    let seventh = null;
    if (ext >= 7) seventh = majSeventh ? 11 : quality === 'dim' ? 9 : 10;

    const extIv = new Set();
    if (ext >= 9) extIv.add(14);
    if (ext === 11) {
      extIv.add(17);
      if (third === 4) third = null; // dominant 11 is voiced without the clashing 3rd
    }
    if (ext >= 13) {
      extIv.add(21);
      if (third === 3) extIv.add(17);
    }
    adds.forEach((a) => extIv.add(a));
    if (six && seventh != null) extIv.add(21);

    if (alters.has('alt')) {
      fifth = null;
      extIv.delete(14); extIv.delete(21);
      extIv.add(13); extIv.add(15); extIv.add(20);
    }
    if (alters.has('b9')) { extIv.delete(14); extIv.add(13); }
    if (alters.has('#9')) { extIv.delete(14); extIv.add(15); }
    if (alters.has('#11')) { extIv.delete(17); extIv.add(18); }
    if (alters.has('b13')) { extIv.delete(21); extIv.add(20); }

    const core = [0];
    if (third != null) core.push(third);
    if (fifth != null) core.push(fifth);
    if (seventh != null) core.push(seventh);
    else if (six) core.push(9);

    const corePcs = new Set(core.map(mod12));
    const extList = [...extIv].sort((a, b) => a - b).filter((iv) => !corePcs.has(mod12(iv)));

    const isMinor = third === 3;
    const isDim = third === 3 && fifth === 6;
    return {
      ok: true,
      input,
      root: root.pc,
      rootName: root.name,
      suffix,
      bass: bass ? bass.pc : null,
      bassName: bass ? bass.name : null,
      core,
      ext: extList,
      intervals: core.concat(extList),
      symbol: root.name + suffix + (bass ? '/' + bass.name : ''),
      info: {
        third, fifth, seventh, six,
        minor: isMinor,
        dim: isDim && seventh !== 10,
        hdim: isDim && seventh === 10,
        aug: third === 4 && fifth === 8,
        power: quality === 'power',
      },
    };
  }

  /** Pitch classes of the chord (core first, then extensions). */
  function chordPitchClasses(chord) {
    return chord.intervals.map((iv) => mod12(chord.root + iv));
  }

  /** ASCII-only chord name for MIDI meta events. */
  function asciiSymbol(symbol) {
    return normalizeAccidentals(symbol)
      .replace(/[øØ]7?/g, 'm7b5')
      .replace(/[°º]/g, 'dim')
      .replace(/[Δ△]7?/g, 'maj7')
      .replace(/[^\x20-\x7e]/g, '');
  }

  function transposeSymbol(symbol, semis, key) {
    const c = parseChord(symbol);
    if (!c.ok) return symbol;
    let out = noteName(c.root + semis, key) + c.suffix;
    if (c.bass != null) out += '/' + noteName(c.bass + semis, key);
    return out;
  }

  // ------------------------------------------------- diatonic / numerals

  const DIATONIC = {
    major: {
      degrees: [0, 2, 4, 5, 7, 9, 11],
      triads: ['', 'm', 'm', '', '', 'm', 'dim'],
      sevenths: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'],
      numerals: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
    },
    minor: {
      degrees: [0, 2, 3, 5, 7, 8, 10],
      triads: ['m', 'dim', '', 'm', '', '', ''],
      sevenths: ['m7', 'm7b5', 'maj7', 'm7', '7', 'maj7', '7'],
      numerals: ['i', 'ii°', 'III', 'iv', 'V', 'VI', 'VII'],
    },
  };

  function diatonicChords(key, sevenths) {
    const d = DIATONIC[key.mode === 'minor' ? 'minor' : 'major'];
    const tonic = (parseNote(key.tonic) || { pc: 0 }).pc;
    return d.degrees.map((deg, i) => ({
      numeral: d.numerals[i],
      symbol: noteName(tonic + deg, key) + (sevenths ? d.sevenths[i] : d.triads[i]),
    }));
  }

  const NUMERALS_MAJOR = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
  const NUMERALS_MINOR = ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII'];

  function romanNumeral(chord, key) {
    if (!chord || !chord.ok) return '';
    const tonic = (parseNote(key.tonic) || { pc: 0 }).pc;
    const deg = mod12(chord.root - tonic);
    let n = (key.mode === 'minor' ? NUMERALS_MINOR : NUMERALS_MAJOR)[deg];
    const i = chord.info;
    if (i.minor || i.dim || i.hdim) n = n.replace(/[IV]+/, (x) => x.toLowerCase());
    let suf = '';
    if (i.hdim) suf = 'ø7';
    else if (i.dim) suf = i.seventh === 9 ? '°7' : '°';
    else if (i.aug) suf = '+';
    if (!i.hdim && i.seventh === 10) suf += '7';
    if (i.seventh === 11) suf += 'maj7';
    if (i.six && i.seventh == null) suf += '6';
    if (i.power) suf = '5';
    if (i.third === 5 || i.third === 2) suf += 'sus';
    return n + suf;
  }

  // Progression templates: [semitones from tonic, chord suffix, bars]
  const TEMPLATES = [
    { id: 'pop', name: 'פופ  I–V–vi–IV', steps: [[0, '', 1], [7, '', 1], [9, 'm', 1], [5, '', 1]] },
    { id: 'doowop', name: 'שנות ה-50  I–vi–IV–V', steps: [[0, '', 1], [9, 'm', 1], [5, '', 1], [7, '', 1]] },
    { id: 'ii-v-i', name: 'ג׳אז  ii–V–I', steps: [[2, 'm7', 1], [7, '7', 1], [0, 'maj7', 2]] },
    { id: 'jazz-turn', name: 'טרנאראונד ג׳אז  I–vi–ii–V', steps: [[0, 'maj7', 1], [9, 'm7', 1], [2, 'm7', 1], [7, '7', 1]] },
    { id: 'blues', name: 'בלוז 12 תיבות', steps: [[0, '7', 4], [5, '7', 2], [0, '7', 2], [7, '7', 1], [5, '7', 1], [0, '7', 1], [7, '7', 1]] },
    { id: 'canon', name: 'קנון  I–V–vi–iii–IV–I–IV–V', steps: [[0, '', 1], [7, '', 1], [9, 'm', 1], [4, 'm', 1], [5, '', 1], [0, '', 1], [5, '', 1], [7, '', 1]] },
    { id: 'minor-epic', name: 'מינורי  i–VI–III–VII', steps: [[0, 'm', 1], [8, '', 1], [3, '', 1], [10, '', 1]] },
    { id: 'andalusian', name: 'אנדלוסי  i–VII–VI–V', steps: [[0, 'm', 1], [10, '', 1], [8, '', 1], [7, '', 1]] },
    { id: 'soul', name: 'סול  IVmaj7–iii7–ii7–Imaj7', steps: [[5, 'maj7', 1], [4, 'm7', 1], [2, 'm7', 1], [0, 'maj7', 1]] },
  ];

  /** Renders a template as progression text in the given key. */
  function templateText(tpl, key) {
    const tonic = (parseNote(key.tonic) || { pc: 0 }).pc;
    const bars = [];
    tpl.steps.forEach(([deg, suf, n]) => {
      bars.push(noteName(tonic + deg, key) + suf);
      for (let i = 1; i < n; i++) bars.push('-');
    });
    return bars.join(' | ');
  }

  // ------------------------------------------------------------- meter

  /** Beat offsets inside one bar, in quarter notes. */
  function beatOffsets(ts) {
    const num = ts.num, den = ts.den;
    if (den === 8) {
      if (num % 3 === 0) {
        const out = [];
        for (let i = 0; i < num / 3; i++) out.push(i * 1.5);
        return out;
      }
      // odd meters: groups of 2 eighths, last group of 3 (5/8 = 2+3, 7/8 = 2+2+3)
      const groups = [];
      let left = num;
      while (left > 0) {
        if (left === 3 || left === 1) { groups.push(left); left = 0; } else { groups.push(2); left -= 2; }
      }
      const out = [];
      let acc = 0;
      groups.forEach((g) => { out.push(acc * 0.5); acc += g; });
      return out;
    }
    const step = 4 / den;
    const out = [];
    for (let i = 0; i < num; i++) out.push(i * step);
    return out;
  }

  function barLength(ts) {
    return (ts.num * 4) / ts.den;
  }

  CF.Theory = {
    mod12,
    SHARP_NAMES, FLAT_NAMES, NEUTRAL_NAMES, KEY_TONICS, TEMPLATES, DIATONIC,
    parseNote, parseChord, chordPitchClasses, asciiSymbol, transposeSymbol,
    keySignature, spellingFor, noteName, keyLabel,
    diatonicChords, romanNumeral, templateText,
    beatOffsets, barLength,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Theory;
})(typeof globalThis !== 'undefined' ? globalThis : this);
