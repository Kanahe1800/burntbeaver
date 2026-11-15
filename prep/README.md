# prep/ — data preprocessing and statistics

Everything that turns raw NASA and GBIF downloads into (1) data for the web map and
(2) tables for the beaver / wildfire / vegetation statistics.

```
NASAdata/ (raw AppEEARS downloads)  ──►  prep_all.py    ──►  web_data/       ──►  R2 bucket (map)
                                     └─►  prep_cells.py  ──►  analysis_data/  ──►  stats_cells.ipynb
GBIF / iNaturalist CSV              ──►  animal_cells.py ──►  analysis_data/<grid>/animals/
```

---

## 1. Setup

```powershell
conda env create -f environment.yml      # first time only
conda activate smokey-creatures
```

If the environment already exists and a script says `ModuleNotFoundError`:

```powershell
pip install rasterio numpy scipy shapely pandas pyarrow geopandas pyproj matplotlib statsmodels
```

Use pip **only** inside this environment (mixing conda and pip versions of rasterio/GDAL
causes `DLL load failed` errors on Windows).

PowerShell tip: quote package names starting with `@` (`npm install "@deck.gl/geo-layers"`).

---

## 2. Input data

### NASA (from AppEEARS), all in one folder, e.g. `..\NASAdata\` (subfolders are fine)

| Product | Layer | Resolution | File name looks like |
|---|---|---|---|
| MOD13A3 v061 | 1 km monthly NDVI | 1 km, monthly | `MOD13A3.061__1_km_monthly_NDVI_20260601T000000_aid0001.tif` |
| MCD64A1 v061 | Burn Date | 500 m, monthly | `MCD64A1.061_Burn_Date_20260701T000000_aid0001.tif` |

- Request them in the **native projection** (MODIS Sinusoidal, the AppEEARS default for GeoTIFF).
- Scripts find files **by name**; other files in the folder (QA, uncertainty, etc.) are ignored.
- MCD64A1 Burn Date values: `1–366` day of year burned, `0` unburned, `-1` unmapped, `-2` water.
- ⚠️ `MCD64A1..._20260701` / `_20260801` may still be the **synthetic sample files** (made for code
  development, tagged `SYNTHETIC=true`). Replace them with real downloads before interpreting results.

### Animals (GBIF or any CSV)

Any CSV/TSV with coordinates works: raw GBIF downloads, our cleaned beaver CSV, iNaturalist exports.
Columns are detected automatically (`decimalLatitude`/`latitude`/`lat`, `year` or `eventDate`/`observed_on`, ...).

### Land polygons

`..\site\public\geo_files\NA.geojson` — defines the grid extent and land area per cell.

---

## 3. Web map data — `prep_all.py`

```powershell
python prep_all.py ..\NASAdata --out web_data --region us_canada --zoom 6 --months 4-10
```

| Output | What | Where it goes |
|---|---|---|
| `web_data/ndvi/ndvi_YYYY_MM.tif` + `manifest.json` | NDVI as Cloud Optimized GeoTIFF, Web Mercator, real values (NDVI × 10000) | R2 bucket `ndvi/` |
| `web_data/burn/burn_YYYY_MM.geojson` + `burn_manifest.json` | Burned-area outlines per month (area km², start/end dates) | R2 bucket `burn/` |

- Run again when new files arrive: only **new months** are processed, manifests are updated.
- `--months 4-10` processes only April–October (the folder can hold all 12 months; others are skipped).
  Other forms: `--months 5,6,7`, `--months 11-2` (wraps over New Year). Leave it out for all months.
- `--zoom 6` (~2.4 km pixels) makes each NDVI month ~21 MB instead of ~83 MB for US + Canada
  (April–October × 10 years ≈ 1.5 GB on R2). Use `--zoom 7` for full 1 km detail on smaller regions.
- Use the **same `--region`** every time (`us_canada`, `north_america`, `canada`, `western_canada`, `bc`, or `--bbox W S E N`).
  Changing it stops with a message; add `--overwrite` to rebuild everything.
- Options: `--simplify 500` (smoother outlines), `--min-area 1` (drop fires < 1 km²).
- The two steps can also run alone: `prep_ndvi.py`, `prep_burn.py` (same options).
- ⚠️ `web_data/` is **only for the map**. These files are resampled; never use them for statistics.

