/*
 * ChordFlow — printable chord sheet (lead-sheet style chart).
 * Pure function: project -> standalone HTML page (print it or save it as PDF).
 * Bars run left to right like real charts; titles are Hebrew.
 */
(function (root) {
  'use strict';
  const CF = (root.CF = root.CF || {});
  const EPS = 1e-6;

  /** Written pitch for transposing instruments: concert + semitones. */
  const TRANSPOSITIONS = [
    { id: 'concert', name: 'צליל קונצרטי (פסנתר, גיטרה, כלי קשת, חליל)', semis: 0, tag: '' },
    { id: 'bb', name: 'כלים ב-Bb (חצוצרה, קלרינט, סקסופון טנור)', semis: 2, tag: 'Bb' },
    { id: 'eb', name: 'כלים ב-Eb (סקסופון אלט, בריטון)', semis: 9, tag: 'Eb' },
    { id: 'f', name: 'כלים ב-F (קרן יער)', semis: 7, tag: 'F' },
  ];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * @param project ChordFlow project
   * @param opts { transposition: id, numerals: bool, barsPerLine: number, notes: string }
   */
  function build(project, opts) {
    opts = opts || {};
    const T = CF.Theory;
    const tr = TRANSPOSITIONS.find((x) => x.id === opts.transposition) || TRANSPOSITIONS[0];
    const ts = project.timeSig;
    const barLen = T.barLength(ts);
    const tonic = T.parseNote(project.key.tonic);
    const writtenKey = {
      tonic: T.KEY_TONICS[project.key.mode].find((n) => T.parseNote(n).pc === (tonic.pc + tr.semis) % 12) || project.key.tonic,
      mode: project.key.mode,
    };
    const chords = project.chords.slice().sort((a, b) => a.start - b.start);
    let end = 0;
    chords.forEach((c) => { end = Math.max(end, c.start + c.length); });
    const nBars = Math.max(1, Math.ceil(end / barLen - EPS));
    const perLine = opts.barsPerLine || 4;

    // bar contents: chord symbols that start in the bar ("%" for a repeated bar, "—" for held)
    const bars = [];
    for (let b = 0; b < nBars; b++) {
      const bs = b * barLen, be = bs + barLen;
      const starts = chords.filter((c) => c.start >= bs - EPS && c.start < be - EPS).map((c) => {
        const sym = tr.semis ? T.transposeSymbol(c.symbol, tr.semis, writtenKey) : c.symbol;
        const parsed = T.parseChord(sym);
        return { sym, rn: opts.numerals && parsed.ok ? T.romanNumeral(parsed, writtenKey) : '' };
      });
      const held = !starts.length && chords.some((c) => c.start < bs - EPS && c.start + c.length > bs + EPS);
      bars.push({ starts, held });
    }
    bars.forEach((bar, i) => {
      const prev = bars[i - 1];
      bar.repeat = i > 0 && bar.starts.length && prev && prev.starts.length &&
        bar.starts.map((x) => x.sym).join() === prev.starts.map((x) => x.sym).join() && !prev.repeat;
    });

    // group bars into sections
    const sections = (project.sections || []).slice().sort((a, b) => a.start - b.start);
    const groups = [];
    if (!sections.length || sections[0].start > EPS) groups.push({ name: '', from: 0 });
    sections.forEach((s) => groups.push({ name: s.name, from: Math.round(s.start / barLen) }));
    groups.forEach((g, i) => { g.to = i + 1 < groups.length ? groups[i + 1].from : nBars; });

    const cell = (bar, idx) => {
      let inner;
      if (bar.repeat) inner = '<span class="rpt">%</span>';
      else if (bar.held || !bar.starts.length) inner = bar.held ? '<span class="held">—</span>' : '';
      else inner = bar.starts.map((x) => `<span class="ch">${esc(x.sym)}${x.rn ? `<small>${esc(x.rn)}</small>` : ''}</span>`).join('');
      return `<div class="bar"><i class="num">${idx + 1}</i>${inner}</div>`;
    };
    const body = groups.filter((g) => g.to > g.from).map((g) => {
      const lines = [];
      for (let i = g.from; i < g.to; i += perLine) {
        const row = [];
        for (let j = i; j < Math.min(g.to, i + perLine); j++) row.push(cell(bars[j], j));
        while (row.length < perLine) row.push('<div class="bar empty"></div>');
        lines.push(`<div class="line">${row.join('')}</div>`);
      }
      return `<section>${g.name ? `<h2>${esc(g.name)}</h2>` : ''}${lines.join('')}</section>`;
    }).join('');

    const keyLabel = T.keyLabel(writtenKey);
    const meta = [`סולם: ${keyLabel}`, `משקל: ${ts.num}/${ts.den}`, `טמפו: ${project.bpm}`, tr.semis ? `כתוב עבור כלי ב-${tr.tag}` : ''].filter(Boolean).join(' · ');
    return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(project.name)} — דף אקורדים</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Heebo', Arial, sans-serif; color: #1b1b18; margin: 0; padding: 24px; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1b1b18; padding-bottom: 8px; margin-bottom: 18px; }
  h1 { font-family: 'Frank Ruhl Libre', Georgia, serif; font-size: 28px; margin: 0; }
  .meta { font-size: 13px; color: #444; }
  .brand { font-size: 11px; color: #8a6414; letter-spacing: 1px; }
  section { margin-bottom: 14px; break-inside: avoid; }
  h2 { font-size: 14px; margin: 0 0 6px; padding: 2px 10px; display: inline-block; border: 1.5px solid #1b1b18; border-radius: 4px; }
  .line { display: grid; grid-template-columns: repeat(${perLine}, 1fr); direction: ltr; border-left: 2px solid #1b1b18; }
  .bar { position: relative; min-height: 54px; border-right: 2px solid #1b1b18; border-bottom: 1px solid #ccc; display: flex; align-items: center; justify-content: space-around; padding: 10px 6px 6px; }
  .bar.empty { border-bottom: 0; }
  .num { position: absolute; top: 2px; left: 4px; font-size: 9px; color: #999; font-style: normal; }
  .ch { font-size: 21px; font-weight: 700; display: flex; flex-direction: column; align-items: center; line-height: 1.1; }
  .ch small { font-size: 11px; font-weight: 500; color: #8a6414; font-family: Georgia, serif; }
  .rpt, .held { font-size: 22px; color: #555; }
  .notes { margin-top: 14px; font-size: 13px; white-space: pre-wrap; }
  .toolbar { margin-bottom: 14px; }
  .toolbar button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #1b1b18; background: #f3ead6; cursor: pointer; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="toolbar"><button onclick="window.print()">הדפסה / שמירה כ-PDF</button></div>
<header><div><h1>${esc(project.name)}</h1><div class="meta">${esc(meta)}</div></div><div class="brand">ChordFlow · בית ליוצרים</div></header>
${body}
${opts.notes ? `<div class="notes">${esc(opts.notes)}</div>` : ''}
</body></html>`;
  }

  CF.Sheet = { build, TRANSPOSITIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = CF.Sheet;
})(typeof globalThis !== 'undefined' ? globalThis : this);
