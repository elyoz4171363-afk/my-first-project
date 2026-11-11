/*
 * ChordFlow - Standard MIDI File writer (SMF type 1).
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
   * @param opts         { trackIds?: string[], markers?: boolean, cc?: boolean,
 *                       keyswitch?: { enabled, map: {art: note}, trackIds?: string[] } }
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
    // song sections first (so they sort before chord markers at the same tick)
    (arrangement.sectionMarkers || []).forEach((m, i) => {
      cond.push({ tick: toTick(m.t), order: 5 + i * 0, bytes: meta(0x06, textBytes(ascii('[' + m.text + ']', 'Section'))) });
    });
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
      // CC7 = track volume x whole-project volume
      const mv = project.master && project.master.volume != null ? project.master.volume : 1;
      ev.push({ tick: 0, order: 5, bytes: [0xb0 | ch, 0x07, Math.round(Math.max(0, Math.min(1, tr.volume * mv)) * 127)] });
      ev.push({ tick: 0, order: 6, bytes: [0xb0 | ch, 0x0a, Math.round(64 + Math.max(-1, Math.min(1, tr.pan || 0)) * 63)] });
      // controller curves (dynamics / expression / breath): before notes at the same tick
      if (opts.cc !== false) {
        (at.cc || []).forEach((c, i) => {
          ev.push({ tick: toTick(c.t), order: c.t === 0 ? 7 + (i % 3) : 150, bytes: [0xb0 | ch, c.cc & 0x7f, Math.max(0, Math.min(127, c.v))] });
        });
      }
      const ks = opts.keyswitch && opts.keyswitch.enabled && (!opts.keyswitch.trackIds || opts.keyswitch.trackIds.includes(tr.id))
        ? opts.keyswitch.map : null;
      let currentArt = null;
      const notes = at.notes.slice().sort((a, b) => a.t - b.t);
      notes.forEach((n) => {
        const on = toTick(n.t);
        const off = Math.max(on + 1, toTick(n.t + n.dur));
        // articulation change -> keyswitch note just before the music
        if (ks && n.art && ks[n.art] != null && n.art !== currentArt) {
          const kt = Math.max(0, on - 12);
          ev.push({ tick: kt, order: 190, bytes: [0x90 | ch, ks[n.art] & 0x7f, 100] });
          ev.push({ tick: kt + 8, order: 95, bytes: [0x80 | ch, ks[n.art] & 0x7f, 0x40] });
          currentArt = n.art;
        }
        // tremolo without keyswitches: write it out as measured repeats so it isn't lost
        if (!ks && n.art === 'tremolo') {
          const step = PPQ / 4;
          for (let t = on; t < off - 4; t += step) {
            const e = Math.min(off, t + step - 6);
            ev.push({ tick: t, order: 200, bytes: [0x90 | ch, n.pitch & 0x7f, Math.max(1, Math.min(127, n.vel - (((t - on) / step) % 2 ? 8 : 0)))] });
            ev.push({ tick: e, order: 100, bytes: [0x80 | ch, n.pitch & 0x7f, 0x40] });
          }
          return;
        }
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

  /**
   * Cubase Expression Map (.expressionmap, XML): one sound slot per articulation. Each slot is
   * triggered by the same keyswitch note the MIDI file writes (remote key) and sends that note on
   * to the library (output event), so the articulations show by name in Cubase's editors.
   * Not yet checked in a real Cubase: the structure follows the format Cubase saves.
   */
  function expressionMap(project) {
    const map = (project.keyswitch && project.keyswitch.map) || CF.Articulations.defaultMap();
    const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    let id = 1000;
    const next = () => ++id;
    const visuals = [];
    const slots = CF.Articulations.list.map((a) => {
      const note = map[a.id] != null ? map[a.id] : a.note;
      const v = next();
      visuals.push(v);
      return `         <obj class="PSoundSlot" ID="${next()}">
            <obj class="PSlotThruTrigger" name="remote" ID="${next()}">
               <int name="status" value="144"/>
               <int name="data1" value="${note}"/>
            </obj>
            <obj class="PSlotMidiAction" name="action" ID="${next()}">
               <int name="version" value="600"/>
               <member name="noteChanger">
                  <int name="ownership" value="1"/>
                  <list name="obj" type="obj">
                     <obj class="PSlotNoteChanger" ID="${next()}">
                        <int name="channel" value="-1"/>
                        <float name="velocityFact" value="1"/>
                        <float name="lengthFact" value="1"/>
                        <int name="minVelocity" value="0"/>
                        <int name="maxVelocity" value="127"/>
                        <int name="transpose" value="0"/>
                        <int name="minPitch" value="0"/>
                        <int name="maxPitch" value="127"/>
                     </obj>
                  </list>
               </member>
               <member name="midiMessages">
                  <int name="ownership" value="1"/>
                  <list name="obj" type="obj">
                     <obj class="POutputEvent" ID="${next()}">
                        <int name="status" value="144"/>
                        <int name="data1" value="${note}"/>
                        <int name="data2" value="120"/>
                        <int name="data3" value="0"/>
                     </obj>
                  </list>
               </member>
               <int name="channel" value="-1"/>
            </obj>
            <member name="sv">
               <int name="ownership" value="2"/>
               <list name="obj" type="obj">
                  <obj class="USlotVisuals" ID="${v}">
                     <int name="displaytype" value="1"/>
                     <int name="articulationtype" value="1"/>
                     <int name="symbol" value="0"/>
                     <string name="text" value="${xml(a.en)}" wide="true"/>
                     <string name="description" value="${xml(a.en)}" wide="true"/>
                     <int name="group" value="0"/>
                  </obj>
               </list>
            </member>
            <member name="name">
               <string name="s" value="${xml(a.en)}" wide="true"/>
            </member>
            <int name="color" value="0"/>
         </obj>`;
    });
    return `<?xml version="1.0" encoding="utf-8"?>
<InstrumentMap>
   <string name="name" value="${xml('ChordFlow ' + ascii(project.name, 'Map'))}" wide="true"/>
   <member name="controller">
      <int name="ownership" value="1"/>
   </member>
   <member name="slots">
      <int name="ownership" value="1"/>
      <list name="obj" type="obj">
${slots.join('\n')}
      </list>
   </member>
   <member name="slotvisuals">
      <int name="ownership" value="1"/>
      <list name="obj" type="obj">
${visuals.map((v) => `         <obj class="USlotVisuals" ID="${v}"/>`).join('\n')}
      </list>
   </member>
</InstrumentMap>
`;
  }

  CF.Midi = { build, fileName, PPQ, expressionMap };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Midi;
})(typeof globalThis !== 'undefined' ? globalThis : this);
