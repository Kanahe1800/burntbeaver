"""
Count ANY animal's occurrence records per grid cell, so they can be joined to the environment
panel made by prep_cells.py (NDVI + burned area per cell).

Works with GBIF downloads (tab-separated) and ordinary CSVs (iNaturalist, field data, ...):
column names are detected automatically (decimalLatitude / latitude / lat, ...). Only numpy +
pandas are needed (the map projection is implemented here), so the SAME code runs:
  - in the stats notebook:  from animal_cells import count_animals
  - from the command line:  python animal_cells.py --grid analysis_data/50km --csv elk.csv --label elk
  - in the browser via Pyodide (pass the uploaded file's text or a DataFrame)

Raw GBIF downloads are cleaned with the team's pipeline (beavers_preprocess.ipynb): missing
year/month/day filled from eventDate, optional start year (--since 2015), rows without year or
coordinates dropped. Already-cleaned CSVs pass through the same steps unchanged.

Output per grid folder, in animals/:
  <label>.parquet          one row per cell: cell_id, n, n_years, first_year, last_year
                           (+ effort_n, index = n / effort_n with an effort file)
  <label>_monthly.parquet  one row per cell x month ("YYYY-MM", joins with panel.parquet): cell_id, month, n

Join in the notebook:
  panel = pd.read_parquet("analysis_data/50km/panel.parquet")
  elk = count_animals("elk.csv", "analysis_data/50km/meta.json", before_year=2026)
  df = panel.merge(elk, on="cell_id", how="left").fillna({"n": 0})
"""

import argparse
import io
import json
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------- North America Albers (ESRI:102008)
# +proj=aea +lat_0=40 +lon_0=-96 +lat_1=20 +lat_2=60 +x_0=0 +y_0=0 +datum=NAD83 (GRS80 ellipsoid)
_A = 6378137.0
_F = 1 / 298.257222101
_E2 = _F * (2 - _F)
_E = np.sqrt(_E2)
_LAT0, _LON0, _LAT1, _LAT2 = np.radians([40.0, -96.0, 20.0, 60.0])


def _q(phi):
    s = np.sin(phi)
    return (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * np.log((1 - _E * s) / (1 + _E * s)))


def _m(phi):
    s = np.sin(phi)
    return np.cos(phi) / np.sqrt(1 - _E2 * s * s)


_M1, _M2 = _m(_LAT1), _m(_LAT2)
_Q0, _Q1, _Q2 = _q(_LAT0), _q(_LAT1), _q(_LAT2)
_N = (_M1 ** 2 - _M2 ** 2) / (_Q2 - _Q1)
_C = _M1 ** 2 + _N * _Q1
_RHO0 = _A * np.sqrt(_C - _N * _Q0) / _N


