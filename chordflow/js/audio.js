/*
 * ChordFlow - Web Audio preview engine.
 * Synthesised instruments (no samples, no server), a look-ahead scheduler
 * with seamless looping, metronome, live mixer updates and chord audition.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ------------------------------------------------------------ voices
  // Each voice: (ac, out, pitch, vel 0..1, t, dur) - schedules itself and stops on its own.

  function envGain(ac, t, peak, attack, tau, dur, release) {
    const g = ac.createGain();
    const p = g.gain;
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + attack);
    if (tau) p.setTargetAtTime(0, t + attack, tau);
    const off = t + Math.max(dur, attack + 0.01);
    const held = tau ? peak * Math.exp(-(off - t - attack) / tau) : peak;
    p.setValueAtTime(Math.max(held, 0.0001), off);
    p.setTargetAtTime(0, off, release);
    return { node: g, stopAt: off + release * 6 };
  }

  function osc(ac, type, freq, t, stopAt, detune) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    o.start(t);
    o.stop(stopAt);
    return o;
  }

  /** Sustained orchestral voice: detuned oscillators, filter, vibrato, optional breath noise / formants. */
  function orch(ac, out, pitch, vel, t, dur, o) {
    const f = mtof(pitch);
    const g = ac.createGain();
    const peak = (o.gain || 0.06) * (0.45 + 0.75 * vel);
    const attack = Math.min(o.attack, dur * 0.6);
    const end = t + Math.max(dur, attack + 0.02);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, end);
    g.gain.setTargetAtTime(0, end, o.release / 3);
    const stopAt = end + o.release * 2.5;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8;
    const cutoff = (o.cutoff || 1500) * (0.6 + 0.8 * vel);
    if (o.filterEnv) {
      lp.frequency.setValueAtTime(cutoff * 0.5, t);
      lp.frequency.linearRampToValueAtTime(cutoff + o.filterEnv * vel, t + attack + 0.04);
      lp.frequency.setTargetAtTime(cutoff, t + attack + 0.05, 0.3);
    } else lp.frequency.value = cutoff;
    let chain = lp;
    if (o.formant) {
      const bp = ac.createBiquadFilter();
      bp.type = 'peaking'; bp.frequency.value = 900; bp.Q.value = 2; bp.gain.value = 8;
      lp.connect(bp);
      chain = bp;
    }
    chain.connect(g).connect(out);
    const lfo = ac.createOscillator();
    const lfoG = ac.createGain();
    lfo.frequency.value = o.vib || 5;
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(o.vibDepth || 6, t + Math.min(0.6, dur * 0.7));
    lfo.connect(lfoG);
    lfo.start(t); lfo.stop(stopAt);
    o.waves.forEach(([type, det]) => {
      const oo = osc(ac, type, f, t, stopAt, det);
      lfoG.connect(oo.detune);
      oo.connect(lp);
    });
    if (o.breath) {
      const len = Math.ceil(ac.sampleRate * 0.5);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const n = ac.createBufferSource();
      n.buffer = buf; n.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 1.5;
      const ng = ac.createGain(); ng.gain.value = o.breath * (0.5 + vel);
      n.connect(bp).connect(ng).connect(g);
      n.start(t); n.stop(stopAt);
    }
  }

  const VOICES = {
    grand(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const tau = 0.35 + 1.6 * Math.max(0, (96 - pitch) / 60);
      const env = envGain(ac, t, 0.16 * vel + 0.03, 0.004, tau, dur, 0.09);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.6;
      lp.frequency.setValueAtTime(Math.min(16000, f * (3 + 7 * vel)), t);
      lp.frequency.setTargetAtTime(Math.min(8000, f * 2.2), t + 0.01, 0.5);
      lp.connect(env.node).connect(out);
      const mix = [[osc(ac, 'triangle', f, t, env.stopAt, 0), 1], [osc(ac, 'sine', f * 2, t, env.stopAt, 4), 0.32], [osc(ac, 'sine', f * 3, t, env.stopAt, -3), 0.12], [osc(ac, 'sawtooth', f, t, env.stopAt, 2), 0.05]];
      mix.forEach(([o, g]) => { const gn = ac.createGain(); gn.gain.value = g; o.connect(gn).connect(lp); });
    },
    epiano(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const env = envGain(ac, t, 0.2 * vel + 0.03, 0.003, 1.1, dur, 0.12);
      env.node.connect(out);
      const car = osc(ac, 'sine', f, t, env.stopAt, 0);
      const mod = osc(ac, 'sine', f, t, env.stopAt, 0);
      const modGain = ac.createGain();
      modGain.gain.setValueAtTime(f * (0.6 + 2.2 * vel), t);
      modGain.gain.setTargetAtTime(f * 0.15, t, 0.18);
      mod.connect(modGain).connect(car.frequency);
      const bell = osc(ac, 'sine', f * 4, t, env.stopAt, 0);
      const bellG = ac.createGain();
      bellG.gain.setValueAtTime(0.08 * vel, t);
      bellG.gain.setTargetAtTime(0, t, 0.08);
      car.connect(env.node);
      bell.connect(bellG).connect(env.node);
    },
    organ(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const env = envGain(ac, t, 0.07 + 0.03 * vel, 0.012, 0, dur, 0.05);
      env.node.connect(out);
      [[1, 1], [2, 0.6], [3, 0.35], [4, 0.25], [0.5, 0.4]].forEach(([h, g]) => {
        const gn = ac.createGain(); gn.gain.value = g;
        osc(ac, 'sine', f * h, t, env.stopAt, 0).connect(gn).connect(env.node);
      });
    },
    pad(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const g = ac.createGain();
      const peak = 0.06 + 0.04 * vel;
      const attack = Math.min(0.35, dur * 0.5);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, t + dur);
      g.gain.setTargetAtTime(0, t + dur, 0.25);
      const stopAt = t + dur + 1.6;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900 + 1400 * vel;
      lp.connect(g).connect(out);
      [-8, 7].forEach((d) => osc(ac, 'sawtooth', f, t, stopAt, d).connect(lp));
    },
    fingerBass(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const env = envGain(ac, t, 0.32 * vel + 0.08, 0.006, 0.9, dur, 0.06);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(380 + 900 * vel, t);
      lp.frequency.setTargetAtTime(260, t + 0.01, 0.25);
      lp.connect(env.node).connect(out);
      osc(ac, 'sawtooth', f, t, env.stopAt, 0).connect(lp);
      const sub = ac.createGain(); sub.gain.value = 0.9;
      osc(ac, 'sine', f, t, env.stopAt, 0).connect(sub).connect(env.node);
    },
    upright(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const env = envGain(ac, t, 0.4 * vel + 0.08, 0.01, 0.45, dur, 0.08);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(700, t);
      lp.frequency.setTargetAtTime(320, t + 0.02, 0.12);
      lp.connect(env.node).connect(out);
      osc(ac, 'triangle', f, t, env.stopAt, 0).connect(lp);
      const g2 = ac.createGain(); g2.gain.value = 0.6;
      osc(ac, 'sine', f, t, env.stopAt, 0).connect(g2).connect(env.node);
    },
    synthBass(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const env = envGain(ac, t, 0.22 * vel + 0.06, 0.004, 0, dur, 0.04);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 7;
      lp.frequency.setValueAtTime(400 + 2600 * vel, t);
      lp.frequency.setTargetAtTime(220, t + 0.005, 0.09);
      lp.connect(env.node).connect(out);
      osc(ac, 'square', f, t, env.stopAt, 0).connect(lp);
      osc(ac, 'sawtooth', f, t, env.stopAt, 6).connect(lp);
    },
    strings(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sawtooth', -7], ['sawtooth', 6], ['sawtooth', 0]], attack: 0.16, release: 0.35, cutoff: 1400, vib: 5.2, vibDepth: 9, gain: 0.05 }); },
    violin(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sawtooth', -5], ['sawtooth', 5]], attack: 0.12, release: 0.3, cutoff: 2600, vib: 5.6, vibDepth: 14, gain: 0.06 }); },
    cello(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sawtooth', -4], ['sawtooth', 4]], attack: 0.14, release: 0.35, cutoff: 900, vib: 5, vibDepth: 10, gain: 0.08 }); },
    brass(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sawtooth', -3], ['sawtooth', 3]], attack: 0.05, release: 0.15, cutoff: 700, filterEnv: 2600, vib: 4.5, vibDepth: 4, gain: 0.07 }); },
    horn(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sawtooth', 0], ['triangle', 2]], attack: 0.08, release: 0.22, cutoff: 600, filterEnv: 900, vib: 4.5, vibDepth: 3, gain: 0.09 }); },
    flute(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sine', 0], ['triangle', 3]], attack: 0.07, release: 0.18, cutoff: 5000, vib: 5, vibDepth: 12, gain: 0.12, breath: 0.035 }); },
    reed(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['square', 0], ['square', 4]], attack: 0.05, release: 0.15, cutoff: 1500, vib: 5, vibDepth: 6, gain: 0.05 }); },
    choir(ac, out, pitch, vel, t, dur) { orch(ac, out, pitch, vel, t, dur, { waves: [['sawtooth', -9], ['sawtooth', 8]], attack: 0.25, release: 0.45, cutoff: 1100, vib: 4.6, vibDepth: 7, gain: 0.05, formant: true }); },
    pizz(ac, out, pitch, vel, t, dur) {
      const f = mtof(pitch);
      const env = envGain(ac, t, 0.22 * vel + 0.04, 0.003, 0.18 + Math.max(0, (72 - pitch) / 200), Math.min(dur, 0.6), 0.08);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.min(9000, f * 6), t);
      lp.frequency.setTargetAtTime(f * 1.5, t, 0.08);
      lp.connect(env.node).connect(out);
      osc(ac, 'triangle', f, t, env.stopAt, 0).connect(lp);
      osc(ac, 'sawtooth', f, t, env.stopAt, 3).connect(lp);
    },
    click(ac, out, pitch, vel, t) {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35 * vel, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      g.connect(out);
      osc(ac, 'sine', pitch, t, t + 0.06, 0).connect(g);
    },
  };

  // metronome: downbeat, beat, subdivision
  const CLICK_PITCH = [1760, 1318, 988];
  const CLICK_VEL = [1, 0.7, 0.38];

  function impulse(ac, seconds, decay) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  /** Dynamic value d (0..1) -> track level and brightness (what CC1/CC11 do in a library). */
  function exprValues(d) {
    const x = Math.max(0, Math.min(1, d));
    return { g: 0.06 + 0.94 * Math.pow(x, 1.6), f: 700 * Math.pow(2, x * 4.8) };
  }

  // ------------------------------------------------------------ player

  class Player {
    /**
     * @param opts.getProject      () => project
     * @param opts.getArrangement  () => arrangement
     * @param opts.onPosition      (pos) => void   (song position in quarters)
     * @param opts.onState         (playing) => void
     */
    constructor(opts) {
      this.opts = opts;
      this.ac = null;
      this.playing = false;
      this.position = 0;
      this.session = null;
      this.timer = null;
      this.raf = null;
    }

    get supported() { return !!(root.AudioContext || root.webkitAudioContext); }

    ensure() {
      if (!this.ac) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) throw new Error('הדפדפן לא תומך ב-Web Audio');
        this.ac = new AC({ latencyHint: 'interactive' });
        const ac = this.ac;
        this.master = ac.createGain();
        this.master.gain.value = 2.2;
        // safety limiter only: catches peaks, leaves the dynamics alone
        const limiter = ac.createDynamicsCompressor();
        limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
        limiter.attack.value = 0.002; limiter.release.value = 0.12;
        this.master.connect(limiter).connect(ac.destination);
        this.reverbSend = ac.createGain();
        this.reverbSend.gain.value = 0.22;
        const conv = ac.createConvolver();
        conv.buffer = impulse(ac, 2.6, 2.8);
        this.reverbSend.connect(conv).connect(this.master);
      }
      if (this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    }

    // ---- mixer
    effectiveGain(track, project) {
      if (this.listenTrack) return track.id === this.listenTrack ? track.volume : 0;
      const anySolo = project.tracks.some((t) => t.solo);
      if (track.mute || (anySolo && !track.solo)) return 0;
      return track.volume;
    }

    buildSession() {
      const ac = this.ac;
      const bus = ac.createGain();
      bus.connect(this.master);
      bus.connect(this.reverbSend);
      const tracks = {};
      const project = this.opts.getProject();
      project.tracks.forEach((tr) => {
        // expression stage: level + brightness, driven by the same curve as CC1/CC11
        const expr = ac.createGain();
        expr.gain.value = 1;
        const tone = ac.createBiquadFilter();
        tone.type = 'lowpass';
        tone.Q.value = 0.4;
        tone.frequency.value = 20000;
        const g = ac.createGain();
        g.gain.value = this.effectiveGain(tr, project);
        expr.connect(tone).connect(g);
        let node = g;
        if (ac.createStereoPanner) {
          const pan = ac.createStereoPanner();
          pan.pan.value = tr.pan || 0;
          g.connect(pan);
          node = pan;
        }
        node.connect(bus);
        tracks[tr.id] = { gain: g, input: expr, expr, tone, pan: node !== g ? node : null };
      });
      const click = ac.createGain();
      click.gain.value = this.clickGain(project);
      click.connect(this.master);
      return { bus, tracks, click };
    }

    /** Metronome level: its own volume, independent of the instruments. */
    clickGain(project) {
      const v = project.metro ? project.metro.volume : 0.7;
      return Math.pow(Math.max(0, Math.min(1, v)), 1.5) * 1.6;
    }

    updateMix() {
      if (!this.session) return;
      const project = this.opts.getProject();
      this.session.click.gain.setTargetAtTime(this.clickGain(project), this.ac.currentTime, 0.02);
      project.tracks.forEach((tr) => {
        const node = this.session.tracks[tr.id];
        if (!node) return;
        node.gain.gain.setTargetAtTime(this.effectiveGain(tr, project), this.ac.currentTime, 0.02);
        if (node.pan) node.pan.pan.setTargetAtTime(tr.pan || 0, this.ac.currentTime, 0.02);
      });
    }

    endSession() {
      if (!this.session) return;
      const s = this.session;
      this.session = null;
      try {
        s.bus.gain.setTargetAtTime(0, this.ac.currentTime, 0.015);
        s.click.gain.setTargetAtTime(0, this.ac.currentTime, 0.01);
      } catch (e) { /* ignore */ }
      setTimeout(() => { try { s.bus.disconnect(); s.click.disconnect(); } catch (e) { /* ignore */ } }, 400);
    }

    // ---- timing
    spq() { return 60 / this.opts.getProject().bpm; }

    loopRange() {
      const p = this.opts.getProject();
      const arr = this.arr;
      const barLen = arr.barLen;
      if (!p.loop.enabled) return { enabled: false, start: 0, end: arr.songEnd };
      const start = Math.min((p.loop.startBar - 1) * barLen, Math.max(0, arr.songEnd - barLen));
      let end = p.loop.endBar ? p.loop.endBar * barLen : arr.songEnd;
      if (end <= start) end = start + barLen;
      return { enabled: true, start, end };
    }

    vAt(time) { return this.anchorV + (time - this.anchorTime) / this.spq(); }

    songPos(v) {
      const L = this.loop;
      if (!L.enabled || v < L.start) return v;
      return L.start + ((v - L.start) % (L.end - L.start));
    }

    buildEvents() {
      const arr = this.arr;
      const ev = [];
      const exprPts = [];
      arr.tracks.forEach((at) => {
        const inst = CF.Instruments.get(at.track.instrument);
        const voice = inst ? inst.voice : 'grand';
        const sample = inst ? inst.id : null;
        const family = at.track.family;
        at.notes.forEach((n) => ev.push({ t: n.t, dur: n.dur, pitch: n.pitch, vel: n.vel, track: at.id, inst: voice, sample, family, art: n.art }));
        // the preview follows the same dynamics curve the MIDI controllers carry
        if (at.track.dyn && (at.track.dyn.cc1 || at.track.dyn.cc11)) {
          at.curve.forEach((p) => exprPts.push(Object.assign({ t: p.t, track: at.id }, exprValues(p.d))));
        }
      });
      ev.sort((a, b) => a.t - b.t);
      exprPts.sort((a, b) => a.t - b.t);
      this.events = ev;
      this.exprPts = exprPts;
    }

    lowerBound(t) {
      let lo = 0, hi = this.events.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].t < t - 1e-9) lo = mid + 1; else hi = mid; }
      return lo;
    }

    /** Recorded instruments used by the project (loads them in the background). */
    preload(project) {
      if (!CF.Sampler) return Promise.resolve(true);
      const ac = this.ensure();
      const ids = [...new Set(project.tracks.map((t) => t.instrument))];
      return Promise.all(ids.map((id) => CF.Sampler.load(ac, id))).then((r) => r.every(Boolean));
    }

    samplesReady(project) {
      return !CF.Sampler || project.tracks.every((t) => CF.Sampler.state(t.instrument) === 'ready' || CF.Sampler.state(t.instrument) === 'error');
    }

    // ---- transport
    /** Starts playback; waits for recorded instruments that are still loading. */
    async play(from) {
      const project = this.opts.getProject();
      this.ensure();
      if (!this.samplesReady(project)) {
        this.opts.onLoading && this.opts.onLoading(true);
        await this.preload(project);
        this.opts.onLoading && this.opts.onLoading(false);
      }
      this.startPlayback(from);
    }

    startPlayback(from) {
      this.endSession();
      this.arr = this.opts.getArrangement();
      this.loop = this.loopRange();
      this.buildEvents();
      let pos = from != null ? from : this.position;
      if (this.loop.enabled && (pos < this.loop.start || pos >= this.loop.end)) pos = this.loop.start;
      if (!this.loop.enabled && pos >= this.arr.songEnd) pos = 0;
      this.session = this.buildSession();
      this.arr.tracks.forEach((at) => {
        const node = this.session.tracks[at.id];
        if (!node || !(at.track.dyn && (at.track.dyn.cc1 || at.track.dyn.cc11)) || !at.curve.length) return;
        const p = at.curve.filter((x) => x.t <= pos + 1e-9).pop() || at.curve[0];
        const ev = exprValues(p.d);
        node.expr.gain.value = ev.g;
        node.tone.frequency.value = ev.f;
      });
      this.anchorTime = this.ac.currentTime + 0.08;
      this.anchorV = pos;
      this.schedV = pos;
      this.position = pos;
      this.playing = true;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
      this.animate();
      this.opts.onState && this.opts.onState(true);
    }

    pause() {
      if (!this.playing) return;
      this.position = this.songPos(Math.max(this.anchorV, this.vAt(this.ac.currentTime)));
      this.halt();
    }

    stop() {
      const wasLoop = this.arr && this.loop && this.loop.enabled;
      this.halt();
      this.position = wasLoop ? this.loop.start : 0;
      this.opts.onPosition && this.opts.onPosition(this.position);
    }

    halt() {
      this.playing = false;
      this.listenTrack = null;
      clearInterval(this.timer);
      this.timer = null;
      cancelAnimationFrame(this.raf);
      this.endSession();
      this.opts.onState && this.opts.onState(false);
      this.opts.onPosition && this.opts.onPosition(this.position);
    }

    seek(pos) {
      this.position = Math.max(0, pos);
      if (this.playing) this.play(this.position);
      else this.opts.onPosition && this.opts.onPosition(this.position);
    }

    /** Re-reads the project (notes, tempo, loop) without stopping playback. */
    refresh() {
      if (!this.playing) return;
      const now = this.ac.currentTime;
      const cur = this.songPos(Math.max(this.anchorV, this.vAt(now)));
      const ahead = Math.max(0, this.schedV - Math.max(this.anchorV, this.vAt(now)));
      this.arr = this.opts.getArrangement();
      this.loop = this.loopRange();
      this.buildEvents();
      let pos = cur;
      if (this.loop.enabled && (pos < this.loop.start || pos >= this.loop.end)) pos = this.loop.start;
      this.anchorTime = Math.max(now, this.anchorTime > now ? this.anchorTime : now);
      this.anchorV = pos;
      this.schedV = pos + ahead;
      this.updateMix();
    }

    tick() {
      if (!this.playing) return;
      const ac = this.ac;
      const now = ac.currentTime;
      // browsers throttle timers in background tabs to ~1s: schedule further ahead there
      const ahead = typeof document !== 'undefined' && document.hidden ? 1.6 : 0.14;
      const horizon = this.vAt(now + ahead);
      const L = this.loop;
      const project = this.opts.getProject();
      let guard = 0;
      while (this.schedV < horizon - 1e-9 && guard++ < 16) {
        let a = this.schedV, b = horizon, offset = 0, cycleEnd = Infinity;
        if (L.enabled && a >= L.start - 1e-9) {
          const len = L.end - L.start;
          const k = Math.floor((a - L.start) / len + 1e-9);
          const cycStart = L.start + k * len;
          offset = cycStart - L.start;
          b = Math.min(b, cycStart + len);
          cycleEnd = L.end;
        }
        const sa = a - offset, sb = b - offset;
        for (let i = this.lowerBound(sa); i < this.events.length && this.events[i].t < sb - 1e-9; i++) {
          const e = this.events[i];
          const when = this.anchorTime + (e.t + offset - this.anchorV) * this.spq();
          if (when < now - 0.01) continue;
          const dur = Math.min(e.dur, cycleEnd - e.t) * this.spq();
          const node = this.session.tracks[e.track];
          if (!node) continue;
          const at = Math.max(when, now), d = Math.max(0.03, dur);
          if (!(CF.Sampler && CF.Sampler.play(ac, node.input, e.sample, e.pitch, e.vel / 127, at, d, e.family, e.art))) {
            // synth fallback: same strong velocity curve as the samples
            const vg = ac.createGain();
            const v = e.vel / 127;
            vg.gain.value = Math.pow(v, 1.4) * 1.8;
            vg.connect(node.input);
            (VOICES[e.inst] || VOICES.grand)(ac, vg, e.pitch, v, at, d);
          }
        }
        this.exprPts.forEach((x) => {
          if (x.t >= sa - 1e-9 && x.t < sb - 1e-9) {
            const node = this.session.tracks[x.track];
            const when = this.anchorTime + (x.t + offset - this.anchorV) * this.spq();
            if (node && when >= now - 0.05) {
              node.expr.gain.setTargetAtTime(x.g, Math.max(when, now), 0.05);
              node.tone.frequency.setTargetAtTime(x.f, Math.max(when, now), 0.06);
            }
          }
        });
        if (project.metronome) {
          this.arr.beatGrid.forEach((g) => {
            if (g.t >= sa - 1e-9 && g.t < sb - 1e-9) {
              const when = this.anchorTime + (g.t + offset - this.anchorV) * this.spq();
              if (when >= now - 0.01) VOICES.click(ac, this.session.click, CLICK_PITCH[g.level || 0], CLICK_VEL[g.level || 0], Math.max(when, now));
            }
          });
        }
        this.schedV = b;
      }
      if (!L.enabled && this.vAt(now) >= this.arr.songEnd + 0.05) {
        this.position = 0;
        this.halt();
      }
    }

    animate() {
      const step = () => {
        if (!this.playing) return;
        const v = this.vAt(this.ac.currentTime);
        if (v >= this.anchorV) {
          this.position = this.songPos(v);
          this.opts.onPosition && this.opts.onPosition(this.position);
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    /**
     * Renders the arrangement to audio, faster than real time (OfflineAudioContext).
     * opts: { mode: 'mix' | 'solo' | 'minus', trackId, metronome, countIn }
     * Resolves to an AudioBuffer. Uses the same voices, samples, expression and mix as playback.
     */
    async render(project, arr, opts) {
      opts = opts || {};
      await this.preload(project);
      const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      if (!OAC) throw new Error('הדפדפן לא תומך ברינדור שמע');
      const spq = 60 / project.bpm;
      const lead = 0.05 + (opts.countIn ? arr.barLen * spq : 0);
      const length = lead + arr.songEnd * spq + 3.5;
      const sr = 44100;
      const ac = new OAC(2, Math.ceil(length * sr), sr);
      const master = ac.createGain();
      master.gain.value = this.master ? this.master.gain.value : 2.2;
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.002; limiter.release.value = 0.12;
      master.connect(limiter).connect(ac.destination);
      const send = ac.createGain();
      send.gain.value = 0.22;
      const conv = ac.createConvolver();
      conv.buffer = impulse(ac, 2.6, 2.8);
      send.connect(conv).connect(master);

      const audible = (tr) => {
        if (opts.mode === 'solo') return tr.id === opts.trackId;
        if (opts.mode === 'minus') return tr.id !== opts.trackId && !tr.mute;
        return this.effectiveGain(tr, project) > 0;
      };
      arr.tracks.forEach((at) => {
        const tr = at.track;
        if (!audible(tr)) return;
        const expr = ac.createGain();
        const tone = ac.createBiquadFilter();
        tone.type = 'lowpass'; tone.Q.value = 0.4; tone.frequency.value = 20000;
        const g = ac.createGain();
        g.gain.value = tr.volume;
        expr.connect(tone).connect(g);
        let out = g;
        if (ac.createStereoPanner) { const pan = ac.createStereoPanner(); pan.pan.value = tr.pan || 0; g.connect(pan); out = pan; }
        out.connect(master);
        out.connect(send);
        if (tr.dyn && (tr.dyn.cc1 || tr.dyn.cc11)) {
          at.curve.forEach((pt, i) => {
            const ev = exprValues(pt.d);
            const when = lead + pt.t * spq;
            if (i === 0) { expr.gain.setValueAtTime(ev.g, 0); tone.frequency.setValueAtTime(ev.f, 0); }
            expr.gain.setTargetAtTime(ev.g, when, 0.05);
            tone.frequency.setTargetAtTime(ev.f, when, 0.06);
          });
        }
        const inst = CF.Instruments.get(tr.instrument);
        const voice = inst ? inst.voice : 'grand';
        at.notes.forEach((n) => {
          const t = lead + n.t * spq, d = Math.max(0.03, n.dur * spq), v = n.vel / 127;
          if (!(CF.Sampler && CF.Sampler.play(ac, expr, tr.instrument, n.pitch, v, t, d, tr.family, n.art))) {
            const vg = ac.createGain();
            vg.gain.value = Math.pow(v, 1.4) * 1.8;
            vg.connect(expr);
            (VOICES[voice] || VOICES.grand)(ac, vg, n.pitch, v, t, d);
          }
        });
      });
      if (opts.metronome || opts.countIn) {
        const click = ac.createGain();
        click.gain.value = this.clickGain(project);
        click.connect(master);
        const grid = arr.beatGrid.slice();
        if (opts.countIn) arr.beatGrid.filter((g) => g.t < arr.barLen - 1e-6).forEach((g) => grid.push({ t: g.t - arr.barLen, level: g.level, count: true }));
        grid.forEach((g) => {
          if (!opts.metronome && !g.count) return;
          VOICES.click(ac, click, CLICK_PITCH[g.level || 0], CLICK_VEL[g.level || 0], lead + g.t * spq);
        });
      }
      return ac.startRendering();
    }

    /** Plays the same notes soft (pp) and then loud (ff), so the dynamic range is heard directly. */
    compare(track, notes, project) {
      const ac = this.ensure();
      const t0 = ac.currentTime + 0.05;
      const inst = CF.Instruments.get(track.instrument);
      const sustained = ['strings', 'brass', 'winds', 'pad'].includes(track.family);
      [[0.18, 0], [0.95, 1.9]].forEach(([d, off]) => {
        const ex = exprValues(d);
        const g = ac.createGain();
        g.gain.value = (sustained ? ex.g : 1) * (track.volume || 0.8) * 1.2;
        const tone = ac.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = sustained ? ex.f : 20000;
        tone.connect(g).connect(this.master);
        g.connect(this.reverbSend);
        const vel = 0.12 + 0.86 * d;
        notes.forEach((p) => {
          if (!(CF.Sampler && CF.Sampler.play(ac, tone, track.instrument, p, vel, t0 + off, 1.5, track.family))) {
            (VOICES[inst ? inst.voice : 'grand'] || VOICES.grand)(ac, tone, p, vel, t0 + off, 1.5);
          }
        });
        setTimeout(() => { try { g.disconnect(); } catch (e) { /* ignore */ } }, (off + 4) * 1000);
      });
    }

    /** One metronome click right now (for setting the metronome volume). */
    testClick(project) {
      const ac = this.ensure();
      const g = ac.createGain();
      g.gain.value = this.clickGain(project);
      g.connect(this.master);
      VOICES.click(ac, g, CLICK_PITCH[0], CLICK_VEL[0], ac.currentTime + 0.01);
      setTimeout(() => { try { g.disconnect(); } catch (e) { /* ignore */ } }, 300);
    }

    /**
     * Plays one chord immediately (used when clicking a chord).
     * parts: [{ track, notes: [pitches] }]
     */
    audition(parts, project) {
      const ac = this.ensure();
      const t = ac.currentTime + 0.02;
      const bus = ac.createGain();
      bus.gain.value = 0.9;
      bus.connect(this.master);
      bus.connect(this.reverbSend);
      parts.forEach(({ track, notes }) => {
        const gain = this.effectiveGain(track, project);
        if (!gain || !notes || !notes.length) return;
        const g = ac.createGain(); g.gain.value = gain; g.connect(bus);
        const inst = CF.Instruments.get(track.instrument);
        const voice = VOICES[inst ? inst.voice : 'grand'] || VOICES.grand;
        const vel = CF.Dynamics.levelValue(track.dyn.level) * 0.9 + 0.1;
        notes.forEach((p) => {
          if (!(CF.Sampler && CF.Sampler.play(ac, g, track.instrument, p, vel, t, 1.4, track.family))) voice(ac, g, p, vel, t, 1.3);
        });
      });
      setTimeout(() => { try { bus.disconnect(); } catch (e) { /* ignore */ } }, 4000);
    }
  }

  /** 16-bit PCM WAV file from an AudioBuffer (the tail of silence is trimmed). */
  function encodeWav(buffer) {
    const ch = Math.min(2, buffer.numberOfChannels);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
    let len = buffer.length;
    while (len > buffer.sampleRate && data.every((d) => Math.abs(d[len - 1]) < 1e-4)) len--;
    len = Math.min(buffer.length, len + Math.floor(buffer.sampleRate * 0.25));
    const bytes = 44 + len * ch * 2;
    const view = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * ch * 2, true);
    view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, len * ch * 2, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const x = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
  }

  CF.Player = Player;
  CF.encodeWav = encodeWav;
  CF.AudioVoices = VOICES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
