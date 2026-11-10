# Sample credits

ChordFlow's in-browser preview uses recorded instrument samples. The same text is shown inside
the tool (menu "עוד" › "קרדיטים ורישיונות").

## Piano: Salamander Grand Piano V3

- Recorded by **Alexander Holm**. License: [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- Source: archive.org/details/SalamanderGrandPianoV3, via the npm package
  `@audio-samples/piano-mp3-velocity8` 1.0.5 (MIT, Copyright (c) 2019 Jan Forst). Trimmed to 9 s.
- Checked 2026-11-10: the package README states "Samples license: CC BY 3.0, Author: Alexander Holm".

## All other instruments: FluidR3 SoundFont

- FluidR3 SoundFont, Copyright (c) 2000-2002, 2008, 2013 **Frank Wen** <getfrank@gmail.com>. MIT License.
- Rendered to MP3 in the npm package `soundfont-for-samplers` 0.0.3 (MIT, K.G.Studio), inspired by
  midi-js-soundfonts, Copyright (C) 2012 Benjamin Gleitzman (MIT).
- Checked 2026-11-10 against two independent files: the package's own `LICENSE` (attribution block
  above), and Debian's `fluid-soundfont-gm` 3.1-5.3 `copyright` file, which quotes the author's
  README: "I hereby release Fluid under the MIT license, as described in COPYING."

## MIT License (applies to FluidR3 and to both npm packages)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

The packs are built with `python3 chordflow/tools/build-samples.py` (one sample every 3 semitones;
the player pitch-shifts between them). Exported MIDI files contain no audio and are not affected
by these licenses.
