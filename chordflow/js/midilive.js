/*
 * ChordFlow - live MIDI (Web MIDI API).
 *
 *   Output: while the song plays, the same notes and controllers that go into the file
 *           (Velocity, CC1, CC11, CC64) are sent to a chosen device, each instrument on its channel.
 *   Input:  notes from a keyboard sound right away through the recorded instrument of a chosen
 *           track (sustain pedal supported), and the delay is shown in ms.
 *
 * States (shown in Hebrew by the app): idle, unsupported, insecure, denied, none, ready, error.
 * Device choices live in localStorage (they belong to this computer, not to the project).
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const KEY = 'chordflow.midi';

  const listeners = [];
  const held = new Map(); // pitch -> sampler handle
  const sustained = new Set();
  let pedal = false;
  let access = null;

  function load() {
    try { return Object.assign({ inputId: '', outputId: '', send: false, local: true, track: '' }, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return { inputId: '', outputId: '', send: false, local: true, track: '' }; }
  }

  const Live = {
    state: 'idle',
    error: '',
    lost: '',          // name of a device that was just disconnected
    settings: load(),
    lastInput: null,   // { pitch, vel, ms }
    player: null,      // set by the app
    trackFor: null,    // () => track object that plays the keyboard

    get supported() { return !!(root.navigator && root.navigator.requestMIDIAccess); },
    onChange(fn) { listeners.push(fn); },
    emit() { listeners.forEach((fn) => { try { fn(Live); } catch (e) { /* ignore */ } }); },
    save() { try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ } },

    inputs() { return access ? [...access.inputs.values()].filter((p) => p.state !== 'disconnected') : []; },
    outputs() { return access ? [...access.outputs.values()].filter((p) => p.state !== 'disconnected') : []; },
    output() { return access && this.settings.outputId ? access.outputs.get(this.settings.outputId) || null : null; },
    input() { return access && this.settings.inputId ? access.inputs.get(this.settings.inputId) || null : null; },

    /** Asks the browser for MIDI access (shows the browser's permission prompt the first time). */
    async connect() {
      this.error = '';
      if (!this.supported) { this.state = 'unsupported'; this.emit(); return this.state; }
      if (root.isSecureContext === false) { this.state = 'insecure'; this.emit(); return this.state; }
      try {
        access = await root.navigator.requestMIDIAccess({ sysex: false });
      } catch (e) {
        access = null;
        this.state = e && /security|notallowed|permission/i.test((e.name || '') + ' ' + (e.message || '')) ? 'denied' : 'error';
        this.error = e && e.message ? e.message : String(e);
        this.emit();
        return this.state;
      }
      access.onstatechange = (ev) => {
        const p = ev.port;
        if (p && p.state === 'disconnected' && (p.id === this.settings.inputId || p.id === this.settings.outputId)) this.lost = p.name || 'MIDI';
        else if (p && p.state === 'connected' && this.lost && (p.id === this.settings.inputId || p.id === this.settings.outputId)) this.lost = '';
        this.refresh();
      };
      this.refresh();
      return this.state;
    },

    refresh() {
      if (!access) return;
      const ins = this.inputs(), outs = this.outputs();
      if (this.settings.inputId && !ins.some((p) => p.id === this.settings.inputId) && !this.lost) this.settings.inputId = '';
      if (this.settings.outputId && !outs.some((p) => p.id === this.settings.outputId) && !this.lost) this.settings.outputId = '';
      if (!this.settings.inputId && ins.length === 1) this.settings.inputId = ins[0].id;
      this.state = ins.length || outs.length ? 'ready' : 'none';
      this.bindInput();
      this.emit();
    },

    select(kind, id) {
      if (kind === 'input') this.settings.inputId = id; else this.settings.outputId = id;
      this.lost = '';
      this.save();
      this.bindInput();
      this.emit();
    },
    set(key, value) { this.settings[key] = value; this.save(); if (key === 'send' && !value) this.flush(); this.emit(); },

    bindInput() {
      if (!access) return;
      access.inputs.forEach((p) => { if (p.onmidimessage) p.onmidimessage = null; });
      const inp = this.input();
      if (inp) inp.onmidimessage = (e) => this.handleMessage(e);
    },

    // ---------------------------------------------------------------- input -> sound
    /**
     * One incoming message. Note-on plays the chosen track's recorded instrument immediately.
     * Returns { when, now, base } for latency measurement.
     */
    handleMessage(e) {
      const d = e.data;
      if (!d || d.length < 2) return null;
      const type = d[0] & 0xf0;
      const pl = this.player;
      if (!pl) return null;
      if (type === 0xb0 && d[1] === 64) {
        pedal = d[2] >= 64;
        if (!pedal) { const ac = pl.ac; sustained.forEach((h) => h.release(ac ? ac.currentTime : 0)); sustained.clear(); }
        return null;
      }
      if (type !== 0x90 && type !== 0x80) return null;
      const pitch = d[1], vel = d[2] || 0;
      if (type === 0x80 || vel === 0) {
        const h = held.get(pitch);
        held.delete(pitch);
        if (h) { if (pedal) sustained.add(h); else h.release(pl.ac.currentTime); }
        return null;
      }
      let ac;
      try { ac = pl.ensure(); } catch (err) { return null; }
      const track = (this.trackFor && this.trackFor()) || null;
      const inst = track ? track.instrument : 'grand';
      const family = track ? track.family : 'keys';
      const now = ac.currentTime;
      if (CF.Sampler && CF.Sampler.state(inst) !== 'ready' && CF.Sampler.state(inst) !== 'loading') CF.Sampler.load(ac, inst);
      const prev = held.get(pitch);
      if (prev) prev.release(now);
      const h = CF.Sampler && CF.Sampler.play(ac, pl.liveBus(), inst, pitch, vel / 127, now, 30, family);
      if (h && h.release) held.set(pitch, h);
      else {
        const v = CF.AudioVoices && (CF.AudioVoices[(CF.Instruments.get(inst) || {}).voice] || CF.AudioVoices.grand);
        if (v) v(ac, pl.liveBus(), pitch, vel / 127, now, 0.6);
      }
      const ms = e.timeStamp != null && root.performance ? Math.max(0, root.performance.now() - e.timeStamp) + ((ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000 : null;
      this.lastInput = { pitch, vel, ms: ms != null ? Math.round(ms) : null };
      this.emit();
      return { when: now, now: ac.currentTime, base: (ac.baseLatency || 0) + (ac.outputLatency || 0) };
    },

    // ---------------------------------------------------------------- song -> device
    sending() { return this.state === 'ready' && this.settings.send && !!this.output(); },
    localSound() { return !this.sending() || this.settings.local !== false; },

    /** Sends one message at an audio-clock time (converted to the MIDI clock). */
    sendAt(bytes, acTime, ac) {
      const out = this.output();
      if (!out) return;
      const ts = root.performance.now() + Math.max(0, acTime - ac.currentTime) * 1000 + ((ac.outputLatency || 0) + (ac.baseLatency || 0)) * 1000 * (this.settings.local !== false ? 1 : 0);
      try { out.send(bytes, ts); } catch (e) { /* port went away */ }
      if (bytes[0] >= 0x90 && bytes[0] < 0xa0 && bytes[2] > 0) this.channels.add(bytes[0] & 0x0f);
      if (bytes[0] >= 0xb0 && bytes[0] < 0xc0) this.channels.add(bytes[0] & 0x0f);
    },
    channels: new Set(),

    /** Stop / restart: drop queued messages and silence every used channel (no hanging notes). */
    flush() {
      const out = this.output();
      if (!out) return;
      try { if (out.clear) out.clear(); } catch (e) { /* not supported */ }
      this.channels.forEach((ch) => {
        try { out.send([0xb0 | ch, 64, 0]); out.send([0xb0 | ch, 123, 0]); } catch (e) { /* ignore */ }
      });
      this.channels.clear();
    },

    /** A short C4 on channel 1, to check the connection. */
    testNote() {
      const out = this.output();
      if (!out) return false;
      const now = root.performance.now();
      try { out.send([0x90, 60, 100], now); out.send([0x80, 60, 0], now + 400); return true; } catch (e) { return false; }
    },
  };

  CF.MidiLive = Live;
})(typeof globalThis !== 'undefined' ? globalThis : this);
