# CLAUDE.md

The main work in this repo is **ChordFlow** (`chordflow/`): a Hebrew RTL browser tool that turns
chord progressions into orchestral arrangements with dynamics/expression, previews them with recorded
samples, and exports multichannel MIDI for Cubase, WAV and printable chord sheets.

**Before doing anything, read `chordflow/HANDOFF.md` in full.** It has the current state, architecture,
decisions, the owner's requirements and preferences, and the ordered list of what's next.

Quick facts:
- Work branch: `claude/sharp-hopper-eix6x6`. Don't open a PR unless the owner asks.
- Reply to the owner in Hebrew. Work autonomously "one by one until done", and prove results (screenshots, measurements, tests).
- Engine tests: `node chordflow/tests/run-tests.js`. Browser tests: `bash chordflow/tests/e2e/run-all.sh`.
- Tester package: `bash chordflow/tools/package-tester.sh` builds `chordflow/dist/ChordFlow-לבדיקה.zip`.
- Plain scripts, no build step: the app must keep working when `index.html` is opened from disk (`file://`).
- Every project-format change goes through `normalize()` in `chordflow/js/project.js` with a migration and a test.
- Don't modify the root `README.md` (it belongs to the original practice project).
