# Sample credits

ChordFlow's in-browser preview uses recorded instrument samples:

- **Piano: Salamander Grand Piano V3** by Alexander Holm. License: [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
  Source: archive.org/details/SalamanderGrandPianoV3, via the npm package `@audio-samples/piano-mp3-velocity8` (MIT). Trimmed to 9 s.
- **All other instruments: FluidR3_GM** SoundFont by Frank Wen, rendered to MP3 in the npm package `soundfont-for-samplers` (MIT).

The packs are built with `python3 chordflow/tools/build-samples.py` (one sample every 3 semitones; the player pitch-shifts between them).
The exported MIDI files contain no audio and are not affected by these licenses.
