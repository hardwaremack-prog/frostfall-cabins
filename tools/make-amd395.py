#!/usr/bin/env python3
"""Build the AMD Ryzen AI Max+ 395 edition of Frostfall Cabins into dist/frostfall-cabins-AMD395.

Same game and same server (everyone can still play together), but the page is marked as the
AMD 395 edition so it starts in Ultra graphics: soft shadows, bloom glow, a forest about twice
as dense, young firs over the ground, heavier snowfall and sharper rendering.
"""
import pathlib, shutil, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "frostfall-cabins-AMD395"
if OUT.exists():
    shutil.rmtree(OUT)
files = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).split()
for f in files:
    if f.startswith(("tools/", ".git")):
        continue
    dst = OUT / f
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / f, dst)

def edit(rel, pairs):
    p = OUT / rel
    s = p.read_text(encoding="utf-8")
    for a, b in pairs:
        assert a in s, (rel, a)
        s = s.replace(a, b, 1)
    p.write_text(s, encoding="utf-8")

edit("public/index.html", [
    ("<title>Frostfall Cabins</title>", '<title>Frostfall Cabins · AMD 395 Edition</title>\n<meta name="ffc-edition" content="amd395">'),
    ("<h1>Frostfall <span>Cabins</span></h1>", '<h1>Frostfall <span>Cabins</span></h1>\n    <div class="sub" style="color:#ffd27a;font-weight:600;letter-spacing:.04em">AMD Ryzen AI Max+ 395 Edition · Ultra graphics</div>'),
])
edit("index.html", [("<title>Frostfall Cabins</title>", "<title>Frostfall Cabins · AMD 395 Edition</title>")])
edit("launch.html", [("<title>Frostfall Cabins</title>", "<title>Frostfall Cabins · AMD 395 Edition</title>")])
edit("start-windows.bat", [("title Frostfall Cabins server", "title Frostfall Cabins AMD 395 Edition server")])
edit("README.md", [("# Frostfall Cabins\n", """# Frostfall Cabins · AMD 395 Edition

This copy is tuned for the **AMD Ryzen AI Max+ 395** (Radeon 8060S graphics). It opens in **Ultra**
graphics: soft real-time shadows from the sun and moon, bloom glow on fires, candles, the bonfire
and the bomb, a forest about twice as dense, young snowy firs across the ground, heavier snowfall,
a sharper TV picture in the bunker and higher-resolution rendering. It is the same game and server
as the regular version, so Raspberry Pis and other PCs can join the same valley (they just pick
their own graphics setting on the join screen). Use Chrome or Edge for the best GPU performance.

""")])
print("built", OUT)
