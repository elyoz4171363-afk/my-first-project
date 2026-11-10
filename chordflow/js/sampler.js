/*
 * ChordFlow - sampler.
 * Plays recorded instrument samples (samples/<instrument>.js) with velocity-sensitive
 * level and brightness, seamless loops for sustained instruments, and natural release.
 * Packs load lazily with a <script> tag, so this also works from file://.
 * If a pack can't be loaded, the player falls back to the built-in synth voices.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});

  const sets = {};          // id -> { state, buffers: [{ midi, buffer }], loop, loopStart, loopEnd, promise }
  const waiting = {};       // id -> resolve callback for the script tag
  let baseUrl = 'samples/';

  function b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function decode(ac, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const p = ac.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  /**
   * Makes [loopStart, loopEnd) loop without a click: the last `fade` seconds before
   * loopEnd are cross-faded (equal power) into the audio just before loopStart.
   */
  function prepareLoop(buffer) {
    const sr = buffer.sampleRate;
    const dur = buffer.duration;
    const loopStart = Math.min(1.0, dur * 0.35);
    const loopEnd = Math.max(loopStart + 0.6, Math.min(dur - 0.12, 2.9));
    const fade = Math.min(0.3, (loopEnd - loopStart) / 3, loopStart);
    const L = Math.floor(loopStart * sr), E = Math.floor(loopEnd * sr), X = Math.floor(fade * sr);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < X; i++) {
        const f = i / X;
        const a = Math.cos(f * Math.PI / 2), b = Math.sin(f * Math.PI / 2);
        d[E - X + i] = d[E - X + i] * a + d[L - X + i] * b;
      }
    }
    return { loopStart: L / sr, loopEnd: E / sr };
  }

  function loadScript(id) {
    return new Promise((resolve, reject) => {
      if (CF.SamplePacks && CF.SamplePacks[id]) { resolve(); return; }
      waiting[id] = resolve;
      const s = document.createElement('script');
      s.src = baseUrl + id + '.js';
      s.async = true;
      s.onload = () => { if (CF.SamplePacks && CF.SamplePacks[id]) resolve(); };
      s.onerror = () => reject(new Error('pack not found: ' + id));
      document.head.appendChild(s);
    });
  }

  const Sampler = {
    setBase(url) { baseUrl = url; },

    /** Called by a pack script when it has registered its data. */
    packArrived(id) { if (waiting[id]) { waiting[id](); delete waiting[id]; } },

    state(id) { return sets[id] ? sets[id].state : 'idle'; },
    ready(id) { return !!sets[id] && sets[id].state === 'ready'; },

    /** Loads and decodes an instrument (once). Resolves true when ready, false on failure. */
    load(ac, id) {
      if (sets[id] && sets[id].promise) return sets[id].promise;
      const set = (sets[id] = { state: 'loading', buffers: [], loop: false });
      set.promise = loadScript(id)
        .then(() => {
          const pack = CF.SamplePacks[id];
          set.loop = !!pack.loop;
          const entries = Object.entries(pack.notes);
          return Promise.all(entries.map(([midi, b64]) => decode(ac, b64ToArrayBuffer(b64)).then((buffer) => {
            const item = { midi: +midi, buffer };
            if (set.loop) Object.assign(item, prepareLoop(buffer));
            return item;
          })));
        })
        .then((items) => {
          set.buffers = items.sort((a, b) => a.midi - b.midi);
          set.state = 'ready';
          if (CF.SamplePacks) delete CF.SamplePacks[id]; // free the base64 text
          return true;
        })
        .catch(() => { set.state = 'error'; return false; });
      return set.promise;
    },

    /**
     * Schedules one note. Returns false if the instrument isn't loaded (caller falls back to synth).
     * vel: 0..1   family: decides release and how velocity shapes the tone
     */
    play(ac, out, id, pitch, vel, t, dur, family, art) {
      const set = sets[id];
      if (!set || set.state !== 'ready' || !set.buffers.length) return false;
      let best = set.buffers[0];
      for (const b of set.buffers) if (Math.abs(b.midi - pitch) < Math.abs(best.midi - pitch)) best = b;
      const src = ac.createBufferSource();
      src.buffer = best.buffer;
      src.playbackRate.value = Math.pow(2, (pitch - best.midi) / 12);
      if (set.loop) {
        src.loop = true;
        src.loopStart = best.loopStart;
        src.loopEnd = best.loopEnd;
      }
      const v = Math.max(0.02, Math.min(1, vel));
      const sustained = family === 'strings' || family === 'brass' || family === 'winds' || family === 'pad';
      // level: struck/plucked instruments follow velocity strongly (about 25 dB from pp to ff);
      // sustained instruments get their dynamics mostly from the expression curve (like CC1/CC11)
      const amp = (sustained ? Math.pow(v, 1.0) : Math.pow(v, 2.6)) * 1.15;
      // tone: soft notes are darker, loud notes open up
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.value = sustained ? 1200 * Math.pow(2, v * 4) : 500 * Math.pow(2, v * 5.4);
      const g = ac.createGain();
      const release = family === 'keys' ? 0.35 : family === 'bass' ? 0.12 : (art === 'staccato' || art === 'spiccato') ? 0.08 : sustained ? 0.28 : 0.2;
      const end = t + Math.max(0.04, dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.004);
      g.gain.setValueAtTime(amp, end);
      g.gain.setTargetAtTime(0, end, release / 3);
      if (art === 'tremolo') {
        // bowed tremolo: fast amplitude flutter on a held note
        const trem = ac.createGain();
        trem.gain.value = 0.7;
        const lfo = ac.createOscillator();
        const depth = ac.createGain();
        lfo.frequency.value = 11 + Math.random() * 2;
        depth.gain.value = 0.3;
        lfo.connect(depth).connect(trem.gain);
        lfo.start(t);
        lfo.stop(end + release * 3 + 0.05);
        src.connect(lp).connect(trem).connect(g).connect(out);
      } else {
        src.connect(lp).connect(g).connect(out);
      }
      src.start(t);
      src.stop(end + release * 3 + 0.05);
      // handle (truthy): lets a live note (MIDI keyboard) end early on note-off
      return {
        release(at) {
          try {
            g.gain.cancelScheduledValues(at);
            g.gain.setValueAtTime(amp, Math.max(at, t + 0.005));
            g.gain.setTargetAtTime(0, Math.max(at, t + 0.005), release / 3);
            src.stop(Math.max(at, t + 0.005) + release * 3 + 0.05);
          } catch (e) { /* already stopped */ }
        },
      };
    },
  };

  CF.Sampler = Sampler;
})(typeof globalThis !== 'undefined' ? globalThis : this);
