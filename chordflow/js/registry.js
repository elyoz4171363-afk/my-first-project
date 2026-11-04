/*
 * ChordFlow — extension registries.
 * Plans (free / paid tiers), instruments and track roles live here so new
 * sounds, patterns and paid features can be added without touching the engine.
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

  /** Instruments: `program` is the General MIDI program (0-based) written to the MIDI file. */
  const INSTRUMENTS = [
    { id: 'grand', role: 'piano', name: 'פסנתר אקוסטי', program: 0, tier: 'free' },
    { id: 'epiano', role: 'piano', name: 'פסנתר חשמלי', program: 4, tier: 'free' },
    { id: 'organ', role: 'piano', name: 'אורגן', program: 16, tier: 'free' },
    { id: 'pad', role: 'piano', name: 'פד חם', program: 89, tier: 'free' },
    { id: 'fingerBass', role: 'bass', name: 'בס חשמלי', program: 33, tier: 'free' },
    { id: 'upright', role: 'bass', name: 'קונטרבס', program: 32, tier: 'free' },
    { id: 'synthBass', role: 'bass', name: 'בס סינתי', program: 38, tier: 'free' },
  ];

  const Instruments = {
    list: INSTRUMENTS,
    get(id) { return INSTRUMENTS.find((i) => i.id === id) || null; },
    forRole(role) { return INSTRUMENTS.filter((i) => i.role === role && Plans.has(i.tier)); },
    register(def) { INSTRUMENTS.push(Object.assign({ tier: 'free' }, def)); },
  };

  /** Piano voicing styles (implemented in voicing.js). */
  const VOICINGS = [
    { id: 'smooth', name: 'הובלת קולות חלקה', desc: 'בוחר היפוך קרוב לאקורד הקודם', tier: 'free' },
    { id: 'close', name: 'צפוף', desc: 'צלילי האקורד באוקטבה אחת', tier: 'free' },
    { id: 'drop2', name: 'Drop 2', desc: 'פתוח וחם, נפוץ בג׳אז ובפופ', tier: 'free' },
    { id: 'spread', name: 'רחב (שתי ידיים)', desc: 'שורש וקווינטה למטה, שאר הצלילים למעלה', tier: 'free' },
    { id: 'shell', name: 'Shell (ג׳אז)', desc: 'שורש, טרצה וספטימה בלבד', tier: 'free' },
  ];

  CF.Plans = Plans;
  CF.Instruments = Instruments;
  CF.Voicings = {
    list: VOICINGS,
    available() { return VOICINGS.filter((v) => Plans.has(v.tier)); },
    get(id) { return VOICINGS.find((v) => v.id === id) || null; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { Plans, Instruments };
})(typeof globalThis !== 'undefined' ? globalThis : this);
