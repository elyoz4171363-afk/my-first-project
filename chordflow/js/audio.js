/*
 * ChordFlow — Web Audio preview engine.
 * Synthesised instruments (no samples, no server), a look-ahead scheduler
 * with seamless looping, metronome, live mixer updates and chord audition.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ------------------------------------------------------------ voices
  // Each voice: (ac, out, pitch, vel 0..1, t, dur) — schedules itself and stops on its own.

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
    click(ac, out, pitch, vel, t) {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35 * vel, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      g.connect(out);
      osc(ac, 'sine', pitch, t, t + 0.06, 0).connect(g);
    },
  };

  function impulse(ac, seconds, decay) {
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
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
        this.master.gain.value = 0.75;
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3;
        comp.attack.value = 0.005; comp.release.value = 0.2;
        this.master.connect(comp).connect(ac.destination);
        this.reverbSend = ac.createGain();
        this.reverbSend.gain.value = 0.16;
        const conv = ac.createConvolver();
        conv.buffer = impulse(ac, 2.2, 3);
        this.reverbSend.connect(conv).connect(this.master);
      }
      if (this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    }

    // ---- mixer
    effectiveGain(track, project) {
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
        const g = ac.createGain();
        g.gain.value = this.effectiveGain(tr, project);
        let node = g;
        if (ac.createStereoPanner) {
          const pan = ac.createStereoPanner();
          pan.pan.value = tr.pan || 0;
          g.connect(pan);
          node = pan;
        }
        node.connect(bus);
        tracks[tr.id] = { gain: g, input: g };
      });
      const click = ac.createGain();
      click.gain.value = 0.8;
      click.connect(this.master);
      return { bus, tracks, click };
    }

    updateMix() {
      if (!this.session) return;
      const project = this.opts.getProject();
      project.tracks.forEach((tr) => {
        const node = this.session.tracks[tr.id];
        if (node) node.gain.gain.setTargetAtTime(this.effectiveGain(tr, project), this.ac.currentTime, 0.02);
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
      arr.tracks.forEach((at) => at.notes.forEach((n) => ev.push({ t: n.t, dur: n.dur, pitch: n.pitch, vel: n.vel, track: at.id, inst: at.track.instrument })));
      ev.sort((a, b) => a.t - b.t);
      this.events = ev;
    }

    lowerBound(t) {
      let lo = 0, hi = this.events.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].t < t - 1e-9) lo = mid + 1; else hi = mid; }
      return lo;
    }

    // ---- transport
    play(from) {
      this.ensure();
      this.endSession();
      this.arr = this.opts.getArrangement();
      this.loop = this.loopRange();
      this.buildEvents();
      let pos = from != null ? from : this.position;
      if (this.loop.enabled && (pos < this.loop.start || pos >= this.loop.end)) pos = this.loop.start;
      if (!this.loop.enabled && pos >= this.arr.songEnd) pos = 0;
      this.session = this.buildSession();
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
      const horizon = this.vAt(now + 0.14);
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
          const voice = VOICES[e.inst] || VOICES.grand;
          if (node) voice(ac, node.input, e.pitch, e.vel / 127, Math.max(when, now), Math.max(0.03, dur));
        }
        if (project.metronome) {
          this.arr.beatGrid.forEach((g) => {
            if (g.t >= sa - 1e-9 && g.t < sb - 1e-9) {
              const when = this.anchorTime + (g.t + offset - this.anchorV) * this.spq();
              if (when >= now - 0.01) VOICES.click(ac, this.session.click, g.down ? 1760 : 1175, g.down ? 1 : 0.6, Math.max(when, now));
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

    /** Plays one chord immediately (used when clicking a chord). */
    audition(pianoNotes, bassPitch, project) {
      const ac = this.ensure();
      const t = ac.currentTime + 0.02;
      const bus = ac.createGain();
      bus.gain.value = 0.9;
      bus.connect(this.master);
      bus.connect(this.reverbSend);
      const piano = project.tracks.find((x) => x.role === 'piano');
      const bass = project.tracks.find((x) => x.role === 'bass');
      if (piano && pianoNotes) {
        const g = ac.createGain(); g.gain.value = this.effectiveGain(piano, project) || 0.0001; g.connect(bus);
        pianoNotes.forEach((p) => (VOICES[piano.instrument] || VOICES.grand)(ac, g, p, piano.velocity / 127, t, 1.3));
      }
      if (bass && bassPitch != null) {
        const g = ac.createGain(); g.gain.value = this.effectiveGain(bass, project) || 0.0001; g.connect(bus);
        (VOICES[bass.instrument] || VOICES.fingerBass)(ac, g, bassPitch, bass.velocity / 127, t, 1.3);
      }
      setTimeout(() => { try { bus.disconnect(); } catch (e) { /* ignore */ } }, 4000);
    }
  }

  CF.Player = Player;
  CF.AudioVoices = VOICES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
