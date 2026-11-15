"""
Preprocess MODIS MCD64A1 Burned Area (Burn Date layer, from AppEEARS) into monthly
burned-area OUTLINES (GeoJSON polygons) for the web map.

Point it at a folder: it finds every file named like
    MCD64A1.061_Burn_Date_20260701T000000_aid0001.tif
(searching subfolders too; Burn_Date_Uncertainty / QA files are ignored), skips months that
were already processed, and adds new ones to burn_manifest.json.

Burn Date values: 1-366 = day of year burned | 0 = unburned | -1 = unmapped | -2 = water

For each monthly file:
  1. Reads the raster in strips and keeps only burned pixels (memory-friendly; the full 500 m
     North America raster would be ~2 GB)
  2. Groups touching burned pixels into fires (8-connected)
  3. Turns each fire into a polygon, simplifies the 500 m "staircase" edges, drops tiny holes
  4. Reprojects to lon/lat (EPSG:4326) and writes burn_YYYY_MM.geojson
     properties per fire: id, area_km2 (exact, from pixel count), start, end (first/last burn day)

Usage:
  pip install rasterio numpy scipy shapely
  python prep_burn.py data/ --out burn_out --region north_america
  python prep_burn.py data/ --out burn_out --region bc --simplify 300 --min-area 1
"""

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.warp import transform_geom
from rasterio.windows import Window
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from shapely.geometry import mapping, shape
from shapely.geometry.polygon import Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

from prep_common import add_common_args, find_files, load_manifest, resolve_bbox, write_manifest

STRIP_ROWS = 2048


def burned_pixels(src):
    """Return (rows, cols, doy) of all burned pixels, reading the file in horizontal strips."""
    rows, cols, doys = [], [], []
    for r0 in range(0, src.height, STRIP_ROWS):
        h = min(STRIP_ROWS, src.height - r0)
        a = src.read(1, window=Window(0, r0, src.width, h))
        r, c = np.nonzero((a >= 1) & (a <= 366))
        if r.size:
            rows.append(r + r0)
            cols.append(c)
            doys.append(a[r, c])
    if not rows:
        return np.array([], np.int64), np.array([], np.int64), np.array([], np.int16)
    return np.concatenate(rows).astype(np.int64), np.concatenate(cols).astype(np.int64), np.concatenate(doys)


def group_fires(rows, cols, width):
    """Label 8-connected groups of burned pixels without building a full-size raster."""
    n = rows.size
    key = rows * width + cols
    order = np.argsort(key)
    key_sorted = key[order]
    edges_a, edges_b = [], []
    for dr, dc in ((0, 1), (1, -1), (1, 0), (1, 1)):          # each neighbour pair once
        nk = (rows + dr) * width + (cols + dc)
        pos = np.searchsorted(key_sorted, nk)
        pos = np.clip(pos, 0, n - 1)
        hit = (key_sorted[pos] == nk) & (cols + dc >= 0) & (cols + dc < width)
        edges_a.append(np.nonzero(hit)[0])
        edges_b.append(order[pos[hit]])
    a = np.concatenate(edges_a)
    b = np.concatenate(edges_b)
    graph = coo_matrix((np.ones(a.size, np.int8), (a, b)), shape=(n, n))
    _, labels = connected_components(graph, directed=False)
    return labels


def polygonal(geom):
    """Repair a geometry (e.g. rings touching at a corner) and keep only its polygon parts."""
    geom = make_valid(geom)
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return unary_union(parts) if parts else Polygon()


def drop_small_holes(geom, min_hole_m2):
    def clean(p):
        return Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area >= min_hole_m2])
    if geom.geom_type == "Polygon":
        return clean(geom)
    return unary_union([clean(p) for p in geom.geoms])


def fire_polygon(rows, cols, transform):
    """Polygon (in the source projection) covering one fire's pixels."""
    r0, c0 = rows.min(), cols.min()
    mask = np.zeros((rows.max() - r0 + 1, cols.max() - c0 + 1), np.uint8)
    mask[rows - r0, cols - c0] = 1
    t = transform * rasterio.Affine.translation(c0, r0)
    polys = [shape(g) for g, v in shapes(mask, mask=mask.astype(bool), transform=t, connectivity=8) if v == 1]
    return unary_union(polys)


