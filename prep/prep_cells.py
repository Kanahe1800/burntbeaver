"""
Build the per-cell ENVIRONMENT tables (NDVI + burned area) for the stats notebook and web app.
Animal records are counted separately with animal_cells.py, so any species can be joined later.

Equal-area square grid in North America Albers (ESRI:102008), same idea as stats.ipynb, for one
or more cell sizes at once. Raw AppEEARS files are read once and aggregated into every grid.

Inputs
  - folder(s) with raw AppEEARS files (searched recursively, picked out by name):
      MOD13A3 ... NDVI_YYYYMMDD...tif      monthly NDVI, 1 km (the ORIGINAL files, not web_data COGs)
      MCD64A1 ... Burn_Date_YYYYMMDD...tif monthly burned area, 500 m
  - --land   land polygons (e.g. site/public/geo_files/NA.geojson) -> grid extent + land area per cell

Output, per cell size:   analysis_data/<size>km/
  grid.gpkg            cell polygons + static columns (for maps in the notebook / QGIS)
  cells.parquet        one row per cell: cell_id, row, col, lon, lat, land_km2, land_frac
  panel.parquet        one row per cell x month: cell_id, month, ndvi_mean, ndvi_valid_frac,
                       burned_km2, burned_frac, first_burn_doy, unmapped_frac  + the cells columns
  meta.json            grid definition (CRS, origin, size, width, height) -> used by animal_cells.py
                       and the web app to put any animal's points into the same cells

cell_id = row * width + col, with row 0 at the top. Grids are snapped to a common origin, so a
50 km cell contains exactly 25 cells of 10 km (and 4 of 25 km).

Notes
  - burned_km2 is NaN for months with no MCD64A1 file (unknown), 0 for months with a file and no burn.
  - unmapped_frac = share of the cell's land MCD64A1 marked "unmapped" (-1) that month: a 0 burn
    with a high unmapped_frac means "unknown", not "no fire".

Usage:
  pip install rasterio numpy pandas pyarrow geopandas pyproj
  python prep_cells.py ..\\NASAdata --land ..\\site\\public\\geo_files\\NA.geojson ^
      --cell-size 10 25 50 --out analysis_data
  then, for any animal:
  python animal_cells.py --grid analysis_data/50km --csv beaver_gbif.csv --label beaver
"""

import argparse
import json
import math
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from pyproj import Transformer
from rasterio import features
from rasterio.transform import from_origin
from rasterio.windows import Window
from shapely.geometry import box

from prep_common import find_files

CRS = "ESRI:102008"           # North America Albers Equal Area Conic
FINE = 1000                   # land-area raster resolution (m)
NDVI_NODATA = -3000
NDVI_SCALE = 0.0001
STRIP_ROWS = 2048
UNMAPPED_STRIDE = 4           # sample every 4th MCD64A1 pixel (both directions) for unmapped_frac


# ----------------------------------------------------------------------------- grid
class Grid:
    def __init__(self, size_m, minx, top, width, height):
        self.size = size_m
        self.minx, self.top = minx, top
        self.W, self.H = width, height
        self.transform = from_origin(minx, top, size_m, size_m)

    def index(self, x, y):
        """Flat cell index for projected coordinates; -1 where outside the grid."""
        col = np.floor((x - self.minx) / self.size).astype(np.int64)
        row = np.floor((self.top - y) / self.size).astype(np.int64)
        ok = (col >= 0) & (col < self.W) & (row >= 0) & (row < self.H)
        return np.where(ok, row * self.W + col, -1)

    def bincount(self, idx, weights=None):
        keep = idx >= 0
        w = None if weights is None else weights[keep]
        return np.bincount(idx[keep], weights=w, minlength=self.W * self.H).astype(np.float64)

    def meta(self):
        return {"crs": CRS, "cell_size_m": self.size, "origin_x": self.minx, "origin_y_top": self.top,
                "width": self.W, "height": self.H,
                "cell_id": "row * width + col; col = floor((x - origin_x) / cell_size_m), "
                           "row = floor((origin_y_top - y) / cell_size_m)"}


