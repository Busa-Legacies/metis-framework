// segment.scad — Forge3D bed-size segmentation engine.
// Split a too-big model into printable pieces along clean seams, then put it
// back together with the center rod + registration joints. Reusable across
// models (#222). `include <../../lib/segment.scad>` (it pulls in x1c.scad).
include <x1c.scad>

// --- angular sector solid, for radial (pie / ridge) splits ---
// A wedge from a0 to a1 degrees, tall/wide enough to clip any model.
module wedge(a0, a1, r = 2000, h = 4000) {
    steps = max(1, ceil((a1 - a0) / 10));
    pts = concat([[0, 0]],
                 [for (i = [0 : steps]) let (a = a0 + (a1 - a0) * i / steps)
                     [r * cos(a), r * sin(a)]]);
    translate([0, 0, -h / 2]) linear_extrude(h) polygon(pts);
}

// Keep only piece `i` of `n` equal radial wedges, offset so seams land where
// you want (start = the angle of the first cut). For a hex roof, n=3 start=0
// cuts on vertices 0/120/240 — every seam falls in a ridge valley.
module radial_piece(i, n, start = 0) {
    a0 = start + i * 360 / n;
    a1 = start + (i + 1) * 360 / n;
    intersection() {
        children();
        wedge(a0, a1);
    }
}

// --- center rod bore (the shared through-hole all pieces share) ---
module rod_bore(rod_d, z0 = -1, z1 = 4000) {
    translate([0, 0, z0]) cylinder(d = rod_d + 2 * CLEARANCE, h = z1 - z0, $fn = 48);
}

// --- seam registration peg (add) / socket (subtract) ---
// Point joints. Prefer the sliding dovetail below for clean, continuous seams;
// pegs remain for spot registration where a full dovetail won't fit.
module seam_peg(phi, r_at, z_at, dia = 4, len = 4, embed = 4) {
    rotate([0, 0, phi]) translate([r_at, 0, z_at]) rotate([-90, 0, 0])
        translate([0, 0, -embed]) cylinder(d = dia + 0, h = embed + len, $fn = 24);
}
module seam_socket(phi, r_at, z_at, dia = 4, len = 4) {
    rotate([0, 0, phi]) translate([r_at, 0, z_at]) rotate([-90, 0, 0])
        translate([0, 0, -0.2]) cylinder(d = dia + 2 * CLEARANCE, h = len + CLEARANCE + 0.2, $fn = 24);
}

// --- sliding dovetail (continuous radial-seam joint, vertical slide) ---
// The preferred seam joint: a dovetail tongue runs the height of the seam at
// radius `r`, protruding toward +normal (CCW). Its undercut locks the pieces in
// every direction except the vertical slide — so neighbours bind along the whole
// joint with no rod. Put a tongue on the CCW face and a (clearanced) groove on
// the neighbour's CW face.
//   neck  = tongue width at the seam,  flare = extra half-width at the tip,
//   depth = how far it reaches into the neighbour,  emb = root anchored in body.
module _dovetail2d(r, neck, flare, depth, emb)
    polygon([[r - neck / 2, -emb], [r + neck / 2, -emb], [r + neck / 2, 0],
             [r + neck / 2 + flare, depth], [r - neck / 2 - flare, depth], [r - neck / 2, 0]]);

module seam_dovetail_tongue(phi, r, z0, z1, neck = 10, flare = 4, depth = 7, emb = 6)
    rotate([0, 0, phi]) translate([0, 0, z0])
        linear_extrude(z1 - z0) _dovetail2d(r, neck, flare, depth, emb);

module seam_dovetail_groove(phi, r, z0, z1, neck = 10, flare = 4, depth = 7, emb = 6)
    rotate([0, 0, phi]) translate([0, 0, z0 - 0.1])
        linear_extrude(z1 - z0 + 0.2) offset(r = CLEARANCE) _dovetail2d(r, neck, flare, depth, emb);

// --- stacked-interface joint (full-contact spigot, flush outer wall) ---
// For the vertical stack (base/post/firebox/roof/finial): a centered male plug
// on top of the lower part seats into a socket in the bottom of the upper part.
// The upper part's full-width wall sleeves the step, so the outside stays flush;
// the plug registers the parts and carries shear, gravity does the rest.
module stack_spigot(d, h, fn = 6) cylinder(d = d, h = h, $fn = fn);
module stack_socket(d, h, fn = 6)
    translate([0, 0, -0.1]) cylinder(d = d + 2 * CLEARANCE, h = h + CLEARANCE + 0.1, $fn = fn);

