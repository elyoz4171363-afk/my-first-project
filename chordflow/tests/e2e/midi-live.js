// Live MIDI with a mock Web MIDI layer (no real device here): every Hebrew state, device lists,
// sending the song during playback (channels, velocity, CC1/CC11/CC64), stop without hanging
// notes, keyboard input -> sound, and a device that disconnects.
const { chromium } = require('playwright');
const URL = process.argv[2];
const SHOT = process.argv[3];

// mode: 'unsupported' | 'denied' | 'none' | 'ready'
function mock(mode) {
  window.__sent = [];
  if (mode === 'unsupported') { try { delete Navigator.prototype.requestMIDIAccess; } catch (e) { /* */ } navigator.requestMIDIAccess = undefined; return; }
  const mkPort = (id, name, type) => ({ id, name, type, state: 'connected', onmidimessage: null,
    send(data, ts) { window.__sent.push({ d: Array.from(data), ts: ts || performance.now() }); }, clear() { window.__cleared = (window.__cleared || 0) + 1; } });
  const inputs = new Map(), outputs = new Map();
  if (mode === 'ready') { inputs.set('in1', mkPort('in1', 'Keys 61', 'input')); outputs.set('out1', mkPort('out1', 'loopMIDI Port', 'output')); }
  const access = { inputs, outputs, onstatechange: null, sysexEnabled: false };
  window.__midi = access;
  navigator.requestMIDIAccess = () => (mode === 'denied' ? Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })) : Promise.resolve(access));
}

(async () => {
  const b = await chromium.launch(); const errors = [];
  const states = {};
  for (const mode of ['unsupported', 'denied', 'none']) {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(mock, mode);
    await p.addInitScript(() => localStorage.setItem('chordflow.guideSeen', '1'));
    await p.goto(URL); await p.waitForSelector('.chord-block');
    await p.click('#midiBtn'); await p.click('#midiConnect');
    await p.waitForTimeout(200);
    states[mode] = (await p.textContent('#midiState b')).trim();
    await p.close();
  }
  console.log('states:', JSON.stringify(states));
  const want = { unsupported: 'הדפדפן לא תומך ב-MIDI', denied: 'הגישה ל-MIDI נחסמה', none: 'אין מכשיר MIDI מחובר' };
  Object.keys(want).forEach((k) => { if (states[k] !== want[k]) console.log('FAILED state', k, states[k]); });

  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.addInitScript(mock, 'ready');
  await p.addInitScript(() => localStorage.setItem('chordflow.guideSeen', '1'));
  await p.goto(URL); await p.waitForSelector('.chord-block');
  await p.click('#midiBtn'); await p.click('#midiConnect'); await p.waitForTimeout(200);
  console.log('ready state:', (await p.textContent('#midiState')).replace(/\s+/g, ' ').trim());
  console.log('input auto-selected:', await p.inputValue('#midiIn'), '| outputs:', await p.$$eval('#midiOut option', (o) => o.map((x) => x.textContent).join(', ')));
  await p.selectOption('#midiOut', 'out1');
  await p.check('#midiSend');
  await p.uncheck('#midiLocal');
  if (SHOT) await p.screenshot({ path: SHOT });
  await p.click('#midiModal [data-close]');

  // play 2.5 s, then stop
  await p.evaluate(() => { ChordFlowApp.state.project.bpm = 120; ChordFlowApp.recompute(); });
  await p.click('#playBtn'); await p.waitForTimeout(2500); await p.click('#stopBtn'); await p.waitForTimeout(100);
  const r = await p.evaluate(() => {
    const s = window.__sent;
    const on = s.filter((x) => (x.d[0] & 0xf0) === 0x90 && x.d[2] > 0);
    const off = s.filter((x) => (x.d[0] & 0xf0) === 0x80);
    const cc = s.filter((x) => (x.d[0] & 0xf0) === 0xb0);
    const chans = [...new Set(on.map((x) => (x.d[0] & 15) + 1))].sort((a, b) => a - b);
    const tracks = ChordFlowApp.state.project.tracks.map((t) => t.channel + 1).sort((a, b) => a - b);
    const ccNums = [...new Set(cc.map((x) => x.d[1]))].sort((a, b) => a - b);
    const panic = cc.filter((x) => x.d[1] === 123).length;
    const vels = on.map((x) => x.d[2]);
    return { noteOns: on.length, noteOffs: off.length, chans: chans.join(','), trackChans: tracks.join(','), ccNums: ccNums.join(','), allNotesOff: panic, cleared: window.__cleared || 0, velRange: Math.min(...vels) + '-' + Math.max(...vels), futureTs: on.some((x) => x.ts > performance.now() - 5000) };
  });
  console.log('sent while playing:', JSON.stringify(r));
  if (!(r.noteOns > 5 && r.noteOffs > 0)) console.log('FAILED no notes sent');
  const tc = r.trackChans.split(',');
  if (!r.chans.split(',').every((c) => tc.includes(c)) || r.chans.split(',').length < 3) console.log('FAILED channels', r.chans, r.trackChans);
  if (!/(^|,)64(,|$)/.test(r.ccNums) || !/(^|,)11(,|$)/.test(r.ccNums)) console.log('FAILED controllers', r.ccNums);
  if (!(r.allNotesOff > 0 && r.cleared > 0)) console.log('FAILED stop must clear the queue and send All Notes Off');

  // browser sound off while sending: no sampler notes
  const local = await p.evaluate(async () => {
    let n = 0; const orig = CF.Sampler.play; CF.Sampler.play = function () { n++; return orig.apply(this, arguments); };
    ChordFlowApp.player.play(0); await new Promise((z) => setTimeout(z, 800)); ChordFlowApp.player.stop();
    CF.Sampler.play = orig; return n;
  });
  console.log('browser notes with "להשמיע גם בדפדפן" off:', local);
  if (local !== 0) console.log('FAILED local sound should be silent');

  // keyboard input -> sound, with pedal
  const inp = await p.evaluate(async () => {
    await ChordFlowApp.player.preload(ChordFlowApp.state.project);
    let played = 0; const orig = CF.Sampler.play; CF.Sampler.play = function () { played++; return orig.apply(this, arguments); };
    const port = window.__midi.inputs.get('in1');
    port.onmidimessage({ data: new Uint8Array([0x90, 64, 100]), timeStamp: performance.now() });
    port.onmidimessage({ data: new Uint8Array([0xb0, 64, 127]), timeStamp: performance.now() });
    port.onmidimessage({ data: new Uint8Array([0x80, 64, 0]), timeStamp: performance.now() });
    port.onmidimessage({ data: new Uint8Array([0xb0, 64, 0]), timeStamp: performance.now() });
    CF.Sampler.play = orig;
    return { played, last: document.getElementById('midiLast').textContent };
  });
  console.log('keyboard input:', JSON.stringify(inp));
  if (inp.played !== 1) console.log('FAILED input note did not sound');

  // device unplugged
  await p.click('#midiBtn');
  await p.evaluate(() => { const port = window.__midi.outputs.get('out1'); port.state = 'disconnected'; window.__midi.outputs.delete('out1'); window.__midi.onstatechange({ port }); });
  await p.waitForTimeout(100);
  console.log('after unplug:', (await p.textContent('#midiState b')).trim(), '| dot:', await p.getAttribute('#midiDot', 'class'));
  if (!/נותק/.test(await p.textContent('#midiState b'))) console.log('FAILED disconnect message');
  console.log('errors:', errors.length ? errors : 'none');
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
