/*
 * ChordFlow - extension registries.
 * Plans (free / paid tiers), instrument families, instruments and voicings.
 * New sounds, families and paid packs are added here without touching the engine.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});

  /**
   * Feature tiers. Every registry entry has a `tier`; the UI only offers entries
   * the current plan includes. Today everything is 'free'. To sell a pack later,
   * register entries with tier: 'pro' and call CF.Plans.unlock('pro') after a
   * successful license check.
   */
  const Plans = {
    unlocked: new Set(['free']),
    has(tier) { return !tier || this.unlocked.has(tier); },
    unlock(tier) { this.unlocked.add(tier); },
  };

  /**
   * Families group instruments and decide which playing patterns apply.
   * role: 'piano' (keyboard patterns), 'bass' (bass lines), 'ensemble' (sustained / orchestral lines)
   */
  const FAMILIES = [
    { id: 'keys', name: 'קלידים', en: 'Keys', role: 'piano', color: '#e8a548',
      defaults: { pattern: 'block', voicing: 'smooth',
        dyn: { level: 'mf', shape: 'phrase', emotion: 55, velMin: 20, velMax: 120, accent: 55, humanize: 35, cc1: false, cc11: true, cc2: false, ccRes: 0.25 } } },
    { id: 'bass', name: 'בס', en: 'Bass', role: 'bass', color: '#d98e5f',
      defaults: { pattern: 'sustain', voicing: null,
        dyn: { level: 'mf', shape: 'flat', emotion: 45, velMin: 30, velMax: 120, accent: 50, humanize: 25, cc1: false, cc11: true, cc2: false, ccRes: 0.25 } } },
    { id: 'strings', name: 'כלי קשת', en: 'Strings', role: 'ensemble', color: '#e57a8a',
      defaults: { pattern: 'sustain', voicing: 'smooth',
        dyn: { level: 'mp', shape: 'swell', emotion: 65, velMin: 30, velMax: 110, accent: 35, humanize: 25, cc1: true, cc11: true, cc2: false, ccRes: 0.25 } } },
    { id: 'brass', name: 'נשיפה ממתכת', en: 'Brass', role: 'ensemble', color: '#e9c46a',
      defaults: { pattern: 'sustain', voicing: 'smooth',
        dyn: { level: 'mf', shape: 'phrase', emotion: 60, velMin: 30, velMax: 120, accent: 60, humanize: 25, cc1: true, cc11: true, cc2: false, ccRes: 0.25 } } },
    { id: 'winds', name: 'נשיפה מעץ', en: 'Woodwinds', role: 'ensemble', color: '#7fb0d8',
      defaults: { pattern: 'topLine', voicing: 'smooth',
        dyn: { level: 'mp', shape: 'phrase', emotion: 60, velMin: 30, velMax: 112, accent: 40, humanize: 25, cc1: true, cc11: true, cc2: false, ccRes: 0.25 } } },
    { id: 'pad', name: 'פד ומקהלה', en: 'Pad', role: 'ensemble', color: '#ae9fe6',
      defaults: { pattern: 'sustain', voicing: 'spread',
        dyn: { level: 'p', shape: 'swell', emotion: 55, velMin: 25, velMax: 100, accent: 20, humanize: 15, cc1: true, cc11: true, cc2: false, ccRes: 0.25 } } },
  ];

  /**
   * Instruments.
   *   program  General MIDI program (0-based) written to the MIDI file
   *   center   voicing centre (MIDI note) - where the chord sits
   *   range    playable range [low, high]; voicings are folded into it
   *   voice    synth used for the in-browser preview
   */
  const INSTRUMENTS = [
    { id: 'grand', family: 'keys', name: 'פסנתר אקוסטי', en: 'Piano', program: 0, center: 63, range: [21, 108], voice: 'grand' },
    { id: 'epiano', family: 'keys', name: 'פסנתר חשמלי', en: 'Electric Piano', program: 4, center: 63, range: [28, 103], voice: 'epiano' },
    { id: 'organ', family: 'keys', name: 'אורגן', en: 'Organ', program: 16, center: 63, range: [24, 96], voice: 'organ' },
    { id: 'harp', family: 'keys', name: 'נבל', en: 'Harp', program: 46, center: 62, range: [24, 103], voice: 'pizz' },

    { id: 'fingerBass', family: 'bass', name: 'בס חשמלי', en: 'Electric Bass', program: 33, center: 34, range: [28, 60], voice: 'fingerBass' },
    { id: 'upright', family: 'bass', name: 'קונטרבס', en: 'Contrabass', program: 32, center: 34, range: [28, 60], voice: 'upright' },
    { id: 'synthBass', family: 'bass', name: 'בס סינתי', en: 'Synth Bass', program: 38, center: 34, range: [24, 60], voice: 'synthBass' },

    { id: 'stringsEns', family: 'strings', name: 'אנסמבל כלי קשת', en: 'Strings', program: 48, center: 63, range: [36, 96], voice: 'strings' },
    { id: 'violins', family: 'strings', name: 'כינורות', en: 'Violins', program: 40, center: 74, range: [55, 100], voice: 'violin' },
    { id: 'violas', family: 'strings', name: 'ויולות', en: 'Violas', program: 41, center: 62, range: [48, 88], voice: 'strings' },
    { id: 'cellos', family: 'strings', name: 'צ׳לו', en: 'Cellos', program: 42, center: 50, range: [36, 76], voice: 'cello' },
    { id: 'pizz', family: 'strings', name: 'פיציקטו', en: 'Pizzicato Strings', program: 45, center: 62, range: [36, 96], voice: 'pizz' },

    { id: 'brassEns', family: 'brass', name: 'אנסמבל נשיפה ממתכת', en: 'Brass Section', program: 61, center: 62, range: [40, 84], voice: 'brass' },
    { id: 'horns', family: 'brass', name: 'קרנות יער', en: 'French Horns', program: 60, center: 58, range: [41, 77], voice: 'horn' },
    { id: 'trumpets', family: 'brass', name: 'חצוצרות', en: 'Trumpets', program: 56, center: 70, range: [55, 84], voice: 'brass' },
    { id: 'trombones', family: 'brass', name: 'טרומבונים', en: 'Trombones', program: 57, center: 52, range: [34, 72], voice: 'horn' },

    { id: 'flute', family: 'winds', name: 'חליל', en: 'Flute', program: 73, center: 79, range: [60, 96], voice: 'flute' },
    { id: 'oboe', family: 'winds', name: 'אבוב', en: 'Oboe', program: 68, center: 72, range: [58, 91], voice: 'reed' },
    { id: 'clarinet', family: 'winds', name: 'קלרינט', en: 'Clarinet', program: 71, center: 66, range: [50, 91], voice: 'reed' },
    { id: 'bassoon', family: 'winds', name: 'בסון', en: 'Bassoon', program: 70, center: 50, range: [34, 75], voice: 'reed' },

    { id: 'warmPad', family: 'pad', name: 'פד חם', en: 'Warm Pad', program: 89, center: 62, range: [36, 96], voice: 'pad' },
    { id: 'choir', family: 'pad', name: 'מקהלה', en: 'Choir', program: 52, center: 64, range: [45, 81], voice: 'choir' },
  ].map((i) => Object.assign({ tier: 'free' }, i));

  const Families = {
    list: FAMILIES,
    get(id) { return FAMILIES.find((f) => f.id === id) || null; },
  };

  const Instruments = {
    list: INSTRUMENTS,
    get(id) { return INSTRUMENTS.find((i) => i.id === id) || null; },
    forFamily(family) { return INSTRUMENTS.filter((i) => i.family === family && Plans.has(i.tier)); },
    register(def) { INSTRUMENTS.push(Object.assign({ tier: 'free' }, def)); },
  };

  /** Chord voicing styles (implemented in voicing.js). */
  const VOICINGS = [
    { id: 'smooth', name: 'הובלת קולות חלקה', desc: 'כל אקורד נבנה קרוב לקודם - הקולות זזים מעט', tier: 'free' },
    { id: 'close', name: 'צפוף', desc: 'צלילי האקורד באוקטבה אחת', tier: 'free' },
    { id: 'drop2', name: 'Drop 2', desc: 'פתוח וחם, נפוץ בג׳אז ובפופ', tier: 'free' },
    { id: 'spread', name: 'רחב (שתי ידיים)', desc: 'שורש וקווינטה למטה, שאר הצלילים למעלה', tier: 'free' },
    { id: 'shell', name: 'Shell (ג׳אז)', desc: 'שורש, טרצה וספטימה בלבד', tier: 'free' },
  ];

  /**
   * Articulations written as keyswitches. Default notes follow a common layout
   * (Cubase names: C0 = MIDI 24). Users can remap them to their library in the export dialog.
   */
  const ARTICULATIONS = [
    { id: 'legato', name: 'לגאטו', en: 'Legato', note: 24 },
    { id: 'sustain', name: 'סוסטיין (ארוך)', en: 'Sustain', note: 25 },
    { id: 'staccato', name: 'סטקטו', en: 'Staccato', note: 26 },
    { id: 'spiccato', name: 'ספיקטו', en: 'Spiccato', note: 27 },
    { id: 'marcato', name: 'מרקטו', en: 'Marcato', note: 28 },
    { id: 'tremolo', name: 'טרמולו', en: 'Tremolo', note: 29 },
    { id: 'pizzicato', name: 'פיציקטו', en: 'Pizzicato', note: 30 },
  ];
  CF.Articulations = {
    list: ARTICULATIONS,
    get(id) { return ARTICULATIONS.find((a) => a.id === id) || null; },
    defaultMap() { const m = {}; ARTICULATIONS.forEach((a) => { m[a.id] = a.note; }); return m; },
    /** Cubase-style note name (C3 = 60). */
    noteName(n) { return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 2); },
  };

  CF.Plans = Plans;
  CF.Families = Families;
  CF.Instruments = Instruments;
  CF.Voicings = {
    list: VOICINGS,
    available() { return VOICINGS.filter((v) => Plans.has(v.tier)); },
    get(id) { return VOICINGS.find((v) => v.id === id) || null; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { Plans, Families, Instruments };
})(typeof globalThis !== 'undefined' ? globalThis : this);