def build_grids(land_path, sizes_km):
    land = gpd.read_file(land_path).to_crs(CRS)
    minx, miny, maxx, maxy = land.total_bounds
    sizes = [int(round(s * 1000)) for s in sizes_km]
    snap = math.lcm(*sizes, FINE)                      # common origin -> grids nest exactly
    minx = math.floor(minx / snap) * snap
    miny = math.floor(miny / snap) * snap
    maxx = math.ceil(maxx / snap) * snap
    maxy = math.ceil(maxy / snap) * snap

    print(f"Rasterizing land at {FINE} m for land area per cell ...")
    wf, hf = int((maxx - minx) / FINE), int((maxy - miny) / FINE)
    fine = features.rasterize(((g, 1) for g in land.geometry if g is not None and not g.is_empty),
                              out_shape=(hf, wf), transform=from_origin(minx, maxy, FINE, FINE),
                              fill=0, dtype="uint8")
    grids, land_km2 = {}, {}
    to_ll = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    tables = {}
    for s in sizes:
        k = s // FINE
        g = Grid(s, minx, maxy, int((maxx - minx) / s), int((maxy - miny) / s))
        lk = fine.reshape(g.H, k, g.W, k).sum(axis=(1, 3)) * (FINE * FINE / 1e6)
        grids[s], land_km2[s] = g, lk
        rows, cols = np.nonzero(lk > 0)
        cx = minx + (cols + 0.5) * s
        cy = maxy - (rows + 0.5) * s
        lon, lat = to_ll.transform(cx, cy)
        tables[s] = pd.DataFrame({
            "cell_id": rows * g.W + cols, "row": rows, "col": cols,
            "lon": np.round(lon, 5), "lat": np.round(lat, 5),
            "land_km2": np.round(lk[rows, cols], 2),
            "land_frac": np.round(lk[rows, cols] / (s * s / 1e6), 4),
        })
        print(f"  {s // 1000} km grid: {g.W} x {g.H}, {len(tables[s]):,} cells with land")
    return grids, land_km2, tables


# ----------------------------------------------------------------------------- NDVI
class NdviBinner:
    """Assign each NDVI pixel to the cell its centre falls in (exact, like the burned-area binning).

    GDAL's 'average' reprojection is NOT used: it averages an axis-aligned box in Sinusoidal
    coordinates, which is badly sheared far from the central meridian (e.g. BC at -120 deg), so it
    picks the wrong pixels. The pixel -> cell lookup is computed once and reused for every month.
    """

    def __init__(self, grids):
        self.grids = grids
        self.flat = None          # sorted flat indices of pixels with a known cell
        self.idx = {}             # grid size -> cell index for each pixel in self.flat
        self.px_km2 = None

    def _cells_for(self, src, flat):
        tf = Transformer.from_crs(src.crs, CRS, always_xy=True)
        T = src.transform
        out = {s: np.empty(flat.size, np.int32) for s in self.grids}
        for i in range(0, flat.size, 5_000_000):                    # chunks keep memory low
            f = flat[i:i + 5_000_000]
            r, c = np.divmod(f, src.width)
            x, y = tf.transform(T.c + (c + 0.5) * T.a, T.f + (r + 0.5) * T.e)
            for s, g in self.grids.items():
                out[s][i:i + f.size] = g.index(np.asarray(x), np.asarray(y))
        return out

    def month(self, path, land_km2):
        out = {}
        with rasterio.open(path) as src:
            raw = src.read(1).ravel()
            nod = src.nodata if src.nodata is not None else NDVI_NODATA
            flat = np.flatnonzero((raw != nod) & (raw >= -2000) & (raw <= 10000))
            vals = raw[flat].astype(np.float64) * NDVI_SCALE
            del raw
            if self.flat is None:                                    # first file: build lookup
                self.px_km2 = abs(src.transform.a * src.transform.e) / 1e6
                self.flat, self.idx = flat, self._cells_for(src, flat)
                pos, known = np.arange(flat.size), np.ones(flat.size, bool)
            else:
                pos = np.clip(np.searchsorted(self.flat, flat), 0, self.flat.size - 1)
                known = self.flat[pos] == flat
            extra = self._cells_for(src, flat[~known]) if (~known).any() else None
            for s, g in self.grids.items():
                idx = np.empty(flat.size, np.int64)
                idx[known] = self.idx[s][pos[known]]
                if extra is not None:
                    idx[~known] = extra[s]
                n = g.bincount(idx)
                total = g.bincount(idx, vals)
                with np.errstate(invalid="ignore", divide="ignore"):
                    mean = np.where(n > 0, total / n, np.nan)
                    frac = np.where(land_km2[s].ravel() > 0,
                                    np.minimum(n * self.px_km2 / land_km2[s].ravel(), 1.0), np.nan)
                out[s] = (mean, frac)
        return out


