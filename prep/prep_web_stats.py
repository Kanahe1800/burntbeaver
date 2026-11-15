"""
Pack the per-cell analysis tables into one compact JSON file the website can load, so the browser can
compute the statistics for ANY uploaded animal (and show the default beaver results).

Input  (from prep_cells.py / animal_cells.py):  analysis_data/<size>/{meta.json, cells.parquet, panel.parquet}
                                                 analysis_data/<size>/animals/<animal>.parquet   (default animal)
Output: web_stats/<size>/season.json        per area (cell) and year: burned share (Apr-Oct, Apr-Jul) + August NDVI
        web_stats/<size>/<animal>_points.json  default animal's records for the map (optional, --points)

Upload to the R2 bucket as  grid/<size>/season.json  and  grid/<size>/<animal>_points.json

Usage:
  python prep_web_stats.py --grid analysis_data/25km --animal beaver --points beavers_clean.csv --out web_stats
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

MIN_LAND = 0.3
NDVI_MONTH = 8
SCALE = 10000          # store fractions / NDVI as integers (x 10000) to keep the file small
MISSING = -9999


def as_int(a):
    a = np.asarray(a, dtype=float)
    return np.where(np.isfinite(a), np.round(a * SCALE), MISSING).astype(int).tolist()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--grid", required=True, help="grid folder from prep_cells.py, e.g. analysis_data/25km")
    ap.add_argument("--animal", default="beaver", help="default animal (file in <grid>/animals/)")
    ap.add_argument("--points", help="cleaned occurrence CSV of the default animal (e.g. beavers_clean.csv) for the map")
    ap.add_argument("--min-valid", type=float, default=0.5, help="August NDVI needs this valid share (default 0.5)")
    ap.add_argument("--out", default="web_stats")
    a = ap.parse_args()

    g = Path(a.grid)
    meta = json.loads((g / "meta.json").read_text())
    cells = pd.read_parquet(g / "cells.parquet")
    cells = cells[cells["land_frac"] >= MIN_LAND].sort_values("cell_id").reset_index(drop=True)
    ids = cells["cell_id"].values

    burn_months = meta["burn_months"]
    aug_months = [m for m in meta["ndvi_months"] if int(m[5:]) == NDVI_MONTH]
    p = pd.read_parquet(g / "panel.parquet", columns=["cell_id", "month", "ndvi_mean", "ndvi_valid_frac", "burned_frac"],
                        filters=[("month", "in", burn_months + aug_months)])
    p["year"] = p["month"].str[:4].astype(int)
    p["mon"] = p["month"].str[5:].astype(int)

    b = p[p["month"].isin(burn_months)]
    season = b.groupby(["cell_id", "year"])["burned_frac"].sum().unstack().reindex(ids).fillna(0)
    early = b[b["mon"] < NDVI_MONTH].groupby(["cell_id", "year"])["burned_frac"].sum().unstack().reindex(ids).fillna(0)
    aug = p[p["month"].isin(aug_months)]
    nd = aug.pivot(index="cell_id", columns="year", values="ndvi_mean").reindex(ids)
    va = aug.pivot(index="cell_id", columns="year", values="ndvi_valid_frac").reindex(ids)
    nd = nd.where(va >= a.min_valid)

    years_b = sorted(season.columns.tolist())
    years_n = sorted(nd.columns.tolist())
    animal = pd.read_parquet(g / "animals" / f"{a.animal}.parquet").set_index("cell_id")["n"]

    out = {
        "grid": {k: meta[k] for k in ("crs", "cell_size_m", "origin_x", "origin_y_top", "width", "height")},
        "scale": SCALE, "missing": MISSING,
        "burn_years": years_b, "ndvi_years": years_n, "ndvi_month": NDVI_MONTH,
        "cells": {"row": cells["row"].tolist(), "col": cells["col"].tolist(),
                  "lat": cells["lat"].round(3).tolist(), "lon": cells["lon"].round(3).tolist(),
                  "land_frac": as_int(cells["land_frac"])},
        "burn": {str(y): as_int(season[y]) for y in years_b},
        "burn_early": {str(y): as_int(early[y]) for y in years_b},
        "ndvi": {str(y): as_int(nd[y]) for y in years_n},
        "default_animal": {"name": a.animal, "counts": pd.Series(ids).map(animal).fillna(0).astype(int).tolist()},
    }
    od = Path(a.out) / g.name
    od.mkdir(parents=True, exist_ok=True)
    (od / "season.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"{od / 'season.json'}: {len(ids):,} areas, burn {years_b[0]}-{years_b[-1]}, NDVI {years_n[0]}-{years_n[-1]}, "
          f"{(od / 'season.json').stat().st_size / 1e6:.1f} MB")

    if a.points:
        pts = pd.read_csv(a.points, low_memory=False)
        lat = next(c for c in pts.columns if c.lower() in ("lat", "decimallatitude", "latitude"))
        lon = next(c for c in pts.columns if c.lower() in ("lon", "decimallongitude", "longitude"))
        yr = next((c for c in pts.columns if c.lower() == "year"), None)
        pts = pts.dropna(subset=[lat, lon])
        po = {"name": a.animal, "lat": pts[lat].round(4).tolist(), "lon": pts[lon].round(4).tolist(),
              "year": pts[yr].fillna(0).astype(int).tolist() if yr else []}
        (od / f"{a.animal}_points.json").write_text(json.dumps(po, separators=(",", ":")))
        print(f"{od / f'{a.animal}_points.json'}: {len(pts):,} records, "
              f"{(od / f'{a.animal}_points.json').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
