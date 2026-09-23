"""Grab the live avionics canvases from the running game for the Cycles renders (tex/fd_screen_*.png).
  .venv/bin/python blender/aircraft/b737/capture_displays.py   (dev server on :5173; uses tools/shot.mjs)
The screen meshes carry v = 0 at the top (three.js CanvasTexture flipY), so the images are stored upside down."""
import base64, io, json, os, subprocess, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
TEX = os.path.join(HERE, 'tex')
TYPES = {'b737.pfd': 'pfd', 'b737.nd': 'nd', 'b737.eicas': 'eicas', 'b737.lower': 'lower', 'b737.cdu': 'cdu', 'a320.isis': 'isfd'}
EXPR = ("(async () => { const m = await import('/src/avionics/index.js'); const g = window.__game; const out = {}; "
        "for (const t of %s) { const d = m.createDisplay(t, {shared:false, size: 1024}); "
        "for (let i=0;i<4;i++) d.update(0.05, g.flight, g.world); out[t] = d.canvas.toDataURL('image/png'); } return out; })()"
        % json.dumps(list(TYPES)))


def main():
    out = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'b737_disp.png')
    r = subprocess.run(['node', 'tools/shot.mjs', 'index.html?aircraft=b737&spawn=AIR-SFO-FINAL', out, '--wait', '12000',
                        '--eval', EXPR], cwd=REPO, capture_output=True, text=True, timeout=180)
    line = [l for l in r.stdout.splitlines() if l.startswith('eval:')][0]
    data = json.loads(line[5:])
    for t, name in TYPES.items():
        im = Image.open(io.BytesIO(base64.b64decode(data[t].split(',')[1]))).convert('RGB')
        im.transpose(Image.FLIP_TOP_BOTTOM).save(os.path.join(TEX, f'fd_screen_{name}.png'))
        print('wrote', name, im.size)


if __name__ == '__main__':
    main()
