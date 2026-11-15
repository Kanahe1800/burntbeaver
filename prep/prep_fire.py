"""
Preprocess MODIS MOD14A2 FireMask GeoTIFFs (8-day fire composites, from AppEEARS)
into small GeoJSON files of fire pixels for the web map and the stats.

Point it at a folder: it finds every file named like
    MOD14A2.061_FireMask_20260829T000000_aid0001.tif
(searching subfolders too), skips dates that were already processed, and adds new ones
to fire_manifest.json. Other files in the folder are ignored.

Why vector instead of a raster: fire pixels are rare (~0.005% of pixels), so a GeoJSON of
just the fire pixels is a few MB, draws instantly in deck.gl, and is easy to use for
"is this beaver point near/inside a fire?" analysis.

MOD14A2 FireMask classes:
  0-2 not processed | 3 water | 4 cloud | 5 land, no fire | 6 unknown
  7 fire, low confidence | 8 fire, nominal confidence | 9 fire, high confidence

Output per file: fire_YYYY_MM_DD.geojson - one ~1 km polygon per fire pixel (lon/lat)
                 properties: start, end (8-day window), conf (7/8/9)

Usage:
  pip install rasterio numpy
  python prep_fire.py data/ --out fire_out --region north_america
  python prep_fire.py data/ --out fire_out --region bc --min-conf 8
"""

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform as warp_points

from prep_common import add_common_args, find_files, load_manifest, resolve_bbox, write_manifest


def fire_pixels(src, min_conf):
    """Yield (rows, cols, values) of fire pixels, reading block by block to keep memory low."""
    for _, window in src.block_windows(1):
        a = src.read(1, window=window)
        r, c = np.nonzero(a >= min_conf)
        if r.size:
            yield r + window.row_off, c + window.col_off, a[r, c]


def process(src_path, start, out_path, bbox, min_conf):
    end = start + dt.timedelta(days=7)               # MOD14A2 = 8-day composite
    w, s, e, n = bbox

    features = []
    counts = {7: 0, 8: 0, 9: 0}
    with rasterio.open(src_path) as src:
        T = src.transform
        for rows, cols, vals in fire_pixels(src, min_conf):
            # 4 corners of each pixel in the source projection (Sinusoidal) -> lon/lat
            x0, y0 = T * (cols, rows)                 # top-left
            x1, y1 = T * (cols + 1, rows + 1)         # bottom-right
            xs = np.concatenate([x0, x1, x1, x0])
            ys = np.concatenate([y0, y0, y1, y1])
            lon, lat = warp_points(src.crs, "EPSG:4326", xs, ys)
            lon = np.array(lon).reshape(4, -1)
            lat = np.array(lat).reshape(4, -1)
            for i in range(rows.size):
                clon, clat = lon[:, i].mean(), lat[:, i].mean()
                if not (w <= clon <= e and s <= clat <= n):
                    continue
                ring = [[round(float(lon[k, i]), 5), round(float(lat[k, i]), 5)] for k in range(4)]
                ring.append(ring[0])
                conf = int(vals[i])
                counts[conf] += 1
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": {"start": start.isoformat(), "end": end.isoformat(), "conf": conf},
                })

    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    size_mb = out_path.stat().st_size / 1e6
    print(f"  {src_path.name}\n    -> {out_path.name}  {len(features):,} fire pixels "
          f"(low {counts[7]:,} / nominal {counts[8]:,} / high {counts[9]:,})  {size_mb:.1f} MB")
    return {"start": start.isoformat(), "end": end.isoformat(), "file": out_path.name,
            "source": src_path.name, "fire_pixels": len(features), "size_mb": round(size_mb, 2)}


def run(inputs, out="fire_out", region="north_america", bbox=None, min_conf=7, overwrite=False):
    bbox = resolve_bbox(region, bbox)
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "fire_manifest.json"

    settings = {"bounds_lonlat": list(bbox), "min_conf": min_conf}
    entries = {} if overwrite else load_manifest(manifest_path, settings)

    files = find_files(inputs, "fire")
    print(f"Fire: found {len(files)} matching file(s); region {bbox}, min confidence {min_conf}")
    done = skipped = 0
    for path, start in files:
        out_path = out_dir / f"fire_{start:%Y_%m_%d}.geojson"
        if out_path.exists() and out_path.name in entries and not overwrite:
            skipped += 1
            continue
        entries[out_path.name] = process(path, start, out_path, bbox, min_conf)
        done += 1
    print(f"Fire: processed {done}, skipped {skipped} already done")

    header = {
        "variable": "fire",
        "source": "MODIS MOD14A2 v061 FireMask, 1 km, 8-day composite",
        "crs": "EPSG:4326",
        "conf_classes": {"7": "low", "8": "nominal", "9": "high"},
        **settings,
    }
    write_manifest(manifest_path, header, entries, sort_key="start")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap, default_out="fire_out")
    ap.add_argument("--min-conf", type=int, choices=[7, 8, 9], default=7,
                    help="lowest fire class to keep: 7 = all fires (default), 8 = nominal+high, 9 = high only")
    a = ap.parse_args()
    run(a.inputs, a.out, a.region, a.bbox, a.min_conf, a.overwrite)


if __name__ == "__main__":
    main()