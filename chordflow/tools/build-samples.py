#!/usr/bin/env python3
"""
Builds ChordFlow's sample packs: chordflow/samples/<instrument>.js

Each pack is a small script that registers base64 MP3 samples, so it loads with a
plain <script> tag — also when index.html is opened from disk (file://), where
fetch() of local files is blocked.

Sources (both on npm, free licences — see chordflow/samples/CREDITS.md):
  * Salamander Grand Piano V3  (@audio-samples/piano-mp3-velocity8, CC BY 3.0, Alexander Holm)
  * FluidR3_GM                 (soundfont-for-samplers, MIT; FluidR3 by Frank Wen)

Usage:
  python3 chordflow/tools/build-samples.py --fluid <.../FluidR3_GM> --salamander <.../audio>

One sample every 3 semitones inside each instrument's range (±1 octave);
the player pitch-shifts to the notes in between.
"""
import argparse
import base64
import json
import os
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'samples')

FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# instrument id -> (FluidR3 folder, range low, range high, loop?)
FLUID = {
    'epiano': ('electric_piano_1', 28, 103, False),
    'organ': ('drawbar_organ', 24, 96, True),
    'harp': ('orchestral_harp', 24, 103, False),
    'fingerBass': ('electric_bass_finger', 24, 67, False),
    'upright': ('acoustic_bass', 24, 67, False),
    'synthBass': ('synth_bass_1', 24, 67, False),
    'stringsEns': ('string_ensemble_1', 36, 96, True),
    'violins': ('violin', 55, 100, True),
    'violas': ('viola', 48, 88, True),
    'cellos': ('cello', 36, 76, True),
    'pizz': ('pizzicato_strings', 36, 96, False),
    'brassEns': ('brass_section', 40, 84, True),
    'horns': ('french_horn', 41, 77, True),
    'trumpets': ('trumpet', 55, 84, True),
    'trombones': ('trombone', 34, 72, True),
    'flute': ('flute', 60, 96, True),
    'oboe': ('oboe', 58, 91, True),
    'clarinet': ('clarinet', 50, 91, True),
    'bassoon': ('bassoon', 34, 75, True),
    'warmPad': ('pad_2_warm', 36, 96, True),
    'choir': ('pad_4_choir', 45, 84, True),
}


def notes_in(lo, hi):
    """MIDI notes on the C / Eb / Gb / A grid covering [lo-12, hi+12]."""
    lo = max(21, lo - 12)
    hi = min(108, hi + 12)
    out = [n for n in range(21, 109) if n % 3 == 0 and lo - 2 <= n <= hi + 2]
    return out


def fluid_name(midi):
    return FLAT[midi % 12] + str(midi // 12 - 1)


def write_pack(inst_id, notes, loop):
    payload = {'id': inst_id, 'loop': loop, 'notes': notes}
    js = '/* ChordFlow sample pack: %s (see CREDITS.md) */\n' % inst_id
    js += '(window.CF = window.CF || {}); (CF.SamplePacks = CF.SamplePacks || {})[%s] = %s;\n' % (
        json.dumps(inst_id), json.dumps(payload, separators=(',', ':')))
    js += 'if (CF.Sampler && CF.Sampler.packArrived) CF.Sampler.packArrived(%s);\n' % json.dumps(inst_id)
    path = os.path.join(OUT, inst_id + '.js')
    with open(path, 'w') as f:
        f.write(js)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fluid', required=True)
    ap.add_argument('--salamander', required=True)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    total = 0

    # Salamander piano: trimmed to 9 s with a gentle fade, re-encoded once
    notes = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name in sorted(os.listdir(args.salamander)):
            if not name.endswith('v8.mp3'):
                continue
            note = name[:-6]
            pc = SHARP.index(note[:-1])
            midi = (int(note[-1]) + 1) * 12 + pc
            dst = os.path.join(tmp, name)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(args.salamander, name),
                            '-t', '9', '-af', 'afade=t=out:st=7.5:d=1.5', '-b:a', '128k', dst], check=True)
            with open(dst, 'rb') as f:
                notes[str(midi)] = base64.b64encode(f.read()).decode()
    total += write_pack('grand', notes, False)

    for inst_id, (folder, lo, hi, loop) in FLUID.items():
        notes = {}
        for midi in notes_in(lo, hi):
            path = os.path.join(args.fluid, folder + '-mp3', fluid_name(midi) + '.mp3')
            if os.path.exists(path):
                with open(path, 'rb') as f:
                    notes[str(midi)] = base64.b64encode(f.read()).decode()
        if not notes:
            raise SystemExit('no samples for ' + inst_id)
        total += write_pack(inst_id, notes, loop)
        print('%-11s %2d samples' % (inst_id, len(notes)))
    print('total %.1f MB' % (total / 1e6))


if __name__ == '__main__':
    main()
