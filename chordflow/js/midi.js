/*
 * ChordFlow — Standard MIDI File writer (SMF type 1).
 * Track 0: conductor (name, time signature, key signature, tempo, chord markers).
 * Track 1..n: one track per instrument on its own channel with name + program change.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const PPQ = 480;

  function vlq(n) {
    n = Math.max(0, Math.round(n));
    const bytes = [n & 0x7f];
    n >>= 7;
    while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
    return bytes;
  }
  function ascii(str, fallback) {
    const s = CF.Theory.asciiSymbol(String(str || '')).trim();
    return s || fallback || '';
  }
  function textBytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0x7f);
    return out;
  }
  function meta(type, data) {
    return [0xff, type, ...vlq(data.length), ...data];
  }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }

  /** events: [{ tick, order, bytes }] -> MTrk chunk bytes (adds End of Track). */
  function trackChunk(events, endTick) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const body = [];
    let last = 0;
    events.forEach((e) => {
      body.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    });
    const end = Math.max(last, endTick || 0);
    body.push(...vlq(end - last), 0xff, 0x2f, 0x00);
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
  }

  /**
   * @param project      ChordFlow project
   * @param arrangement  result of CF.Arranger.arrange(project)
   * @param opts         { trackIds?: string[], markers?: boolean, cc?: boolean }
   * @returns Uint8Array with a complete .mid file
   */
  function build(project, arrangement, opts) {
    opts = opts || {};
    const toTick = (q) => Math.round(q * PPQ);
    const endTick = toTick(arrangement.songEnd);
    const chunks = [];

    // --- conductor track
    const ts = project.timeSig;
    const ks = CF.Theory.keySignature(project.key);
    const tempo = Math.round(60000000 / project.bpm);
    const cond = [];
    cond.push({ tick: 0, order: 0, bytes: meta(0x03, textBytes(ascii(project.name, 'ChordFlow'))) });
    cond.push({ tick: 0, order: 1, bytes: meta(0x01, textBytes('Created with ChordFlow - Beit LeYotzrim')) });
    cond.push({ tick: 0, order: 2, bytes: meta(0x58, [ts.num, Math.round(Math.log2(ts.den)), ts.den === 8 && ts.num % 3 === 0 ? 36 : 24, 8]) });
    cond.push({ tick: 0, order: 3, bytes: meta(0x59, [ks.sf & 0xff, ks.mi]) });
    cond.push({ tick: 0, order: 4, bytes: meta(0x51, [(tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]) });
    if (opts.markers !== false) {
      arrangement.markers.forEach((m, i) => {
        cond.push({ tick: toTick(m.t), order: 10 + i, bytes: meta(0x06, textBytes(ascii(m.text, '?'))) });
      });
    }
    chunks.push(trackChunk(cond, endTick));

    // --- instrument tracks
    const include = opts.trackIds ? new Set(opts.trackIds) : null;
    arrangement.tracks.forEach((at) => {
      const tr = at.track;
      if (include && !include.has(tr.id)) return;
      const ch = Math.max(0, Math.min(15, tr.channel | 0));
      const inst = CF.Instruments.get(tr.instrument);
      const program = inst ? inst.program : 0;
      const name = ascii(tr.midiName, inst ? inst.en : 'Track');
      const ev = [];
      ev.push({ tick: 0, order: 0, bytes: meta(0x03, textBytes(name)) });
      ev.push({ tick: 0, order: 1, bytes: meta(0x04, textBytes(ascii(inst ? inst.en : name, name))) });
      ev.push({ tick: 0, order: 2, bytes: [0xb0 | ch, 0x00, 0x00] }); // bank select MSB
      ev.push({ tick: 0, order: 3, bytes: [0xb0 | ch, 0x20, 0x00] }); // bank select LSB
      ev.push({ tick: 0, order: 4, bytes: [0xc0 | ch, program & 0x7f] });
      ev.push({ tick: 0, order: 5, bytes: [0xb0 | ch, 0x07, Math.round(Math.max(0, Math.min(1, tr.volume)) * 127)] });
      ev.push({ tick: 0, order: 6, bytes: [0xb0 | ch, 0x0a, Math.round(64 + Math.max(-1, Math.min(1, tr.pan || 0)) * 63)] });
      // controller curves (dynamics / expression / breath): before notes at the same tick
      if (opts.cc !== false) {
        (at.cc || []).forEach((c, i) => {
          ev.push({ tick: toTick(c.t), order: c.t === 0 ? 7 + (i % 3) : 150, bytes: [0xb0 | ch, c.cc & 0x7f, Math.max(0, Math.min(127, c.v))] });
        });
      }
      at.notes.forEach((n) => {
        const on = toTick(n.t);
        const off = Math.max(on + 1, toTick(n.t + n.dur));
        // note-offs (100) sort before controllers (150) and note-ons (200) at the same tick
        ev.push({ tick: on, order: 200, bytes: [0x90 | ch, n.pitch & 0x7f, Math.max(1, Math.min(127, n.vel))] });
        ev.push({ tick: off, order: 100, bytes: [0x80 | ch, n.pitch & 0x7f, 0x40] });
      });
      chunks.push(trackChunk(ev, endTick));
    });

    const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ)];
    const total = header.length + chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    out.set(header, o); o += header.length;
    chunks.forEach((c) => { out.set(c, o); o += c.length; });
    return out;
  }

  function fileName(project) {
    const base = String(project.name || 'ChordFlow').replace(/[\\/:*?"<>|]+/g, '').trim() || 'ChordFlow';
    return `${base} - ${project.bpm}bpm.mid`;
  }

  CF.Midi = { build, fileName, PPQ };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Midi;
})(typeof globalThis !== 'undefined' ? globalThis : this);