Upload: R2 bucket `smoky-data` → folders `ndvi/` and `burn/`
(served at `https://data.smoky-creatures.earth/...`). Check that `.../burn/burn_manifest.json` opens.

---

## 4. Statistics data — `prep_cells.py` (environment) + `animal_cells.py` (animals)

### 4a. Environment per grid cell (run once per data update)

```powershell
python prep_cells.py ..\NASAdata --land ..\site\public\geo_files\NA.geojson --cell-size 10 25 50 --out analysis_data --months 4-10
```

- `--months 4-10` uses only the growing season (winter NDVI is mostly snow). Same format as above.
- Equal-area square grid in **North America Albers (ESRI:102008)**, several sizes in one run.
  Grids share an origin, so one 50 km cell = exactly 25 cells of 10 km.
- Reads the **raw** AppEEARS files (not `web_data`).
- Each NDVI / burn pixel is assigned to the cell its **centre** falls in (exact).
  We do *not* use GDAL `reproject(..., average)`: MODIS Sinusoidal is strongly sheared far from its
  central meridian (e.g. BC), and that averaging picks the wrong pixels (errors up to ~0.09 NDVI).
- Runtime: roughly 30 s per NDVI month and 10 s per burn month (10 years Apr–Oct ≈ 1 hour), ~2 GB RAM.
- **Cache:** each month's result is saved in `analysis_data/_cache/`. A rerun (after a crash, or after adding
  new files) only processes what is new. Delete `_cache/` to force a full recompute.
- Duplicate downloads like `name (1).tif` are detected; the original name is used.
- Files tagged as **synthetic sample data** are skipped automatically.

Output per size, `analysis_data/<size>km/`:

| File | One row per | Columns |
|---|---|---|
| `panel.parquet` | cell × month | `ndvi_mean`, `ndvi_valid_frac`, `burned_km2`, `burned_frac`, `first_burn_doy`, `unmapped_frac` (join `cells.parquet` on `cell_id` for location/land) |
| `cells.parquet` | cell | `cell_id`, `row`, `col`, `lon`, `lat`, `land_km2`, `land_frac` |
| `grid.gpkg` | cell | polygons for maps (notebook / QGIS) |
| `meta.json` | — | grid definition: CRS, origin, cell size, width/height, months |

Missing data is not zero:
- `burned_km2` is **NaN** for months without an MCD64A1 file, **0** only when a file exists and nothing burned.
- `unmapped_frac`: share of the cell MCD64A1 could not map — a 0 burn with high `unmapped_frac` means *unknown*.

### 4b. Animals per grid cell (any species, any time)

```powershell
python animal_cells.py --grid analysis_data/50km analysis_data/25km analysis_data/10km --csv 0011564-261023074918325.csv --label beaver --since 2015 --save-clean beavers_clean.csv
```

Cleaning = the team pipeline from `beavers_preprocess.ipynb`, applied automatically to raw or cleaned files:
1. keep only needed columns
2. fill missing year / month / day from `eventDate` (date ranges like `2012-06-15/2012-06-16` use the start date)
3. `--since 2015` (= `filter_timeline`)
4. drop rows without year or coordinates