# ----------------------------------------------------------------------------- burned area
def burn_month(path, grids):
    """Per grid: burned km2, first burn day of year, unmapped fraction (sampled)."""
    with rasterio.open(path) as src:
        T = src.transform
        px_km2 = abs(T.a * T.e) / 1e6
        tf = Transformer.from_crs(src.crs, CRS, always_xy=True)
        bx, by, bd = [], [], []                 # burned pixels
        sx, sy, su = [], [], []                 # sampled land pixels (unmapped flag)
        for r0 in range(0, src.height, STRIP_ROWS):
            a = src.read(1, window=Window(0, r0, src.width, min(STRIP_ROWS, src.height - r0)))
            r, c = np.nonzero((a >= 1) & (a <= 366))
            if r.size:
                x, y = tf.transform(T.c + (c + 0.5) * T.a, T.f + (r + r0 + 0.5) * T.e)
                bx.append(x); by.append(y); bd.append(a[r, c])
            sub = a[::UNMAPPED_STRIDE, ::UNMAPPED_STRIDE]
            r, c = np.nonzero((sub >= -1) & (sub <= 366))          # mapped land or unmapped
            if r.size:
                r = r * UNMAPPED_STRIDE + r0
                c = c * UNMAPPED_STRIDE
                x, y = tf.transform(T.c + (c + 0.5) * T.a, T.f + (r + 0.5) * T.e)
                sx.append(x); sy.append(y); su.append(sub[(r - r0) // UNMAPPED_STRIDE, c // UNMAPPED_STRIDE] == -1)

    cat = lambda L, dt: np.concatenate(L) if L else np.array([], dt)
    bx, by, bd = cat(bx, float), cat(by, float), cat(bd, np.int16)
    sx, sy, su = cat(sx, float), cat(sy, float), cat(su, bool)
    out = {}
    for s, g in grids.items():
        bi = g.index(bx, by)
        burned = g.bincount(bi) * px_km2
        first = np.full(g.W * g.H, 999, np.int32)
        k = bi >= 0
        np.minimum.at(first, bi[k], bd[k].astype(np.int32))
        first = np.where(first == 999, np.nan, first)
        si = g.index(sx, sy)
        n_all = g.bincount(si)
        n_unm = g.bincount(si, su.astype(np.float64))
        with np.errstate(invalid="ignore", divide="ignore"):
            unm = np.where(n_all > 0, n_unm / n_all, np.nan)
        out[s] = (burned, first, unm)
    return out, len(bd) * px_km2


# ----------------------------------------------------------------------------- main
def run(inputs, land, sizes_km, out):
    grids, land_km2, cells = build_grids(land, sizes_km)
    out = Path(out)

    ndvi_files = find_files(inputs, "ndvi")
    burn_files = find_files(inputs, "burn")
    print(f"Found {len(ndvi_files)} NDVI and {len(burn_files)} Burn Date file(s)")
    if not ndvi_files and not burn_files:
        raise SystemExit("No MOD13A3 NDVI or MCD64A1 Burn_Date files found.")

    ndvi, burn = {}, {}
    binner = NdviBinner(grids)
    for path, date in ndvi_files:
        m = f"{date:%Y-%m}"
        ndvi[m] = binner.month(path, land_km2)
        print(f"  NDVI {m}: done")
    for path, date in burn_files:
        m = f"{date:%Y-%m}"
        burn[m], total = burn_month(path, grids)
        print(f"  Burned area {m}: {total:,.0f} km2")

    months = sorted(set(ndvi) | set(burn))
    for s, g in grids.items():
        d = out / f"{s // 1000}km"
        d.mkdir(parents=True, exist_ok=True)
        c = cells[s].copy()
        ids = c["cell_id"].values

        rows = []
        for m in months:
            part = pd.DataFrame({"cell_id": ids, "month": m})
            if m in ndvi:
                mean, frac = ndvi[m][s]
                part["ndvi_mean"] = np.round(mean[ids], 4)
                part["ndvi_valid_frac"] = np.round(frac[ids], 3)
            else:
                part["ndvi_mean"] = np.nan
                part["ndvi_valid_frac"] = np.nan
            if m in burn:
                burned, first, unm = burn[m][s]
                part["burned_km2"] = np.round(burned[ids], 3)
                part["burned_frac"] = np.round(burned[ids] / c["land_km2"].values, 5)
                part["first_burn_doy"] = first[ids]
                part["unmapped_frac"] = np.round(unm[ids], 3)
            else:                                    # no burned-area data this month -> unknown
                for col in ("burned_km2", "burned_frac", "first_burn_doy", "unmapped_frac"):
                    part[col] = np.nan
            rows.append(part)
        panel = pd.concat(rows, ignore_index=True).merge(c, on="cell_id", how="left")

        c.to_parquet(d / "cells.parquet", index=False)
        panel.to_parquet(d / "panel.parquet", index=False)
        geo = gpd.GeoDataFrame(
            c, crs=CRS,
            geometry=[box(g.minx + col * s, g.top - (row + 1) * s, g.minx + (col + 1) * s, g.top - row * s)
                      for row, col in zip(c["row"], c["col"])])
        geo.to_file(d / "grid.gpkg", driver="GPKG")
        meta = g.meta() | {"months": months,
                           "ndvi_months": sorted(ndvi), "burn_months": sorted(burn)}
        (d / "meta.json").write_text(json.dumps(meta, indent=2))
        print(f"{s // 1000} km: wrote {d}  ({len(c):,} cells, {len(panel):,} panel rows)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="folder(s) with raw AppEEARS MOD13A3 NDVI and MCD64A1 Burn_Date files")
    ap.add_argument("--land", required=True, help="land polygons (GeoJSON/GPKG/shapefile), e.g. NA.geojson")
    ap.add_argument("--cell-size", type=float, nargs="+", default=[50], help="cell size(s) in km (default 50)")
    ap.add_argument("--out", default="analysis_data", help="output folder (default analysis_data)")
    a = ap.parse_args()
    run(a.inputs, a.land, a.cell_size, a.out)


if __name__ == "__main__":
    main()