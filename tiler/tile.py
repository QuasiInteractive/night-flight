"""Turns LAS/LAZ point clouds into an octree a browser can stream.

    uv run tile.py OUT_DIR file1.laz [file2.laz ...] [--max-points N] [--feet]

Every octree node holds an evenly spread sample of its region (one point per grid cell),
so the root alone is a coarse picture of the whole scan and each level down adds detail
where the camera is looking. Points are written once, in the shallowest node that samples
them, so nothing is duplicated.

Output:
    OUT_DIR/cloud.json          bounds, attributes, and the node list
    OUT_DIR/n/<level>-<x>-<y>-<z>.bin
        per point: 3 x uint16 position within the node's cube, then uint8 classification,
        uint16 intensity, and 3 x uint8 colour when the source has RGB
"""
import argparse
import json
import time
from pathlib import Path

import laspy
import numpy as np

GRID = 128          # sample cells per node edge: up to GRID^3 points, in practice ~10-40k
LEAF_MAX = 20_000   # a node with this many points or fewer keeps them all and stops splitting
FEET = 0.3048


def read(files, max_points, feet, seed=7):
    xyz, cls, inten, rgb = [], [], [], []
    has_rgb = True
    for f in files:
        las = laspy.read(f)
        has_rgb &= {"red", "green", "blue"} <= set(las.point_format.dimension_names)
        xyz.append(np.column_stack([las.x, las.y, las.z]).astype(np.float64))
        cls.append(np.asarray(las.classification, dtype=np.uint8))
        inten.append(np.asarray(las.intensity, dtype=np.uint16))
        if has_rgb:
            c = np.column_stack([las.red, las.green, las.blue])
            # LAS colour is 16-bit, but plenty of producers write 8-bit values into it
            rgb.append((c >> 8 if c.max() > 255 else c).astype(np.uint8))
        print(f"  read {Path(f).name}: {len(las.points):,} points")
    xyz = np.concatenate(xyz)
    if feet:
        xyz *= FEET
    out = {"xyz": xyz, "cls": np.concatenate(cls), "intensity": np.concatenate(inten)}
    if has_rgb:
        out["rgb"] = np.concatenate(rgb)
    n = len(xyz)
    if max_points and n > max_points:
        keep = np.random.default_rng(seed).choice(n, max_points, replace=False)
        out = {k: v[keep] for k, v in out.items()}
        print(f"  kept a random {max_points:,} of {n:,} points")
    return out


def build(pts, seed=7):
    """Assigns every point a (level, node) so each node holds an even sample of its cube."""
    xyz = pts["xyz"]
    lo = xyz.min(axis=0)
    size = float((xyz.max(axis=0) - lo).max()) * 1.0001 or 1.0
    unit = (xyz - lo) / size                      # 0..1 inside the root cube
    n = len(xyz)
    order = np.random.default_rng(seed).permutation(n)  # random priority: first in a cell wins
    level = np.full(n, -1, dtype=np.int16)
    remaining = order
    L = 0
    while len(remaining):
        res = (1 << L) * GRID
        if res > 1 << 21:
            raise SystemExit("octree too deep: are there duplicate points stacked on one spot?")
        u = unit[remaining]
        node = np.minimum((u * (1 << L)).astype(np.int64), (1 << L) - 1)
        node_key = (node[:, 0] << 42) | (node[:, 1] << 21) | node[:, 2]
        # small nodes keep everything they have left and become leaves
        _, inv, counts = np.unique(node_key, return_inverse=True, return_counts=True)
        leaf = counts[inv] <= LEAF_MAX
        # otherwise one point per sample cell stays at this level
        cell = np.minimum((u * res).astype(np.int64), res - 1)
        cell_key = (cell[:, 0] << 42) | (cell[:, 1] << 21) | cell[:, 2]
        _, first = np.unique(cell_key, return_index=True)
        sampled = np.zeros(len(remaining), dtype=bool)
        sampled[first] = True
        take = leaf | sampled
        level[remaining[take]] = L
        remaining = remaining[~take]
        print(f"  level {L}: {take.sum():,} points ({len(remaining):,} left)")
        L += 1
    return lo, size, level, unit


