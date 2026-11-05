#!/usr/bin/env bash
# Builds the tester package: chordflow/dist/ChordFlow-לבדיקה.zip
#   ChordFlow.html (single file) + samples/ + demo MIDI + demo audio + tester checklist
#
#   bash chordflow/tools/package-tester.sh
#
# Needs node, python3, a global playwright with Chromium (for the demo audio), ffmpeg (optional, for MP3).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$APP/dist"
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
mkdir -p "$DIST"

echo "1/5 single-file build"
python3 "$APP/tools/build-single.py" "$DIST/ChordFlow.html"

echo "2/5 demo MIDI"
(cd "$APP" && node -e "
const CF = require('./tests/load.js'); const P = CF.Project;
const p = P.create({ name: 'ChordFlow Orchestral Demo', ensemble: 'ballad',
  progression: '[Verse] Am | F | C | G | Dm7 | E7sus4 E7 | [Chorus] F | G | Em7 | Am | Dm7 | G | C | -' });
p.bpm = 84;
const horns = p.tracks.find((t) => t.instrument === 'horns');
p.sections[0].tracks[horns.id] = { on: false };
require('fs').writeFileSync('dist/ChordFlow-דוגמה-תזמורתית.mid', Buffer.from(CF.Midi.build(p, CF.Arranger.arrange(p))));
")

echo "3/5 demo audio"
node "$APP/tools/render-demo.js" "$DIST/ChordFlow-demo.wav"
AUDIO="ChordFlow-demo.wav"
if command -v ffmpeg >/dev/null; then
  ffmpeg -v error -y -i "$DIST/ChordFlow-demo.wav" -b:a 192k "$DIST/ChordFlow-דוגמת-שמע.mp3" && rm "$DIST/ChordFlow-demo.wav"
  AUDIO="ChordFlow-דוגמת-שמע.mp3"
fi

echo "4/5 tester checklist"
cp "$APP/tools/tester-checklist.txt" "$DIST/הוראות בדיקה - ChordFlow.txt"

echo "5/5 zip"
(cd "$DIST" && rm -f "ChordFlow-לבדיקה.zip" && python3 - "$AUDIO" <<'EOF'
import os, sys, zipfile
audio = sys.argv[1]
with zipfile.ZipFile('ChordFlow-לבדיקה.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in ['ChordFlow.html', 'ChordFlow-דוגמה-תזמורתית.mid', audio, 'הוראות בדיקה - ChordFlow.txt']:
        z.write(f, 'ChordFlow-לבדיקה/' + f)
    for f in sorted(os.listdir('samples')):
        z.write('samples/' + f, 'ChordFlow-לבדיקה/samples/' + f)
print('ChordFlow-לבדיקה.zip', round(os.path.getsize('ChordFlow-לבדיקה.zip') / 1e6, 1), 'MB')
EOF
)
