#!/usr/bin/env bash
# ChordFlow - browser (end-to-end) checks with Playwright + Chromium.
#
#   bash chordflow/tests/e2e/run-all.sh            # all checks
#   bash chordflow/tests/e2e/run-all.sh melody     # only scripts whose name contains "melody"
#
# Needs: node, a global `playwright` package with Chromium (NODE_PATH=$(npm root -g)),
# python3 (for the static server). Screenshots and downloads go to chordflow/tests/out/e2e/.
# Each script prints its findings; a check FAILS when it exits non-zero, prints FAILED,
# or reports page errors. Read the printed lines - they are the evidence.
#
# The full single-file build check needs `python3 chordflow/tools/build-single.py` first.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"           # chordflow/
OUT="$APP/tests/out/e2e"
PORT="${CHORDFLOW_PORT:-8090}"
export CHORDFLOW_URL="http://localhost:$PORT/index.html"
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
export LANG="${LANG:-C.UTF-8}"             # Hebrew download names need a UTF-8 locale
FILTER="${1:-}"
mkdir -p "$OUT"

# static server for the app (stopped on exit)
python3 -m http.server "$PORT" --directory "$APP" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1

# name | arguments
CHECKS=(
  "full-flow|$OUT $CHORDFLOW_URL"
  "curve-editing|$CHORDFLOW_URL"
  "sections|$CHORDFLOW_URL $OUT/sections.png"
  "editing-tools|"
  "keyswitch-export|$OUT/export-ks.png $OUT/keyswitch.mid"
  "audio-and-sheet|$OUT $OUT/sheet.png"
  "melody|$OUT/melody.png $APP/tests/golden/quartet.mid"
  "screen-fit|$APP/index.html $OUT"
  "dynamics-loudness|"
  "dynamics-swell|$CHORDFLOW_URL"
  "metronome|$APP/index.html $OUT/metronome.png"
  "theme-toggle|$OUT $APP/index.html"
  "standalone-build|$APP/dist/ChordFlow.html $OUT/standalone.png"
)

pass=0; fail=0
for entry in "${CHECKS[@]}"; do
  name="${entry%%|*}"; args="${entry#*|}"
  [[ -n "$FILTER" && "$name" != *"$FILTER"* ]] && continue
  if [[ "$name" == "standalone-build" && ! -f "$APP/dist/ChordFlow.html" ]]; then
    echo "── $name: skipped (run tools/build-single.py first)"; continue
  fi
  echo "── $name"
  log="$OUT/$name.log"
  # shellcheck disable=SC2086
  (cd "$HERE" && timeout 300 node "$name.js" $args) >"$log" 2>&1
  code=$?
  sed 's/^/   /' "$log" | grep -v '^\s*$' | tail -25
  bad=0
  [[ $code -ne 0 ]] && bad=1
  grep -q "FAILED" "$log" && bad=1
  # every "errors ..." line must say "none"
  if grep -Eqi "^(•\s*)?errors" "$log" && grep -Ei "^(•\s*)?errors" "$log" | grep -Eqvi "errors:?\s+none"; then bad=1; fi
  if [[ $bad -eq 1 ]]; then
    echo "   ✗ FAIL ($name)"; fail=$((fail + 1))
  else
    echo "   ✓ ok"; pass=$((pass + 1))
  fi
done
echo
echo "browser checks: $pass ok, $fail failed   (details: $OUT/*.log)"
[[ $fail -eq 0 ]]
