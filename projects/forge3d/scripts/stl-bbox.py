#!/usr/bin/env python3
"""stl-bbox.py — report an STL's bounding box and check it fits the X1C bed.

Pure stdlib (no numpy) so it runs in any container or on <<MACHINE_1_ID>>. Handles both
binary and ASCII STL. Exit code is non-zero if the part exceeds the build
volume, so it doubles as a pre-slice gate in scripts/CI.

    python3 stl-bbox.py part.stl
"""
import struct
import sys

BED = (256.0, 256.0, 256.0)  # Bambu Lab X1C build volume, mm


def _iter_binary(data):
    (ntri,) = struct.unpack_from("<I", data, 80)
    off = 84
    for _ in range(ntri):
        # 12 floats per facet (normal + 3 verts); verts are floats 3..11
        vals = struct.unpack_from("<12f", data, off)
        for v in range(3):
            yield vals[3 + v * 3], vals[4 + v * 3], vals[5 + v * 3]
        off += 50


def _iter_ascii(text):
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("vertex"):
            _, x, y, z = line.split()
            yield float(x), float(y), float(z)


def bbox(path):
    with open(path, "rb") as fh:
        data = fh.read()
    is_ascii = data[:5].lower().startswith(b"solid") and b"facet" in data[:512].lower()
    verts = _iter_ascii(data.decode("utf-8", "replace")) if is_ascii else _iter_binary(data)

    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    n = 0
    for x, y, z in verts:
        for i, c in enumerate((x, y, z)):
            lo[i] = min(lo[i], c)
            hi[i] = max(hi[i], c)
        n += 1
    if n == 0:
        raise ValueError("no vertices found — empty or unreadable STL")
    return [hi[i] - lo[i] for i in range(3)]


def main(argv):
    if len(argv) != 2:
        print("usage: stl-bbox.py <part.stl>", file=sys.stderr)
        return 2
    dims = bbox(argv[1])
    fits = all(dims[i] <= BED[i] for i in range(3))
    print(f"bbox mm:  {dims[0]:.2f} x {dims[1]:.2f} x {dims[2]:.2f}")
    print(f"X1C bed:  {BED[0]:.0f} x {BED[1]:.0f} x {BED[2]:.0f}")
    print("fit:      " + ("OK — fits the bed" if fits else "TOO BIG — split or scale"))
    return 0 if fits else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