def albers_xy(lon, lat):
    """lon/lat (degrees) -> ESRI:102008 metres. Ellipsoidal Albers (Snyder 1987, eq. 14-1..14-4)."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    dlon = (lon - np.degrees(_LON0) + 180) % 360 - 180          # wrap so Alaska's Aleutians work
    rho = _A * np.sqrt(_C - _N * _q(np.radians(lat))) / _N
    theta = _N * np.radians(dlon)
    return rho * np.sin(theta), _RHO0 - rho * np.cos(theta)


# ---------------------------------------------------------------- reading any occurrence table
LAT = ["decimallatitude", "latitude", "lat", "y"]
LON = ["decimallongitude", "longitude", "lon", "lng", "long", "x"]
YEAR, MONTH, DAY = ["year"], ["month"], ["day"]
DATE = ["eventdate", "observed_on", "date", "datetime", "time_observed_at"]
UNC = ["coordinateuncertaintyinmeters", "positional_accuracy", "uncertainty", "accuracy"]
SPECIES = ["species", "scientificname", "scientific_name", "taxon_name"]


def _pick(cols, names):
    lower = {c.strip().lower(): c for c in cols}
    return next((lower[n] for n in names if n in lower), None)


def _read_table(source):
    """DataFrame from a path, CSV text, bytes or an existing DataFrame (comma or tab separated)."""
    if isinstance(source, pd.DataFrame):
        return source
    if isinstance(source, Path) or (isinstance(source, str) and "\n" not in source and len(source) < 1000):
        raw = Path(source).read_bytes()                                  # a file path
    else:
        raw = source.encode() if isinstance(source, str) else source     # CSV text or bytes
    first = raw[:20000].split(b"\n", 1)[0].decode("utf-8", "replace")
    sep = "\t" if first.count("\t") > first.count(",") else ","
    return pd.read_csv(io.BytesIO(raw), sep=sep, dtype=str, on_bad_lines="skip",
                       quoting=3 if sep == "\t" else 0, encoding_errors="replace")


# --- the team's GBIF cleaning pipeline (beavers_preprocess.ipynb), made column-name agnostic ---
def impute_missing_dates(df, year_col, month_col, day_col, date_col):
    """Fill missing year/month/day from the event date (and vice versa keeps existing values).

    Like the notebook's impute_missing_data(), plus two small extensions:
      - date ranges such as '2012-06-15/2012-06-16' use their start date (the notebook gives NaT)
      - a year-only date such as '1960' still provides the year
    """
    num = lambda c: pd.to_numeric(df[c], errors="coerce") if c else pd.Series(np.nan, index=df.index)
    year, month, day = num(year_col), num(month_col), num(day_col)
    if date_col:
        txt = df[date_col].astype(str).str.split("/").str[0].str.strip()
        parsed = pd.to_datetime(txt.str[:10], format="%Y-%m-%d", errors="coerce")
        year = year.fillna(parsed.dt.year).fillna(
            pd.to_numeric(txt.str.extract(r"^(\d{4})")[0], errors="coerce"))
        month = month.fillna(parsed.dt.month)
        day = day.fillna(parsed.dt.day)
    return year, month, day


def filter_timeline(df, start_year):
    """Keep rows from start_year onwards (notebook: filter_timeline(df, 2015))."""
    return df if start_year is None else df[df["year"] >= start_year]


def read_occurrences(source, max_uncertainty_m=5000, species=None, start_year=None):
    """Cleaned occurrences: lon, lat, year, month, day (+ species).

    Works on raw GBIF downloads, the team's already-cleaned CSV, iNaturalist exports or any CSV
    with coordinates. Steps (= the team pipeline, then a few extra safety checks):
      1. keep only the columns we need (instead of dropping a fixed list -> works for any source)
      2. impute missing year/month/day from the event date
      3. filter_timeline(start_year)
      4. drop rows without year, latitude or longitude
      + species filter, coordinate-uncertainty filter, drop invalid / 0,0 coordinates
    """
    df = _read_table(source)
    cols = list(df.columns)
    lat, lon = _pick(cols, LAT), _pick(cols, LON)
    if not lat or not lon:
        raise ValueError(f"Could not find latitude/longitude columns. Columns are: {cols[:15]}")

    year, month, day = impute_missing_dates(df, _pick(cols, YEAR), _pick(cols, MONTH),
                                            _pick(cols, DAY), _pick(cols, DATE))
    out = pd.DataFrame({"lat": pd.to_numeric(df[lat], errors="coerce"),
                        "lon": pd.to_numeric(df[lon], errors="coerce"),
                        "year": year, "month": month, "day": day})

    sc = _pick(cols, SPECIES)
    if sc:
        out["species"] = df[sc].astype(str)
        if species:
            out = out[out["species"].str.lower() == species.lower()]

    uc = _pick(cols, UNC)
    if uc and max_uncertainty_m:
        u = pd.to_numeric(df.loc[out.index, uc], errors="coerce")
        out = out[u.isna() | (u <= max_uncertainty_m)]          # missing uncertainty is kept

    out = filter_timeline(out, start_year)
    out = out.dropna(subset=["year", "lat", "lon"])
    ok = out["lat"].between(-90, 90) & out["lon"].between(-180, 180)
    ok &= ~((out["lat"] == 0) & (out["lon"] == 0))              # common "missing" placeholder
    out = out[ok].reset_index(drop=True)
    for c in ("year", "month", "day"):
        out[c] = out[c].astype("Int64")
    return out


# ---------------------------------------------------------------- counting per cell
def load_meta(meta):
    if isinstance(meta, dict):
        return meta
    return json.loads(Path(meta).read_text())


def cell_ids(lon, lat, meta):
    """Cell id for each point (-1 = outside the grid), same formula as prep_cells.py."""
    m = load_meta(meta)
    x, y = albers_xy(lon, lat)
    s = m["cell_size_m"]
    col = np.floor((x - m["origin_x"]) / s).astype(np.int64)
    row = np.floor((m["origin_y_top"] - y) / s).astype(np.int64)
    ok = (col >= 0) & (col < m["width"]) & (row >= 0) & (row < m["height"])
    return np.where(ok, row * m["width"] + col, -1)


def _prepare(source, meta, start_year, before_year, max_uncertainty_m, species):
    occ = read_occurrences(source, max_uncertainty_m, species, start_year)
    if before_year is not None:
        occ = occ[occ["year"] < before_year]
    occ = occ.assign(cell_id=cell_ids(occ["lon"].values, occ["lat"].values, meta))
    return occ[occ["cell_id"] >= 0]


def count_animals(source, meta, before_year=None, effort=None, max_uncertainty_m=5000,
                  species=None, start_year=None):
    """Records per cell. `source`/`effort`: path, CSV text/bytes or DataFrame.

    Returns cell_id, n, n_years, first_year, last_year (+ effort_n, index with an effort file).
    """
    occ = _prepare(source, meta, start_year, before_year, max_uncertainty_m, species)
    out = occ.groupby("cell_id").agg(n=("lat", "size"), n_years=("year", "nunique"),
                                     first_year=("year", "min"), last_year=("year", "max")).reset_index()
    if effort is not None:
        eff = _prepare(effort, meta, start_year, before_year, max_uncertainty_m, None)
        e = eff["cell_id"].value_counts().rename("effort_n").rename_axis("cell_id").reset_index()
        out = out.merge(e, on="cell_id", how="outer").fillna({"n": 0, "effort_n": 0})
        out["index"] = np.where(out["effort_n"] > 0, out["n"] / out["effort_n"].clip(lower=1), np.nan)
    out["n"] = out["n"].astype(int)
    return out.sort_values("cell_id").reset_index(drop=True)


def count_animals_monthly(source, meta, max_uncertainty_m=5000, species=None, start_year=None):
    """Records per cell per month ("YYYY-MM", same as panel.parquet), for records with a month."""
    occ = _prepare(source, meta, start_year, None, max_uncertainty_m, species).dropna(subset=["month"])
    occ = occ.assign(month=occ["year"].astype(int).astype(str) + "-" + occ["month"].astype(int).map("{:02d}".format))
    return (occ.groupby(["cell_id", "month"]).size().rename("n").reset_index()
            .sort_values(["cell_id", "month"]).reset_index(drop=True))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--grid", required=True, nargs="+",
                    help="grid folder(s) from prep_cells.py, e.g. analysis_data/50km analysis_data/10km")
    ap.add_argument("--csv", required=True, help="occurrence CSV/TSV (raw GBIF, cleaned CSV, iNaturalist, ...)")
    ap.add_argument("--label", required=True, help="name for the output files, e.g. beaver, elk")
    ap.add_argument("--effort", help="CSV/TSV of all records (e.g. all mammals) for effort correction")
    ap.add_argument("--species", help="keep only this species if the file has several")
    ap.add_argument("--since", type=int, help="only records from this year on (team pipeline used 2015)")
    ap.add_argument("--before", type=int, help="only count records from years before this (e.g. 2026)")
    ap.add_argument("--max-uncertainty", type=float, default=5000,
                    help="drop records less precise than this many metres (default 5000; 0 = keep all)")
    ap.add_argument("--save-clean", help="also save the cleaned records to this CSV")
    a = ap.parse_args()

    if a.save_clean:
        clean = read_occurrences(a.csv, a.max_uncertainty, a.species, a.since)
        clean.to_csv(a.save_clean, index=False)
        print(f"{a.save_clean}: {len(clean):,} cleaned records")
    for g in a.grid:
        g = Path(g)
        (g / "animals").mkdir(exist_ok=True)
        res = count_animals(a.csv, g / "meta.json", a.before, a.effort, a.max_uncertainty, a.species, a.since)
        res.to_parquet(g / "animals" / f"{a.label}.parquet", index=False)
        mon = count_animals_monthly(a.csv, g / "meta.json", a.max_uncertainty, a.species, a.since)
        mon.to_parquet(g / "animals" / f"{a.label}_monthly.parquet", index=False)
        print(f"{g / 'animals' / a.label}: {int(res['n'].sum()):,} records in {int((res['n'] > 0).sum()):,} cells "
              f"(+ {a.label}_monthly.parquet, {len(mon):,} cell-months)")


if __name__ == "__main__":
    main()