def process(src_path, month_start, out_path, bbox, simplify_m, min_area_km2, min_hole_km2):
    w, s, e, n = bbox
    features = []
    with rasterio.open(src_path) as src:
        px_km2 = abs(src.transform.a * src.transform.e) / 1e6     # ~0.2147 km2 for MCD64A1
        rows, cols, doys = burned_pixels(src)
        if rows.size:
            labels = group_fires(rows, cols, src.width)
            order = np.argsort(labels, kind="stable")
            bounds = np.flatnonzero(np.diff(labels[order])) + 1
            for idx in np.split(order, bounds):
                area = idx.size * px_km2
                if area < min_area_km2:
                    continue
                geom = polygonal(fire_polygon(rows[idx], cols[idx], src.transform))
                geom = polygonal(geom.simplify(simplify_m, preserve_topology=True))
                geom = drop_small_holes(geom, min_hole_km2 * 1e6)
                if geom.is_empty:
                    continue
                # reproject + round coordinates, then repair again (rounding can create touches)
                ll = polygonal(shape(transform_geom(src.crs, "EPSG:4326", mapping(geom), precision=5)))
                if ll.is_empty:
                    continue
                gj = mapping(ll)
                lon, lat = ll.centroid.coords[0]
                if not (w <= lon <= e and s <= lat <= n):
                    continue
                d = doys[idx]
                year_start = dt.date(month_start.year, 1, 1)
                features.append({
                    "type": "Feature",
                    "geometry": gj,
                    "properties": {
                        "area_km2": round(float(area), 2),
                        "start": (year_start + dt.timedelta(days=int(d.min()) - 1)).isoformat(),
                        "end": (year_start + dt.timedelta(days=int(d.max()) - 1)).isoformat(),
                    },
                })

    features.sort(key=lambda f: -f["properties"]["area_km2"])
    for i, f in enumerate(features):
        f["properties"] = {"id": i, **f["properties"]}
    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))

    total = sum(f["properties"]["area_km2"] for f in features)
    size_mb = out_path.stat().st_size / 1e6
    print(f"  {src_path.name}\n    -> {out_path.name}  {len(features):,} fires  {total:,.0f} km2  {size_mb:.1f} MB")
    return {"month": f"{month_start:%Y-%m}", "file": out_path.name, "source": src_path.name,
            "fires": len(features), "burned_km2": round(total, 1), "size_mb": round(size_mb, 2)}


def run(inputs, out="burn_out", region="north_america", bbox=None, simplify=250.0,
        min_area=0.0, min_hole=1.0, overwrite=False):
    bbox = resolve_bbox(region, bbox)
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "burn_manifest.json"

    settings = {"bounds_lonlat": list(bbox), "simplify_m": simplify, "min_area_km2": min_area,
                "min_hole_km2": min_hole}
    entries = {} if overwrite else load_manifest(manifest_path, settings)

    files = find_files(inputs, "burn")
    print(f"Burned area: found {len(files)} matching file(s); region {bbox}, simplify {simplify} m")
    done = skipped = 0
    for path, month_start in files:
        out_path = out_dir / f"burn_{month_start:%Y_%m}.geojson"
        if out_path.exists() and out_path.name in entries and not overwrite:
            skipped += 1
            continue
        entries[out_path.name] = process(path, month_start, out_path, bbox, simplify, min_area, min_hole)
        done += 1
    print(f"Burned area: processed {done}, skipped {skipped} already done")

    header = {
        "variable": "burned_area",
        "source": "MODIS MCD64A1 v061 Burn Date, 500 m monthly",
        "crs": "EPSG:4326",
        **settings,
    }
    write_manifest(manifest_path, header, entries, sort_key="month")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap, default_out="burn_out")
    ap.add_argument("--simplify", type=float, default=250.0,
                    help="outline simplification tolerance in metres (default 250 = half a pixel)")
    ap.add_argument("--min-area", type=float, default=0.0,
                    help="drop fires smaller than this many km2 (default 0 = keep all; 1 pixel = 0.21 km2)")
    ap.add_argument("--min-hole", type=float, default=1.0,
                    help="fill unburned holes smaller than this many km2 inside a fire (default 1)")
    a = ap.parse_args()
    run(a.inputs, a.out, a.region, a.bbox, a.simplify, a.min_area, a.min_hole, a.overwrite)


if __name__ == "__main__":
    main()