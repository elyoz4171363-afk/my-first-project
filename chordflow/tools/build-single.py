#!/usr/bin/env python3
"""
Builds a single, self-contained ChordFlow HTML file (CSS and JS inlined),
for sending to testers or opening with a double-click.

    python3 chordflow/tools/build-single.py [output.html]

Default output: chordflow/dist/ChordFlow.html
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def build():
    html = read('index.html')

    def inline_css(m):
        return '<style>\n' + read(m.group(1)) + '\n</style>'

    def inline_js(m):
        code = read(m.group(1))
        if '</script' in code.lower():
            raise SystemExit(f'{m.group(1)} contains "</script" and cannot be inlined')
        return f'<script>/* {m.group(1)} */\n' + code + '\n</script>'

    html, n_css = re.subn(r'<link rel="stylesheet" href="(css/[^"]+)">', inline_css, html)
    html, n_js = re.subn(r'<script src="(js/[^"]+)"></script>', inline_js, html)
    if n_css != 1 or n_js < 10:
        raise SystemExit(f'unexpected structure: {n_css} stylesheets, {n_js} scripts')
    return html


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'ChordFlow.html')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(build())
    print(f'{out}  ({os.path.getsize(out) // 1024} KB)')
    # recorded instruments are loaded from samples/ next to the HTML file
    import shutil
    dst = os.path.join(os.path.dirname(out), 'samples')
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, 'samples'), dst)
    print(f'{dst}/  ({len(os.listdir(dst))} files)')