def write(out, pts, lo, size, level, unit, crs_note):
    out = Path(out)
    (out / "n").mkdir(parents=True, exist_ok=True)
    has_rgb = "rgb" in pts
    nodes = []
    for L in range(int(level.max()) + 1):
        idx = np.nonzero(level == L)[0]
        cells = 1 << L
        node = np.minimum((unit[idx] * cells).astype(np.int64), cells - 1)
        key = (node[:, 0] << 42) | (node[:, 1] << 21) | node[:, 2]
        o = np.argsort(key, kind="stable")
        idx, node, key = idx[o], node[o], key[o]
        starts = np.flatnonzero(np.r_[True, key[1:] != key[:-1]])
        ends = np.r_[starts[1:], len(idx)]
        for s, e in zip(starts, ends):
            x, y, z = (int(v) for v in node[s])
            i = idx[s:e]
            # position inside this node's cube, quantised to 16 bits per axis
            local = unit[i] * cells - np.array([x, y, z])
            q = np.clip(np.round(local * 65535), 0, 65535).astype("<u2")
            cols = [q.view(np.uint8).reshape(-1, 6), pts["cls"][i].reshape(-1, 1),
                    pts["intensity"][i].astype("<u2").view(np.uint8).reshape(-1, 2)]
            if has_rgb:
                cols.append(pts["rgb"][i])
            rec = np.ascontiguousarray(np.concatenate(cols, axis=1))
            (out / "n" / f"{L}-{x}-{y}-{z}.bin").write_bytes(rec.tobytes())
            nodes.append([L, x, y, z, int(e - s)])
    z = pts["xyz"][:, 2]
    meta = {
        "version": 1,
        "points": int(len(level)),
        "origin": lo.tolist(),          # metres, in the source projection
        "size": size,                   # root cube edge, metres
        "zRange": [float(np.percentile(z, 1)), float(np.percentile(z, 99))],
        "intensityRange": [0, float(np.percentile(pts["intensity"], 99))],
        "attributes": ["position:u16x3", "classification:u8", "intensity:u16"] + (["rgb:u8x3"] if has_rgb else []),
        "stride": 9 + (3 if has_rgb else 0),
        "classes": sorted(int(c) for c in np.unique(pts["cls"])),
        "crs": crs_note,
        "nodes": nodes,                 # [level, x, y, z, count]
    }
    (out / "cloud.json").write_text(json.dumps(meta, separators=(",", ":")))
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--max-points", type=int, default=0, help="randomly keep at most this many points")
    ap.add_argument("--feet", action="store_true", help="source coordinates are in feet")
    ap.add_argument("--crs", default="", help="a note on the coordinate system, shown in the viewer")
    ap.add_argument("--utm", default="", help='UTM/MGA zone like "56S", so the viewer can show latitude and longitude')
    ap.add_argument("--title", default="", help="name shown in the viewer")
    ap.add_argument("--place", default="", help="subtitle, e.g. suburb")
    ap.add_argument("--credit", default="", help="data credit shown on screen")
    a = ap.parse_args()
    t0 = time.time()
    print("reading")
    pts = read(a.files, a.max_points, a.feet)
    print(f"building octree for {len(pts['xyz']):,} points")
    lo, size, level, unit = build(pts)
    print("writing")
    meta = write(a.out, pts, lo, size, level, unit, a.crs)
    extra = {"title": a.title, "place": a.place, "credit": a.credit}
    if a.utm:
        extra["utm"] = {"zone": int(a.utm[:-1]), "south": a.utm[-1].upper() == "S"}
    meta.update({k: v for k, v in extra.items() if v})
    (Path(a.out) / "cloud.json").write_text(json.dumps(meta, separators=(",", ":")))
    mb = sum(p.stat().st_size for p in Path(a.out, "n").iterdir()) / 1e6
    print(f"done: {meta['points']:,} points in {len(meta['nodes'])} nodes, {mb:.0f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
