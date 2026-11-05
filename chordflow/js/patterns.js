/*
 * ChordFlow — playing patterns.
 * A pattern turns one chord span into "hits": { t, dur, pitches[], vel } with times
 * in quarter notes (absolute song time). New patterns are added with
 * CF.Patterns.register(role, def) — the UI, preview and MIDI export pick them up.
 *
 * Context `c` passed to generate():
 *   start, end        chord span (quarters)
 *   notes             piano voicing (ascending MIDI pitches)
 *   bass, fifth, octave, tones  bass pitches (tones: chord tones above the bass)
 *   next              { bass } of the following chord, or null
 *   vel               track velocity (1-127)
 *   barLen            quarters per bar
 *   bars(), beats(), grid(step), offbeats()  time helpers
 *   barHits({'4/4': [offsets]})  bar-relative hits for a meter (falls back to beats)
 *   accent(t)         velocity multiplier for metric position
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const registry = { piano: [], bass: [] };

  function register(role, def) {
    if (!registry[role]) registry[role] = [];
    registry[role].push(Object.assign({ tier: 'free' }, def));
  }

  const clipDur = (c, t, dur) => Math.max(0.05, Math.min(dur, c.end - t));
  const nextOr = (arr, i, fallback) => (i + 1 < arr.length ? arr[i + 1] : fallback);

  // ------------------------------------------------------------ piano

  register('piano', {
    id: 'block', name: 'אקורד מוחזק',
    desc: 'אקורד אחד ארוך, מוכה מחדש בכל תיבה',
    generate(c) {
      const ts = c.bars();
      return ts.map((t, i) => ({ t, dur: nextOr(ts, i, c.end) - t, pitches: c.notes, vel: c.vel * c.accent(t) }));
    },
  });

  register('piano', {
    id: 'beats', name: 'רבעים',
    desc: 'מכה על כל פעמה',
    generate(c) {
      const ts = c.beats();
      return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.92, pitches: c.notes, vel: c.vel * c.accent(t) }));
    },
  });

  register('piano', {
    id: 'eighths', name: 'שמיניות',
    desc: 'פולס של שמיניות עם הדגשה על הפעמות',
    generate(c) {
      return c.grid(0.5).map((t) => ({ t, dur: clipDur(c, t, 0.45), pitches: c.notes, vel: c.vel * c.accent(t) }));
    },
  });

  register('piano', {
    id: 'pop', name: 'סינקופה פופ',
    desc: 'מכות על 1, "וְ" של 2 ו-4 — דחיפה קצבית',
    generate(c) {
      const ts = c.barHits({ '4/4': [0, 1.5, 3], '3/4': [0, 1.5], '2/4': [0, 1.5], '12/8': [0, 1.5, 3, 4.5] });
      return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.95, pitches: c.notes, vel: c.vel * c.accent(t) }));
    },
  });

  register('piano', {
    id: 'stabs', name: 'אקצנטים על 2 ו-4',
    desc: 'אקורדים קצרים על פעמות החולשה (בקביט)',
    generate(c) {
      const ts = c.barHits({ '4/4': [1, 3], '3/4': [1, 2], '2/4': [1], '6/8': [1.5], '12/8': [1.5, 4.5] });
      const hits = ts.map((t) => ({ t, dur: clipDur(c, t, 0.3), pitches: c.notes, vel: c.vel * 0.92 }));
      if (!ts.some((t) => Math.abs(t - c.start) < 1e-6)) hits.unshift({ t: c.start, dur: clipDur(c, c.start, 0.3), pitches: c.notes, vel: c.vel });
      return hits;
    },
  });

  register('piano', {
    id: 'offbeat', name: 'אופביט (רגאיי / סקא)',
    desc: 'אקורד קצר על ה"וְ" של כל פעמה',
    generate(c) {
      return c.offbeats().map((t) => ({ t, dur: clipDur(c, t, 0.22), pitches: c.notes, vel: c.vel * 0.9 }));
    },
  });

  register('piano', {
    id: 'arpUp', name: 'ארפג׳ עולה',
    desc: 'צלילי האקורד בזה אחר זה בשמיניות',
    generate(c) {
      const n = c.notes;
      return c.grid(0.5).map((t, i) => ({ t, dur: clipDur(c, t, 1), pitches: [n[i % n.length]], vel: c.vel * c.accent(t) }));
    },
  });

  register('piano', {
    id: 'arpUpDown', name: 'ארפג׳ עולה-יורד',
    desc: 'עולה ויורד ברצף שמיניות',
    generate(c) {
      const n = c.notes;
      const seq = n.length > 2 ? n.concat(n.slice(1, -1).reverse()) : n;
      return c.grid(0.5).map((t, i) => ({ t, dur: clipDur(c, t, 0.9), pitches: [seq[i % seq.length]], vel: c.vel * c.accent(t) }));
    },
  });

  register('piano', {
    id: 'broken', name: 'ליווי שבור (בלדה)',
    desc: 'נמוך-גבוה-אמצע-גבוה, כמו יד שמאל בבלדה',
    generate(c) {
      const n = c.notes;
      const hi = n.length - 1;
      const mid = Math.max(1, Math.floor(hi / 2));
      const seq = n.length >= 3 ? [0, hi, mid, hi] : [0, hi];
      return c.grid(0.5).map((t, i) => ({ t, dur: clipDur(c, t, 1.2), pitches: [n[seq[i % seq.length]]], vel: c.vel * (i % seq.length === 0 ? 1 : 0.8) }));
    },
  });

  // ------------------------------------------------------------- bass

  register('bass', {
    id: 'sustain', name: 'צליל ארוך',
    desc: 'שורש מוחזק, מוכה בכל תיבה',
    generate(c) {
      const ts = c.bars();
      return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.97, pitches: [c.bass], vel: c.vel * c.accent(t) }));
    },
  });

  register('bass', {
    id: 'beats', name: 'רבעים',
    desc: 'שורש על כל פעמה',
    generate(c) {
      const ts = c.beats();
      return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.85, pitches: [c.bass], vel: c.vel * c.accent(t) }));
    },
  });

  register('bass', {
    id: 'rootFifth', name: 'שורש-קווינטה',
    desc: 'שורש וקווינטה לסירוגין (קאנטרי / פולק)',
    generate(c) {
      const ts = c.beats();
      return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.85, pitches: [i % 2 ? c.fifth : c.bass], vel: c.vel * c.accent(t) }));
    },
  });

  register('bass', {
    id: 'pump', name: 'שמיניות רוק',
    desc: 'שורש בשמיניות רצופות',
    generate(c) {
      return c.grid(0.5).map((t) => ({ t, dur: clipDur(c, t, 0.42), pitches: [c.bass], vel: c.vel * c.accent(t) }));
    },
  });

  register('bass', {
    id: 'octaves', name: 'אוקטבות (דיסקו)',
    desc: 'שורש ואוקטבה לסירוגין בשמיניות',
    generate(c) {
      return c.grid(0.5).map((t, i) => ({ t, dur: clipDur(c, t, 0.4), pitches: [i % 2 ? c.octave : c.bass], vel: c.vel * (i % 2 ? 0.85 : 1) }));
    },
  });

  register('bass', {
    id: 'popSync', name: 'סינקופה פופ',
    desc: 'שורש מנוקד, דחיפה ותנועה לקווינטה',
    generate(c) {
      const pattern = c.barLen === 4
        ? [[0, 'r', 1.5], [1.5, 'r', 0.5], [2, 'r', 1], [3, 'f', 0.5], [3.5, 'o', 0.5]]
        : null;
      if (!pattern) {
        const ts = c.beats();
        return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.85, pitches: [c.bass], vel: c.vel * c.accent(t) }));
      }
      const pick = { r: c.bass, f: c.fifth, o: c.octave };
      const hits = [];
      c.bars().forEach((barT) => {
        const barStart = Math.floor(barT / c.barLen + 1e-9) * c.barLen;
        pattern.forEach(([off, which, dur]) => {
          const t = barStart + off;
          if (t >= c.start - 1e-9 && t < c.end - 1e-9) hits.push({ t, dur: clipDur(c, t, dur * 0.95), pitches: [pick[which]], vel: c.vel * c.accent(t) });
        });
      });
      if (!hits.length || hits[0].t > c.start + 1e-9) hits.unshift({ t: c.start, dur: clipDur(c, c.start, 0.95), pitches: [c.bass], vel: c.vel });
      return hits;
    },
  });

  register('bass', {
    id: 'walking', name: 'ווקינג ג׳אז',
    desc: 'רבעים שמטיילים בין צלילי האקורד ומתקרבים כרומטית לאקורד הבא',
    generate(c) {
      const ts = c.beats();
      const tones = c.tones.length ? c.tones : [c.bass];
      return ts.map((t, i) => {
        let p;
        const last = i === ts.length - 1;
        if (i === 0) p = c.bass;
        else if (last && c.next && ts.length >= 2) {
          const target = c.next.bass;
          p = target > c.bass ? target - 1 : target + 1;
        } else p = tones[Math.min(i, tones.length - 1)] || c.bass;
        return { t, dur: (nextOr(ts, i, c.end) - t) * 0.9, pitches: [p], vel: c.vel * (i === 0 ? 1 : 0.88) };
      });
    },
  });

  // --------------------------------------------------------- ensemble
  // Strings, brass, woodwinds, pads. `legato: true` patterns let the arranger tie
  // common tones across chords into one long note (true voice leading).

  register('ensemble', {
    id: 'sustain', name: 'אקורד מוחזק (לגאטו)', legato: true, art: 'legato',
    desc: 'כל הקולות מוחזקים לאורך האקורד; צליל משותף נמשך לאקורד הבא',
    generate(c) { return [{ t: c.start, dur: c.end - c.start, pitches: c.notes, vel: c.vel }]; },
  });

  register('ensemble', {
    id: 'topLine', name: 'קו עליון (מלודיה)', legato: true, section: true, art: 'legato',
    desc: 'רק הקול העליון של האקורד — קו מלודי לכינור, חליל או חצוצרה',
    generate(c) { return [{ t: c.start, dur: c.end - c.start, pitches: [c.notes[c.notes.length - 1]], vel: c.vel }]; },
  });

  register('ensemble', {
    id: 'innerVoices', name: 'קולות פנימיים', legato: true, section: true, art: 'legato',
    desc: 'הקולות האמצעיים — לוויולה, קרנות או כינור שני',
    generate(c) {
      const n = c.notes;
      let inner = n.length > 2 ? n.slice(1, -1) : n.slice(0, 1);
      if (inner.length > 2) inner = inner.slice(-2); // two inner parts, not a keyboard chord
      return [{ t: c.start, dur: c.end - c.start, pitches: inner, vel: c.vel }];
    },
  });

  register('ensemble', {
    id: 'bassLine', name: 'קו תחתון', legato: true, section: true, art: 'legato',
    desc: 'הקול הנמוך — לצ׳לו, טרומבון או בסון',
    generate(c) { return [{ t: c.start, dur: c.end - c.start, pitches: [c.notes[0]], vel: c.vel }]; },
  });

  register('ensemble', {
    id: 'pulse8', name: 'אוסטינטו שמיניות', art: 'spiccato',
    desc: 'שמיניות קצרות ומניעות (ספיקטו / סטקטו)',
    generate(c) {
      return c.grid(0.5).map((t) => ({ t, dur: clipDur(c, t, 0.32), pitches: c.notes, vel: c.vel * c.accent(t) }));
    },
  });

  register('ensemble', {
    id: 'pulseLow', name: 'אוסטינטו נמוך (תו אחד)', section: true, art: 'spiccato',
    desc: 'הבס של האקורד בשמיניות קצרות — מנוע קצבי לצ׳לו, טרומבון או בסון',
    generate(c) {
      const n = c.notes[0];
      return c.grid(0.5).map((t, i) => ({ t, dur: clipDur(c, t, 0.3), pitches: [i % 4 === 2 ? n + 12 : n], vel: c.vel * c.accent(t) }));
    },
  });

  register('ensemble', {
    id: 'pulse4', name: 'רבעים מודגשים', art: 'marcato',
    desc: 'מכה על כל פעמה (מרקטו)',
    generate(c) {
      const ts = c.beats();
      return ts.map((t, i) => ({ t, dur: (nextOr(ts, i, c.end) - t) * 0.7, pitches: c.notes, vel: c.vel * c.accent(t) }));
    },
  });

  register('ensemble', {
    id: 'tremolo', name: 'טרמולו', art: 'tremolo',
    desc: 'אקורד מוחזק בארטיקולציית טרמולו — מתח קולנועי (בלי Keyswitch נכתב כחזרות מדודות)',
    generate(c) { return [{ t: c.start, dur: c.end - c.start, pitches: c.notes, vel: c.vel }]; },
  });

  register('ensemble', {
    id: 'stabs', name: 'סטאבים', art: 'staccato',
    desc: 'אקורד קצר וחזק בתחילת כל אקורד ותיבה',
    generate(c) {
      return c.bars().map((t) => ({ t, dur: clipDur(c, t, 0.4), pitches: c.notes, vel: c.vel }));
    },
  });

  register('ensemble', {
    id: 'arpUp', name: 'ארפג׳ עולה', art: 'sustain',
    desc: 'צלילי האקורד בזה אחר זה בשמיניות',
    generate(c) {
      const n = c.notes;
      return c.grid(0.5).map((t, i) => ({ t, dur: clipDur(c, t, 0.9), pitches: [n[i % n.length]], vel: c.vel * c.accent(t) }));
    },
  });

  CF.Patterns = {
    register,
    list(role) { return (registry[role] || []).filter((p) => !CF.Plans || CF.Plans.has(p.tier)); },
    get(role, id) {
      const all = registry[role] || [];
      return all.find((p) => p.id === id) || all[0];
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Patterns;
})(typeof globalThis !== 'undefined' ? globalThis : this);
