#!/usr/bin/env python3
"""forge3d-selftest.py — verify the Forge3D toolchain end-to-end.

Transport-independent like the dashboard contract check: it asserts structure
always, and exercises the real render+export loop when OpenSCAD is installed.
Run before pushing changes to the workflow.

    python3 projects/forge3d/scripts/forge3d-selftest.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FORGE = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(FORGE))

LIB = os.path.join(FORGE, "lib", "x1c.scad")
EXAMPLE = os.path.join(FORGE, "models", "cable-clip", "cable-clip.scad")
RENDER = os.path.join(REPO, "scripts", "forge3d-render.sh")
BBOX = os.path.join(HERE, "stl-bbox.py")

sys.path.insert(0, HERE)
import importlib

bboxmod = importlib.import_module("stl-bbox")


def check(label, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    return ok


def main():
    print("Forge3D selftest")
    ok = True

    # 1. Library carries the X1C constants + helpers the models depend on.
    lib = open(LIB).read()
    for token in ("X1C_BED_X = 256", "CLEARANCE", "module rbox", "module bed_report"):
        ok &= check(f"lib defines {token!r}", token in lib)

    # 2. Example model exists and pulls the library in with include (not use,
    #    which would drop the constants).
    ex = open(EXAMPLE).read()
    ok &= check("example uses include <...x1c.scad>", "include <../../lib/x1c.scad>" in ex)

    # 3. Render scripts are present + executable.
    for p in (RENDER, BBOX):
        ok &= check(f"{os.path.basename(p)} is executable", os.access(p, os.X_OK))

    # 4. Live loop when OpenSCAD is available; skip cleanly otherwise.
    if shutil.which("openscad"):
        with tempfile.TemporaryDirectory() as td:
            work = os.path.join(td, "models", "cable-clip")
            os.makedirs(work)
            shutil.copy(EXAMPLE, work)
            shutil.copytree(os.path.join(FORGE, "lib"), os.path.join(td, "lib"))
            r = subprocess.run(
                ["bash", RENDER, os.path.join(work, "cable-clip.scad")],
                capture_output=True, text=True,
            )
            stl = os.path.join(work, "stl", "cable-clip.stl")
            png = os.path.join(work, "renders", "cable-clip-iso.png")
            ok &= check("render produced an STL", os.path.exists(stl))
            ok &= check("render produced PNGs", os.path.exists(png))
            if "WARNING: Ignoring unknown variable" in r.stdout + r.stderr:
                ok &= check("no undefined-variable warnings", False, "include scope broke")
            else:
                ok &= check("no undefined-variable warnings", True)
            if os.path.exists(stl):
                dims = bboxmod.bbox(stl)
                fits = all(dims[i] <= bboxmod.BED[i] for i in range(3))
                ok &= check("STL parses + fits the X1C bed", fits,
                            f"{dims[0]:.0f}x{dims[1]:.0f}x{dims[2]:.0f} mm")
    else:
        print("  [SKIP] openscad not installed — structural checks only")

    print("RESULT:", "OK" if ok else "FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