Plus: drop `0,0` and invalid coordinates, and records with `coordinateUncertaintyInMeters` > 5 km
(records **without** an uncertainty value are kept). `--max-uncertainty 0` turns this off
(= exactly the notebook's 59,417 beaver records; with the filter: 54,690).

Output in `analysis_data/<size>km/animals/`:

| File | One row per | Columns |
|---|---|---|
| `<label>.parquet` | cell with records | `n`, `n_years`, `first_year`, `last_year` |
| `<label>_monthly.parquet` | cell × month | `n` (joins with `panel.parquet` on `cell_id` + `month`) |

Other options: `--species "Cervus canadensis"` (files with several species), `--before 2026`,
`--effort all_mammals.csv` (adds `effort_n` and `index`; not used for the hackathon).

In Python (also works in the browser via Pyodide — only numpy + pandas needed):

```python
from animal_cells import count_animals
elk = count_animals("elk.csv", "analysis_data/50km/meta.json", start_year=2015)
```

---

## 5. Statistics — `stats_cells.ipynb`

Open in VS Code / Jupyter from the `prep/` folder and run all cells. Settings at the top:
`GRID` (main grid), `ANIMAL` (label used in 4b), **`YEAR`** (fire season to analyse; fires April–July,
NDVI change = August of `YEAR` vs August of the year before), filters.
Run it for several years (e.g. 2017, 2018, 2021, 2023) and compare.

| Section | What |
|---|---|
| 1 | One row per cell: burned share in the fire months of `YEAR`, August NDVI before/after, beaver presence. NDVI change is compared with unburned cells at the same latitude (removes year-to-year weather differences). |
| 2 | Maps: NDVI, burned share, beaver records |
| 3a | Spearman correlation, beaver records vs burned share |
| 3b | Two-part model: *did the cell burn?* (logistic, odds ratios) and *how much burned?* (burned cells), controlling for NDVI, latitude, longitude |
| 3c | Moran's I on residuals (are neighbouring cells making p-values too optimistic?) |
| 4 | Vegetation resistance: extra NDVI drop in burned cells, with vs without beaver records (accounts for fire size) |
| 5 | Burned share by beaver presence (presentation plot) |
| 6 | Same analysis at 10 / 25 / 50 km |
| 7 | NDVI timelapse GIF per cell |
| 8 | How to report the results |

Sections 6–9 are **robustness checks**: the odds ratio within 500 km regions, in surveyed areas only (a beaver record
within 100 km), at 10/25/50 km, and for several fire seasons (2017, 2018, 2021, 2023, plus pooled). Section 9 puts them
all in one chart.

## 5b. Recovery — `recovery_cells.ipynb`

Same input tables, no extra preprocessing. For every cell whose first big fire (≥ 10 % burned) was in 2017–2023, follows
August NDVI in the following years and measures how much of the fire's NDVI drop has come back (recovery ratio,
climate-adjusted with never-burned cells at the same latitude). Main grid 25 km.

| Section | What |
|---|---|
| 2 | fires/cells used (table + map) |
| 3 | recovery curves, beaver vs no beaver records, bootstrap bands by region |
| 4 | Kaplan–Meier "share not yet 90 % recovered", log-rank test, Cox hazard ratio (> 1 = faster), within region and surveyed |
| 5 | extra recovery per year in beaver cells (`k:beaver_present`) |
| 6 | 10 / 25 / 50 km |

### Interpreting — please read

- **Associations, not causes.** GBIF records show where beavers were *observed* (near people and roads),
  not where they live. There is no effort correction, so we use **presence** and control for location.
- **Moran's I is clearly positive** in our runs (~0.23 at 50 km) → p-values are optimistic. Rely on
  results that keep the same direction at 10, 25 and 50 km. 10 km is the main result; 50 km mixes
  "big busy cells" effects (Spearman grows with cell size).
- **MCD64A1 includes farm and prescribed burns.** Before concluding, restrict to forested/natural cells
  (e.g. `ndvi_pre >= 0.5` or a land-cover layer) and to regions where beavers and wildfire both occur.
- Beaver effects are very local (Fairfax & Whittle 2020: riparian strips). At 10–50 km with 1 km NDVI the
  signal may be weak; "no clear landscape-scale effect" is a valid result.
- The notebook tests resistance within one season; recovery over the following years is a separate analysis (the 10-year panel supports it).

Reference: Fairfax, E. & Whittle, A. (2020). Smokey the Beaver: beaver-dammed riparian corridors stay green
during wildfire throughout the western USA. *Ecological Applications* 30(8): e02225.

---

## 6. Files in this folder

| File | Purpose |
|---|---|
| `prep_common.py` | shared helpers: regions, file-name patterns, manifests |
| `prep_ndvi.py` | NDVI → web COGs |
| `prep_burn.py` | MCD64A1 → burned-area outlines (GeoJSON) |
| `prep_all.py` | runs both web steps |
| `prep_cells.py` | NDVI + burned area → per-cell analysis tables |
| `animal_cells.py` | any occurrence CSV → per-cell counts (team GBIF cleaning built in) |
| `stats_cells.ipynb` | fire statistics notebook (+ robustness checks) |
| `recovery_cells.ipynb` | post-fire recovery notebook |
| `environment.yml` | Python environment |

## 7. Git

Data never goes into git (GitHub rejects files > 100 MB). `.gitignore` should contain:

```
prep/web_data/
prep/analysis_data/
*.zip
*.tif
*.tiff
*.parquet
*.gpkg
*.csv
```

To share processed data with teammates, use the R2 bucket or a shared drive, or let them rerun the scripts.
