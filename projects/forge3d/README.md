# Forge3D: code-first 3D design for the Bambu X1C

For someone who prints well but doesn't model well. The agent triages each part
to the cheapest path to the right result:

- **Just build it**: trivially simple parts (spacer, bracket, peg, hook). Faster
  to model than to search, and exactly to spec.
- **Source it**: common objects others have already made well: check
  **MakerWorld** (Bambu's library; profiles open straight in Bambu Studio), then
  **Printables** / **Thingiverse**. The agent searches and recommends.
- **Custom design**: detailed, particular, or parametric parts. You describe it
  in plain English; an agent writes it as **parametric OpenSCAD** (text-based
  CAD), renders it to images so we can *look at it together*, and exports a
  print-ready STL. No mouse-driven modeling required.

```
describe  →  agent writes/edits .scad  →  render PNGs  →  review & refine  →  export STL  →  slice in Bambu Studio  →  print
                         ↑___________________________________|
```

## Why this approach
- **Text is editable by an agent.** "make it 20% taller, add a 4th slot, round
  the corners" → a one-line parameter change, not a remodel.
- **It's reviewable.** Every change renders to PNGs (4 angles) so we both see the
  result before any filament is spent.
- **It's bed-aware.** Every model `include`s `lib/x1c.scad` (256×256×256 build
  volume, 0.4 nozzle, fit clearances) and every export is checked against the bed.
- **Parameters, not files.** One `.scad` makes a whole family of parts by
  changing numbers.

## Layout
```
projects/forge3d/
├── lib/x1c.scad              # X1C build constants + helpers (rbox, bed_report)
├── models/<name>/<name>.scad # one parametric model per folder
│   └── renders/              # committed PNGs — the visual history of the design
├── scripts/
│   ├── stl-bbox.py           # STL bounding-box + bed-fit check (pure stdlib)
│   └── forge3d-selftest.py   # verify the toolchain + example end-to-end
├── viewer.html               # browser STL viewer with orbit/zoom + bed-fit stats
└── README.md
```
STLs land in `models/<name>/stl/` and are **git-ignored**; they regenerate from
source. PNG renders are committed.

## Quickstart
```bash
# Render an existing model (4 angles + STL + bed-fit check)
scripts/forge3d-render.sh projects/forge3d/models/cable-clip/cable-clip.scad

# Override parameters without editing the file — try 6 cables, 8mm each
scripts/forge3d-render.sh projects/forge3d/models/cable-clip/cable-clip.scad \
    -D slots=6 -D cable_dia=8

# Just preview, skip the STL export
scripts/forge3d-render.sh .../model.scad --no-stl

# Add a turntable fallback for chat/mobile review.
# Writes renders/<name>-turntable/frame-000.png... plus a GIF when ffmpeg or
# ImageMagick is installed.
scripts/forge3d-render.sh projects/forge3d/models/cable-clip/cable-clip.scad --turntable

# Split a too-big model: assembled preview + one STL per piece + a fit report.
# The model must expose a `piece` var (-1 = assembled, 0..N-1 = a printable piece,
# the lib/segment.scad convention). Exits non-zero if any piece exceeds the bed.
scripts/forge3d-render.sh projects/forge3d/models/garden-lantern/roof-pieces.scad --pieces 3
#   --piece-var NAME   if the model names its split variable something other than `piece`
```
Renders go to `models/<name>/renders/`; the STL to `models/<name>/stl/`. In split
mode each piece is `stl/<name>-piece<i>.stl` with a `<name>-fit-report.txt` listing
every piece's bbox against the 256³ bed.

## Interactive STL viewer

After rendering an STL, serve the Forge3D folder and open `viewer.html` with a
repo-relative model path:

```bash
python3 -m http.server 8765 --directory projects/forge3d
open 'http://127.0.0.1:8765/viewer.html?model=models/cable-clip/stl/cable-clip.stl'
```

The viewer supports orbit, zoom, pan, drag-and-drop, and local file selection.
Opening `viewer.html` directly from Finder still works for local file selection,
but browser security blocks `?model=...` fetches from `file://` URLs.

## The print handoff (Bambu Studio)
1. Open the exported STL in **Bambu Studio**, select the **X1C** profile.
2. Orient so flat faces sit on the bed; minimize overhangs/supports.
3. Slice, sanity-check the preview, send to the printer.

The model is designed in millimeters at 1:1; no scaling needed on import.

## Tooling
- **OpenSCAD**: `brew install openscad` (mac/<<MACHINE_1_ID>>) or `apt install openscad`.
- `xvfb-run` is used automatically for headless rendering when there's no display
  (cloud sessions); on a desktop it renders directly.
- Optional: **ImageMagick** (`montage`) produces a 2×2 contact sheet per render.
- Optional: **ffmpeg** or **ImageMagick** encodes `--turntable` frames into GIFs.

## Verify
```bash
python3 projects/forge3d/scripts/forge3d-selftest.py
```
Checks the library constants, renders the example if OpenSCAD is present, and
asserts the STL parses and fits the bed.

Full process + how to drive the loop with an agent: `docs/process/3d-design-workflow.md`.
