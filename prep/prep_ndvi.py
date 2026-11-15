"""
Preprocess MODIS MOD13A3 monthly NDVI GeoTIFFs (from AppEEARS) for the web map.

Point it at a folder: it finds every file named like
    MOD13A3.061__1_km_monthly_NDVI_20260401T000000_aid0001.tif
(searching subfolders too), skips months that were already processed, and adds new ones
to manifest.json. Other files in the folder are ignored.

For each new file:
  1. Reprojects MODIS Sinusoidal -> Web Mercator (EPSG:3857), the projection Google Maps uses
  2. Clips to a region (preset or custom lon/lat box)
  3. Aligns pixels to the standard web-map tile grid (Google Maps compatible), so one
     COG tile == one map tile at the chosen zoom level -> easy to load in deck.gl
  4. Keeps the raw int16 values (NDVI * 10000, nodata = -3000) so the app can show real values
  5. Writes a Cloud Optimized GeoTIFF (COG) with overviews, named ndvi_YYYY_MM.tif

Usage:
  pip install rasterio numpy
  python prep_ndvi.py data/ --out cog_out --region north_america
  python prep_ndvi.py data/ --out cog_out --bbox -139.1 48.2 -114.0 60.0
"""

import argparse
import math
from pathlib import Path

import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform as warp_points

from prep_common import add_common_args, find_files, load_manifest, resolve_bbox, write_manifest

WEB_MERCATOR = "EPSG:3857"
ORIGIN = 20037508.342789244          # half the width of the Web Mercator world (m)
TILE_SIZE = 256                       # standard web map tile size (px)
NODATA = -3000                        # MOD13 fill value
SCALE = 0.0001                        # NDVI = value * SCALE


def tile_grid_bounds(bbox_lonlat, zoom):
    """Convert a lon/lat box to Web Mercator and snap it outward to the tile grid."""
    w, s, e, n = bbox_lonlat
    xs, ys = warp_points("EPSG:4326", WEB_MERCATOR, [w, e], [s, n])
    res = 2 * ORIGIN / (TILE_SIZE * 2 ** zoom)       # metres per pixel at this zoom
    tile_m = TILE_SIZE * res
    x_min = math.floor((xs[0] + ORIGIN) / tile_m) * tile_m - ORIGIN
    x_max = math.ceil((xs[1] + ORIGIN) / tile_m) * tile_m - ORIGIN
    y_min = ORIGIN - math.ceil((ORIGIN - ys[0]) / tile_m) * tile_m
    y_max = ORIGIN - math.floor((ORIGIN - ys[1]) / tile_m) * tile_m
    return (x_min, y_min, x_max, y_max), res


def process(src_path, date, out_path, bbox, zoom, resampling):
    (x_min, y_min, x_max, y_max), res = tile_grid_bounds(bbox, zoom)
    width = round((x_max - x_min) / res)
    height = round((y_max - y_min) / res)
    transform = from_origin(x_min, y_max, res, res)

    with rasterio.open(src_path) as src:
        src_nodata = src.nodata if src.nodata is not None else NODATA
        with WarpedVRT(src, crs=WEB_MERCATOR, transform=transform, width=width, height=height,
                       src_nodata=src_nodata, nodata=NODATA, resampling=resampling, dtype="int16") as vrt:
            rio_copy(
                vrt, out_path, driver="COG",
                COMPRESS="DEFLATE", PREDICTOR="2", LEVEL="9",
                BLOCKSIZE=str(TILE_SIZE),
                TILING_SCHEME="GoogleMapsCompatible", ZOOM_LEVEL=str(zoom),
                OVERVIEWS="IGNORE_EXISTING", OVERVIEW_RESAMPLING="AVERAGE",
                RESAMPLING=resampling.name.upper(),
                BIGTIFF="IF_SAFER", NUM_THREADS="ALL_CPUS",
            )

    with rasterio.open(out_path) as dst:
        small = dst.read(1, out_shape=(max(1, dst.height // 16), max(1, dst.width // 16)))
        valid = small[small != NODATA]
        stats = {k: (round(float(f(valid)) * SCALE, 4) if valid.size else None)
                 for k, f in (("min", lambda v: v.min()), ("max", lambda v: v.max()), ("mean", lambda v: v.mean()))}
        size_mb = out_path.stat().st_size / 1e6
        print(f"  {src_path.name}\n    -> {out_path.name}  {dst.width}x{dst.height}px  "
              f"{size_mb:.1f} MB  NDVI mean={stats['mean']}")

    return {"date": f"{date:%Y-%m}", "file": out_path.name, "source": src_path.name,
            "size_mb": round(size_mb, 1), "stats": stats}


def run(inputs, out="cog_out", region="north_america", bbox=None, zoom=7,
        resampling="bilinear", overwrite=False):
    bbox = resolve_bbox(region, bbox)
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"

    (x_min, y_min, x_max, y_max), _ = tile_grid_bounds(bbox, zoom)
    lons, lats = warp_points(WEB_MERCATOR, "EPSG:4326", [x_min, x_max], [y_min, y_max])
    bounds = [round(v, 6) for v in (lons[0], lats[0], lons[1], lats[1])]
    settings = {"bounds_lonlat": bounds, "max_zoom": zoom}
    entries = {} if overwrite else load_manifest(manifest_path, settings)

    files = find_files(inputs, "ndvi")
    print(f"NDVI: found {len(files)} matching file(s); region {bbox}, zoom {zoom}")
    done = skipped = 0
    for path, date in files:
        out_path = out_dir / f"ndvi_{date:%Y_%m}.tif"
        if out_path.exists() and out_path.name in entries and not overwrite:
            skipped += 1
            continue
        entries[out_path.name] = process(path, date, out_path, bbox, zoom, Resampling[resampling])
        done += 1
    print(f"NDVI: processed {done}, skipped {skipped} already done")

    header = {
        "variable": "NDVI",
        "source": "MODIS MOD13A3 v061, 1 km monthly",
        "crs": WEB_MERCATOR,
        "tiling": "GoogleMapsCompatible",
        **settings,
        "tile_size": TILE_SIZE,
        "dtype": "int16",
        "scale": SCALE,
        "nodata": NODATA,
        "valid_range": [-2000, 10000],
    }
    write_manifest(manifest_path, header, entries, sort_key="date")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap, default_out="cog_out")
    ap.add_argument("--zoom", type=int, default=7,
                    help="native web-map zoom level. 7 ~ 1.2 km/px at the equator, ~0.8 km at 50N "
                         "(good match for 1 km MODIS). Use 9 for 250 m data.")
    ap.add_argument("--resampling", choices=["nearest", "bilinear"], default="bilinear")
    a = ap.parse_args()
    run(a.inputs, a.out, a.region, a.bbox, a.zoom, a.resampling, a.overwrite)


if __name__ == "__main__":
    main()