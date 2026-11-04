/*
 * ChordFlow — dynamics & expression engine.
 *
 * A track's loudness at any moment ("d", 0..1) combines three things:
 *   1. its base level      — a score marking: pp p mp mf f ff
 *   2. the song curve      — one global intensity line drawn on the timeline (0..1, 0.5 = neutral)
 *   3. its own shape       — swell per chord, phrase arcs, crescendo, pulse …
 * "Emotion" (0..100) scales how far 2 and 3 move away from the base level.
 *
 * From d we derive:
 *   Velocity (note-on)     inside the track's velocity range, plus metric accents and humanisation
 *   CC1  Modulation        the dynamics fader of orchestral libraries (layer crossfade)
 *   CC11 Expression        volume shaping, never dropping to silence
 *   CC2  Breath            optional, for wind libraries that read breath control
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});

  const LEVELS = [
    { id: 'pp', name: 'pianissimo', he: 'חלש מאוד', value: 0.16 },
    { id: 'p', name: 'piano', he: 'חלש', value: 0.3 },
    { id: 'mp', name: 'mezzo-piano', he: 'בינוני-חלש', value: 0.45 },
    { id: 'mf', name: 'mezzo-forte', he: 'בינוני-חזק', value: 0.6 },
    { id: 'f', name: 'forte', he: 'חזק', value: 0.76 },
    { id: 'ff', name: 'fortissimo', he: 'חזק מאוד', value: 0.92 },
  ];
  const levelValue = (id) => (LEVELS.find((l) => l.id === id) || LEVELS[3]).value;

  /** Per-track shapes. Each returns -0.5 … +0.5 around the base level. */
  const SHAPES = [
    { id: 'flat', name: 'קבוע', desc: 'עוצמה יציבה (לפי עקומת השיר בלבד)', fn: () => 0 },
    { id: 'swell', name: 'נשימה לכל אקורד', desc: 'מתחיל רך, מתעצם באמצע ונרגע — כלי קשת ופדים', fn: (x) => Math.sin(Math.PI * x.chord) - 0.5 },
    { id: 'phrase', name: 'קשת של משפט', desc: 'עולה ויורד לאורך כל משפט של 4 תיבות', fn: (x) => Math.sin(Math.PI * x.phrase) - 0.5 },
    { id: 'cresc', name: 'קרשנדו לכל אקורד', desc: 'כל אקורד מתחזק לקראת הבא — דחיפה קדימה', fn: (x) => x.chord - 0.5 },
    { id: 'dim', name: 'דימינואנדו לכל אקורד', desc: 'כל אקורד נכנס חזק ודועך', fn: (x) => 0.5 - x.chord },
    { id: 'pulse', name: 'דופק של תיבה', desc: 'ראש התיבה חזק והשאר נרגע — תחושת ריקוד', fn: (x) => 0.45 - x.bar },
  ];

  /** Song-curve presets (t as fraction of the song, value 0..1). */
  const CURVE_PRESETS = [
    { id: 'flat', name: 'קבוע', points: (n) => [[0, 0.5], [1, 0.5]] },
    { id: 'build', name: 'בנייה הדרגתית', points: () => [[0, 0.22], [1, 0.9]] },
    { id: 'fade', name: 'דעיכה', points: () => [[0, 0.85], [1, 0.2]] },
    { id: 'arc', name: 'קשת — שיא באמצע', points: () => [[0, 0.3], [0.62, 0.9], [1, 0.35]] },
    { id: 'climax', name: 'בנייה לשיא בסוף', points: () => [[0, 0.3], [0.5, 0.5], [0.85, 0.95], [1, 0.8]] },
    { id: 'waves', name: 'גלים (כל 4 תיבות)', points: (phrases) => {
      const pts = [];
      const n = Math.max(1, phrases);
      for (let i = 0; i < n; i++) { pts.push([i / n, 0.38]); pts.push([(i + 0.6) / n, 0.72]); }
      pts.push([1, 0.4]);
      return pts;
    } },
    { id: 'verseChorus', name: 'בית ופזמון', points: () => [[0, 0.35], [0.48, 0.42], [0.5, 0.8], [0.95, 0.85], [1, 0.6]] },
  ];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Builds the song-curve point list for a preset. */
  function presetPoints(presetId, songEnd, barLen) {
    const preset = CURVE_PRESETS.find((p) => p.id === presetId) || CURVE_PRESETS[0];
    const phrases = Math.max(1, Math.round(songEnd / (barLen * 4)));
    return preset.points(phrases).map(([x, v]) => ({ t: +(x * songEnd).toFixed(4), v: clamp(v, 0, 1) }));
  }

  /** Song intensity at time t (linear between points; 0.5 when the curve is empty). */
  function curveAt(points, t) {
    if (!points || !points.length) return 0.5;
    if (t <= points[0].t) return points[0].v;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (t <= b.t) {
        const span = b.t - a.t;
        return span <= 1e-9 ? b.v : a.v + (b.v - a.v) * ((t - a.t) / span);
      }
    }
    return points[points.length - 1].v;
  }

  /**
   * Dynamic value 0..1 for a track at time t.
   * pos = { chord: 0..1 position inside the chord, phrase: 0..1 inside the 4-bar phrase, bar: 0..1 inside the bar }
   */
  function valueAt(dyn, songValue, pos) {
    const emo = clamp((dyn.emotion != null ? dyn.emotion : 50) / 100, 0, 1);
    const shape = SHAPES.find((s) => s.id === dyn.shape) || SHAPES[0];
    let d = levelValue(dyn.level);
    d += (songValue - 0.5) * (0.55 + 0.9 * emo);
    d += shape.fn(pos) * (0.2 + 0.6 * emo);
    return clamp(d, 0.02, 1);
  }

  /** Velocity for a note: d inside the track range, with metric accent and humanisation. */
  function velocityFor(dyn, d, accentFactor, rnd) {
    const lo = clamp(dyn.velMin != null ? dyn.velMin : 40, 1, 127);
    const hi = clamp(dyn.velMax != null ? dyn.velMax : 110, lo, 127);
    let v = lo + d * (hi - lo);
    const accent = clamp((dyn.accent != null ? dyn.accent : 50) / 100, 0, 1);
    v *= 1 - (1 - clamp(accentFactor, 0.4, 1.2)) * accent * 1.6;
    const hum = clamp((dyn.humanize != null ? dyn.humanize : 30) / 100, 0, 1);
    if (rnd) v += (rnd() - 0.5) * 2 * hum * 9;
    return Math.round(clamp(v, 1, 127));
  }

  /** CC values derived from d. */
  const ccFromD = {
    1: (d) => Math.round(clamp(d, 0, 1) * 127),
    11: (d) => Math.round(clamp(38 + d * 89, 0, 127)),
    2: (d) => Math.round(clamp(d, 0, 1) * 127),
  };

  CF.Dynamics = { LEVELS, SHAPES, CURVE_PRESETS, levelValue, presetPoints, curveAt, valueAt, velocityFor, ccFromD };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Dynamics;
})(typeof globalThis !== 'undefined' ? globalThis : this);
