// x1c.scad — Bambu Lab X1 Carbon build constants + shared helpers for Forge3D.
// Units are millimeters. `use <../../lib/x1c.scad>` from any model so it is
// bed-aware and consistent from the very first render.

// --- Build volume (Bambu Lab X1C) ---
X1C_BED_X = 256;   // mm — usable X
X1C_BED_Y = 256;   // mm — usable Y
X1C_BED_Z = 256;   // mm — usable Z

// --- Process defaults (0.4 mm nozzle, standard profile) ---
NOZZLE    = 0.4;   // mm — nozzle diameter
LAYER     = 0.2;   // mm — standard layer height
WALL      = 1.2;   // mm — 3 perimeters @ 0.4 nozzle: a sturdy default wall
CLEARANCE = 0.2;   // mm — slip-fit gap between mating printed parts

// Smooth curves on the final CGAL render, fast in the interactive preview.
$fn = $preview ? 48 : 96;

// rbox — a box with rounded vertical (XY) corners. The single most useful
// primitive for printable parts (no sharp edges to chip, nicer to hold).
//   size   = [x, y, z]
//   r      = corner radius (mm)
//   center = true centers on origin; false puts the near-bottom corner at [0,0,0]
module rbox(size, r = 2, center = false) {
    translate(center ? [0, 0, 0] : [size[0] / 2, size[1] / 2, size[2] / 2])
        linear_extrude(height = size[2], center = true)
            offset(r = r) offset(r = -r)
                square([size[0], size[1]], center = true);
}

// bed_report — echo the footprint and warn (in the render log) if the part
// will not fit the X1C build volume. Call once from your top-level module.
module bed_report(size) {
    echo(str("FORGE3D bbox mm: ", size[0], " x ", size[1], " x ", size[2]));
    if (size[0] > X1C_BED_X || size[1] > X1C_BED_Y || size[2] > X1C_BED_Z)
        echo(str("FORGE3D WARNING: model exceeds X1C build volume ",
                 X1C_BED_X, "x", X1C_BED_Y, "x", X1C_BED_Z, " mm"));
}
